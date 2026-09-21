import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { loadDelegationConfig } from '../config/delegation-config';
import { Account } from '../identity/account.entity';
import { Delegation } from './delegation.entity';

export interface DelegationView {
  id: string;
  principalName: string;
  delegateName: string;
  permittedActions: string[];
  validFrom: string;
  validUntil: string;
  grantedByName: string;
  revokedAt: string | null;
  isActive: boolean;
}

/** The authority a delegate currently holds for one action. */
export interface RepresentedAuthority {
  delegationId: string;
  principalAccountId: string;
  principalDescription: string;
}

@Injectable()
export class DelegationService {
  private readonly config = loadDelegationConfig();

  constructor(
    @InjectRepository(Delegation) private readonly delegations: Repository<Delegation>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Resolves whether this account may currently perform this action under
   * someone else's authority.
   *
   * Three things must hold together: the delegation is not revoked, now falls
   * inside its period, and the action is explicitly listed. A delegation that
   * covers a different action grants nothing here (FR-DEL-004).
   *
   * The principal is re-checked at use, not only at grant: if they have since
   * lost the role or been disabled, the delegation confers nothing, because
   * nobody can delegate authority they no longer hold.
   */
  async authorityFor(delegateAccountId: string, action: string): Promise<RepresentedAuthority | null> {
    const candidates = await this.delegations.find({
      where: { delegate: { id: delegateAccountId } },
      relations: { principal: { person: true, roleAssignments: { role: true } } },
      order: { grantedAt: 'DESC' },
    });

    const now = Date.now();
    for (const delegation of candidates) {
      if (delegation.revokedAt !== null) continue;
      if (delegation.validFrom.getTime() > now || delegation.validUntil.getTime() < now) continue;
      if (!this.actionsOf(delegation).includes(action)) continue;

      const principal = delegation.principal;
      if (!principal.isEnabled) continue;
      const principalRoles = (principal.roleAssignments ?? [])
        .filter((a) => a.revokedAt === null)
        .map((a) => a.role.code);
      if (!principalRoles.some((role) => this.config.rolesThatMayDelegate.includes(role))) continue;

      return {
        delegationId: delegation.id,
        principalAccountId: principal.id,
        principalDescription: `${principal.person.fullName} (${principal.email})`,
      };
    }
    return null;
  }

  /**
   * Who may receive delegated authority: any enabled account holding a business
   * role. Support staff are the usual delegates, which is the whole point of
   * FR-DEL-005, so the list of people who may *carry* responsibility is the
   * wrong list to offer here.
   *
   * The administrator is excluded — a business action performed under an
   * administrator account would defeat FR-SEC-010. Names and identifiers only.
   */
  async delegationCandidates(): Promise<{ accountId: string; personName: string }[]> {
    const accounts = await this.accounts.find({
      where: { isEnabled: true },
      relations: { person: true, roleAssignments: { role: true } },
      order: { email: 'ASC' },
    });

    return accounts
      .filter((account) => {
        const roles = (account.roleAssignments ?? [])
          .filter((a) => a.revokedAt === null)
          .map((a) => a.role.code);
        return roles.length > 0 && !roles.includes('SYS_ADMIN');
      })
      .map((account) => ({ accountId: account.id, personName: account.person.fullName }));
  }

  /**
   * What this user may currently do, and under whose authority.
   *
   * The interface needs this: gating the controls on the user's own roles alone
   * hides delegated authority from the person who holds it, which makes the
   * whole mechanism unusable by its intended user — support staff.
   *
   * Each entry names the principal, so the delegate can see whose authority
   * they are about to use before they use it. Convenience may reduce clicks; it
   * may not blur whose authority is in play.
   */
  async currentAuthority(
    accountId: string,
    ownRoles: string[],
  ): Promise<{ action: string; viaDelegationFrom: string | null }[]> {
    const result: { action: string; viaDelegationFrom: string | null }[] = [];
    const holdsRoleAuthority = ownRoles.some((role) =>
      this.config.rolesThatMayDelegate.includes(role),
    );

    for (const action of this.config.delegatableActions) {
      if (holdsRoleAuthority) {
        result.push({ action, viaDelegationFrom: null });
        continue;
      }
      const authority = await this.authorityFor(accountId, action);
      if (authority) {
        result.push({ action, viaDelegationFrom: authority.principalDescription });
      }
    }
    return result;
  }

  async list(): Promise<DelegationView[]> {
    const rows = await this.delegations.find({
      relations: {
        principal: { person: true },
        delegate: { person: true },
        grantedBy: { person: true },
      },
      order: { grantedAt: 'DESC' },
      take: 200,
    });
    return rows.map((row) => this.toView(row));
  }

  /**
   * Grants a delegation. The granting user must themselves hold a role that
   * DEC-13 configuration permits to delegate — authority cannot be conjured by
   * someone who does not hold it.
   */
  async grant(
    actor: { accountId: string; description: string; roles: string[] },
    input: { delegateAccountId: string; actions: string[]; validFrom: string; validUntil: string },
  ): Promise<DelegationView> {
    if (!actor.roles.some((role) => this.config.rolesThatMayDelegate.includes(role))) {
      throw new ForbiddenException('Your role does not permit delegating authority.');
    }
    if (actor.accountId === input.delegateAccountId) {
      throw new BadRequestException('You cannot delegate your own authority to yourself.');
    }

    const unknown = input.actions.filter((a) => !this.config.delegatableActions.includes(a));
    if (input.actions.length === 0 || unknown.length > 0) {
      throw new BadRequestException(
        `These actions cannot be delegated: ${unknown.join(', ') || 'none supplied'}.`,
      );
    }

    const delegate = await this.accounts.findOne({
      where: { id: input.delegateAccountId },
      relations: { person: true },
    });
    if (!delegate) throw new NotFoundException('Unknown account.');
    if (!delegate.isEnabled) {
      throw new BadRequestException('That account is disabled and cannot receive authority.');
    }

    const from = new Date(input.validFrom);
    const until = new Date(input.validUntil);
    if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime()) || until <= from) {
      throw new BadRequestException('The period must start before it ends.');
    }
    const days = (until.getTime() - from.getTime()) / 86_400_000;
    if (days > this.config.maxDurationDays) {
      throw new BadRequestException(
        `A delegation may not run longer than ${this.config.maxDurationDays} days.`,
      );
    }

    const id = await this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(
        `INSERT INTO delegation (principal_account_id, delegate_account_id, permitted_actions,
           valid_from, valid_until, granted_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $1) RETURNING id`,
        [actor.accountId, input.delegateAccountId, input.actions.join(','), from, until],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.DELEGATION_GRANTED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `${delegate.person.fullName} (${delegate.email})`,
        newValue: `${input.actions.join(', ')} until ${until.toISOString().slice(0, 10)}`,
        summary: `${actor.description} delegated ${input.actions.join(' and ')} to ${delegate.person.fullName} until ${until.toISOString().slice(0, 10)}.`,
      });
      return row.id as string;
    });

    return this.toView(await this.load(id));
  }

  /** Revocation stops future use and leaves the record of what was done. */
  async revoke(
    actor: { accountId: string; description: string },
    delegationId: string,
  ): Promise<DelegationView> {
    const delegation = await this.load(delegationId);
    if (delegation.revokedAt !== null) {
      throw new BadRequestException('That delegation is already revoked.');
    }
    if (delegation.principal.id !== actor.accountId) {
      throw new ForbiddenException('Only the principal who granted this authority may revoke it.');
    }

    const revocationEntry = {
      eventType: AuditEventType.DELEGATION_REVOKED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      subjectDescription: `${delegation.delegate.person.fullName} (${delegation.delegate.email})`,
      previousValue: delegation.permittedActions,
      newValue: 'revoked',
      summary: `${actor.description} revoked the delegation to ${delegation.delegate.person.fullName}.`,
    };

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE delegation SET revoked_at = now(), revoked_by_account_id = $1 WHERE id = $2`,
        [actor.accountId, delegationId],
      );
      await this.audit.recordInTransaction(manager, revocationEntry);
    });

    return this.toView(await this.load(delegationId));
  }

  private actionsOf(delegation: Delegation): string[] {
    return delegation.permittedActions.split(',').map((a) => a.trim()).filter(Boolean);
  }

  private async load(id: string): Promise<Delegation> {
    const delegation = await this.delegations.findOne({
      where: { id },
      relations: {
        principal: { person: true },
        delegate: { person: true },
        grantedBy: { person: true },
      },
    });
    if (!delegation) throw new NotFoundException('Unknown delegation.');
    return delegation;
  }

  private toView(row: Delegation): DelegationView {
    const now = Date.now();
    return {
      id: row.id,
      principalName: row.principal.person.fullName,
      delegateName: row.delegate.person.fullName,
      permittedActions: this.actionsOf(row),
      validFrom: row.validFrom.toISOString(),
      validUntil: row.validUntil.toISOString(),
      grantedByName: row.grantedBy.person.fullName,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      isActive:
        row.revokedAt === null &&
        row.validFrom.getTime() <= now &&
        row.validUntil.getTime() >= now,
    };
  }
}
