import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { Account } from '../identity/account.entity';
import { FunctionalRole } from '../identity/functional-role.entity';
import { RoleAssignment } from '../identity/role-assignment.entity';
import { AccountSummary } from './admin.dto';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @InjectRepository(FunctionalRole) private readonly roles: Repository<FunctionalRole>,
    @InjectRepository(RoleAssignment) private readonly assignments: Repository<RoleAssignment>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Account administration data only: who exists, their roles, whether they are
   * enabled. No record or dossier content is reachable here, because
   * administrative power and business-record access are separate (FR-SEC-010).
   */
  async listAccounts(): Promise<AccountSummary[]> {
    const accounts = await this.accounts.find({
      relations: { person: true, organisationalUnit: true, roleAssignments: { role: true } },
      order: { email: 'ASC' },
    });

    return accounts.map((account) => ({
      accountId: account.id,
      personName: account.person.fullName,
      email: account.email,
      organisationalUnit: account.organisationalUnit?.name ?? null,
      isEnabled: account.isEnabled,
      roles: (account.roleAssignments ?? [])
        .filter((a) => a.revokedAt === null)
        .map((a) => ({ code: a.role.code, name: a.role.name })),
    }));
  }

  async assignRole(actor: AuditActor, accountId: string, roleCode: string): Promise<void> {
    const account = await this.loadAccount(accountId);
    const role = await this.roles.findOne({ where: { code: roleCode } });
    if (!role) throw new NotFoundException('Unknown functional role.');

    const existing = await this.assignments.findOne({
      where: { account: { id: accountId }, role: { id: role.id } },
      relations: { account: true, role: true },
    });

    if (existing && existing.revokedAt === null) {
      throw new BadRequestException('That role is already assigned to this account.');
    }

    const entry = {
      eventType: AuditEventType.ROLE_ASSIGNED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      subjectDescription: `${account.person.fullName} (${account.email})`,
      previousValue: existing ? 'revoked' : 'not assigned',
      newValue: `assigned: ${role.name}`,
      summary: `${actor.description} assigned the role ${role.name} to ${account.person.fullName}.`,
    };

    await this.dataSource.transaction(async (manager) => {
      if (existing) {
        // A previously revoked assignment is reinstated by clearing revokedAt.
        // The row is never deleted, so the earlier revocation remains evidenced
        // by its own audit event.
        await manager.query(
          `UPDATE role_assignment SET revoked_at = NULL, assigned_at = now() WHERE id = $1`,
          [existing.id],
        );
      } else {
        await manager.query(
          `INSERT INTO role_assignment (account_id, functional_role_id) VALUES ($1, $2)`,
          [accountId, role.id],
        );
      }
      await this.audit.recordInTransaction(manager, entry);
    });
  }

  async revokeRole(actor: AuditActor, accountId: string, roleCode: string): Promise<void> {
    const account = await this.loadAccount(accountId);
    const assignment = await this.assignments.findOne({
      where: { account: { id: accountId }, role: { code: roleCode }, revokedAt: IsNull() },
      relations: { role: true },
    });
    if (!assignment) throw new NotFoundException('That role is not currently assigned.');
    if (roleCode === 'SYS_ADMIN') await this.assertNotLastAdministrator(accountId);

    const entry = {
      eventType: AuditEventType.ROLE_REVOKED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      subjectDescription: `${account.person.fullName} (${account.email})`,
      previousValue: `assigned: ${assignment.role.name}`,
      newValue: 'revoked',
      summary: `${actor.description} revoked the role ${assignment.role.name} from ${account.person.fullName}.`,
    };

    // Revocation marks the row rather than deleting it: future use of the
    // authority is prevented, historical evidence is untouched (FR-SEC-011).
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE role_assignment SET revoked_at = now() WHERE id = $1`, [
        assignment.id,
      ]);
      await this.audit.recordInTransaction(manager, entry);
    });
  }

  async setAccountEnabled(actor: AuditActor, accountId: string, enabled: boolean): Promise<void> {
    const account = await this.loadAccount(accountId);
    if (account.isEnabled === enabled) {
      throw new BadRequestException(
        enabled ? 'That account is already enabled.' : 'That account is already disabled.',
      );
    }

    if (!enabled) {
      const holdsAdmin = await this.assignments.findOne({
        where: { account: { id: accountId }, role: { code: 'SYS_ADMIN' }, revokedAt: IsNull() },
      });
      if (holdsAdmin) await this.assertNotLastAdministrator(accountId);
    }

    const entry = {
      eventType: enabled ? AuditEventType.ACCOUNT_ENABLED : AuditEventType.ACCOUNT_DISABLED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      subjectDescription: `${account.person.fullName} (${account.email})`,
      previousValue: account.isEnabled ? 'enabled' : 'disabled',
      newValue: enabled ? 'enabled' : 'disabled',
      summary: `${actor.description} ${enabled ? 'enabled' : 'disabled'} the account of ${account.person.fullName}.`,
    };

    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE account SET is_enabled = $1 WHERE id = $2`, [enabled, accountId]);
      await this.audit.recordInTransaction(manager, entry);
    });
  }

  /**
   * Refuses a change that would leave the pilot with no usable administrator.
   * Without this, an administrator can revoke their own role or disable their
   * own account and lock everyone out of administration entirely.
   */
  private async assertNotLastAdministrator(accountId: string): Promise<void> {
    const administrators = await this.assignments.find({
      where: { role: { code: 'SYS_ADMIN' }, revokedAt: IsNull() },
      relations: { account: true },
    });
    const othersStillAble = administrators.filter(
      (a) => a.account.id !== accountId && a.account.isEnabled,
    );
    if (othersStillAble.length === 0) {
      throw new BadRequestException(
        'This would leave the system with no active administrator. Give the role to another account first.',
      );
    }
  }

  private async loadAccount(accountId: string): Promise<Account> {
    const account = await this.accounts.findOne({
      where: { id: accountId },
      relations: { person: true },
    });
    if (!account) throw new NotFoundException('Unknown account.');
    return account;
  }
}

export interface AuditActor {
  accountId: string;
  description: string;
}
