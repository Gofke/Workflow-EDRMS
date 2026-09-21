import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.1.16 — derived text from captured documents (FR-COR-015).
 *
 * document_text is derived data, and the schema says so:
 *
 * - It is a separate table. The authoritative bytes and their integrity
 *   reference are untouched by anything here, so OCR cannot replace captured
 *   content — the failure FR-COR-015 exists to prevent.
 * - It carries the content hash it was read from. If that ever differs from
 *   the document's current hash, the text is stale and must not be trusted.
 * - One row per document, replaceable. Unlike an event, derived text is not
 *   evidence: a better engine may redo it, and nothing of record is lost.
 *   That is exactly why it must never be shown as the document itself.
 */
export class DocumentText1759200000000 implements MigrationInterface {
  name = 'DocumentText1759200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "document_text" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "captured_document_id" uuid NOT NULL,
        "content_hash" character varying(64) NOT NULL,
        "status" character varying(20) NOT NULL,
        "extracted_text" text,
        "engine" character varying(200),
        "languages" character varying(100),
        "extracted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_document_text" PRIMARY KEY ("id"),
        CONSTRAINT "uq_document_text_document" UNIQUE ("captured_document_id"),
        CONSTRAINT "fk_document_text_document" FOREIGN KEY ("captured_document_id")
          REFERENCES "captured_document"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_document_text_status"
          CHECK ("status" IN ('EXTRACTED','EMPTY','SKIPPED','FAILED')),
        -- Text exists only where something was read.
        CONSTRAINT "ck_document_text_has_text"
          CHECK ("status" <> 'EXTRACTED' OR ("extracted_text" IS NOT NULL
                 AND char_length("extracted_text") > 0))
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "document_text"`);
  }
}
