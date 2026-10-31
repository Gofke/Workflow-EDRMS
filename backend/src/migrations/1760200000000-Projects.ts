import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.5.0 — projects.
 *
 * A project has an owner (opdrachtgever) who answers for it, a project manager
 * (projectleider) who runs it, stakeholders and team members. It moves through
 * milestones; the first milestone is the business case, which the owner
 * approves before the work starts, and the last is the closure, which the owner
 * signs off. The work itself is tickets: tasks that belong to a milestone and
 * have a start date, so they keep everything a task has (assignee, comments,
 * checklist, attachments, reminders, audit) and draw a Gantt chart.
 *
 * Need-to-know: a team member sees their own tickets, not the whole project.
 * The rules live in ProjectsService and TasksService.visibility.
 */
export class Projects1760200000000 implements MigrationInterface {
  name = 'Projects1760200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE SEQUENCE "project_sequence" START 1`);
    await q.query(`
      CREATE TABLE "project" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "reference" character varying(40) NOT NULL,
        "name" character varying(200) NOT NULL,
        "description" character varying(20000) NOT NULL DEFAULT '',
        "unit_id" uuid NOT NULL,
        "owner_account_id" uuid NOT NULL,
        "manager_account_id" uuid NOT NULL,
        "classification" character varying(20) NOT NULL DEFAULT 'INTERNAL',
        "status" character varying(20) NOT NULL DEFAULT 'PROPOSED',
        "status_before_hold" character varying(20),
        "status_reason" character varying(600),
        "start_date" date NOT NULL,
        "end_date" date NOT NULL,
        "business_case_status" character varying(20) NOT NULL DEFAULT 'DRAFT',
        "bc_problem" character varying(8000) NOT NULL DEFAULT '',
        "bc_solution" character varying(8000) NOT NULL DEFAULT '',
        "bc_benefits" character varying(8000) NOT NULL DEFAULT '',
        "bc_costs" character varying(8000) NOT NULL DEFAULT '',
        "bc_risks" character varying(8000) NOT NULL DEFAULT '',
        "budget" numeric(14,2),
        "bc_submitted_at" TIMESTAMP WITH TIME ZONE,
        "bc_decided_at" TIMESTAMP WITH TIME ZONE,
        "bc_decided_by_account_id" uuid,
        "bc_return_reason" character varying(600),
        "created_by_account_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "pk_project" PRIMARY KEY ("id"),
        CONSTRAINT "uq_project_reference" UNIQUE ("reference"),
        CONSTRAINT "fk_project_unit" FOREIGN KEY ("unit_id") REFERENCES "organisational_unit"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_project_owner" FOREIGN KEY ("owner_account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_project_manager" FOREIGN KEY ("manager_account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_project_creator" FOREIGN KEY ("created_by_account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_project_bc_decider" FOREIGN KEY ("bc_decided_by_account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_project_name" CHECK (char_length(btrim("name")) > 0),
        CONSTRAINT "ck_project_classification" CHECK ("classification" IN ('INTERNAL','CONFIDENTIAL')),
        CONSTRAINT "ck_project_status" CHECK ("status" IN ('PROPOSED','ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
        CONSTRAINT "ck_project_bc_status" CHECK ("business_case_status" IN ('DRAFT','SUBMITTED','APPROVED','RETURNED')),
        CONSTRAINT "ck_project_dates" CHECK ("end_date" >= "start_date"),
        CONSTRAINT "ck_project_budget" CHECK ("budget" IS NULL OR "budget" >= 0),
        CONSTRAINT "ck_project_hold" CHECK ("status" <> 'ON_HOLD' OR "status_before_hold" IS NOT NULL)
      )`);
    await q.query(`CREATE INDEX "ix_project_unit" ON "project" ("unit_id")`);
    await q.query(`CREATE INDEX "ix_project_owner" ON "project" ("owner_account_id")`);
    await q.query(`CREATE INDEX "ix_project_manager" ON "project" ("manager_account_id")`);
    await q.query(`CREATE RULE "project_no_delete" AS ON DELETE TO "project" DO INSTEAD NOTHING`);

    await q.query(`
      CREATE TABLE "project_member" (
        "project_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "role" character varying(20) NOT NULL,
        "added_by_account_id" uuid NOT NULL,
        "added_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "removed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_project_member" PRIMARY KEY ("project_id", "account_id"),
        CONSTRAINT "fk_project_member_project" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_project_member_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_project_member_adder" FOREIGN KEY ("added_by_account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_project_member_role" CHECK ("role" IN ('STAKEHOLDER','MEMBER'))
      )`);
    await q.query(`CREATE INDEX "ix_project_member_account" ON "project_member" ("account_id") WHERE "removed_at" IS NULL`);

    await q.query(`
      CREATE TABLE "project_milestone" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "project_id" uuid NOT NULL,
        "position" integer NOT NULL,
        "name" character varying(200) NOT NULL,
        "description" character varying(4000) NOT NULL DEFAULT '',
        "gate" character varying(20),
        "start_date" date NOT NULL,
        "end_date" date NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'PLANNED',
        "closed_at" TIMESTAMP WITH TIME ZONE,
        "closed_by_account_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_project_milestone" PRIMARY KEY ("id"),
        CONSTRAINT "uq_project_milestone_position" UNIQUE ("project_id", "position"),
        CONSTRAINT "fk_project_milestone_project" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_project_milestone_closer" FOREIGN KEY ("closed_by_account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_project_milestone_name" CHECK (char_length(btrim("name")) > 0),
        CONSTRAINT "ck_project_milestone_gate" CHECK ("gate" IS NULL OR "gate" IN ('BUSINESS_CASE','CLOSURE')),
        CONSTRAINT "ck_project_milestone_status" CHECK ("status" IN ('PLANNED','ACTIVE','CLOSED')),
        CONSTRAINT "ck_project_milestone_dates" CHECK ("end_date" >= "start_date"),
        CONSTRAINT "ck_project_milestone_closed" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL))
      )`);
    await q.query(`CREATE RULE "project_milestone_no_delete" AS ON DELETE TO "project_milestone" DO INSTEAD NOTHING`);

    await q.query(`
      CREATE TABLE "project_event" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "project_id" uuid NOT NULL,
        "event_type" character varying(40) NOT NULL,
        "actor_account_id" uuid NOT NULL,
        "note" character varying(600),
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_project_event" PRIMARY KEY ("id"),
        CONSTRAINT "fk_project_event_project" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_project_event_actor" FOREIGN KEY ("actor_account_id") REFERENCES "account"("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "ix_project_event_project" ON "project_event" ("project_id", "occurred_at")`);
    await q.query(`CREATE RULE "project_event_no_update" AS ON UPDATE TO "project_event" DO INSTEAD NOTHING`);
    await q.query(`CREATE RULE "project_event_no_delete" AS ON DELETE TO "project_event" DO INSTEAD NOTHING`);

    // Tickets are tasks in a milestone, with a start date for the Gantt chart.
    await q.query(`ALTER TABLE "task" ADD COLUMN "project_milestone_id" uuid`);
    await q.query(`ALTER TABLE "task" ADD COLUMN "start_date" date`);
    await q.query(`ALTER TABLE "task" ADD CONSTRAINT "fk_task_milestone" FOREIGN KEY ("project_milestone_id") REFERENCES "project_milestone"("id") ON DELETE RESTRICT`);
    await q.query(`ALTER TABLE "task" ADD CONSTRAINT "ck_task_start_before_due" CHECK ("start_date" IS NULL OR "due_date" IS NULL OR "start_date" <= "due_date")`);
    await q.query(`CREATE INDEX "ix_task_milestone" ON "task" ("project_milestone_id") WHERE "project_milestone_id" IS NOT NULL`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "ix_task_milestone"`);
    await q.query(`ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "ck_task_start_before_due"`);
    await q.query(`ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "fk_task_milestone"`);
    await q.query(`ALTER TABLE "task" DROP COLUMN IF EXISTS "start_date"`);
    await q.query(`ALTER TABLE "task" DROP COLUMN IF EXISTS "project_milestone_id"`);
    await q.query(`DROP TABLE IF EXISTS "project_event"`);
    await q.query(`DROP TABLE IF EXISTS "project_milestone"`);
    await q.query(`DROP TABLE IF EXISTS "project_member"`);
    await q.query(`DROP TABLE IF EXISTS "project"`);
    await q.query(`DROP SEQUENCE IF EXISTS "project_sequence"`);
  }
}
