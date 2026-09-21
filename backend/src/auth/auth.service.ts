import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { Account } from '../identity/account.entity';
import { AuthenticatedUser } from './dto';
import { verifyPassword } from './password';

/**
 * The single message returned for every failed sign-in attempt.
 *
 * A wrong password, an unknown email and a disabled account are deliberately
 * indistinguishable: a different message for each would let anyone discover
 * which addresses are real ministry accounts. This is the same principle the
 * TS-06 identity-enumeration cases apply to search.
 */
const GENERIC_FAILURE = 'Invalid email or password.';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Account)
    private readonly accounts: Repository<Account>,
    private readonly audit: AuditService,
  ) {}

  /** Verifies credentials and returns the account id, or throws 401. */
  async authenticate(email: string, password: string): Promise<string> {
    const account = await this.accounts.findOne({
      where: { email: email.trim().toLowerCase() },
    });

    // Verify against a dummy hash when the account is absent so that a missing
    // email does not answer measurably faster than a wrong password.
    const storedHash =
      account?.passwordHash ??
      '16384:8:1:00000000000000000000000000000000:' + '0'.repeat(128);
    const passwordMatches = await verifyPassword(password, storedHash);

    if (!account || !passwordMatches || !account.isEnabled) {
      // Left lenient on purpose: the attempt is already being refused, and a
      // failure to record it must not become a different error that tells the
      // caller something about why.
      const reason = !account
        ? 'no such account'
        : !passwordMatches
          ? 'incorrect password'
          : 'account disabled';
      await this.audit.record({
        eventType: AuditEventType.SIGN_IN_FAILED,
        actorAccountId: account?.id ?? null,
        actorDescription: account ? `${account.email}` : `unrecognised: ${email.trim()}`,
        newValue: reason,
        summary: `A sign-in attempt for ${email.trim()} was refused (${reason}).`,
      });
      throw new UnauthorizedException(GENERIC_FAILURE);
    }

    await this.accounts.update(account.id, { lastLoginAt: new Date() });

    const identity = await this.loadAuthenticatedUser(account.id);
    // Strict: a session with no record of its creation is an unaudited
    // identity. Better to refuse the sign-in.
    await this.audit.recordStrict({
      eventType: AuditEventType.SIGN_IN_SUCCEEDED,
      actorAccountId: account.id,
      actorDescription: identity ? `${identity.personName} (${account.email})` : account.email,
      summary: `${identity?.personName ?? account.email} signed in.`,
    });
    return account.id;
  }

  /**
   * Loads the identity for an established session. Returns null when the
   * account has since been disabled, so revoking access takes effect on the
   * next request rather than when the session happens to expire (FR-SEC-011).
   */
  async loadAuthenticatedUser(accountId: string): Promise<AuthenticatedUser | null> {
    const account = await this.accounts.findOne({
      where: { id: accountId, isEnabled: true },
      relations: {
        person: true,
        organisationalUnit: true,
        roleAssignments: { role: true },
      },
    });
    if (!account) return null;

    const active = (account.roleAssignments ?? []).filter((a) => a.revokedAt === null);

    return {
      accountId: account.id,
      personName: account.person.fullName,
      email: account.email,
      jobPosition: account.person.jobPosition,
      organisationalUnit: account.organisationalUnit?.name ?? null,
      roles: active.map((a) => ({ code: a.role.code, name: a.role.name })),
    };
  }

  /** Records a sign-out against the account that held the session. */
  async recordSignOut(accountId: string): Promise<void> {
    const identity = await this.loadAuthenticatedUser(accountId);
    await this.audit.recordStrict({
      eventType: AuditEventType.SIGN_OUT,
      actorAccountId: accountId,
      actorDescription: identity ? `${identity.personName} (${identity.email})` : accountId,
      summary: `${identity?.personName ?? 'A user'} signed out.`,
    });
  }

  /** Active role assignments only — a revoked assignment grants nothing. */
  async activeRoleCodes(accountId: string): Promise<string[]> {
    const account = await this.accounts.findOne({
      where: { id: accountId, isEnabled: true, roleAssignments: { revokedAt: IsNull() } },
      relations: { roleAssignments: { role: true } },
    });
    return (account?.roleAssignments ?? []).map((a) => a.role.code);
  }
}
