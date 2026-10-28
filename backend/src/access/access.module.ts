import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { APP_GUARD } from '@nestjs/core';
import { RecordAccessGuard } from './record-access.guard';
import { IsIn, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { actorFrom, BUSINESS_ROLES, DECISION_ROLES } from '../common/actor';
import { AccessService, LEVELS } from './access.service';

class ClassifyDto {
  @IsIn(LEVELS, { message: 'Choose Open, Internal, Confidential or Secret.' })
  level: string;

  @IsString()
  @MinLength(1, { message: 'A reason is required when the classification changes.' })
  @MaxLength(600)
  reason: string;
}

class GrantDto {
  @IsUUID('4', { message: 'Choose who is to receive access.' })
  accountId: string;

  @IsString()
  @MinLength(1, { message: 'A reason is required for a need-to-know grant.' })
  @MaxLength(600)
  reason: string;
}

const AUDIT_VIEWERS = ['AUDITOR', 'MINISTER', 'DIRECTEUR'];

/**
 * Classification, need-to-know grants and the view log.
 *
 * Changing a classification is a decision-maker act and always carries a
 * reason. Grants are revoked, never deleted. Who opened a record is visible to
 * the decision-makers and the auditor, so access can be accounted for.
 */
@Controller('api/access')
export class AccessController {
  constructor(
    private readonly access: AccessService,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  @Post(':type/:id/classification')
  @RequireRoles(...DECISION_ROLES)
  @HttpCode(200)
  async classify(
    @Param('type') type: string,
    @Param('id') id: string,
    @Body() dto: ClassifyDto,
    @Req() request: Request,
  ) {
    const actor = actorFrom(request);
    const { table, subjectType, label } = await this.subject(actor.accountId, type, id);
    const [row] = await this.dataSource.query(`SELECT classification, state FROM ${table} WHERE id = $1`, [id]);
    if (row.classification === dto.level) {
      throw new BadRequestException('The record already has this classification.');
    }
    if (table === 'dossier' && row.state === 'CLOSED') {
      throw new BadRequestException('This dossier is closed. Reopen the dossier before changing it.');
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO classification_change (subject_type, subject_id, previous_level, new_level, reason, changed_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [subjectType, id, row.classification, dto.level, dto.reason.trim(), actor.accountId],
      );
      await manager.query(`UPDATE ${table} SET classification = $1 WHERE id = $2`, [dto.level, id]);
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.CLASSIFICATION_CHANGED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: label,
        previousValue: row.classification,
        newValue: dto.level,
        summary: `${actor.description} changed the classification of ${label} from ${row.classification} to ${dto.level} (reason: ${dto.reason.trim()}).`,
      });
    });
    return { classification: dto.level };
  }

  @Get(':type/:id/grants')
  @RequireRoles(...BUSINESS_ROLES)
  async grants(@Param('type') type: string, @Param('id') id: string, @Req() request: Request) {
    const { subjectType } = await this.subject(actorFrom(request).accountId, type, id);
    return this.dataSource.query(
      `SELECT g.id, g.account_id AS "accountId", p.full_name AS "personName", g.reason,
              gp.full_name AS "grantedByName", g.granted_at AS "grantedAt", g.revoked_at AS "revokedAt"
         FROM record_access_grant g
         JOIN account a ON a.id = g.account_id JOIN person p ON p.id = a.person_id
         JOIN account ga ON ga.id = g.granted_by_account_id JOIN person gp ON gp.id = ga.person_id
        WHERE g.subject_type = $1 AND g.subject_id = $2
        ORDER BY g.granted_at DESC`,
      [subjectType, id],
    );
  }

  @Post(':type/:id/grants')
  @RequireRoles(...DECISION_ROLES)
  @HttpCode(201)
  async grant(@Param('type') type: string, @Param('id') id: string, @Body() dto: GrantDto, @Req() request: Request) {
    const actor = actorFrom(request);
    const { subjectType, label } = await this.subject(actor.accountId, type, id);
    const [target] = await this.dataSource.query(
      `SELECT a.id, p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = $1 AND a.is_enabled`,
      [dto.accountId],
    );
    if (!target) throw new NotFoundException('Unknown account.');
    const existing = await this.dataSource.query(
      `SELECT 1 FROM record_access_grant WHERE subject_type = $1 AND subject_id = $2 AND account_id = $3 AND revoked_at IS NULL`,
      [subjectType, id, dto.accountId],
    );
    if (existing.length) throw new BadRequestException('This person already has access.');
    const grantId = await this.dataSource.transaction(async (manager) => {
      const [row] = await manager.query(
        `INSERT INTO record_access_grant (subject_type, subject_id, account_id, reason, granted_by_account_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [subjectType, id, dto.accountId, dto.reason.trim(), actor.accountId],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.ACCESS_GRANTED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: label,
        newValue: `need-to-know: ${target.full_name}`,
        summary: `${actor.description} granted ${target.full_name} access to ${label} (reason: ${dto.reason.trim()}).`,
      });
      return row.id as string;
    });
    return { id: grantId };
  }

  @Post('grants/:grantId/revoke')
  @RequireRoles(...DECISION_ROLES)
  @HttpCode(200)
  async revoke(@Param('grantId') grantId: string, @Req() request: Request) {
    const actor = actorFrom(request);
    const [grant] = await this.dataSource.query(
      `SELECT g.*, p.full_name FROM record_access_grant g JOIN account a ON a.id = g.account_id
         JOIN person p ON p.id = a.person_id WHERE g.id = $1 AND g.revoked_at IS NULL`,
      [grantId],
    );
    if (!grant) throw new NotFoundException('Unknown or already revoked grant.');
    const { label } = await this.subject(actor.accountId, grant.subject_type === 'DOSSIER' ? 'dossiers' : 'items', grant.subject_id);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE record_access_grant SET revoked_at = now(), revoked_by_account_id = $2 WHERE id = $1`,
        [grantId, actor.accountId],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.ACCESS_REVOKED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: label,
        previousValue: `need-to-know: ${grant.full_name}`,
        summary: `${actor.description} revoked the access of ${grant.full_name} to ${label}.`,
      });
    });
    return { revoked: true };
  }

  /** Who opened this record. Decision-makers and the auditor only. */
  @Get(':type/:id/views')
  @RequireRoles(...AUDIT_VIEWERS, 'ONDER_DIRECTEUR')
  async views(@Param('type') type: string, @Param('id') id: string, @Req() request: Request) {
    const user = request.authenticatedUser;
    const isAuditor = user?.roles.some((r) => r.code === 'AUDITOR');
    const subjectType = type === 'dossiers' ? 'DOSSIER' : type === 'items' ? 'ITEM' : null;
    if (!subjectType) throw new NotFoundException();
    if (!isAuditor) await this.subject(actorFrom(request).accountId, type, id);
    return this.dataSource.query(
      `SELECT v.occurred_at AS "occurredAt", p.full_name AS "personName", v.view_kind AS "kind", u.name AS "unit"
         FROM record_view_event v
         JOIN account a ON a.id = v.account_id JOIN person p ON p.id = a.person_id
         LEFT JOIN organisational_unit u ON u.id = a.organisational_unit_id
        WHERE (v.subject_type = $1 AND v.subject_id = $2)
           OR ($1 = 'ITEM' AND v.subject_type = 'DOCUMENT' AND v.subject_id IN
                (SELECT id FROM captured_document WHERE correspondence_item_id = $2))
        ORDER BY v.occurred_at DESC LIMIT 200`,
      [subjectType, id],
    );
  }

  private async subject(accountId: string, type: string, id: string) {
    if (type === 'dossiers') {
      await this.access.assertDossier(accountId, id);
      const [d] = await this.dataSource.query(`SELECT dossier_identity, subject FROM dossier WHERE id = $1`, [id]);
      return { table: 'dossier', subjectType: 'DOSSIER' as const, label: `${d.dossier_identity} — ${d.subject}` };
    }
    if (type === 'items') {
      await this.access.assertItem(accountId, id);
      const [i] = await this.dataSource.query(
        `SELECT registration_identity, subject FROM correspondence_item WHERE id = $1`,
        [id],
      );
      return { table: 'correspondence_item', subjectType: 'ITEM' as const, label: `${i.registration_identity ?? 'draft'} — ${i.subject}` };
    }
    throw new ForbiddenException();
  }
}

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [AccessController],
  providers: [{ provide: APP_GUARD, useClass: RecordAccessGuard }],
})
export class AccessModule {}
