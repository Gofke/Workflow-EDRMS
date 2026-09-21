import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { loadDossierClosureConfig } from '../config/dossier-closure-config';
import { Account } from '../identity/account.entity';
import { ProcessingState } from '../workflow/workflow.entity';
import { Dossier, DossierState, DossierStateEvent } from './dossier.entity';
import { Actor } from './registration.service';

export interface DossierStateEventView {
  fromState: DossierState;
  toState: DossierState;
  actorName: string;
  reason: string | null;
  occurredAt: string;
}

/**
 * Closing and reopening the matter file (FR-DOS-006, 007, 008; UC-15).
 *
 * Closure says the matter is complete, so it needs a finalised result behind it.
 * Reopening is an explicit, reasoned event that returns the file to active
 * handling without erasing the closure it follows. Neither touches the
 * processing state: a reopened file whose work also needs redoing is then
 * reopened in the workflow, as its own decision.
 */
@Injectable()
export class DossierClosureService {
  private readonly config = loadDossierClosureConfig();

  constructor(
    @InjectRepository(Dossier) private readonly dossiers: Repository<Dossier>,
    @InjectRepository(DossierStateEvent) private readonly events: Repository<DossierStateEvent>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async close(actor: Actor, dossierId: string, reason: string | null, version: number) {
    const dossier = await this.load(dossierId, version);
    if (dossier.state === DossierState.CLOSED) {
      throw new BadRequestException('This dossier is already closed.');
    }
    if (dossier.processingState !== ProcessingState.FINALISED) {
      throw new BadRequestException(
        'A dossier can be closed only when its matter is finalised. Finalise the matter first.',
      );
    }
    await this.assertMayClose(actor.accountId);

    const cleanReason = reason && reason.trim().length > 0 ? reason.trim() : null;
    await this.transition(dossier, DossierState.CLOSED, actor, cleanReason, {
      eventType: AuditEventType.DOSSIER_CLOSED,
      summary:
        `${actor.description} closed dossier ${dossier.dossierIdentity}` +
        (cleanReason ? ` (reason: ${cleanReason}).` : '.'),
    });
    return this.stateOf(dossierId);
  }

  async reopen(actor: Actor, dossierId: string, reason: string, version: number) {
    const dossier = await this.load(dossierId, version);
    if (dossier.state !== DossierState.CLOSED) {
      throw new BadRequestException('Only a closed dossier can be reopened.');
    }
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('A reason is required when reopening a closed dossier.');
    }
    await this.assertMayClose(actor.accountId);

    await this.transition(dossier, DossierState.REOPENED, actor, reason.trim(), {
      eventType: AuditEventType.DOSSIER_REOPENED,
      summary: `${actor.description} reopened the closed dossier ${dossier.dossierIdentity} (reason: ${reason.trim()}).`,
    });
    return this.stateOf(dossierId);
  }

  async historyFor(dossierId: string): Promise<DossierStateEventView[]> {
    const exists = await this.dossiers.exist({ where: { id: dossierId } });
    if (!exists) throw new NotFoundException('Unknown dossier.');
    const events = await this.events.find({
      where: { dossier: { id: dossierId } },
      relations: { actor: { person: true } },
      order: { occurredAt: 'ASC' },
    });
    return events.map((event) => ({
      fromState: event.fromState,
      toState: event.toState,
      actorName: event.actor.person.fullName,
      reason: event.reason,
      occurredAt: event.occurredAt.toISOString(),
    }));
  }

  /** The event first, then the state: the trigger refuses the other order. */
  private async transition(
    dossier: Dossier,
    to: DossierState,
    actor: Actor,
    reason: string | null,
    audit: { eventType: AuditEventType; summary: string },
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO dossier_state_event (dossier_id, from_state, to_state, actor_account_id, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [dossier.id, dossier.state, to, actor.accountId, reason],
      );
      const [, affected] = await manager.query(
        `UPDATE dossier SET state = $1, version = version + 1 WHERE id = $2 AND version = $3`,
        [to, dossier.id, dossier.version],
      );
      if (affected !== 1) throw this.stale();
      await this.audit.recordInTransaction(manager, {
        eventType: audit.eventType,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${dossier.dossierIdentity} — ${dossier.subject}`,
        previousValue: dossier.state.toLowerCase(),
        newValue: to.toLowerCase(),
        summary: audit.summary,
      });
    });
  }

  private async assertMayClose(accountId: string): Promise<void> {
    const account = await this.accounts.findOne({
      where: { id: accountId },
      relations: { roleAssignments: { role: true } },
    });
    const roles = (account?.roleAssignments ?? [])
      .filter((assignment) => assignment.revokedAt === null)
      .map((assignment) => assignment.role.code);
    if (!roles.some((role) => this.config.rolesThatMayClose.includes(role))) {
      throw new ForbiddenException('You are not permitted to close or reopen a dossier.');
    }
  }

  private async load(id: string, version: number): Promise<Dossier> {
    const dossier = await this.dossiers.findOne({ where: { id } });
    if (!dossier) throw new NotFoundException('Unknown dossier.');
    if (dossier.version !== version) throw this.stale();
    return dossier;
  }

  private async stateOf(dossierId: string) {
    const dossier = await this.dossiers.findOneOrFail({ where: { id: dossierId } });
    return { state: dossier.state, processingState: dossier.processingState, version: dossier.version };
  }

  private stale() {
    return new ConflictException(
      'This dossier changed while you were working on it. Reload and try again.',
    );
  }
}
