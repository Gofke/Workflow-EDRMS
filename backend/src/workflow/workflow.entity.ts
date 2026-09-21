import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Account } from '../identity/account.entity';
import { Dossier } from '../records/dossier.entity';

/** The processing states this version uses, from FS-05 §3.2. */
export enum ProcessingState {
  ACTIVE = 'ACTIVE',
  UNDER_REVIEW = 'UNDER_REVIEW',
  RETURNED = 'RETURNED',
  APPROVED = 'APPROVED',
  FINALISED = 'FINALISED',
}

export enum WorkflowEventType {
  SUBMITTED = 'SUBMITTED',
  RETURNED = 'RETURNED',
  APPROVED = 'APPROVED',
  FINALISED = 'FINALISED',
  REOPENED = 'REOPENED',
}

/**
 * A workflow decision event (FS-06 §4: Workflow/Decision Event).
 *
 * A decision is evidence, not working data. The table is append-only in the
 * database: a return cannot be reworded after the fact, and correcting the work
 * never touches the record of why it was returned (FR-WFL-008).
 *
 * FR-WFL-014 is the reason reviewedVersion and reviewedSnapshot exist. What was
 * approved must be the thing that was reviewed, not whatever the matter looks
 * like afterwards. The snapshot captures the matter as the reviewer saw it —
 * its linked records and the integrity references of their documents — so an
 * approval can be bound to it rather than to a moving target.
 */
@Entity({ name: 'workflow_event' })
export class WorkflowEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('ix_workflow_event_dossier')
  @ManyToOne(() => Dossier, { nullable: false })
  @JoinColumn({ name: 'dossier_id' })
  dossier: Dossier;

  @Column({ name: 'event_type', type: 'varchar', length: 30 })
  eventType: WorkflowEventType;

  /** The authenticated person who acted. Never the represented principal. */
  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'actor_account_id' })
  actor: Account;

  /** Whose authority was used, where the actor acted for someone else. */
  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: 'on_behalf_of_account_id' })
  onBehalfOf: Account | null;

  /** The designated reviewer, on a submission. */
  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: 'reviewer_account_id' })
  reviewer: Account | null;

  /** Required on a return (FR-WFL-007). Optional on other outcomes. */
  @Column({ name: 'reason', type: 'varchar', length: 1000, nullable: true })
  reason: string | null;

  @Column({ name: 'reviewed_version', type: 'integer' })
  reviewedVersion: number;

  /** The matter as the reviewer saw it. Written once, never recomputed. */
  @Column({ name: 'reviewed_snapshot', type: 'jsonb' })
  reviewedSnapshot: Record<string, unknown>;

  @Column({ name: 'occurred_at', type: 'timestamptz', default: () => 'now()' })
  occurredAt: Date;
}
