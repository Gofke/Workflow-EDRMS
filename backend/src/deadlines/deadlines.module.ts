import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Module, NotFoundException, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { IsBoolean, IsDateString, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { SessionGuard } from '../auth/session.guard';
import { actorFrom, todayInSuriname } from '../common/actor';
import { PushSender } from '../core/delivery';
import { NotificationService } from '../core/notification.service';
import { ALL_KINDS, DEFAULT_CHANNELS, NotificationKind } from '../core/notification-templates';
import { SURINAME_HOLIDAYS, WorkingDaysService } from '../core/working-days.service';
import { OrgModule } from '../org/org.module';
import { DeadlinesService } from './deadlines.service';

class PreferencesDto {
  @IsOptional() @IsObject() kinds?: Record<string, { email?: boolean; sms?: boolean; push?: boolean }>;
  @IsOptional() @IsIn(['IMMEDIATE', 'DIGEST', 'OFF']) emailMode?: 'IMMEDIATE' | 'DIGEST' | 'OFF';
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @Matches(/^\+?[0-9 ]{7,20}$/, { message: 'Enter a mobile number with country code, e.g. +597 8123456.' }) mobileNumber?: string | null;
  @IsOptional() @IsIn(['nl', 'en']) language?: 'nl' | 'en';
}

class PushKeysDto {
  @IsString() @MaxLength(200) p256dh: string;
  @IsString() @MaxLength(100) auth: string;
}

class PushSubscribeDto {
  @IsString() @Matches(/^https?:\/\//) @MaxLength(1000) endpoint: string;
  @IsObject() keys: PushKeysDto;
}

class HolidayDto {
  @IsDateString() date: string;
  @IsString() @MinLength(2) @MaxLength(200) name: string;
}

class NotificationsReadDto {
  @IsOptional() @IsBoolean() all?: boolean;
}

@Controller('api/notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly push: PushSender,
    private readonly notifications: NotificationService,
  ) {}

  @Get()
  async list(@Req() request: Request, @Query('unread') unread?: string, @Query('limit') limit?: string) {
    const me = request.authenticatedUser!.accountId;
    const take = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const items = await this.dataSource.query(
      `SELECT n.id, n.kind, n.title, n.body, n.link, n.subject_type AS "subjectType", n.subject_id AS "subjectId",
              n.created_at AS "createdAt", n.read_at AS "readAt", ap.full_name AS "forAbsentName"
         FROM notification n LEFT JOIN account aa ON aa.id = n.for_absent_account_id LEFT JOIN person ap ON ap.id = aa.person_id
        WHERE n.account_id = $1 AND ($2::boolean = false OR n.read_at IS NULL)
        ORDER BY n.created_at DESC LIMIT ${take}`,
      [me, unread === 'true'],
    );
    const [{ count }] = await this.dataSource.query(`SELECT count(*)::int AS count FROM notification WHERE account_id = $1 AND read_at IS NULL`, [me]);
    return { items, unread: count };
  }

  @Post(':id/read')
  @HttpCode(200)
  async read(@Param('id') id: string, @Req() request: Request) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException();
    await this.dataSource.query(`UPDATE notification SET read_at = coalesce(read_at, now()) WHERE id = $1 AND account_id = $2`, [id, request.authenticatedUser!.accountId]);
    return { read: true };
  }

  @Post('read-all')
  @HttpCode(200)
  async readAll(@Body() _dto: NotificationsReadDto, @Req() request: Request) {
    await this.dataSource.query(`UPDATE notification SET read_at = now() WHERE account_id = $1 AND read_at IS NULL`, [request.authenticatedUser!.accountId]);
    return { read: true };
  }

  @Get('preferences')
  async preferences(@Req() request: Request) {
    const me = request.authenticatedUser!.accountId;
    const stored: { kind: NotificationKind; email: boolean; sms: boolean; push: boolean }[] = await this.dataSource.query(
      `SELECT kind, email, sms, push FROM notification_preference WHERE account_id = $1`,
      [me],
    );
    const [contact] = await this.dataSource.query(`SELECT email_mode, mobile_number, language FROM account_contact WHERE account_id = $1`, [me]);
    return {
      kinds: Object.fromEntries(
        ALL_KINDS.filter((k) => k !== 'SYSTEM').map((k) => {
          const s = stored.find((x) => x.kind === k);
          return [k, s ? { email: s.email, sms: s.sms, push: s.push } : DEFAULT_CHANNELS[k]];
        }),
      ),
      emailMode: contact?.email_mode ?? 'IMMEDIATE',
      mobileNumber: contact?.mobile_number ?? null,
      language: contact?.language ?? 'nl',
    };
  }

  @Put('preferences')
  async savePreferences(@Body() dto: PreferencesDto, @Req() request: Request) {
    const me = request.authenticatedUser!.accountId;
    for (const [kind, channels] of Object.entries(dto.kinds ?? {})) {
      if (!ALL_KINDS.includes(kind as NotificationKind)) throw new BadRequestException(`Unknown notification kind ${kind}.`);
      const d = DEFAULT_CHANNELS[kind as NotificationKind];
      await this.dataSource.query(
        `INSERT INTO notification_preference (account_id, kind, email, sms, push) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, kind) DO UPDATE SET email = EXCLUDED.email, sms = EXCLUDED.sms, push = EXCLUDED.push`,
        [me, kind, channels.email ?? d.email, channels.sms ?? d.sms, channels.push ?? d.push],
      );
    }
    if (dto.emailMode || dto.mobileNumber !== undefined || dto.language) {
      await this.dataSource.query(
        `INSERT INTO account_contact (account_id, email_mode, mobile_number, language) VALUES ($1, coalesce($2, 'IMMEDIATE'), $3, coalesce($4, 'nl'))
         ON CONFLICT (account_id) DO UPDATE SET
           email_mode = coalesce($2, account_contact.email_mode),
           mobile_number = CASE WHEN $5::boolean THEN $3 ELSE account_contact.mobile_number END,
           language = coalesce($4, account_contact.language), updated_at = now()`,
        [me, dto.emailMode ?? null, dto.mobileNumber?.replace(/\s/g, '') || null, dto.language ?? null, dto.mobileNumber !== undefined],
      );
    }
    return this.preferences(request);
  }

  @Get('push/public-key')
  publicKey() {
    return { publicKey: this.push.vapid().publicKey };
  }

  @Post('push/subscribe')
  @HttpCode(201)
  async subscribe(@Body() dto: PushSubscribeDto, @Req() request: Request) {
    await this.dataSource.query(
      `INSERT INTO push_subscription (account_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET account_id = EXCLUDED.account_id, p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth, revoked_at = NULL`,
      [request.authenticatedUser!.accountId, dto.endpoint, dto.keys.p256dh, dto.keys.auth, String(request.headers['user-agent'] ?? '').slice(0, 400)],
    );
    return { subscribed: true };
  }

  @Post('push/unsubscribe')
  @HttpCode(200)
  async unsubscribe(@Body() dto: { endpoint?: string }, @Req() request: Request) {
    await this.dataSource.query(`UPDATE push_subscription SET revoked_at = now() WHERE account_id = $1 AND ($2::text IS NULL OR endpoint = $2)`, [
      request.authenticatedUser!.accountId,
      dto?.endpoint ?? null,
    ]);
    return { subscribed: false };
  }

  @Post('push/test')
  @HttpCode(200)
  async testPush(@Req() request: Request) {
    const sent = await this.notifications.pushTo(request.authenticatedUser!.accountId, {
      title: 'JusPol EDRMS',
      body: 'Pushmeldingen werken op dit apparaat.',
      link: '/',
    });
    return { sent };
  }
}

@Controller('api/calendar')
export class CalendarController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly workingDays: WorkingDaysService,
    private readonly audit: AuditService,
  ) {}

  @Get('holidays')
  @UseGuards(SessionGuard)
  holidays(@Query('year') year?: string) {
    const y = Number(year) || null;
    return this.dataSource.query(
      `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS date, name FROM public_holiday
        WHERE ($1::int IS NULL OR extract(year FROM holiday_date) = $1) ORDER BY holiday_date`,
      [y],
    );
  }

  @Post('holidays')
  @RequireRoles('SYS_ADMIN')
  @HttpCode(201)
  async addHoliday(@Body() dto: HolidayDto, @Req() request: Request) {
    const actor = actorFrom(request);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO public_holiday (holiday_date, name) VALUES ($1, $2) ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name`,
        [dto.date, dto.name.trim()],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.HOLIDAY_CHANGED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        newValue: `${dto.date} ${dto.name.trim()}`,
        summary: `${actor.description} set ${dto.date} as a public holiday (${dto.name.trim()}).`,
      });
    });
    this.workingDays.invalidate();
    return { date: dto.date, name: dto.name.trim() };
  }

  @Delete('holidays/:date')
  @RequireRoles('SYS_ADMIN')
  async removeHoliday(@Param('date') date: string, @Req() request: Request) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Enter a date as YYYY-MM-DD.');
    const actor = actorFrom(request);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`DELETE FROM public_holiday WHERE holiday_date = $1`, [date]);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.HOLIDAY_CHANGED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        previousValue: date,
        summary: `${actor.description} removed ${date} from the public holidays.`,
      });
    });
    this.workingDays.invalidate();
    return { removed: date };
  }

  /** Adds the published Suriname holidays for 2026 and 2027 that are not there yet. */
  @Post('holidays/load-suriname')
  @RequireRoles('SYS_ADMIN')
  @HttpCode(200)
  async loadSuriname(@Req() request: Request) {
    const actor = actorFrom(request);
    let added = 0;
    for (const h of SURINAME_HOLIDAYS) {
      const rows = await this.dataSource.query(
        `INSERT INTO public_holiday (holiday_date, name) VALUES ($1, $2) ON CONFLICT (holiday_date) DO NOTHING RETURNING holiday_date`,
        [h.date, h.name],
      );
      added += rows.length;
    }
    await this.audit.recordStrict({
      eventType: AuditEventType.HOLIDAY_CHANGED,
      actorAccountId: actor.accountId,
      actorDescription: actor.description,
      newValue: `${added} holidays added`,
      summary: `${actor.description} loaded the Suriname public holidays (${added} added).`,
    });
    this.workingDays.invalidate();
    return { added };
  }

  /** The date n working days from a date, for suggesting a deadline. */
  @Get('working-days')
  @UseGuards(SessionGuard)
  async add(@Query('from') from?: string, @Query('days') days?: string) {
    const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : todayInSuriname();
    const n = Math.min(Math.max(Number(days) || 0, 0), 365);
    return { from: start, days: n, date: await this.workingDays.addWorkingDays(start, n) };
  }
}

@Controller('api/admin')
export class JobsAdminController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly deadlines: DeadlinesService,
    private readonly notifications: NotificationService,
  ) {}

  @Get('jobs')
  @RequireRoles('SYS_ADMIN')
  jobs() {
    return this.dataSource.query(
      `SELECT id, job, started_at AS "startedAt", finished_at AS "finishedAt", outcome FROM job_run ORDER BY started_at DESC LIMIT 100`,
    );
  }

  @Post('jobs/:job/run')
  @RequireRoles('SYS_ADMIN')
  @HttpCode(200)
  run(@Param('job') job: string) {
    const key = `manual-${new Date().toISOString()}`;
    if (job === 'deadlines') return this.deadlines.logged('deadlines', key, () => this.deadlines.run());
    if (job === 'digest') return this.deadlines.logged('digest', key, () => this.deadlines.sendDigests());
    if (job === 'weekly-report') return this.deadlines.logged('weekly-report', key, () => this.deadlines.sendWeeklyReports());
    if (job === 'outbox') return this.notifications.flush();
    throw new NotFoundException('Unknown job.');
  }

  @Get('outbox/email')
  @RequireRoles('SYS_ADMIN')
  emails(@Query('status') status?: string) {
    return this.dataSource.query(
      `SELECT id, to_address AS "to", subject, body_text AS "body", kind, status, attempts, last_error AS "lastError",
              created_at AS "createdAt", sent_at AS "sentAt"
         FROM email_outbox WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 200`,
      [status ?? null],
    );
  }

  @Get('outbox/sms')
  @RequireRoles('SYS_ADMIN')
  sms(@Query('status') status?: string) {
    return this.dataSource.query(
      `SELECT id, to_number AS "to", body, kind, status, attempts, last_error AS "lastError", created_at AS "createdAt", sent_at AS "sentAt"
         FROM sms_outbox WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 200`,
      [status ?? null],
    );
  }
}

@Module({
  imports: [AuthModule, OrgModule],
  controllers: [NotificationsController, CalendarController, JobsAdminController],
  providers: [DeadlinesService],
  exports: [DeadlinesService],
})
export class DeadlinesModule {}
