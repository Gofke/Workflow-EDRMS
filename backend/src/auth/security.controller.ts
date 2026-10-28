import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { MfaCodeDto } from './dto';
import { MfaService } from './mfa.service';
import { hashPassword, verifyPassword } from './password';
import { RequireRoles } from './require-roles.decorator';
import { SessionGuard } from './session.guard';

class PasswordChangeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword: string;

  @IsString()
  @MinLength(8, { message: 'The new password is too short.' })
  @MaxLength(200)
  newPassword: string;
}

/** A person's own security: two-step verification, sign-in history, password. */
@Controller('api/security')
export class SecurityController {
  constructor(
    private readonly mfa: MfaService,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  @Get('mfa')
  @UseGuards(SessionGuard)
  status(@Req() request: Request) {
    return this.mfa.status(request.authenticatedUser!.accountId);
  }

  @Post('mfa/setup')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  setup(@Req() request: Request) {
    const user = request.authenticatedUser!;
    return this.mfa.beginSetup(user.accountId, user.email);
  }

  @Post('mfa/enable')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async enable(@Body() dto: MfaCodeDto, @Req() request: Request) {
    const user = request.authenticatedUser!;
    const result = await this.mfa.enable(user.accountId, `${user.personName} (${user.email})`, dto.code);
    request.session.mfaSetupRequired = false;
    return result;
  }

  @Post('mfa/disable')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async disable(@Body() dto: MfaCodeDto, @Req() request: Request) {
    const user = request.authenticatedUser!;
    const security = await this.settings.get('security');
    if (user.roles.some((r) => security.mfaRequiredForRoles.includes(r.code))) {
      throw new BadRequestException('Your role requires two-step verification. It cannot be switched off.');
    }
    await this.mfa.disable(user.accountId, `${user.personName} (${user.email})`, dto.code);
    return { enabled: false };
  }

  /** The person's own sign-in attempts, newest first. */
  @Get('login-history')
  @UseGuards(SessionGuard)
  history(@Req() request: Request) {
    return this.dataSource.query(
      `SELECT occurred_at AS "occurredAt", succeeded, reason, ip_address AS "ipAddress", user_agent AS "userAgent"
         FROM login_attempt WHERE account_id = $1 ORDER BY occurred_at DESC LIMIT 50`,
      [request.authenticatedUser!.accountId],
    );
  }

  @Post('password')
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async changePassword(@Body() dto: PasswordChangeDto, @Req() request: Request) {
    const user = request.authenticatedUser!;
    const security = await this.settings.get('security');
    const [row] = await this.dataSource.query(`SELECT password_hash FROM account WHERE id = $1`, [user.accountId]);
    if (!(await verifyPassword(dto.currentPassword, row.password_hash))) {
      throw new BadRequestException('Your current password is not right.');
    }
    assertPasswordPolicy(dto.newPassword, security.passwordMinLength);
    const hash = await hashPassword(dto.newPassword);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE account SET password_hash = $2 WHERE id = $1`, [user.accountId, hash]);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.PASSWORD_CHANGED,
        actorAccountId: user.accountId,
        actorDescription: `${user.personName} (${user.email})`,
        summary: `${user.personName} changed their password.`,
      });
    });
    return { changed: true };
  }

  /** Locked sign-ins and bursts of failures, for the administrator. */
  @Get('alerts')
  @RequireRoles('SYS_ADMIN', 'AUDITOR')
  async alerts(@Query('days') days?: string) {
    const window = Math.min(Math.max(Number(days ?? 7) || 7, 1), 90);
    const locks = await this.dataSource.query(
      `SELECT occurred_at AS "occurredAt", summary, actor_description AS "account"
         FROM audit_event WHERE event_type = 'ACCOUNT_LOCKED' AND occurred_at > now() - make_interval(days => $1)
         ORDER BY occurred_at DESC LIMIT 100`,
      [window],
    );
    const failures = await this.dataSource.query(
      `SELECT lower(email_tried) AS "email", count(*)::int AS "failures", max(occurred_at) AS "lastAttempt",
              count(DISTINCT ip_address)::int AS "addresses"
         FROM login_attempt
        WHERE succeeded = false AND reason IS DISTINCT FROM 'awaiting second factor'
          AND occurred_at > now() - make_interval(days => $1)
        GROUP BY lower(email_tried) ORDER BY count(*) DESC LIMIT 50`,
      [window],
    );
    return { locks, failures };
  }
}

export function assertPasswordPolicy(password: string, minLength: number): void {
  if (password.length < minLength) {
    throw new BadRequestException(`A password must be at least ${minLength} characters.`);
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    throw new BadRequestException('Use at least three of: lower case, upper case, digits, symbols.');
  }
}
