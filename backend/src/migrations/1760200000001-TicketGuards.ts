import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.5.0 — guards for project tickets, in the database itself.
 *
 * A ticket belongs to its project only: it is never linked to a matter or a
 * letter, whose timelines and readers are outside the project's need-to-know.
 * The application refuses this too; the constraint makes it hold for any client.
 * Owner and project manager are two different people (one writes the business
 * case, the other decides on it).
 */
export class TicketGuards1760200000001 implements MigrationInterface {
  name = 'TicketGuards1760200000001';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE task ADD CONSTRAINT task_ticket_stays_in_project
      CHECK (project_milestone_id IS NULL OR (dossier_id IS NULL AND correspondence_item_id IS NULL))`);
    await q.query(`ALTER TABLE project ADD CONSTRAINT project_owner_is_not_manager CHECK (owner_account_id <> manager_account_id)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE project DROP CONSTRAINT IF EXISTS project_owner_is_not_manager`);
    await q.query(`ALTER TABLE task DROP CONSTRAINT IF EXISTS task_ticket_stays_in_project`);
  }
}
