import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Account } from './account.entity';
import { FunctionalRole } from './functional-role.entity';

/**
 * Assignment of a functional role to an account (FR-SEC-002: one or more
 * configured roles per authenticated user).
 *
 * Revocation sets revokedAt rather than deleting the row, so removing authority
 * prevents future use without altering historical evidence (FR-SEC-011,
 * FS02-AC-005). An assignment is active when revokedAt is null.
 */
@Entity({ name: 'role_assignment' })
@Unique('uq_role_assignment_account_role', ['account', 'role'])
export class RoleAssignment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Account, (account) => account.roleAssignments, { nullable: false })
  @JoinColumn({ name: 'account_id' })
  account: Account;

  @ManyToOne(() => FunctionalRole, { nullable: false })
  @JoinColumn({ name: 'functional_role_id' })
  role: FunctionalRole;

  @Column({ name: 'assigned_at', type: 'timestamptz', default: () => 'now()' })
  assignedAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
}
