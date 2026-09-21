import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, VersionColumn } from 'typeorm';
import { Account } from '../identity/account.entity';
import { OrganisationalUnit } from '../identity/organisational-unit.entity';

/** FR-COR-001: the three distinct correspondence directions. */
export enum CorrespondenceDirection {
  INCOMING = 'INCOMING',
  OUTGOING = 'OUTGOING',
  INTERNAL = 'INTERNAL',
}

/**
 * FS-06 §3: draft is not official evidence.
 *
 * DRAFT is preparatory material. REGISTERED is an official record of the
 * Ministry. The two are the same row in different states, and the interface must
 * never present one as the other.
 */
export enum ItemState {
  DRAFT = 'DRAFT',
  REGISTERED = 'REGISTERED',
}

/**
 * A Correspondence Item (FS-06 §4) — incoming, outgoing or internal.
 *
 * Three invariants are enforced by the database, not by this class:
 *
 * BR-001 — registrationIdentity is unique and is not derived from any filename.
 * BR-002 — registeredAt is server time, set by the database, and is distinct
 *          from documentDate, which is what the paper itself says.
 * FR-COR-004 — once set, registrationIdentity and registeredAt cannot be
 *          changed by an ordinary update. A trigger rejects the attempt.
 *
 * The numbering syntax itself is NOT decided here. DEC-01 is open, so the
 * pattern comes from configuration. See config/registration-config.ts.
 */
@Entity({ name: 'correspondence_item' })
export class CorrespondenceItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Null while DRAFT. Assigned once, at registration, and never again. */
  @Index('ix_correspondence_item_identity', { unique: true })
  @Column({ name: 'registration_identity', type: 'varchar', length: 80, nullable: true })
  registrationIdentity: string | null;

  @Column({ name: 'state', type: 'varchar', length: 20, default: ItemState.DRAFT })
  state: ItemState;

  @Column({ name: 'direction', type: 'varchar', length: 20 })
  direction: CorrespondenceDirection;

  @Column({ name: 'subject', type: 'varchar', length: 400 })
  subject: string;

  /** The counterparty: sender for incoming, addressee for outgoing. */
  @Column({ name: 'party', type: 'varchar', length: 300, nullable: true })
  party: string | null;

  /** What the document itself is dated. Supplied by the user, never trusted as the registration time. */
  @Column({ name: 'document_date', type: 'date', nullable: true })
  documentDate: string | null;

  /** Server-authoritative registration time. Null while DRAFT. */
  @Column({ name: 'registered_at', type: 'timestamptz', nullable: true })
  registeredAt: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  /**
   * DEC-05 resolved: optimistic version check. Every update must present the
   * version it read. A stale version is refused rather than silently winning,
   * which is what protects an approved version from being overwritten
   * (FR-WFL-014).
   */
  @VersionColumn({ name: 'version' })
  version: number;

  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'created_by_account_id' })
  createdBy: Account;

  @ManyToOne(() => OrganisationalUnit, { nullable: true })
  @JoinColumn({ name: 'owning_unit_id' })
  owningUnit: OrganisationalUnit | null;
}
