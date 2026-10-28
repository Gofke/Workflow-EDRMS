import { Controller, Get, HttpCode, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { actorFrom } from '../common/actor';
import { AuditQuery, AuditViewerService } from './audit-viewer.service';
import { IntegrityService } from './integrity.service';

const FULL_VIEW = ['AUDITOR', 'MINISTER'];
const READERS = [...FULL_VIEW, 'SYS_ADMIN'];

function restricted(request: Request): boolean {
  return !request.authenticatedUser!.roles.some((r) => FULL_VIEW.includes(r.code));
}

function query(q: Record<string, string>): AuditQuery {
  return {
    from: q.from,
    to: q.to,
    type: q.type,
    category: q.category,
    actor: q.actor,
    q: q.q,
    page: Number(q.page) || 1,
    limit: Number(q.limit) || 50,
  };
}

@Controller('api/audit')
export class AuditController {
  constructor(private readonly viewer: AuditViewerService) {}

  @Get('types')
  @RequireRoles(...READERS)
  types() {
    return this.viewer.types();
  }

  @Get('overview')
  @RequireRoles(...READERS)
  overview(@Req() request: Request, @Query('days') days?: string) {
    return this.viewer.overview(Math.min(Math.max(Number(days) || 30, 1), 366), restricted(request));
  }

  @Get('events')
  @RequireRoles(...READERS)
  list(@Req() request: Request, @Query() q: Record<string, string>) {
    return this.viewer.list(query(q), restricted(request));
  }

  @Get('events.csv')
  @RequireRoles(...READERS)
  async csv(@Req() request: Request, @Query() q: Record<string, string>, @Res() response: Response) {
    const { bytes } = await this.viewer.csv(actorFrom(request), query(q), restricted(request));
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="logboek-${new Date().toISOString().slice(0, 10)}.csv"`);
    response.setHeader('Cache-Control', 'no-store');
    response.end(bytes);
  }

  @Get('events.xlsx')
  @RequireRoles(...READERS)
  async excel(@Req() request: Request, @Query() q: Record<string, string>, @Res() response: Response) {
    const { bytes } = await this.viewer.excel(actorFrom(request), query(q), restricted(request));
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', `attachment; filename="logboek-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    response.setHeader('Cache-Control', 'no-store');
    response.end(bytes);
  }
}

@Controller('api/integrity')
export class IntegrityController {
  constructor(private readonly integrity: IntegrityService) {}

  @Post('run')
  @RequireRoles('AUDITOR', 'SYS_ADMIN')
  @HttpCode(200)
  run(@Req() request: Request) {
    return this.integrity.run(actorFrom(request));
  }

  @Get('runs')
  @RequireRoles(...READERS)
  runs() {
    return this.integrity.runs();
  }

  @Get('runs/:id')
  @RequireRoles(...READERS)
  report(@Param('id') id: string) {
    return this.integrity.report(id);
  }

  @Get('runs/:id/report.pdf')
  @RequireRoles(...READERS)
  async pdf(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    const bytes = await this.integrity.pdf(actorFrom(request), id);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `attachment; filename="integriteitsverklaring-${id.slice(0, 8)}.pdf"`);
    response.end(bytes);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [AuditController, IntegrityController],
  providers: [AuditViewerService, IntegrityService],
  exports: [IntegrityService],
})
export class OversightModule {}
