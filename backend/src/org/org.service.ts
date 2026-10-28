import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { assertPasswordPolicy } from '../auth/security.controller';
import { hashPassword } from '../auth/password';
import { SettingsService } from '../settings/settings.service';
import { Actor } from '../records/registration.service';

export interface UnitView {
  id: string;
  code: string;
  name: string;
  kind: string;
  isActive: boolean;
  parentUnitId: string | null;
  headAccountId: string | null;
  headName: string | null;
  memberCount: number;
}

export interface PersonView {
  accountId: string;
  personName: string;
  email: string;
  jobPosition: string | null;
  unitId: string | null;
  unit: string | null;
  roles: string[];
  isEnabled: boolean;
  absentUntil: string | null;
}

const KINDS = ['CABINET', 'DIRECTORATE', 'DEPARTMENT', 'DISTRICT', 'OFFICE', 'SERVICE'];

/**
 * The ministry's structure: units, their place under each other, their heads,
 * and the people in them.
 *
 * The heads matter for more than display: a missed deadline is escalated to
 * the head of the responsible person's unit, and on to the head above.
 */
@Injectable()
export class OrgService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  async units(): Promise<UnitView[]> {
    return this.dataSource.query(
      `SELECT u.id, u.code, u.name, u.kind, u.is_active AS "isActive", u.parent_unit_id AS "parentUnitId",
              u.head_account_id AS "headAccountId", hp.full_name AS "headName",
              (SELECT count(*)::int FROM account a WHERE a.organisational_unit_id = u.id AND a.is_enabled) AS "memberCount"
         FROM organisational_unit u
         LEFT JOIN account ha ON ha.id = u.head_account_id
         LEFT JOIN person hp ON hp.id = ha.person_id
        ORDER BY u.name`,
    );
  }

  async createUnit(actor: Actor, input: { code: string; name: string; kind?: string; parentUnitId?: string | null }): Promise<UnitView> {
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9-]{2,40}$/.test(code)) throw new BadRequestException('A unit code uses letters, digits and dashes.');
    if (input.kind && !KINDS.includes(input.kind)) throw new BadRequestException('Unknown unit kind.');
    if (input.parentUnitId) await this.unitOrFail(input.parentUnitId);
    const exists = await this.dataSource.query(`SELECT 1 FROM organisational_unit WHERE code = $1`, [code]);
    if (exists.length) throw new ConflictException('A unit with this code already exists.');
    const id = await this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(
        `INSERT INTO organisational_unit (code, name, kind, parent_unit_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, input.name.trim(), input.kind ?? 'DEPARTMENT', input.parentUnitId ?? null],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.UNIT_CREATED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${code} — ${input.name.trim()}`,
        summary: `${actor.description} created the unit ${input.name.trim()} (${code}).`,
      });
      return row.id as string;
    });
    return (await this.units()).find((u) => u.id === id) as UnitView;
  }

  async updateUnit(
    actor: Actor,
    id: string,
    input: { name?: string; kind?: string; parentUnitId?: string | null; headAccountId?: string | null; isActive?: boolean },
  ): Promise<UnitView> {
    const unit = await this.unitOrFail(id);
    if (input.kind && !KINDS.includes(input.kind)) throw new BadRequestException('Unknown unit kind.');
    if (input.parentUnitId) {
      if (input.parentUnitId === id) throw new BadRequestException('A unit cannot sit under itself.');
      await this.unitOrFail(input.parentUnitId);
      // Refuse a loop: the new parent may not be below this unit.
      const below: { id: string }[] = await this.dataSource.query(
        `WITH RECURSIVE sub AS (SELECT id FROM organisational_unit WHERE parent_unit_id = $1
                                UNION SELECT u.id FROM organisational_unit u JOIN sub ON u.parent_unit_id = sub.id)
         SELECT id FROM sub`,
        [id],
      );
      if (below.some((b) => b.id === input.parentUnitId)) throw new BadRequestException('That would place the unit under one of its own sub-units.');
    }
    if (input.headAccountId) {
      const head = await this.dataSource.query(`SELECT 1 FROM account WHERE id = $1 AND is_enabled`, [input.headAccountId]);
      if (!head.length) throw new NotFoundException('Unknown account for the head of unit.');
    }
    const changes: string[] = [];
    if (input.name !== undefined && input.name.trim() !== unit.name) changes.push(`name → ${input.name.trim()}`);
    if (input.kind !== undefined && input.kind !== unit.kind) changes.push(`kind → ${input.kind}`);
    if (input.parentUnitId !== undefined && input.parentUnitId !== unit.parent_unit_id) changes.push('parent changed');
    if (input.headAccountId !== undefined && input.headAccountId !== unit.head_account_id) changes.push('head changed');
    if (input.isActive !== undefined && input.isActive !== unit.is_active) changes.push(input.isActive ? 'reactivated' : 'deactivated');
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE organisational_unit SET
           name = coalesce($2, name), kind = coalesce($3, kind),
           parent_unit_id = CASE WHEN $4::boolean THEN $5::uuid ELSE parent_unit_id END,
           head_account_id = CASE WHEN $6::boolean THEN $7::uuid ELSE head_account_id END,
           is_active = coalesce($8, is_active)
         WHERE id = $1`,
        [
          id,
          input.name?.trim() ?? null,
          input.kind ?? null,
          input.parentUnitId !== undefined,
          input.parentUnitId ?? null,
          input.headAccountId !== undefined,
          input.headAccountId ?? null,
          input.isActive ?? null,
        ],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.UNIT_UPDATED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${unit.code} — ${unit.name}`,
        newValue: changes.join('; ').slice(0, 400) || 'no change',
        summary: `${actor.description} updated the unit ${unit.name}: ${changes.join('; ') || 'no change'}.`,
      });
    });
    return (await this.units()).find((u) => u.id === id) as UnitView;
  }

  async people(filter: { q?: string; role?: string; unitId?: string; includeDisabled?: boolean } = {}): Promise<PersonView[]> {
    const rows: (PersonView & { roles: string[] | null })[] = await this.dataSource.query(
      `SELECT a.id AS "accountId", p.full_name AS "personName", a.email, p.job_position AS "jobPosition",
              u.id AS "unitId", u.name AS "unit", a.is_enabled AS "isEnabled",
              array_remove(array_agg(DISTINCT r.code), NULL) AS roles,
              (SELECT to_char(max(o.ends_on), 'YYYY-MM-DD') FROM out_of_office o
                WHERE o.account_id = a.id AND o.ended_at IS NULL
                  AND o.starts_on <= (now() AT TIME ZONE 'America/Paramaribo')::date
                  AND o.ends_on >= (now() AT TIME ZONE 'America/Paramaribo')::date) AS "absentUntil"
         FROM account a
         JOIN person p ON p.id = a.person_id
         LEFT JOIN organisational_unit u ON u.id = a.organisational_unit_id
         LEFT JOIN role_assignment ra ON ra.account_id = a.id AND ra.revoked_at IS NULL
         LEFT JOIN functional_role r ON r.id = ra.functional_role_id
        WHERE ($1::boolean OR a.is_enabled)
          AND ($2::text IS NULL OR p.full_name ILIKE '%' || $2 || '%' OR a.email ILIKE '%' || $2 || '%')
          AND ($3::uuid IS NULL OR a.organisational_unit_id = $3)
        GROUP BY a.id, p.full_name, a.email, p.job_position, u.id, u.name
        ORDER BY p.full_name`,
      [filter.includeDisabled === true, filter.q?.trim() || null, filter.unitId || null],
    );
    return rows
      .map((r) => ({ ...r, roles: r.roles ?? [] }))
      .filter((r) => !filter.role || r.roles.includes(filter.role));
  }

  /**
   * Who a person answers to: the head of their unit, or — when they are that
   * head — the head of the unit above. Null when the structure does not say.
   */
  async supervisorOf(accountId: string): Promise<string | null> {
    const rows: { head: string | null }[] = await this.dataSource.query(
      `WITH RECURSIVE chain AS (
         SELECT u.id, u.parent_unit_id, u.head_account_id, 0 AS depth
           FROM account a JOIN organisational_unit u ON u.id = a.organisational_unit_id WHERE a.id = $1
         UNION ALL
         SELECT p.id, p.parent_unit_id, p.head_account_id, chain.depth + 1
           FROM organisational_unit p JOIN chain ON p.id = chain.parent_unit_id WHERE chain.depth < 10)
       SELECT head_account_id AS head FROM chain
        WHERE head_account_id IS NOT NULL AND head_account_id <> $1
        ORDER BY depth LIMIT 1`,
      [accountId],
    );
    return rows[0]?.head ?? null;
  }

  async createAccount(
    actor: Actor,
    input: { fullName: string; jobPosition?: string; email: string; unitId?: string | null; roles: string[]; initialPassword: string },
  ): Promise<PersonView> {
    const email = input.email.trim().toLowerCase();
    const security = await this.settings.get('security');
    assertPasswordPolicy(input.initialPassword, security.passwordMinLength);
    if ((await this.dataSource.query(`SELECT 1 FROM account WHERE email = $1`, [email])).length) {
      throw new ConflictException('An account with this e-mail address already exists.');
    }
    if (input.unitId) await this.unitOrFail(input.unitId);
    const roles = await this.dataSource.query(`SELECT id, code FROM functional_role WHERE code = ANY($1)`, [input.roles]);
    if (roles.length !== new Set(input.roles).size) throw new BadRequestException('Unknown functional role.');
    const hash = await hashPassword(input.initialPassword);
    const accountId = await this.dataSource.transaction(async (manager) => {
      const [person] = await manager.query(
        `INSERT INTO person (full_name, job_position) VALUES ($1, $2) RETURNING id`,
        [input.fullName.trim(), input.jobPosition?.trim() || null],
      );
      const [account] = await manager.query(
        `INSERT INTO account (email, password_hash, person_id, organisational_unit_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [email, hash, person.id, input.unitId ?? null],
      );
      for (const role of roles) {
        await manager.query(`INSERT INTO role_assignment (account_id, functional_role_id) VALUES ($1, $2)`, [account.id, role.id]);
      }
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.ACCOUNT_CREATED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${input.fullName.trim()} (${email})`,
        newValue: `roles: ${input.roles.join(', ') || 'none'}`,
        summary: `${actor.description} created the account ${email} for ${input.fullName.trim()} with roles ${input.roles.join(', ') || 'none'}.`,
      });
      return account.id as string;
    });
    return (await this.people({ includeDisabled: true })).find((p) => p.accountId === accountId) as PersonView;
  }

  async updateAccount(actor: Actor, accountId: string, input: { fullName?: string; jobPosition?: string | null; unitId?: string | null }): Promise<PersonView> {
    const [current] = await this.dataSource.query(
      `SELECT a.id, a.email, a.person_id, a.organisational_unit_id, p.full_name, p.job_position
         FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = $1`,
      [accountId],
    );
    if (!current) throw new NotFoundException('Unknown account.');
    if (input.unitId) await this.unitOrFail(input.unitId);
    const changes: string[] = [];
    if (input.fullName !== undefined && input.fullName.trim() !== current.full_name) changes.push(`name → ${input.fullName.trim()}`);
    if (input.jobPosition !== undefined && (input.jobPosition ?? null) !== current.job_position) changes.push(`position → ${input.jobPosition ?? '—'}`);
    if (input.unitId !== undefined && input.unitId !== current.organisational_unit_id) changes.push('unit changed');
    await this.dataSource.transaction(async (manager) => {
      if (input.fullName !== undefined || input.jobPosition !== undefined) {
        await manager.query(
          `UPDATE person SET full_name = coalesce($2, full_name),
             job_position = CASE WHEN $3::boolean THEN $4 ELSE job_position END WHERE id = $1`,
          [current.person_id, input.fullName?.trim() ?? null, input.jobPosition !== undefined, input.jobPosition ?? null],
        );
      }
      if (input.unitId !== undefined) {
        await manager.query(`UPDATE account SET organisational_unit_id = $2 WHERE id = $1`, [accountId, input.unitId]);
      }
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.ACCOUNT_UPDATED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${current.full_name} (${current.email})`,
        newValue: changes.join('; ').slice(0, 400) || 'no change',
        summary: `${actor.description} updated the account ${current.email}: ${changes.join('; ') || 'no change'}.`,
      });
    });
    return (await this.people({ includeDisabled: true })).find((p) => p.accountId === accountId) as PersonView;
  }

  async resetPassword(actor: Actor, accountId: string, newPassword: string): Promise<void> {
    const security = await this.settings.get('security');
    assertPasswordPolicy(newPassword, security.passwordMinLength);
    const [current] = await this.dataSource.query(`SELECT email FROM account WHERE id = $1`, [accountId]);
    if (!current) throw new NotFoundException('Unknown account.');
    const hash = await hashPassword(newPassword);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE account SET password_hash = $2 WHERE id = $1`, [accountId, hash]);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.PASSWORD_RESET,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: current.email,
        summary: `${actor.description} reset the password of ${current.email}.`,
      });
    });
  }

  private async unitOrFail(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Unknown unit.');
    const [unit] = await this.dataSource.query(`SELECT * FROM organisational_unit WHERE id = $1`, [id]);
    if (!unit) throw new NotFoundException('Unknown unit.');
    return unit;
  }
}
