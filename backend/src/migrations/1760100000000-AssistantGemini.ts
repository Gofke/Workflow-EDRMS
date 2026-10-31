import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.4.0 — the assistant panel with a language model and tools.
 *
 * 1. A sub-directorate (onderdirectoraat) is a kind of unit, so the ministry's
 *    line of command — Minister, directorates, sub-directorates, departments —
 *    can be recorded as it is.
 * 2. Each assistant question records its outcome (the same reason codes as the
 *    API), the tools it used and the tokens it cost, for the audit page and for
 *    the hourly limit. The question text itself is not stored here.
 */
export class AssistantGemini1760100000000 implements MigrationInterface {
  name = 'AssistantGemini1760100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "organisational_unit" DROP CONSTRAINT "ck_unit_kind"`);
    await q.query(`
      ALTER TABLE "organisational_unit"
        ADD CONSTRAINT "ck_unit_kind" CHECK ("kind" IN ('CABINET','DIRECTORATE','SUB_DIRECTORATE','DEPARTMENT','DISTRICT','OFFICE','SERVICE'))`);
    await q.query(`ALTER TABLE "ai_interaction" ADD COLUMN "outcome" character varying(30) NOT NULL DEFAULT 'success'`);
    await q.query(`ALTER TABLE "ai_interaction" ADD COLUMN "tools_used" text[] NOT NULL DEFAULT '{}'`);
    await q.query(`ALTER TABLE "ai_interaction" ADD COLUMN "input_tokens" integer`);
    await q.query(`ALTER TABLE "ai_interaction" ADD COLUMN "output_tokens" integer`);
    await q.query(`CREATE INDEX "ix_ai_interaction_feature_time" ON "ai_interaction" ("account_id", "feature", "created_at" DESC)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "ix_ai_interaction_feature_time"`);
    await q.query(`ALTER TABLE "ai_interaction" DROP COLUMN IF EXISTS "output_tokens"`);
    await q.query(`ALTER TABLE "ai_interaction" DROP COLUMN IF EXISTS "input_tokens"`);
    await q.query(`ALTER TABLE "ai_interaction" DROP COLUMN IF EXISTS "tools_used"`);
    await q.query(`ALTER TABLE "ai_interaction" DROP COLUMN IF EXISTS "outcome"`);
    await q.query(`UPDATE "organisational_unit" SET "kind" = 'DIRECTORATE' WHERE "kind" = 'SUB_DIRECTORATE'`);
    await q.query(`ALTER TABLE "organisational_unit" DROP CONSTRAINT "ck_unit_kind"`);
    await q.query(`
      ALTER TABLE "organisational_unit"
        ADD CONSTRAINT "ck_unit_kind" CHECK ("kind" IN ('CABINET','DIRECTORATE','DEPARTMENT','DISTRICT','OFFICE','SERVICE'))`);
  }
}
