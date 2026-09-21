import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * The event types recorded so far. Review and finalisation events are added by
 * the versions that introduce those actions.
 */
export enum AuditEventType {
  SIGN_IN_SUCCEEDED = 'SIGN_IN_SUCCEEDED',
  SIGN_IN_FAILED = 'SIGN_IN_FAILED',
  SIGN_OUT = 'SIGN_OUT',
  ROLE_ASSIGNED = 'ROLE_ASSIGNED',
  ROLE_REVOKED = 'ROLE_REVOKED',
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  ACCOUNT_ENABLED = 'ACCOUNT_ENABLED',
  DRAFT_CREATED = 'DRAFT_CREATED',
  ITEM_REGISTERED = 'ITEM_REGISTERED',
  DOSSIER_CREATED = 'DOSSIER_CREATED',
  RECORD_LINKED = 'RECORD_LINKED',
  RESPONSIBILITY_ASSIGNED = 'RESPONSIBILITY_ASSIGNED',
  RESPONSIBILITY_REASSIGNED = 'RESPONSIBILITY_REASSIGNED',
  DUE_DATE_SET = 'DUE_DATE_SET',
  DUE_DATE_CHANGED = 'DUE_DATE_CHANGED',
  DOCUMENT_CAPTURED = 'DOCUMENT_CAPTURED',
  DOCUMENT_RETRIEVED = 'DOCUMENT_RETRIEVED',
  DOCUMENT_INTEGRITY_FAILED = 'DOCUMENT_INTEGRITY_FAILED',
  DELEGATION_GRANTED = 'DELEGATION_GRANTED',
  DELEGATION_REVOKED = 'DELEGATION_REVOKED',
  WORKFLOW_SUBMITTED = 'WORKFLOW_SUBMITTED',
  WORKFLOW_RETURNED = 'WORKFLOW_RETURNED',
  WORKFLOW_APPROVED = 'WORKFLOW_APPROVED',
  WORKFLOW_FINALISED = 'WORKFLOW_FINALISED',
  WORKFLOW_REOPENED = 'WORKFLOW_REOPENED',
  DOSSIER_CLOSED = 'DOSSIER_CLOSED',
  DOSSIER_REOPENED = 'DOSSIER_REOPENED',
  TIMELINE_EXPORTED = 'TIMELINE_EXPORTED',
}

/**
 * An append-only record of a material action (FR-AUD family).
 *
 * Three properties matter and are enforced rather than intended:
 *
 * 1. Append-only. A database rule blocks UPDATE and DELETE on this table, so
 *    history cannot be silently rewritten even by a direct SQL connection
 *    (FR-GEN-007). See the V0.1.2 migration.
 * 2. Server time. occurredAt is set by the database with now(). No client value
 *    is ever accepted as the evidentiary timestamp.
 * 3. Real attribution. actorAccountId is the authenticated account that acted,
 *    never a claimed identity. actorDescription copies the person's name as it
 *    stood at the time, so the history stays readable after a rename.
 */
@Entity({ name: 'audit_event' })
export class AuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('ix_audit_event_occurred_at')
  @Column({ name: 'occurred_at', type: 'timestamptz', default: () => 'now()' })
  occurredAt: Date;

  @Column({ name: 'event_type', type: 'varchar', length: 60 })
  eventType: AuditEventType;

  /** Null only where no account could be identified, as in a failed sign-in. */
  @Index('ix_audit_event_actor')
  @Column({ name: 'actor_account_id', type: 'uuid', nullable: true })
  actorAccountId: string | null;

  @Column({ name: 'actor_description', type: 'varchar', length: 260 })
  actorDescription: string;

  /**
   * The authority represented, where the actor acted for someone else
   * (FR-DEL-003). Null for an action taken in the actor's own right — never
   * filled in speculatively, because a false representation is as damaging to
   * the accountability chain as a missing one.
   */
  @Column({ name: 'represented_authority', type: 'varchar', length: 260, nullable: true })
  representedAuthority: string | null;

  /** The account, role or other object the action was performed upon. */
  @Column({ name: 'subject_description', type: 'varchar', length: 260, nullable: true })
  subjectDescription: string | null;

  @Column({ name: 'previous_value', type: 'varchar', length: 400, nullable: true })
  previousValue: string | null;

  @Column({ name: 'new_value', type: 'varchar', length: 400, nullable: true })
  newValue: string | null;

  /** Plain-language sentence, so a non-developer can read the history. */
  @Column({ name: 'summary', type: 'varchar', length: 600 })
  summary: string;
}
