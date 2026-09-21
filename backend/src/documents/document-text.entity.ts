import { Column, Entity, JoinColumn, OneToOne, PrimaryGeneratedColumn } from 'typeorm';
import { CapturedDocument } from './captured-document.entity';

export enum DocumentTextStatus {
  /** Text was read. */
  EXTRACTED = 'EXTRACTED',
  /** The engine ran and found nothing readable. */
  EMPTY = 'EMPTY',
  /** Not attempted: OCR off, or a type the engine is not asked to read. */
  SKIPPED = 'SKIPPED',
  /** The engine failed or timed out. The capture itself was unaffected. */
  FAILED = 'FAILED',
}

/**
 * Text derived from a captured document (FR-COR-015).
 *
 * Retrieval assistance, never the record. It is stored apart from the document,
 * carries the content hash it was read from, and is always presented as derived.
 */
@Entity({ name: 'document_text' })
export class DocumentText {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @OneToOne(() => CapturedDocument, { nullable: false })
  @JoinColumn({ name: 'captured_document_id' })
  document: CapturedDocument;

  /** The hash of the bytes the text was read from (FR-COR-015 staleness check). */
  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash: string;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status: DocumentTextStatus;

  @Column({ name: 'extracted_text', type: 'text', nullable: true })
  extractedText: string | null;

  @Column({ name: 'engine', type: 'varchar', length: 200, nullable: true })
  engine: string | null;

  @Column({ name: 'languages', type: 'varchar', length: 100, nullable: true })
  languages: string | null;

  @Column({ name: 'extracted_at', type: 'timestamptz', default: () => 'now()' })
  extractedAt: Date;
}
