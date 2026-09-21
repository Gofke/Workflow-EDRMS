import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Dossier } from '../records/dossier.entity';

export interface TimelineEntry {
  occurredAt: string;
  kind: string;
  headline: string;
  actorName: string;
  onBehalfOfName: string | null;
  detail: string | null;
  /** Which authoritative object the entry was derived from. */
  source: string;
}

/**
 * The chronological account of a matter (BR-009).
 *
 * Derived, never assembled. Every entry comes from an authoritative row that
 * already carries its own server time and actor — workflow decisions,
 * responsibility assignments, due-date changes, record links, registrations,
 * document captures, and the closing and reopening of the file itself. Nothing is written when a timeline is read, and no entry
 * exists that some authoritative row did not produce.
 *
 * That matters more than it sounds. A timeline stored as its own narrative
 * would be a second version of history, free to drift from the first. This one
 * cannot disagree with the record because it is the record, read in order.
 *
 * One deliberate omission: the supersession of a responsibility assignment is
 * not a separate entry. It is implied by the next assignment, and emitting both
 * would report one change twice.
 *
 * This view does not yet filter by record-level permission — that arrives with
 * FR-SEC-003 and depends on DEC-02. Until then it shows what the dossier
 * contains to anyone who may open the dossier, and FR-DOS-009 will need this
 * query revisited when the evaluator exists.
 */
export interface TimelinePage {
  entries: TimelineEntry[];
  /** Every entry in the account right now, for showing progress and growth. */
  total: number;
  /** Null on the last page. */
  nextCursor: string | null;
}

/** The unpaged endpoint remains, unchanged, for the full read and export. */
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

/** A client-supplied page size, made safe: whole, at least 1, at most MAX_PAGE. */
export function clampPageLimit(limit: number): number {
  const requested = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_PAGE;
  return Math.min(MAX_PAGE, Math.max(1, requested));
}

const ENTRIES_SQL = `
      WITH linked_items AS (
        SELECT correspondence_item_id FROM dossier_link WHERE dossier_id = $1
      )
      SELECT * FROM (
        -- The dossier itself
        SELECT d.created_at AS occurred_at,
               'DOSSIER_OPENED' AS kind,
               'Dossier opened' AS headline,
               p.full_name AS actor_name,
               NULL::text AS on_behalf_of_name,
               d.subject AS detail,
               'dossier' AS source,
               d.id::text AS row_id
          FROM dossier d
          JOIN account a ON a.id = d.created_by_account_id
          JOIN person p ON p.id = a.person_id
         WHERE d.id = $1

        UNION ALL
        -- Responsibility assigned or reassigned
        SELECT ra.assigned_at,
               'RESPONSIBILITY_ASSIGNED',
               'Responsibility assigned to ' || rp.full_name,
               ap.full_name,
               obp.full_name,
               NULL,
               'responsibility_assignment',
               ra.id::text
          FROM responsibility_assignment ra
          JOIN account racc ON racc.id = ra.responsible_account_id
          JOIN person rp ON rp.id = racc.person_id
          JOIN account aacc ON aacc.id = ra.assigned_by_account_id
          JOIN person ap ON ap.id = aacc.person_id
          LEFT JOIN account obacc ON obacc.id = ra.on_behalf_of_account_id
          LEFT JOIN person obp ON obp.id = obacc.person_id
         WHERE ra.dossier_id = $1

        UNION ALL
        -- Official due date set, changed or removed
        SELECT dc.changed_at,
               'DUE_DATE_CHANGED',
               CASE WHEN dc.previous_due_date IS NULL
                    THEN 'Official due date set to ' || dc.new_due_date::text
                    WHEN dc.new_due_date IS NULL
                    THEN 'Official due date removed'
                    ELSE 'Official due date changed to ' || dc.new_due_date::text
               END,
               cp.full_name,
               obp.full_name,
               dc.reason,
               'due_date_change',
               dc.id::text
          FROM due_date_change dc
          JOIN account cacc ON cacc.id = dc.changed_by_account_id
          JOIN person cp ON cp.id = cacc.person_id
          LEFT JOIN account obacc ON obacc.id = dc.on_behalf_of_account_id
          LEFT JOIN person obp ON obp.id = obacc.person_id
         WHERE dc.dossier_id = $1

        UNION ALL
        -- A record filed into the matter
        SELECT dl.linked_at,
               'RECORD_LINKED',
               'Record ' || ci.registration_identity || ' filed in this matter',
               lp.full_name,
               NULL,
               ci.subject,
               'dossier_link',
               dl.id::text
          FROM dossier_link dl
          JOIN correspondence_item ci ON ci.id = dl.correspondence_item_id
          JOIN account lacc ON lacc.id = dl.linked_by_account_id
          JOIN person lp ON lp.id = lacc.person_id
         WHERE dl.dossier_id = $1

        UNION ALL
        -- Registration of a record that is in the matter
        SELECT ci.registered_at,
               'ITEM_REGISTERED',
               'Record ' || ci.registration_identity || ' registered',
               cp.full_name,
               NULL,
               ci.subject,
               'correspondence_item',
               ci.id::text
          FROM correspondence_item ci
          JOIN account cacc ON cacc.id = ci.created_by_account_id
          JOIN person cp ON cp.id = cacc.person_id
         WHERE ci.id IN (SELECT correspondence_item_id FROM linked_items)
           AND ci.registered_at IS NOT NULL

        UNION ALL
        -- A document captured against a record in the matter
        SELECT cd.captured_at,
               'DOCUMENT_CAPTURED',
               'Document captured: ' || cd.original_filename,
               kp.full_name,
               NULL,
               'sha256 ' || left(cd.content_hash, 16) || '…',
               'captured_document',
               cd.id::text
          FROM captured_document cd
          JOIN account kacc ON kacc.id = cd.captured_by_account_id
          JOIN person kp ON kp.id = kacc.person_id
         WHERE cd.correspondence_item_id IN (SELECT correspondence_item_id FROM linked_items)

        UNION ALL
        -- Workflow decisions
        SELECT we.occurred_at,
               we.event_type,
               CASE we.event_type
                 WHEN 'SUBMITTED' THEN 'Submitted for review to ' || COALESCE(vp.full_name, 'a reviewer')
                 WHEN 'RETURNED'  THEN 'Returned for correction'
                 WHEN 'APPROVED'  THEN 'Approved'
                 WHEN 'FINALISED' THEN 'Finalised'
                 WHEN 'REOPENED'  THEN 'Reopened'
                 ELSE we.event_type
               END,
               wp.full_name,
               obp.full_name,
               we.reason,
               'workflow_event',
               we.id::text
          FROM workflow_event we
          JOIN account wacc ON wacc.id = we.actor_account_id
          JOIN person wp ON wp.id = wacc.person_id
          LEFT JOIN account vacc ON vacc.id = we.reviewer_account_id
          LEFT JOIN person vp ON vp.id = vacc.person_id
          LEFT JOIN account obacc ON obacc.id = we.on_behalf_of_account_id
          LEFT JOIN person obp ON obp.id = obacc.person_id
         WHERE we.dossier_id = $1

        UNION ALL
        -- The matter file closed or reopened (EV-DOS-CLOSE)
        SELECT se.occurred_at,
               'DOSSIER_' || se.to_state,
               CASE se.to_state WHEN 'CLOSED' THEN 'Dossier closed' ELSE 'Dossier reopened' END,
               sp.full_name,
               NULL,
               se.reason,
               'dossier_state_event',
               se.id::text
          FROM dossier_state_event se
          JOIN account sacc ON sacc.id = se.actor_account_id
          JOIN person sp ON sp.id = sacc.person_id
         WHERE se.dossier_id = $1
      ) entries`;

@Injectable()
export class TimelineService {
  constructor(
    @InjectRepository(Dossier) private readonly dossiers: Repository<Dossier>,
    private readonly dataSource: DataSource,
  ) {}

  async forDossier(dossierId: string): Promise<TimelineEntry[]> {
    await this.assertExists(dossierId);
    return this.read(dossierId);
  }

  /**
   * One page of the account, oldest first (V0.1.14).
   *
   * Cursor paging, not offset paging. The history is not strictly append-at-end:
   * filing an older record brings its earlier registration and document
   * captures into the middle of the account. With offsets that would shift an
   * entry onto two pages. With a cursor on (time, source, row) no entry is ever
   * served twice, and the total lets the reader see that the history grew
   * behind the point they had reached.
   */
  async page(dossierId: string, cursor: string | null, limit: number): Promise<TimelinePage> {
    await this.assertExists(dossierId);
    const safeLimit = clampPageLimit(limit);
    const after = cursor ? decodeCursor(cursor) : null;

    const [{ total }] = await this.dataSource.query(
      `SELECT count(*)::int AS total FROM (${ENTRIES_SQL}) counted`,
      [dossierId],
    );
    const rows = await this.dataSource.query(
      `SELECT *, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
         FROM (${ENTRIES_SQL}) ordered
        ${after ? 'WHERE (occurred_at, source, row_id) > ($3::timestamptz, $4::text, $5::text)' : ''}
        ORDER BY occurred_at ASC, source ASC, row_id ASC
        LIMIT $2`,
      after ? [dossierId, safeLimit + 1, after.t, after.s, after.r] : [dossierId, safeLimit + 1],
    );

    const more = rows.length > safeLimit;
    const served = rows.slice(0, safeLimit);
    const last = served[served.length - 1];
    return {
      entries: served.map(toEntry),
      total,
      nextCursor: more && last ? encodeCursor({ t: last.cursor_time, s: last.source, r: last.row_id }) : null,
    };
  }

  private async assertExists(dossierId: string): Promise<Dossier> {
    const dossier = await this.dossiers.findOne({ where: { id: dossierId } });
    if (!dossier) throw new NotFoundException('Unknown dossier.');
    return dossier;
  }

  /** Looks up the dossier for callers that need its identity, e.g. export. */
  async dossierFor(dossierId: string): Promise<Dossier> {
    return this.assertExists(dossierId);
  }

  private async read(dossierId: string): Promise<TimelineEntry[]> {
    // One query, one ordering, one source of truth per entry. Assembling this
    // in application code would invite an entry that no row produced.
    const rows = await this.dataSource.query(
      `SELECT * FROM (${ENTRIES_SQL}) ordered ORDER BY occurred_at ASC, source ASC, row_id ASC`,
      [dossierId],
    );
    return rows.map(toEntry);
  }
}

interface EntryRow {
  occurred_at: Date;
  kind: string;
  headline: string;
  actor_name: string;
  on_behalf_of_name: string | null;
  detail: string | null;
  source: string;
}

function toEntry(row: EntryRow): TimelineEntry {
  return {
    occurredAt: new Date(row.occurred_at).toISOString(),
    kind: row.kind,
    headline: row.headline,
    actorName: row.actor_name,
    onBehalfOfName: row.on_behalf_of_name,
    detail: row.detail,
    source: row.source,
  };
}

interface Cursor {
  t: string;
  s: string;
  r: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** A cursor is client-held, so it is validated rather than trusted. */
function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed?.t === 'string' &&
      !Number.isNaN(Date.parse(parsed.t)) &&
      typeof parsed?.s === 'string' &&
      typeof parsed?.r === 'string'
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  throw new BadRequestException('That page reference is not valid. Reload the history.');
}
