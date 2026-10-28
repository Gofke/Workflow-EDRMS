import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Request, Response } from 'express';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { actorFrom, BUSINESS_ROLES } from '../common/actor';
import { TaskStatus, TasksService } from './tasks.service';
import { TemplatesService } from './templates.service';

const PRIORITY = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const STATUS = ['OPEN', 'ACCEPTED', 'IN_PROGRESS', 'WAITING', 'IN_REVIEW', 'COMPLETED', 'REJECTED', 'CANCELLED'];

class CreateTaskDto {
  @IsString() @MinLength(1, { message: 'A title is required.' }) @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsUUID('4', { message: 'Choose who the task is for.' }) assigneeAccountId: string;
  @IsOptional() @IsUUID('4') ownerAccountId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('4', { each: true }) audience?: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString({}, { message: 'Enter a valid due date.' }) dueDate?: string | null;
  @IsOptional() @IsIn(PRIORITY) priority?: string;
  @IsOptional() @IsUUID('4') dossierId?: string;
  @IsOptional() @IsUUID('4') itemId?: string;
  @IsOptional() @IsUUID('4') parentTaskId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) checklist?: string[];
  @IsOptional() @IsIn(['NONE', 'WEEKLY', 'MONTHLY']) recurrence?: string;
  @IsOptional() @IsIn(['MANUAL', 'AI_PROPOSAL', 'MEETING_NOTES', 'CHAT']) source?: string;
}

class UpdateTaskDto {
  @IsInt({ message: 'The version you are editing must be supplied.' }) version: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsOptional() @IsUUID('4') assigneeAccountId?: string;
  @IsOptional() @IsUUID('4') ownerAccountId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('4', { each: true }) audience?: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() dueDate?: string | null;
  @IsOptional() @IsIn(PRIORITY) priority?: string;
  @IsOptional() @IsIn(['NONE', 'WEEKLY', 'MONTHLY']) recurrence?: string;
}

class StatusDto {
  @IsIn(STATUS) status: TaskStatus;
  @IsInt() version: number;
  @IsOptional() @IsString() @MaxLength(600) note?: string;
}

class ReasonDto {
  @IsInt() version: number;
  @IsString() @MinLength(1, { message: 'A reason is required.' }) @MaxLength(600) reason: string;
}

class VersionDto {
  @IsInt() version: number;
}

class ChecklistAddDto {
  @IsString() @MinLength(1) @MaxLength(300) label: string;
}

class ChecklistPatchDto {
  @IsOptional() @IsBoolean() done?: boolean;
  @IsOptional() @IsString() @MaxLength(300) label?: string;
  @IsOptional() @IsBoolean() remove?: boolean;
}

class CommentDto {
  @IsString() @MinLength(1, { message: 'A comment cannot be empty.' }) @MaxLength(5000) body: string;
}

class BulkAssignDto {
  @IsArray() @ArrayMaxSize(200) @IsUUID('4', { each: true }) taskIds: string[];
  @IsUUID('4') assigneeAccountId: string;
}

class SubtaskTemplateDto {
  @IsString() @MinLength(1) @MaxLength(200) title: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() dueOffsetWorkingDays?: number | null;
}

class TemplateDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsString() @MinLength(1) @MaxLength(200) titleTemplate: string;
  @IsOptional() @IsIn(PRIORITY) defaultPriority?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() defaultDueWorkingDays?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) checklist?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(15) @ValidateNested({ each: true }) @Type(() => SubtaskTemplateDto) subtasks?: SubtaskTemplateDto[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class ApplyTemplateDto {
  @IsUUID('4') assigneeAccountId: string;
  @IsOptional() @IsUUID('4') dossierId?: string;
  @IsOptional() @IsUUID('4') itemId?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
}

@Controller('api/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @RequireRoles(...BUSINESS_ROLES)
  list(@Req() request: Request, @Query() query: Record<string, string>) {
    return this.tasks.list(request.authenticatedUser!.accountId, {
      scope: (['my', 'owner', 'audience', 'assigned', 'all', 'unit'].includes(query.scope) ? query.scope : 'all') as 'all',
      status: query.status,
      priority: query.priority,
      q: query.q,
      dossierId: uuidOrUndefined(query.dossierId),
      itemId: uuidOrUndefined(query.itemId),
      due: (['overdue', 'today', 'week'].includes(query.due) ? query.due : undefined) as 'overdue',
      assigneeAccountId: uuidOrUndefined(query.assigneeAccountId),
      includeArchived: query.includeArchived === 'true',
      includeClosed: query.includeClosed === 'false' ? false : undefined,
      from: dateOrUndefined(query.from),
      to: dateOrUndefined(query.to),
      page: Number(query.page) || 1,
      limit: Number(query.limit) || 50,
    });
  }

  @Get('counts')
  @RequireRoles(...BUSINESS_ROLES)
  counts(@Req() request: Request) {
    return this.tasks.counts(request.authenticatedUser!.accountId);
  }

  @Post()
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(201)
  create(@Body() dto: CreateTaskDto, @Req() request: Request) {
    return this.tasks.create(actorFrom(request), dto);
  }

  @Post('bulk-assign')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  bulk(@Body() dto: BulkAssignDto, @Req() request: Request) {
    return this.tasks.bulkAssign(actorFrom(request), dto.taskIds, dto.assigneeAccountId);
  }

  @Get(':id')
  @RequireRoles(...BUSINESS_ROLES)
  detail(@Param('id') id: string, @Req() request: Request) {
    return this.tasks.detail(request.authenticatedUser!.accountId, id);
  }

  @Put(':id')
  @RequireRoles(...BUSINESS_ROLES)
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto, @Req() request: Request) {
    return this.tasks.update(actorFrom(request), id, dto);
  }

  @Post(':id/status')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  status(@Param('id') id: string, @Body() dto: StatusDto, @Req() request: Request) {
    return this.tasks.changeStatus(actorFrom(request), id, dto.status, dto.version, dto.note);
  }

  @Post(':id/accept')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  accept(@Param('id') id: string, @Body() dto: VersionDto, @Req() request: Request) {
    return this.tasks.changeStatus(actorFrom(request), id, 'ACCEPTED', dto.version);
  }

  @Post(':id/reject')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  reject(@Param('id') id: string, @Body() dto: ReasonDto, @Req() request: Request) {
    return this.tasks.changeStatus(actorFrom(request), id, 'REJECTED', dto.version, dto.reason);
  }

  @Post(':id/complete')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  complete(@Param('id') id: string, @Body() dto: VersionDto, @Req() request: Request) {
    return this.tasks.changeStatus(actorFrom(request), id, 'COMPLETED', dto.version);
  }

  @Post(':id/cancel')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  cancel(@Param('id') id: string, @Body() dto: ReasonDto, @Req() request: Request) {
    return this.tasks.changeStatus(actorFrom(request), id, 'CANCELLED', dto.version, dto.reason);
  }

  @Post(':id/archive')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  archive(@Param('id') id: string, @Req() request: Request) {
    return this.tasks.archive(actorFrom(request), id);
  }

  @Post(':id/checklist')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  addChecklist(@Param('id') id: string, @Body() dto: ChecklistAddDto, @Req() request: Request) {
    return this.tasks.addChecklistItem(actorFrom(request), id, dto.label);
  }

  @Patch(':id/checklist/:itemId')
  @RequireRoles(...BUSINESS_ROLES)
  patchChecklist(@Param('id') id: string, @Param('itemId') itemId: string, @Body() dto: ChecklistPatchDto, @Req() request: Request) {
    return this.tasks.updateChecklistItem(actorFrom(request), id, itemId, dto);
  }

  @Post(':id/subtasks')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(201)
  subtask(@Param('id') id: string, @Body() dto: CreateTaskDto, @Req() request: Request) {
    return this.tasks.create(actorFrom(request), { ...dto, parentTaskId: id });
  }

  @Post(':id/comments')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(201)
  comment(@Param('id') id: string, @Body() dto: CommentDto, @Req() request: Request) {
    return this.tasks.comment(actorFrom(request), id, dto.body);
  }

  @Post(':id/attachments')
  @RequireRoles(...BUSINESS_ROLES)
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(201)
  attach(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Req() request: Request) {
    return this.tasks.attach(actorFrom(request), id, file);
  }

  @Get(':id/attachments/:attachmentId/content')
  @RequireRoles(...BUSINESS_ROLES)
  async content(@Param('id') id: string, @Param('attachmentId') attachmentId: string, @Req() request: Request, @Res() response: Response) {
    const { bytes, mediaType, filename } = await this.tasks.attachmentContent(request.authenticatedUser!.accountId, id, attachmentId);
    response.setHeader('Content-Type', mediaType);
    response.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.end(bytes);
  }
}

@Controller('api/task-templates')
export class TaskTemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @RequireRoles(...BUSINESS_ROLES, 'SYS_ADMIN')
  list(@Query('all') all?: string) {
    return this.templates.list(all === 'true');
  }

  @Post()
  @RequireRoles('DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER', 'SYS_ADMIN')
  @HttpCode(201)
  create(@Body() dto: TemplateDto, @Req() request: Request) {
    return this.templates.save(actorFrom(request), null, dto);
  }

  @Put(':id')
  @RequireRoles('DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER', 'SYS_ADMIN')
  update(@Param('id') id: string, @Body() dto: TemplateDto, @Req() request: Request) {
    return this.templates.save(actorFrom(request), id, dto);
  }

  @Post(':id/apply')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(201)
  apply(@Param('id') id: string, @Body() dto: ApplyTemplateDto, @Req() request: Request) {
    return this.templates.apply(actorFrom(request), id, dto);
  }
}

function uuidOrUndefined(v?: string): string | undefined {
  return v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined;
}

function dateOrUndefined(v?: string): string | undefined {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

@Module({
  imports: [AuthModule],
  controllers: [TasksController, TaskTemplatesController],
  providers: [TasksService, TemplatesService],
  exports: [TasksService, TemplatesService],
})
export class TasksModule {}
