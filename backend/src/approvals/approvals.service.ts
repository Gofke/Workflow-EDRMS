import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccessService } from '../access/access.service';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { DECISION_ROLES, readableDate, todayInSuriname } from '../common/actor';
import { NotificationService } from '../core/notification.service';
import { DelegationService } from '../delegation/delegation.service';
import { Actor } from '../records/registration.service';
import { WorkflowService } from '../workflow/workflow.service';

export interface RouteStep {
  role: 'ONDER_DIRECTEUR' | 'DIRECTEUR' | 'MINISTER';
  label: string;
}

const STEP_ROLES = ['ONDER_DIRECTEUR', 'DIRECTEUR', 'MINISTER'];

/**
 * Approval routes, advice requests and stand-ins.
 *
 * A route is a sequence of review steps — Onder-Directeur, then Directeur,
 * then Minister. Each step is decided by a designated reviewer who holds the
 * step's role; intermediate approvals are recorded per step, and only the last
 * step's decision makes the matter Approved, through the Delivery 1 approval
 * itself. A return at any step returns the matter; resubmitting starts the
 * route again from its first step.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly workflow: WorkflowService,
    private readonly notifications: NotificationService,
    private readonly delegations: DelegationService,
  ) {}

  // ------------------------------------------------------------- routes

  routes(includeInactive = false) {
    return this.dataSource.query(
      `SELECT id, name, description, steps, is_active AS "isActive", updated_at AS "updatedAt"
         FROM approval_route WHERE ($1::boolean OR is_active) ORDER BY name`,
      [includeInactive],
    );
  }

  async saveRoute(actor: Actor, id: string | null, input: { name: string; description?: string; steps: RouteStep[]; isActive?: boolean }) {
    if (!input.name?.trim()) throw new BadRequestException('A route needs a name.');
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 6) throw new BadRequestException('A route has one to six steps.');
    for (const step of input.steps) {
      if (!STEP_ROLES.includes(step.role)) throw new BadRequestException('Each step is decided by an Onder-Directeur, a Directeur or the Minister.');
      if (!step.label?.trim()) throw new BadRequestException('Each step needs a label.');
    }
    const steps = input.steps.map((s) => ({ role: s.role, label: s.label.trim().slice(0, 120) }));
    const saved = await this.dataSource.transaction(async (manager) => {
      let rowId = id;
      if (id) {
        const r = await manager.query(
          `UPDATE approval_route SET name = $2, description = $3, steps = $4, is_active = coalesce($5, is_active), updated_at = now() WHERE id = $1`,
          [id, input.name.trim(), input.description?.trim() ?? '', JSON.stringify(steps), input.isActive ?? null],
        );
        if (r[1] === 0) throw new NotFoundException('Unknown route.');
      } else {
        const [row] = await manager.query(
          `INSERT INTO approval_route (name, description, steps, created_by_account_id) VALUES ($1, $2, $3, $4) RETURNING id`,
          [input.name.trim(), input.description?.trim() ?? '', JSON.stringify(steps), actor.accountId],
        );
        rowId = row.id;
      }
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.ROUTE_SAVED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `route: ${input.name.trim()}`.slice(0, 260),
        newValue: steps.map((s) => s.label).join(' → ').slice(0, 400),
        summary: `${actor.description} ${id ? 'updated' : 'created'} the approval route ${input.name.trim()} (${steps.map((s) => s.label).join(' → ')}).`.slice(0, 600),
      });
      return rowId as string;
    });
    return (await this.routes(true)).find((r: { id: string }) => r.id === saved);
  }

  /** The route a matter is on, step by step, and who decided what. */
  async routeOf(dossierId: string) {
    const [active] = await this.dataSource.query(
      `SELECT dr.*, d.processing_state FROM dossier_route dr JOIN dossier d ON d.id = dr.dossier_id
        WHERE dr.dossier_id = $1 ORDER BY dr.started_at DESC LIMIT 1`,
      [dossierId],
    );
    if (!active) return null;
    await this.settle(active);
    const [route] = await this.dataSource.query(`SELECT * FROM dossier_route WHERE id = $1`, [active.id]);
    const decisions = await this.dataSource.query(
      `SELECT r.step_index AS "stepIndex", r.step_label AS "stepLabel", r.decision, r.note, r.occurred_at AS "occurredAt",
              p.full_name AS "actorName", np.full_name AS "nextReviewerName"
         FROM route_step_decision r JOIN account a ON a.id = r.actor_account_id JOIN person p ON p.id = a.person_id
         LEFT JOIN account na ON na.id = r.next_reviewer_account_id LEFT JOIN person np ON np.id = na.person_id
        WHERE r.dossier_route_id = $1 ORDER BY r.occurred_at`,
      [route.id],
    );
    const reviewer = route.completed_at ? null : await this.workflow.currentReviewer(dossierId);
    const [reviewerRow] = reviewer
      ? await this.dataSource.query(`SELECT p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = $1`, [reviewer])
      : [];
    const steps = (route.steps as RouteStep[]).map((s, i) => ({
      ...s,
      index: i,
      status: decisions.some((d: { stepIndex: number; decision: string }) => d.stepIndex === i && ['APPROVED', 'FINAL'].includes(d.decision))
        ? 'DONE'
        : !route.completed_at && i === route.current_step
          ? 'CURRENT'
          : route.ended_reason === 'RETURNED' && i === route.current_step
            ? 'RETURNED'
            : 'PENDING',
    }));
    return {
      id: route.id,
      routeId: route.route_id,
      name: route.route_name,
      currentStep: route.current_step,
      completedAt: route.completed_at,
      endedReason: route.ended_reason,
      currentReviewerAccountId: reviewer,
      currentReviewerName: reviewerRow?.full_name ?? null,
      steps,
      decisions,
    };
  }

  /** A route whose matter was returned or decided outside it is closed with the reason. */
  private async settle(route: { id: string; completed_at: string | null; processing_state: string }) {
    if (route.completed_at) return;
    if (route.processing_state === 'RETURNED') {
      await this.dataSource.query(`UPDATE dossier_route SET completed_at = now(), ended_reason = 'RETURNED' WHERE id = $1 AND completed_at IS NULL`, [route.id]);
    } else if (['APPROVED', 'FINALISED'].includes(route.processing_state)) {
      await this.dataSource.query(`UPDATE dossier_route SET completed_at = now(), ended_reason = 'APPROVED' WHERE id = $1 AND completed_at IS NULL`, [route.id]);
    }
  }

  async submitAlongRoute(actor: Actor, dossierId: string, routeId: string, reviewerAccountId: string, version: number) {
    const [route] = await this.dataSource.query(`SELECT * FROM approval_route WHERE id = $1 AND is_active`, [routeId]);
    if (!route) throw new NotFoundException('Unknown or inactive approval route.');
    const steps = route.steps as RouteStep[];
    await this.assertHoldsRole(reviewerAccountId, steps[0].role, steps[0].label);
    const previous = await this.dataSource.query(`SELECT id FROM dossier_route WHERE dossier_id = $1 AND completed_at IS NULL`, [dossierId]);
    for (const p of previous) {
      const [d] = await this.dataSource.query(`SELECT processing_state FROM dossier WHERE id = $1`, [dossierId]);
      await this.settle({ id: p.id, completed_at: null, processing_state: d.processing_state });
    }
    const state = await this.workflow.submit(actor, dossierId, reviewerAccountId, version);
    await this.dataSource.query(
      `INSERT INTO dossier_route (dossier_id, route_id, route_name, steps, current_step, started_by_account_id) VALUES ($1, $2, $3, $4, 0, $5)`,
      [dossierId, routeId, route.name, JSON.stringify(steps), actor.accountId],
    );
    return { ...state, route: await this.routeOf(dossierId) };
  }

  /**
   * The current step's reviewer approves it. On an intermediate step the matter
   * passes to the next reviewer; on the last step this is the approval itself.
   */
  async approveStep(actor: Actor, dossierId: string, version: number, nextReviewerAccountId?: string, note?: string) {
    const [route] = await this.dataSource.query(
      `SELECT dr.*, d.processing_state FROM dossier_route dr JOIN dossier d ON d.id = dr.dossier_id
        WHERE dr.dossier_id = $1 AND dr.completed_at IS NULL`,
      [dossierId],
    );
    if (!route) throw new BadRequestException('This matter is not on an approval route.');
    await this.settle(route);
    if (route.processing_state !== 'UNDER_REVIEW') throw new BadRequestException('This matter has no decision awaiting.');
    const steps = route.steps as RouteStep[];
    const i = route.current_step as number;
    const reviewer = await this.workflow.currentReviewer(dossierId);
    if (reviewer !== actor.accountId) throw new ForbiddenException('You are not permitted to decide on this matter.');
    const last = i === steps.length - 1;
    if (last) {
      const state = await this.workflow.approve(actor, dossierId, version);
      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO route_step_decision (dossier_route_id, dossier_id, step_index, step_label, decision, actor_account_id, reviewed_version, note)
           VALUES ($1, $2, $3, $4, 'FINAL', $5, $6, $7)`,
          [route.id, dossierId, i, steps[i].label, actor.accountId, version, note?.trim() || null],
        );
        await manager.query(`UPDATE dossier_route SET completed_at = now(), ended_reason = 'APPROVED' WHERE id = $1`, [route.id]);
      });
      return { ...state, route: await this.routeOf(dossierId) };
    }
    const next = steps[i + 1];
    const nextReviewer = nextReviewerAccountId ?? (await this.onlyHolderOf(next.role, actor.accountId));
    if (!nextReviewer) throw new BadRequestException(`Choose who decides the next step (${next.label}).`);
    await this.assertHoldsRole(nextReviewer, next.role, next.label);
    const state = await this.workflow.forward(actor, dossierId, nextReviewer, version, steps[i].label);
    const [d] = await this.dataSource.query(`SELECT dossier_identity, subject FROM dossier WHERE id = $1`, [dossierId]);
    await this.dataSource.transaction(async (manager) => {
      // The step is approved the moment before the matter goes on to the next reviewer, so the history reads in that order.
      await manager.query(
        `INSERT INTO route_step_decision (dossier_route_id, dossier_id, step_index, step_label, decision, actor_account_id, next_reviewer_account_id, reviewed_version, note, occurred_at)
         VALUES ($1, $2, $3, $4, 'APPROVED', $5, $6, $7, $8,
                 coalesce((SELECT max(occurred_at) FROM workflow_event WHERE dossier_id = $2) - interval '1 millisecond', now()))`,
        [route.id, dossierId, i, steps[i].label, actor.accountId, nextReviewer, version, note?.trim() || null],
      );
      await manager.query(`UPDATE dossier_route SET current_step = $2 WHERE id = $1`, [route.id, i + 1]);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.ROUTE_STEP_APPROVED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${d.dossier_identity} — ${d.subject}`.slice(0, 260),
        newValue: `step ${i + 1}/${steps.length}: ${steps[i].label}`,
        summary: `${actor.description} approved step ${i + 1} of ${steps.length} (${steps[i].label}) of ${d.dossier_identity}.`.slice(0, 600),
      });
    });
    return { ...state, route: await this.routeOf(dossierId) };
  }

  private async onlyHolderOf(role: string, exclude: string): Promise<string | null> {
    const rows: { id: string }[] = await this.dataSource.query(
      `SELECT DISTINCT a.id FROM account a JOIN role_assignment ra ON ra.account_id = a.id AND ra.revoked_at IS NULL
         JOIN functional_role r ON r.id = ra.functional_role_id WHERE r.code = $1 AND a.is_enabled AND a.id <> $2`,
      [role, exclude],
    );
    return rows.length === 1 ? rows[0].id : null;
  }

  private async assertHoldsRole(accountId: string, role: string, label: string): Promise<void> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM account a JOIN role_assignment ra ON ra.account_id = a.id AND ra.revoked_at IS NULL
         JOIN functional_role r ON r.id = ra.functional_role_id WHERE a.id = $1 AND a.is_enabled AND r.code = $2`,
      [accountId, role],
    );
    if (!rows.length) throw new BadRequestException(`The step "${label}" is decided by someone holding that role.`);
  }

  // ------------------------------------------------------------- advice

  advices(dossierId: string) {
    return this.dataSource.query(
      `SELECT ar.id, ar.question, to_char(ar.due_date, 'YYYY-MM-DD') AS "dueDate", ar.status, ar.answer,
              ar.requested_at AS "requestedAt", ar.answered_at AS "answeredAt", ar.withdrawn_reason AS "withdrawnReason",
              fp.full_name AS "requestedFromName", ar.requested_from_account_id AS "requestedFromAccountId",
              u.name AS "requestedFromUnit", rp.full_name AS "requestedByName", ar.requested_by_account_id AS "requestedByAccountId",
              gp.full_name AS "answeredByName"
         FROM advice_request ar
         JOIN account fa ON fa.id = ar.requested_from_account_id JOIN person fp ON fp.id = fa.person_id
         LEFT JOIN organisational_unit u ON u.id = fa.organisational_unit_id
         JOIN account ra ON ra.id = ar.requested_by_account_id JOIN person rp ON rp.id = ra.person_id
         LEFT JOIN account ga ON ga.id = ar.answered_by_account_id LEFT JOIN person gp ON gp.id = ga.person_id
        WHERE ar.dossier_id = $1 ORDER BY ar.requested_at`,
      [dossierId],
    );
  }

  async mine(accountId: string) {
    return this.dataSource.query(
      `SELECT ar.id, ar.question, to_char(ar.due_date, 'YYYY-MM-DD') AS "dueDate", ar.requested_at AS "requestedAt",
              d.id AS "dossierId", d.dossier_identity AS "dossierIdentity", d.subject, rp.full_name AS "requestedByName"
         FROM advice_request ar JOIN dossier d ON d.id = ar.dossier_id
         JOIN account ra ON ra.id = ar.requested_by_account_id JOIN person rp ON rp.id = ra.person_id
        WHERE ar.requested_from_account_id = $1 AND ar.status = 'OPEN' ORDER BY ar.due_date NULLS LAST, ar.requested_at`,
      [accountId],
    );
  }

  async requestAdvice(actor: Actor, dossierId: string, input: { requestedFromAccountId: string; question: string; dueDate?: string | null }) {
    const [d] = await this.dataSource.query(`SELECT dossier_identity, subject, state FROM dossier WHERE id = $1`, [dossierId]);
    if (!d) throw new NotFoundException('Unknown dossier.');
    if (d.state === 'CLOSED') throw new BadRequestException('This dossier is closed. Reopen the dossier before changing it.');
    if (!input.question?.trim()) throw new BadRequestException('Write the question you are asking.');
    if (input.requestedFromAccountId === actor.accountId) throw new BadRequestException('You cannot ask yourself for advice.');
    const [target] = await this.dataSource.query(
      `SELECT a.id, a.organisational_unit_id, p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = $1 AND a.is_enabled`,
      [input.requestedFromAccountId],
    );
    if (!target) throw new BadRequestException('That person is not an active account.');
    if (input.dueDate && input.dueDate < todayInSuriname()) throw new BadRequestException('The advice date cannot be in the past.');
    const id = await this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(
        `INSERT INTO advice_request (dossier_id, requested_from_account_id, requested_from_unit_id, question, due_date, requested_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [dossierId, target.id, target.organisational_unit_id, input.question.trim(), input.dueDate ?? null, actor.accountId],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.ADVICE_REQUESTED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${d.dossier_identity} — ${d.subject}`.slice(0, 260),
        newValue: `from ${target.full_name}${input.dueDate ? ` by ${input.dueDate}` : ''}`,
        summary: `${actor.description} asked ${target.full_name} for advice on ${d.dossier_identity}.`.slice(0, 600),
      });
      return row.id as string;
    });
    await this.notifications.notify({
      recipients: [target.id],
      kind: 'ADVICE_REQUESTED',
      params: { identity: d.dossier_identity, actor: name(actor), due: input.dueDate ? readableDate(input.dueDate) : null, excerpt: input.question.trim().slice(0, 160) },
      link: `/zaken/${dossierId}`,
      subjectType: 'DOSSIER',
      subjectId: dossierId,
      actorAccountId: actor.accountId,
    });
    return (await this.advices(dossierId)).find((a: { id: string }) => a.id === id);
  }

  async answer(actor: Actor, adviceId: string, answer: string) {
    const [a] = await this.dataSource.query(
      `SELECT ar.*, d.dossier_identity, d.subject FROM advice_request ar JOIN dossier d ON d.id = ar.dossier_id WHERE ar.id = $1`,
      [adviceId],
    );
    if (!a) throw new NotFoundException('Unknown advice request.');
    if (a.requested_from_account_id !== actor.accountId) throw new ForbiddenException('Only the person asked may give this advice.');
    if (a.status !== 'OPEN') throw new BadRequestException('This request has already been answered or withdrawn.');
    if (!answer?.trim()) throw new BadRequestException('The advice cannot be empty.');
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE advice_request SET status = 'ANSWERED', answer = $2, answered_by_account_id = $3, answered_at = now() WHERE id = $1`,
        [adviceId, answer.trim(), actor.accountId],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.ADVICE_GIVEN,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${a.dossier_identity} — ${a.subject}`.slice(0, 260),
        summary: `${actor.description} gave advice on ${a.dossier_identity}.`,
      });
    });
    await this.notifications.notify({
      recipients: [a.requested_by_account_id],
      kind: 'ADVICE_GIVEN',
      params: { identity: a.dossier_identity, actor: name(actor) },
      link: `/zaken/${a.dossier_id}`,
      subjectType: 'DOSSIER',
      subjectId: a.dossier_id,
      actorAccountId: actor.accountId,
    });
    return (await this.advices(a.dossier_id)).find((x: { id: string }) => x.id === adviceId);
  }

  async withdraw(actor: Actor, adviceId: string, reason: string) {
    const [a] = await this.dataSource.query(
      `SELECT ar.*, d.dossier_identity, d.subject FROM advice_request ar JOIN dossier d ON d.id = ar.dossier_id WHERE ar.id = $1`,
      [adviceId],
    );
    if (!a) throw new NotFoundException('Unknown advice request.');
    if (a.requested_by_account_id !== actor.accountId) throw new ForbiddenException('Only the person who asked may withdraw the request.');
    if (a.status !== 'OPEN') throw new BadRequestException('This request has already been answered or withdrawn.');
    if (!reason?.trim()) throw new BadRequestException('A reason is required.');
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE advice_request SET status = 'WITHDRAWN', withdrawn_reason = $2 WHERE id = $1`, [adviceId, reason.trim()]);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.ADVICE_WITHDRAWN,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${a.dossier_identity} — ${a.subject}`.slice(0, 260),
        summary: `${actor.description} withdrew an advice request on ${a.dossier_identity} (reason: ${reason.trim()}).`.slice(0, 600),
      });
    });
    return (await this.advices(a.dossier_id)).find((x: { id: string }) => x.id === adviceId);
  }

  async assertAdviceVisible(accountId: string, adviceId: string): Promise<string> {
    const [a] = await this.dataSource.query(`SELECT dossier_id FROM advice_request WHERE id = $1`, [adviceId]);
    if (!a) throw new NotFoundException('Unknown advice request.');
    await this.access.assertDossier(accountId, a.dossier_id);
    return a.dossier_id;
  }

  // ------------------------------------------------------------- out of office

  async myAbsences(accountId: string) {
    return this.dataSource.query(
      `SELECT o.id, to_char(o.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(o.ends_on, 'YYYY-MM-DD') AS "endsOn", o.message,
              o.ended_at AS "endedAt", p.full_name AS "standInName", o.stand_in_account_id AS "standInAccountId", o.delegation_id AS "delegationId"
         FROM out_of_office o JOIN account a ON a.id = o.stand_in_account_id JOIN person p ON p.id = a.person_id
        WHERE o.account_id = $1 ORDER BY o.starts_on DESC`,
      [accountId],
    );
  }

  async standingIn(accountId: string) {
    return this.dataSource.query(
      `SELECT o.id, to_char(o.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(o.ends_on, 'YYYY-MM-DD') AS "endsOn", o.message,
              p.full_name AS "absentName", o.account_id AS "absentAccountId"
         FROM out_of_office o JOIN account a ON a.id = o.account_id JOIN person p ON p.id = a.person_id
        WHERE o.stand_in_account_id = $1 AND o.ended_at IS NULL AND o.ends_on >= (now() AT TIME ZONE 'America/Paramaribo')::date
        ORDER BY o.starts_on`,
      [accountId],
    );
  }

  async setAbsence(
    actor: Actor & { roles: string[] },
    input: { startsOn: string; endsOn: string; standInAccountId: string; message?: string; delegate?: boolean },
  ) {
    if (input.endsOn < input.startsOn) throw new BadRequestException('The absence must start before it ends.');
    if (input.endsOn < todayInSuriname()) throw new BadRequestException('The absence lies in the past.');
    if (input.standInAccountId === actor.accountId) throw new BadRequestException('Choose someone else as your stand-in.');
    const [standIn] = await this.dataSource.query(
      `SELECT a.id, p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = $1 AND a.is_enabled`,
      [input.standInAccountId],
    );
    if (!standIn) throw new BadRequestException('That stand-in is not an active account.');
    const overlap = await this.dataSource.query(
      `SELECT 1 FROM out_of_office WHERE account_id = $1 AND ended_at IS NULL AND starts_on <= $3 AND ends_on >= $2`,
      [actor.accountId, input.startsOn, input.endsOn],
    );
    if (overlap.length) throw new BadRequestException('You already have an absence in this period.');
    // Where the absent person may delegate, the stand-in receives the delegatable
    // authority for the period, through the Delivery 1 delegation itself.
    let delegationId: string | null = null;
    if (input.delegate !== false && actor.roles.some((r) => DECISION_ROLES.includes(r))) {
      const delegation = await this.delegations.grant(actor, {
        delegateAccountId: input.standInAccountId,
        actions: ['ASSIGN_RESPONSIBILITY', 'SET_DUE_DATE'],
        validFrom: `${input.startsOn}T00:00:00-03:00`,
        validUntil: `${input.endsOn}T23:59:59-03:00`,
      });
      delegationId = delegation.id;
    }
    const id = await this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(
        `INSERT INTO out_of_office (account_id, starts_on, ends_on, stand_in_account_id, message, delegation_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [actor.accountId, input.startsOn, input.endsOn, input.standInAccountId, input.message?.trim() ?? '', delegationId],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.OUT_OF_OFFICE_SET,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        newValue: `${input.startsOn} – ${input.endsOn}, stand-in ${standIn.full_name}${delegationId ? ', with delegation' : ''}`,
        summary: `${actor.description} will be away from ${input.startsOn} to ${input.endsOn}; ${standIn.full_name} stands in${delegationId ? ' with delegated authority' : ''}.`.slice(0, 600),
      });
      return row.id as string;
    });
    await this.notifications.notify({
      recipients: [input.standInAccountId],
      kind: 'OUT_OF_OFFICE',
      params: { person: name(actor), from: readableDate(input.startsOn), until: readableDate(input.endsOn) },
      link: '/mijn-werk',
      actorAccountId: actor.accountId,
    });
    return (await this.myAbsences(actor.accountId)).find((a: { id: string }) => a.id === id);
  }

  async endAbsence(actor: Actor, id: string) {
    const [o] = await this.dataSource.query(`SELECT * FROM out_of_office WHERE id = $1 AND account_id = $2 AND ended_at IS NULL`, [id, actor.accountId]);
    if (!o) throw new NotFoundException('Unknown or already ended absence.');
    if (o.delegation_id) {
      await this.delegations.revoke(actor, o.delegation_id).catch(() => undefined);
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE out_of_office SET ended_at = now() WHERE id = $1`, [id]);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.OUT_OF_OFFICE_ENDED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        summary: `${actor.description} ended their absence early.`,
      });
    });
    return this.myAbsences(actor.accountId);
  }
}

function name(actor: Actor): string {
  return actor.description.replace(/\s*\([^)]*@[^)]*\)\s*$/, '');
}
