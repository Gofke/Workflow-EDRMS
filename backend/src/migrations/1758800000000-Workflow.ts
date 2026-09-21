import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.1.9 — the review decision flow.
 *
 * Three protections in the database:
 *
 * 1. workflow_event is append-only. A decision is evidence: it cannot be
 *    edited or deleted, so a return reason cannot be reworded and an approval
 *    cannot be quietly withdrawn (FR-WFL-007, FR-WFL-008).
 * 2. Only the transitions FS-05 §3.4 permits are accepted. A trigger rejects
 *    anything else, so no code path — application or direct SQL — can move a
 *    matter from Active straight to Approved.
 * 3. Every state change must be accounted for by a workflow event. The trigger
 *    refuses a processing-state change with no event behind it, the same way
 *    the due date cannot move without its history.
 */
export class Workflow1758800000000 implements MigrationInterface {
  name = 'Workflow1758800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dossier" ADD COLUMN "processing_state" character varying(30)
         NOT NULL DEFAULT 'ACTIVE'`,
    );
    await queryRunner.query(`
      ALTER TABLE "dossier" ADD CONSTRAINT "ck_dossier_processing_state"
        CHECK ("processing_state" IN ('ACTIVE','UNDER_REVIEW','RETURNED','APPROVED'))`);

    await queryRunner.query(`
      CREATE TABLE "workflow_event" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_id" uuid NOT NULL,
        "event_type" character varying(30) NOT NULL,
        "actor_account_id" uuid NOT NULL,
        "on_behalf_of_account_id" uuid,
        "reviewer_account_id" uuid,
        "reason" character varying(1000),
        "reviewed_version" integer NOT NULL,
        "reviewed_snapshot" jsonb NOT NULL,
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_workflow_event" PRIMARY KEY ("id"),
        CONSTRAINT "fk_workflow_event_dossier" FOREIGN KEY ("dossier_id")
          REFERENCES "dossier"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_workflow_event_actor" FOREIGN KEY ("actor_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_workflow_event_on_behalf" FOREIGN KEY ("on_behalf_of_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_workflow_event_reviewer" FOREIGN KEY ("reviewer_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_workflow_event_type"
          CHECK ("event_type" IN ('SUBMITTED','RETURNED','APPROVED')),
        -- A return without a reason is not a reviewed decision (FR-WFL-007).
        CONSTRAINT "ck_workflow_event_return_reason"
          CHECK ("event_type" <> 'RETURNED' OR ("reason" IS NOT NULL AND char_length("reason") > 0)),
        -- A submission must name the reviewer it went to (FR-WFL-002).
        CONSTRAINT "ck_workflow_event_submit_reviewer"
          CHECK ("event_type" <> 'SUBMITTED' OR "reviewer_account_id" IS NOT NULL)
      )`);

    await queryRunner.query(
      `CREATE INDEX "ix_workflow_event_dossier"
         ON "workflow_event" ("dossier_id", "occurred_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_workflow_event_reviewer"
         ON "workflow_event" ("reviewer_account_id", "occurred_at")`,
    );

    await queryRunner.query(
      `CREATE RULE "workflow_event_no_update"
         AS ON UPDATE TO "workflow_event" DO INSTEAD NOTHING`,
    );
    await queryRunner.query(
      `CREATE RULE "workflow_event_no_delete"
         AS ON DELETE TO "workflow_event" DO INSTEAD NOTHING`,
    );

    await queryRunner.query(`
      CREATE FUNCTION "guard_processing_state"() RETURNS trigger AS $$
      DECLARE
        permitted boolean := false;
        accounted boolean := false;
      BEGIN
        IF NEW.processing_state IS NOT DISTINCT FROM OLD.processing_state THEN
          RETURN NEW;
        END IF;

        -- FS-05 §3.4 transitions, and only these.
        permitted := (OLD.processing_state = 'ACTIVE'       AND NEW.processing_state = 'UNDER_REVIEW')
                  OR (OLD.processing_state = 'UNDER_REVIEW' AND NEW.processing_state IN ('RETURNED','APPROVED'))
                  OR (OLD.processing_state = 'RETURNED'     AND NEW.processing_state = 'UNDER_REVIEW');

        IF NOT permitted THEN
          RAISE EXCEPTION 'processing state cannot move from % to %',
            OLD.processing_state, NEW.processing_state;
        END IF;

        SELECT EXISTS (
          SELECT 1 FROM workflow_event
           WHERE dossier_id = NEW.id
             AND occurred_at > now() - interval '5 seconds'
             AND ((NEW.processing_state = 'UNDER_REVIEW' AND event_type = 'SUBMITTED')
               OR (NEW.processing_state = 'RETURNED'     AND event_type = 'RETURNED')
               OR (NEW.processing_state = 'APPROVED'     AND event_type = 'APPROVED'))
        ) INTO accounted;

        IF NOT accounted THEN
          RAISE EXCEPTION 'a processing state change must be recorded as a workflow event first';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);

    await queryRunner.query(`
      CREATE TRIGGER "trg_guard_processing_state"
        BEFORE UPDATE ON "dossier"
        FOR EACH ROW EXECUTE FUNCTION "guard_processing_state"()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_guard_processing_state" ON "dossier"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS "guard_processing_state"()`);
    await queryRunner.query(`DROP TABLE "workflow_event"`);
    await queryRunner.query(
      `ALTER TABLE "dossier" DROP CONSTRAINT IF EXISTS "ck_dossier_processing_state"`,
    );
    await queryRunner.query(`ALTER TABLE "dossier" DROP COLUMN "processing_state"`);
  }
}
