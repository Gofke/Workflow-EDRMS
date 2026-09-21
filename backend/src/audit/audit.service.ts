import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AuditEvent, AuditEventType } from './audit-event.entity';

export interface AuditEntry {
  eventType: AuditEventType;
  actorAccountId: string | null;
  actorDescription: string;
  representedAuthority?: string | null;
  subjectDescription?: string | null;
  previousValue?: string | null;
  newValue?: string | null;
  summary: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditEvent)
    private readonly events: Repository<AuditEvent>,
  ) {}

  /**
   * Writes one event. occurredAt is deliberately omitted so the database
   * supplies it: server time is the evidentiary timestamp, not application or
   * client time.
   *
   * A failure to write is logged loudly and never swallowed into a silent pass,
   * but it does not fail the user's action for the event types in V0.1.2. Once
   * business records exist, an action whose audit write fails must fail with it;
   * that belongs to the version that introduces those records.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.events.insert({
        eventType: entry.eventType,
        actorAccountId: entry.actorAccountId,
        actorDescription: entry.actorDescription,
        representedAuthority: entry.representedAuthority ?? null,
        subjectDescription: entry.subjectDescription ?? null,
        previousValue: entry.previousValue ?? null,
        newValue: entry.newValue ?? null,
        summary: entry.summary,
      });
    } catch (error) {
      this.logger.error(
        `AUDIT WRITE FAILED for ${entry.eventType}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Writes the event and lets a failure propagate, for an action that has no
   * other database write to enlist — a document retrieval, for instance. The
   * caller fails rather than proceeding unaudited.
   */
  async recordStrict(entry: AuditEntry): Promise<void> {
    await this.events.insert({
      eventType: entry.eventType,
      actorAccountId: entry.actorAccountId,
      actorDescription: entry.actorDescription,
      representedAuthority: entry.representedAuthority ?? null,
      subjectDescription: entry.subjectDescription ?? null,
      previousValue: entry.previousValue ?? null,
      newValue: entry.newValue ?? null,
      summary: entry.summary,
    });
  }

  /**
   * Writes the event inside the caller's transaction and lets a failure
   * propagate, so the action fails with its own audit.
   *
   * record() logs and continues and is now used only where the action has
   * already failed anyway — a refused sign-in. Everything that changes
   * authoritative state uses this or recordStrict, so no such change can exist
   * without its evidence.
   */
  async recordInTransaction(manager: EntityManager, entry: AuditEntry): Promise<void> {
    await manager.query(
      `INSERT INTO audit_event (event_type, actor_account_id, actor_description,
         represented_authority, subject_description, previous_value, new_value, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.eventType,
        entry.actorAccountId,
        entry.actorDescription,
        entry.representedAuthority ?? null,
        entry.subjectDescription ?? null,
        entry.previousValue ?? null,
        entry.newValue ?? null,
        entry.summary,
      ],
    );
  }

  /** Newest first. Read by the administrator; exposes no record content. */
  async list(limit = 100): Promise<AuditEvent[]> {
    return this.events.find({
      order: { occurredAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }
}
