import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.3.0 — small additions the Phase 3 modules need on existing tables.
 *
 * 1. When a person last received their daily summary e-mail.
 * 2. A tracking reference printed for citizens is unique.
 * 3. Text derived for a scanned PDF records how it was read (text layer or
 *    page-image OCR), so nobody mistakes guessed text for extracted text.
 */
export class Phase3Extras1760000000000 implements MigrationInterface {
  name = 'Phase3Extras1760000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "account_contact" ADD COLUMN "last_digest_at" TIMESTAMP WITH TIME ZONE`);
    await q.query(`CREATE UNIQUE INDEX "ix_item_tracking_code" ON "item_tracking" ("tracking_code")`);
    await q.query(`ALTER TABLE "document_text" ADD COLUMN "method" character varying(20)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "document_text" DROP COLUMN IF EXISTS "method"`);
    await q.query(`DROP INDEX IF EXISTS "ix_item_tracking_code"`);
    await q.query(`ALTER TABLE "account_contact" DROP COLUMN IF EXISTS "last_digest_at"`);
  }
}
