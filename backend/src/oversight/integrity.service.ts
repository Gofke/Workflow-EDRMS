import { Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { loadDocumentConfig } from '../config/document-config';
import { SealService } from '../core/seal.service';
import { footer, letterhead, newPdf, pdfBuffer, qrPng, table, surinameDateTime } from '../core/pdf';
import { Actor } from '../records/registration.service';
import { SettingsService } from '../settings/settings.service';

export interface IntegrityReport {
  id: string;
  runAt: string;
  ok: boolean;
  audit: { events: number; chainOk: boolean; broken: number[]; newestSeq: number | null; newestHash: string | null };
  anchors: { checked: number; ok: boolean; missing: { runAt: string; seq: number }[] };
  documents: { checked: number; failed: number; failures: { kind: string; id: string; name: string; reason: string }[] };
  seals: { checked: number; failed: number; failures: { id: string; reason: string }[] };
  sealId?: string | null;
}

/**
 * The integrity check: proves that the audit history and the stored documents
 * are what they were.
 *
 *   audit history  every event is chained to the one before it by SHA-256; a
 *                  changed or removed event breaks the chain at that point.
 *   anchors        each check records the newest event and its hash. A later
 *                  check confirms every earlier anchor is still there with the
 *                  same hash — so events cannot be cut off the end unnoticed.
 *   documents      every stored file (letters' documents and task attachments)
 *                  is re-read and its SHA-256 compared with the one recorded
 *                  when it was captured.
 *   seals          every digital seal is verified against the ministry key.
 *
 * Runs every night and on demand. The result is kept (integrity_anchor, which
 * cannot be changed) and can be downloaded as a sealed report.
 */
@Injectable()
export class IntegrityService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private readonly root = loadDocumentConfig().storageRoot;

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly seals: SealService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.INTEGRITY_SCHEDULE === 'off') return;
    // Once a night, after 02:00 in Suriname, if no check ran in the last 20 hours.
    this.timer = setInterval(() => void this.nightly(), 15 * 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async nightly(): Promise<void> {
    const hour = (new Date().getUTCHours() + 21) % 24;
    if (hour < 2 || hour > 5) return;
    const [recent] = await this.dataSource.query(`SELECT 1 FROM integrity_anchor WHERE run_at > now() - interval '20 hours' LIMIT 1`);
    if (recent) return;
    await this.run(null).catch(() => undefined);
  }

  async run(actor: Actor | null): Promise<IntegrityReport> {
    // 1. The audit chain.
    const [{ events }] = await this.dataSource.query(`SELECT count(*)::int AS events FROM audit_event`);
    const broken: { seq: string }[] = await this.dataSource.query(`
      WITH c AS (SELECT seq, chain_hash, audit_event_payload(a) AS p, lag(chain_hash) OVER (ORDER BY seq) AS prev FROM audit_event a)
      SELECT seq FROM c WHERE chain_hash IS DISTINCT FROM encode(sha256(convert_to(coalesce(prev, '') || '#' || p, 'UTF8')), 'hex')
      ORDER BY seq LIMIT 50`);
    const [newest] = await this.dataSource.query(`SELECT seq, chain_hash FROM audit_event ORDER BY seq DESC LIMIT 1`);

    // 2. Earlier anchors must still be there, unchanged.
    const anchors: { audit_seq: string | null; audit_hash: string | null; run_at: Date }[] = await this.dataSource.query(
      `SELECT a.audit_seq, a.audit_hash, a.run_at FROM integrity_anchor a WHERE a.audit_seq IS NOT NULL ORDER BY a.run_at`,
    );
    const missing: { runAt: string; seq: number }[] = [];
    for (const a of anchors) {
      const [e] = await this.dataSource.query(`SELECT chain_hash FROM audit_event WHERE seq = $1`, [a.audit_seq]);
      if (!e || e.chain_hash !== a.audit_hash) missing.push({ runAt: new Date(a.run_at).toISOString(), seq: Number(a.audit_seq) });
    }

    // 3. Every stored file.
    const files: { kind: string; id: string; name: string; storage_key: string; content_hash: string }[] = await this.dataSource.query(`
      SELECT 'DOCUMENT' AS kind, id, original_filename AS name, storage_key, content_hash FROM captured_document
      UNION ALL
      SELECT 'TASK_ATTACHMENT', id, original_filename, storage_key, content_hash FROM task_attachment`);
    const failures: IntegrityReport['documents']['failures'] = [];
    for (const f of files) {
      try {
        const bytes = await readFile(join(this.root, f.storage_key));
        if (createHash('sha256').update(bytes).digest('hex') !== f.content_hash) failures.push({ kind: f.kind, id: f.id, name: f.name, reason: 'content changed' });
      } catch {
        failures.push({ kind: f.kind, id: f.id, name: f.name, reason: 'file missing' });
      }
    }

    // 4. Every seal.
    const sealRows: { id: string }[] = await this.dataSource.query(`SELECT id FROM document_seal`);
    const sealFailures: { id: string; reason: string }[] = [];
    for (const s of sealRows) {
      const v = await this.seals.verifySeal(s.id);
      if (!v.valid) sealFailures.push({ id: s.id, reason: v.reason ?? 'invalid' });
    }

    const chainOk = broken.length === 0;
    const anchorsOk = missing.length === 0;
    const ok = chainOk && anchorsOk && failures.length === 0 && sealFailures.length === 0;
    const details = {
      broken: broken.map((b) => Number(b.seq)),
      missingAnchors: missing,
      documentFailures: failures.slice(0, 100),
      seals: { checked: sealRows.length, failed: sealFailures.length, failures: sealFailures.slice(0, 50) },
      anchorsChecked: anchors.length,
    };
    const id = await this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(
        `INSERT INTO integrity_anchor (audit_seq, audit_hash, audit_events_checked, audit_chain_ok, documents_checked, documents_failed, anchors_ok, details, run_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [newest?.seq ?? null, newest?.chain_hash ?? null, events, chainOk, files.length, failures.length, anchorsOk, JSON.stringify(details), actor?.accountId ?? null],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.INTEGRITY_CHECK_RUN,
        actorAccountId: actor?.accountId ?? null,
        actorDescription: actor?.description ?? 'system (nightly integrity check)',
        subjectDescription: 'audit history and stored documents',
        newValue: ok ? 'intact' : 'PROBLEMS FOUND',
        summary: `Integrity check: ${events} audit events (${chainOk ? 'chain intact' : `chain broken at ${broken.length} point(s)`}), ${anchors.length} earlier anchor(s) ${anchorsOk ? 'present' : `— ${missing.length} missing`}, ${files.length} stored file(s) (${failures.length} failed), ${sealRows.length} seal(s) (${sealFailures.length} failed).`.slice(0, 600),
      });
      return row.id as string;
    });
    return this.report(id);
  }

  async runs(limit = 30) {
    const rows = await this.dataSource.query(
      `SELECT a.id, a.run_at AS "runAt", a.audit_events_checked AS "auditEvents", a.audit_chain_ok AS "chainOk", a.anchors_ok AS "anchorsOk",
              a.documents_checked AS "documents", a.documents_failed AS "documentsFailed", a.details, coalesce(p.full_name, 'Systeem') AS "runBy"
         FROM integrity_anchor a LEFT JOIN account ac ON ac.id = a.run_by_account_id LEFT JOIN person p ON p.id = ac.person_id
        ORDER BY a.run_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    return rows.map((r: Record<string, unknown> & { details: { seals?: { failed: number } } }) => ({
      ...r,
      sealsFailed: r.details?.seals?.failed ?? 0,
      ok: Boolean(r.chainOk && r.anchorsOk && r.documentsFailed === 0 && (r.details?.seals?.failed ?? 0) === 0),
      details: undefined,
    }));
  }

  async report(id: string): Promise<IntegrityReport> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Unknown integrity check.');
    const [a] = await this.dataSource.query(`SELECT * FROM integrity_anchor WHERE id = $1`, [id]);
    if (!a) throw new NotFoundException('Unknown integrity check.');
    const d = a.details;
    const [seal] = await this.dataSource.query(`SELECT id FROM document_seal WHERE subject_type = 'PACKAGE' AND subject_id = $1 ORDER BY sealed_at DESC LIMIT 1`, [id]);
    return {
      id: a.id,
      runAt: new Date(a.run_at).toISOString(),
      ok: a.audit_chain_ok && a.anchors_ok && a.documents_failed === 0 && (d.seals?.failed ?? 0) === 0,
      audit: { events: a.audit_events_checked, chainOk: a.audit_chain_ok, broken: d.broken ?? [], newestSeq: a.audit_seq === null ? null : Number(a.audit_seq), newestHash: a.audit_hash },
      anchors: { checked: d.anchorsChecked ?? 0, ok: a.anchors_ok, missing: d.missingAnchors ?? [] },
      documents: { checked: a.documents_checked, failed: a.documents_failed, failures: d.documentFailures ?? [] },
      seals: d.seals ?? { checked: 0, failed: 0, failures: [] },
      sealId: seal?.id ?? null,
    };
  }

  /** The report as a PDF, sealed so a copy handed to an inspector can be checked. */
  async pdf(actor: Actor, id: string): Promise<Buffer> {
    const r = await this.report(id);
    const branding = await this.settings.get('branding');
    const sealId = r.sealId ?? (await this.seals.seal('PACKAGE', r.id, { kind: 'INTEGRITY_REPORT', report: r as unknown as Record<string, unknown> }, actor.accountId)).id;
    const doc = newPdf({ title: 'Integriteitsverklaring' });
    letterhead(doc, branding);
    doc.font('Bold').fontSize(17).fillColor(branding.primaryColor).text('Integriteitsverklaring');
    doc.font('Body').fontSize(9).fillColor('#4b5563').text(`Controle uitgevoerd op ${surinameDateTime(r.runAt)} (Surinaamse tijd). Rapportnummer ${r.id}.`);
    doc.moveDown(0.8);
    doc.font('Bold').fontSize(13).fillColor(r.ok ? '#166534' : '#991b1b').text(r.ok ? 'Uitkomst: alles intact' : 'Uitkomst: afwijkingen gevonden');
    doc.moveDown(0.6);
    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    table(
      doc,
      [
        { label: 'Onderdeel', width: usable * 0.32 },
        { label: 'Gecontroleerd', width: usable * 0.2 },
        { label: 'Uitkomst', width: usable * 0.48 },
      ],
      [
        ['Logboek (hashketen)', String(r.audit.events), r.audit.chainOk ? 'Keten ongebroken' : `Keten gebroken bij nr. ${r.audit.broken.join(', ')}`],
        ['Eerdere ankerpunten', String(r.anchors.checked), r.anchors.ok ? 'Alle aanwezig en ongewijzigd' : `${r.anchors.missing.length} ontbreken of gewijzigd`],
        ['Opgeslagen bestanden', String(r.documents.checked), r.documents.failed ? `${r.documents.failed} afwijkend` : 'Alle ongewijzigd (SHA-256)'],
        ['Digitale zegels', String(r.seals.checked), r.seals.failed ? `${r.seals.failed} ongeldig` : 'Alle geldig'],
      ],
      branding.primaryColor,
    );
    doc.moveDown(0.8);
    doc.font('Body').fontSize(9).fillColor('#111827').text(`Nieuwste logboekregel: nr. ${r.audit.newestSeq ?? '—'}, hash ${r.audit.newestHash ?? '—'}`, { width: usable });
    if (r.documents.failures.length) {
      doc.moveDown(0.5).font('Bold').fontSize(10).text('Afwijkende bestanden');
      for (const f of r.documents.failures.slice(0, 30)) doc.font('Body').fontSize(9).text(`• ${f.name} (${f.kind === 'DOCUMENT' ? 'document' : 'taakbijlage'}): ${f.reason === 'file missing' ? 'bestand ontbreekt' : 'inhoud gewijzigd'}`);
    }
    doc.moveDown(1);
    const url = `${(process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/verifieren/${sealId}`;
    const qr = await qrPng(url, 200);
    const y = doc.y;
    doc.image(qr, doc.page.margins.left, y, { width: 90 });
    doc.font('Bold').fontSize(9).text('Digitaal zegel', doc.page.margins.left + 105, y + 8);
    doc.font('Body').fontSize(8.5).text(`Zegelnummer ${sealId}`, doc.page.margins.left + 105, y + 22);
    doc.text(url, doc.page.margins.left + 105, y + 36, { lineBreak: false });
    doc.y = y + 100;
    footer(doc, `${branding.organisationName}, integriteitsverklaring`);
    return pdfBuffer(doc);
  }
}
