import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsDateString, IsIn, IsUUID } from 'class-validator';
import { Request } from 'express';
import { RequireRoles } from '../auth/require-roles.decorator';
import { DelegatableAction } from './delegation.entity';
import { DelegationService, DelegationView } from './delegation.service';

export class GrantDelegationDto {
  @IsUUID('4', { message: 'Choose who is to receive the authority.' })
  delegateAccountId: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Choose at least one action to delegate.' })
  @IsIn(Object.values(DelegatableAction), {
    each: true,
    message: 'That action cannot be delegated.',
  })
  actions: string[];

  @IsDateString({}, { message: 'Enter a valid start date.' })
  validFrom: string;

  @IsDateString({}, { message: 'Enter a valid end date.' })
  validUntil: string;
}

/**
 * Anyone with a business role may read the delegation register: knowing who is
 * acting for whom is part of knowing who is accountable. Only a role permitted
 * by DEC-13 configuration may grant, and only the principal may revoke.
 */
const BUSINESS_ROLES = ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER'];

@Controller('api/delegations')
export class DelegationController {
  constructor(private readonly delegations: DelegationService) {}

  @Get()
  @RequireRoles(...BUSINESS_ROLES)
  list(): Promise<DelegationView[]> {
    return this.delegations.list();
  }

  /** Must precede ':id/...' so these are not read as delegation ids. */
  @Get('my-authority')
  @RequireRoles(...BUSINESS_ROLES)
  myAuthority(@Req() request: Request) {
    const user = request.authenticatedUser;
    return this.delegations.currentAuthority(
      user?.accountId as string,
      (user?.roles ?? []).map((r: { code: string }) => r.code),
    );
  }

  @Get('candidates')
  @RequireRoles(...BUSINESS_ROLES)
  candidates(): Promise<{ accountId: string; personName: string }[]> {
    return this.delegations.delegationCandidates();
  }

  @Post()
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(201)
  grant(@Body() dto: GrantDelegationDto, @Req() request: Request): Promise<DelegationView> {
    const user = request.authenticatedUser;
    return this.delegations.grant(
      {
        accountId: user?.accountId as string,
        description: `${user?.personName} (${user?.email})`,
        roles: (user?.roles ?? []).map((r: { code: string }) => r.code),
      },
      dto,
    );
  }

  @Post(':id/revoke')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  revoke(@Param('id') id: string, @Req() request: Request): Promise<DelegationView> {
    const user = request.authenticatedUser;
    return this.delegations.revoke(
      { accountId: user?.accountId as string, description: `${user?.personName} (${user?.email})` },
      id,
    );
  }
}
