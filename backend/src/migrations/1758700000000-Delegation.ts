import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.1.8 — delegation and acting on behalf.
 *
 * Two protections in the database:
 *
 * 1. delegation rows cannot be deleted or rewritten. A trigger permits only the
 *    revocation transition, exactly as responsibility_assignment does, so a
 *    delegation that was once valid cannot be made to have never existed
 *    (FR-DEL-006).
 * 2. audit_event gains represented_authority. A delegated action must record
 *    the actual actor AND the authority represented (FR-DEL-003); actor_* were
 *    already there, and this is the other half.
 *
 * The on_behalf_of columns on the two authoritative tables record the same fact
 * on the object itself, not only in the trail, so the state and the history
 * cannot disagree about who acted for whom.
 */
export class Delegation1758700000000 implements MigrationInterface {
  name = 'Delegation1758700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "audit_event" ADD COLUMN "represented_authority" character varying(260)`,
    );
    await queryRunner.query(
      `ALTER TABLE "responsibility_assignment" ADD COLUMN "on_behalf_of_account_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "due_date_change" ADD COLUMN "on_behalf_of_account_id" uuid`,
    );

    await queryRunner.query(`
      CREATE TABLE "delegation" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "principal_account_id" uuid NOT NULL,
        "delegate_account_id" uuid NOT NULL,
        "permitted_actions" character varying(400) NOT NULL,
        "valid_from" TIMESTAMP WITH TIME ZONE NOT NULL,
        "valid_until" TIMESTAMP WITH TIME ZONE NOT NULL,
        "granted_by_account_id" uuid NOT NULL,
        "granted_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "revoked_by_account_id" uuid,
        CONSTRAINT "pk_delegation" PRIMARY KEY ("id"),
        CONSTRAINT "fk_delegation_principal" FOREIGN KEY ("principal_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_delegation_delegate" FOREIGN KEY ("delegate_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_delegation_granted_by" FOREIGN KEY ("granted_by_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_delegation_revoked_by" FOREIGN KEY ("revoked_by_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        -- Nobody may hold their own delegated authority: it would add nothing
        -- and would muddy attribution.
        CONSTRAINT "ck_delegation_distinct" CHECK ("principal_account_id" <> "delegate_account_id"),
        CONSTRAINT "ck_delegation_period" CHECK ("valid_until" > "valid_from"),
        CONSTRAINT "ck_delegation_actions" CHECK (char_length("permitted_actions") > 0)
      )`);

    await queryRunner.query(
      `CREATE INDEX "ix_delegation_delegate" ON "delegation" ("delegate_account_id", "valid_until")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_delegation_principal" ON "delegation" ("principal_account_id")`,
    );

    await queryRunner.query(
      `CREATE RULE "delegation_no_delete" AS ON DELETE TO "delegation" DO INSTEAD NOTHING`,
    );

    await queryRunner.query(`
      CREATE FUNCTION "protect_delegation"() RETURNS trigger AS $$
      BEGIN
        IF NEW.principal_account_id IS DISTINCT FROM OLD.principal_account_id
           OR NEW.delegate_account_id IS DISTINCT FROM OLD.delegate_account_id
           OR NEW.permitted_actions IS DISTINCT FROM OLD.permitted_actions
           OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
           OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
           OR NEW.granted_by_account_id IS DISTINCT FROM OLD.granted_by_account_id
           OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
          RAISE EXCEPTION 'a delegation cannot be rewritten; revoke it and grant a new one';
        END IF;
        IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
          RAISE EXCEPTION 'a revoked delegation cannot be changed or revived';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);

    await queryRunner.query(`
      CREATE TRIGGER "trg_protect_delegation"
        BEFORE UPDATE ON "delegation"
        FOR EACH ROW EXECUTE FUNCTION "protect_delegation"()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_protect_delegation" ON "delegation"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS "protect_delegation"()`);
    await queryRunner.query(`DROP TABLE "delegation"`);
    await queryRunner.query(`ALTER TABLE "due_date_change" DROP COLUMN "on_behalf_of_account_id"`);
    await queryRunner.query(
      `ALTER TABLE "responsibility_assignment" DROP COLUMN "on_behalf_of_account_id"`,
    );
    await queryRunner.query(`ALTER TABLE "audit_event" DROP COLUMN "represented_authority"`);
  }
}
