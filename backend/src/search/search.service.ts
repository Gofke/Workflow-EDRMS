import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccessService } from '../access/access.service';
import { TasksService } from '../tasks/tasks.service';

export type SearchType = 'ITEM' | 'DOSSIER' | 'TASK' | 'DOCUMENT';

export interface SearchQuery {
  q?: string;
  types?: SearchType[];
  direction?: string;
  party?: string;
  from?: string;
  to?: string;
  state?: string;
  classification?: string;
  categoryId?: string;
  unitId?: string;
  limit?: number;
}

export interface SearchHit {
  type: SearchType;
  id: string;
  identity: string | null;
  title: string;
  snippet: string | null;
  date: string | null;
  meta: Record<string, string | null>;
  link: string;
  rank: number;
}

const ITEM_VECTOR = `to_tsvector('dutch', coalesce(ci."subject", '') || ' ' || coalesce(ci."party", '') || ' ' || coalesce(ci."registration_identity", '') || ' ' || coalesce(ci."sender_reference", ''))`;
const DOSSIER_VECTOR = `to_tsvector('dutch', coalesce(d."subject", '') || ' ' || coalesce(d."dossier_identity", ''))`;
const TEXT_VECTOR = `to_tsvector('dutch', coalesce(dt."extracted_text", ''))`;

/**
 * Search across letters, matters, tasks and the text read from documents.
 *
 * Gate 4 said search waits for record-level permissions; it does not have to
 * wait any longer. Every part of this query goes through the same evaluator
 * as the lists, in the database, so a classified record is never matched for
 * someone who may not see it — not even as a count.
 *
 * Dutch full-text search: "verzoeken" finds "verzoek", "politie" finds
 * "Korps Politie Suriname". A registration number or part of one is matched
 * directly.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: AccessService,
    private readonly tasks: TasksService,
  ) {}

  async search(accountId: string, query: SearchQuery): Promise<{ hits: SearchHit[]; counts: Record<SearchType, number> }> {
    const profile = await this.access.profile(accountId);
    const types = query.types?.length ? query.types : (['ITEM', 'DOSSIER', 'TASK', 'DOCUMENT'] as SearchType[]);
    const q = (query.q ?? '').trim().slice(0, 200);
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
    const hits: SearchHit[] = [];
    const counts = { ITEM: 0, DOSSIER: 0, TASK: 0, DOCUMENT: 0 } as Record<SearchType, number>;
    if (!q && !query.party && !query.from && !query.to && !query.direction && !query.categoryId && !query.unitId && !query.state && !query.classification) {
      return { hits, counts };
    }

    if (types.includes('ITEM')) {
      const params: unknown[] = [];
      const where: string[] = [];
      const pred = this.access.itemPredicate(profile, 'ci', 1);
      params.push(...pred.params);
      where.push(pred.sql);
      let rank = '0';
      if (q) {
        params.push(q, `%${q}%`);
        const t = `websearch_to_tsquery('dutch', $${params.length - 1})`;
        where.push(`(${ITEM_VECTOR} @@ ${t} OR ci.registration_identity ILIKE $${params.length} OR ci.sender_reference ILIKE $${params.length})`);
        rank = `ts_rank(${ITEM_VECTOR}, ${t}) + CASE WHEN ci.registration_identity ILIKE $${params.length} THEN 1 ELSE 0 END`;
      }
      this.itemFilters(query, params, where);
      const rows = await this.dataSource.query(
        `SELECT ci.id, ci.registration_identity, ci.subject, ci.party, ci.direction, ci.state, ci.classification,
                to_char(coalesce(ci.registered_at, ci.created_at) AT TIME ZONE 'America/Paramaribo', 'YYYY-MM-DD') AS d,
                u.name AS unit, ${rank} AS rank, count(*) OVER () AS total
           FROM correspondence_item ci LEFT JOIN organisational_unit u ON u.id = ci.owning_unit_id
          WHERE ${where.join(' AND ')}
          ORDER BY rank DESC, coalesce(ci.registered_at, ci.created_at) DESC LIMIT ${limit}`,
        params,
      );
      counts.ITEM = Number(rows[0]?.total ?? 0);
      for (const r of rows) {
        hits.push({
          type: 'ITEM',
          id: r.id,
          identity: r.registration_identity,
          title: r.subject,
          snippet: r.party,
          date: r.d,
          meta: { direction: r.direction, state: r.state, classification: r.classification, unit: r.unit },
          link: `/post/${r.id}`,
          rank: Number(r.rank),
        });
      }
    }

    if (types.includes('DOCUMENT') && q) {
      const params: unknown[] = [];
      const pred = this.access.itemPredicate(profile, 'ci', 1);
      params.push(...pred.params, q);
      const t = `websearch_to_tsquery('dutch', $${params.length})`;
      const where = [pred.sql, `dt.status = 'EXTRACTED'`, `${TEXT_VECTOR} @@ ${t}`];
      this.itemFilters(query, params, where);
      const rows = await this.dataSource.query(
        `SELECT cd.id, ci.id AS item_id, ci.registration_identity, ci.subject, cd.original_filename, dt.method,
                ts_headline('dutch', dt.extracted_text, ${t}, 'MaxWords=24, MinWords=8, StartSel=«, StopSel=»') AS snippet,
                to_char(cd.captured_at AT TIME ZONE 'America/Paramaribo', 'YYYY-MM-DD') AS d,
                ts_rank(${TEXT_VECTOR}, ${t}) AS rank, count(*) OVER () AS total
           FROM document_text dt
           JOIN captured_document cd ON cd.id = dt.captured_document_id
           JOIN correspondence_item ci ON ci.id = cd.correspondence_item_id
          WHERE ${where.join(' AND ')}
          ORDER BY rank DESC LIMIT ${limit}`,
        params,
      );
      counts.DOCUMENT = Number(rows[0]?.total ?? 0);
      for (const r of rows) {
        hits.push({
          type: 'DOCUMENT',
          id: r.id,
          identity: r.registration_identity,
          title: `${r.original_filename} — ${r.subject}`,
          snippet: r.snippet,
          date: r.d,
          meta: { itemId: r.item_id, method: r.method, derived: 'true' },
          link: `/post/${r.item_id}?document=${r.id}`,
          rank: Number(r.rank),
        });
      }
    }

    if (types.includes('DOSSIER')) {
      const params: unknown[] = [];
      const pred = this.access.dossierPredicate(profile, 'd', 1);
      params.push(...pred.params);
      const where = [pred.sql];
      let rank = '0';
      if (q) {
        params.push(q, `%${q}%`);
        const t = `websearch_to_tsquery('dutch', $${params.length - 1})`;
        where.push(`(${DOSSIER_VECTOR} @@ ${t} OR d.dossier_identity ILIKE $${params.length})`);
        rank = `ts_rank(${DOSSIER_VECTOR}, ${t}) + CASE WHEN d.dossier_identity ILIKE $${params.length} THEN 1 ELSE 0 END`;
      }
      if (query.categoryId) {
        params.push(query.categoryId);
        where.push(`d.category_id = $${params.length}`);
      }
      if (query.unitId) {
        params.push(query.unitId);
        where.push(`d.owning_unit_id = $${params.length}`);
      }
      if (query.classification) {
        params.push(query.classification);
        where.push(`d.classification = $${params.length}`);
      }
      if (query.state) {
        params.push(query.state);
        where.push(`(d.processing_state = $${params.length} OR d.state = $${params.length})`);
      }
      if (query.from) {
        params.push(query.from);
        where.push(`d.created_at >= $${params.length}::date`);
      }
      if (query.to) {
        params.push(query.to);
        where.push(`d.created_at < ($${params.length}::date + 1)`);
      }
      if (!q && (query.party || query.direction)) where.push('false');
      const rows = await this.dataSource.query(
        `SELECT d.id, d.dossier_identity, d.subject, d.state, d.processing_state, d.classification,
                to_char(d.due_date, 'YYYY-MM-DD') AS due, to_char(d.created_at AT TIME ZONE 'America/Paramaribo', 'YYYY-MM-DD') AS d,
                c.name AS category, ${rank} AS rank, count(*) OVER () AS total
           FROM dossier d LEFT JOIN dossier_category c ON c.id = d.category_id
          WHERE ${where.join(' AND ')}
          ORDER BY rank DESC, d.created_at DESC LIMIT ${limit}`,
        params,
      );
      counts.DOSSIER = Number(rows[0]?.total ?? 0);
      for (const r of rows) {
        hits.push({
          type: 'DOSSIER',
          id: r.id,
          identity: r.dossier_identity,
          title: r.subject,
          snippet: r.category,
          date: r.d,
          meta: { state: r.state, processingState: r.processing_state, classification: r.classification, due: r.due },
          link: `/dossiers/${r.id}`,
          rank: Number(r.rank),
        });
      }
    }

    if (types.includes('TASK') && q) {
      const result = await this.tasks.list(accountId, { scope: 'all', q, limit, includeArchived: false });
      counts.TASK = result.total;
      for (const t of result.data) {
        hits.push({
          type: 'TASK',
          id: t.id,
          identity: t.reference,
          title: t.title,
          snippet: `${t.assignee.name}${t.dueDate ? ` · ${t.dueDate}` : ''}`,
          date: t.createdAt.slice(0, 10),
          meta: { status: t.status, priority: t.priority, overdue: String(t.overdue) },
          link: `/taken/${t.id}`,
          rank: 0.5,
        });
      }
    }
    return { hits, counts };
  }

  private itemFilters(query: SearchQuery, params: unknown[], where: string[]): void {
    if (query.direction && ['INCOMING', 'OUTGOING', 'INTERNAL'].includes(query.direction)) {
      params.push(query.direction);
      where.push(`ci.direction = $${params.length}`);
    }
    if (query.party?.trim()) {
      params.push(`%${query.party.trim()}%`);
      where.push(`ci.party ILIKE $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      where.push(`coalesce(ci.registered_at, ci.created_at) >= $${params.length}::date`);
    }
    if (query.to) {
      params.push(query.to);
      where.push(`coalesce(ci.registered_at, ci.created_at) < ($${params.length}::date + 1)`);
    }
    if (query.state && ['DRAFT', 'REGISTERED'].includes(query.state)) {
      params.push(query.state);
      where.push(`ci.state = $${params.length}`);
    }
    if (query.classification) {
      params.push(query.classification);
      where.push(`ci.classification = $${params.length}`);
    }
    if (query.unitId) {
      params.push(query.unitId);
      where.push(`ci.owning_unit_id = $${params.length}`);
    }
    if (query.categoryId) {
      params.push(query.categoryId);
      where.push(`EXISTS (SELECT 1 FROM dossier_link dl JOIN dossier dd ON dd.id = dl.dossier_id WHERE dl.correspondence_item_id = ci.id AND dd.category_id = $${params.length})`);
    }
  }

  // ------------------------------------------------------------- saved searches

  saved(accountId: string) {
    return this.dataSource.query(
      `SELECT id, name, query, created_at AS "createdAt" FROM saved_search WHERE account_id = $1 ORDER BY name`,
      [accountId],
    );
  }

  async save(accountId: string, name: string, query: SearchQuery) {
    if (!name?.trim()) throw new BadRequestException('Give the search a name.');
    const [{ n }] = await this.dataSource.query(`SELECT count(*)::int AS n FROM saved_search WHERE account_id = $1`, [accountId]);
    if (n >= 50) throw new BadRequestException('You can keep at most 50 saved searches.');
    await this.dataSource.query(`INSERT INTO saved_search (account_id, name, query) VALUES ($1, $2, $3)`, [accountId, name.trim().slice(0, 120), JSON.stringify(query)]);
    return this.saved(accountId);
  }

  async remove(accountId: string, id: string) {
    const r = await this.dataSource.query(`DELETE FROM saved_search WHERE id = $1 AND account_id = $2`, [id, accountId]);
    if (r[1] === 0) throw new NotFoundException('Unknown saved search.');
    return this.saved(accountId);
  }
}
