import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.1.13 — dossier closure and reopening (FR-DOS-006, 007, 008; EV-DOS-CLOSE).
 *
 * The dossier state is the matter FILE's state, separate from the processing
 * state that says where the work has got to:
 *
 *   OPEN     -> CLOSED     the matter is complete; ordinary change stops
 *   CLOSED   -> REOPENED   an explicit, reasoned, authorised event
 *   REOPENED -> CLOSED     closed again after further handling
 *
 * Four protections live in the database, so no code path can bypass them:
 *
 * 1. dossier_state_event is append-only. A closure cannot be erased by the
 *    reopening that follows it (FR-DOS-008) — both stay, in order.
 * 2. Only the three transitions above are accepted, and only a FINALISED
 *    matter may be closed: closure needs the authoritative result to exist
 *    (T-06, UC-15 precondition).
 * 3. Every state change must be accounted for by a state event, the same
 *    event-backed rule the processing state already follows.
 * 4. While CLOSED, the subject, due date and processing state cannot change,
 *    and nothing may be added to the matter: no link, no assignment, no
 *    due-date change, no workflow event (FR-DOS-007). Reading is untouched.
 */
export class DossierClosure1759000000000 implements MigrationInterface {
  name = 'DossierClosure1759000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "dossier" DROP CONSTRAINT "ck_dossier_state"`);
    await queryRunner.query(`
      ALTER TABLE "dossier" ADD CONSTRAINT "ck_dossier_state"
        CHECK ("state" IN ('OPEN','CLOSED','REOPENED'))`);

    await queryRunner.query(`
      CREATE TABLE "dossier_state_event" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_id" uuid NOT NULL,
        "from_state" character varying(20) NOT NULL,
        "to_state" character varying(20) NOT NULL,
        "actor_account_id" uuid NOT NULL,
        "reason" character varying(1000),
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_dossier_state_event" PRIMARY KEY ("id"),
        CONSTRAINT "fk_dossier_state_event_dossier" FOREIGN KEY ("dossier_id")
          REFERENCES "dossier"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_dossier_state_event_actor" FOREIGN KEY ("actor_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_dossier_state_event_transition" CHECK (
             ("from_state" = 'OPEN'     AND "to_state" = 'CLOSED')
          OR ("from_state" = 'CLOSED'   AND "to_state" = 'REOPENED')
          OR ("from_state" = 'REOPENED' AND "to_state" = 'CLOSED')),
        -- A reopening without a reason is not an authorised explicit event.
        CONSTRAINT "ck_dossier_state_event_reopen_reason"
          CHECK ("to_state" <> 'REOPENED' OR ("reason" IS NOT NULL AND char_length("reason") > 0))
      )`);

    await queryRunner.query(
      `CREATE INDEX "ix_dossier_state_event_dossier"
         ON "dossier_state_event" ("dossier_id", "occurred_at")`,
    );
    await queryRunner.query(
      `CREATE RULE "dossier_state_event_no_update"
         AS ON UPDATE TO "dossier_state_event" DO INSTEAD NOTHING`,
    );
    await queryRunner.query(
      `CREATE RULE "dossier_state_event_no_delete"
         AS ON DELETE TO "dossier_state_event" DO INSTEAD NOTHING`,
    );

    await queryRunner.query(`
      CREATE FUNCTION "guard_dossier_state"() RETURNS trigger AS $$
      DECLARE
        accounted boolean := false;
      BEGIN
        IF NEW.state IS DISTINCT FROM OLD.state THEN
          IF NOT ((OLD.state = 'OPEN'     AND NEW.state = 'CLOSED')
               OR (OLD.state = 'CLOSED'   AND NEW.state = 'REOPENED')
               OR (OLD.state = 'REOPENED' AND NEW.state = 'CLOSED')) THEN
            RAISE EXCEPTION 'dossier state cannot move from % to %', OLD.state, NEW.state;
          END IF;

          IF NEW.state = 'CLOSED' AND NEW.processing_state <> 'FINALISED' THEN
            RAISE EXCEPTION 'a dossier can be closed only when its matter is finalised';
          END IF;

          SELECT EXISTS (
            SELECT 1 FROM dossier_state_event
             WHERE dossier_id = NEW.id
               AND from_state = OLD.state
               AND to_state = NEW.state
               AND occurred_at > now() - interval '5 seconds'
          ) INTO accounted;

          IF NOT accounted THEN
            RAISE EXCEPTION 'a dossier state change must be recorded as a state event first';
          END IF;
        END IF;

        IF OLD.state = 'CLOSED' AND NEW.state = 'CLOSED' AND (
             NEW.processing_state IS DISTINCT FROM OLD.processing_state
          OR NEW.subject IS DISTINCT FROM OLD.subject
          OR NEW.due_date IS DISTINCT FROM OLD.due_date) THEN
          RAISE EXCEPTION 'dossier is closed; reopen it before changing it';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);

    await queryRunner.query(`
      CREATE TRIGGER "trg_guard_dossier_state"
        BEFORE UPDATE ON "dossier"
        FOR EACH ROW EXECUTE FUNCTION "guard_dossier_state"()`);

    // Nothing may be added to a closed matter, whichever table it lands in.
    await queryRunner.query(`
      CREATE FUNCTION "refuse_if_dossier_closed"() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM dossier WHERE id = NEW.dossier_id AND state = 'CLOSED') THEN
          RAISE EXCEPTION 'dossier is closed; reopen it before changing it';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);

    for (const table of ['dossier_link', 'responsibility_assignment', 'due_date_change', 'workflow_event']) {
      await queryRunner.query(`
        CREATE TRIGGER "trg_${table}_closed_dossier"
          BEFORE INSERT ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION "refuse_if_dossier_closed"()`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['dossier_link', 'responsibility_assignment', 'due_date_change', 'workflow_event']) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_${table}_closed_dossier" ON "${table}"`);
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS "refuse_if_dossier_closed"()`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_guard_dossier_state" ON "dossier"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS "guard_dossier_state"()`);
    await queryRunner.query(`DROP TABLE "dossier_state_event"`);
    await queryRunner.query(`ALTER TABLE "dossier" DROP CONSTRAINT "ck_dossier_state"`);
    await queryRunner.query(`
      ALTER TABLE "dossier" ADD CONSTRAINT "ck_dossier_state" CHECK ("state" IN ('OPEN'))`);
  }
}
