import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.1.5 — dossiers and record-to-dossier links.
 *
 * The dossier identity is protected exactly as the registration identity is: a
 * unique index, plus a trigger that raises an error on any attempt to change it
 * once assigned. A matter's reference appearing on correspondence, in minutes
 * and in later correspondence must keep meaning the same matter.
 *
 * dossier_link carries no delete protection, because unlinking is not a
 * Delivery 1 capability at all (DEC-10 open) — there is no route that removes a
 * link. If DEC-10 later enables it, the removal will need its own audit event
 * and its own decision about whether the link history survives.
 */
export class Dossiers1758400000000 implements MigrationInterface {
  name = 'Dossiers1758400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE "dossier_sequence" START 1`);

    await queryRunner.query(`
      CREATE TABLE "dossier" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_identity" character varying(80) NOT NULL,
        "subject" character varying(400) NOT NULL,
        "state" character varying(20) NOT NULL DEFAULT 'OPEN',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1,
        "created_by_account_id" uuid NOT NULL,
        "owning_unit_id" uuid,
        CONSTRAINT "pk_dossier" PRIMARY KEY ("id"),
        CONSTRAINT "fk_dossier_created_by" FOREIGN KEY ("created_by_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_dossier_unit" FOREIGN KEY ("owning_unit_id")
          REFERENCES "organisational_unit"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_dossier_state" CHECK ("state" IN ('OPEN'))
      )`);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "ix_dossier_identity" ON "dossier" ("dossier_identity")`,
    );

    await queryRunner.query(`
      CREATE TABLE "dossier_link" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "dossier_id" uuid NOT NULL,
        "correspondence_item_id" uuid NOT NULL,
        "linked_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "linked_by_account_id" uuid NOT NULL,
        CONSTRAINT "pk_dossier_link" PRIMARY KEY ("id"),
        CONSTRAINT "uq_dossier_link" UNIQUE ("dossier_id", "correspondence_item_id"),
        CONSTRAINT "fk_dossier_link_dossier" FOREIGN KEY ("dossier_id")
          REFERENCES "dossier"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_dossier_link_item" FOREIGN KEY ("correspondence_item_id")
          REFERENCES "correspondence_item"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_dossier_link_linked_by" FOREIGN KEY ("linked_by_account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT
      )`);

    await queryRunner.query(`
      CREATE FUNCTION "protect_dossier_identity"() RETURNS trigger AS $$
      BEGIN
        IF NEW.dossier_identity IS DISTINCT FROM OLD.dossier_identity THEN
          RAISE EXCEPTION 'dossier_identity cannot be changed once assigned';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);

    await queryRunner.query(`
      CREATE TRIGGER "trg_protect_dossier_identity"
        BEFORE UPDATE ON "dossier"
        FOR EACH ROW EXECUTE FUNCTION "protect_dossier_identity"()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_protect_dossier_identity" ON "dossier"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS "protect_dossier_identity"()`);
    await queryRunner.query(`DROP TABLE "dossier_link"`);
    await queryRunner.query(`DROP TABLE "dossier"`);
    await queryRunner.query(`DROP SEQUENCE "dossier_sequence"`);
  }
}
