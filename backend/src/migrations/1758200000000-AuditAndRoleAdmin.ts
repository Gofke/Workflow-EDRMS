import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.1.2 — append-only audit event storage.
 *
 * The append-only property is enforced in the database, not only in the
 * application. Two rules make UPDATE and DELETE on audit_event no-ops for every
 * connection, including a direct psql session using the application's own
 * credentials. An attempt reports success and changes nothing, which is why
 * TS-08's tamper cases must verify the row afterwards rather than trust the
 * response.
 *
 * A rule is used rather than a revoked GRANT because a superuser or the table
 * owner would bypass the GRANT, and the application user owns this schema.
 */
export class AuditAndRoleAdmin1758200000000 implements MigrationInterface {
  name = 'AuditAndRoleAdmin1758200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "audit_event" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "event_type" character varying(60) NOT NULL,
        "actor_account_id" uuid,
        "actor_description" character varying(260) NOT NULL,
        "subject_description" character varying(260),
        "previous_value" character varying(400),
        "new_value" character varying(400),
        "summary" character varying(600) NOT NULL,
        CONSTRAINT "pk_audit_event" PRIMARY KEY ("id")
      )`);

    await queryRunner.query(
      `CREATE INDEX "ix_audit_event_occurred_at" ON "audit_event" ("occurred_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_audit_event_actor" ON "audit_event" ("actor_account_id")`,
    );

    // No foreign key to account: an event must survive as evidence even if the
    // account it refers to is later removed. actor_description carries the
    // readable identity for exactly that reason.

    await queryRunner.query(
      `CREATE RULE "audit_event_no_update" AS ON UPDATE TO "audit_event" DO INSTEAD NOTHING`,
    );
    await queryRunner.query(
      `CREATE RULE "audit_event_no_delete" AS ON DELETE TO "audit_event" DO INSTEAD NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP RULE IF EXISTS "audit_event_no_delete" ON "audit_event"`);
    await queryRunner.query(`DROP RULE IF EXISTS "audit_event_no_update" ON "audit_event"`);
    await queryRunner.query(`DROP TABLE "audit_event"`);
  }
}
