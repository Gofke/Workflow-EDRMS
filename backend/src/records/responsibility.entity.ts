import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Account } from '../identity/account.entity';
import { Dossier } from './dossier.entity';

/**
 * Responsibility for a matter (FS-06 §4: Responsibility Assignment).
 *
 * FR-OWN-001 demands ONE unambiguous current responsibility. That is enforced
 * by a partial unique index on the dossier where supersededAt is null, so two
 * live owners cannot exist even under a race.
 *
 * FR-OWN-003 demands that reassignment preserves the previous responsibility.
 * A superseded row is therefore marked, never deleted or overwritten, and the
 * history below is append-only in the database.
 */
@Entity({ name: 'responsibility_assignment' })
export class ResponsibilityAssignment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Dossier, { nullable: false })
  @JoinColumn({ name: 'dossier_id' })
  dossier: Dossier;

  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'responsible_account_id' })
  responsible: Account;

  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'assigned_by_account_id' })
  assignedBy: Account;

  /** Whose authority the assigner was representing, if any (FR-DEL-003). */
  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: 'on_behalf_of_account_id' })
  onBehalfOf: Account | null;

  @Column({ name: 'assigned_at', type: 'timestamptz', default: () => 'now()' })
  assignedAt: Date;

  /** Null on the current assignment; set when responsibility moves on. */
  @Column({ name: 'superseded_at', type: 'timestamptz', nullable: true })
  supersededAt: Date | null;
}

/**
 * A due-date change (FR-OWN-006): old value, new value, actor, server time, and
 * a reason where the configuration requires one.
 *
 * Removing a due date is a change to null — an event, not an erasure.
 */
@Entity({ name: 'due_date_change' })
export class DueDateChange {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Dossier, { nullable: false })
  @JoinColumn({ name: 'dossier_id' })
  dossier: Dossier;

  @Column({ name: 'previous_due_date', type: 'date', nullable: true })
  previousDueDate: string | null;

  @Column({ name: 'new_due_date', type: 'date', nullable: true })
  newDueDate: string | null;

  @Column({ name: 'reason', type: 'varchar', length: 600, nullable: true })
  reason: string | null;

  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'changed_by_account_id' })
  changedBy: Account;

  /** Whose authority the change was made under, if any (FR-DEL-003). */
  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: 'on_behalf_of_account_id' })
  onBehalfOf: Account | null;

  @Column({ name: 'changed_at', type: 'timestamptz', default: () => 'now()' })
  changedAt: Date;
}
