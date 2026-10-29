import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Module, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Request, Response } from 'express';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { actorFrom, DECISION_ROLES } from '../common/actor';
import { DocumentsModule } from '../documents/documents.module';
import { LettersModule } from '../letters/letters.module';
import { RecordsModule } from '../records/records.module';
import { ExchangeService } from './exchange.service';
import { IntegrationKeysService } from './integration-keys.service';
import { WijSamenService } from './wijsamen.service';

class KeyDto {
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsIn(['WIJSAMEN', 'MAIL_GATEWAY']) kind: 'WIJSAMEN' | 'MAIL_GATEWAY';
  @IsUUID() actAsAccountId: string;
}

class ReporterDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsEmail() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
}

class AttachmentDto {
  @IsString() @MinLength(1) @MaxLength(200) filename: string;
  @IsString() @MaxLength(100) contentType: string;
  @IsString() @MaxLength(30_000_000) base64: string;
}

class ReportDto {
  @IsString() @Matches(/^[A-Za-z0-9._\-/]{3,120}$/, { message: 'reference must be 3–120 letters, digits or . _ - /' }) reference: string;
  @IsOptional() @IsString() @MaxLength(120) category?: string;
  @IsString() @MinLength(3) @MaxLength(300) subject: string;
  @IsString() @MinLength(1) @MaxLength(20_000) description: string;
  @IsOptional() @ValidateNested() @Type(() => ReporterDto) reporter?: ReporterDto;
  @IsOptional() @IsString() @MaxLength(300) location?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) occurredOn?: string;
  @IsOptional() @IsISO8601() submittedAt?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => AttachmentDto) attachments?: AttachmentDto[];
}

class PartnerDto {
  @IsString() @MinLength(2) @MaxLength(40) code: string;
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsString() @MinLength(40) @MaxLength(2000) publicKeyPem: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class ExportDto {
  @IsString() @MinLength(2) @MaxLength(40) partnerCode: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) itemIds?: string[];
}

const REGISTRARS = ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER', 'RECORDS_MANAGER'];

@Controller('api/admin/integrations')
export class IntegrationKeysController {
  constructor(private readonly keys: IntegrationKeysService) {}

  @Get()
  @RequireRoles('SYS_ADMIN')
  list() {
    return this.keys.list();
  }

  @Post()
  @RequireRoles('SYS_ADMIN')
  @HttpCode(201)
  create(@Body() dto: KeyDto, @Req() request: Request) {
    return this.keys.create(actorFrom(request), dto);
  }

  @Post(':id/revoke')
  @RequireRoles('SYS_ADMIN')
  @HttpCode(200)
  revoke(@Param('id') id: string, @Req() request: Request) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('Unknown key.');
    return this.keys.revoke(actorFrom(request), id);
  }
}

/** For the WijSamen app. Authenticated by its integration key, not a session. */
@Controller('api/integrations/wijsamen')
export class WijSamenController {
  constructor(
    private readonly keys: IntegrationKeysService,
    private readonly wijsamen: WijSamenService,
  ) {}

  @Post('reports')
  @HttpCode(201)
  async receive(@Headers('x-api-key') key: string | undefined, @Body() dto: ReportDto) {
    const client = await this.keys.authenticate(key, 'WIJSAMEN');
    return this.wijsamen.receive(client, dto);
  }

  @Get('reports/:reference')
  async status(@Headers('x-api-key') key: string | undefined, @Param('reference') reference: string) {
    const client = await this.keys.authenticate(key, 'WIJSAMEN');
    return this.wijsamen.status(client, reference);
  }
}

@Controller('api/exchange')
export class ExchangeController {
  constructor(private readonly exchange: ExchangeService) {}

  /** This ministry's exchange identity, to give to a partner. */
  @Get('identity')
  @RequireRoles(...REGISTRARS, 'SYS_ADMIN')
  identity() {
    return this.exchange.identity();
  }

  @Get('partners')
  @RequireRoles(...REGISTRARS, 'SYS_ADMIN')
  partners() {
    return this.exchange.partners();
  }

  @Post('partners')
  @RequireRoles('SYS_ADMIN')
  @HttpCode(200)
  savePartner(@Body() dto: PartnerDto, @Req() request: Request) {
    return this.exchange.savePartner(actorFrom(request), dto);
  }

  @Get('log')
  @RequireRoles(...REGISTRARS, 'SYS_ADMIN', 'AUDITOR')
  log() {
    return this.exchange.log();
  }

  @Post('dossiers/:id/export')
  @RequireRoles(...DECISION_ROLES, 'SUPPORT_STAFF')
  @HttpCode(200)
  async export(@Param('id') id: string, @Body() dto: ExportDto, @Req() request: Request, @Res() response: Response) {
    const { bytes, filename, packageHash } = await this.exchange.export(actorFrom(request), id, dto);
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('X-Package-Sha256', packageHash);
    response.setHeader('Cache-Control', 'no-store');
    response.end(bytes);
  }

  @Post('verify')
  @RequireRoles(...REGISTRARS)
  @UseInterceptors(FileInterceptor('package'))
  @HttpCode(200)
  async verify(@UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer?.length) throw new BadRequestException('No package was received.');
    const { manifest, partner, packageHash } = await this.exchange.verify(file.buffer);
    return { valid: true, from: partner, packageHash, dossier: manifest.dossier, items: manifest.items.map((i) => ({ registrationIdentity: i.registrationIdentity, subject: i.subject, documents: i.documents.length })) };
  }

  @Post('import')
  @RequireRoles(...REGISTRARS)
  @UseInterceptors(FileInterceptor('package'))
  @HttpCode(201)
  import(@UploadedFile() file: Express.Multer.File, @Req() request: Request) {
    if (!file?.buffer?.length) throw new BadRequestException('No package was received.');
    return this.exchange.import(actorFrom(request), file.buffer);
  }
}

@Module({
  imports: [AuthModule, LettersModule, DocumentsModule, RecordsModule],
  controllers: [IntegrationKeysController, WijSamenController, ExchangeController],
  providers: [WijSamenService, ExchangeService],
})
export class IntegrationsModule {}
