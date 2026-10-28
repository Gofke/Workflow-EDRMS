import { Body, Controller, Get, HttpCode, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { actorFrom, BUSINESS_ROLES, DECISION_ROLES } from '../common/actor';
import { DelegationModule } from '../delegation/delegation.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ApprovalsService, RouteStep } from './approvals.service';

class StepDto {
  @IsIn(['ONDER_DIRECTEUR', 'DIRECTEUR', 'MINISTER']) role: RouteStep['role'];
  @IsString() @MinLength(1) @MaxLength(120) label: string;
}

class RouteDto {
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => StepDto) steps: StepDto[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class RouteSubmitDto {
  @IsUUID('4') routeId: string;
  @IsUUID('4', { message: 'Choose who decides the first step.' }) reviewerAccountId: string;
  @IsInt() version: number;
}

class StepApproveDto {
  @IsInt() version: number;
  @IsOptional() @IsUUID('4') nextReviewerAccountId?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

class AdviceDto {
  @IsUUID('4', { message: 'Choose whom you are asking.' }) requestedFromAccountId: string;
  @IsString() @MinLength(1, { message: 'Write the question you are asking.' }) @MaxLength(2000) question: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() dueDate?: string | null;
}

class AnswerDto {
  @IsString() @MinLength(1, { message: 'The advice cannot be empty.' }) @MaxLength(8000) answer: string;
}

class ReasonDto {
  @IsString() @MinLength(1, { message: 'A reason is required.' }) @MaxLength(600) reason: string;
}

class AbsenceDto {
  @IsDateString() startsOn: string;
  @IsDateString() endsOn: string;
  @IsUUID('4', { message: 'Choose a stand-in.' }) standInAccountId: string;
  @IsOptional() @IsString() @MaxLength(600) message?: string;
  @IsOptional() @IsBoolean() delegate?: boolean;
}

@Controller('api/approval-routes')
export class RoutesController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequireRoles(...BUSINESS_ROLES, 'SYS_ADMIN')
  list(@Query('all') all?: string) {
    return this.approvals.routes(all === 'true');
  }

  @Post()
  @RequireRoles('SYS_ADMIN', 'MINISTER', 'DIRECTEUR')
  @HttpCode(201)
  create(@Body() dto: RouteDto, @Req() request: Request) {
    return this.approvals.saveRoute(actorFrom(request), null, dto);
  }

  @Put(':id')
  @RequireRoles('SYS_ADMIN', 'MINISTER', 'DIRECTEUR')
  update(@Param('id') id: string, @Body() dto: RouteDto, @Req() request: Request) {
    return this.approvals.saveRoute(actorFrom(request), id, dto);
  }
}

@Controller('api/dossiers')
export class DossierApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get(':id/route')
  @RequireRoles(...BUSINESS_ROLES)
  route(@Param('id') id: string) {
    return this.approvals.routeOf(id);
  }

  @Post(':id/route/submit')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  submit(@Param('id') id: string, @Body() dto: RouteSubmitDto, @Req() request: Request) {
    return this.approvals.submitAlongRoute(actorFrom(request), id, dto.routeId, dto.reviewerAccountId, dto.version);
  }

  @Post(':id/route/approve')
  @RequireRoles(...DECISION_ROLES)
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() dto: StepApproveDto, @Req() request: Request) {
    return this.approvals.approveStep(actorFrom(request), id, dto.version, dto.nextReviewerAccountId, dto.note);
  }

  @Get(':id/advice')
  @RequireRoles(...BUSINESS_ROLES)
  advice(@Param('id') id: string) {
    return this.approvals.advices(id);
  }

  @Post(':id/advice')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(201)
  ask(@Param('id') id: string, @Body() dto: AdviceDto, @Req() request: Request) {
    return this.approvals.requestAdvice(actorFrom(request), id, dto);
  }
}

@Controller('api/advice')
export class AdviceController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('mine')
  @RequireRoles(...BUSINESS_ROLES)
  mine(@Req() request: Request) {
    return this.approvals.mine(request.authenticatedUser!.accountId);
  }

  @Post(':id/answer')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  async answer(@Param('id') id: string, @Body() dto: AnswerDto, @Req() request: Request) {
    await this.approvals.assertAdviceVisible(request.authenticatedUser!.accountId, id);
    return this.approvals.answer(actorFrom(request), id, dto.answer);
  }

  @Post(':id/withdraw')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  async withdraw(@Param('id') id: string, @Body() dto: ReasonDto, @Req() request: Request) {
    await this.approvals.assertAdviceVisible(request.authenticatedUser!.accountId, id);
    return this.approvals.withdraw(actorFrom(request), id, dto.reason);
  }
}

@Controller('api/out-of-office')
export class AbsenceController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('mine')
  @RequireRoles(...BUSINESS_ROLES)
  mine(@Req() request: Request) {
    return this.approvals.myAbsences(request.authenticatedUser!.accountId);
  }

  @Get('standing-in')
  @RequireRoles(...BUSINESS_ROLES)
  standingIn(@Req() request: Request) {
    return this.approvals.standingIn(request.authenticatedUser!.accountId);
  }

  @Post()
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(201)
  set(@Body() dto: AbsenceDto, @Req() request: Request) {
    const user = request.authenticatedUser!;
    return this.approvals.setAbsence({ ...actorFrom(request), roles: user.roles.map((r) => r.code) }, dto);
  }

  @Post(':id/end')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  end(@Param('id') id: string, @Req() request: Request) {
    return this.approvals.endAbsence(actorFrom(request), id);
  }
}

@Module({
  imports: [AuthModule, WorkflowModule, DelegationModule],
  controllers: [RoutesController, DossierApprovalsController, AdviceController, AbsenceController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
