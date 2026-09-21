import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.1.3 — correspondence items: draft capture and official registration.
 *
 * Two protections are enforced in the database rather than in application code:
 *
 * 1. A unique index on registration_identity (BR-001). Two records cannot share
 *    an identity even if two registrations race.
 * 2. A trigger rejecting any change to registration_identity or registered_at
 *    once set (FR-COR-004). Unlike the audit table's silent rules, this one
 *    raises an error: an ordinary edit that tries to move a registration
 *    timestamp should fail loudly, not appear to succeed.
 *
 * The sequence backs the {SEQ} token of the configured numbering pattern. The
 * pattern itself lives in configuration because DEC-01 is open — no numbering
 * syntax is decided here.
 */
export class Records1758300000000 implements MigrationInterface {
  name = 'Records1758300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE "registration_sequence" START 1`);

    await queryRunner.query(`
      CREATE TABLE "correspondence_item" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "registration_identity" character varying(80),
        "state" character varying(20) NOT NULL DEFAULT 'DRAFT',
        "direction" character varying(20) NOT NULL,
        "subject" character varying(400) NOT NULL,
        "party" character varying(300),
        "document_date" date,
        "registered_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1,
        "created_by_account_id" uuid NOT NULL,
        "owning_unit_id" uuid,
        CONSTRAINT "pk_correspondence_item" PRIMARY KEY ("id"),
        CONSTRAINT "fk_correspondence_item_created_by" FOREIGN KEY ("created_by_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_correspondence_item_unit" FOREIGN KEY ("owning_unit_id")
          REFERENCES "organisational_unit"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_correspondence_item_state" CHECK ("state" IN ('DRAFT','REGISTERED')),
        CONSTRAINT "ck_correspondence_item_direction"
          CHECK ("direction" IN ('INCOMING','OUTGOING','INTERNAL')),
        -- A registered item must carry both an identity and a registration
        -- time; a draft must carry neither. No half-registered state exists.
        CONSTRAINT "ck_correspondence_item_registered" CHECK (
          ("state" = 'DRAFT' AND "registration_identity" IS NULL AND "registered_at" IS NULL)
          OR
          ("state" = 'REGISTERED' AND "registration_identity" IS NOT NULL AND "registered_at" IS NOT NULL)
        )
      )`);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "ix_correspondence_item_identity"
         ON "correspondence_item" ("registration_identity")`,
    );

    await queryRunner.query(`
      CREATE FUNCTION "protect_registry_identity"() RETURNS trigger AS $$
      BEGIN
        IF OLD.registration_identity IS NOT NULL
           AND NEW.registration_identity IS DISTINCT FROM OLD.registration_identity THEN
          RAISE EXCEPTION 'registration_identity cannot be changed once assigned';
        END IF;
        IF OLD.registered_at IS NOT NULL
           AND NEW.registered_at IS DISTINCT FROM OLD.registered_at THEN
          RAISE EXCEPTION 'registered_at cannot be changed once assigned';
        END IF;
        IF OLD.state = 'REGISTERED' AND NEW.state = 'DRAFT' THEN
          RAISE EXCEPTION 'a registered item cannot be returned to draft';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);

    await queryRunner.query(`
      CREATE TRIGGER "trg_protect_registry_identity"
        BEFORE UPDATE ON "correspondence_item"
        FOR EACH ROW EXECUTE FUNCTION "protect_registry_identity"()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_protect_registry_identity" ON "correspondence_item"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS "protect_registry_identity"()`);
    await queryRunner.query(`DROP TABLE "correspondence_item"`);
    await queryRunner.query(`DROP SEQUENCE "registration_sequence"`);
  }
}
