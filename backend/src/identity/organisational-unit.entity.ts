import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Approved organisational context (FS-06 §4: Organisational Unit).
 * Delivery 1 carries only approved Head Office structures. No ministry-wide
 * hierarchy is invented here.
 */
@Entity({ name: 'organisational_unit' })
export class OrganisationalUnit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 40, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
