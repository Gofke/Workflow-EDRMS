import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.3.0 — letters, documents and intake.
 *
 * 1. Intake metadata on a correspondence item: where it came from (typed in,
 *    e-mail, WijSamen, another ministry, the phone camera), the sender's own
 *    reference, and the reply date the sender asked for. None of these are
 *    the registration identity, which stays the server's (BR-001).
 * 2. item_draft_version — the successive texts of a reply being written.
 *    Append-only: version 2 never overwrites version 1, so what was approved
 *    can always be compared with what came before.
 * 3. letter_template — standard letters with the ministry letterhead.
 * 4. item_tracking — the code printed on a receipt so a citizen can look up the
 *    status of their letter, and tracking_lookup, every lookup attempt, which
 *    is also what rate-limits guessing.
 * 5. email_intake — one row per e-mail taken in, keyed on its Message-ID, so
 *    the same e-mail forwarded twice is registered once.
 * 6. document_scan — the outcome of the malware check on every upload.
 */
export class Letters1759600000000 implements MigrationInterface {
  name = 'Letters1759600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "correspondence_item" ADD COLUMN "source" character varying(20) NOT NULL DEFAULT 'MANUAL'`,
    );
    await q.query(`
      ALTER TABLE "correspondence_item" ADD CONSTRAINT "ck_correspondence_item_source"
        CHECK ("source" IN ('MANUAL','EMAIL','WIJSAMEN','EXCHANGE','MOBILE','COMPOSED'))`);
    await q.query(`ALTER TABLE "correspondence_item" ADD COLUMN "sender_reference" character varying(120)`);
    await q.query(`ALTER TABLE "correspondence_item" ADD COLUMN "reply_requested_by" date`);
    await q.query(`ALTER TABLE "correspondence_item" ADD COLUMN "in_reply_to_item_id" uuid`);
    await q.query(`
      ALTER TABLE "correspondence_item" ADD CONSTRAINT "fk_correspondence_item_reply_to"
        FOREIGN KEY ("in_reply_to_item_id") REFERENCES "correspondence_item"("id") ON DELETE RESTRICT`);

    await q.query(`
      CREATE TABLE "item_draft_version" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "item_id" uuid NOT NULL,
        "version_no" integer NOT NULL,
        "body" text NOT NULL,
        "note" character varying(300),
        "template_id" uuid,
        "created_by_account_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "ai_interaction_id" uuid,
        CONSTRAINT "pk_item_draft_version" PRIMARY KEY ("id"),
        CONSTRAINT "uq_item_draft_version" UNIQUE ("item_id", "version_no"),
        CONSTRAINT "fk_item_draft_version_item" FOREIGN KEY ("item_id") REFERENCES "correspondence_item"("id") ON DELETE RESTRICT
      )`);
    await q.query(`CREATE RULE "item_draft_version_no_update" AS ON UPDATE TO "item_draft_version" DO INSTEAD NOTHING`);
    await q.query(`CREATE RULE "item_draft_version_no_delete" AS ON DELETE TO "item_draft_version" DO INSTEAD NOTHING`);

    await q.query(`
      CREATE TABLE "letter_template" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "code" character varying(40) NOT NULL,
        "name" character varying(200) NOT NULL,
        "language" character varying(2) NOT NULL DEFAULT 'nl',
        "body" text NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_by_account_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_letter_template" PRIMARY KEY ("id"),
        CONSTRAINT "uq_letter_template_code" UNIQUE ("code")
      )`);

    await q.query(`
      CREATE TABLE "item_tracking" (
        "item_id" uuid NOT NULL,
        "tracking_code" character varying(16) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_item_tracking" PRIMARY KEY ("item_id"),
        CONSTRAINT "fk_item_tracking_item" FOREIGN KEY ("item_id") REFERENCES "correspondence_item"("id") ON DELETE RESTRICT
      )`);
    await q.query(`
      CREATE TABLE "tracking_lookup" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "reference_tried" character varying(80) NOT NULL,
        "succeeded" boolean NOT NULL,
        "ip_address" character varying(80),
        CONSTRAINT "pk_tracking_lookup" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_tracking_lookup_ip" ON "tracking_lookup" ("ip_address", "occurred_at")`);
    await q.query(`CREATE RULE "tracking_lookup_no_update" AS ON UPDATE TO "tracking_lookup" DO INSTEAD NOTHING`);
    await q.query(`CREATE RULE "tracking_lookup_no_delete" AS ON DELETE TO "tracking_lookup" DO INSTEAD NOTHING`);

    await q.query(`
      CREATE TABLE "email_intake" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "message_id" character varying(400) NOT NULL,
        "from_address" character varying(400),
        "subject" character varying(600),
        "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "item_id" uuid NOT NULL,
        "raw_hash" character varying(64) NOT NULL,
        "channel" character varying(20) NOT NULL DEFAULT 'UPLOAD',
        CONSTRAINT "pk_email_intake" PRIMARY KEY ("id"),
        CONSTRAINT "uq_email_intake_message" UNIQUE ("message_id"),
        CONSTRAINT "fk_email_intake_item" FOREIGN KEY ("item_id") REFERENCES "correspondence_item"("id") ON DELETE RESTRICT
      )`);

    await q.query(`
      CREATE TABLE "document_scan" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "content_hash" character varying(64) NOT NULL,
        "scanner" character varying(120) NOT NULL,
        "result" character varying(12) NOT NULL,
        "signature" character varying(200),
        "filename" character varying(400),
        "account_id" uuid,
        "scanned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_document_scan" PRIMARY KEY ("id"),
        CONSTRAINT "ck_document_scan_result" CHECK ("result" IN ('CLEAN','INFECTED','ERROR'))
      )`);
    await q.query(`CREATE INDEX "ix_document_scan_hash" ON "document_scan" ("content_hash")`);
    await q.query(`CREATE RULE "document_scan_no_update" AS ON UPDATE TO "document_scan" DO INSTEAD NOTHING`);
    await q.query(`CREATE RULE "document_scan_no_delete" AS ON DELETE TO "document_scan" DO INSTEAD NOTHING`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of ['document_scan', 'email_intake', 'tracking_lookup', 'item_tracking', 'letter_template', 'item_draft_version']) {
      await q.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    await q.query(`ALTER TABLE "correspondence_item" DROP CONSTRAINT IF EXISTS "fk_correspondence_item_reply_to"`);
    await q.query(`ALTER TABLE "correspondence_item" DROP CONSTRAINT IF EXISTS "ck_correspondence_item_source"`);
    for (const col of ['in_reply_to_item_id', 'reply_requested_by', 'sender_reference', 'source']) {
      await q.query(`ALTER TABLE "correspondence_item" DROP COLUMN IF EXISTS "${col}"`);
    }
  }
}
