import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.1.15 — lookup indexes for the duplicate warning (FR-COR-016).
 *
 * Indexes only. No constraint is added: two records may legitimately carry the
 * same document or the same subject, and preventing it would be the silent
 * merge FR-COR-016 forbids by another route. The warning is advisory.
 */
export class DuplicateLookup1759100000000 implements MigrationInterface {
  name = 'DuplicateLookup1759100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "ix_captured_document_hash" ON "captured_document" ("content_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_correspondence_item_subject_norm"
         ON "correspondence_item" (lower(btrim("subject")))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_correspondence_item_subject_norm"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_captured_document_hash"`);
  }
}
