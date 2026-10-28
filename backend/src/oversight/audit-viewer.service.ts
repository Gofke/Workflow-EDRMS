import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../records/registration.service';

export type AuditCategory = 'SECURITY' | 'ADMINISTRATION' | 'RECORDS' | 'MATTERS' | 'TASKS' | 'ACCESS' | 'ARCHIVE' | 'ASSISTANT' | 'INTEGRATION' | 'OVERSIGHT';

const CATEGORY_OF: Record<AuditCategory, RegExp> = {
  SECURITY: /^(SIGN_IN_|SIGN_OUT|PASSWORD_|ACCOUNT_LOCKED|MFA_)/,
  ADMINISTRATION: /^(ROLE_|ACCOUNT_(ENABLED|DISABLED|CREATED|UPDATED)|SETTING_CHANGED|UNIT_|HOLIDAY_CHANGED|TASK_TEMPLATE_SAVED|LETTER_TEMPLATE_SAVED|CATEGORY_SAVED|ROUTE_SAVED|TRAINING_DATA_LOADED)/,
  RECORDS: /^(DRAFT_|ITEM_|DOCUMENT_|LETTER_COMPOSED|LABEL_PRINTED|EMAIL_INTAKE_RECEIVED|SEAL_APPLIED)/,
  MATTERS: /^(DOSSIER_(CREATED|CLOSED|REOPENED|CATEGORISED|RELATED)|RECORD_LINKED|RESPONSIBILITY_|DUE_DATE_|DELEGATION_|WORKFLOW_|ROUTE_STEP_|ADVICE_|OUT_OF_OFFICE_|TIMELINE_EXPORTED)/,
  TASKS: /^(TASK_(CREATED|UPDATED|ASSIGNED|STATUS_CHANGED|ACCEPTED|REJECTED|COMPLETED|CANCELLED|ARCHIVED|COMMENTED|ATTACHMENT_ADDED)|REMINDER_SENT|DEADLINE_ESCALATED|WEEKLY_REPORT_SENT)/,
  ACCESS: /^(CLASSIFICATION_CHANGED|ACCESS_)/,
  ARCHIVE: /^(LEGAL_HOLD_|RETENTION_|ARCHIVE_|TIMELINE_PDF_EXPORTED)/,
  ASSISTANT: /^AI_/,
  INTEGRATION: /^(INTEGRATION_KEY_|WIJSAMEN_|EXCHANGE_)/,
  OVERSIGHT: /^(AUDIT_EXPORTED|INTEGRITY_CHECK_RUN|REPORT_EXPORTED)/,
};

export function categoryOf(type: string): AuditCategory | 'OTHER' {
  for (const [category, re] of Object.entries(CATEGORY_OF)) if (re.test(type)) return category as AuditCategory;
  return 'OTHER';
}

/** What the system administrator may read: the running of the system, not the work done in it. */
const ADMIN_CATEGORIES: AuditCategory[] = ['SECURITY', 'ADMINISTRATION', 'INTEGRATION', 'OVERSIGHT'];

export interface AuditQuery {
  from?: string;
  to?: string;
  type?: string;
  category?: string;
  actor?: string;
  q?: string;
  page?: number;
  limit?: number;
}

/**
 * The audit history for the auditor: searchable, filterable and exportable.
 * The history itself cannot be changed by anyone; this only reads it. Each
 * export is itself recorded.
 *
 * The auditor and the Minister see everything. The system administrator sees
 * the events about running the system — sign-ins, roles, settings, keys — but
 * not the events about the ministry's records.
 */
@Injectable()
export class AuditViewerService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  types(): { type: string; category: string }[] {
    return Object.values(AuditEventType).map((type) => ({ type, category: categoryOf(type) }));
  }

  private filter(query: AuditQuery, restricted: boolean): { where: string; params: unknown[] } {
    const params: unknown[] = [];
    const clauses: string[] = [];
    const add = (sql: (n: number) => string, value: unknown) => {
      params.push(value);
      clauses.push(sql(params.length));
    };
    let allowed = Object.values(AuditEventType) as string[];
    if (restricted) allowed = allowed.filter((t) => ADMIN_CATEGORIES.includes(categoryOf(t) as AuditCategory));
    if (query.category) allowed = allowed.filter((t) => categoryOf(t) === query.category);
    if (query.type) allowed = allowed.filter((t) => t === query.type);
    add((n) => `e.event_type = ANY($${n})`, allowed);
    if (query.from && /^\d{4}-\d{2}-\d{2}$/.test(query.from)) add((n) => `e.occurred_at >= ($${n}::date::timestamp AT TIME ZONE 'America/Paramaribo')`, query.from);
    if (query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to)) add((n) => `e.occurred_at < (($${n}::date + 1)::timestamp AT TIME ZONE 'America/Paramaribo')`, query.to);
    if (query.actor?.trim()) add((n) => `e.actor_description ILIKE $${n}`, `%${query.actor.trim()}%`);
    if (query.q?.trim()) {
      add((n) => `(e.summary ILIKE $${n} OR e.subject_description ILIKE $${n} OR e.new_value ILIKE $${n} OR e.previous_value ILIKE $${n})`, `%${query.q.trim()}%`);
    }
    return { where: clauses.join(' AND '), params };
  }

  async list(query: AuditQuery, restricted: boolean) {
    const { where, params } = this.filter(query, restricted);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const page = Math.max(query.page ?? 1, 1);
    const [{ total }] = await this.dataSource.query(`SELECT count(*)::int AS total FROM audit_event e WHERE ${where}`, params);
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT e.seq, e.id, e.occurred_at AS "occurredAt", e.event_type AS "eventType", e.actor_description AS "actor",
              e.represented_authority AS "onBehalfOf", e.subject_description AS "subject",
              e.previous_value AS "previousValue", e.new_value AS "newValue", e.summary, e.chain_hash AS "chainHash"
         FROM audit_event e WHERE ${where} ORDER BY e.seq DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params,
    );
    return { total, page, limit, data: rows.map((r) => ({ ...r, seq: Number(r.seq), category: categoryOf(r.eventType as string) })) };
  }

  /** Counts per category and per day, for the auditor's overview. */
  async overview(days: number, restricted: boolean) {
    const { where, params } = this.filter({}, restricted);
    params.push(days);
    const byType: { event_type: string; n: number }[] = await this.dataSource.query(
      `SELECT e.event_type, count(*)::int AS n FROM audit_event e WHERE ${where} AND e.occurred_at > now() - make_interval(days => $${params.length}) GROUP BY e.event_type`,
      params,
    );
    const byDay: { day: string; n: number }[] = await this.dataSource.query(
      `SELECT to_char(e.occurred_at AT TIME ZONE 'America/Paramaribo', 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM audit_event e WHERE ${where} AND e.occurred_at > now() - make_interval(days => $${params.length}) GROUP BY 1 ORDER BY 1`,
      params,
    );
    const categories: Record<string, number> = {};
    for (const r of byType) categories[categoryOf(r.event_type)] = (categories[categoryOf(r.event_type)] ?? 0) + r.n;
    const [failed] = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE event_type IN ('SIGN_IN_FAILED','MFA_FAILED','ACCOUNT_LOCKED','DOCUMENT_INTEGRITY_FAILED') AND occurred_at > now() - make_interval(days => $1)`,
      [days],
    );
    return { days, categories, byDay, attention: failed.n };
  }

  private async rows(query: AuditQuery, restricted: boolean) {
    const { where, params } = this.filter(query, restricted);
    const rows: Record<string, unknown>[] = await this.dataSource.query(
      `SELECT e.seq, to_char(e.occurred_at AT TIME ZONE 'America/Paramaribo', 'YYYY-MM-DD HH24:MI:SS') AS occurred, e.event_type, e.actor_description,
              e.represented_authority, e.subject_description, e.previous_value, e.new_value, e.summary, e.chain_hash
         FROM audit_event e WHERE ${where} ORDER BY e.seq LIMIT 50000`,
      params,
    );
    return rows;
  }

  private static COLUMNS: [string, string, number][] = [
    ['seq', 'Nr', 8],
    ['occurred', 'Tijdstip (Suriname)', 20],
    ['event_type', 'Gebeurtenis', 26],
    ['actor_description', 'Door', 34],
    ['represented_authority', 'Namens', 24],
    ['subject_description', 'Onderwerp', 40],
    ['previous_value', 'Was', 20],
    ['new_value', 'Wordt', 20],
    ['summary', 'Samenvatting', 70],
    ['chain_hash', 'Ketenhash', 66],
  ];

  async csv(actor: Actor, query: AuditQuery, restricted: boolean): Promise<{ bytes: Buffer; count: number }> {
    const rows = await this.rows(query, restricted);
    const cell = (v: unknown) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [AuditViewerService.COLUMNS.map((c) => c[1]).join(',')];
    for (const r of rows) lines.push(AuditViewerService.COLUMNS.map(([k]) => cell(r[k])).join(','));
    await this.recordExport(actor, query, 'CSV', rows.length);
    return { bytes: Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8'), count: rows.length };
  }

  async excel(actor: Actor, query: AuditQuery, restricted: boolean): Promise<{ bytes: Buffer; count: number }> {
    const rows = await this.rows(query, restricted);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Logboek');
    ws.addRow([`Logboek — export door ${actor.description}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`]).font = { bold: true };
    ws.addRow([describe(query)]).font = { italic: true, size: 9 };
    ws.addRow([]);
    const header = ws.addRow(AuditViewerService.COLUMNS.map((c) => c[1]));
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF15325B' } }));
    AuditViewerService.COLUMNS.forEach((c, i) => (ws.getColumn(i + 1).width = c[2]));
    for (const r of rows) {
      ws.addRow(AuditViewerService.COLUMNS.map(([k]) => {
        const v = r[k];
        if (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) return `'${v}`;
        return k === 'seq' ? Number(v) : v ?? '';
      }));
    }
    ws.views = [{ state: 'frozen', ySplit: 4 }];
    await this.recordExport(actor, query, 'Excel', rows.length);
    return { bytes: Buffer.from(await wb.xlsx.writeBuffer()), count: rows.length };
  }

  private async recordExport(actor: Actor, query: AuditQuery, format: string, count: number) {
    await this.audit.recordStrict({
      eventType: AuditEventType.AUDIT_EXPORTED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      subjectDescription: 'audit history',
      newValue: `${format}, ${count} events`,
      summary: `${actor.description} exported ${count} audit events as ${format} (${describe(query)}).`.slice(0, 600),
    });
  }
}

function describe(q: AuditQuery): string {
  const parts = [];
  if (q.from) parts.push(`vanaf ${q.from}`);
  if (q.to) parts.push(`tot en met ${q.to}`);
  if (q.category) parts.push(`categorie ${q.category}`);
  if (q.type) parts.push(`type ${q.type}`);
  if (q.actor) parts.push(`door "${q.actor}"`);
  if (q.q) parts.push(`tekst "${q.q}"`);
  return parts.length ? parts.join(', ') : 'alle gebeurtenissen';
}
