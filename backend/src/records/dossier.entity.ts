import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  VersionColumn,
} from 'typeorm';
import { Account } from '../identity/account.entity';
import { OrganisationalUnit } from '../identity/organisational-unit.entity';
import { CorrespondenceItem } from './correspondence-item.entity';
import { ProcessingState } from '../workflow/workflow.entity';
import { BadRequestException } from '@nestjs/common';

/** FR-DOS-006. REOPENED is its own state so a reopened file reads as one. */
export enum DossierState {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  REOPENED = 'REOPENED',
}

/**
 * FR-DOS-007: a closed matter stays readable, but ordinary change stops. The
 * database refuses the same changes; this gives the user a sentence instead of
 * a trigger error.
 */
export function assertDossierNotClosed(dossier: { state: string }): void {
  if (dossier.state === DossierState.CLOSED) {
    throw new BadRequestException('This dossier is closed. Reopen the dossier before changing it.');
  }
}

/**
 * A Dossier (FS-06 §4) — the matter-level workspace grouping related records
 * and their history.
 *
 * Its identity is protected the same way a registration identity is: assigned
 * by the server, unique, and immutable once set. The syntax is configuration,
 * because DEC-11 (dossier identity scheme) is open.
 *
 * The dossier state (FR-DOS-006) is OPEN, CLOSED or REOPENED. It is the state
 * of the matter file, not of the work: see processingState. Retention is a
 * DEC-04 matter and nothing here anticipates it.
 */
@Entity({ name: 'dossier' })
export class Dossier {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('ix_dossier_identity', { unique: true })
  @Column({ name: 'dossier_identity', type: 'varchar', length: 80 })
  dossierIdentity: string;

  @Column({ name: 'subject', type: 'varchar', length: 400 })
  subject: string;

  @Column({ name: 'state', type: 'varchar', length: 20, default: 'OPEN' })
  state: DossierState;

  /**
   * The FS-05 §3.2 processing state. Separate from the dossier state above:
   * one says whether the matter file is open, the other says where the work has
   * got to. Only the transitions FS-05 §3.4 permits are accepted, enforced by a
   * trigger rather than by this class.
   */
  @Column({ name: 'processing_state', type: 'varchar', length: 30, default: 'ACTIVE' })
  processingState: ProcessingState;

  /** The official due date, where the matter requires one (FR-OWN-004). */
  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @VersionColumn({ name: 'version' })
  version: number;

  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'created_by_account_id' })
  createdBy: Account;

  @ManyToOne(() => OrganisationalUnit, { nullable: true })
  @JoinColumn({ name: 'owning_unit_id' })
  owningUnit: OrganisationalUnit | null;
}

/**
 * The link between a record and a dossier (BR-004).
 *
 * A link, not a copy: the authoritative item stays where it is and is never
 * duplicated to support navigation. One record may be linked to more than one
 * dossier, and the pair is unique so the same link cannot be made twice.
 *
 * Unlinking is deliberately absent. DEC-10 (whether unlink/relink is enabled)
 * is open, and building it would decide the question by default.
 */
@Entity({ name: 'dossier_link' })
@Unique('uq_dossier_link', ['dossier', 'item'])
export class DossierLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Dossier, { nullable: false })
  @JoinColumn({ name: 'dossier_id' })
  dossier: Dossier;

  @ManyToOne(() => CorrespondenceItem, { nullable: false })
  @JoinColumn({ name: 'correspondence_item_id' })
  item: CorrespondenceItem;

  @Column({ name: 'linked_at', type: 'timestamptz', default: () => 'now()' })
  linkedAt: Date;

  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'linked_by_account_id' })
  linkedBy: Account;
}

/**
 * A dossier state event (EV-DOS-CLOSE): who closed or reopened a matter file,
 * when, from which state to which, and why.
 *
 * Append-only in the database. Reopening never erases the closure it follows
 * (FR-DOS-008); both events stay in the history, in order.
 */
@Entity({ name: 'dossier_state_event' })
export class DossierStateEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Dossier, { nullable: false })
  @JoinColumn({ name: 'dossier_id' })
  dossier: Dossier;

  @Column({ name: 'from_state', type: 'varchar', length: 20 })
  fromState: DossierState;

  @Column({ name: 'to_state', type: 'varchar', length: 20 })
  toState: DossierState;

  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'actor_account_id' })
  actor: Account;

  /** Required on a reopening. Optional on a closure. */
  @Column({ name: 'reason', type: 'varchar', length: 1000, nullable: true })
  reason: string | null;

  @Column({ name: 'occurred_at', type: 'timestamptz', default: () => 'now()' })
  occurredAt: Date;
}
