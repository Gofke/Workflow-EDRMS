import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.3.0 — small additions the Phase 3 modules need on existing tables.
 *
 * 1. When a person last received their daily summary e-mail.
 * 2. A tracking reference printed for citizens is unique.
 * 3. Text derived for a scanned PDF records how it was read (text layer or
 *    page-image OCR), so nobody mistakes guessed text for extracted text.
 * 4. The account an integration (WijSamen, the mail gateway) acts as.
 */
export class Phase3Extras1760000000000 implements MigrationInterface {
  name = 'Phase3Extras1760000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "account_contact" ADD COLUMN "last_digest_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`CREATE UNIQUE INDEX "ix_item_tracking_code" ON "item_tracking" ("tracking_code")`);
    await q.query(`ALTER TABLE "document_text" ADD COLUMN "method" character varying(20)`);
    // 4. The account an integration acts as: what it registers is attributed to
    //    that person, with the integration named in the audit history.
    await q.query(`ALTER TABLE "integration_client" ADD COLUMN "act_as_account_id" uuid`);
    await q.query(`
      ALTER TABLE "integration_client" ADD CONSTRAINT "fk_integration_client_act_as"
        FOREIGN KEY ("act_as_account_id") REFERENCES "account"("id") ON DELETE RESTRICT`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "integration_client" DROP CONSTRAINT IF EXISTS "fk_integration_client_act_as"`);
    await q.query(`ALTER TABLE "integration_client" DROP COLUMN IF EXISTS "act_as_account_id"`);
    await q.query(`ALTER TABLE "document_text" DROP COLUMN IF EXISTS "method"`);
    await q.query(`DROP INDEX IF EXISTS "ix_item_tracking_code"`);
    await q.query(`ALTER TABLE "account_contact" DROP COLUMN IF EXISTS "last_digest_at"`);
  }
}
