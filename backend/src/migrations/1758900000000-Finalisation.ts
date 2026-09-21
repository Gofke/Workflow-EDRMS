import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * V0.1.10 — finalisation and reopening.
 *
 * Finalised is added to the processing states, and the transition guard is
 * rewritten to cover it:
 *
 *   APPROVED  -> FINALISED   finalisation of an approved result
 *   FINALISED -> ACTIVE      an explicit, authorised reopening
 *
 * FR-FIN-004 is why reopening returns to ACTIVE rather than erasing anything:
 * the finalisation event stays in the history, and the reopen event is recorded
 * beside it. A matter can therefore be finalised, reopened and finalised again,
 * and the sequence remains readable.
 *
 * FR-WFL-012 — no finalisation without the required approval evidence — is
 * enforced in the service, because it is a question about the event history
 * rather than about the row being updated. The trigger's event-backed rule
 * still applies: a state cannot move to FINALISED without a FINALISED event.
 */
export class Finalisation1758900000000 implements MigrationInterface {
  name = 'Finalisation1758900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "dossier" DROP CONSTRAINT "ck_dossier_processing_state"`,
    );
    await queryRunner.query(`
      ALTER TABLE "dossier" ADD CONSTRAINT "ck_dossier_processing_state"
        CHECK ("processing_state" IN ('ACTIVE','UNDER_REVIEW','RETURNED','APPROVED','FINALISED'))`);

    await queryRunner.query(`ALTER TABLE "workflow_event" DROP CONSTRAINT "ck_workflow_event_type"`);
    await queryRunner.query(`
      ALTER TABLE "workflow_event" ADD CONSTRAINT "ck_workflow_event_type"
        CHECK ("event_type" IN ('SUBMITTED','RETURNED','APPROVED','FINALISED','REOPENED'))`);

    // A reopening without a reason is not an authorised explicit event.
    await queryRunner.query(`
      ALTER TABLE "workflow_event" ADD CONSTRAINT "ck_workflow_event_reopen_reason"
        CHECK ("event_type" <> 'REOPENED' OR ("reason" IS NOT NULL AND char_length("reason") > 0))`);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "guard_processing_state"() RETURNS trigger AS $$
      DECLARE
        permitted boolean := false;
        accounted boolean := false;
      BEGIN
        IF NEW.processing_state IS NOT DISTINCT FROM OLD.processing_state THEN
          RETURN NEW;
        END IF;

        permitted := (OLD.processing_state = 'ACTIVE'       AND NEW.processing_state = 'UNDER_REVIEW')
                  OR (OLD.processing_state = 'UNDER_REVIEW' AND NEW.processing_state IN ('RETURNED','APPROVED'))
                  OR (OLD.processing_state = 'RETURNED'     AND NEW.processing_state = 'UNDER_REVIEW')
                  OR (OLD.processing_state = 'APPROVED'     AND NEW.processing_state = 'FINALISED')
                  OR (OLD.processing_state = 'FINALISED'    AND NEW.processing_state = 'ACTIVE');

        IF NOT permitted THEN
          RAISE EXCEPTION 'processing state cannot move from % to %',
            OLD.processing_state, NEW.processing_state;
        END IF;

        SELECT EXISTS (
          SELECT 1 FROM workflow_event
           WHERE dossier_id = NEW.id
             AND occurred_at > now() - interval '5 seconds'
             AND ((NEW.processing_state = 'UNDER_REVIEW' AND event_type = 'SUBMITTED')
               OR (NEW.processing_state = 'RETURNED'     AND event_type = 'RETURNED')
               OR (NEW.processing_state = 'APPROVED'     AND event_type = 'APPROVED')
               OR (NEW.processing_state = 'FINALISED'    AND event_type = 'FINALISED')
               OR (NEW.processing_state = 'ACTIVE'       AND event_type = 'REOPENED'))
        ) INTO accounted;

        IF NOT accounted THEN
          RAISE EXCEPTION 'a processing state change must be recorded as a workflow event first';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workflow_event" DROP CONSTRAINT IF EXISTS "ck_workflow_event_reopen_reason"`,
    );
    await queryRunner.query(`ALTER TABLE "workflow_event" DROP CONSTRAINT "ck_workflow_event_type"`);
    await queryRunner.query(`
      ALTER TABLE "workflow_event" ADD CONSTRAINT "ck_workflow_event_type"
        CHECK ("event_type" IN ('SUBMITTED','RETURNED','APPROVED'))`);
    await queryRunner.query(
      `ALTER TABLE "dossier" DROP CONSTRAINT "ck_dossier_processing_state"`,
    );
    await queryRunner.query(`
      ALTER TABLE "dossier" ADD CONSTRAINT "ck_dossier_processing_state"
        CHECK ("processing_state" IN ('ACTIVE','UNDER_REVIEW','RETURNED','APPROVED'))`);
  }
}
