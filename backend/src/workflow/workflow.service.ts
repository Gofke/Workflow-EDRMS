import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { loadWorkflowConfig } from '../config/workflow-config';
import { DelegationService } from '../delegation/delegation.service';
import { Account } from '../identity/account.entity';
import { assertDossierNotClosed, Dossier, DossierLink } from '../records/dossier.entity';
import { Actor } from '../records/registration.service';
import { ProcessingState, WorkflowEvent, WorkflowEventType } from './workflow.entity';

/** Roles that may decide. Preparation does not create approval authority. */
const REVIEWER_ROLES = ['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR'];

@Injectable()
export class WorkflowService {
  private readonly config = loadWorkflowConfig();

  constructor(
    @InjectRepository(Dossier) private readonly dossiers: Repository<Dossier>,
    @InjectRepository(DossierLink) private readonly links: Repository<DossierLink>,
    @InjectRepository(WorkflowEvent) private readonly events: Repository<WorkflowEvent>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly delegations: DelegationService,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** Officials who may be designated as reviewer (FR-WFL-002, FR-WFL-004). */
  async eligibleReviewers(excludeAccountId: string) {
    const accounts = await this.accounts.find({
      where: { isEnabled: true },
      relations: { person: true, roleAssignments: { role: true } },
      order: { email: 'ASC' },
    });
    return accounts
      .filter((account) => {
        if (account.id === excludeAccountId) return false;
        const roles = (account.roleAssignments ?? [])
          .filter((a) => a.revokedAt === null)
          .map((a) => a.role.code);
        return roles.some((role) => REVIEWER_ROLES.includes(role));
      })
      .map((account) => ({ accountId: account.id, personName: account.person.fullName }));
  }

  /**
   * Submits a matter to a designated reviewer.
   *
   * Support staff may do this in their own right (FR-WFL-013): preparing and
   * routing a package is their work, and routing confers no decision authority
   * on them.
   */
  async submit(actor: Actor, dossierId: string, reviewerAccountId: string, version: number) {
    const dossier = await this.load(dossierId);
    if (dossier.version !== version) throw this.stale();
    if (![ProcessingState.ACTIVE, ProcessingState.RETURNED].includes(dossier.processingState)) {
      throw new BadRequestException(
        `A matter that is ${readable(dossier.processingState)} cannot be submitted for review.`,
      );
    }
    if (reviewerAccountId === actor.accountId) {
      throw new BadRequestException('You cannot send a matter to yourself for review.');
    }
    await this.assertReviewAuthority(reviewerAccountId);

    const resubmission = dossier.processingState === ProcessingState.RETURNED;
    const snapshot = await this.snapshot(dossier);

    const reviewer = await this.accounts.findOne({
      where: { id: reviewerAccountId },
      relations: { person: true },
    });

    await this.transition(
      dossier,
      ProcessingState.UNDER_REVIEW,
      {
        eventType: WorkflowEventType.SUBMITTED,
        actorAccountId: actor.accountId,
        onBehalfOfAccountId: actor.onBehalfOfAccountId ?? null,
        reviewerAccountId,
        reason: null,
        snapshot,
        reviewedVersion: dossier.version + 1,
      },
      {
        eventType: AuditEventType.WORKFLOW_SUBMITTED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${dossier.dossierIdentity} — ${dossier.subject}`,
        previousValue: dossier.processingState,
        newValue: `under review by ${reviewer?.person.fullName}`,
        summary: `${actor.description} ${resubmission ? 'resubmitted' : 'submitted'} ${dossier.dossierIdentity} for review by ${reviewer?.person.fullName}.`,
      },
    );

    return this.stateOf(dossierId);
  }

  /**
   * Returns a matter for correction. A reason is required, and the return event
   * is evidence: correcting the work afterwards never alters it (FR-WFL-007,
   * FR-WFL-008).
   */
  async returnForCorrection(actor: Actor, dossierId: string, reason: string, version: number) {
    const { dossier, submission } = await this.loadUnderReview(dossierId, version);
    const authority = await this.decisionAuthority(actor, submission);

    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('A reason is required when returning a matter for correction.');
    }

    await this.transition(
      dossier,
      ProcessingState.RETURNED,
      {
        eventType: WorkflowEventType.RETURNED,
        actorAccountId: actor.accountId,
        onBehalfOfAccountId: authority.onBehalfOfAccountId,
        reviewerAccountId: submission.reviewer?.id ?? null,
        reason: reason.trim(),
        snapshot: submission.reviewedSnapshot,
        reviewedVersion: submission.reviewedVersion,
      },
      {
        eventType: AuditEventType.WORKFLOW_RETURNED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: authority.representedAuthority,
        subjectDescription: `${dossier.dossierIdentity} — ${dossier.subject}`,
        previousValue: 'under review',
        newValue: 'returned for correction',
        summary: `${actor.description} returned ${dossier.dossierIdentity} for correction (reason: ${reason.trim()}).`,
      },
    );

    return this.stateOf(dossierId);
  }

  /**
   * Records approval.
   *
   * FR-WFL-014: what is approved must be what was reviewed. The approval is
   * bound to the submission's version, and if the matter has changed since it
   * was submitted the approval is refused rather than applied to content nobody
   * reviewed. The correct remedy is to resubmit, which is a new decision.
   */
  async approve(actor: Actor, dossierId: string, version: number) {
    const { dossier, submission } = await this.loadUnderReview(dossierId, version);
    const authority = await this.decisionAuthority(actor, submission);

    if (dossier.version !== submission.reviewedVersion) {
      throw new ConflictException(
        'This matter has changed since it was submitted. It must be resubmitted so the reviewer sees what they are approving.',
      );
    }
    const current = await this.snapshot(dossier);
    if (JSON.stringify(current.records) !== JSON.stringify(submission.reviewedSnapshot.records)) {
      throw new ConflictException(
        'The records in this matter have changed since it was submitted. It must be resubmitted before approval.',
      );
    }

    await this.transition(
      dossier,
      ProcessingState.APPROVED,
      {
        eventType: WorkflowEventType.APPROVED,
        actorAccountId: actor.accountId,
        onBehalfOfAccountId: authority.onBehalfOfAccountId,
        reviewerAccountId: submission.reviewer?.id ?? null,
        reason: null,
        snapshot: submission.reviewedSnapshot,
        reviewedVersion: submission.reviewedVersion,
      },
      {
        eventType: AuditEventType.WORKFLOW_APPROVED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: authority.representedAuthority,
        subjectDescription: `${dossier.dossierIdentity} — ${dossier.subject}`,
        previousValue: 'under review',
        newValue: `approved at version ${submission.reviewedVersion}`,
        summary: `${actor.description} approved ${dossier.dossierIdentity} as reviewed at version ${submission.reviewedVersion}.`,
      },
    );

    return this.stateOf(dossierId);
  }

  /**
   * Finalises an approved matter (FR-FIN-001, FR-FIN-002).
   *
   * FR-WFL-012: finalisation is refused unless the required approval evidence
   * exists for the version being finalised. An approval recorded against an
   * earlier version does not carry forward — that would finalise a result
   * nobody approved.
   */
  async finalise(actor: Actor, dossierId: string, version: number) {
    const dossier = await this.load(dossierId);
    if (dossier.version !== version) throw this.stale();
    if (dossier.processingState !== ProcessingState.APPROVED) {
      throw new BadRequestException(
        `A matter that is ${readable(dossier.processingState)} cannot be finalised. It must be approved first.`,
      );
    }

    const approval = await this.events.findOne({
      where: { dossier: { id: dossierId }, eventType: WorkflowEventType.APPROVED },
      relations: { actor: { person: true } },
      order: { occurredAt: 'DESC' },
    });
    if (!approval) {
      throw new BadRequestException(
        'This matter cannot be finalised: no approval decision is recorded for it.',
      );
    }
    await this.assertDecisionRole(actor.accountId);

    await this.transition(
      dossier,
      ProcessingState.FINALISED,
      {
        eventType: WorkflowEventType.FINALISED,
        actorAccountId: actor.accountId,
        onBehalfOfAccountId: actor.onBehalfOfAccountId ?? null,
        reviewerAccountId: null,
        reason: null,
        snapshot: approval.reviewedSnapshot,
        reviewedVersion: approval.reviewedVersion,
      },
      {
        eventType: AuditEventType.WORKFLOW_FINALISED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${dossier.dossierIdentity} — ${dossier.subject}`,
        previousValue: 'approved',
        newValue: `finalised on the approval by ${approval.actor.person.fullName} at version ${approval.reviewedVersion}`,
        summary: `${actor.description} finalised ${dossier.dossierIdentity}, on the approval recorded by ${approval.actor.person.fullName}.`,
      },
    );

    return this.stateOf(dossierId);
  }

  /**
   * Reopens a finalised matter (FR-FIN-004).
   *
   * An explicit, reasoned, authorised event. The finalisation it supersedes is
   * not erased, amended or hidden: it stays in the history, and the reopening
   * is recorded beside it.
   */
  async reopen(actor: Actor, dossierId: string, reason: string, version: number) {
    const dossier = await this.load(dossierId);
    if (dossier.version !== version) throw this.stale();
    if (dossier.processingState !== ProcessingState.FINALISED) {
      throw new BadRequestException(
        `Only a finalised matter can be reopened. This one is ${readable(dossier.processingState)}.`,
      );
    }
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('A reason is required when reopening a finalised matter.');
    }
    await this.assertDecisionRole(actor.accountId);

    await this.transition(
      dossier,
      ProcessingState.ACTIVE,
      {
        eventType: WorkflowEventType.REOPENED,
        actorAccountId: actor.accountId,
        onBehalfOfAccountId: actor.onBehalfOfAccountId ?? null,
        reviewerAccountId: null,
        reason: reason.trim(),
        snapshot: await this.snapshot(dossier),
        reviewedVersion: dossier.version + 1,
      },
      {
        eventType: AuditEventType.WORKFLOW_REOPENED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${dossier.dossierIdentity} — ${dossier.subject}`,
        previousValue: 'finalised',
        newValue: 'reopened for further handling',
        summary: `${actor.description} reopened the finalised matter ${dossier.dossierIdentity} (reason: ${reason.trim()}).`,
      },
    );

    return this.stateOf(dossierId);
  }

  /**
   * Finalisation and reopening are decision-maker acts, not preparation.
   * Support staff may route work; they may not close it or undo its closure.
   */
  private async assertDecisionRole(accountId: string): Promise<void> {
    const account = await this.accounts.findOne({
      where: { id: accountId },
      relations: { roleAssignments: { role: true } },
    });
    const roles = (account?.roleAssignments ?? [])
      .filter((a) => a.revokedAt === null)
      .map((a) => a.role.code);
    if (!roles.some((role) => REVIEWER_ROLES.includes(role))) {
      throw new ForbiddenException('You are not permitted to perform this action.');
    }
  }

  /** The decision history, oldest first. Every event survives (FR-WFL-009). */
  async historyFor(dossierId: string) {
    const events = await this.events.find({
      where: { dossier: { id: dossierId } },
      relations: {
        actor: { person: true },
        onBehalfOf: { person: true },
        reviewer: { person: true },
      },
      order: { occurredAt: 'ASC' },
    });
    return events.map((event) => ({
      eventType: event.eventType,
      actorName: event.actor.person.fullName,
      onBehalfOfName: event.onBehalfOf?.person?.fullName ?? null,
      reviewerName: event.reviewer?.person?.fullName ?? null,
      reason: event.reason,
      reviewedVersion: event.reviewedVersion,
      occurredAt: event.occurredAt.toISOString(),
    }));
  }

  /** Matters awaiting this reviewer's decision. */
  async reviewQueueFor(accountId: string) {
    const rows = await this.dossiers.find({
      where: { processingState: ProcessingState.UNDER_REVIEW },
      order: { createdAt: 'DESC' },
    });
    const queue = [];
    for (const dossier of rows) {
      const submission = await this.latestSubmission(dossier.id);
      if (submission?.reviewer?.id === accountId) {
        queue.push({
          dossierId: dossier.id,
          dossierIdentity: dossier.dossierIdentity,
          subject: dossier.subject,
          submittedByName: submission.actor.person.fullName,
          submittedAt: submission.occurredAt.toISOString(),
        });
      }
    }
    return queue;
  }

  /**
   * Who may decide on this submission: the designated reviewer, or someone
   * holding an explicit delegation of approval authority from them — which is
   * off unless DEC-13 configuration enables it.
   */
  private async decisionAuthority(actor: Actor, submission: WorkflowEvent) {
    const reviewerId = submission.reviewer?.id;
    if (reviewerId === actor.accountId) {
      return { onBehalfOfAccountId: null, representedAuthority: null };
    }

    if (this.config.approvalDelegationEnabled) {
      const authority = await this.delegations.authorityFor(actor.accountId, 'APPROVE_ON_BEHALF');
      if (authority && authority.principalAccountId === reviewerId) {
        return {
          onBehalfOfAccountId: authority.principalAccountId,
          representedAuthority: authority.principalDescription,
        };
      }
    }
    // The refusal names no one: a denial should not disclose who may decide.
    throw new ForbiddenException('You are not permitted to decide on this matter.');
  }

  private async assertReviewAuthority(accountId: string): Promise<void> {
    const account = await this.accounts.findOne({
      where: { id: accountId },
      relations: { roleAssignments: { role: true } },
    });
    if (!account) throw new NotFoundException('Unknown account.');
    if (!account.isEnabled) {
      throw new BadRequestException('That account is disabled and cannot review.');
    }
    const roles = (account.roleAssignments ?? [])
      .filter((a) => a.revokedAt === null)
      .map((a) => a.role.code);
    if (!roles.some((role) => REVIEWER_ROLES.includes(role))) {
      throw new BadRequestException('That person holds no review authority for this matter.');
    }
  }

  /** Writes the event, then moves the state. The trigger requires this order. */
  private async transition(
    dossier: Dossier,
    to: ProcessingState,
    event: {
      eventType: WorkflowEventType;
      actorAccountId: string;
      onBehalfOfAccountId: string | null;
      reviewerAccountId: string | null;
      reason: string | null;
      snapshot: Record<string, unknown>;
      /**
       * The version the event refers to. For a submission that is the version
       * the matter will hold while under review — its own state change bumps
       * the version, and that bump is not "the matter changed". For a decision
       * it is the version that was actually decided on.
       */
      reviewedVersion: number;
    },
    /** Written inside the same transaction: no decision without its evidence. */
    auditEntry: Parameters<AuditService['recordInTransaction']>[1],
  ): Promise<void> {
    // FR-DOS-007: no workflow move on a closed file, including a reopening of
    // its processing. The dossier is reopened first, as its own decision.
    assertDossierNotClosed(dossier);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO workflow_event (dossier_id, event_type, actor_account_id,
           on_behalf_of_account_id, reviewer_account_id, reason, reviewed_version,
           reviewed_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          dossier.id,
          event.eventType,
          event.actorAccountId,
          event.onBehalfOfAccountId,
          event.reviewerAccountId,
          event.reason,
          event.reviewedVersion,
          JSON.stringify(event.snapshot),
        ],
      );
      await manager.query(
        `UPDATE dossier SET processing_state = $1, version = version + 1 WHERE id = $2`,
        [to, dossier.id],
      );
      await this.audit.recordInTransaction(manager, auditEntry);
    });
  }

  /** The matter as a reviewer sees it: its records and their content hashes. */
  private async snapshot(dossier: Dossier): Promise<Record<string, unknown>> {
    const links = await this.links.find({
      where: { dossier: { id: dossier.id } },
      relations: { item: true },
    });
    const documents = await this.dataSource.query(
      `SELECT cd.content_hash FROM captured_document cd
         JOIN dossier_link dl ON dl.correspondence_item_id = cd.correspondence_item_id
        WHERE dl.dossier_id = $1 ORDER BY cd.content_hash`,
      [dossier.id],
    );
    return {
      subject: dossier.subject,
      dueDate: dossier.dueDate,
      records: links
        .map((link) => link.item.registrationIdentity ?? link.item.id)
        .sort(),
      documentHashes: documents.map((d: { content_hash: string }) => d.content_hash),
    };
  }

  private async latestSubmission(dossierId: string): Promise<WorkflowEvent | null> {
    return this.events.findOne({
      where: { dossier: { id: dossierId }, eventType: WorkflowEventType.SUBMITTED },
      relations: { reviewer: true, actor: { person: true } },
      order: { occurredAt: 'DESC' },
    });
  }

  private async loadUnderReview(dossierId: string, version: number) {
    const dossier = await this.load(dossierId);
    if (dossier.version !== version) throw this.stale();
    if (dossier.processingState !== ProcessingState.UNDER_REVIEW) {
      throw new BadRequestException(
        `This matter is ${readable(dossier.processingState)} and has no decision awaiting.`,
      );
    }
    const submission = await this.latestSubmission(dossierId);
    if (!submission) throw new BadRequestException('No submission was found for this matter.');
    return { dossier, submission };
  }

  private async load(id: string): Promise<Dossier> {
    const dossier = await this.dossiers.findOne({ where: { id } });
    if (!dossier) throw new NotFoundException('Unknown dossier.');
    return dossier;
  }

  private async stateOf(dossierId: string) {
    const dossier = await this.load(dossierId);
    return { processingState: dossier.processingState, version: dossier.version };
  }

  private stale() {
    return new ConflictException(
      'This matter changed while you were working on it. Reload and try again.',
    );
  }
}

function readable(state: string): string {
  return state.toLowerCase().replace('_', ' ');
}
