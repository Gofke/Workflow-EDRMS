import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Account } from '../identity/account.entity';

/** The actions that may be delegated. DEC-13 decides the matrix; this is the vocabulary. */
export enum DelegatableAction {
  ASSIGN_RESPONSIBILITY = 'ASSIGN_RESPONSIBILITY',
  SET_DUE_DATE = 'SET_DUE_DATE',
  /**
   * Deciding on a matter for the designated reviewer. Absent from the default
   * DELEGATABLE_ACTIONS configuration: approval authority is the last thing
   * that should spread by default, and FR-WFL-006 permits it only where acting
   * on behalf is explicitly allowed.
   */
  APPROVE_ON_BEHALF = 'APPROVE_ON_BEHALF',
}

/**
 * An explicit, scoped, time-bounded grant of authority to act for someone else
 * (FR-DEL-001, FR-DEL-002).
 *
 * No credential is shared. The delegate signs in as themselves and the system
 * decides, per action, whether they currently hold authority for it. That is
 * why this is a row and not a password.
 *
 * FR-DEL-002 requires four things to be identifiable: the principal whose
 * authority is represented, the delegate who may act, the permitted actions,
 * and the period during which it is valid. All four are columns here.
 *
 * FR-DEL-006: revoking sets revokedAt. The row is never deleted, so evidence of
 * what was legitimately done while the delegation was valid survives.
 */
@Entity({ name: 'delegation' })
export class Delegation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Whose authority is being represented. */
  @Index('ix_delegation_principal')
  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'principal_account_id' })
  principal: Account;

  /** Who may act under it. Always an individual account (FR-SEC-001). */
  @Index('ix_delegation_delegate')
  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'delegate_account_id' })
  delegate: Account;

  /**
   * The permitted actions, as a comma-separated list of DelegatableAction
   * codes. Only what is listed is granted: nothing else follows from it
   * (FR-DEL-004).
   */
  @Column({ name: 'permitted_actions', type: 'varchar', length: 400 })
  permittedActions: string;

  @Column({ name: 'valid_from', type: 'timestamptz' })
  validFrom: Date;

  @Column({ name: 'valid_until', type: 'timestamptz' })
  validUntil: Date;

  /** Who granted it. Not necessarily the principal, where policy allows. */
  @ManyToOne(() => Account, { nullable: false })
  @JoinColumn({ name: 'granted_by_account_id' })
  grantedBy: Account;

  @Column({ name: 'granted_at', type: 'timestamptz', default: () => 'now()' })
  grantedAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @ManyToOne(() => Account, { nullable: true })
  @JoinColumn({ name: 'revoked_by_account_id' })
  revokedBy: Account | null;
}
