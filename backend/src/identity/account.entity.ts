import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { OrganisationalUnit } from './organisational-unit.entity';
import { Person } from './person.entity';
import { RoleAssignment } from './role-assignment.entity';

/**
 * An authentication identity (FS-06 §4: Account).
 *
 * FR-SEC-001: every human user is identified through an individual account, not
 * a shared operational account. Account state controls login only — it never
 * removes historical authorship, which is why an account is disabled rather
 * than deleted (FR-SEC-011).
 */
@Entity({ name: 'account' })
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'email', type: 'varchar', length: 320, unique: true })
  email: string;

  /** scrypt hash in the format N:r:p:salt:hash. Never a plaintext password. */
  @Column({ name: 'password_hash', type: 'varchar', length: 400 })
  passwordHash: string;

  @Column({ name: 'is_enabled', type: 'boolean', default: true })
  isEnabled: boolean;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @ManyToOne(() => Person, (person) => person.accounts, { nullable: false })
  @JoinColumn({ name: 'person_id' })
  person: Person;

  @ManyToOne(() => OrganisationalUnit, { nullable: true })
  @JoinColumn({ name: 'organisational_unit_id' })
  organisationalUnit: OrganisationalUnit | null;

  @OneToMany(() => RoleAssignment, (assignment) => assignment.account)
  roleAssignments: RoleAssignment[];
}
