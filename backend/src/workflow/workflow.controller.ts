import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { IsInt, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Request } from 'express';
import { RequireRoles } from '../auth/require-roles.decorator';
import { Actor } from '../records/registration.service';
import { WorkflowService } from './workflow.service';

export class SubmitDto {
  @IsUUID('4', { message: 'Choose who is to review this matter.' })
  reviewerAccountId: string;

  @IsInt({ message: 'The version you are working from must be supplied.' })
  version: number;
}

export class ReturnDto {
  @IsString()
  @MinLength(1, { message: 'A reason is required when returning a matter.' })
  @MaxLength(1000)
  reason: string;

  @IsInt({ message: 'The version you are working from must be supplied.' })
  version: number;
}

export class DecideDto {
  @IsInt({ message: 'The version you are working from must be supplied.' })
  version: number;
}

/**
 * Submission is support-staff work (FR-WFL-013). The decision itself is
 * restricted inside the service to the designated reviewer, which is a stricter
 * test than a role: holding a senior role does not let you decide on a matter
 * that was routed to someone else (FR-WFL-004).
 */
const BUSINESS_ROLES = ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER'];

@Controller('api/dossiers')
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  /** Must precede ':id/...' so these are not read as dossier ids. */
  @Get('review-queue')
  @RequireRoles(...BUSINESS_ROLES)
  queue(@Req() request: Request) {
    return this.workflow.reviewQueueFor(request.authenticatedUser?.accountId as string);
  }

  @Get('eligible-reviewers')
  @RequireRoles(...BUSINESS_ROLES)
  reviewers(@Req() request: Request) {
    return this.workflow.eligibleReviewers(request.authenticatedUser?.accountId as string);
  }

  @Get(':id/workflow')
  @RequireRoles(...BUSINESS_ROLES)
  history(@Param('id') id: string) {
    return this.workflow.historyFor(id);
  }

  @Post(':id/submit')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  submit(@Param('id') id: string, @Body() dto: SubmitDto, @Req() request: Request) {
    return this.workflow.submit(actorFrom(request), id, dto.reviewerAccountId, dto.version);
  }

  @Post(':id/return')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  returnForCorrection(
    @Param('id') id: string,
    @Body() dto: ReturnDto,
    @Req() request: Request,
  ) {
    return this.workflow.returnForCorrection(actorFrom(request), id, dto.reason, dto.version);
  }

  @Post(':id/finalise')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  finalise(@Param('id') id: string, @Body() dto: DecideDto, @Req() request: Request) {
    return this.workflow.finalise(actorFrom(request), id, dto.version);
  }

  @Post(':id/reopen')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  reopen(@Param('id') id: string, @Body() dto: ReturnDto, @Req() request: Request) {
    return this.workflow.reopen(actorFrom(request), id, dto.reason, dto.version);
  }

  @Post(':id/approve')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() dto: DecideDto, @Req() request: Request) {
    return this.workflow.approve(actorFrom(request), id, dto.version);
  }
}

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
