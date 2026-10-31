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

  // Phase 3 — administration and security
  SETTING_CHANGED = 'SETTING_CHANGED',
  ACCOUNT_CREATED = 'ACCOUNT_CREATED',
  ACCOUNT_UPDATED = 'ACCOUNT_UPDATED',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  PASSWORD_RESET = 'PASSWORD_RESET',
  ACCOUNT_LOCKED = 'ACCOUNT_LOCKED',
  MFA_ENABLED = 'MFA_ENABLED',
  MFA_DISABLED = 'MFA_DISABLED',
  MFA_FAILED = 'MFA_FAILED',
  UNIT_CREATED = 'UNIT_CREATED',
  UNIT_UPDATED = 'UNIT_UPDATED',
  CLASSIFICATION_CHANGED = 'CLASSIFICATION_CHANGED',
  ACCESS_GRANTED = 'ACCESS_GRANTED',
  ACCESS_REVOKED = 'ACCESS_REVOKED',

  // Phase 3 — tasks and actions
  TASK_CREATED = 'TASK_CREATED',
  TASK_UPDATED = 'TASK_UPDATED',
  TASK_ASSIGNED = 'TASK_ASSIGNED',
  TASK_STATUS_CHANGED = 'TASK_STATUS_CHANGED',
  TASK_ACCEPTED = 'TASK_ACCEPTED',
  TASK_REJECTED = 'TASK_REJECTED',
  TASK_COMPLETED = 'TASK_COMPLETED',
  TASK_CANCELLED = 'TASK_CANCELLED',
  TASK_ARCHIVED = 'TASK_ARCHIVED',
  TASK_COMMENTED = 'TASK_COMMENTED',
  TASK_ATTACHMENT_ADDED = 'TASK_ATTACHMENT_ADDED',
  TASK_TEMPLATE_SAVED = 'TASK_TEMPLATE_SAVED',
  PROJECT_CREATED = 'PROJECT_CREATED',
  PROJECT_UPDATED = 'PROJECT_UPDATED',
  PROJECT_MEMBER_ADDED = 'PROJECT_MEMBER_ADDED',
  PROJECT_MEMBER_REMOVED = 'PROJECT_MEMBER_REMOVED',
  BUSINESS_CASE_SUBMITTED = 'BUSINESS_CASE_SUBMITTED',
  BUSINESS_CASE_APPROVED = 'BUSINESS_CASE_APPROVED',
  BUSINESS_CASE_RETURNED = 'BUSINESS_CASE_RETURNED',
  MILESTONE_CLOSED = 'MILESTONE_CLOSED',
  MILESTONE_CHANGED = 'MILESTONE_CHANGED',
  PROJECT_STATUS_CHANGED = 'PROJECT_STATUS_CHANGED',
  PROJECT_COMPLETED = 'PROJECT_COMPLETED',

  // Phase 3 — deadlines and notifications
  REMINDER_SENT = 'REMINDER_SENT',
  DEADLINE_ESCALATED = 'DEADLINE_ESCALATED',
  HOLIDAY_CHANGED = 'HOLIDAY_CHANGED',
  WEEKLY_REPORT_SENT = 'WEEKLY_REPORT_SENT',

  // Phase 3 — letters and documents
  DOCUMENT_REJECTED_MALWARE = 'DOCUMENT_REJECTED_MALWARE',
  DRAFT_VERSION_SAVED = 'DRAFT_VERSION_SAVED',
  LETTER_COMPOSED = 'LETTER_COMPOSED',
  LABEL_PRINTED = 'LABEL_PRINTED',
  EMAIL_INTAKE_RECEIVED = 'EMAIL_INTAKE_RECEIVED',
  LETTER_TEMPLATE_SAVED = 'LETTER_TEMPLATE_SAVED',

  // Phase 3 — case files
  CATEGORY_SAVED = 'CATEGORY_SAVED',
  DOSSIER_CATEGORISED = 'DOSSIER_CATEGORISED',
  DOSSIER_RELATED = 'DOSSIER_RELATED',
  LEGAL_HOLD_SET = 'LEGAL_HOLD_SET',
  LEGAL_HOLD_RELEASED = 'LEGAL_HOLD_RELEASED',
  RETENTION_DECIDED = 'RETENTION_DECIDED',
  ARCHIVE_PACKAGE_EXPORTED = 'ARCHIVE_PACKAGE_EXPORTED',
  TIMELINE_PDF_EXPORTED = 'TIMELINE_PDF_EXPORTED',

  // Phase 3 — approvals
  ROUTE_SAVED = 'ROUTE_SAVED',
  ROUTE_STEP_APPROVED = 'ROUTE_STEP_APPROVED',
  ADVICE_REQUESTED = 'ADVICE_REQUESTED',
  ADVICE_GIVEN = 'ADVICE_GIVEN',
  ADVICE_WITHDRAWN = 'ADVICE_WITHDRAWN',
  OUT_OF_OFFICE_SET = 'OUT_OF_OFFICE_SET',
  OUT_OF_OFFICE_ENDED = 'OUT_OF_OFFICE_ENDED',
  SEAL_APPLIED = 'SEAL_APPLIED',

  // Phase 3 — search, reporting, AI
  REPORT_EXPORTED = 'REPORT_EXPORTED',
  AI_SUGGESTION_ACCEPTED = 'AI_SUGGESTION_ACCEPTED',
  AI_SUGGESTION_REJECTED = 'AI_SUGGESTION_REJECTED',
  AI_QUESTION_ANSWERED = 'AI_QUESTION_ANSWERED',
  AI_QUESTION_FAILED = 'AI_QUESTION_FAILED',

  // Phase 3 — audit and integrations
  AUDIT_EXPORTED = 'AUDIT_EXPORTED',
  INTEGRITY_CHECK_RUN = 'INTEGRITY_CHECK_RUN',
  INTEGRATION_KEY_CREATED = 'INTEGRATION_KEY_CREATED',
  INTEGRATION_KEY_REVOKED = 'INTEGRATION_KEY_REVOKED',
  WIJSAMEN_REPORT_RECEIVED = 'WIJSAMEN_REPORT_RECEIVED',
  EXCHANGE_EXPORTED = 'EXCHANGE_EXPORTED',
  EXCHANGE_IMPORTED = 'EXCHANGE_IMPORTED',
  EXCHANGE_PARTNER_SAVED = 'EXCHANGE_PARTNER_SAVED',
  TRAINING_DATA_LOADED = 'TRAINING_DATA_LOADED',
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

  /** Position in the history. Assigned by the database. */
  @Column({ name: 'seq', type: 'bigint', insert: false, update: false })
  seq: string;

  /**
   * SHA-256 over this event and the previous event's hash (V0.3.0). Set by a
   * database trigger; the application never computes or supplies it.
   */
  @Column({ name: 'chain_hash', type: 'varchar', length: 64, insert: false, update: false, nullable: true })
  chainHash: string | null;
}
