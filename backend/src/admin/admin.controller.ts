import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuditEvent } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { RequireRoles } from '../auth/require-roles.decorator';
import { AccountStateDto, AccountSummary, RoleChangeDto } from './admin.dto';
import { AdminService, AuditActor } from './admin.service';

/** Every route here requires an authenticated session plus the SYS_ADMIN role. */
@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly audit: AuditService,
  ) {}

  @Get('accounts')
  @RequireRoles('SYS_ADMIN')
  listAccounts(): Promise<AccountSummary[]> {
    return this.adminService.listAccounts();
  }

  @Post('roles/assign')
  @RequireRoles('SYS_ADMIN')
  @HttpCode(200)
  async assignRole(@Body() dto: RoleChangeDto, @Req() request: Request) {
    await this.adminService.assignRole(actorFrom(request), dto.accountId, dto.roleCode);
    return { applied: true };
  }

  @Post('roles/revoke')
  @RequireRoles('SYS_ADMIN')
  @HttpCode(200)
  async revokeRole(@Body() dto: RoleChangeDto, @Req() request: Request) {
    await this.adminService.revokeRole(actorFrom(request), dto.accountId, dto.roleCode);
    return { applied: true };
  }

  @Post('accounts/disable')
  @RequireRoles('SYS_ADMIN')
  @HttpCode(200)
  async disable(@Body() dto: AccountStateDto, @Req() request: Request) {
    await this.adminService.setAccountEnabled(actorFrom(request), dto.accountId, false);
    return { applied: true };
  }

  @Post('accounts/enable')
  @RequireRoles('SYS_ADMIN')
  @HttpCode(200)
  async enable(@Body() dto: AccountStateDto, @Req() request: Request) {
    await this.adminService.setAccountEnabled(actorFrom(request), dto.accountId, true);
    return { applied: true };
  }

  /** Identity and permission events only. No record content exists here. */
  @Get('audit')
  @RequireRoles('SYS_ADMIN')
  listAudit(@Query('limit') limit?: string): Promise<AuditEvent[]> {
    return this.audit.list(limit ? Number(limit) : 100);
  }
}

/** The authenticated actor, taken from the session — never from the request body. */
function actorFrom(request: Request): AuditActor {
  const user = request.authenticatedUser;
  return {
    accountId: user?.accountId ?? null,
    description: user ? `${user.personName} (${user.email})` : 'unknown',
  } as AuditActor;
}
