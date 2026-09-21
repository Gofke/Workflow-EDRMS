import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.1.1 identity foundation.
 *
 * Migration-based only. TypeORM synchronize is never enabled, so the schema of
 * every environment is a reviewable artifact rather than a side effect of
 * starting the application.
 */
export class InitIdentity1758100000000 implements MigrationInterface {
  name = 'InitIdentity1758100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE "person" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "full_name" character varying(200) NOT NULL,
        "job_position" character varying(200),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_person" PRIMARY KEY ("id")
      )`);

    await queryRunner.query(`
      CREATE TABLE "organisational_unit" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "code" character varying(40) NOT NULL,
        "name" character varying(200) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_organisational_unit" PRIMARY KEY ("id"),
        CONSTRAINT "uq_organisational_unit_code" UNIQUE ("code")
      )`);

    await queryRunner.query(`
      CREATE TABLE "functional_role" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "code" character varying(40) NOT NULL,
        "name" character varying(120) NOT NULL,
        "description" character varying(400) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_functional_role" PRIMARY KEY ("id"),
        CONSTRAINT "uq_functional_role_code" UNIQUE ("code")
      )`);

    await queryRunner.query(`
      CREATE TABLE "account" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" character varying(320) NOT NULL,
        "password_hash" character varying(400) NOT NULL,
        "is_enabled" boolean NOT NULL DEFAULT true,
        "last_login_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "person_id" uuid NOT NULL,
        "organisational_unit_id" uuid,
        CONSTRAINT "pk_account" PRIMARY KEY ("id"),
        CONSTRAINT "uq_account_email" UNIQUE ("email"),
        CONSTRAINT "fk_account_person" FOREIGN KEY ("person_id")
          REFERENCES "person"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_account_organisational_unit" FOREIGN KEY ("organisational_unit_id")
          REFERENCES "organisational_unit"("id") ON DELETE RESTRICT
      )`);

    await queryRunner.query(`
      CREATE TABLE "role_assignment" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "account_id" uuid NOT NULL,
        "functional_role_id" uuid NOT NULL,
        "assigned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "pk_role_assignment" PRIMARY KEY ("id"),
        CONSTRAINT "uq_role_assignment_account_role" UNIQUE ("account_id", "functional_role_id"),
        CONSTRAINT "fk_role_assignment_account" FOREIGN KEY ("account_id")
          REFERENCES "account"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_role_assignment_role" FOREIGN KEY ("functional_role_id")
          REFERENCES "functional_role"("id") ON DELETE RESTRICT
      )`);

    // Server-side session store. Sessions live in the database so that they are
    // revocable and survive an application restart.
    await queryRunner.query(`
      CREATE TABLE "user_session" (
        "sid" character varying NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" TIMESTAMP(6) NOT NULL,
        CONSTRAINT "pk_user_session" PRIMARY KEY ("sid")
      )`);
    await queryRunner.query(`CREATE INDEX "ix_user_session_expire" ON "user_session" ("expire")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_session"`);
    await queryRunner.query(`DROP TABLE "role_assignment"`);
    await queryRunner.query(`DROP TABLE "account"`);
    await queryRunner.query(`DROP TABLE "functional_role"`);
    await queryRunner.query(`DROP TABLE "organisational_unit"`);
    await queryRunner.query(`DROP TABLE "person"`);
  }
}
