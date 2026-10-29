import { Body, Controller, Get, HttpCode, Module, Param, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { actorFrom, BUSINESS_ROLES, MANAGEMENT_ROLES } from '../common/actor';
import { DashboardModule } from '../dashboard/dashboard.module';
import { LettersModule } from '../letters/letters.module';
import { TasksModule } from '../tasks/tasks.module';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
import { probe } from './llm';
import { HELP, searchHelp } from './engine/help';

class LanguageDto {
  @IsOptional() @IsIn(['nl', 'en']) language?: 'nl' | 'en';
}

class DraftReplyDto {
  @IsOptional() @IsIn(['formal', 'short']) tone?: 'formal' | 'short';
  @IsOptional() @IsIn(['nl', 'en']) language?: 'nl' | 'en';
}

class TextDto {
  @IsString() @MinLength(1, { message: 'Paste the text of the letter.' }) @MaxLength(100_000) text: string;
}

class DeadlinesDto {
  @IsOptional() @IsUUID() itemId?: string;
  @IsOptional() @IsString() @MaxLength(100_000) text?: string;
}

class TranslateDto {
  @IsOptional() @IsString() @MaxLength(20_000) text?: string;
  @IsIn(['nl', 'en']) to: 'nl' | 'en';
  @IsOptional() @IsUUID() itemId?: string;
}

class NotesDto {
  @IsString() @MinLength(1, { message: 'Paste the meeting notes.' }) @MaxLength(60_000) text: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() dossierId?: string | null;
}

class AskDto {
  @IsString() @MinLength(1, { message: 'Ask a question.' }) @MaxLength(500) question: string;
  @IsOptional() @IsIn(['nl', 'en']) language?: 'nl' | 'en';
}

class ContextDto {
  @IsIn(['ITEM', 'DOSSIER']) type: 'ITEM' | 'DOSSIER';
  @IsUUID() id: string;
}

class ChatDto {
  @IsOptional() @IsUUID() conversationId?: string;
  @IsString() @MinLength(1, { message: 'Type a message.' }) @MaxLength(4000) message: string;
  @IsOptional() @IsIn(['nl', 'en']) language?: 'nl' | 'en';
  @IsOptional() @ValidateIf((_, v) => v !== null) @ValidateNested() @Type(() => ContextDto) context?: ContextDto | null;
}

class ApplyTaskDto {
  @IsString() @MinLength(1) @MaxLength(200) title: string;
  @IsUUID() assigneeAccountId: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() dueDate?: string | null;
  @IsOptional() @IsIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT']) priority?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() dossierId?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
}

class ApplyDto {
  @IsOptional() @IsUUID() targetItemId?: string;
  @IsOptional() @IsString() @MaxLength(60_000) body?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => ApplyTaskDto) tasks?: ApplyTaskDto[];
}

class FeedbackDto {
  @IsIn(['ACCEPTED', 'EDITED', 'REJECTED']) outcome: 'ACCEPTED' | 'EDITED' | 'REJECTED';
  @IsOptional() @IsString() @MaxLength(600) note?: string;
  @IsOptional() @ValidateNested() @Type(() => ApplyDto) apply?: ApplyDto;
}

@Controller('api/ai')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly chat: ChatService,
  ) {}

  @Get('status')
  @RequireRoles(...BUSINESS_ROLES, 'SYS_ADMIN', 'AUDITOR')
  status(@Req() request: Request) {
    return this.ai.status(request.authenticatedUser!.accountId);
  }

  @Get('model-check')
  @RequireRoles('SYS_ADMIN')
  async modelCheck() {
    return probe(await this.ai.config());
  }

  /** The help articles the chatbot answers from, for the Help page. Not a switchable AI feature. */
  @Get('help')
  @RequireRoles(...BUSINESS_ROLES, 'SYS_ADMIN', 'AUDITOR')
  help(@Query('q') q?: string) {
    const strip = (a: (typeof HELP)[number]) => ({ id: a.id, link: a.link, nl: a.nl, en: a.en });
    if (q?.trim()) return searchHelp(q.slice(0, 300), 8).map((r) => ({ ...strip(r.article), score: r.score }));
    return HELP.map(strip);
  }

  @Post('items/:id/intake')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  intakeForItem(@Param('id') id: string, @Req() request: Request) {
    return this.ai.intakeForItem(actorFrom(request), id);
  }

  @Post('intake')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  intakeFromText(@Body() dto: TextDto, @Req() request: Request) {
    return this.ai.intakeFromText(actorFrom(request), dto.text);
  }

  @Post('items/:id/routing')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  routing(@Param('id') id: string, @Req() request: Request) {
    return this.ai.routing(actorFrom(request), id);
  }

  @Post('items/:id/duplicates')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  duplicates(@Param('id') id: string, @Req() request: Request) {
    return this.ai.duplicates(actorFrom(request), id);
  }

  @Post('items/:id/summary')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  summariseItem(@Param('id') id: string, @Body() dto: LanguageDto, @Req() request: Request) {
    return this.ai.summariseItem(actorFrom(request), id, dto.language);
  }

  @Post('dossiers/:id/summary')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  summariseDossier(@Param('id') id: string, @Body() dto: LanguageDto, @Req() request: Request) {
    return this.ai.summariseDossier(actorFrom(request), id, dto.language);
  }

  @Post('items/:id/draft-reply')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  draftReply(@Param('id') id: string, @Body() dto: DraftReplyDto, @Req() request: Request) {
    return this.ai.draftReply(actorFrom(request), id, dto);
  }

  @Post('deadlines')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  deadlines(@Body() dto: DeadlinesDto, @Req() request: Request) {
    return this.ai.deadlines(actorFrom(request), dto);
  }

  @Post('translate')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  translate(@Body() dto: TranslateDto, @Req() request: Request) {
    return this.ai.translate(actorFrom(request), { text: dto.text ?? '', to: dto.to, itemId: dto.itemId });
  }

  @Get('risk')
  @RequireRoles(...BUSINESS_ROLES)
  risk(@Query('scope') scope: string | undefined, @Query('language') language: string | undefined, @Req() request: Request) {
    return this.ai.risk(actorFrom(request), scope === 'all' ? 'all' : 'mine', language === 'en' ? 'en' : 'nl');
  }

  @Post('meeting-notes')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  meetingNotes(@Body() dto: NotesDto, @Req() request: Request) {
    return this.ai.meetingNotes(actorFrom(request), dto);
  }

  @Post('ask')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  ask(@Body() dto: AskDto, @Req() request: Request) {
    return this.ai.ask(actorFrom(request), dto.question, dto.language);
  }

  @Post('chat')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  send(@Body() dto: ChatDto, @Req() request: Request) {
    return this.chat.send(actorFrom(request), dto);
  }

  @Get('chat/conversations')
  @RequireRoles(...BUSINESS_ROLES)
  conversations(@Req() request: Request) {
    return this.chat.conversations(request.authenticatedUser!.accountId);
  }

  @Get('chat/conversations/:id')
  @RequireRoles(...BUSINESS_ROLES)
  messages(@Param('id') id: string, @Req() request: Request) {
    return this.chat.messages(request.authenticatedUser!.accountId, id);
  }

  @Post('interactions/:id/feedback')
  @RequireRoles(...BUSINESS_ROLES)
  @HttpCode(200)
  feedback(@Param('id') id: string, @Body() dto: FeedbackDto, @Req() request: Request) {
    return this.ai.feedback(actorFrom(request), id, dto);
  }

  @Get('history')
  @RequireRoles(...BUSINESS_ROLES)
  history(@Req() request: Request, @Query('limit') limit?: string) {
    return this.ai.history(request.authenticatedUser!.accountId, Number(limit) || 30);
  }

  @Get('usage')
  @RequireRoles(...MANAGEMENT_ROLES, 'SYS_ADMIN', 'AUDITOR')
  usage(@Query('days') days?: string) {
    return this.ai.usage(Math.min(Math.max(Number(days) || 30, 1), 365));
  }
}

@Module({
  imports: [AuthModule, TasksModule, LettersModule, DashboardModule],
  controllers: [AiController],
  providers: [AiService, ChatService],
  exports: [AiService],
})
export class AiModule {}
