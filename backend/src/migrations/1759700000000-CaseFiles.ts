import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.3.0 — the file plan, related matters, retention and archive transfer.
 *
 * Retention (DEC-04) is still a Ministry decision. The retention period and
 * the action at its end (destroy, transfer to the National Archive, review)
 * are set per category by the records manager, not by this migration, and no
 * category comes with a value. Nothing is destroyed automatically: when a
 * retention period ends the matter appears on a review list, and a person
 * records the decision.
 *
 * A legal hold stops any retention decision being taken on a matter for as
 * long as it is in place. Setting and releasing it are both events.
 *
 * The closed-dossier guard is extended: a closed matter cannot be
 * re-categorised or re-classified either. Retention and legal-hold fields are
 * deliberately not frozen — they exist to be used on closed matters.
 */
export class CaseFiles1759700000000 implements MigrationInterface {
  name = 'CaseFiles1759700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "dossier_category" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "code" character varying(40) NOT NULL,
        "name" character varying(200) NOT NULL,
        "parent_id" uuid,
        "description" character varying(1000) NOT NULL DEFAULT '',
        "retention_years" integer,
        "retention_action" character varying(12),
        "handling_working_days" integer,
        "default_classification" character varying(20) NOT NULL DEFAULT 'INTERNAL',
        "default_route_id" uuid,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_dossier_category" PRIMARY KEY ("id"),
        CONSTRAINT "uq_dossier_category_code" UNIQUE ("code"),
        CONSTRAINT "fk_dossier_category_parent" FOREIGN KEY ("parent_id") REFERENCES "dossier_category"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_dossier_category_action" CHECK ("retention_action" IS NULL OR "retention_action" IN ('DESTROY','TRANSFER','REVIEW')),
        CONSTRAINT "ck_dossier_category_years" CHECK ("retention_years" IS NULL OR ("retention_years" BETWEEN 0 AND 200)),
        CONSTRAINT "ck_dossier_category_days" CHECK ("handling_working_days" IS NULL OR ("handling_working_days" BETWEEN 1 AND 365)),
        CONSTRAINT "ck_dossier_category_class" CHECK ("default_classification" IN ('OPEN','INTERNAL','CONFIDENTIAL','SECRET'))
      )`);

    await q.query(`ALTER TABLE "dossier" ADD COLUMN "category_id" uuid`);
    await q.query(`ALTER TABLE "dossier" ADD COLUMN "legal_hold" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "dossier" ADD COLUMN "retention_due_date" date`);
    await q.query(
      `ALTER TABLE "dossier" ADD COLUMN "retention_state" character varying(20) NOT NULL DEFAULT 'ACTIVE'`,
    );
    await q.query(`
      ALTER TABLE "dossier"
        ADD CONSTRAINT "fk_dossier_category" FOREIGN KEY ("category_id") REFERENCES "dossier_category"("id") ON DELETE RESTRICT,
        ADD CONSTRAINT "ck_dossier_retention_state"
          CHECK ("retention_state" IN ('ACTIVE','DUE','DESTROYED','TRANSFERRED','RETAINED'))`);

    // The closed-file guard, now also covering category and classification.
    await q.query(`
      CREATE OR REPLACE FUNCTION "guard_dossier_state"() RETURNS trigger AS $$
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
          OR NEW.due_date IS DISTINCT FROM OLD.due_date
          OR NEW.category_id IS DISTINCT FROM OLD.category_id
          OR NEW.classification IS DISTINCT FROM OLD.classification) THEN
          RAISE EXCEPTION 'dossier is closed; reopen it before changing it';
        END IF;

        -- A matter under legal hold keeps its retention state.
        IF OLD.legal_hold AND NEW.legal_hold AND NEW.retention_state IS DISTINCT FROM OLD.retention_state
           AND NEW.retention_state IN ('DESTROYED','TRANSFERRED') THEN
          RAISE EXCEPTION 'this matter is under legal hold; release the hold before a retention decision';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);

    await q.query(`
      CREATE TABLE "dossier_relation" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_id" uuid NOT NULL,
        "related_dossier_id" uuid NOT NULL,
        "relation" character varying(20) NOT NULL DEFAULT 'RELATED',
        "note" character varying(600),
        "created_by_account_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_dossier_relation" PRIMARY KEY ("id"),
        CONSTRAINT "uq_dossier_relation" UNIQUE ("dossier_id", "related_dossier_id"),
        CONSTRAINT "fk_dossier_relation_a" FOREIGN KEY ("dossier_id") REFERENCES "dossier"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_dossier_relation_b" FOREIGN KEY ("related_dossier_id") REFERENCES "dossier"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_dossier_relation_self" CHECK ("dossier_id" <> "related_dossier_id"),
        CONSTRAINT "ck_dossier_relation_kind" CHECK ("relation" IN ('RELATED','FOLLOW_UP','PRECEDES','SAME_SUBJECT'))
      )`);
    await q.query(`CREATE RULE "dossier_relation_no_update" AS ON UPDATE TO "dossier_relation" DO INSTEAD NOTHING`);
    await q.query(`CREATE RULE "dossier_relation_no_delete" AS ON DELETE TO "dossier_relation" DO INSTEAD NOTHING`);

    await q.query(`
      CREATE TABLE "retention_decision" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_id" uuid NOT NULL,
        "decision" character varying(12) NOT NULL,
        "reason" character varying(1000) NOT NULL,
        "extend_until" date,
        "decided_by_account_id" uuid NOT NULL,
        "decided_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_retention_decision" PRIMARY KEY ("id"),
        CONSTRAINT "fk_retention_decision_dossier" FOREIGN KEY ("dossier_id") REFERENCES "dossier"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_retention_decision" CHECK ("decision" IN ('DESTROY','TRANSFER','RETAIN','EXTEND')),
        CONSTRAINT "ck_retention_decision_reason" CHECK (char_length(btrim("reason")) > 0),
        CONSTRAINT "ck_retention_decision_extend" CHECK ("decision" <> 'EXTEND' OR "extend_until" IS NOT NULL)
      )`);
    await q.query(`
      CREATE TABLE "legal_hold_event" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_id" uuid NOT NULL,
        "action" character varying(10) NOT NULL,
        "reason" character varying(1000) NOT NULL,
        "actor_account_id" uuid NOT NULL,
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_legal_hold_event" PRIMARY KEY ("id"),
        CONSTRAINT "fk_legal_hold_event_dossier" FOREIGN KEY ("dossier_id") REFERENCES "dossier"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_legal_hold_event_action" CHECK ("action" IN ('SET','RELEASED')),
        CONSTRAINT "ck_legal_hold_event_reason" CHECK (char_length(btrim("reason")) > 0)
      )`);
    await q.query(`
      CREATE TABLE "archive_transfer" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_id" uuid NOT NULL,
        "package_hash" character varying(64) NOT NULL,
        "manifest" jsonb NOT NULL,
        "seal_id" uuid,
        "exported_by_account_id" uuid NOT NULL,
        "exported_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_archive_transfer" PRIMARY KEY ("id"),
        CONSTRAINT "fk_archive_transfer_dossier" FOREIGN KEY ("dossier_id") REFERENCES "dossier"("id") ON DELETE RESTRICT
      )`);
    for (const table of ['retention_decision', 'legal_hold_event', 'archive_transfer']) {
      await q.query(`CREATE RULE "${table}_no_update" AS ON UPDATE TO "${table}" DO INSTEAD NOTHING`);
      await q.query(`CREATE RULE "${table}_no_delete" AS ON DELETE TO "${table}" DO INSTEAD NOTHING`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of ['archive_transfer', 'legal_hold_event', 'retention_decision', 'dossier_relation']) {
      await q.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    await q.query(`
      ALTER TABLE "dossier"
        DROP CONSTRAINT IF EXISTS "ck_dossier_retention_state",
        DROP CONSTRAINT IF EXISTS "fk_dossier_category",
        DROP COLUMN IF EXISTS "retention_state",
        DROP COLUMN IF EXISTS "retention_due_date",
        DROP COLUMN IF EXISTS "legal_hold",
        DROP COLUMN IF EXISTS "category_id"`);
    await q.query(`DROP TABLE IF EXISTS "dossier_category"`);
  }
}
