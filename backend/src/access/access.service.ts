import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BUSINESS_ROLES } from '../common/actor';
import { SettingsService } from '../settings/settings.service';

export type Level = 'OPEN' | 'INTERNAL' | 'CONFIDENTIAL' | 'SECRET';
export const LEVELS: Level[] = ['OPEN', 'INTERNAL', 'CONFIDENTIAL', 'SECRET'];

/** What the evaluator knows about the person asking. */
export interface AccessProfile {
  accountId: string;
  roles: string[];
  unitId: string | null;
  /** Holds a role whose work is the ministry's records. */
  business: boolean;
  confidential: boolean;
  secret: boolean;
  unitSeesConfidential: boolean;
}

/**
 * The record-level permission evaluator (FR-SEC-003), provisional.
 *
 * DEC-02 — sensitivity and need-to-know — is still open. This implements a
 * conservative reading so the rest of Phase 3 can be built on one evaluator
 * instead of each screen deciding for itself. The clearances per role live in
 * the classification settings, so the Ministry's decision is applied there.
 *
 *   OPEN, INTERNAL  — anyone holding a business role (what Delivery 1 did).
 *   CONFIDENTIAL    — the cleared roles; members of the owning unit; anyone
 *                     with a relationship to the matter.
 *   SECRET          — the cleared roles and anyone with a relationship only.
 *
 * A relationship is: created it, is currently responsible, holds an active
 * need-to-know grant, was designated reviewer, holds or owns a task on it, or
 * was asked for advice on it.
 *
 * System administration never grants content (FR-SEC-010). A refusal looks the
 * same as a record that does not exist, so a classified matter cannot be
 * discovered by guessing its identifier.
 *
 * The predicates are SQL so that lists, search, dashboards, exports and the AI
 * assistant all filter in the database, the same way, before anything leaves.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
  ) {}

  async profile(accountId: string): Promise<AccessProfile> {
    const rows: { code: string; unit_id: string | null }[] = await this.dataSource.query(
      `SELECT r.code, a.organisational_unit_id AS unit_id
         FROM account a
         LEFT JOIN role_assignment ra ON ra.account_id = a.id AND ra.revoked_at IS NULL
         LEFT JOIN functional_role r ON r.id = ra.functional_role_id
        WHERE a.id = $1 AND a.is_enabled = true`,
      [accountId],
    );
    const roles = rows.map((r) => r.code).filter(Boolean);
    const c = await this.settings.get('classification');
    return {
      accountId,
      roles,
      unitId: rows[0]?.unit_id ?? null,
      business: roles.some((r) => BUSINESS_ROLES.includes(r)),
      confidential: roles.some((r) => c.confidentialRoles.includes(r)),
      secret: roles.some((r) => c.secretRoles.includes(r)),
      unitSeesConfidential: c.unitSeesConfidential,
    };
  }

  /**
   * A WHERE fragment over a dossier alias. `next` is the next free $n
   * parameter number; the fragment's parameters are returned for appending.
   */
  dossierPredicate(p: AccessProfile, alias: string, next: number): { sql: string; params: unknown[] } {
    if (!p.business) return { sql: 'false', params: [] };
    const me = `$${next}`;
    const relation = `(
         ${alias}.created_by_account_id = ${me}
      OR EXISTS (SELECT 1 FROM responsibility_assignment ra_x
                  WHERE ra_x.dossier_id = ${alias}.id AND ra_x.superseded_at IS NULL
                    AND ra_x.responsible_account_id = ${me})
      OR EXISTS (SELECT 1 FROM record_access_grant g_x
                  WHERE g_x.subject_type = 'DOSSIER' AND g_x.subject_id = ${alias}.id
                    AND g_x.account_id = ${me} AND g_x.revoked_at IS NULL)
      OR EXISTS (SELECT 1 FROM workflow_event we_x
                  WHERE we_x.dossier_id = ${alias}.id AND we_x.reviewer_account_id = ${me})
      OR EXISTS (SELECT 1 FROM task t_x
                  WHERE t_x.dossier_id = ${alias}.id
                    AND (t_x.assignee_account_id = ${me} OR t_x.owner_account_id = ${me}))
      OR EXISTS (SELECT 1 FROM advice_request ar_x
                  WHERE ar_x.dossier_id = ${alias}.id AND ar_x.requested_from_account_id = ${me})
    )`;
    const unit = p.unitId && p.unitSeesConfidential ? `${alias}.owning_unit_id = $${next + 1}` : 'false';
    const sql = `(
         ${alias}.classification IN ('OPEN','INTERNAL')
      OR (${alias}.classification = 'CONFIDENTIAL' AND (${p.confidential || p.secret ? 'true' : 'false'} OR ${unit} OR ${relation}))
      OR (${alias}.classification = 'SECRET' AND (${p.secret ? 'true' : 'false'} OR ${relation}))
    )`;
    const params: unknown[] = [p.accountId];
    if (p.unitId && p.unitSeesConfidential) params.push(p.unitId);
    return { sql, params };
  }

  /** The same evaluation for a correspondence item. */
  itemPredicate(p: AccessProfile, alias: string, next: number): { sql: string; params: unknown[] } {
    if (!p.business) return { sql: 'false', params: [] };
    const me = `$${next}`;
    const relation = `(
         ${alias}.created_by_account_id = ${me}
      OR EXISTS (SELECT 1 FROM record_access_grant g_y
                  WHERE g_y.subject_type = 'ITEM' AND g_y.subject_id = ${alias}.id
                    AND g_y.account_id = ${me} AND g_y.revoked_at IS NULL)
      OR EXISTS (SELECT 1 FROM dossier_link dl_y
                   JOIN responsibility_assignment ra_y
                     ON ra_y.dossier_id = dl_y.dossier_id AND ra_y.superseded_at IS NULL
                  WHERE dl_y.correspondence_item_id = ${alias}.id AND ra_y.responsible_account_id = ${me})
      OR EXISTS (SELECT 1 FROM task t_y
                  WHERE t_y.correspondence_item_id = ${alias}.id
                    AND (t_y.assignee_account_id = ${me} OR t_y.owner_account_id = ${me}))
    )`;
    const unit = p.unitId && p.unitSeesConfidential ? `${alias}.owning_unit_id = $${next + 1}` : 'false';
    const sql = `(
         ${alias}.classification IN ('OPEN','INTERNAL')
      OR (${alias}.classification = 'CONFIDENTIAL' AND (${p.confidential || p.secret ? 'true' : 'false'} OR ${unit} OR ${relation}))
      OR (${alias}.classification = 'SECRET' AND (${p.secret ? 'true' : 'false'} OR ${relation}))
    )`;
    const params: unknown[] = [p.accountId];
    if (p.unitId && p.unitSeesConfidential) params.push(p.unitId);
    return { sql, params };
  }

  async canViewDossier(p: AccessProfile, dossierId: string): Promise<boolean> {
    const pred = this.dossierPredicate(p, 'd', 2);
    const rows = await this.dataSource.query(
      `SELECT 1 FROM dossier d WHERE d.id = $1 AND ${pred.sql}`,
      [dossierId, ...pred.params],
    );
    return rows.length > 0;
  }

  async canViewItem(p: AccessProfile, itemId: string): Promise<boolean> {
    const pred = this.itemPredicate(p, 'ci', 2);
    const rows = await this.dataSource.query(
      `SELECT 1 FROM correspondence_item ci WHERE ci.id = $1 AND ${pred.sql}`,
      [itemId, ...pred.params],
    );
    return rows.length > 0;
  }

  /** Refuses as "not found", so classified matters cannot be probed for. */
  async assertDossier(accountId: string, dossierId: string): Promise<AccessProfile> {
    const p = await this.profile(accountId);
    if (!isUuid(dossierId) || !(await this.canViewDossier(p, dossierId))) {
      throw new NotFoundException('Unknown dossier.');
    }
    return p;
  }

  async assertItem(accountId: string, itemId: string): Promise<AccessProfile> {
    const p = await this.profile(accountId);
    if (!isUuid(itemId) || !(await this.canViewItem(p, itemId))) {
      throw new NotFoundException('Unknown item.');
    }
    return p;
  }

  /** Ids of the dossiers this person may see, for in-memory filtering of small lists. */
  async visibleDossierIds(p: AccessProfile): Promise<Set<string>> {
    const pred = this.dossierPredicate(p, 'd', 1);
    const rows: { id: string }[] = await this.dataSource.query(
      `SELECT d.id FROM dossier d WHERE ${pred.sql}`,
      pred.params,
    );
    return new Set(rows.map((r) => r.id));
  }

  async visibleItemIds(p: AccessProfile): Promise<Set<string>> {
    const pred = this.itemPredicate(p, 'ci', 1);
    const rows: { id: string }[] = await this.dataSource.query(
      `SELECT ci.id FROM correspondence_item ci WHERE ${pred.sql}`,
      pred.params,
    );
    return new Set(rows.map((r) => r.id));
  }

  /** Records that someone opened a record. Append-only. */
  async recordView(accountId: string, subjectType: 'DOSSIER' | 'ITEM' | 'DOCUMENT' | 'TASK', subjectId: string, label: string, kind = 'OPENED'): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO record_view_event (account_id, subject_type, subject_id, subject_label, view_kind)
       VALUES ($1, $2, $3, $4, $5)`,
      [accountId, subjectType, subjectId, label.slice(0, 260), kind],
    );
  }
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? '');
}
