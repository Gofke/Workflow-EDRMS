/**
 * The assistant's API, in the guide's contract:
 *
 *   POST /api/v1/ai/query   {question, history, lang, page, conversationId}
 *     200 {success: true,  message, data: {answer, toolsUsed, cards, …}}
 *     4xx/5xx {success: false, message, reason}
 *   GET  /api/v1/ai/status  what the panel shows for this person
 *   GET  /api/v1/health     {success, data: {env, ai, version}} — no secrets
 *
 * Origin check, per-address limit and the body size limit run before the
 * session (assistantGate, registered in app-factory); sign-in and role are the
 * guards here; everything after that is AssistantService.
 */
import {
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import express, { Request, Response } from 'express';
import { RequireRoles } from '../../auth/require-roles.decorator';
import { BUSINESS_ROLES, actorFrom } from '../../common/actor';
import { AgentError, AgentReason, MESSAGE, STATUS } from './errors';
import { AssistantService } from './assistant.service';

const EVERY_ROLE = [...BUSINESS_ROLES, 'AUDITOR', 'SYS_ADMIN'];

function langOf(req: Request): 'nl' | 'en' {
  const b = req.body as { lang?: unknown } | undefined;
  if (b && (b.lang === 'en' || b.lang === 'nl')) return b.lang;
  if (req.query?.lang === 'en') return 'en';
  return /^en\b/i.test(req.headers['accept-language'] ?? '') ? 'en' : 'nl';
}

export function fail(res: Response, reason: AgentReason, lang: 'nl' | 'en', message?: string): void {
  res.status(STATUS[reason]).json({ success: false, message: message ?? MESSAGE[reason][lang], reason });
}

@Catch()
export class AssistantErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Assistant');

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const lang = langOf(req);
    if (res.headersSent) return;
    if (error instanceof AgentError) return fail(res, error.reason, lang);
    if (error instanceof HttpException) {
      const status = error.getStatus();
      // A session whose account was switched off since: the person is known, but no longer allowed.
      if (status === 401 && /no longer valid/i.test(error.message)) return fail(res, 'denied', lang);
      if (status === 401) return fail(res, 'signed-out', lang);
      if (status === 403) return fail(res, 'denied', lang);
      if (status === 404) return fail(res, 'invalid', lang, lang === 'en' ? 'This conversation does not exist. Start a new chat.' : 'Dit gesprek bestaat niet. Begin een nieuw gesprek.');
      if (status === 400) return fail(res, 'invalid', lang);
      if (status === 413) return fail(res, 'too-large', lang);
      if (status === 429) return fail(res, 'rate-limit', lang);
    }
    this.logger.error(`Unexpected assistant error: ${(error as Error)?.message ?? error}`);
    res.status(500).json({ success: false, message: lang === 'en' ? 'Something went wrong. Try again.' : 'Er ging iets mis. Probeer het opnieuw.', reason: 'error' });
  }
}

@Controller('api/v1')
@UseFilters(AssistantErrorFilter)
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('health')
  async health() {
    return { success: true, message: 'ok', data: await this.assistant.health() };
  }

  @Get('ai/status')
  @RequireRoles(...EVERY_ROLE)
  async status(@Req() req: Request, @Query('lang') lang?: string) {
    return { success: true, message: 'ok', data: await this.assistant.status(actorFrom(req), lang === 'en' ? 'en' : 'nl') };
  }

  /** For Beheer → Assistent: what the server really uses, and what is fixed there. Never the key. */
  @Get('ai/config')
  @RequireRoles('SYS_ADMIN')
  async config() {
    const c = await this.assistant.config();
    return {
      success: true,
      message: 'ok',
      data: {
        provider: c.provider,
        model: c.model,
        fallbackModels: c.fallbackModels,
        baseUrl: c.provider === 'builtin' ? null : c.baseUrl,
        tier: c.tier,
        keyPresent: c.keyPresent,
        dataPolicy: c.dataPolicy,
        hourlyLimit: c.hourlyLimit,
        pinned: c.pinned,
        limits: { maxRounds: c.maxRounds, callTimeoutMs: c.callTimeoutMs, totalTimeoutMs: c.totalTimeoutMs, maxOutputTokens: c.maxOutputTokens },
      },
    };
  }

  @Post('ai/query')
  @RequireRoles(...EVERY_ROLE)
  @HttpCode(200)
  async query(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const input = AssistantService.validate(req.body);
    // Stop in the panel closes the request; the model calls stop with it.
    const stop = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) stop.abort();
    };
    res.on('close', onClose);
    try {
      const data = await this.assistant.ask(actorFrom(req), input, stop.signal);
      return { success: true, message: 'ok', data };
    } finally {
      res.off('close', onClose);
    }
  }
}

// ---------------------------------------------------------------- the gate

const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

/** For tests. */
export function resetAssistantGate(): void {
  hits.clear();
}

function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Runs before the session for /api/v1/ai: the request must come from the
 * EDRMS itself, one address may not flood the model, and the body has a size
 * limit. Express middleware, so it answers in the same JSON shape.
 */
export function assistantGate() {
  const parse = express.json({ limit: process.env.AI_MAX_BODY ?? '256kb' });
  return function assistantGateLayer(req: Request, res: Response, next: express.NextFunction): void {
    const lang: 'nl' | 'en' = /^en\b/i.test(req.headers['accept-language'] ?? '') ? 'en' : 'nl';
    const origin = req.headers.origin;
    if (origin) {
      const clean = origin.replace(/\/+$/, '');
      let sameHost = false;
      try {
        sameHost = new URL(clean).host === req.headers.host;
      } catch {
        sameHost = false;
      }
      if (!sameHost && !allowedOrigins().includes(clean)) return fail(res, 'origin', lang);
    }
    const perMinute = Number(process.env.AI_IP_LIMIT_PER_MINUTE ?? 60);
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (list.length >= perMinute) {
      hits.set(key, list);
      res.setHeader('Retry-After', String(Math.ceil((WINDOW_MS - (now - list[0])) / 1000)));
      return fail(res, 'rate-limit', lang);
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
    parse(req, res, (err?: unknown) => {
      if (err) {
        const e = err as { status?: number; type?: string };
        return fail(res, e.status === 413 || e.type === 'entity.too.large' ? 'too-large' : 'invalid', lang);
      }
      next();
    });
  };
}
