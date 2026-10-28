import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.3.0 — search, the AI assistant, integrations and the integrity record.
 *
 * Search uses PostgreSQL's own full-text search with the Dutch dictionary, so
 * "verzoeken" finds "verzoek". Indexes only: nothing is copied out of the
 * records to make them searchable.
 *
 * Every AI answer or suggestion is kept in ai_interaction, and whether a person
 * accepted, changed or rejected it in ai_feedback. Both are append-only. The
 * chat history is private to the person who had the conversation.
 *
 * integration_client keys are stored only as a hash. The key itself is shown
 * once, when it is created.
 *
 * integrity_anchor records each integrity check: the position and hash of the
 * newest audit event at the time, so a later check can prove that nothing was
 * removed from the end of the history either.
 */
export class SearchAiIntegrations1759900000000 implements MigrationInterface {
  name = 'SearchAiIntegrations1759900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE INDEX "ix_correspondence_item_fts" ON "correspondence_item"
        USING gin (to_tsvector('dutch', coalesce("subject", '') || ' ' || coalesce("party", '') || ' ' || coalesce("registration_identity", '') || ' ' || coalesce("sender_reference", '')))`);
    await q.query(`
      CREATE INDEX "ix_document_text_fts" ON "document_text"
        USING gin (to_tsvector('dutch', coalesce("extracted_text", '')))`);
    await q.query(`
      CREATE INDEX "ix_dossier_fts" ON "dossier"
        USING gin (to_tsvector('dutch', coalesce("subject", '') || ' ' || coalesce("dossier_identity", '')))`);
    await q.query(`
      CREATE INDEX "ix_task_fts" ON "task"
        USING gin (to_tsvector('dutch', coalesce("title", '') || ' ' || coalesce("description", '') || ' ' || coalesce("reference", '')))`);
    await q.query(`
      CREATE TABLE "saved_search" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "account_id" uuid NOT NULL,
        "name" character varying(120) NOT NULL,
        "query" jsonb NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_saved_search" PRIMARY KEY ("id"),
        CONSTRAINT "fk_saved_search_account" FOREIGN KEY ("account_id") REFERENCES "account"("id") ON DELETE RESTRICT
      )`);

    await q.query(`
      CREATE TABLE "ai_interaction" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "feature" character varying(30) NOT NULL,
        "account_id" uuid NOT NULL,
        "subject_type" character varying(20),
        "subject_id" uuid,
        "provider" character varying(30) NOT NULL,
        "model" character varying(120) NOT NULL,
        "prompt_summary" character varying(600) NOT NULL,
        "output" jsonb NOT NULL,
        "latency_ms" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_ai_interaction" PRIMARY KEY ("id")
      )`);
    await q.query(`CREATE INDEX "ix_ai_interaction_account" ON "ai_interaction" ("account_id", "created_at" DESC)`);
    await q.query(`
      CREATE TABLE "ai_feedback" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "interaction_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "outcome" character varying(12) NOT NULL,
        "note" character varying(600),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_ai_feedback" PRIMARY KEY ("id"),
        CONSTRAINT "fk_ai_feedback_interaction" FOREIGN KEY ("interaction_id") REFERENCES "ai_interaction"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_ai_feedback_outcome" CHECK ("outcome" IN ('ACCEPTED','EDITED','REJECTED'))
      )`);
    await q.query(`
      CREATE TABLE "chat_message" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "conversation_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "role" character varying(10) NOT NULL,
        "content" text NOT NULL,
        "payload" jsonb,
        "interaction_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_chat_message" PRIMARY KEY ("id"),
        CONSTRAINT "ck_chat_message_role" CHECK ("role" IN ('user','assistant'))
      )`);
    await q.query(`CREATE INDEX "ix_chat_message_conversation" ON "chat_message" ("account_id", "conversation_id", "created_at")`);
    for (const table of ['ai_interaction', 'ai_feedback', 'chat_message']) {
      await q.query(`CREATE RULE "${table}_no_update" AS ON UPDATE TO "${table}" DO INSTEAD NOTHING`);
      await q.query(`CREATE RULE "${table}_no_delete" AS ON DELETE TO "${table}" DO INSTEAD NOTHING`);
    }

    await q.query(`
      CREATE TABLE "integration_client" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(200) NOT NULL,
        "kind" character varying(20) NOT NULL,
        "key_prefix" character varying(16) NOT NULL,
        "key_hash" character varying(200) NOT NULL,
        "created_by_account_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "last_used_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_integration_client" PRIMARY KEY ("id"),
        CONSTRAINT "uq_integration_client_prefix" UNIQUE ("key_prefix"),
        CONSTRAINT "ck_integration_client_kind" CHECK ("kind" IN ('WIJSAMEN','MAIL_GATEWAY'))
      )`);
    await q.query(`
      CREATE TABLE "integration_receipt" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "client_id" uuid NOT NULL,
        "external_reference" character varying(120) NOT NULL,
        "item_id" uuid NOT NULL,
        "payload_hash" character varying(64) NOT NULL,
        "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_integration_receipt" PRIMARY KEY ("id"),
        CONSTRAINT "uq_integration_receipt" UNIQUE ("client_id", "external_reference"),
        CONSTRAINT "fk_integration_receipt_client" FOREIGN KEY ("client_id") REFERENCES "integration_client"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_integration_receipt_item" FOREIGN KEY ("item_id") REFERENCES "correspondence_item"("id") ON DELETE RESTRICT
      )`);
    await q.query(`
      CREATE TABLE "exchange_partner" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "code" character varying(40) NOT NULL,
        "name" character varying(200) NOT NULL,
        "public_key_pem" text NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_exchange_partner" PRIMARY KEY ("id"),
        CONSTRAINT "uq_exchange_partner_code" UNIQUE ("code")
      )`);
    await q.query(`
      CREATE TABLE "exchange_log" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "direction" character varying(10) NOT NULL,
        "partner_code" character varying(40) NOT NULL,
        "dossier_id" uuid,
        "item_id" uuid,
        "package_hash" character varying(64) NOT NULL,
        "manifest" jsonb NOT NULL,
        "actor_account_id" uuid NOT NULL,
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_exchange_log" PRIMARY KEY ("id"),
        CONSTRAINT "ck_exchange_log_direction" CHECK ("direction" IN ('EXPORTED','IMPORTED'))
      )`);
    await q.query(`
      CREATE UNIQUE INDEX "ix_exchange_log_import_once" ON "exchange_log" ("package_hash") WHERE "direction" = 'IMPORTED'`);
    await q.query(`
      CREATE TABLE "integrity_anchor" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "audit_seq" bigint,
        "audit_hash" character varying(64),
        "audit_events_checked" integer NOT NULL,
        "audit_chain_ok" boolean NOT NULL,
        "documents_checked" integer NOT NULL,
        "documents_failed" integer NOT NULL,
        "anchors_ok" boolean NOT NULL,
        "details" jsonb NOT NULL DEFAULT '[]',
        "run_by_account_id" uuid,
        "run_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_integrity_anchor" PRIMARY KEY ("id")
      )`);
    for (const table of ['integration_receipt', 'exchange_log', 'integrity_anchor']) {
      await q.query(`CREATE RULE "${table}_no_update" AS ON UPDATE TO "${table}" DO INSTEAD NOTHING`);
      await q.query(`CREATE RULE "${table}_no_delete" AS ON DELETE TO "${table}" DO INSTEAD NOTHING`);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const table of ['integrity_anchor', 'exchange_log', 'exchange_partner', 'integration_receipt', 'integration_client', 'chat_message', 'ai_feedback', 'ai_interaction', 'saved_search']) {
      await q.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    for (const index of ['ix_task_fts', 'ix_dossier_fts', 'ix_document_text_fts', 'ix_correspondence_item_fts']) {
      await q.query(`DROP INDEX IF EXISTS "${index}"`);
    }
  }
}
