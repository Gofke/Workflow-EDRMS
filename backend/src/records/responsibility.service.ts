import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { loadRegistrationConfig } from '../config/registration-config';
import { Account } from '../identity/account.entity';
import { Dossier, assertDossierNotClosed } from './dossier.entity';
import { Actor } from './registration.service';
import { DueDateChange, ResponsibilityAssignment } from './responsibility.entity';

/** Renders the represented authority into a readable summary, when there is one. */
function onBehalf(actor: Actor): string {
  return actor.representedAuthority ? `, acting on behalf of ${actor.representedAuthority}` : '';
}

/** Roles that may hold official responsibility for a matter (FS-02 §4). */
const ELIGIBLE_ROLES = ['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR'];

@Injectable()
export class ResponsibilityService {
  private readonly config = loadRegistrationConfig();

  constructor(
    @InjectRepository(Dossier) private readonly dossiers: Repository<Dossier>,
    @InjectRepository(ResponsibilityAssignment)
    private readonly assignments: Repository<ResponsibilityAssignment>,
    @InjectRepository(DueDateChange) private readonly changes: Repository<DueDateChange>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Assigns or reassigns responsibility.
   *
   * Reassignment supersedes the previous assignment inside one transaction
   * rather than editing it, so the earlier owner, the actor who assigned them
   * and the time it happened all survive (FR-OWN-003).
   */
  async assign(actor: Actor, dossierId: string, accountId: string, version: number) {
    const dossier = await this.dossiers.findOne({ where: { id: dossierId } });
    if (!dossier) throw new NotFoundException('Unknown dossier.');
    if (dossier.version !== version) {
      throw new ConflictException('This dossier changed while you were working on it. Reload and try again.');
    }

    this.assertNotFinalised(dossier);
    const target = await this.eligibleTarget(accountId);
    const current = await this.assignments.findOne({
      where: { dossier: { id: dossierId }, supersededAt: IsNull() },
      relations: { responsible: { person: true } },
    });

    if (current && current.responsible.id === accountId) {
      throw new BadRequestException('That person already holds responsibility for this matter.');
    }

    const previousName = current?.responsible?.person?.fullName ?? null;
    const assignEntry = {
      eventType: current
        ? AuditEventType.RESPONSIBILITY_REASSIGNED
        : AuditEventType.RESPONSIBILITY_ASSIGNED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      representedAuthority: actor.representedAuthority ?? null,
      subjectDescription: `${dossier.dossierIdentity} — ${dossier.subject}`,
      previousValue: previousName,
      newValue: target.person.fullName,
      summary:
        (current
          ? `${actor.description} moved responsibility for ${dossier.dossierIdentity} from ${previousName} to ${target.person.fullName}`
          : `${actor.description} assigned responsibility for ${dossier.dossierIdentity} to ${target.person.fullName}`) +
        onBehalf(actor) +
        '.',
    };

    await this.dataSource.transaction(async (manager) => {
      if (current) {
        await manager.query(
          `UPDATE responsibility_assignment SET superseded_at = now() WHERE id = $1`,
          [current.id],
        );
      }
      await manager.query(
        `INSERT INTO responsibility_assignment
           (dossier_id, responsible_account_id, assigned_by_account_id, on_behalf_of_account_id)
         VALUES ($1, $2, $3, $4)`,
        [dossierId, accountId, actor.accountId, actor.onBehalfOfAccountId ?? null],
      );
      await manager.query(`UPDATE dossier SET version = version + 1 WHERE id = $1`, [dossierId]);
      // One transaction: the assignment and its evidence stand or fall together.
      await this.audit.recordInTransaction(manager, assignEntry);
    });
  }

  /**
   * Sets, changes or removes the official due date.
   *
   * DEC-12 — which due-date changes require a reason — is OPEN. The
   * configuration decides; the code asserts nothing. Removal is a change to no
   * date, recorded as an event rather than an erasure.
   */
  async setDueDate(
    actor: Actor,
    dossierId: string,
    newDueDate: string | null,
    reason: string | null,
    version: number,
  ) {
    const dossier = await this.dossiers.findOne({ where: { id: dossierId } });
    if (!dossier) throw new NotFoundException('Unknown dossier.');
    if (dossier.version !== version) {
      throw new ConflictException('This dossier changed while you were working on it. Reload and try again.');
    }

    this.assertNotFinalised(dossier);

    const previous = dossier.dueDate ?? null;
    if (previous === newDueDate) {
      throw new BadRequestException('That is already the official due date for this matter.');
    }
    if (this.reasonRequired(previous, newDueDate) && (!reason || reason.trim() === '')) {
      throw new BadRequestException(
        'A reason is required for this change to the official due date.',
      );
    }

    const dueDateEntry = {
      eventType: previous ? AuditEventType.DUE_DATE_CHANGED : AuditEventType.DUE_DATE_SET,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      representedAuthority: actor.representedAuthority ?? null,
      subjectDescription: `${dossier.dossierIdentity} — ${dossier.subject}`,
      previousValue: previous,
      newValue: newDueDate ?? 'no due date',
      summary:
        (previous
          ? `${actor.description} changed the official due date of ${dossier.dossierIdentity} from ${previous} to ${newDueDate ?? 'no due date'}${reason ? ` (reason: ${reason.trim()})` : ''}`
          : `${actor.description} set the official due date of ${dossier.dossierIdentity} to ${newDueDate}`) +
        onBehalf(actor) +
        '.',
    };

    await this.dataSource.transaction(async (manager) => {
      // History first, then the current value: the dossier trigger refuses a
      // due-date move that has no matching history row.
      await manager.query(
        `INSERT INTO due_date_change
           (dossier_id, previous_due_date, new_due_date, reason, changed_by_account_id,
            on_behalf_of_account_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          dossierId,
          previous,
          newDueDate,
          reason?.trim() ?? null,
          actor.accountId,
          actor.onBehalfOfAccountId ?? null,
        ],
      );
      await manager.query(`UPDATE dossier SET due_date = $1, version = version + 1 WHERE id = $2`, [
        newDueDate,
        dossierId,
      ]);
      await this.audit.recordInTransaction(manager, dueDateEntry);
    });
  }

  /** Current responsibility plus its full history, for one dossier. */
  async historyFor(dossierId: string) {
    const assignments = await this.assignments.find({
      where: { dossier: { id: dossierId } },
      relations: {
        responsible: { person: true },
        assignedBy: { person: true },
        onBehalfOf: { person: true },
      },
      order: { assignedAt: 'ASC' },
    });
    const dueDates = await this.changes.find({
      where: { dossier: { id: dossierId } },
      relations: { changedBy: { person: true }, onBehalfOf: { person: true } },
      order: { changedAt: 'ASC' },
    });

    return {
      responsibility: assignments.map((a) => ({
        responsibleName: a.responsible.person.fullName,
        assignedByName: a.assignedBy.person.fullName,
        onBehalfOfName: a.onBehalfOf?.person?.fullName ?? null,
        assignedAt: a.assignedAt.toISOString(),
        supersededAt: a.supersededAt ? a.supersededAt.toISOString() : null,
        isCurrent: a.supersededAt === null,
      })),
      dueDates: dueDates.map((c) => ({
        onBehalfOfName: c.onBehalfOf?.person?.fullName ?? null,
        previousDueDate: c.previousDueDate,
        newDueDate: c.newDueDate,
        reason: c.reason,
        changedByName: c.changedBy.person.fullName,
        changedAt: c.changedAt.toISOString(),
      })),
    };
  }

  /**
   * The officials who may be given responsibility, for the assignment picker.
   *
   * Names and identifiers only — no email addresses, no account state. An
   * assigner needs to identify the right person (UC-04 step 2), not to read the
   * account register, which remains administration's own data.
   */
  async assignableOfficials(): Promise<{ accountId: string; personName: string; roles: string[] }[]> {
    const accounts = await this.accounts.find({
      where: { isEnabled: true },
      relations: { person: true, roleAssignments: { role: true } },
      order: { email: 'ASC' },
    });

    return accounts
      .map((account) => ({
        accountId: account.id,
        personName: account.person.fullName,
        roles: (account.roleAssignments ?? [])
          .filter((a) => a.revokedAt === null)
          .map((a) => a.role.code),
      }))
      .filter((entry) => entry.roles.some((code) => ELIGIBLE_ROLES.includes(code)));
  }

  /** Who may be given responsibility — and who may not. */
  private async eligibleTarget(accountId: string): Promise<Account> {
    const account = await this.accounts.findOne({
      where: { id: accountId },
      relations: { person: true, roleAssignments: { role: true } },
    });
    if (!account) throw new NotFoundException('Unknown account.');
    if (!account.isEnabled) {
      throw new BadRequestException('That account is disabled and cannot hold responsibility.');
    }

    const roles = (account.roleAssignments ?? [])
      .filter((a) => a.revokedAt === null)
      .map((a) => a.role.code);

    // Support staff prepare work; they do not hold official responsibility
    // without an explicit delegation, which Delivery 1 has not built
    // (FR-DEL-005). The administrator holds no business role at all.
    if (!roles.some((code) => ELIGIBLE_ROLES.includes(code))) {
      throw new BadRequestException(
        'That person does not hold a role that can carry official responsibility for a matter.',
      );
    }
    return account;
  }

  /**
   * FR-FIN-003: finalised evidence is protected from ordinary change. Altering
   * the owner or the deadline of a finalised matter is not a correction — it is
   * a change to a closed result, and needs an explicit reopening first.
   */
  private assertNotFinalised(dossier: {
    state: string;
    processingState: string;
    dossierIdentity: string;
  }): void {
    assertDossierNotClosed(dossier);
    if (dossier.processingState === 'FINALISED') {
      throw new BadRequestException(
        `${dossier.dossierIdentity} is finalised. Reopen it before changing responsibility or the due date.`,
      );
    }
  }

  private reasonRequired(previous: string | null, next: string | null): boolean {
    switch (this.config.dueDateReasonRequiredOn) {
      case 'always':
        return true;
      case 'never':
        return false;
      default:
        // 'change': the first date needs no reason; moving or removing an
        // existing official deadline does.
        return previous !== null;
    }
  }
}
