import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Request } from 'express';
import { RequireRoles } from '../auth/require-roles.decorator';
import { RequireRolesOrDelegation } from '../delegation/delegated-authority.guard';
import { DelegatableAction } from '../delegation/delegation.entity';
import { DossierClosureService } from './dossier-closure.service';
import { DossierService, DossierView } from './dossier.service';
import { Actor } from './registration.service';
import { ResponsibilityService } from './responsibility.service';

export class CreateDossierDto {
  @IsString()
  @MinLength(1, { message: 'A subject is required.' })
  @MaxLength(400)
  subject: string;
}

export class LinkRecordDto {
  @IsUUID('4', { message: 'A valid record identifier is required.' })
  itemId: string;
}

export class CloseDossierDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsInt({ message: 'The version you are working from must be supplied.' })
  version: number;
}

export class ReopenDossierDto {
  @IsString({ message: 'A reason is required when reopening a closed dossier.' })
  @MaxLength(1000)
  reason: string;

  @IsInt({ message: 'The version you are working from must be supplied.' })
  version: number;
}

export class AssignResponsibilityDto {
  @IsUUID('4', { message: 'Choose who is to be responsible.' })
  responsibleAccountId: string;

  @IsInt({ message: 'The version you are working from must be supplied.' })
  version: number;
}

export class SetDueDateDto {
  /** null removes the official due date, which is a change, not an erasure. */
  @ValidateIf((dto: SetDueDateDto) => dto.dueDate !== null)
  @IsDateString({}, { message: 'Enter a valid date.' })
  dueDate: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  reason?: string;

  @IsInt({ message: 'The version you are working from must be supplied.' })
  version: number;
}

/** Same registering roles as the registry. SYS_ADMIN is absent (FR-SEC-010). */
const REGISTRARS = ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER'];

/**
 * Who may assign responsibility or set an official deadline (FS-02 §4).
 *
 * Support staff are excluded deliberately. They prepare and register work
 * without acquiring authority (FR-SEC-008), and acting on a principal's behalf
 * needs an explicit delegation that Delivery 1 has not built (FR-DEL-005).
 * Adding them here would grant by default what FR-DEL requires be granted
 * explicitly.
 */
const ASSIGNERS = ['DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER'];

@Controller('api/dossiers')
export class DossierController {
  constructor(
    private readonly dossiers: DossierService,
    private readonly responsibility: ResponsibilityService,
    private readonly closure: DossierClosureService,
  ) {}

  @Get()
  @RequireRoles(...REGISTRARS)
  list(): Promise<DossierView[]> {
    return this.dossiers.list();
  }

  @Post()
  @RequireRoles(...REGISTRARS)
  @HttpCode(201)
  create(@Body() dto: CreateDossierDto, @Req() request: Request): Promise<DossierView> {
    return this.dossiers.create(actorFrom(request), dto.subject);
  }

  @Post(':id/links')
  @RequireRoles(...REGISTRARS)
  @HttpCode(200)
  link(
    @Param('id') id: string,
    @Body() dto: LinkRecordDto,
    @Req() request: Request,
  ): Promise<DossierView> {
    return this.dossiers.link(actorFrom(request), id, dto.itemId);
  }

  /** Must precede ':id/...' routes so 'assignable' is not read as a dossier id. */
  @Get('assignable-officials')
  @RequireRoles(...ASSIGNERS)
  assignableOfficials() {
    return this.responsibility.assignableOfficials();
  }

  @Get(':id/history')
  @RequireRoles(...REGISTRARS)
  history(@Param('id') id: string) {
    return this.responsibility.historyFor(id);
  }

  /**
   * Closing and reopening the matter file (FR-DOS-006 to 008). Open to the
   * business roles at the door; the service then applies the configured
   * closure roles, so support staff reach a clear 403 rather than a 404.
   * Deliberately not delegatable (see dossier-closure-config).
   */
  @Get(':id/dossier-state')
  @RequireRoles(...REGISTRARS)
  dossierStateHistory(@Param('id') id: string) {
    return this.closure.historyFor(id);
  }

  @Post(':id/dossier-state/close')
  @RequireRoles(...REGISTRARS)
  @HttpCode(200)
  close(@Param('id') id: string, @Body() dto: CloseDossierDto, @Req() request: Request) {
    return this.closure.close(actorFrom(request), id, dto.reason ?? null, dto.version);
  }

  @Post(':id/dossier-state/reopen')
  @RequireRoles(...REGISTRARS)
  @HttpCode(200)
  reopenDossier(@Param('id') id: string, @Body() dto: ReopenDossierDto, @Req() request: Request) {
    return this.closure.reopen(actorFrom(request), id, dto.reason, dto.version);
  }

  @Post(':id/responsibility')
  @RequireRolesOrDelegation(DelegatableAction.ASSIGN_RESPONSIBILITY, ...ASSIGNERS)
  @HttpCode(200)
  async assign(
    @Param('id') id: string,
    @Body() dto: AssignResponsibilityDto,
    @Req() request: Request,
  ): Promise<DossierView> {
    await this.responsibility.assign(
      actorFrom(request),
      id,
      dto.responsibleAccountId,
      dto.version,
    );
    return this.dossiers.find(id);
  }

  @Post(':id/due-date')
  @RequireRolesOrDelegation(DelegatableAction.SET_DUE_DATE, ...ASSIGNERS)
  @HttpCode(200)
  async setDueDate(
    @Param('id') id: string,
    @Body() dto: SetDueDateDto,
    @Req() request: Request,
  ): Promise<DossierView> {
    await this.responsibility.setDueDate(
      actorFrom(request),
      id,
      dto.dueDate,
      dto.reason ?? null,
      dto.version,
    );
    return this.dossiers.find(id);
  }
}

/**
 * The actor is always the authenticated user. Where authority came from a
 * delegation, the represented authority travels alongside it — never instead of
 * it (FR-DEL-003).
 */
function actorFrom(request: Request): Actor {
  const user = request.authenticatedUser;
  const authority = request.representedAuthority;
  return {
    accountId: user?.accountId as string,
    description: user ? `${user.personName} (${user.email})` : 'unknown',
    onBehalfOfAccountId: authority?.principalAccountId,
    representedAuthority: authority?.principalDescription,
  };
}
