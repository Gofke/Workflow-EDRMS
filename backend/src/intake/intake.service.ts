import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { simpleParser } from 'mailparser';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { loadDocumentConfig } from '../config/document-config';
import { NotificationService } from '../core/notification.service';
import { footer, letterhead, newPdf, pdfBuffer } from '../core/pdf';
import { DocumentsService } from '../documents/documents.service';
import { Actor, RegistrationService } from '../records/registration.service';
import { SettingsService } from '../settings/settings.service';

export interface IntakeResult {
  item: { id: string; subject: string; party: string | null; state: string };
  captured: { id: string; filename: string; contentHash: string }[];
  skipped: { filename: string; reason: string }[];
}

/**
 * E-mail as incoming post. An e-mail — uploaded by a registrar, or delivered
 * by the ministry's mail server through the gateway — becomes a draft
 * incoming item: its subject, sender and date filled in, the message itself
 * kept as a PDF, its attachments captured with their fingerprints. A person
 * still registers it: intake prepares, it does not register.
 *
 * The same e-mail taken in twice is refused the second time, by its
 * Message-ID, so a forward loop cannot create duplicates.
 */
@Injectable()
export class IntakeService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly registration: RegistrationService,
    private readonly documents: DocumentsService,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
  ) {}

  async fromEmail(actor: Actor, raw: Buffer, channel: 'UPLOAD' | 'GATEWAY'): Promise<IntakeResult> {
    const parsed = await simpleParser(raw);
    const rawHash = createHash('sha256').update(raw).digest('hex');
    const messageId = (parsed.messageId ?? `sha256:${rawHash}`).slice(0, 400);
    const [existing] = await this.dataSource.query(
      `SELECT ei.item_id, ci.registration_identity, ci.subject FROM email_intake ei
         JOIN correspondence_item ci ON ci.id = ei.item_id WHERE ei.message_id = $1`,
      [messageId],
    );
    if (existing) {
      throw new ConflictException(`This e-mail was already taken in as ${existing.registration_identity ?? 'a draft'}: ${existing.subject}.`);
    }
    const from = parsed.from?.value?.[0];
    const party = from ? (from.name ? `${from.name} <${from.address}>` : from.address ?? null) : null;
    const subject = (parsed.subject?.trim() || '(e-mail zonder onderwerp)').slice(0, 400);
    const date = parsed.date ? new Date(parsed.date.getTime() - 3 * 3600_000).toISOString().slice(0, 10) : undefined;
    const draft = await this.registration.createDraft(
      actor,
      { direction: 'INCOMING' as never, subject, party: party?.slice(0, 300) ?? undefined, documentDate: date },
      'EMAIL',
    );
    const captured: IntakeResult['captured'] = [];
    const skipped: IntakeResult['skipped'] = [];

    // The message itself, as a readable and fingerprinted PDF.
    const branding = await this.settings.get('branding');
    const doc = newPdf({ title: subject });
    letterhead(doc, branding);
    doc.font('Bold').fontSize(14).text('Ontvangen e-mail');
    doc.moveDown(0.6);
    const header: [string, string][] = [
      ['Van', party ?? '—'],
      ['Aan', parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(', ') : parsed.to.text) : '—'],
      ['Datum', parsed.date ? parsed.date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—'],
      ['Onderwerp', subject],
      ['Message-ID', messageId],
      ['Bijlagen', parsed.attachments.length ? parsed.attachments.map((a) => a.filename ?? 'naamloos').join(', ') : 'geen'],
    ];
    for (const [k, v] of header) {
      const y = doc.y;
      doc.font('Bold').fontSize(9).fillColor('#4b5563').text(k, doc.page.margins.left, y, { width: 80 });
      doc.font('Body').fontSize(10).fillColor('#111827').text(v, doc.page.margins.left + 85, y);
      doc.moveDown(0.2);
    }
    doc.moveDown(0.8);
    doc.font('Body').fontSize(10.5).fillColor('#111827').text((parsed.text ?? '').trim().slice(0, 60_000) || '(geen tekst)');
    footer(doc, `E-mail ontvangen via ${channel === 'GATEWAY' ? 'de mailserver' : 'upload'}, sha256 ${rawHash.slice(0, 16)}…`);
    const messagePdf = await pdfBuffer(doc);
    const mainDoc = await this.documents.capture(actor, draft.id, {
      originalname: 'E-mailbericht.pdf',
      mimetype: 'application/pdf',
      size: messagePdf.length,
      buffer: messagePdf,
    });
    captured.push({ id: mainDoc.id, filename: mainDoc.originalFilename, contentHash: mainDoc.contentHash });

    const config = loadDocumentConfig();
    for (const attachment of parsed.attachments) {
      const filename = attachment.filename ?? 'bijlage';
      if (!config.allowedMediaTypes.includes(attachment.contentType)) {
        skipped.push({ filename, reason: `type ${attachment.contentType} is not accepted` });
        continue;
      }
      try {
        const d = await this.documents.capture(actor, draft.id, {
          originalname: filename,
          mimetype: attachment.contentType,
          size: attachment.size,
          buffer: attachment.content,
        });
        captured.push({ id: d.id, filename: d.originalFilename, contentHash: d.contentHash });
      } catch (error) {
        skipped.push({ filename, reason: (error as Error).message });
      }
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO email_intake (message_id, from_address, subject, item_id, raw_hash, channel) VALUES ($1, $2, $3, $4, $5, $6)`,
        [messageId, from?.address?.slice(0, 400) ?? null, subject.slice(0, 600), draft.id, rawHash, channel],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.EMAIL_INTAKE_RECEIVED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `draft: ${subject}`.slice(0, 260),
        newValue: `${captured.length} document(s), ${skipped.length} skipped`,
        summary: `An e-mail from ${party ?? 'an unknown sender'} was taken in as a draft incoming item (${captured.length} document(s) captured${skipped.length ? `, ${skipped.length} skipped` : ''}).`.slice(0, 600),
      });
    });
    if (channel === 'GATEWAY') {
      await this.notifications.notify({
        recipients: [actor.accountId],
        kind: 'INTAKE_RECEIVED',
        params: { subject, channel: 'e-mail' },
        link: `/post/${draft.id}`,
        subjectType: 'ITEM',
        subjectId: draft.id,
      });
    }
    return { item: { id: draft.id, subject: draft.subject, party: draft.party, state: draft.state }, captured, skipped };
  }
}
