import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export type DuplicateReason = 'IDENTICAL_DOCUMENT' | 'SAME_SUBJECT_AND_PARTY';

export interface PossibleDuplicate {
  itemId: string;
  registrationIdentity: string;
  direction: string;
  subject: string;
  party: string | null;
  registeredAt: string;
  reasons: DuplicateReason[];
}

/** Enough to act on at pilot scale without turning a warning into a listing. */
const MAX_CANDIDATES = 20;

/**
 * Possible duplicates of a record (FR-COR-016).
 *
 * Advisory and read-only. It names registered records that carry a byte-identical
 * document, or the same direction, subject and party. It never blocks
 * registration, never merges, and writes nothing — asking the question must not
 * change either record (TS02 026, expected results A and D).
 *
 * Only registered records are candidates: a draft is preparatory material, not
 * an official record something could duplicate.
 *
 * Gate 4 dependency: this names other records, so when FR-SEC-003 exists a
 * candidate must pass the permission evaluator before it is shown (UC-R04 —
 * no counts, snippets or context from records the user may not see). Today
 * every business role may see every record, so nothing is disclosed that the
 * registry list does not already show.
 */
@Injectable()
export class DuplicateService {
  constructor(private readonly dataSource: DataSource) {}

  async candidatesFor(itemId: string): Promise<PossibleDuplicate[]> {
    const [item] = await this.dataSource.query(
      `SELECT id FROM correspondence_item WHERE id = $1`,
      [itemId],
    );
    if (!item) throw new NotFoundException('Unknown correspondence item.');

    const rows: {
      id: string;
      registration_identity: string;
      direction: string;
      subject: string;
      party: string | null;
      registered_at: Date;
      reason: DuplicateReason;
    }[] = await this.dataSource.query(
      `
      WITH me AS (SELECT * FROM correspondence_item WHERE id = $1),
      matches AS (
        SELECT theirs.correspondence_item_id AS id, 'IDENTICAL_DOCUMENT' AS reason
          FROM captured_document mine
          JOIN captured_document theirs
            ON theirs.content_hash = mine.content_hash
           AND theirs.correspondence_item_id <> mine.correspondence_item_id
         WHERE mine.correspondence_item_id = $1
        UNION
        SELECT other.id, 'SAME_SUBJECT_AND_PARTY'
          FROM correspondence_item other, me
         WHERE other.id <> me.id
           AND other.direction = me.direction
           AND lower(btrim(other.subject)) = lower(btrim(me.subject))
           AND lower(btrim(coalesce(other.party, ''))) = lower(btrim(coalesce(me.party, '')))
      )
      SELECT ci.id, ci.registration_identity, ci.direction, ci.subject, ci.party,
             ci.registered_at, m.reason
        FROM matches m
        JOIN correspondence_item ci ON ci.id = m.id
       WHERE ci.state = 'REGISTERED'
       ORDER BY ci.registered_at DESC, ci.id, m.reason
      `,
      [itemId],
    );

    const byItem = new Map<string, PossibleDuplicate>();
    for (const row of rows) {
      const existing = byItem.get(row.id);
      if (existing) {
        if (!existing.reasons.includes(row.reason)) existing.reasons.push(row.reason);
        continue;
      }
      if (byItem.size >= MAX_CANDIDATES) continue;
      byItem.set(row.id, {
        itemId: row.id,
        registrationIdentity: row.registration_identity,
        direction: row.direction,
        subject: row.subject,
        party: row.party,
        registeredAt: new Date(row.registered_at).toISOString(),
        reasons: [row.reason],
      });
    }
    return [...byItem.values()];
  }
}
