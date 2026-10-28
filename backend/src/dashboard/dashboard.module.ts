import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Module, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { IsObject, IsString, MaxLength, MinLength } from 'class-validator';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { actorFrom, BUSINESS_ROLES, MANAGEMENT_ROLES } from '../common/actor';
import { SearchService, SearchType } from '../search/search.service';
import { TasksModule } from '../tasks/tasks.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { DashboardService } from './dashboard.service';
import { ReportName, ReportsService } from './reports.service';

class SavedSearchDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @IsObject() query: Record<string, unknown>;
}

const REPORTS: ReportName[] = ['departments', 'workload', 'trends', 'overview'];

@Controller('api/my-work')
export class MyWorkController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequireRoles(...BUSINESS_ROLES)
  myWork(@Req() request: Request) {
    return this.dashboard.myWork(request.authenticatedUser!.accountId);
  }
}

@Controller('api/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('overview')
  @RequireRoles(...MANAGEMENT_ROLES)
  overview(@Req() request: Request) {
    return this.dashboard.overview(request.authenticatedUser!.accountId);
  }

  @Get('departments')
  @RequireRoles(...MANAGEMENT_ROLES)
  departments(@Query('days') days?: string) {
    return this.dashboard.departments(Math.min(Math.max(Number(days) || 90, 7), 730));
  }

  @Get('workload')
  @RequireRoles(...MANAGEMENT_ROLES)
  workload() {
    return this.dashboard.workload();
  }

  @Get('trends')
  @RequireRoles(...MANAGEMENT_ROLES)
  trends(@Query('months') months?: string) {
    return this.dashboard.trends(Math.min(Math.max(Number(months) || 12, 1), 36));
  }
}

@Controller('api/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get(':name.xlsx')
  @RequireRoles(...MANAGEMENT_ROLES)
  async excel(@Param('name') name: string, @Req() request: Request, @Res() response: Response) {
    if (!REPORTS.includes(name as ReportName)) throw new BadRequestException('Unknown report.');
    const { bytes, filename } = await this.reports.excel(actorFrom(request), name as ReportName);
    response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.end(bytes);
  }

  @Get(':name.pdf')
  @RequireRoles(...MANAGEMENT_ROLES)
  async pdf(@Param('name') name: string, @Req() request: Request, @Res() response: Response) {
    if (!REPORTS.includes(name as ReportName)) throw new BadRequestException('Unknown report.');
    const { bytes, filename } = await this.reports.pdf(actorFrom(request), name as ReportName);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.end(bytes);
  }
}

@Controller('api/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @RequireRoles(...BUSINESS_ROLES)
  find(@Req() request: Request, @Query() query: Record<string, string>) {
    const types = (query.types ?? '')
      .split(',')
      .filter((t): t is SearchType => ['ITEM', 'DOSSIER', 'TASK', 'DOCUMENT'].includes(t));
    const date = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);
    return this.search.search(request.authenticatedUser!.accountId, {
      q: query.q,
      types,
      direction: query.direction,
      party: query.party,
      from: date(query.from),
      to: date(query.to),
      state: query.state,
      classification: ['OPEN', 'INTERNAL', 'CONFIDENTIAL', 'SECRET'].includes(query.classification) ? query.classification : undefined,
      categoryId: uuid(query.categoryId),
      unitId: uuid(query.unitId),
      limit: Number(query.limit) || 25,
    });
  }

  @Get('saved')
  @RequireRoles(...BUSINESS_ROLES)
  saved(@Req() request: Request) {
    return this.search.saved(request.authenticatedUser!.accountId);
  }

  @Post('saved')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(201)
  save(@Body() dto: SavedSearchDto, @Req() request: Request) {
    return this.search.save(request.authenticatedUser!.accountId, dto.name, dto.query);
  }

  @Delete('saved/:id')
  @RequireRoles(...BUSINESS_ROLES)
  remove(@Param('id') id: string, @Req() request: Request) {
    return this.search.remove(request.authenticatedUser!.accountId, id);
  }
}

@Module({
  imports: [AuthModule, TasksModule, WorkflowModule, ApprovalsModule],
  controllers: [MyWorkController, DashboardController, ReportsController, SearchController],
  providers: [DashboardService, ReportsService, SearchService],
  exports: [DashboardService, SearchService],
})
export class DashboardModule {}
