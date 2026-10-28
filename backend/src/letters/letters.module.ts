import { Body, Controller, Get, Headers, HttpCode, Module, NotFoundException, Param, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { DataSource } from 'typeorm';
import { AccessService } from '../access/access.service';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { actorFrom } from '../common/actor';
import { SealService } from '../core/seal.service';
import { DocumentsModule } from '../documents/documents.module';
import { IntakeService } from '../intake/intake.service';
import { IntegrationKeysService } from '../integrations/integration-keys.service';
import { RecordsModule } from '../records/records.module';
import { LettersService } from './letters.service';

const REGISTRARS = ['SUPPORT_STAFF', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER', 'RECORDS_MANAGER'];
const TEMPLATE_EDITORS = ['SYS_ADMIN', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'MINISTER'];

class TemplateDto {
  @IsString() @MinLength(2) @MaxLength(40) code: string;
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsString() @MinLength(1) @MaxLength(50000) body: string;
  @IsOptional() @IsIn(['nl', 'en']) language?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class VersionDto {
  @IsString() @MinLength(1) @MaxLength(100000) body: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsUUID('4') templateId?: string;
  @IsOptional() @IsUUID('4') aiInteractionId?: string;
}

class ReplyDto {
  @IsOptional() @IsUUID('4') templateId?: string;
}

class ComposeDto {
  @IsOptional() @IsBoolean() seal?: boolean;
}

class FillDto {
  @IsUUID('4') itemId: string;
}

class TrackDto {
  @IsString() @MinLength(3) @MaxLength(80) reference: string;
  @IsString() @MinLength(4) @MaxLength(20) code: string;
}

@Controller('api/letters')
export class LetterTemplatesController {
  constructor(
    private readonly letters: LettersService,
    private readonly dataSource: DataSource,
    private readonly access: AccessService,
  ) {}

  @Get('templates')
  @RequireRoles(...REGISTRARS, 'SYS_ADMIN')
  templates(@Query('all') all?: string) {
    return this.letters.templates(all === 'true');
  }

  @Post('templates')
  @RequireRoles(...TEMPLATE_EDITORS)
  @HttpCode(201)
  create(@Body() dto: TemplateDto, @Req() request: Request) {
    return this.letters.saveTemplate(actorFrom(request), null, dto);
  }

  @Put('templates/:id')
  @RequireRoles(...TEMPLATE_EDITORS)
  update(@Param('id') id: string, @Body() dto: TemplateDto, @Req() request: Request) {
    return this.letters.saveTemplate(actorFrom(request), id, dto);
  }

  /** The template's text filled in for a letter, to start a draft from. */
  @Post('templates/:id/fill')
  @RequireRoles(...REGISTRARS)
  @HttpCode(200)
  async fill(@Param('id') id: string, @Body() dto: FillDto, @Req() request: Request) {
    const [item] = await this.dataSource.query(
      `SELECT ci.subject, ci.party, ci.registration_identity, ci.sender_reference, ci.document_date::text AS document_date,
              o.subject AS o_subject, o.party AS o_party, o.registration_identity AS o_identity,
              o.sender_reference AS o_sender_reference, o.document_date::text AS o_document_date
         FROM correspondence_item ci LEFT JOIN correspondence_item o ON o.id = ci.in_reply_to_item_id WHERE ci.id = $1`,
      [dto.itemId],
    );
    if (!item) throw new NotFoundException('Unknown item.');
    await this.access.assertItem(request.authenticatedUser!.accountId, dto.itemId);
    const source = item.o_identity
      ? { subject: item.o_subject, party: item.o_party, registration_identity: item.o_identity, sender_reference: item.o_sender_reference, document_date: item.o_document_date }
      : item;
    return { body: await this.letters.fillTemplate(id, source, item.o_identity ? item.registration_identity : null) };
  }
}

@Controller('api/records')
export class LettersController {
  constructor(private readonly letters: LettersService) {}

  @Get(':id/draft-versions')
  @RequireRoles(...REGISTRARS)
  versions(@Param('id') id: string) {
    return this.letters.versions(id);
  }

  @Post(':id/draft-versions')
  @RequireRoles(...REGISTRARS)
  @HttpCode(201)
  save(@Param('id') id: string, @Body() dto: VersionDto, @Req() request: Request) {
    return this.letters.saveVersion(actorFrom(request), id, dto);
  }

  @Post(':id/reply')
  @RequireRoles(...REGISTRARS)
  @HttpCode(201)
  reply(@Param('id') id: string, @Body() dto: ReplyDto, @Req() request: Request) {
    return this.letters.startReply(actorFrom(request), id, dto.templateId);
  }

  @Post(':id/compose')
  @RequireRoles(...REGISTRARS)
  @HttpCode(201)
  compose(@Param('id') id: string, @Body() dto: ComposeDto, @Req() request: Request) {
    return this.letters.compose(actorFrom(request), id, { seal: dto.seal === true });
  }

  @Post(':id/documents/:documentId/seal')
  @RequireRoles('MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR')
  @HttpCode(201)
  seal(@Param('id') id: string, @Param('documentId') documentId: string, @Req() request: Request) {
    return this.letters.sealDocument(actorFrom(request), id, documentId);
  }

  @Get(':id/tracking')
  @RequireRoles(...REGISTRARS)
  async tracking(@Param('id') id: string) {
    return (await this.letters.tracking(id)) ?? { code: null };
  }

  @Get(':id/label.pdf')
  @RequireRoles(...REGISTRARS)
  async label(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    const bytes = await this.letters.label(actorFrom(request), id);
    sendPdf(response, bytes, 'label.pdf');
  }

  @Get(':id/receipt.pdf')
  @RequireRoles(...REGISTRARS)
  async receipt(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    const bytes = await this.letters.receipt(actorFrom(request), id);
    sendPdf(response, bytes, 'ontvangstbevestiging.pdf');
  }
}

/** Everything a citizen or a partner may reach without signing in. */
@Controller('api/public')
export class PublicController {
  constructor(
    private readonly letters: LettersService,
    private readonly seals: SealService,
  ) {}

  @Post('track')
  @HttpCode(200)
  track(@Body() dto: TrackDto, @Req() request: Request) {
    const ip = (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? request.ip ?? null;
    return this.letters.publicTrack(dto.reference, dto.code, ip);
  }

  @Get('seals/:id')
  verify(@Param('id') id: string) {
    return this.letters.verifyPublic(id);
  }

  @Get('seal-key')
  key() {
    return { keyId: this.seals.keyId, algorithm: 'Ed25519', publicKeyPem: this.seals.publicKeyPem };
  }
}

@Controller('api/intake')
export class IntakeController {
  constructor(
    private readonly intake: IntakeService,
    private readonly keys: IntegrationKeysService,
  ) {}

  /** A registrar uploads an e-mail (.eml) to take it in as post. */
  @Post('email')
  @RequireRoles(...REGISTRARS)
  @UseInterceptors(FileInterceptor('message'))
  @HttpCode(201)
  upload(@UploadedFile() file: Express.Multer.File, @Req() request: Request) {
    if (!file?.buffer?.length) throw new NotFoundException('No e-mail was received.');
    return this.intake.fromEmail(actorFrom(request), file.buffer, 'UPLOAD');
  }

  /**
   * The ministry's mail server delivers an e-mail here (for example a Postfix
   * pipe to curl), with its integration key, the raw message as the body.
   */
  @Post('email/gateway')
  @HttpCode(201)
  async gateway(@Headers('x-api-key') key: string | undefined, @Req() request: Request) {
    const client = await this.keys.authenticate(key, 'MAIL_GATEWAY');
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body ?? ''));
    if (!raw.length) throw new NotFoundException('No e-mail was received.');
    return this.intake.fromEmail({ accountId: client.actAsAccountId, description: client.actAsDescription }, raw, 'GATEWAY');
  }
}

function sendPdf(response: Response, bytes: Buffer, filename: string): void {
  response.setHeader('Content-Type', 'application/pdf');
  response.setHeader('Content-Length', bytes.length);
  response.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'private, no-store');
  response.end(bytes);
}

@Module({
  imports: [AuthModule, DocumentsModule, RecordsModule],
  controllers: [LetterTemplatesController, LettersController, PublicController, IntakeController],
  providers: [LettersService, IntakeService, IntegrationKeysService],
  exports: [LettersService, IntakeService, IntegrationKeysService],
})
export class LettersModule {}
