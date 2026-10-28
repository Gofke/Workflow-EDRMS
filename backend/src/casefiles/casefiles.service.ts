import { dutchHeadline } from '../timeline/headline-nl';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import JSZip from 'jszip';
import { DataSource } from 'typeorm';
import { AccessService } from '../access/access.service';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { footer, letterhead, newPdf, pdfBuffer, table, surinameDateTime } from '../core/pdf';
import { canonicalJson, SealService } from '../core/seal.service';
import { DocumentsService } from '../documents/documents.service';
import { Actor } from '../records/registration.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';

export interface CategoryInput {
  code: string;
  name: string;
  parentId?: string | null;
  description?: string;
  retentionYears?: number | null;
  retentionAction?: 'DESTROY' | 'TRANSFER' | 'REVIEW' | null;
  handlingWorkingDays?: number | null;
  defaultClassification?: string;
  defaultRouteId?: string | null;
  isActive?: boolean;
}

const RELATIONS = ['RELATED', 'FOLLOW_UP', 'PRECEDES', 'SAME_SUBJECT'];

/**
 * The file plan, related matters, retention, legal holds, the archive
 * transfer package and the timeline as a PDF.
 *
 * Retention never destroys anything by itself. When a closed matter reaches
 * the end of its retention period it appears on the review list; the records
 * manager records the decision, with a reason, and a legal hold blocks any
 * decision while it is in place. Removing the stored files after a decision
 * to destroy is an operational step outside the application, done under the
 * Ministry's procedure; the record of the decision stays.
 */
@Injectable()
export class CaseFilesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly timeline: TimelineService,
    private readonly documents: DocumentsService,
    private readonly seals: SealService,
    private readonly settings: SettingsService,
  ) {}

  // ------------------------------------------------------------- file plan

  categories(includeInactive = false) {
    return this.dataSource.query(
      `SELECT c.id, c.code, c.name, c.parent_id AS "parentId", c.description, c.retention_years AS "retentionYears",
              c.retention_action AS "retentionAction", c.handling_working_days AS "handlingWorkingDays",
              c.default_classification AS "defaultClassification", c.default_route_id AS "defaultRouteId",
              c.is_active AS "isActive",
              (SELECT count(*)::int FROM dossier d WHERE d.category_id = c.id) AS "dossierCount"
         FROM dossier_category c WHERE ($1::boolean OR c.is_active) ORDER BY c.code`,
      [includeInactive],
    );
  }

  async saveCategory(actor: Actor, id: string | null, input: CategoryInput) {
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,40}$/.test(code)) throw new BadRequestException('A category code uses letters, digits, dots and dashes.');
    if (!input.name?.trim()) throw new BadRequestException('A category needs a name.');
    if (input.retentionAction && !['DESTROY', 'TRANSFER', 'REVIEW'].includes(input.retentionAction)) throw new BadRequestException('Unknown retention action.');
    if ((input.retentionYears ?? null) !== null && (input.retentionAction ?? null) === null) {
      throw new BadRequestException('Say what happens at the end of the retention period.');
    }
    if (input.parentId) {
      if (input.parentId === id) throw new BadRequestException('A category cannot sit under itself.');
      const [p] = await this.dataSource.query(`SELECT id FROM dossier_category WHERE id = $1`, [input.parentId]);
      if (!p) throw new NotFoundException('Unknown parent category.');
    }
    const clash = await this.dataSource.query(`SELECT id FROM dossier_category WHERE code = $1 AND ($2::uuid IS NULL OR id <> $2)`, [code, id]);
    if (clash.length) throw new ConflictException('A category with this code already exists.');
    const values = [
      code,
      input.name.trim(),
      input.parentId ?? null,
      input.description?.trim() ?? '',
      input.retentionYears ?? null,
      input.retentionAction ?? null,
      input.handlingWorkingDays ?? null,
      input.defaultClassification ?? 'INTERNAL',
      input.defaultRouteId ?? null,
      input.isActive ?? true,
    ];
    const saved = await this.dataSource.transaction(async (manager) => {
      let rowId = id;
      if (id) {
        const r = await manager.query(
          `UPDATE dossier_category SET code = $2, name = $3, parent_id = $4, description = $5, retention_years = $6,
             retention_action = $7, handling_working_days = $8, default_classification = $9, default_route_id = $10,
             is_active = $11, updated_at = now() WHERE id = $1`,
          [id, ...values],
        );
        if (r[1] === 0) throw new NotFoundException('Unknown category.');
      } else {
        const [row] = await manager.query(
          `INSERT INTO dossier_category (code, name, parent_id, description, retention_years, retention_action,
             handling_working_days, default_classification, default_route_id, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          values,
        );
        rowId = row.id;
      }
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.CATEGORY_SAVED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `category ${code} — ${input.name.trim()}`.slice(0, 260),
        newValue: `retention ${input.retentionYears ?? '—'} yr, ${input.retentionAction ?? '—'}; handling ${input.handlingWorkingDays ?? '—'} wd`,
        summary: `${actor.description} ${id ? 'updated' : 'created'} the file-plan category ${code} (${input.name.trim()}).`,
      });
      return rowId as string;
    });
    return (await this.categories(true)).find((c: { id: string }) => c.id === saved);
  }

  async categorise(actor: Actor, dossierId: string, categoryId: string | null) {
    const [d] = await this.dataSource.query(`SELECT state, category_id, dossier_identity, subject FROM dossier WHERE id = $1`, [dossierId]);
    if (!d) throw new NotFoundException('Unknown dossier.');
    if (d.state === 'CLOSED') throw new BadRequestException('This dossier is closed. Reopen the dossier before changing it.');
    let name: string | null = null;
    if (categoryId) {
      const [c] = await this.dataSource.query(`SELECT code, name FROM dossier_category WHERE id = $1 AND is_active`, [categoryId]);
      if (!c) throw new NotFoundException('Unknown or inactive category.');
      name = `${c.code} ${c.name}`;
    }
    if (d.category_id === categoryId) return { categoryId };
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE dossier SET category_id = $2, version = version + 1 WHERE id = $1`, [dossierId, categoryId]);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.DOSSIER_CATEGORISED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${d.dossier_identity} — ${d.subject}`.slice(0, 260),
        newValue: name ?? 'no category',
        summary: `${actor.description} placed ${d.dossier_identity} in the file plan under ${name ?? 'no category'}.`.slice(0, 600),
      });
    });
    return { categoryId };
  }

  // ------------------------------------------------------------- related matters

  async relations(accountId: string, dossierId: string) {
    const profile = await this.access.profile(accountId);
    const pred = this.access.dossierPredicate(profile, 'o', 2);
    return this.dataSource.query(
      `SELECT r.id, r.relation, r.note, r.created_at AS "createdAt", p.full_name AS "createdByName",
              o.id AS "dossierId", o.dossier_identity AS "dossierIdentity", o.subject, o.processing_state AS "processingState",
              (r.dossier_id = $1) AS outgoing
         FROM dossier_relation r
         JOIN dossier o ON o.id = CASE WHEN r.dossier_id = $1 THEN r.related_dossier_id ELSE r.dossier_id END
         JOIN account a ON a.id = r.created_by_account_id JOIN person p ON p.id = a.person_id
        WHERE (r.dossier_id = $1 OR r.related_dossier_id = $1) AND ${pred.sql}
        ORDER BY r.created_at`,
      [dossierId, ...pred.params],
    );
  }

  async relate(actor: Actor, dossierId: string, relatedId: string, relation: string, note?: string) {
    if (!RELATIONS.includes(relation)) throw new BadRequestException('Unknown kind of relation.');
    if (dossierId === relatedId) throw new BadRequestException('A dossier cannot be related to itself.');
    await this.access.assertDossier(actor.accountId, relatedId);
    const existing = await this.dataSource.query(
      `SELECT 1 FROM dossier_relation WHERE (dossier_id = $1 AND related_dossier_id = $2) OR (dossier_id = $2 AND related_dossier_id = $1)`,
      [dossierId, relatedId],
    );
    if (existing.length) throw new ConflictException('These dossiers are already related.');
    const [a] = await this.dataSource.query(`SELECT dossier_identity FROM dossier WHERE id = $1`, [dossierId]);
    const [b] = await this.dataSource.query(`SELECT dossier_identity FROM dossier WHERE id = $1`, [relatedId]);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO dossier_relation (dossier_id, related_dossier_id, relation, note, created_by_account_id) VALUES ($1, $2, $3, $4, $5)`,
        [dossierId, relatedId, relation, note?.trim() || null, actor.accountId],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.DOSSIER_RELATED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${a.dossier_identity} ↔ ${b.dossier_identity}`,
        newValue: relation,
        summary: `${actor.description} related ${a.dossier_identity} to ${b.dossier_identity} (${relation.toLowerCase()}).`,
      });
    });
    return this.relations(actor.accountId, dossierId);
  }

  // ------------------------------------------------------------- retention and legal hold

  /**
   * Closed matters with a retention period, with the date it ends. `due` lists
   * those whose period has ended and that await a decision.
   */
  async retentionList(filter: 'due' | 'upcoming' | 'all' = 'due') {
    const rows = await this.dataSource.query(
      `SELECT d.id, d.dossier_identity AS "dossierIdentity", d.subject, d.legal_hold AS "legalHold", d.retention_state AS "retentionState",
              c.code AS "categoryCode", c.name AS "categoryName", c.retention_years AS "retentionYears", c.retention_action AS "retentionAction",
              to_char(closed.closed_at AT TIME ZONE 'America/Paramaribo', 'YYYY-MM-DD') AS "closedOn",
              to_char(coalesce(d.retention_due_date, (closed.closed_at AT TIME ZONE 'America/Paramaribo')::date + make_interval(years => c.retention_years)), 'YYYY-MM-DD') AS "retentionEndsOn"
         FROM dossier d
         JOIN dossier_category c ON c.id = d.category_id AND c.retention_years IS NOT NULL
         JOIN LATERAL (SELECT max(occurred_at) AS closed_at FROM dossier_state_event e WHERE e.dossier_id = d.id AND e.to_state = 'CLOSED') closed ON true
        WHERE d.state = 'CLOSED' AND d.retention_state IN ('ACTIVE','DUE')
        ORDER BY "retentionEndsOn"`,
    );
    const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const in90 = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10);
    return rows.filter((r: { retentionEndsOn: string }) =>
      filter === 'all' ? true : filter === 'due' ? r.retentionEndsOn <= today : r.retentionEndsOn > today && r.retentionEndsOn <= in90,
    );
  }

  async decideRetention(actor: Actor, dossierId: string, decision: 'DESTROY' | 'TRANSFER' | 'RETAIN' | 'EXTEND', reason: string, extendUntil?: string) {
    const [d] = await this.dataSource.query(
      `SELECT d.*, c.retention_years FROM dossier d LEFT JOIN dossier_category c ON c.id = d.category_id WHERE d.id = $1`,
      [dossierId],
    );
    if (!d) throw new NotFoundException('Unknown dossier.');
    if (d.state !== 'CLOSED') throw new BadRequestException('A retention decision is taken on a closed dossier only.');
    if (!['ACTIVE', 'DUE'].includes(d.retention_state)) throw new BadRequestException('A retention decision has already been taken on this dossier.');
    if (!reason?.trim()) throw new BadRequestException('A reason is required for a retention decision.');
    if (d.legal_hold && ['DESTROY', 'TRANSFER'].includes(decision)) {
      throw new BadRequestException('This matter is under legal hold. Release the hold before a retention decision.');
    }
    if (decision === 'EXTEND' && !/^\d{4}-\d{2}-\d{2}$/.test(extendUntil ?? '')) throw new BadRequestException('Give the date the retention is extended to.');
    if (decision === 'TRANSFER') {
      const packages = await this.dataSource.query(`SELECT 1 FROM archive_transfer WHERE dossier_id = $1`, [dossierId]);
      if (!packages.length) throw new BadRequestException('Export the archive transfer package before recording the transfer.');
    }
    const newState = decision === 'DESTROY' ? 'DESTROYED' : decision === 'TRANSFER' ? 'TRANSFERRED' : decision === 'RETAIN' ? 'RETAINED' : 'ACTIVE';
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO retention_decision (dossier_id, decision, reason, extend_until, decided_by_account_id) VALUES ($1, $2, $3, $4, $5)`,
        [dossierId, decision, reason.trim(), decision === 'EXTEND' ? extendUntil : null, actor.accountId],
      );
      await manager.query(
        `UPDATE dossier SET retention_state = $2, retention_due_date = CASE WHEN $3::date IS NOT NULL THEN $3::date ELSE retention_due_date END WHERE id = $1`,
        [dossierId, newState, decision === 'EXTEND' ? extendUntil : null],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.RETENTION_DECIDED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${d.dossier_identity} — ${d.subject}`.slice(0, 260),
        previousValue: d.retention_state,
        newValue: `${decision}${decision === 'EXTEND' ? ` until ${extendUntil}` : ''}`,
        summary: `${actor.description} recorded the retention decision ${decision} for ${d.dossier_identity} (reason: ${reason.trim()}).`.slice(0, 600),
      });
    });
    return this.retentionOf(dossierId);
  }

  async retentionOf(dossierId: string) {
    const [d] = await this.dataSource.query(
      `SELECT d.legal_hold AS "legalHold", d.retention_state AS "retentionState", to_char(d.retention_due_date, 'YYYY-MM-DD') AS "retentionDueDate",
              c.retention_years AS "retentionYears", c.retention_action AS "retentionAction"
         FROM dossier d LEFT JOIN dossier_category c ON c.id = d.category_id WHERE d.id = $1`,
      [dossierId],
    );
    const decisions = await this.dataSource.query(
      `SELECT r.decision, r.reason, to_char(r.extend_until, 'YYYY-MM-DD') AS "extendUntil", r.decided_at AS "decidedAt", p.full_name AS "decidedByName"
         FROM retention_decision r JOIN account a ON a.id = r.decided_by_account_id JOIN person p ON p.id = a.person_id
        WHERE r.dossier_id = $1 ORDER BY r.decided_at`,
      [dossierId],
    );
    const holds = await this.dataSource.query(
      `SELECT h.action, h.reason, h.occurred_at AS "occurredAt", p.full_name AS "actorName"
         FROM legal_hold_event h JOIN account a ON a.id = h.actor_account_id JOIN person p ON p.id = a.person_id
        WHERE h.dossier_id = $1 ORDER BY h.occurred_at`,
      [dossierId],
    );
    const transfers = await this.dataSource.query(
      `SELECT t.id, t.package_hash AS "packageHash", t.exported_at AS "exportedAt", p.full_name AS "exportedByName", t.seal_id AS "sealId"
         FROM archive_transfer t JOIN account a ON a.id = t.exported_by_account_id JOIN person p ON p.id = a.person_id
        WHERE t.dossier_id = $1 ORDER BY t.exported_at`,
      [dossierId],
    );
    return { ...d, decisions, holds, transfers };
  }

  async legalHold(actor: Actor, dossierId: string, action: 'SET' | 'RELEASED', reason: string) {
    const [d] = await this.dataSource.query(`SELECT legal_hold, dossier_identity, subject FROM dossier WHERE id = $1`, [dossierId]);
    if (!d) throw new NotFoundException('Unknown dossier.');
    if (!reason?.trim()) throw new BadRequestException('A reason is required for a legal hold.');
    if (action === 'SET' && d.legal_hold) throw new BadRequestException('This matter is already under legal hold.');
    if (action === 'RELEASED' && !d.legal_hold) throw new BadRequestException('This matter is not under legal hold.');
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`INSERT INTO legal_hold_event (dossier_id, action, reason, actor_account_id) VALUES ($1, $2, $3, $4)`, [
        dossierId,
        action,
        reason.trim(),
        actor.accountId,
      ]);
      await manager.query(`UPDATE dossier SET legal_hold = $2 WHERE id = $1`, [dossierId, action === 'SET']);
      await this.audit.recordInTransaction(manager, {
        eventType: action === 'SET' ? AuditEventType.LEGAL_HOLD_SET : AuditEventType.LEGAL_HOLD_RELEASED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${d.dossier_identity} — ${d.subject}`.slice(0, 260),
        summary: `${actor.description} ${action === 'SET' ? 'placed' : 'released'} a legal hold on ${d.dossier_identity} (reason: ${reason.trim()}).`.slice(0, 600),
      });
    });
    return this.retentionOf(dossierId);
  }

  // ------------------------------------------------------------- exports

  async timelinePdf(actor: Actor, dossierId: string): Promise<{ bytes: Buffer; filename: string }> {
    const dossier = await this.timeline.dossierFor(dossierId);
    const entries = await this.timeline.forDossier(dossierId);
    const branding = await this.settings.get('branding');
    const doc = newPdf({ title: `Tijdlijn ${dossier.dossierIdentity}` });
    letterhead(doc, branding);
    doc.font('Bold').fontSize(16).fillColor(branding.primaryColor).text(`Tijdlijn ${dossier.dossierIdentity}`);
    doc.font('Body').fontSize(11).fillColor('#111827').text(dossier.subject);
    doc.fontSize(8.5).fillColor('#6b7280').text(`Geëxporteerd door ${actor.description} op ${surinameDateTime(new Date())}. ${entries.length} ${entries.length === 1 ? "gebeurtenis" : "gebeurtenissen"}, afgeleid uit de registratie en niet afzonderlijk opgeslagen.`);
    doc.moveDown(0.8);
    const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    table(
      doc,
      [
        { label: 'Moment', width: usable * 0.17 },
        { label: 'Gebeurtenis', width: usable * 0.33 },
        { label: 'Door', width: usable * 0.18 },
        { label: 'Toelichting', width: usable * 0.32 },
      ],
      entries.map((e) => [
        surinameDateTime(e.occurredAt),
        dutchHeadline(e.headline),
        e.onBehalfOfName ? `${e.actorName} (namens ${e.onBehalfOfName})` : e.actorName,
        dutchHeadline(e.detail ?? '').slice(0, 220),
      ]),
      branding.primaryColor,
    );
    footer(doc, `${branding.organisationName}, ${dossier.dossierIdentity}`);
    const bytes = await pdfBuffer(doc);
    await this.audit.recordStrict({
      eventType: AuditEventType.TIMELINE_PDF_EXPORTED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      subjectDescription: `${dossier.dossierIdentity} — ${dossier.subject}`.slice(0, 260),
      newValue: `${entries.length} entries, PDF`,
      summary: `${actor.description} exported the timeline of ${dossier.dossierIdentity} as PDF (${entries.length} entries).`,
    });
    return { bytes, filename: `${dossier.dossierIdentity}-tijdlijn.pdf`.replace(/[^A-Za-z0-9._-]/g, '_') };
  }

  /**
   * The archive transfer package: every record of the matter with its
   * documents, their fingerprints, the decisions and the timeline, described in
   * a manifest that is signed with the ministry's key. The receiving archive
   * can check every file against the manifest and the manifest against the key.
   */
  async archivePackage(actor: Actor, dossierId: string): Promise<{ bytes: Buffer; filename: string; packageHash: string; sealId: string }> {
    const dossier = await this.timeline.dossierFor(dossierId);
    const [meta] = await this.dataSource.query(
      `SELECT d.*, c.code AS category_code, c.name AS category_name, c.retention_years, c.retention_action, u.name AS unit
         FROM dossier d LEFT JOIN dossier_category c ON c.id = d.category_id LEFT JOIN organisational_unit u ON u.id = d.owning_unit_id
        WHERE d.id = $1`,
      [dossierId],
    );
    const items = await this.dataSource.query(
      `SELECT ci.id, ci.registration_identity, ci.direction, ci.subject, ci.party, ci.document_date::text AS document_date,
              ci.registered_at, ci.classification, ci.sender_reference
         FROM dossier_link dl JOIN correspondence_item ci ON ci.id = dl.correspondence_item_id
        WHERE dl.dossier_id = $1 ORDER BY ci.registered_at`,
      [dossierId],
    );
    const zip = new JSZip();
    const files: { path: string; sha256: string; bytes: number; recordIdentity: string; mediaType: string }[] = [];
    for (const item of items) {
      const docs = await this.dataSource.query(
        `SELECT id, original_filename, media_type FROM captured_document WHERE correspondence_item_id = $1 ORDER BY captured_at`,
        [item.id],
      );
      for (const [index, d] of docs.entries()) {
        const { bytes } = await this.documents.bytesOf(d.id);
        const path = `documenten/${item.registration_identity}/${String(index + 1).padStart(2, '0')}-${String(d.original_filename).replace(/[^\w.-]/g, '_')}`;
        zip.file(path, bytes);
        files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, recordIdentity: item.registration_identity, mediaType: d.media_type });
      }
    }
    const timeline = await this.timeline.forDossier(dossierId);
    const decisions = await this.dataSource.query(
      `SELECT we.event_type, we.reason, we.reviewed_version, we.occurred_at, p.full_name AS actor, obp.full_name AS on_behalf_of
         FROM workflow_event we JOIN account a ON a.id = we.actor_account_id JOIN person p ON p.id = a.person_id
         LEFT JOIN account oba ON oba.id = we.on_behalf_of_account_id LEFT JOIN person obp ON obp.id = oba.person_id
        WHERE we.dossier_id = $1 ORDER BY we.occurred_at`,
      [dossierId],
    );
    const { bytes: timelineBytes } = await this.timelinePdf(actor, dossierId);
    zip.file('tijdlijn.pdf', timelineBytes);
    files.push({ path: 'tijdlijn.pdf', sha256: createHash('sha256').update(timelineBytes).digest('hex'), bytes: timelineBytes.length, recordIdentity: dossier.dossierIdentity, mediaType: 'application/pdf' });
    const branding = await this.settings.get('branding');
    const manifest = {
      format: 'JusPol-EDRMS archive transfer package, version 1',
      issuer: branding.organisationName,
      createdAt: new Date().toISOString(),
      createdBy: actor.description,
      dossier: {
        identity: meta.dossier_identity,
        subject: meta.subject,
        classification: meta.classification,
        owningUnit: meta.unit,
        category: meta.category_code ? { code: meta.category_code, name: meta.category_name } : null,
        retention: meta.retention_years !== null ? { years: meta.retention_years, action: meta.retention_action } : null,
        state: meta.state,
        processingState: meta.processing_state,
        openedAt: new Date(meta.created_at).toISOString(),
      },
      records: items.map((i: Record<string, unknown>) => ({
        identity: i.registration_identity,
        direction: i.direction,
        subject: i.subject,
        party: i.party,
        documentDate: i.document_date,
        registeredAt: i.registered_at ? new Date(i.registered_at as string).toISOString() : null,
        classification: i.classification,
        senderReference: i.sender_reference,
      })),
      decisions: decisions.map((d: Record<string, unknown>) => ({
        event: d.event_type,
        by: d.actor,
        onBehalfOf: d.on_behalf_of,
        reason: d.reason,
        reviewedVersion: d.reviewed_version,
        at: new Date(d.occurred_at as string).toISOString(),
      })),
      timelineEntries: timeline.length,
      files,
    };
    const manifestText = canonicalJson(manifest);
    zip.file('manifest.json', manifestText);
    zip.file('manifest.sig', this.seals.signBytes(Buffer.from(manifestText)));
    zip.file('publieke-sleutel.pem', this.seals.publicKeyPem);
    zip.file(
      'LEESMIJ.txt',
      [
        `Archiefoverdrachtspakket ${meta.dossier_identity}`,
        '',
        'manifest.json      beschrijving van het dossier, de stukken en elk bestand met zijn SHA-256',
        'manifest.sig       Ed25519-handtekening over manifest.json, te controleren met publieke-sleutel.pem',
        'documenten/        de vastgelegde stukken, ongewijzigd',
        'tijdlijn.pdf       de chronologische weergave van de zaak',
        '',
        'Controle: bereken de SHA-256 van elk bestand en vergelijk met manifest.json; controleer daarna manifest.sig.',
      ].join('\n'),
    );
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const packageHash = createHash('sha256').update(bytes).digest('hex');
    const seal = await this.seals.seal('PACKAGE', dossierId, { manifestSha256: createHash('sha256').update(manifestText).digest('hex'), packageSha256: packageHash, dossierIdentity: meta.dossier_identity, files: files.length }, actor.accountId);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO archive_transfer (dossier_id, package_hash, manifest, seal_id, exported_by_account_id) VALUES ($1, $2, $3, $4, $5)`,
        [dossierId, packageHash, manifestText, seal.id, actor.accountId],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.ARCHIVE_PACKAGE_EXPORTED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${meta.dossier_identity} — ${meta.subject}`.slice(0, 260),
        newValue: `${files.length} files, sha256 ${packageHash.slice(0, 12)}…`,
        summary: `${actor.description} exported the archive transfer package of ${meta.dossier_identity} (${files.length} files).`,
      });
    });
    return { bytes, filename: `${meta.dossier_identity}-archiefpakket.zip`.replace(/[^A-Za-z0-9._-]/g, '_'), packageHash, sealId: seal.id };
  }
}
