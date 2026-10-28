import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.3.0 — approval routes, advice, stand-ins and the system seal.
 *
 * 1. approval_route — an ordered list of review steps, e.g. Onder-Directeur,
 *    then Directeur, then Minister. When a matter goes along a route, each
 *    intermediate approval is recorded in route_step_decision (append-only) and
 *    the matter is passed to the next reviewer as a new submission, so the
 *    Delivery 1 rules still hold at every step: the reviewer is designated,
 *    what is approved is what was reviewed, and only the last step's decision
 *    makes the matter Approved.
 * 2. advice_request — a question to another department or person while the
 *    matter is being prepared. Several may run at the same time.
 * 3. out_of_office — an absence with a stand-in. Notifications reach the
 *    stand-in too; where the absent person may delegate, a time-bound
 *    delegation is created for the period through the Delivery 1 mechanism.
 * 4. document_seal and seal_key — a tamper-evident seal: an Ed25519 signature
 *    over the document's SHA-256 and its approval facts. Anyone can check a
 *    seal against the published public key. This is a system seal, not a
 *    qualified electronic signature under any statute.
 */
export class Approvals1759800000000 implements MigrationInterface {
  name = 'Approvals1759800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "approval_route" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(200) NOT NULL,
        "description" character varying(1000) NOT NULL DEFAULT '',
        "steps" jsonb NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_by_account_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_approval_route" PRIMARY KEY ("id"),
        CONSTRAINT "ck_approval_route_steps" CHECK (jsonb_typeof("steps") = 'array' AND jsonb_array_length("steps") BETWEEN 1 AND 6)
      )`);
    await q.query(`
      ALTER TABLE "dossier_category" ADD CONSTRAINT "fk_dossier_category_route"
        FOREIGN KEY ("default_route_id") REFERENCES "approval_route"("id") ON DELETE RESTRICT`);
    await q.query(`
      CREATE TABLE "dossier_route" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_id" uuid NOT NULL,
        "route_id" uuid NOT NULL,
        "route_name" character varying(200) NOT NULL,
        "steps" jsonb NOT NULL,
        "current_step" integer NOT NULL DEFAULT 0,
        "started_by_account_id" uuid NOT NULL,
        "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "ended_reason" character varying(60),
        CONSTRAINT "pk_dossier_route" PRIMARY KEY ("id"),
        CONSTRAINT "fk_dossier_route_dossier" FOREIGN KEY ("dossier_id") REFERENCES "dossier"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_dossier_route_route" FOREIGN KEY ("route_id") REFERENCES "approval_route"("id") ON DELETE RESTRICT
      )`);
    await q.query(
      `CREATE UNIQUE INDEX "ix_dossier_route_active" ON "dossier_route" ("dossier_id") WHERE "completed_at" IS NULL`,
    );
    await q.query(`
      CREATE TABLE "route_step_decision" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_route_id" uuid NOT NULL,
        "dossier_id" uuid NOT NULL,
        "step_index" integer NOT NULL,
        "step_label" character varying(200) NOT NULL,
        "decision" character varying(12) NOT NULL,
        "actor_account_id" uuid NOT NULL,
        "next_reviewer_account_id" uuid,
        "reviewed_version" integer NOT NULL,
        "note" character varying(1000),
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_route_step_decision" PRIMARY KEY ("id"),
        CONSTRAINT "fk_route_step_decision_route" FOREIGN KEY ("dossier_route_id") REFERENCES "dossier_route"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_route_step_decision" CHECK ("decision" IN ('APPROVED','RETURNED','FINAL'))
      )`);
    await q.query(`CREATE RULE "route_step_decision_no_update" AS ON UPDATE TO "route_step_decision" DO INSTEAD NOTHING`);
    await q.query(`CREATE RULE "route_step_decision_no_delete" AS ON DELETE TO "route_step_decision" DO INSTEAD NOTHING`);

    await q.query(`
      CREATE TABLE "advice_request" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_id" uuid NOT NULL,
        "requested_from_account_id" uuid NOT NULL,
        "requested_from_unit_id" uuid,
        "question" character varying(2000) NOT NULL,
        "due_date" date,
        "status" character varying(12) NOT NULL DEFAULT 'OPEN',
        "requested_by_account_id" uuid NOT NULL,
        "requested_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "answer" character varying(8000),
        "answered_by_account_id" uuid,
        "answered_at" TIMESTAMP WITH TIME ZONE,
        "withdrawn_reason" character varying(600),
        CONSTRAINT "pk_advice_request" PRIMARY KEY ("id"),
        CONSTRAINT "fk_advice_request_dossier" FOREIGN KEY ("dossier_id") REFERENCES "dossier"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_advice_request_from" FOREIGN KEY ("requested_from_account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_advice_request_status" CHECK ("status" IN ('OPEN','ANSWERED','WITHDRAWN')),
        CONSTRAINT "ck_advice_request_answer" CHECK ("status" <> 'ANSWERED' OR ("answer" IS NOT NULL AND char_length(btrim("answer")) > 0)),
        CONSTRAINT "ck_advice_request_question" CHECK (char_length(btrim("question")) > 0)
      )`);
    await q.query(`CREATE INDEX "ix_advice_request_dossier" ON "advice_request" ("dossier_id")`);
    await q.query(`CREATE INDEX "ix_advice_request_from" ON "advice_request" ("requested_from_account_id", "status")`);
    await q.query(`CREATE RULE "advice_request_no_delete" AS ON DELETE TO "advice_request" DO INSTEAD NOTHING`);
    await q.query(`
      CREATE FUNCTION "protect_answered_advice"() RETURNS trigger AS $$
      BEGIN
        IF OLD.status <> 'OPEN' THEN
          RAISE EXCEPTION 'an answered or withdrawn advice request cannot be changed';
        END IF;
        IF NEW.question IS DISTINCT FROM OLD.question OR NEW.dossier_id IS DISTINCT FROM OLD.dossier_id
           OR NEW.requested_from_account_id IS DISTINCT FROM OLD.requested_from_account_id THEN
          RAISE EXCEPTION 'the question of an advice request cannot be rewritten';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER "trg_protect_answered_advice"
        BEFORE UPDATE ON "advice_request"
        FOR EACH ROW EXECUTE FUNCTION "protect_answered_advice"()`);
    await q.query(`
      CREATE TRIGGER "trg_advice_request_closed_dossier"
        BEFORE INSERT ON "advice_request"
        FOR EACH ROW EXECUTE FUNCTION "refuse_if_dossier_closed"()`);

    await q.query(`
      CREATE TABLE "out_of_office" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "account_id" uuid NOT NULL,
        "starts_on" date NOT NULL,
        "ends_on" date NOT NULL,
        "stand_in_account_id" uuid NOT NULL,
        "message" character varying(600) NOT NULL DEFAULT '',
        "delegation_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "ended_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_out_of_office" PRIMARY KEY ("id"),
        CONSTRAINT "fk_out_of_office_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_out_of_office_stand_in" FOREIGN KEY ("stand_in_account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_out_of_office_period" CHECK ("ends_on" >= "starts_on"),
        CONSTRAINT "ck_out_of_office_self" CHECK ("account_id" <> "stand_in_account_id")
      )`);
    await q.query(`CREATE INDEX "ix_out_of_office_account" ON "out_of_office" ("account_id", "starts_on")`);

    await q.query(`
      CREATE TABLE "seal_key" (
        "key_id" character varying(40) NOT NULL,
        "public_key_pem" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "retired_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_seal_key" PRIMARY KEY ("key_id")
      )`);
    await q.query(`
      CREATE TABLE "document_seal" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "subject_type" character varying(20) NOT NULL,
        "subject_id" uuid NOT NULL,
        "payload" jsonb NOT NULL,
        "payload_hash" character varying(64) NOT NULL,
        "signature" character varying(200) NOT NULL,
        "key_id" character varying(40) NOT NULL,
        "sealed_by_account_id" uuid NOT NULL,
        "sealed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_document_seal" PRIMARY KEY ("id"),
        CONSTRAINT "fk_document_seal_key" FOREIGN KEY ("key_id") REFERENCES "seal_key"("key_id") ON DELETE RESTRICT,
        CONSTRAINT "ck_document_seal_type" CHECK ("subject_type" IN ('DOCUMENT','DOSSIER','PACKAGE'))
      )`);
    await q.query(`CREATE INDEX "ix_document_seal_subject" ON "document_seal" ("subject_type", "subject_id")`);
    await q.query(`CREATE RULE "document_seal_no_update" AS ON UPDATE TO "document_seal" DO INSTEAD NOTHING`);
    await q.query(`CREATE RULE "document_seal_no_delete" AS ON DELETE TO "document_seal" DO INSTEAD NOTHING`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "document_seal"`);
    await q.query(`DROP TABLE IF EXISTS "seal_key"`);
    await q.query(`DROP TABLE IF EXISTS "out_of_office"`);
    await q.query(`DROP TRIGGER IF EXISTS "trg_advice_request_closed_dossier" ON "advice_request"`);
    await q.query(`DROP TRIGGER IF EXISTS "trg_protect_answered_advice" ON "advice_request"`);
    await q.query(`DROP FUNCTION IF EXISTS "protect_answered_advice"()`);
    await q.query(`DROP TABLE IF EXISTS "advice_request"`);
    await q.query(`DROP TABLE IF EXISTS "route_step_decision"`);
    await q.query(`DROP TABLE IF EXISTS "dossier_route"`);
    await q.query(`ALTER TABLE "dossier_category" DROP CONSTRAINT IF EXISTS "fk_dossier_category_route"`);
    await q.query(`DROP TABLE IF EXISTS "approval_route"`);
  }
}
