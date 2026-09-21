import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.1.7 — captured documents.
 *
 * The table is append-only in the database, matching audit_event: an UPDATE or
 * DELETE reports success and changes nothing. Captured evidence is not
 * editable, and a correction is a new capture rather than a replacement.
 *
 * There is deliberately no unique constraint on content_hash. Two records may
 * legitimately carry the same document, and collapsing them would be the silent
 * merge FR-COR-016 forbids. The bytes are stored once because storage is
 * content-addressed; the associations stay separate.
 */
export class CapturedDocuments1758600000000 implements MigrationInterface {
  name = 'CapturedDocuments1758600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "captured_document" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "correspondence_item_id" uuid NOT NULL,
        "original_filename" character varying(400) NOT NULL,
        "media_type" character varying(120) NOT NULL,
        "byte_size" bigint NOT NULL,
        "content_hash" character varying(64) NOT NULL,
        "storage_key" character varying(200) NOT NULL,
        "captured_by_account_id" uuid NOT NULL,
        "captured_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_captured_document" PRIMARY KEY ("id"),
        CONSTRAINT "fk_captured_document_item" FOREIGN KEY ("correspondence_item_id")
          REFERENCES "correspondence_item"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_captured_document_captured_by" FOREIGN KEY ("captured_by_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_captured_document_hash" CHECK (char_length("content_hash") = 64),
        CONSTRAINT "ck_captured_document_size" CHECK ("byte_size" > 0)
      )`);

    await queryRunner.query(
      `CREATE INDEX "ix_captured_document_item"
         ON "captured_document" ("correspondence_item_id", "captured_at")`,
    );

    await queryRunner.query(
      `CREATE RULE "captured_document_no_update"
         AS ON UPDATE TO "captured_document" DO INSTEAD NOTHING`,
    );
    await queryRunner.query(
      `CREATE RULE "captured_document_no_delete"
         AS ON DELETE TO "captured_document" DO INSTEAD NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "captured_document"`);
  }
}
