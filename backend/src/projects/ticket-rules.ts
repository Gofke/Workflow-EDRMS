import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../records/registration.service';

/**
 * The rules a project ticket follows wherever it is created or changed — the
 * project screens, the task screens, subtasks and bulk assignment — so that
 * need-to-know cannot be side-stepped through another door. Every function runs
 * inside the caller's transaction.
 */

/** Ministry roles that can hold a place on a project (never the system administrator or an auditor alone). */
export const PROJECT_PERSON_ROLES = ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER', 'RECORDS_MANAGER'];

export interface TicketProject {
  id: string;
  reference: string;
  status: string;
  businessCaseStatus: string;
  ownerAccountId: string;
  managerAccountId: string;
  milestone: { id: string; status: string; gate: string | null };
}

type Db = Pick<EntityManager, 'query'>;

/**
 * The project of a phase, locked for the rest of the transaction, so that a
 * business case submission or a phase close and a new ticket cannot pass each
 * other.
 */
export async function lockTicketProject(m: EntityManager, milestoneId: string): Promise<TicketProject> {
  // First the lock; then a fresh read, so that a phase closed while this waited is seen as closed.
  const [locked] = await m.query(`SELECT id FROM project WHERE id = (SELECT project_id FROM project_milestone WHERE id = $1) FOR UPDATE`, [milestoneId]);
  if (!locked) throw new BadRequestException('Choose a phase of this project.');
  const [row] = await m.query(
    `SELECT p.id, p.reference, p.status, p.business_case_status, p.owner_account_id, p.manager_account_id,
            pm.id AS milestone_id, pm.status AS milestone_status, pm.gate
       FROM project_milestone pm JOIN project p ON p.id = pm.project_id
      WHERE pm.id = $1`,
    [milestoneId],
  );
  if (!row) throw new BadRequestException('Choose a phase of this project.');
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    businessCaseStatus: row.business_case_status,
    ownerAccountId: row.owner_account_id,
    managerAccountId: row.manager_account_id,
    milestone: { id: row.milestone_id, status: row.milestone_status, gate: row.gate },
  };
}

/** A phase that may take new or reopened work: a running project, an open phase, a business case not yet submitted. */
export function assertPhaseTakesWork(p: TicketProject): void {
  if (!['PROPOSED', 'ACTIVE'].includes(p.status)) throw new BadRequestException('Tickets can only be added or reopened in a running project.');
  if (p.milestone.status === 'CLOSED') throw new BadRequestException('This phase is closed.');
  if (p.milestone.gate === 'BUSINESS_CASE' && ['SUBMITTED', 'APPROVED'].includes(p.businessCaseStatus)) {
    throw new BadRequestException('The business case has been submitted; its phase takes no new work.');
  }
}

export function leads(p: Pick<TicketProject, 'ownerAccountId' | 'managerAccountId'>, accountId: string): boolean {
  return p.ownerAccountId === accountId || p.managerAccountId === accountId;
}

/** The owner, the project manager, or an active stakeholder or team member. */
export async function isOnProject(db: Db, projectId: string, accountId: string): Promise<boolean> {
  const [row] = await db.query(
    `SELECT 1 FROM project p WHERE p.id = $1 AND (p.owner_account_id = $2 OR p.manager_account_id = $2
        OR EXISTS (SELECT 1 FROM project_member pm WHERE pm.project_id = p.id AND pm.account_id = $2 AND pm.removed_at IS NULL))`,
    [projectId, accountId],
  );
  return !!row;
}

export async function isProjectPerson(db: Db, accountId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(accountId ?? '')) return false;
  const [row] = await db.query(
    `SELECT 1 FROM account a WHERE a.id = $1 AND a.is_enabled
        AND EXISTS (SELECT 1 FROM role_assignment ra JOIN functional_role fr ON fr.id = ra.functional_role_id
                     WHERE ra.account_id = a.id AND ra.revoked_at IS NULL AND fr.code = ANY($2))`,
    [accountId, PROJECT_PERSON_ROLES],
  );
  return !!row;
}

/**
 * Whoever holds a ticket is on the team. A person who was removed comes back as
 * a team member — never in an earlier, wider role. The owner and the manager
 * are on the project already; an active stakeholder keeps that role.
 */
export async function joinAsTicketHolder(m: EntityManager, audit: AuditService, actor: Actor, p: TicketProject, accountId: string, ticketReference: string): Promise<void> {
  if (leads(p, accountId)) return;
  const added = await m.query(
    `INSERT INTO project_member (project_id, account_id, role, added_by_account_id) VALUES ($1, $2, 'MEMBER', $3)
     ON CONFLICT (project_id, account_id) DO UPDATE
        SET removed_at = NULL, role = 'MEMBER', added_by_account_id = EXCLUDED.added_by_account_id, added_at = now()
      WHERE project_member.removed_at IS NOT NULL
     RETURNING account_id`,
    [p.id, accountId, actor.accountId],
  );
  if (!added.length) return;
  const [person] = await m.query(`SELECT pe.full_name FROM account a JOIN person pe ON pe.id = a.person_id WHERE a.id = $1`, [accountId]);
  const who = person?.full_name ?? 'unknown';
  await m.query(`INSERT INTO project_event (project_id, event_type, actor_account_id, note) VALUES ($1, 'MEMBER_ADDED', $2, $3)`, [
    p.id,
    actor.accountId,
    `${who} (team, through ticket ${ticketReference})`.slice(0, 600),
  ]);
  await audit.recordInTransaction(m, {
    eventType: AuditEventType.PROJECT_MEMBER_ADDED,
    actorAccountId: actor.accountId,
    actorDescription: actor.description,
    representedAuthority: actor.representedAuthority ?? null,
    subjectDescription: p.reference,
    newValue: `${who}: member`,
    summary: `${actor.description} added ${who} to project ${p.reference} with ticket ${ticketReference}.`.slice(0, 600),
  });
}

/**
 * SQL: the task on alias is not a ticket of a confidential project. Ministry-wide
 * figures (dashboards, workload, the weekly report) leave those out: even the
 * number of tickets is need-to-know.
 */
export const notConfidentialTicket = (alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM project_milestone pmx JOIN project px ON px.id = pmx.project_id
                WHERE pmx.id = ${alias}.project_milestone_id AND px.classification = 'CONFIDENTIAL')`;

/**
 * SQL: of the accounts in $2 (uuid[]), those who may see ticket $1 — the same rule
 * as TasksService.visibility for tickets. Notifications about a ticket go only to them.
 */
export const TICKET_READERS = `
  SELECT r.id FROM unnest($2::uuid[]) AS r(id)
    JOIN task t ON t.id = $1
    JOIN project_milestone pm ON pm.id = t.project_milestone_id
    JOIN project p ON p.id = pm.project_id
   WHERE r.id = t.assignee_account_id OR r.id = p.owner_account_id OR r.id = p.manager_account_id
      OR ((r.id = t.created_by_account_id OR r.id = t.owner_account_id
           OR EXISTS (SELECT 1 FROM task_audience ta WHERE ta.task_id = t.id AND ta.account_id = r.id))
          AND EXISTS (SELECT 1 FROM project_member mm WHERE mm.project_id = p.id AND mm.account_id = r.id AND mm.removed_at IS NULL))`;
