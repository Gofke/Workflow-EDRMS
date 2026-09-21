import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { loadDocumentConfig } from '../config/document-config';
import { CorrespondenceItem } from '../records/correspondence-item.entity';
import { Actor } from '../records/registration.service';
import { loadOcrConfig } from '../config/ocr-config';
import { CapturedDocument } from './captured-document.entity';
import { DocumentText, DocumentTextStatus } from './document-text.entity';
import { DocumentStorage, IntegrityError } from './document-storage';
import { extractPdfText, extractText } from './ocr-engine';

/**
 * Derived text for one document (FR-COR-015).
 *
 * `derived: true` is not decoration. This is assistance for finding a document,
 * never the document: the authoritative content is the captured bytes, and the
 * interface must not let the two be confused.
 */
export interface DocumentTextView {
  documentId: string;
  status: DocumentTextStatus;
  text: string | null;
  engine: string | null;
  languages: string | null;
  extractedAt: string | null;
  /** True when the text was read from content that has since changed. */
  stale: boolean;
  derived: true;
}

export interface CapturedDocumentView {
  id: string;
  originalFilename: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
  capturedByName: string;
  capturedAt: string;
}

@Injectable()
export class DocumentsService {
  private readonly config = loadDocumentConfig();
  private readonly ocr = loadOcrConfig();
  private readonly storage = new DocumentStorage(this.config.storageRoot);

  constructor(
    @InjectRepository(CapturedDocument)
    private readonly documents: Repository<CapturedDocument>,
    @InjectRepository(CorrespondenceItem)
    private readonly items: Repository<CorrespondenceItem>,
    @InjectRepository(DocumentText)
    private readonly texts: Repository<DocumentText>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Captures a document against an item.
   *
   * Permitted on a draft and on a registered record alike: capture is not
   * registration, and a further document arriving on an existing matter is
   * ordinary business. It never replaces what was captured before.
   */
  async capture(
    actor: Actor,
    itemId: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ): Promise<CapturedDocumentView> {
    const item = await this.items.findOne({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Unknown correspondence item.');

    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('No file was received, or the file is empty.');
    }
    if (file.buffer.length > this.config.maxBytes) {
      throw new PayloadTooLargeException(
        `That file is larger than the configured limit of ${Math.floor(this.config.maxBytes / (1024 * 1024))} MB.`,
      );
    }
    if (!this.config.allowedMediaTypes.includes(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `Files of type ${file.mimetype} are not accepted. Accepted types: ${this.config.allowedMediaTypes.join(', ')}.`,
      );
    }

    const { storageKey, contentHash } = await this.storage.put(file.buffer);

    const filename = sanitiseName(file.originalname);

    // The capture row and its audit event are one transaction. The bytes are
    // already on disk by now and are content-addressed, so a rolled-back
    // capture leaves an orphaned file rather than an unaudited record — the
    // safer of the two failures, and the file is unreferenced and harmless.
    const id = await this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(
        `INSERT INTO captured_document (correspondence_item_id, original_filename, media_type,
           byte_size, content_hash, storage_key, captured_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          itemId,
          filename,
          file.mimetype,
          String(file.buffer.length),
          contentHash,
          storageKey,
          actor.accountId,
        ],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.DOCUMENT_CAPTURED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${item.registrationIdentity ?? 'draft'} — ${item.subject}`,
        newValue: `${filename} (sha256 ${contentHash.slice(0, 12)}…)`,
        summary: `${actor.description} captured the document ${filename} against ${item.registrationIdentity ?? 'a draft item'}.`,
      });
      return row.id as string;
    });

    // FR-COR-015. After the capture is committed, never as part of it: the
    // document is captured evidence whether or not a machine could read it, so
    // an OCR failure must not fail or roll back the capture.
    await this.deriveText(id, contentHash, file.mimetype, file.buffer);

    return toView(await this.load(id));
  }

  /**
   * Reads text from a captured document, where reading is enabled.
   *
   * An image goes to OCR; a PDF's text layer is read out of the file. A type
   * with no configured reader is skipped, not failed.
   *
   * Never touches the captured bytes or their integrity reference. Every
   * outcome is recorded, including the ones where nothing was read, so a blank
   * result is visibly "nothing was read" rather than "nobody looked".
   */
  private async deriveText(
    documentId: string,
    contentHash: string,
    mediaType: string,
    bytes: Buffer,
  ): Promise<void> {
    const reader = !this.ocr.enabled
      ? null
      : this.ocr.mediaTypes.includes(mediaType)
        ? extractText
        : this.ocr.pdfMediaTypes.includes(mediaType)
          ? extractPdfText
          : null;
    if (!reader) {
      await this.recordText(documentId, contentHash, DocumentTextStatus.SKIPPED, null, null);
      return;
    }
    try {
      const { text, engine } = await reader(bytes, this.ocr);
      await this.recordText(
        documentId,
        contentHash,
        text.length > 0 ? DocumentTextStatus.EXTRACTED : DocumentTextStatus.EMPTY,
        text.length > 0 ? text : null,
        engine,
      );
    } catch {
      // Deliberately swallowed. The capture has already succeeded and the
      // document is safe; the failure is recorded as the state of the text.
      await this.recordText(
        documentId,
        contentHash,
        DocumentTextStatus.FAILED,
        null,
        this.ocr.mediaTypes.includes(mediaType) ? this.ocr.command : this.ocr.pdfCommand,
      );
    }
  }

  private async recordText(
    documentId: string,
    contentHash: string,
    status: DocumentTextStatus,
    text: string | null,
    engine: string | null,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO document_text (captured_document_id, content_hash, status, extracted_text,
         engine, languages)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (captured_document_id) DO UPDATE
          SET content_hash = EXCLUDED.content_hash, status = EXCLUDED.status,
              extracted_text = EXCLUDED.extracted_text, engine = EXCLUDED.engine,
              languages = EXCLUDED.languages, extracted_at = now()`,
      [documentId, contentHash, status, text, engine, engine ? this.ocr.languages : null],
    );
  }

  /** The derived text, if any. Reading it never touches the document. */
  async textFor(documentId: string): Promise<DocumentTextView> {
    const document = await this.load(documentId);
    const text = await this.texts.findOne({ where: { document: { id: documentId } } });
    if (!text) {
      return {
        documentId,
        status: DocumentTextStatus.SKIPPED,
        text: null,
        engine: null,
        languages: null,
        extractedAt: null,
        stale: false,
        derived: true,
      };
    }
    return {
      documentId,
      status: text.status,
      text: text.extractedText,
      engine: text.engine,
      languages: text.languages,
      extractedAt: text.extractedAt.toISOString(),
      stale: text.contentHash !== document.contentHash,
      derived: true,
    };
  }

  async listFor(itemId: string): Promise<CapturedDocumentView[]> {
    const documents = await this.documents.find({
      where: { item: { id: itemId } },
      relations: { capturedBy: { person: true } },
      order: { capturedAt: 'ASC' },
    });
    return documents.map(toView);
  }

  /**
   * Retrieves the captured bytes, verified against their integrity reference,
   * and records the retrieval. Content is returned in usable form rather than
   * merely referenced (TS02-TC-REG-012 expected result B).
   */
  async retrieve(
    actor: Actor,
    documentId: string,
  ): Promise<{ bytes: Buffer; filename: string; mediaType: string }> {
    const document = await this.load(documentId);

    let bytes: Buffer;
    try {
      bytes = await this.storage.get(document.storageKey, document.contentHash);
    } catch (error) {
      if (error instanceof IntegrityError) {
        // Recorded as an event: a failed integrity check on stored evidence is
        // itself material, whether it was tampering or corruption.
        // Left as log-and-continue on purpose: the retrieval is already being
        // refused, and a failure to record that must not turn into a different
        // error that hides the integrity problem.
        await this.audit.record({
          eventType: AuditEventType.DOCUMENT_INTEGRITY_FAILED,
          actorAccountId: actor.accountId,
          actorDescription: actor.description,
          subjectDescription: `${document.originalFilename} (${document.id})`,
          summary: `Retrieval of ${document.originalFilename} was refused: the stored content no longer matches its recorded integrity reference.`,
        });
        throw new InternalServerErrorException(error.message);
      }
      throw new NotFoundException('The captured content could not be read.');
    }

    // Strict: an access log that failed to write means the retrieval did not
    // happen. Evidence of who read what is part of the record.
    await this.audit.recordStrict({
      eventType: AuditEventType.DOCUMENT_RETRIEVED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      subjectDescription: `${document.originalFilename} (${document.id})`,
      summary: `${actor.description} retrieved the captured document ${document.originalFilename}.`,
    });

    return {
      bytes,
      filename: document.originalFilename,
      mediaType: document.mediaType,
    };
  }

  private async load(id: string): Promise<CapturedDocument> {
    const document = await this.documents.findOne({
      where: { id },
      relations: { capturedBy: { person: true }, item: true },
    });
    if (!document) throw new NotFoundException('Unknown captured document.');
    return document;
  }
}

/** Strips any path from the supplied name. The name is a label, not a location. */
function sanitiseName(name: string): string {
  return (name ?? 'document').replace(/^.*[\\/]/, '').slice(0, 400) || 'document';
}

function toView(document: CapturedDocument): CapturedDocumentView {
  return {
    id: document.id,
    originalFilename: document.originalFilename,
    mediaType: document.mediaType,
    byteSize: Number(document.byteSize),
    contentHash: document.contentHash,
    capturedByName: document.capturedBy?.person?.fullName ?? 'unknown',
    capturedAt: document.capturedAt.toISOString(),
  };
}
