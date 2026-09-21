import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { RequireRoles } from '../auth/require-roles.decorator';
import { ItemView, CreateDraftDto, RegisterDto, UpdateDraftDto } from './records.dto';
import { DuplicateService, PossibleDuplicate } from './duplicate.service';
import { Actor, RegistrationService } from './registration.service';

/**
 * Registration is support-staff work (FR-SEC-008): an assistant prepares and
 * registers without gaining approval authority. Directeur, Onder-Directeur and
 * Minister may also register.
 *
 * SYS_ADMIN is deliberately absent from every route here. System administration
 * confers no business-record access (FR-SEC-010), and the administrator's own
 * account must not be a back door into the registry.
 */
const REGISTRARS = ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER'];

@Controller('api/records')
export class RecordsController {
  constructor(
    private readonly registration: RegistrationService,
    private readonly duplicates: DuplicateService,
  ) {}

  @Get()
  @RequireRoles(...REGISTRARS)
  list(): Promise<ItemView[]> {
    return this.registration.list();
  }

  /**
   * FR-COR-016: registered records that may be duplicates of this one.
   * Advisory only; asking writes nothing and registration is never blocked.
   */
  @Get(':id/possible-duplicates')
  @RequireRoles(...REGISTRARS)
  possibleDuplicates(@Param('id') id: string): Promise<PossibleDuplicate[]> {
    return this.duplicates.candidatesFor(id);
  }

  @Post('drafts')
  @RequireRoles(...REGISTRARS)
  @HttpCode(201)
  createDraft(@Body() dto: CreateDraftDto, @Req() request: Request): Promise<ItemView> {
    return this.registration.createDraft(actorFrom(request), dto);
  }

  @Put('drafts/:id')
  @RequireRoles(...REGISTRARS)
  updateDraft(
    @Param('id') id: string,
    @Body() dto: UpdateDraftDto,
    @Req() request: Request,
  ): Promise<ItemView> {
    return this.registration.updateDraft(actorFrom(request), id, dto);
  }

  @Post(':id/register')
  @RequireRoles(...REGISTRARS)
  @HttpCode(200)
  register(
    @Param('id') id: string,
    @Body() dto: RegisterDto,
    @Req() request: Request,
  ): Promise<ItemView> {
    return this.registration.register(actorFrom(request), id, dto.version);
  }
}

/** The actor comes from the session. A client-supplied identity is never used. */
function actorFrom(request: Request): Actor {
  const user = request.authenticatedUser;
  return {
    accountId: user?.accountId as string,
    description: user ? `${user.personName} (${user.email})` : 'unknown',
  };
}
