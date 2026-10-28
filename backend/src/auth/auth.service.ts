import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { NotificationService } from '../core/notification.service';
import { SettingsService } from '../settings/settings.service';
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
    private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Verifies credentials and returns the account id, or throws 401.
   *
   * Phase 3 adds three things, none of which changes what a refused caller
   * learns: every attempt is kept in login_attempt; repeated failures lock the
   * address for a while (the refusal reads exactly the same as any other); and
   * an account with two-step verification is not signed in until its code is
   * checked.
   */
  async authenticate(
    email: string,
    password: string,
    context: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<{ accountId: string; mfaRequired: boolean; mfaSetupRequired: boolean }> {
    const normalised = email.trim().toLowerCase();
    const security = await this.settings.get('security');
    const account = await this.accounts.findOne({
      where: { email: normalised },
    });
    if (await this.isLocked(normalised, security)) {
      await this.recordAttempt(normalised, account?.id ?? null, false, 'locked', context);
      throw new UnauthorizedException(GENERIC_FAILURE);
    }
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
      await this.recordAttempt(normalised, account?.id ?? null, false, reason, context);
      await this.lockIfThresholdReached(normalised, account?.id ?? null, security);
      throw new UnauthorizedException(GENERIC_FAILURE);
    }
    const mfa = await this.dataSource.query(
      `SELECT enabled_at FROM account_mfa WHERE account_id = $1 AND enabled_at IS NOT NULL`,
      [account.id],
    );
    if (mfa.length > 0) {
      // The password was right; the sign-in completes at the code.
      await this.recordAttempt(normalised, account.id, false, 'awaiting second factor', context);
      return { accountId: account.id, mfaRequired: true, mfaSetupRequired: false };
    }
    await this.completeSignIn(account.id, context);
    const roles = await this.activeRoleCodes(account.id);
    const setupRequired = roles.some((r) => security.mfaRequiredForRoles.includes(r));
    return { accountId: account.id, mfaRequired: false, mfaSetupRequired: setupRequired };
  }

  /** The successful end of a sign-in, with or without a second factor. */
  async completeSignIn(accountId: string, context: { ip?: string | null; userAgent?: string | null } = {}, viaMfa = false): Promise<void> {
    const account = await this.accounts.findOne({ where: { id: accountId } });
    if (!account) throw new UnauthorizedException(GENERIC_FAILURE);
    await this.accounts.update(account.id, { lastLoginAt: new Date() });
    const identity = await this.loadAuthenticatedUser(account.id);
    // Strict: a session with no record of its creation is an unaudited
    // identity. Better to refuse the sign-in.
    await this.audit.recordStrict({
      eventType: AuditEventType.SIGN_IN_SUCCEEDED,
      actorAccountId: account.id,
      actorDescription: identity ? `${identity.personName} (${account.email})` : account.email,
      summary: `${identity?.personName ?? account.email} signed in${viaMfa ? ' with two-step verification' : ''}.`,
    });
    await this.recordAttempt(account.email, account.id, true, viaMfa ? 'two-step verification' : null, context);
  }

  async recordAttempt(
    email: string,
    accountId: string | null,
    succeeded: boolean,
    reason: string | null,
    context: { ip?: string | null; userAgent?: string | null },
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO login_attempt (email_tried, account_id, succeeded, reason, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [email.slice(0, 320), accountId, succeeded, reason, context.ip?.slice(0, 80) ?? null, context.userAgent?.slice(0, 400) ?? null],
      );
    } catch {
      // The sign-in outcome stands; the audit event already carries it.
    }
  }

  private async failuresSinceLastSuccess(email: string, windowMinutes: number): Promise<{ count: number; last: Date | null }> {
    const [row] = await this.dataSource.query(
      `SELECT count(*)::int AS count, max(occurred_at) AS last
         FROM login_attempt
        WHERE lower(email_tried) = $1 AND succeeded = false
          AND reason IS DISTINCT FROM 'awaiting second factor'
          AND occurred_at > now() - make_interval(mins => $2)
          AND occurred_at > coalesce((SELECT max(occurred_at) FROM login_attempt
                                       WHERE lower(email_tried) = $1 AND succeeded), 'epoch')`,
      [email, windowMinutes],
    );
    return { count: row.count, last: row.last };
  }

  private async isLocked(email: string, security: { lockoutThreshold: number; lockoutWindowMinutes: number; lockoutMinutes: number }): Promise<boolean> {
    const { count, last } = await this.failuresSinceLastSuccess(email, Math.max(security.lockoutWindowMinutes, security.lockoutMinutes));
    return count >= security.lockoutThreshold && !!last && Date.now() - new Date(last).getTime() < security.lockoutMinutes * 60_000;
  }

  private async lockIfThresholdReached(
    email: string,
    accountId: string | null,
    security: { lockoutThreshold: number; lockoutWindowMinutes: number; lockoutMinutes: number },
  ): Promise<void> {
    const { count } = await this.failuresSinceLastSuccess(email, security.lockoutWindowMinutes);
    if (count !== security.lockoutThreshold) return;
    await this.audit.record({
      eventType: AuditEventType.ACCOUNT_LOCKED,
      actorAccountId: accountId,
      actorDescription: accountId ? email : `unrecognised: ${email}`,
      newValue: `locked for ${security.lockoutMinutes} minutes`,
      summary: `Sign-in for ${email} was locked for ${security.lockoutMinutes} minutes after ${count} failed attempts.`,
    });
    const admins: { id: string }[] = await this.dataSource.query(
      `SELECT a.id FROM account a JOIN role_assignment ra ON ra.account_id = a.id AND ra.revoked_at IS NULL
         JOIN functional_role r ON r.id = ra.functional_role_id WHERE r.code = 'SYS_ADMIN' AND a.is_enabled`,
    );
    await this.notifications.notify({
      recipients: [accountId, ...admins.map((a) => a.id)],
      kind: 'SECURITY_ALERT',
      params: {
        what: 'aanmelden geblokkeerd',
        detail: `Na ${count} mislukte pogingen is aanmelden met ${email} ${security.lockoutMinutes} minuten geblokkeerd. Was u dit niet? Meld het bij ICT.`,
      },
      link: '/profiel/beveiliging',
      subjectType: 'ACCOUNT',
      subjectId: accountId ?? undefined,
    });
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
