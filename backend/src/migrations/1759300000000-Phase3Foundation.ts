import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.3.0 — Phase 3 foundation.
 *
 * Everything later in Phase 3 stands on these tables:
 *
 * 1. system_setting — configuration an administrator may change from the
 *    screen instead of the server's environment file. Every change is audited.
 *    Values that are secrets (passwords, API keys) are never stored here.
 * 2. Organisational hierarchy — a unit may sit under another unit and may have
 *    a head. Escalation and department reporting need both.
 * 3. login_attempt — every sign-in attempt with its outcome, address and
 *    browser. Append-only. Drives lockout and the user's own login history.
 * 4. account_mfa — two-step verification (TOTP). The secret is stored
 *    encrypted, never in clear.
 * 5. Classification — OPEN, INTERNAL, CONFIDENTIAL, SECRET on dossiers and on
 *    correspondence items. Default INTERNAL, which is what every record was
 *    before this version, so nothing becomes visible or hidden by migrating.
 * 6. record_access_grant — explicit need-to-know grants. Revoked, never
 *    deleted.
 * 7. record_view_event — who opened which record and when. Append-only.
 * 8. A hash chain over audit_event — every row carries the SHA-256 of its own
 *    content and the previous row's hash, so removing or altering any row in
 *    the history, even by someone who can bypass the append-only rules, breaks
 *    the chain and is detected by the integrity check.
 *
 * The classification rules are provisional. DEC-02 (sensitivity and
 * need-to-know) is still open; the clearance per role lives in system_setting
 * so the Ministry's decision can be applied without a code change.
 */
export class Phase3Foundation1759300000000 implements MigrationInterface {
  name = 'Phase3Foundation1759300000000';

  public async up(q: QueryRunner): Promise<void> {
    // 1. Settings
    await q.query(`
      CREATE TABLE "system_setting" (
        "key" character varying(120) NOT NULL,
        "value" jsonb NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by_account_id" uuid,
        CONSTRAINT "pk_system_setting" PRIMARY KEY ("key")
      )`);

    // 2. Organisational hierarchy
    await q.query(`ALTER TABLE "organisational_unit" ADD COLUMN "parent_unit_id" uuid`);
    await q.query(`ALTER TABLE "organisational_unit" ADD COLUMN "head_account_id" uuid`);
    await q.query(
      `ALTER TABLE "organisational_unit" ADD COLUMN "kind" character varying(30) NOT NULL DEFAULT 'DEPARTMENT'`,
    );
    await q.query(
      `ALTER TABLE "organisational_unit" ADD COLUMN "is_active" boolean NOT NULL DEFAULT true`,
    );
    await q.query(`
      ALTER TABLE "organisational_unit"
        ADD CONSTRAINT "fk_unit_parent" FOREIGN KEY ("parent_unit_id")
          REFERENCES "organisational_unit"("id") ON DELETE RESTRICT,
        ADD CONSTRAINT "fk_unit_head" FOREIGN KEY ("head_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        ADD CONSTRAINT "ck_unit_not_own_parent" CHECK ("parent_unit_id" IS NULL OR "parent_unit_id" <> "id"),
        ADD CONSTRAINT "ck_unit_kind" CHECK ("kind" IN ('CABINET','DIRECTORATE','DEPARTMENT','DISTRICT','OFFICE','SERVICE'))`);

    // 3. Login attempts
    await q.query(`
      CREATE TABLE "login_attempt" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "email_tried" character varying(320) NOT NULL,
        "account_id" uuid,
        "succeeded" boolean NOT NULL,
        "reason" character varying(60),
        "ip_address" character varying(80),
        "user_agent" character varying(400),
        CONSTRAINT "pk_login_attempt" PRIMARY KEY ("id")
      )`);
    await q.query(
      `CREATE INDEX "ix_login_attempt_email" ON "login_attempt" (lower("email_tried"), "occurred_at")`,
    );
    await q.query(`CREATE INDEX "ix_login_attempt_account" ON "login_attempt" ("account_id", "occurred_at")`);
    await q.query(`CREATE RULE "login_attempt_no_update" AS ON UPDATE TO "login_attempt" DO INSTEAD NOTHING`);
    await q.query(`CREATE RULE "login_attempt_no_delete" AS ON DELETE TO "login_attempt" DO INSTEAD NOTHING`);

    // 4. Two-step verification
    await q.query(`
      CREATE TABLE "account_mfa" (
        "account_id" uuid NOT NULL,
        "secret_encrypted" character varying(400) NOT NULL,
        "enabled_at" TIMESTAMP WITH TIME ZONE,
        "last_used_step" bigint,
        "recovery_code_hashes" jsonb NOT NULL DEFAULT '[]',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_account_mfa" PRIMARY KEY ("account_id"),
        CONSTRAINT "fk_account_mfa_account" FOREIGN KEY ("account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT
      )`);

    // 5. Classification
    for (const table of ['dossier', 'correspondence_item']) {
      await q.query(
        `ALTER TABLE "${table}" ADD COLUMN "classification" character varying(20) NOT NULL DEFAULT 'INTERNAL'`,
      );
      await q.query(`
        ALTER TABLE "${table}" ADD CONSTRAINT "ck_${table}_classification"
          CHECK ("classification" IN ('OPEN','INTERNAL','CONFIDENTIAL','SECRET'))`);
    }
    await q.query(`
      CREATE TABLE "classification_change" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "subject_type" character varying(20) NOT NULL,
        "subject_id" uuid NOT NULL,
        "previous_level" character varying(20) NOT NULL,
        "new_level" character varying(20) NOT NULL,
        "reason" character varying(600) NOT NULL,
        "changed_by_account_id" uuid NOT NULL,
        "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_classification_change" PRIMARY KEY ("id"),
        CONSTRAINT "ck_classification_change_type" CHECK ("subject_type" IN ('DOSSIER','ITEM')),
        CONSTRAINT "ck_classification_change_reason" CHECK (char_length("reason") > 0)
      )`);
    await q.query(`CREATE RULE "classification_change_no_update" AS ON UPDATE TO "classification_change" DO INSTEAD NOTHING`);
    await q.query(`CREATE RULE "classification_change_no_delete" AS ON DELETE TO "classification_change" DO INSTEAD NOTHING`);

    // 6. Need-to-know grants
    await q.query(`
      CREATE TABLE "record_access_grant" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "subject_type" character varying(20) NOT NULL,
        "subject_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "reason" character varying(600) NOT NULL,
        "granted_by_account_id" uuid NOT NULL,
        "granted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "revoked_by_account_id" uuid,
        CONSTRAINT "pk_record_access_grant" PRIMARY KEY ("id"),
        CONSTRAINT "fk_grant_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_grant_subject_type" CHECK ("subject_type" IN ('DOSSIER','ITEM'))
      )`);
    await q.query(
      `CREATE INDEX "ix_grant_subject" ON "record_access_grant" ("subject_type", "subject_id") WHERE "revoked_at" IS NULL`,
    );
    await q.query(
      `CREATE INDEX "ix_grant_account" ON "record_access_grant" ("account_id") WHERE "revoked_at" IS NULL`,
    );

    // 7. View log
    await q.query(`
      CREATE TABLE "record_view_event" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "account_id" uuid NOT NULL,
        "subject_type" character varying(20) NOT NULL,
        "subject_id" uuid NOT NULL,
        "subject_label" character varying(260),
        "view_kind" character varying(30) NOT NULL DEFAULT 'OPENED',
        CONSTRAINT "pk_record_view_event" PRIMARY KEY ("id")
      )`);
    await q.query(
      `CREATE INDEX "ix_record_view_subject" ON "record_view_event" ("subject_type", "subject_id", "occurred_at")`,
    );
    await q.query(`CREATE RULE "record_view_event_no_update" AS ON UPDATE TO "record_view_event" DO INSTEAD NOTHING`);
    await q.query(`CREATE RULE "record_view_event_no_delete" AS ON DELETE TO "record_view_event" DO INSTEAD NOTHING`);

    // 8. Hash chain over the audit history.
    // The append-only rules would turn the backfill UPDATE into a no-op, so
    // they are lifted for the duration of this migration only and restored
    // before it ends. The migration runs in one transaction.
    await q.query(`DROP RULE "audit_event_no_update" ON "audit_event"`);
    await q.query(`ALTER TABLE "audit_event" ADD COLUMN "seq" bigserial`);
    await q.query(`ALTER TABLE "audit_event" ADD COLUMN "chain_hash" character varying(64)`);
    await q.query(`CREATE UNIQUE INDEX "ix_audit_event_seq" ON "audit_event" ("seq")`);
    await q.query(`
      CREATE FUNCTION "audit_event_payload"(e audit_event) RETURNS text AS $$
        SELECT concat_ws('|',
          e.id::text,
          to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
          e.event_type,
          coalesce(e.actor_account_id::text, ''),
          e.actor_description,
          coalesce(e.represented_authority, ''),
          coalesce(e.subject_description, ''),
          coalesce(e.previous_value, ''),
          coalesce(e.new_value, ''),
          e.summary)
      $$ LANGUAGE sql IMMUTABLE`);
    // Backfill the chain for history that already exists, in order.
    await q.query(`
      DO $$
      DECLARE
        r audit_event;
        prev text := '';
      BEGIN
        FOR r IN SELECT * FROM audit_event ORDER BY seq LOOP
          prev := encode(sha256(convert_to(prev || '#' || audit_event_payload(r), 'UTF8')), 'hex');
          UPDATE audit_event SET chain_hash = prev WHERE id = r.id;
        END LOOP;
      END $$`);
    await q.query(`
      CREATE FUNCTION "audit_event_chain"() RETURNS trigger AS $$
      DECLARE
        prev text;
      BEGIN
        -- Serialise writers so two events cannot both chain onto the same row.
        PERFORM pg_advisory_xact_lock(hashtext('audit_event_chain'));
        SELECT chain_hash INTO prev FROM audit_event ORDER BY seq DESC LIMIT 1;
        NEW.chain_hash := encode(
          sha256(convert_to(coalesce(prev, '') || '#' || audit_event_payload(NEW), 'UTF8')), 'hex');
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE TRIGGER "trg_audit_event_chain"
        BEFORE INSERT ON "audit_event"
        FOR EACH ROW EXECUTE FUNCTION "audit_event_chain"()`);
    await q.query(
      `CREATE RULE "audit_event_no_update" AS ON UPDATE TO "audit_event" DO INSTEAD NOTHING`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS "trg_audit_event_chain" ON "audit_event"`);
    await q.query(`DROP FUNCTION IF EXISTS "audit_event_chain"()`);
    await q.query(`DROP FUNCTION IF EXISTS "audit_event_payload"(audit_event)`);
    await q.query(`DROP RULE IF EXISTS "audit_event_no_update" ON "audit_event"`);
    await q.query(`ALTER TABLE "audit_event" DROP COLUMN IF EXISTS "chain_hash"`);
    await q.query(`ALTER TABLE "audit_event" DROP COLUMN IF EXISTS "seq"`);
    await q.query(`CREATE RULE "audit_event_no_update" AS ON UPDATE TO "audit_event" DO INSTEAD NOTHING`);
    await q.query(`DROP TABLE IF EXISTS "record_view_event"`);
    await q.query(`DROP TABLE IF EXISTS "record_access_grant"`);
    await q.query(`DROP TABLE IF EXISTS "classification_change"`);
    for (const table of ['dossier', 'correspondence_item']) {
      await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "ck_${table}_classification"`);
      await q.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "classification"`);
    }
    await q.query(`DROP TABLE IF EXISTS "account_mfa"`);
    await q.query(`DROP TABLE IF EXISTS "login_attempt"`);
    await q.query(`
      ALTER TABLE "organisational_unit"
        DROP CONSTRAINT IF EXISTS "ck_unit_kind",
        DROP CONSTRAINT IF EXISTS "ck_unit_not_own_parent",
        DROP CONSTRAINT IF EXISTS "fk_unit_head",
        DROP CONSTRAINT IF EXISTS "fk_unit_parent",
        DROP COLUMN IF EXISTS "is_active",
        DROP COLUMN IF EXISTS "kind",
        DROP COLUMN IF EXISTS "head_account_id",
        DROP COLUMN IF EXISTS "parent_unit_id"`);
    await q.query(`DROP TABLE IF EXISTS "system_setting"`);
  }
}
