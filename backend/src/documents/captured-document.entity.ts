import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Account } from '../identity/account.entity';
import { CorrespondenceItem } from '../records/correspondence-item.entity';

/**
 * A captured document or file attached to a correspondence item
 * (FR-COR-006, FR-COR-014; FS-06 §4 Record vs Document/File).
 *
 * The file is NOT the authoritative record — the registered item is. This row
 * associates captured content with that record and carries the integrity
 * reference FS-06 §6 requires.
 *
 * Three properties are enforced rather than intended:
 *
 * 1. Append-only. Rules on the table make UPDATE and DELETE no-ops. A
 *    correction adds a new capture; the earlier one stays retrievable, which is
 *    what FR-GEN-007 demands of any change to evidence.
 * 2. Integrity. contentHash is computed server-side over the received bytes and
 *    re-verified on every retrieval. Altered content is refused, never served.
 * 3. Provenance. Who captured it and when (server time) are recorded here; the
 *    sender and the registration time come from the item itself.
 *
 * No version model is implied. FR-FIN-005's rules are open, so this stores an
 * ordered history of captures and asserts nothing about which is "the version".
 */
@Entity({ name: 'captured_document' })
export class CapturedDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('ix_captured_document_item')
  @ManyToOne(() => CorrespondenceItem, { nullable: false })
  @JoinColumn({ name: 'correspondence_item_id' })
  item: CorrespondenceItem;

  /** The name the file arrived with. Never an identity — BR-001 forbids that. */
  @Column({ name: 'original_filename', type: 'varchar', length: 400 })
  originalFilename: string;

  @Column({ name: 'media_type', type: 'varchar', length: 120 })
  mediaType: string;

  @Column({ name: 'byte_size', type: 'bigint' })
  byteSize: string;

  /** SHA-256 over the stored bytes, in hex. The integrity reference. */
  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash: string;

  /** Where the bytes live. Content-addressed, so it is derived, not meaningful. */
  @Column({ name: 'storage_key', type: 'varchar', length: 200 })
  storageKey: string;

  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'captured_by_account_id' })
  capturedBy: Account;

  @Column({ name: 'captured_at', type: 'timestamptz', default: () => 'now()' })
  capturedAt: Date;
}
