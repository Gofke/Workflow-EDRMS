import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.3.0 — tasks and actions (brought over from Workflow Task Management).
 *
 * A task is an instruction to a person: who must do what, by when, for whom,
 * and — when it concerns a letter or a matter — which one. It lives beside the
 * record and the matter, never instead of them.
 *
 * What the database enforces:
 *
 * 1. A task cannot be deleted. Workflow Task Management removed a task
 *    permanently with no trace; here a task is cancelled with a reason or
 *    archived, and the row stays. A DELETE is a no-op.
 * 2. task_event, task_comment and task_attachment are append-only. A comment
 *    cannot be reworded after the fact, and the history of a task cannot be
 *    rewritten.
 * 3. A cancelled task carries its reason; a completed task carries the time it
 *    was completed.
 * 4. Nothing new may be attached to a closed matter: a task on a closed dossier
 *    is refused the same way a new link is.
 */
export class Tasks1759400000000 implements MigrationInterface {
  name = 'Tasks1759400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE SEQUENCE "task_sequence" START 1`);
    await q.query(`
      CREATE TABLE "task_template" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(200) NOT NULL,
        "description" character varying(1000) NOT NULL DEFAULT '',
        "title_template" character varying(200) NOT NULL,
        "default_priority" character varying(10) NOT NULL DEFAULT 'MEDIUM',
        "default_due_working_days" integer,
        "checklist" jsonb NOT NULL DEFAULT '[]',
        "subtasks" jsonb NOT NULL DEFAULT '[]',
        "is_active" boolean NOT NULL DEFAULT true,
        "created_by_account_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_task_template" PRIMARY KEY ("id"),
        CONSTRAINT "ck_task_template_priority" CHECK ("default_priority" IN ('LOW','MEDIUM','HIGH','URGENT'))
      )`);
    await q.query(
      `CREATE UNIQUE INDEX "ix_task_template_name" ON "task_template" (lower("name")) WHERE "is_active"`,
    );
    await q.query(`
      CREATE TABLE "task" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "reference" character varying(40) NOT NULL,
        "title" character varying(200) NOT NULL,
        "description" character varying(20000) NOT NULL DEFAULT '',
        "status" character varying(20) NOT NULL DEFAULT 'OPEN',
        "priority" character varying(10) NOT NULL DEFAULT 'MEDIUM',
        "due_date" date,
        "assignee_account_id" uuid NOT NULL,
        "owner_account_id" uuid NOT NULL,
        "created_by_account_id" uuid NOT NULL,
        "on_behalf_of_account_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1,
        "dossier_id" uuid,
        "correspondence_item_id" uuid,
        "parent_task_id" uuid,
        "template_id" uuid,
        "recurrence" character varying(10) NOT NULL DEFAULT 'NONE',
        "series_id" uuid,
        "source" character varying(20) NOT NULL DEFAULT 'MANUAL',
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "cancelled_reason" character varying(600),
        "rejection_reason" character varying(600),
        "archived_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_task" PRIMARY KEY ("id"),
        CONSTRAINT "uq_task_reference" UNIQUE ("reference"),
        CONSTRAINT "fk_task_assignee" FOREIGN KEY ("assignee_account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_task_owner" FOREIGN KEY ("owner_account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_task_creator" FOREIGN KEY ("created_by_account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_task_dossier" FOREIGN KEY ("dossier_id") REFERENCES "dossier"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_task_item" FOREIGN KEY ("correspondence_item_id") REFERENCES "correspondence_item"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_task_parent" FOREIGN KEY ("parent_task_id") REFERENCES "task"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_task_template" FOREIGN KEY ("template_id") REFERENCES "task_template"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_task_status" CHECK ("status" IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW','COMPLETED','REJECTED','CANCELLED')),
        CONSTRAINT "ck_task_priority" CHECK ("priority" IN ('LOW','MEDIUM','HIGH','URGENT')),
        CONSTRAINT "ck_task_recurrence" CHECK ("recurrence" IN ('NONE','WEEKLY','MONTHLY')),
        CONSTRAINT "ck_task_source" CHECK ("source" IN ('MANUAL','TEMPLATE','AI_PROPOSAL','MEETING_NOTES','RECURRENCE','BULK','CHAT')),
        CONSTRAINT "ck_task_title" CHECK (char_length(btrim("title")) > 0),
        CONSTRAINT "ck_task_cancel_reason" CHECK ("status" <> 'CANCELLED' OR ("cancelled_reason" IS NOT NULL AND char_length("cancelled_reason") > 0)),
        CONSTRAINT "ck_task_completed_at" CHECK (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL)),
        CONSTRAINT "ck_task_not_own_parent" CHECK ("parent_task_id" IS NULL OR "parent_task_id" <> "id")
      )`);
    await q.query(`CREATE INDEX "ix_task_assignee" ON "task" ("assignee_account_id", "status")`);
    await q.query(`CREATE INDEX "ix_task_owner" ON "task" ("owner_account_id", "status")`);
    await q.query(`CREATE INDEX "ix_task_dossier" ON "task" ("dossier_id")`);
    await q.query(`CREATE INDEX "ix_task_item" ON "task" ("correspondence_item_id")`);
    await q.query(`CREATE INDEX "ix_task_parent" ON "task" ("parent_task_id")`);
    await q.query(`CREATE INDEX "ix_task_due" ON "task" ("due_date") WHERE "status" NOT IN ('COMPLETED','CANCELLED','REJECTED')`);
    await q.query(`CREATE RULE "task_no_delete" AS ON DELETE TO "task" DO INSTEAD NOTHING`);

    await q.query(`
      CREATE TABLE "task_audience" (
        "task_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "added_by_account_id" uuid NOT NULL,
        "added_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_task_audience" PRIMARY KEY ("task_id", "account_id"),
        CONSTRAINT "fk_task_audience_task" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_task_audience_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "ix_task_audience_account" ON "task_audience" ("account_id")`);

    await q.query(`
      CREATE TABLE "task_checklist_item" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "task_id" uuid NOT NULL,
        "label" character varying(300) NOT NULL,
        "position" integer NOT NULL DEFAULT 0,
        "done" boolean NOT NULL DEFAULT false,
        "done_by_account_id" uuid,
        "done_at" TIMESTAMP WITH TIME ZONE,
        "removed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_task_checklist_item" PRIMARY KEY ("id"),
        CONSTRAINT "fk_task_checklist_task" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_task_checklist_label" CHECK (char_length(btrim("label")) > 0)
      )`);
    await q.query(`CREATE INDEX "ix_task_checklist_task" ON "task_checklist_item" ("task_id", "position")`);
    await q.query(`CREATE RULE "task_checklist_no_delete" AS ON DELETE TO "task_checklist_item" DO INSTEAD NOTHING`);

    await q.query(`
      CREATE TABLE "task_comment" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "task_id" uuid NOT NULL,
        "author_account_id" uuid NOT NULL,
        "body" character varying(5000) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_task_comment" PRIMARY KEY ("id"),
        CONSTRAINT "fk_task_comment_task" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_task_comment_author" FOREIGN KEY ("author_account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_task_comment_body" CHECK (char_length(btrim("body")) > 0)
      )`);
    await q.query(`CREATE INDEX "ix_task_comment_task" ON "task_comment" ("task_id", "created_at")`);
    await q.query(`
      CREATE TABLE "task_mention" (
        "comment_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        CONSTRAINT "pk_task_mention" PRIMARY KEY ("comment_id", "account_id"),
        CONSTRAINT "fk_task_mention_comment" FOREIGN KEY ("comment_id") REFERENCES "task_comment"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_task_mention_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT
      )`);
    await q.query(`
      CREATE TABLE "task_attachment" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "task_id" uuid NOT NULL,
        "original_filename" character varying(400) NOT NULL,
        "media_type" character varying(120) NOT NULL,
        "byte_size" bigint NOT NULL,
        "content_hash" character varying(64) NOT NULL,
        "storage_key" character varying(200) NOT NULL,
        "uploaded_by_account_id" uuid NOT NULL,
        "uploaded_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_task_attachment" PRIMARY KEY ("id"),
        CONSTRAINT "fk_task_attachment_task" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_task_attachment_hash" CHECK ("content_hash" ~ '^[0-9a-f]{64}$')
      )`);
    await q.query(`
      CREATE TABLE "task_event" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "task_id" uuid NOT NULL,
        "event_type" character varying(40) NOT NULL,
        "actor_account_id" uuid NOT NULL,
        "on_behalf_of_account_id" uuid,
        "from_value" character varying(300),
        "to_value" character varying(300),
        "note" character varying(600),
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_task_event" PRIMARY KEY ("id"),
        CONSTRAINT "fk_task_event_task" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_task_event_actor" FOREIGN KEY ("actor_account_id") REFERENCES "account"("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX "ix_task_event_task" ON "task_event" ("task_id", "occurred_at")`);
    for (const table of ['task_comment', 'task_mention', 'task_attachment', 'task_event']) {
      await q.query(`CREATE RULE "${table}_no_update" AS ON UPDATE TO "${table}" DO INSTEAD NOTHING`);
      await q.query(`CREATE RULE "${table}_no_delete" AS ON DELETE TO "${table}" DO INSTEAD NOTHING`);
    }

    // No new task on a closed matter (FR-DOS-007).
    await q.query(`
      CREATE FUNCTION "refuse_task_on_closed_dossier"() RETURNS trigger AS $$
      BEGIN
        IF NEW.dossier_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.dossier_id IS DISTINCT FROM OLD.dossier_id)
           AND EXISTS (SELECT 1 FROM dossier WHERE id = NEW.dossier_id AND state = 'CLOSED') THEN
          RAISE EXCEPTION 'dossier is closed; reopen it before changing it';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER "trg_task_closed_dossier"
        BEFORE INSERT OR UPDATE ON "task"
        FOR EACH ROW EXECUTE FUNCTION "refuse_task_on_closed_dossier"()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "trg_task_closed_dossier" ON "task"`);
    await q.query(`DROP FUNCTION IF EXISTS "refuse_task_on_closed_dossier"()`);
    for (const table of ['task_event', 'task_attachment', 'task_mention', 'task_comment', 'task_checklist_item', 'task_audience', 'task', 'task_template']) {
      await q.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    await q.query(`DROP SEQUENCE IF EXISTS "task_sequence"`);
  }
}
