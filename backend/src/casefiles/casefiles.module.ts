import { Body, Controller, Get, HttpCode, Module, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { actorFrom, BUSINESS_ROLES } from '../common/actor';
import { DocumentsModule } from '../documents/documents.module';
import { TimelineModule } from '../timeline/timeline.module';
import { CaseFilesService } from './casefiles.service';

const PLAN_EDITORS = ['RECORDS_MANAGER', 'SYS_ADMIN'];
const RETENTION_ROLES = ['RECORDS_MANAGER'];
const HOLD_ROLES = ['RECORDS_MANAGER', 'MINISTER', 'DIRECTEUR'];
const EXPORT_ROLES = ['RECORDS_MANAGER', 'MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR'];

class CategoryDto {
  @IsString() @MinLength(1) @MaxLength(40) code: string;
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID('4') parentId?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(200) retentionYears?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(['DESTROY', 'TRANSFER', 'REVIEW']) retentionAction?: 'DESTROY' | 'TRANSFER' | 'REVIEW' | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(365) handlingWorkingDays?: number | null;
  @IsOptional() @IsIn(['OPEN', 'INTERNAL', 'CONFIDENTIAL', 'SECRET']) defaultClassification?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID('4') defaultRouteId?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class CategoriseDto {
  @ValidateIf((_, v) => v !== null) @IsUUID('4') categoryId: string | null;
}

class RelationDto {
  @IsUUID('4') relatedDossierId: string;
  @IsIn(['RELATED', 'FOLLOW_UP', 'PRECEDES', 'SAME_SUBJECT']) relation: string;
  @IsOptional() @IsString() @MaxLength(600) note?: string;
}

class RetentionDto {
  @IsIn(['DESTROY', 'TRANSFER', 'RETAIN', 'EXTEND']) decision: 'DESTROY' | 'TRANSFER' | 'RETAIN' | 'EXTEND';
  @IsString() @MinLength(1, { message: 'A reason is required.' }) @MaxLength(1000) reason: string;
  @IsOptional() @IsDateString() extendUntil?: string;
}

class HoldDto {
  @IsIn(['SET', 'RELEASED']) action: 'SET' | 'RELEASED';
  @IsString() @MinLength(1, { message: 'A reason is required.' }) @MaxLength(1000) reason: string;
}

@Controller('api/casefiles')
export class FilePlanController {
  constructor(private readonly casefiles: CaseFilesService) {}

  @Get('categories')
  @RequireRoles(...BUSINESS_ROLES, 'SYS_ADMIN', 'AUDITOR')
  categories(@Query('all') all?: string) {
    return this.casefiles.categories(all === 'true');
  }

  @Post('categories')
  @RequireRoles(...PLAN_EDITORS)
  @HttpCode(201)
  create(@Body() dto: CategoryDto, @Req() request: Request) {
    return this.casefiles.saveCategory(actorFrom(request), null, dto);
  }

  @Put('categories/:id')
  @RequireRoles(...PLAN_EDITORS)
  update(@Param('id') id: string, @Body() dto: CategoryDto, @Req() request: Request) {
    return this.casefiles.saveCategory(actorFrom(request), id, dto);
  }

  @Get('retention')
  @RequireRoles(...RETENTION_ROLES, 'MINISTER', 'DIRECTEUR', 'AUDITOR')
  retention(@Query('filter') filter?: string) {
    return this.casefiles.retentionList((['due', 'upcoming', 'all'].includes(filter ?? '') ? filter : 'due') as 'due');
  }
}

@Controller('api/dossiers')
export class CaseFileDossierController {
  constructor(private readonly casefiles: CaseFilesService) {}

  @Post(':id/category')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  categorise(@Param('id') id: string, @Body() dto: CategoriseDto, @Req() request: Request) {
    return this.casefiles.categorise(actorFrom(request), id, dto.categoryId);
  }

  @Get(':id/relations')
  @RequireRoles(...BUSINESS_ROLES)
  relations(@Param('id') id: string, @Req() request: Request) {
    return this.casefiles.relations(request.authenticatedUser!.accountId, id);
  }

  @Post(':id/relations')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(201)
  relate(@Param('id') id: string, @Body() dto: RelationDto, @Req() request: Request) {
    return this.casefiles.relate(actorFrom(request), id, dto.relatedDossierId, dto.relation, dto.note);
  }

  @Get(':id/retention')
  @RequireRoles(...BUSINESS_ROLES)
  retention(@Param('id') id: string) {
    return this.casefiles.retentionOf(id);
  }

  @Post(':id/retention')
  @RequireRoles(...RETENTION_ROLES)
  @HttpCode(200)
  decide(@Param('id') id: string, @Body() dto: RetentionDto, @Req() request: Request) {
    return this.casefiles.decideRetention(actorFrom(request), id, dto.decision, dto.reason, dto.extendUntil);
  }

  @Post(':id/legal-hold')
  @RequireRoles(...HOLD_ROLES)
  @HttpCode(200)
  hold(@Param('id') id: string, @Body() dto: HoldDto, @Req() request: Request) {
    return this.casefiles.legalHold(actorFrom(request), id, dto.action, dto.reason);
  }

  @Get(':id/timeline/export.pdf')
  @RequireRoles(...BUSINESS_ROLES)
  async timelinePdf(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    const { bytes, filename } = await this.casefiles.timelinePdf(actorFrom(request), id);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.end(bytes);
  }

  @Get(':id/archive-package')
  @RequireRoles(...EXPORT_ROLES)
  async archive(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    const { bytes, filename, packageHash, sealId } = await this.casefiles.archivePackage(actorFrom(request), id);
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('X-Package-Sha256', packageHash);
    response.setHeader('X-Seal-Id', sealId);
    response.setHeader('Cache-Control', 'no-store');
    response.end(bytes);
  }
}

@Module({
  imports: [AuthModule, TimelineModule, DocumentsModule],
  controllers: [FilePlanController, CaseFileDossierController],
  providers: [CaseFilesService],
  exports: [CaseFilesService],
})
export class CaseFilesModule {}
