import { Body, Controller, Delete, Get, HttpCode, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { actorFrom, BUSINESS_ROLES } from '../common/actor';
import { TasksModule } from '../tasks/tasks.module';
import { ProjectsService } from './projects.service';

class PhaseDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsDateString({}, { message: 'Enter a valid start date.' }) startDate: string;
  @IsDateString({}, { message: 'Enter a valid end date.' }) endDate: string;
}

class CreateProjectDto {
  @IsString() @MinLength(1, { message: 'A project needs a name.' }) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsUUID('4', { message: 'Choose the unit the project belongs to.' }) unitId: string;
  @IsOptional() @IsUUID('4') ownerAccountId?: string;
  @IsUUID('4', { message: 'Choose the project manager.' }) managerAccountId: string;
  @IsDateString({}, { message: 'Enter a valid start date.' }) startDate: string;
  @IsDateString({}, { message: 'Enter a valid end date.' }) endDate: string;
  @IsOptional() @IsIn(['INTERNAL', 'CONFIDENTIAL']) classification?: 'INTERNAL' | 'CONFIDENTIAL';
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsUUID('4', { each: true }) stakeholders?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(60) @IsUUID('4', { each: true }) members?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => PhaseDto) milestones?: PhaseDto[];
}

class UpdateProjectDto {
  @IsInt() version: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsIn(['INTERNAL', 'CONFIDENTIAL']) classification?: 'INTERNAL' | 'CONFIDENTIAL';
  @IsOptional() @IsUUID('4') ownerAccountId?: string;
  @IsOptional() @IsUUID('4') managerAccountId?: string;
}

class MemberDto {
  @IsUUID('4', { message: 'Choose a person.' }) accountId: string;
  @IsIn(['STAKEHOLDER', 'MEMBER']) role: 'STAKEHOLDER' | 'MEMBER';
}

class BusinessCaseDto {
  @IsInt() version: number;
  @IsOptional() @IsString() @MaxLength(8000) problem?: string;
  @IsOptional() @IsString() @MaxLength(8000) solution?: string;
  @IsOptional() @IsString() @MaxLength(8000) benefits?: string;
  @IsOptional() @IsString() @MaxLength(8000) costs?: string;
  @IsOptional() @IsString() @MaxLength(8000) risks?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) budget?: number | null;
}

class VersionDto {
  @IsInt() version: number;
}

class DecisionDto {
  @IsInt() version: number;
  @IsOptional() @IsString() @MaxLength(600) reason?: string;
}

class CloseDto {
  @IsInt() version: number;
  @IsOptional() @IsString() @MaxLength(600) note?: string;
}

class MilestoneDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsDateString() startDate: string;
  @IsDateString() endDate: string;
}

class MilestonePatchDto {
  @IsInt() version: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
}

class TicketDto {
  @IsUUID('4', { message: 'Choose a phase.' }) milestoneId: string;
  @IsString() @MinLength(1, { message: 'A title is required.' }) @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsUUID('4', { message: 'Choose who the ticket is for.' }) assigneeAccountId: string;
  @IsOptional() @IsDateString({}, { message: 'Enter a valid start date.' }) startDate?: string;
  @IsOptional() @IsDateString({}, { message: 'Enter a valid due date.' }) dueDate?: string;
  @IsOptional() @IsIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT']) priority?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) checklist?: string[];
}

class StatusDto {
  @IsIn(['HOLD', 'RESUME', 'CANCEL']) action: 'HOLD' | 'RESUME' | 'CANCEL';
  @IsInt() version: number;
  @IsOptional() @IsString() @MaxLength(600) reason?: string;
}

/**
 * Projects. Every route is for the ministry's business roles; inside, each
 * project decides who sees what (ProjectsService: need-to-know).
 */
@Controller('api/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequireRoles(...BUSINESS_ROLES)
  list(@Req() request: Request, @Query() query: Record<string, string>) {
    return this.projects.list(request.authenticatedUser!.accountId, {
      scope: query.scope === 'mine' ? 'mine' : 'all',
      status: query.status,
      q: query.q,
    });
  }

  @Post()
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(201)
  create(@Body() dto: CreateProjectDto, @Req() request: Request) {
    return this.projects.create(actorFrom(request), { ...dto, startDate: dto.startDate.slice(0, 10), endDate: dto.endDate.slice(0, 10) });
  }

  @Get(':id')
  @RequireRoles(...BUSINESS_ROLES)
  detail(@Param('id') id: string, @Req() request: Request) {
    return this.projects.detail(request.authenticatedUser!.accountId, id);
  }

  @Put(':id')
  @RequireRoles(...BUSINESS_ROLES)
  update(@Param('id') id: string, @Body() dto: UpdateProjectDto, @Req() request: Request) {
    return this.projects.update(actorFrom(request), id, { ...dto, startDate: dto.startDate?.slice(0, 10), endDate: dto.endDate?.slice(0, 10) });
  }

  @Post(':id/members')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  addMember(@Param('id') id: string, @Body() dto: MemberDto, @Req() request: Request) {
    return this.projects.addMember(actorFrom(request), id, dto.accountId, dto.role);
  }

  @Delete(':id/members/:accountId')
  @RequireRoles(...BUSINESS_ROLES)
  removeMember(@Param('id') id: string, @Param('accountId') accountId: string, @Req() request: Request) {
    return this.projects.removeMember(actorFrom(request), id, accountId);
  }

  @Put(':id/business-case')
  @RequireRoles(...BUSINESS_ROLES)
  saveBusinessCase(@Param('id') id: string, @Body() dto: BusinessCaseDto, @Req() request: Request) {
    return this.projects.saveBusinessCase(actorFrom(request), id, dto);
  }

  @Post(':id/business-case/submit')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  submit(@Param('id') id: string, @Body() dto: VersionDto, @Req() request: Request) {
    return this.projects.submitBusinessCase(actorFrom(request), id, dto.version);
  }

  @Post(':id/business-case/approve')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() dto: DecisionDto, @Req() request: Request) {
    return this.projects.decideBusinessCase(actorFrom(request), id, 'APPROVE', dto.version, dto.reason);
  }

  @Post(':id/business-case/return')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  returnCase(@Param('id') id: string, @Body() dto: DecisionDto, @Req() request: Request) {
    return this.projects.decideBusinessCase(actorFrom(request), id, 'RETURN', dto.version, dto.reason);
  }

  @Post(':id/milestones')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(201)
  addMilestone(@Param('id') id: string, @Body() dto: MilestoneDto, @Req() request: Request) {
    return this.projects.addMilestone(actorFrom(request), id, { ...dto, startDate: dto.startDate.slice(0, 10), endDate: dto.endDate.slice(0, 10) });
  }

  @Put(':id/milestones/:milestoneId')
  @RequireRoles(...BUSINESS_ROLES)
  updateMilestone(@Param('id') id: string, @Param('milestoneId') milestoneId: string, @Body() dto: MilestonePatchDto, @Req() request: Request) {
    return this.projects.updateMilestone(actorFrom(request), id, milestoneId, {
      ...dto,
      startDate: dto.startDate?.slice(0, 10),
      endDate: dto.endDate?.slice(0, 10),
    });
  }

  @Post(':id/milestones/:milestoneId/close')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  closeMilestone(@Param('id') id: string, @Param('milestoneId') milestoneId: string, @Body() dto: CloseDto, @Req() request: Request) {
    return this.projects.closeMilestone(actorFrom(request), id, milestoneId, dto.version, dto.note);
  }

  @Post(':id/tickets')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(201)
  addTicket(@Param('id') id: string, @Body() dto: TicketDto, @Req() request: Request) {
    return this.projects.addTicket(actorFrom(request), id, { ...dto, startDate: dto.startDate?.slice(0, 10), dueDate: dto.dueDate?.slice(0, 10) });
  }

  @Post(':id/status')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  status(@Param('id') id: string, @Body() dto: StatusDto, @Req() request: Request) {
    return this.projects.changeStatus(actorFrom(request), id, dto.action, dto.version, dto.reason);
  }
}

@Module({
  imports: [AuthModule, TasksModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
