import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { qrDataUrl } from '../core/pdf';
import { SettingsService } from '../settings/settings.service';
import { decryptSecret, encryptSecret, generateSecret, otpauthUrl, recoveryCodes, verifyCode } from '../security/totp';
import { hashPassword, verifyPassword } from './password';

/**
 * Two-step verification with an authenticator app.
 *
 * Setting up is two calls: the first creates a secret and shows it as a QR
 * code; the second proves the person can produce a code from it, and only then
 * is it switched on. Eight recovery codes are shown once, for when the phone is
 * lost; each works once.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  async status(accountId: string): Promise<{ enabled: boolean; recoveryCodesLeft: number }> {
    const [row] = await this.dataSource.query(
      `SELECT enabled_at, jsonb_array_length(recovery_code_hashes) AS left FROM account_mfa WHERE account_id = $1`,
      [accountId],
    );
    return { enabled: !!row?.enabled_at, recoveryCodesLeft: row?.enabled_at ? Number(row.left) : 0 };
  }

  async beginSetup(accountId: string, email: string): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string }> {
    const current = await this.status(accountId);
    if (current.enabled) throw new BadRequestException('Two-step verification is already on. Switch it off first to set up a new phone.');
    const secret = generateSecret();
    await this.dataSource.query(
      `INSERT INTO account_mfa (account_id, secret_encrypted) VALUES ($1, $2)
       ON CONFLICT (account_id) DO UPDATE SET secret_encrypted = EXCLUDED.secret_encrypted,
         enabled_at = NULL, last_used_step = NULL, recovery_code_hashes = '[]'`,
      [accountId, encryptSecret(secret)],
    );
    const branding = await this.settings.get('branding');
    const url = otpauthUrl(secret, email, branding.productName);
    return { secret, otpauthUrl: url, qrDataUrl: await qrDataUrl(url, 220) };
  }

  async enable(accountId: string, description: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const [row] = await this.dataSource.query(`SELECT * FROM account_mfa WHERE account_id = $1`, [accountId]);
    if (!row) throw new BadRequestException('Start the set-up first.');
    if (row.enabled_at) throw new BadRequestException('Two-step verification is already on.');
    const step = verifyCode(decryptSecret(row.secret_encrypted), code, null);
    if (step === null) throw new BadRequestException('That code is not right. Check the time on your phone and try the newest code.');
    const codes = recoveryCodes();
    const hashes = await Promise.all(codes.map((c) => hashPassword(c)));
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE account_mfa SET enabled_at = now(), last_used_step = $2, recovery_code_hashes = $3 WHERE account_id = $1`,
        [accountId, step, JSON.stringify(hashes)],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.MFA_ENABLED,
        actorAccountId: accountId,
        actorDescription: description,
        summary: `${description} switched on two-step verification.`,
      });
    });
    return { recoveryCodes: codes };
  }

  async disable(accountId: string, description: string, code: string): Promise<void> {
    await this.verifyFor(accountId, description, code);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE account_mfa SET enabled_at = NULL, recovery_code_hashes = '[]' WHERE account_id = $1`, [accountId]);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.MFA_DISABLED,
        actorAccountId: accountId,
        actorDescription: description,
        summary: `${description} switched off two-step verification.`,
      });
    });
  }

  /**
   * Checks a code (or an unused recovery code) for an account. A code is
   * accepted once: the step is remembered, and a recovery code is removed.
   */
  async verifyFor(accountId: string, description: string, code: string): Promise<'totp' | 'recovery'> {
    const [row] = await this.dataSource.query(
      `SELECT * FROM account_mfa WHERE account_id = $1 AND enabled_at IS NOT NULL`,
      [accountId],
    );
    if (!row) throw new UnauthorizedException('Two-step verification is not set up for this account.');
    const step = verifyCode(decryptSecret(row.secret_encrypted), code, row.last_used_step === null ? null : Number(row.last_used_step));
    if (step !== null) {
      await this.dataSource.query(`UPDATE account_mfa SET last_used_step = $2 WHERE account_id = $1`, [accountId, step]);
      return 'totp';
    }
    const candidate = code.trim().toUpperCase();
    if (/^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(candidate)) {
      const hashes: string[] = row.recovery_code_hashes ?? [];
      for (let i = 0; i < hashes.length; i += 1) {
        if (await verifyPassword(candidate, hashes[i])) {
          const remaining = hashes.filter((_, j) => j !== i);
          await this.dataSource.query(`UPDATE account_mfa SET recovery_code_hashes = $2 WHERE account_id = $1`, [accountId, JSON.stringify(remaining)]);
          return 'recovery';
        }
      }
    }
    await this.audit.record({
      eventType: AuditEventType.MFA_FAILED,
      actorAccountId: accountId,
      actorDescription: description,
      summary: `A two-step verification code for ${description} was refused.`,
    });
    throw new UnauthorizedException('That code is not right.');
  }
}
