import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { footer, letterhead, newPdf, pdfBuffer, surinameDateTime } from '../core/pdf';
import { canonicalJson } from '../core/seal.service';
import { DocumentsService } from '../documents/documents.service';
import { RegistrationService } from '../records/registration.service';
import { SettingsService } from '../settings/settings.service';
import { IntegrationClient } from './integration-keys.service';

export interface WijSamenReport {
  reference: string;
  category?: string;
  subject: string;
  description: string;
  reporter?: { name?: string; email?: string; phone?: string };
  location?: string;
  occurredOn?: string;
  attachments?: { filename: string; contentType: string; base64: string }[];
}

const STAGES: Record<string, string> = {
  DRAFT: 'RECEIVED',
  REGISTERED: 'REGISTERED',
};

/**
 * Reports from the WijSamen citizen app. Each report arrives as a draft
 * incoming item with the report itself as a PDF and its photos attached, for a
 * clerk to check and register — the app delivers, it does not register.
 *
 * The same report sent twice is recognised by the app's own reference and not
 * taken in again. The app can ask for the status of its reports, never for
 * their content or anything else in the system.
 */
@Injectable()
export class WijSamenService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly registration: RegistrationService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  async receive(client: IntegrationClient, report: WijSamenReport) {
    const payloadHash = createHash('sha256').update(canonicalJson(report)).digest('hex');
    const [existing] = await this.dataSource.query(
      `SELECT r.item_id, r.payload_hash, ci.registration_identity FROM integration_receipt r JOIN correspondence_item ci ON ci.id = r.item_id
        WHERE r.client_id = $1 AND r.external_reference = $2`,
      [client.id, report.reference],
    );
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new ConflictException('A different report was already received under this reference.');
      }
      return { itemId: existing.item_id, status: 'ALREADY_RECEIVED', registrationIdentity: existing.registration_identity };
    }
    for (const a of report.attachments ?? []) {
      if (!/^[A-Za-z0-9+/=\s]+$/.test(a.base64)) throw new BadRequestException(`Attachment ${a.filename} is not valid base64.`);
    }
    const actor = { accountId: client.actAsAccountId, description: client.actAsDescription };
    const reporter = [report.reporter?.name, report.reporter?.email, report.reporter?.phone].filter(Boolean).join(', ');
    const draft = await this.registration.createDraft(
      actor,
      {
        direction: 'INCOMING' as never,
        subject: `WijSamen: ${report.subject}`.slice(0, 400),
        party: (report.reporter?.name ? `${report.reporter.name} (via WijSamen)` : 'Melder via WijSamen').slice(0, 300),
        documentDate: report.occurredOn && /^\d{4}-\d{2}-\d{2}$/.test(report.occurredOn) ? report.occurredOn : undefined,
        senderReference: report.reference.slice(0, 120),
      },
      'WIJSAMEN',
    );

    const branding = await this.settings.get('branding');
    const doc = newPdf({ title: report.subject });
    letterhead(doc, branding);
    doc.font('Bold').fontSize(14).text('Melding via WijSamen');
    doc.moveDown(0.6);
    const rows: [string, string][] = [
      ['Kenmerk app', report.reference],
      ['Categorie', report.category ?? '—'],
      ['Onderwerp', report.subject],
      ['Melder', reporter || 'anoniem'],
      ['Locatie', report.location ?? '—'],
      ['Datum voorval', report.occurredOn ?? '—'],
      ['Ontvangen', `${surinameDateTime(new Date())} via ${client.name}`],
    ];
    for (const [k, v] of rows) {
      const y = doc.y;
      doc.font('Bold').fontSize(9).fillColor('#4b5563').text(k, doc.page.margins.left, y, { width: 100 });
      doc.font('Body').fontSize(10).fillColor('#111827').text(v, doc.page.margins.left + 105, y);
      doc.moveDown(0.2);
    }
    doc.moveDown(0.8).font('Body').fontSize(10.5).text(report.description.slice(0, 20_000));
    footer(doc, `WijSamen-melding ${report.reference}, sha256 ${payloadHash.slice(0, 16)}…`);
    const pdf = await pdfBuffer(doc);
    await this.documents.capture(actor, draft.id, { originalname: 'Melding WijSamen.pdf', mimetype: 'application/pdf', size: pdf.length, buffer: pdf });
    const skipped: { filename: string; reason: string }[] = [];
    for (const a of report.attachments ?? []) {
      const buffer = Buffer.from(a.base64, 'base64');
      try {
        await this.documents.capture(actor, draft.id, { originalname: a.filename.slice(0, 200), mimetype: a.contentType, size: buffer.length, buffer });
      } catch (error) {
        skipped.push({ filename: a.filename, reason: (error as Error).message });
      }
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO integration_receipt (client_id, external_reference, item_id, payload_hash) VALUES ($1, $2, $3, $4)`,
        [client.id, report.reference, draft.id, payloadHash],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.WIJSAMEN_REPORT_RECEIVED,
        actorAccountId: client.actAsAccountId,
        actorDescription: client.actAsDescription,
        subjectDescription: `draft: WijSamen ${report.reference}`.slice(0, 260),
        newValue: `${(report.attachments ?? []).length - skipped.length} attachment(s)${skipped.length ? `, ${skipped.length} refused` : ''}`,
        summary: `A WijSamen report (${report.reference}) was received as a draft incoming item${skipped.length ? `; ${skipped.length} attachment(s) refused` : ''}.`.slice(0, 600),
      });
    });
    return { itemId: draft.id, status: 'RECEIVED', skipped };
  }

  /** Status only: received, registered, in a matter, finished. Never content. */
  async status(client: IntegrationClient, reference: string) {
    const [row] = await this.dataSource.query(
      `SELECT ci.state, ci.registration_identity, r.received_at,
              (SELECT d.processing_state FROM dossier_link dl JOIN dossier d ON d.id = dl.dossier_id WHERE dl.correspondence_item_id = ci.id ORDER BY dl.linked_at DESC LIMIT 1) AS processing
         FROM integration_receipt r JOIN correspondence_item ci ON ci.id = r.item_id
        WHERE r.client_id = $1 AND r.external_reference = $2`,
      [client.id, reference],
    );
    if (!row) throw new NotFoundException('Unknown reference.');
    const stage = row.processing === 'FINALISED' ? 'COMPLETED' : row.processing ? 'IN_PROGRESS' : STAGES[row.state] ?? 'RECEIVED';
    return { reference, stage, registrationIdentity: row.registration_identity, receivedAt: row.received_at };
  }
}
