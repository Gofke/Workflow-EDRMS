import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Account } from './account.entity';

/**
 * A human individual known to the system (FS-06 §4: Person).
 * A Person is never deleted, so historical authorship stays truthful when an
 * account is disabled or a role changes.
 */
@Entity({ name: 'person' })
export class Person {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'full_name', type: 'varchar', length: 200 })
  fullName: string;

  @Column({ name: 'job_position', type: 'varchar', length: 200, nullable: true })
  jobPosition: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @OneToMany(() => Account, (account) => account.person)
  accounts: Account[];
}
