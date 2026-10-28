import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AccessService } from '../access/access.service';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { DECISION_ROLES, todayInSuriname } from '../common/actor';
import { footer, letterhead, newPdf, pdfBuffer, qrPng } from '../core/pdf';
import { SealService } from '../core/seal.service';
import { WorkingDaysService } from '../core/working-days.service';
import { DocumentsService } from '../documents/documents.service';
import { Actor, RegistrationService } from '../records/registration.service';
import { SettingsService } from '../settings/settings.service';

const MONTHS_NL = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function longDate(iso: string | null | undefined, language: 'nl' | 'en' = 'nl'): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return language === 'en' ? `${d} ${MONTHS_EN[m - 1]} ${y}` : `${d} ${MONTHS_NL[m - 1]} ${y}`;
}

export const DEFAULT_LETTER_TEMPLATES = [
  {
    code: 'ONTVANGST',
    name: 'Ontvangstbevestiging',
    body:
      'Geachte heer/mevrouw,\n\nHierbij bevestig ik de ontvangst van uw brief van {{uw_brief_datum}}{{uw_kenmerk_zin}}, betreffende {{onderwerp}}.\n\n' +
      'Uw brief is geregistreerd onder nummer {{registratienummer}} en wordt in behandeling genomen. U ontvangt binnen {{termijn}} werkdagen een inhoudelijke reactie.\n\n' +
      'Met de volgcode op de bijgevoegde ontvangstbevestiging kunt u de voortgang online volgen.',
  },
  {
    code: 'ANTWOORD',
    name: 'Inhoudelijk antwoord',
    body:
      'Geachte heer/mevrouw,\n\nNaar aanleiding van uw brief van {{uw_brief_datum}}{{uw_kenmerk_zin}}, betreffende {{onderwerp}}, bericht ik u het volgende.\n\n' +
      '[Inhoudelijke reactie]\n\nIk vertrouw erop u hiermee voldoende te hebben geïnformeerd.',
  },
  {
    code: 'DOORVERWIJZING',
    name: 'Doorverwijzing naar bevoegde instantie',
    body:
      'Geachte heer/mevrouw,\n\nIn goede orde ontving ik uw brief van {{uw_brief_datum}}{{uw_kenmerk_zin}}, betreffende {{onderwerp}}.\n\n' +
      'De behandeling van uw verzoek valt onder de bevoegdheid van [instantie]. Ik heb uw brief daarom ter verdere afhandeling doorgezonden. U ontvangt van die instantie bericht.',
  },
  {
    code: 'UITNODIGING',
    name: 'Uitnodiging voor gesprek',
    body:
      'Geachte heer/mevrouw,\n\nNaar aanleiding van uw brief van {{uw_brief_datum}}, betreffende {{onderwerp}}, nodig ik u uit voor een gesprek op [datum] om [tijd] uur op het Ministerie van Justitie en Politie.\n\n' +
      'Ik verzoek u de uitnodiging uiterlijk [datum] te bevestigen.',
  },
];

/**
 * Letters: drafting a reply in versions, standard letters with the ministry
 * letterhead, the finished letter as a PDF with a verifiable seal, the label
 * for a paper letter, the citizen's receipt, and the public status lookup.
 *
 * A draft version is never overwritten: version 2 is added after version 1.
 * The PDF of a letter is captured on the record like any other document, so it
 * carries its own fingerprint and its own access log.
 */
@Injectable()
export class LettersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly documents: DocumentsService,
    private readonly registration: RegistrationService,
    private readonly seals: SealService,
    private readonly workingDays: WorkingDaysService,
  ) {}

  // ------------------------------------------------------------- templates

  async templates(includeInactive = false) {
    await this.ensureDefaultTemplates();
    return this.dataSource.query(
      `SELECT id, code, name, language, body, is_active AS "isActive", updated_at AS "updatedAt"
         FROM letter_template WHERE ($1::boolean OR is_active) ORDER BY name`,
      [includeInactive],
    );
  }

  async ensureDefaultTemplates(): Promise<void> {
    const [{ n }] = await this.dataSource.query(`SELECT count(*)::int AS n FROM letter_template`);
    if (n > 0) return;
    for (const t of DEFAULT_LETTER_TEMPLATES) {
      await this.dataSource.query(
        `INSERT INTO letter_template (code, name, body) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`,
        [t.code, t.name, t.body],
      );
    }
  }

  async saveTemplate(actor: Actor, id: string | null, input: { code: string; name: string; body: string; language?: string; isActive?: boolean }) {
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) throw new BadRequestException('A template code uses letters, digits, dashes and underscores.');
    if (!input.name.trim() || !input.body.trim()) throw new BadRequestException('A template needs a name and a text.');
    const clash = await this.dataSource.query(`SELECT id FROM letter_template WHERE code = $1 AND ($2::uuid IS NULL OR id <> $2)`, [code, id]);
    if (clash.length) throw new ConflictException('A template with this code already exists.');
    const saved = await this.dataSource.transaction(async (manager) => {
      let rowId = id;
      if (id) {
        const r = await manager.query(
          `UPDATE letter_template SET code = $2, name = $3, body = $4, language = coalesce($5, language), is_active = coalesce($6, is_active), updated_at = now() WHERE id = $1`,
          [id, code, input.name.trim(), input.body, input.language ?? null, input.isActive ?? null],
        );
        if (r[1] === 0) throw new NotFoundException('Unknown template.');
      } else {
        const [row] = await manager.query(
          `INSERT INTO letter_template (code, name, body, language, created_by_account_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [code, input.name.trim(), input.body, input.language ?? 'nl', actor.accountId],
        );
        rowId = row.id;
      }
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.LETTER_TEMPLATE_SAVED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `letter template ${code}`,
        summary: `${actor.description} ${id ? 'updated' : 'created'} the letter template ${input.name.trim()} (${code}).`,
      });
      return rowId as string;
    });
    return (await this.templates(true)).find((t: { id: string }) => t.id === saved);
  }

  // ------------------------------------------------------------- drafting

  async versions(itemId: string) {
    return this.dataSource.query(
      `SELECT v.id, v.version_no AS "versionNo", v.body, v.note, v.created_at AS "createdAt", p.full_name AS "authorName",
              t.name AS "templateName", v.ai_interaction_id AS "aiInteractionId"
         FROM item_draft_version v JOIN account a ON a.id = v.created_by_account_id JOIN person p ON p.id = a.person_id
         LEFT JOIN letter_template t ON t.id = v.template_id
        WHERE v.item_id = $1 ORDER BY v.version_no`,
      [itemId],
    );
  }

  async saveVersion(actor: Actor, itemId: string, input: { body: string; note?: string; templateId?: string | null; aiInteractionId?: string | null }) {
    const [item] = await this.dataSource.query(`SELECT state, registration_identity, subject FROM correspondence_item WHERE id = $1`, [itemId]);
    if (!item) throw new NotFoundException('Unknown item.');
    if (item.state !== 'DRAFT') throw new BadRequestException('A registered record is final. Its text can no longer be changed.');
    if (!input.body?.trim()) throw new BadRequestException('The text of a version cannot be empty.');
    if (input.body.length > 100_000) throw new BadRequestException('The text is too long.');
    const versionNo = await this.dataSource.transaction(async (manager) => {
      const [{ next }] = await manager.query(
        `SELECT coalesce(max(version_no), 0) + 1 AS next FROM item_draft_version WHERE item_id = $1`,
        [itemId],
      );
      await manager.query(
        `INSERT INTO item_draft_version (item_id, version_no, body, note, template_id, created_by_account_id, ai_interaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [itemId, next, input.body, input.note?.trim() || null, input.templateId ?? null, actor.accountId, input.aiInteractionId ?? null],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.DRAFT_VERSION_SAVED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `draft: ${item.subject}`.slice(0, 260),
        newValue: `version ${next}${input.aiInteractionId ? ' (from an AI suggestion)' : ''}`,
        summary: `${actor.description} saved version ${next} of the text of the draft "${item.subject}".`.slice(0, 600),
      });
      return next as number;
    });
    return { versionNo, versions: await this.versions(itemId) };
  }

  /** Starts a reply: a new outgoing draft, linked to the letter it answers. */
  async startReply(actor: Actor, itemId: string, templateId?: string) {
    const [original] = await this.dataSource.query(
      `SELECT id, subject, party, registration_identity, sender_reference, document_date::text AS document_date, state, classification
         FROM correspondence_item WHERE id = $1`,
      [itemId],
    );
    if (!original) throw new NotFoundException('Unknown item.');
    if (original.state !== 'REGISTERED') throw new BadRequestException('Register the letter before replying to it.');
    const draft = await this.registration.createDraft(
      actor,
      {
        direction: 'OUTGOING' as never,
        subject: `Antwoord: ${original.subject}`.slice(0, 400),
        party: original.party ?? undefined,
        classification: original.classification,
      },
      'COMPOSED',
    );
    await this.dataSource.query(`UPDATE correspondence_item SET in_reply_to_item_id = $2 WHERE id = $1`, [draft.id, itemId]);
    if (templateId) {
      const body = await this.fillTemplate(templateId, original, null);
      await this.saveVersion(actor, draft.id, { body, note: 'Vanuit sjabloon', templateId });
    }
    return draft;
  }

  async fillTemplate(templateId: string, original: Record<string, string | null>, ourReference: string | null): Promise<string> {
    const [template] = await this.dataSource.query(`SELECT body FROM letter_template WHERE id = $1 AND is_active`, [templateId]);
    if (!template) throw new NotFoundException('Unknown letter template.');
    const deadlines = await this.settings.get('deadlines');
    const values: Record<string, string> = {
      datum: longDate(todayInSuriname()),
      onderwerp: original.subject ?? '',
      geadresseerde: original.party ?? '',
      uw_kenmerk: original.sender_reference ?? '',
      uw_kenmerk_zin: original.sender_reference ? ` (uw kenmerk ${original.sender_reference})` : '',
      uw_brief_datum: original.document_date ? longDate(original.document_date) : 'onbekende datum',
      registratienummer: original.registration_identity ?? '',
      kenmerk: ourReference ?? '(volgt na registratie)',
      termijn: String(deadlines.defaultIncomingWorkingDays),
    };
    return template.body.replace(/\{\{(\w+)\}\}/g, (match: string, key: string) => (key in values ? values[key] : match));
  }

  // ------------------------------------------------------------- the letter as a PDF

  /**
   * Builds the letter from its newest text version and captures it on the
   * record. A draft gets a CONCEPT watermark. A registered letter is final:
   * when `seal` is asked for, by a decision-maker, the PDF carries a QR code to
   * its own seal, and the seal is applied to exactly those bytes.
   */
  async compose(actor: Actor, itemId: string, options: { seal?: boolean } = {}) {
    const [item] = await this.dataSource.query(
      `SELECT ci.*, o.registration_identity AS reply_to_identity, o.sender_reference AS reply_to_sender_reference,
              o.document_date::text AS reply_to_date, o.subject AS reply_to_subject
         FROM correspondence_item ci LEFT JOIN correspondence_item o ON o.id = ci.in_reply_to_item_id
        WHERE ci.id = $1`,
      [itemId],
    );
    if (!item) throw new NotFoundException('Unknown item.');
    if (item.direction !== 'OUTGOING') throw new BadRequestException('Only an outgoing letter can be composed.');
    const [latest] = await this.dataSource.query(
      `SELECT version_no, body FROM item_draft_version WHERE item_id = $1 ORDER BY version_no DESC LIMIT 1`,
      [itemId],
    );
    if (!latest) throw new BadRequestException('Write the text of the letter first.');
    const final = item.state === 'REGISTERED';
    if (options.seal) {
      if (!final) throw new BadRequestException('Only a registered letter can be sealed. Register it first.');
      const profile = await this.access.profile(actor.accountId);
      if (!profile.roles.some((r) => DECISION_ROLES.includes(r))) throw new ForbiddenException('Only a decision-maker may seal a letter.');
    }
    const sealId = options.seal ? randomUUID() : null;
    const branding = await this.settings.get('branding');
    const doc = newPdf({ title: item.subject });
    letterhead(doc, branding);
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.font('Body').fontSize(10.5).fillColor('#111827');
    doc.text(`Paramaribo, ${longDate(todayInSuriname())}`, left, doc.y, { width, align: 'right' });
    doc.moveDown(1.2);
    if (item.party) doc.font('Bold').text(item.party).font('Body');
    doc.moveDown(1.2);
    const meta: [string, string][] = [
      ['Ons kenmerk', item.registration_identity ?? 'CONCEPT — volgt na registratie'],
      ...(item.reply_to_sender_reference ? ([['Uw kenmerk', item.reply_to_sender_reference]] as [string, string][]) : []),
      ...(item.reply_to_identity ? ([['Uw brief', `${item.reply_to_identity}${item.reply_to_date ? ` van ${longDate(item.reply_to_date)}` : ''}`]] as [string, string][]) : []),
      ['Betreft', item.subject.replace(/^Antwoord: /, '')],
    ];
    for (const [label, value] of meta) {
      const y = doc.y;
      doc.font('Bold').fontSize(9.5).fillColor('#4b5563').text(label, left, y, { width: 90 });
      doc.font('Body').fontSize(10.5).fillColor('#111827').text(value, left + 95, y, { width: width - 95 });
      doc.moveDown(0.3);
    }
    doc.moveDown(1.2);
    doc.font('Body').fontSize(11).fillColor('#111827');
    for (const paragraph of String(latest.body).split(/\n{2,}/)) {
      doc.text(paragraph.trim(), left, doc.y, { width, align: 'left', lineGap: 2 });
      doc.moveDown(0.8);
    }
    doc.moveDown(0.8);
    doc.text('Hoogachtend,');
    doc.moveDown(2.4);
    doc.font('Bold').text(branding.signatoryTitle);
    if (sealId) {
      const base = process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173';
      const qr = await qrPng(`${base}/verifieren/${sealId}`, 220);
      const y = doc.page.height - doc.page.margins.bottom - 96;
      doc.image(qr, left, y, { width: 72 });
      doc.font('Body').fontSize(8).fillColor('#4b5563').text(
        `Elektronisch gewaarmerkt door ${branding.organisationName}. Controleer de echtheid: scan de code of ga naar`,
        left + 82,
        y + 14,
        { width: width - 82 },
      );
      doc.font('Bold').fontSize(7.5).fillColor('#111827').text(`${base}/verifieren/${sealId}`, left + 82, doc.y + 2, { width: width - 82, lineBreak: false });
    }
    if (!final) {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('Bold').fontSize(96).fillColor('#dc2626').opacity(0.12).text('CONCEPT', 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' });
      doc.restore();
      doc.opacity(1);
    }
    footer(doc, `${branding.organisationName} · ${item.registration_identity ?? 'concept'} · versie ${latest.version_no}`);
    const bytes = await pdfBuffer(doc);
    const filename = `${final ? 'Brief' : 'Concept'}-${(item.registration_identity ?? 'concept').replace(/[^\w-]/g, '_')}-v${latest.version_no}.pdf`;
    const captured = await this.documents.capture(actor, itemId, {
      originalname: filename,
      mimetype: 'application/pdf',
      size: bytes.length,
      buffer: bytes,
    });
    await this.audit.recordStrict({
      eventType: AuditEventType.LETTER_COMPOSED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      subjectDescription: `${item.registration_identity ?? 'draft'} — ${item.subject}`.slice(0, 260),
      newValue: `${filename} (sha256 ${captured.contentHash.slice(0, 12)}…)`,
      summary: `${actor.description} composed the ${final ? 'letter' : 'draft letter'} ${filename} from text version ${latest.version_no}.`.slice(0, 600),
    });
    let seal = null;
    if (sealId) seal = await this.sealDocument(actor, itemId, captured.id, sealId);
    return { document: captured, seal, versionNo: latest.version_no };
  }

  async sealDocument(actor: Actor, itemId: string, documentId: string, presetId?: string) {
    const [doc] = await this.dataSource.query(
      `SELECT cd.id, cd.content_hash, cd.original_filename, ci.registration_identity, ci.subject, ci.party, ci.state
         FROM captured_document cd JOIN correspondence_item ci ON ci.id = cd.correspondence_item_id
        WHERE cd.id = $1 AND ci.id = $2`,
      [documentId, itemId],
    );
    if (!doc) throw new NotFoundException('Unknown captured document.');
    if (doc.state !== 'REGISTERED') throw new BadRequestException('Only a document on a registered record can be sealed.');
    const profile = await this.access.profile(actor.accountId);
    if (!profile.roles.some((r) => DECISION_ROLES.includes(r))) throw new ForbiddenException('Only a decision-maker may apply the seal.');
    const [approval] = await this.dataSource.query(
      `SELECT p.full_name, we.occurred_at FROM dossier_link dl
         JOIN workflow_event we ON we.dossier_id = dl.dossier_id AND we.event_type = 'APPROVED'
         JOIN account a ON a.id = we.actor_account_id JOIN person p ON p.id = a.person_id
        WHERE dl.correspondence_item_id = $1 ORDER BY we.occurred_at DESC LIMIT 1`,
      [itemId],
    );
    const branding = await this.settings.get('branding');
    const [sealer] = await this.dataSource.query(`SELECT p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = $1`, [actor.accountId]);
    const payload = {
      issuer: branding.organisationName,
      documentSha256: doc.content_hash,
      filename: doc.original_filename,
      registrationIdentity: doc.registration_identity,
      subject: doc.subject,
      addressee: doc.party,
      approvedBy: approval?.full_name ?? null,
      approvedAt: approval ? new Date(approval.occurred_at).toISOString() : null,
      sealedBy: sealer.full_name,
    };
    const seal = await this.seals.seal('DOCUMENT', documentId, payload, actor.accountId, presetId ?? randomUUID());
    await this.audit.recordStrict({
      eventType: AuditEventType.SEAL_APPLIED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      subjectDescription: `${doc.registration_identity} — ${doc.original_filename}`.slice(0, 260),
      newValue: `seal ${seal.id}`,
      summary: `${actor.description} applied the system seal to ${doc.original_filename} (${doc.registration_identity}).`.slice(0, 600),
    });
    return seal;
  }

  /** Public: is this seal genuine, and is the sealed document unchanged? */
  async verifyPublic(sealId: string) {
    const result = await this.seals.verifySeal(sealId);
    const [row] = await this.dataSource.query(`SELECT subject_id, subject_type FROM document_seal WHERE id = $1`, [sealId]);
    let documentIntact: boolean | null = null;
    if (row?.subject_type === 'DOCUMENT') {
      const verification = await this.documents.verify(row.subject_id).catch(() => null);
      documentIntact = verification ? verification.intact && verification.contentHash === result.payload.documentSha256 : false;
    }
    const p = result.payload as Record<string, string | null>;
    return {
      valid: result.valid && documentIntact !== false,
      reason: result.reason ?? (documentIntact === false ? 'The stored document no longer matches the sealed fingerprint.' : null),
      issuer: p.issuer,
      registrationIdentity: p.registrationIdentity,
      documentSha256: p.documentSha256,
      approvedBy: p.approvedBy,
      approvedAt: p.approvedAt,
      sealedBy: result.sealedByName,
      sealedAt: result.sealedAt,
      keyId: result.keyId,
      // The subject and addressee are not disclosed to an anonymous visitor.
    };
  }

  // ------------------------------------------------------------- labels, receipts, tracking

  async label(actor: Actor, itemId: string): Promise<Buffer> {
    const [item] = await this.dataSource.query(
      `SELECT ci.*, t.tracking_code FROM correspondence_item ci LEFT JOIN item_tracking t ON t.item_id = ci.id WHERE ci.id = $1`,
      [itemId],
    );
    if (!item) throw new NotFoundException('Unknown item.');
    if (item.state !== 'REGISTERED') throw new BadRequestException('Only a registered record has a label.');
    const branding = await this.settings.get('branding');
    const base = process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173';
    const doc = newPdf({ size: [283, 142], margin: 10, title: `Label ${item.registration_identity}` });
    doc.rect(4, 4, 275, 134).lineWidth(1.5).strokeColor(branding.primaryColor).stroke();
    doc.font('Bold').fontSize(7).fillColor(branding.primaryColor).text(branding.organisationName.toUpperCase(), 12, 11, { width: 170 });
    doc.font('Bold').fontSize(17).fillColor('#111827').text(item.registration_identity, 12, 26, { width: 180 });
    const registered = new Date(item.registered_at);
    const local = new Date(registered.getTime() - 3 * 3600_000);
    const direction = item.direction === 'INCOMING' ? 'INKOMEND' : item.direction === 'OUTGOING' ? 'UITGAAND' : 'INTERN';
    doc.font('Body').fontSize(8).fillColor('#374151');
    doc.text(`${direction} · geregistreerd ${longDate(local.toISOString().slice(0, 10))} ${local.toISOString().slice(11, 16)}`, 12, 50, { width: 180 });
    if (item.party) doc.text(`Van: ${String(item.party).slice(0, 60)}`, 12, 62, { width: 180 });
    doc.text(String(item.subject).slice(0, 110), 12, 74, { width: 180, height: 32, ellipsis: true });
    if (item.tracking_code) {
      doc.font('Bold').fontSize(8).fillColor(branding.primaryColor).text(`Volgcode: ${item.tracking_code}`, 12, 118, { width: 180 });
    }
    doc.image(await qrPng(`${base}/post/${item.id}`, 300), 196, 22, { width: 78 });
    doc.font('Body').fontSize(6).fillColor('#6b7280').text('Scan om het digitale stuk te openen', 192, 104, { width: 86, align: 'center' });
    const bytes = await pdfBuffer(doc);
    await this.audit.recordStrict({
      eventType: AuditEventType.LABEL_PRINTED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      subjectDescription: `${item.registration_identity} — ${item.subject}`.slice(0, 260),
      summary: `${actor.description} printed the label for ${item.registration_identity}.`,
    });
    return bytes;
  }

  /** The receipt a citizen gets: registration number, date, and how to follow it. */
  async receipt(actor: Actor, itemId: string): Promise<Buffer> {
    const [item] = await this.dataSource.query(
      `SELECT ci.*, t.tracking_code FROM correspondence_item ci LEFT JOIN item_tracking t ON t.item_id = ci.id WHERE ci.id = $1`,
      [itemId],
    );
    if (!item) throw new NotFoundException('Unknown item.');
    if (item.state !== 'REGISTERED' || item.direction !== 'INCOMING') throw new BadRequestException('A receipt exists only for a registered incoming letter.');
    const branding = await this.settings.get('branding');
    const deadlines = await this.settings.get('deadlines');
    const base = process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173';
    const registeredOn = new Date(new Date(item.registered_at).getTime() - 3 * 3600_000).toISOString().slice(0, 10);
    const expected = await this.workingDays.addWorkingDays(registeredOn, deadlines.defaultIncomingWorkingDays);
    const doc = newPdf({ title: `Ontvangstbevestiging ${item.registration_identity}` });
    letterhead(doc, branding);
    const left = doc.page.margins.left;
    doc.font('Bold').fontSize(18).fillColor(branding.primaryColor).text('Ontvangstbevestiging', left);
    doc.moveDown(0.8);
    doc.font('Body').fontSize(11).fillColor('#111827');
    doc.text(`Wij hebben uw stuk op ${longDate(registeredOn)} ontvangen en geregistreerd.`);
    doc.moveDown(0.8);
    const rows: [string, string][] = [
      ['Registratienummer', item.registration_identity],
      ['Afzender', item.party ?? '—'],
      ['Ontvangen op', longDate(registeredOn)],
      ['Verwachte reactie vóór', longDate(expected)],
      ['Volgcode', item.tracking_code ?? '—'],
    ];
    for (const [k, v] of rows) {
      const y = doc.y;
      doc.font('Bold').fontSize(10).fillColor('#4b5563').text(k, left, y, { width: 160 });
      doc.font('Body').fontSize(11).fillColor('#111827').text(v, left + 170, y);
      doc.moveDown(0.4);
    }
    doc.moveDown(1);
    if (item.tracking_code) {
      const url = `${base}/volgen?nummer=${encodeURIComponent(item.registration_identity)}&code=${item.tracking_code}`;
      doc.image(await qrPng(url, 300), left, doc.y, { width: 110 });
      doc.font('Body').fontSize(10).text(
        `Volg de behandeling online: scan de code of ga naar ${base}/volgen en vul uw registratienummer en volgcode in. De volgcode is persoonlijk; deel hem niet.`,
        left + 125,
        doc.y + 18,
        { width: doc.page.width - left - doc.page.margins.right - 125 },
      );
    }
    footer(doc, `${branding.organisationName} · ${item.registration_identity}`);
    const bytes = await pdfBuffer(doc);
    await this.audit.recordStrict({
      eventType: AuditEventType.LABEL_PRINTED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      subjectDescription: `${item.registration_identity} — receipt`,
      summary: `${actor.description} printed the receipt for ${item.registration_identity}.`,
    });
    return bytes;
  }

  async tracking(itemId: string): Promise<{ code: string } | null> {
    const [row] = await this.dataSource.query(`SELECT tracking_code FROM item_tracking WHERE item_id = $1`, [itemId]);
    return row ? { code: row.tracking_code } : null;
  }

  /**
   * The public status lookup. It needs both the registration number and the
   * personal code, says only where the letter stands — never what it is about
   * — and stops answering an address after repeated wrong guesses.
   */
  async publicTrack(reference: string, code: string, ip: string | null) {
    const enabled = (await this.settings.get('publicTracking')).enabled;
    if (!enabled) throw new NotFoundException('Online tracking is not available.');
    const [{ fails }] = await this.dataSource.query(
      `SELECT count(*)::int AS fails FROM tracking_lookup WHERE ip_address IS NOT DISTINCT FROM $1 AND succeeded = false AND occurred_at > now() - interval '15 minutes'`,
      [ip],
    );
    if (fails >= 10) throw new HttpException('Too many attempts. Try again in fifteen minutes.', 429);
    const normalisedCode = (code ?? '').trim().toUpperCase();
    const [row] = await this.dataSource.query(
      `SELECT ci.id, ci.registration_identity, ci.registered_at, t.tracking_code
         FROM correspondence_item ci JOIN item_tracking t ON t.item_id = ci.id
        WHERE upper(ci.registration_identity) = upper($1)`,
      [(reference ?? '').trim()],
    );
    const ok = !!row && row.tracking_code === normalisedCode;
    await this.dataSource.query(`INSERT INTO tracking_lookup (reference_tried, succeeded, ip_address) VALUES ($1, $2, $3)`, [
      (reference ?? '').slice(0, 80),
      ok,
      ip,
    ]);
    if (!ok) throw new NotFoundException('No letter matches this number and code.');
    const [state] = await this.dataSource.query(
      `SELECT
         (SELECT max(d.processing_state) FROM dossier_link dl JOIN dossier d ON d.id = dl.dossier_id WHERE dl.correspondence_item_id = $1) AS processing,
         (SELECT bool_or(d.processing_state = 'FINALISED') FROM dossier_link dl JOIN dossier d ON d.id = dl.dossier_id WHERE dl.correspondence_item_id = $1) AS finalised,
         (SELECT max(r.registered_at) FROM correspondence_item r WHERE r.in_reply_to_item_id = $1 AND r.state = 'REGISTERED') AS replied_at,
         (SELECT max(e.occurred_at) FROM dossier_link dl JOIN workflow_event e ON e.dossier_id = dl.dossier_id WHERE dl.correspondence_item_id = $1) AS last_event`,
      [row.id],
    );
    const status = state.finalised || state.replied_at ? 'COMPLETED' : state.processing ? 'IN_PROGRESS' : 'RECEIVED';
    const deadlines = await this.settings.get('deadlines');
    const registeredOn = new Date(new Date(row.registered_at).getTime() - 3 * 3600_000).toISOString().slice(0, 10);
    return {
      reference: row.registration_identity,
      status,
      receivedOn: registeredOn,
      expectedBy: status === 'COMPLETED' ? null : await this.workingDays.addWorkingDays(registeredOn, deadlines.defaultIncomingWorkingDays),
      lastUpdate: new Date(state.replied_at ?? state.last_event ?? row.registered_at).toISOString(),
    };
  }
}
