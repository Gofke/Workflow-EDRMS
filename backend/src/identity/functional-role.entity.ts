import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * An approved business capability (FS-06 §4: Functional Role) — Minister,
 * Directeur, Onder-Directeur, support staff, administrator.
 *
 * Person, role and account are three separate concepts. Holding a role does not
 * by itself grant record access: FR-SEC-003 evaluates identity, role, scope,
 * relationship, sensitivity, delegation and workflow state together. V0.1.1
 * establishes the role only; permission evaluation arrives in a later step.
 */
@Entity({ name: 'functional_role' })
export class FunctionalRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 40, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 400 })
  description: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
