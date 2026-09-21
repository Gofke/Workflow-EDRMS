import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.1.6 — responsibility and official due dates for a matter.
 *
 * Three protections live here rather than in application code:
 *
 * 1. A partial unique index giving each dossier at most one live responsibility
 *    (FR-OWN-001). Two concurrent assignments cannot both become current.
 * 2. due_date_change is append-only, matching audit_event. Assignment rows are
 *    delete-proof and rewrite-proof: a trigger permits only the one legitimate
 *    update, marking a row superseded (FR-OWN-003, FR-OWN-006).
 * 3. The dossier's current due date is a plain column, but every change to it
 *    must leave a row in due_date_change. A trigger enforces that: the column
 *    cannot move unless a change row for the new value exists, so the current
 *    value can never drift away from its own history.
 */
export class Responsibility1758500000000 implements MigrationInterface {
  name = 'Responsibility1758500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "dossier" ADD COLUMN "due_date" date`);

    await queryRunner.query(`
      CREATE TABLE "responsibility_assignment" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_id" uuid NOT NULL,
        "responsible_account_id" uuid NOT NULL,
        "assigned_by_account_id" uuid NOT NULL,
        "assigned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "superseded_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_responsibility_assignment" PRIMARY KEY ("id"),
        CONSTRAINT "fk_responsibility_dossier" FOREIGN KEY ("dossier_id")
          REFERENCES "dossier"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_responsibility_responsible" FOREIGN KEY ("responsible_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_responsibility_assigned_by" FOREIGN KEY ("assigned_by_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT
      )`);

    // FR-OWN-001: one unambiguous current owner per matter.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "ix_responsibility_one_current"
        ON "responsibility_assignment" ("dossier_id")
        WHERE "superseded_at" IS NULL`);

    await queryRunner.query(`
      CREATE TABLE "due_date_change" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_id" uuid NOT NULL,
        "previous_due_date" date,
        "new_due_date" date,
        "reason" character varying(600),
        "changed_by_account_id" uuid NOT NULL,
        "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_due_date_change" PRIMARY KEY ("id"),
        CONSTRAINT "fk_due_date_dossier" FOREIGN KEY ("dossier_id")
          REFERENCES "dossier"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_due_date_changed_by" FOREIGN KEY ("changed_by_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        -- A row that records no actual change is not history, it is noise.
        CONSTRAINT "ck_due_date_change_moved"
          CHECK ("previous_due_date" IS DISTINCT FROM "new_due_date")
      )`);

    await queryRunner.query(
      `CREATE INDEX "ix_due_date_change_dossier" ON "due_date_change" ("dossier_id", "changed_at")`,
    );

    // due_date_change is pure history: append-only, like audit_event.
    await queryRunner.query(
      `CREATE RULE "due_date_change_no_update" AS ON UPDATE TO "due_date_change" DO INSTEAD NOTHING`,
    );
    await queryRunner.query(
      `CREATE RULE "due_date_change_no_delete" AS ON DELETE TO "due_date_change" DO INSTEAD NOTHING`,
    );

    // responsibility_assignment cannot be append-only in the same way, because
    // superseding an assignment is a legitimate update to superseded_at. So a
    // trigger permits exactly that one transition and nothing else: no other
    // column may change, a superseded row may never be revived, and rows are
    // never deleted.
    await queryRunner.query(
      `CREATE RULE "responsibility_assignment_no_delete"
         AS ON DELETE TO "responsibility_assignment" DO INSTEAD NOTHING`,
    );

    await queryRunner.query(`
      CREATE FUNCTION "protect_responsibility_history"() RETURNS trigger AS $$
      BEGIN
        IF NEW.dossier_id IS DISTINCT FROM OLD.dossier_id
           OR NEW.responsible_account_id IS DISTINCT FROM OLD.responsible_account_id
           OR NEW.assigned_by_account_id IS DISTINCT FROM OLD.assigned_by_account_id
           OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at THEN
          RAISE EXCEPTION 'an assignment record cannot be rewritten; assign a new one instead';
        END IF;
        IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
          RAISE EXCEPTION 'a superseded assignment cannot be changed or revived';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);

    await queryRunner.query(`
      CREATE TRIGGER "trg_protect_responsibility_history"
        BEFORE UPDATE ON "responsibility_assignment"
        FOR EACH ROW EXECUTE FUNCTION "protect_responsibility_history"()`);

    // The current due date cannot move without a matching history row.
    await queryRunner.query(`
      CREATE FUNCTION "require_due_date_history"() RETURNS trigger AS $$
      BEGIN
        IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
          IF NOT EXISTS (
            SELECT 1 FROM due_date_change
             WHERE dossier_id = NEW.id
               AND new_due_date IS NOT DISTINCT FROM NEW.due_date
               AND previous_due_date IS NOT DISTINCT FROM OLD.due_date
          ) THEN
            RAISE EXCEPTION 'a due date change must be recorded in due_date_change first';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);

    await queryRunner.query(`
      CREATE TRIGGER "trg_require_due_date_history"
        BEFORE UPDATE ON "dossier"
        FOR EACH ROW EXECUTE FUNCTION "require_due_date_history"()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_require_due_date_history" ON "dossier"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS "require_due_date_history"()`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_protect_responsibility_history" ON "responsibility_assignment"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS "protect_responsibility_history"()`);
    await queryRunner.query(`DROP TABLE "due_date_change"`);
    await queryRunner.query(`DROP TABLE "responsibility_assignment"`);
    await queryRunner.query(`ALTER TABLE "dossier" DROP COLUMN "due_date"`);
  }
}
