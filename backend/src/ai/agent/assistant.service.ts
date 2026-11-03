/**
 * The assistant panel ("Vraag de assistent"): one question in, one answer out.
 *
 * Lifecycle (guide, request lifecycle): origin and per-address limit (middleware)
 * → sign-in and role (guard) → validation → hourly quota per person → the
 * answer (language model with tools, or the built-in assistant) → audit entry
 * → JSON. The question and the answer are kept in the person's own chat
 * history only; the audit log records who asked, when, which tools ran and the
 * result — never the text.
 */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccessService } from '../../access/access.service';
import { AuditEventType } from '../../audit/audit-event.entity';
import { AuditService } from '../../audit/audit.service';
import { todayInSuriname } from '../../common/actor';
import { WorkingDaysService } from '../../core/working-days.service';
import { DashboardService } from '../../dashboard/dashboard.service';
import { Actor } from '../../records/registration.service';
import { SettingsService } from '../../settings/settings.service';
import { TasksService } from '../../tasks/tasks.service';
import { ProjectsService } from '../../projects/projects.service';
import { BUILD_VERSION } from '../../version';
import { AiService, BUILTIN_MODEL } from '../ai.service';
import { Card, ChatContext, ChatService } from '../chat.service';
import { detectLanguage, detectLanguageOr } from '../engine/text';
import { AgentConfig, agentConfig, createModel, needsKey } from './config';
import { AgentError, AgentReason, MESSAGE, RECOVERABLE } from './errors';
import { runLoop } from './loop';
import { systemPrompt } from './prompt';
import { redact } from './redact';
import { ToolContext, runTool, toolsFor } from './tools';
import { Entry, ChatModel } from './types';

export interface QueryInput {
  question: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  lang?: 'nl' | 'en';
  page?: string | null;
  conversationId?: string | null;
}

export interface QueryAnswer {
  answer: string;
  toolsUsed: string[];
  cards: Card[];
  suggestions: string[];
  conversationId: string;
  messageId: string;
  engine: { provider: string; model: string; offline: boolean; local: boolean };
  notice: string | null;
  /** A proposal waiting for the person's confirmation (built-in engine only). */
  pending: { kind: 'TASKS'; interactionId: string } | null;
  createdAt: string;
}

export const LIMITS = { question: 2000, historyTurns: 30, historyChars: 8000 };
const RESTRICTED_LEVELS = ['CONFIDENTIAL', 'SECRET'];

const EXAMPLES: Record<string, { nl: string[]; en: string[] }> = {
  MINISTER: {
    nl: ['Hoeveel zaken lopen er per directoraat?', 'Welke zaken wachten op mijn besluit?', 'Welke zaken lopen risico op termijnoverschrijding?', 'Welke projecten lopen achter?'],
    en: ['How many matters are open per directorate?', 'Which matters await my decision?', 'Which matters are at risk of missing their deadline?', 'Which projects are behind schedule?'],
  },
  DIRECTEUR: {
    nl: ['Hoeveel open zaken heeft elke afdeling in mijn directoraat?', 'Welke taken zijn te laat in mijn lijn?', 'Welke business cases wachten op mijn goedkeuring?', 'Wat staat er vandaag voor mij klaar?'],
    en: ['How many open matters does each department in my directorate have?', 'Which tasks are overdue in my line?', 'Which business cases await my approval?', 'What is waiting for me today?'],
  },
  ONDER_DIRECTEUR: {
    nl: ['Welke zaken in mijn onderdirectoraat verlopen deze week?', 'Hoeveel taken heeft elke medewerker open?', 'Hoe staan de projecten in mijn onderdirectoraat ervoor?', 'Wat staat er vandaag voor mij klaar?'],
    en: ['Which matters in my sub-directorate are due this week?', 'How many open tasks does each colleague have?', 'How are the projects in my sub-directorate doing?', 'What is waiting for me today?'],
  },
  SUPPORT_STAFF: {
    nl: ['Wat staat er vandaag voor mij klaar?', 'Welke van mijn taken zijn te laat?', 'Hoe registreer ik een brief?', 'Hoe staat mijn project ervoor?'],
    en: ['What is waiting for me today?', 'Which of my tasks are overdue?', 'How do I register a letter?', 'How is my project doing?'],
  },
  RECORDS_MANAGER: {
    nl: ['Welke bewaartermijnen zijn verlopen?', 'Hoeveel zaken staan onder juridische blokkade?', 'Hoeveel brieven zijn er dit jaar geregistreerd, per maand?', 'Hoe werkt vernietiging na de bewaartermijn?'],
    en: ['Which retention periods have ended?', 'How many matters are on legal hold?', 'How many letters were registered this year, per month?', 'How does destruction after the retention period work?'],
  },
  AUDITOR: {
    nl: ['Hoeveel mislukte aanmeldingen waren er de afgelopen 30 dagen?', 'Wanneer was de laatste integriteitscontrole?', 'Welke soorten gebeurtenissen zijn het meest gelogd?', 'Hoe controleer ik de hashketen?'],
    en: ['How many failed sign-ins were there in the last 30 days?', 'When was the last integrity check?', 'Which kinds of events were logged most?', 'How do I check the hash chain?'],
  },
  SYS_ADMIN: {
    nl: ['Hoeveel accounts zijn actief, per rol?', 'Draaien de achtergrondtaken goed?', 'Staan er e-mails of sms’jes in de wachtrij?', 'Hoe voeg ik een afdeling toe?'],
    en: ['How many accounts are active, per role?', 'Are the background jobs running well?', 'Are e-mails or text messages waiting in the queue?', 'How do I add a department?'],
  },
};

const ROLE_ORDER = ['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'RECORDS_MANAGER', 'AUDITOR', 'SYS_ADMIN', 'SUPPORT_STAFF'];

@Injectable()
export class AssistantService {
  /** For tests: a fake model replaces the real provider. Never set in production code. */
  static modelFactory: ((cfg: AgentConfig) => ChatModel) | null = null;

  constructor(
    private readonly db: DataSource,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly workingDays: WorkingDaysService,
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
    private readonly dashboard: DashboardService,
    private readonly ai: AiService,
    private readonly chat: ChatService,
  ) {}

  async config(): Promise<AgentConfig> {
    return agentConfig(await this.settings.get('ai'));
  }

  /** What the health check may say about the assistant: no key, no secrets. */
  async health() {
    const ai = await this.settings.get('ai');
    const cfg = agentConfig(ai);
    const state = !ai.features.assistant
      ? 'off'
      : cfg.provider === 'builtin'
        ? 'offline'
        : needsKey(cfg.provider) && !cfg.keyPresent
          ? 'no-key'
          : 'ready';
    return {
      env: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
      version: BUILD_VERSION,
      ai: { state, provider: cfg.provider, model: cfg.provider === 'builtin' ? BUILTIN_MODEL : cfg.model },
    };
  }

  /** What the panel shows in its header, for this person. */
  async status(actor: Actor, lang: 'nl' | 'en') {
    const ai = await this.settings.get('ai');
    const cfg = agentConfig(ai);
    const profile = await this.access.profile(actor.accountId);
    const role = ROLE_ORDER.find((r) => profile.roles.includes(r)) ?? 'SUPPORT_STAFF';
    const used = await this.usedThisHour(actor.accountId);
    const offline = cfg.provider === 'builtin' || (needsKey(cfg.provider) && !cfg.keyPresent);
    return {
      enabled: ai.features.assistant,
      provider: offline ? 'builtin' : cfg.provider,
      model: offline ? BUILTIN_MODEL : cfg.model,
      offline,
      external: !offline && !cfg.local,
      tier: cfg.tier,
      dataPolicy: cfg.dataPolicy,
      scope: cfg.scope,
      hourlyLimit: cfg.hourlyLimit,
      usedThisHour: used,
      limits: LIMITS,
      examples: EXAMPLES[role][lang],
    };
  }

  private async usedThisHour(accountId: string): Promise<number> {
    const [{ n }] = await this.db.query(
      `SELECT count(*)::int AS n FROM ai_interaction WHERE account_id = $1 AND feature = 'assistant-quota' AND created_at > now() - interval '1 hour'`,
      [accountId],
    );
    return n;
  }

  /** Validation (guide: question 1–2000, history ≤ 30 turns, user/assistant only). */
  static validate(body: unknown): QueryInput {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AgentError('invalid', 'body');
    const b = body as Record<string, unknown>;
    const allowed = ['question', 'history', 'lang', 'page', 'conversationId'];
    if (Object.keys(b).some((k) => !allowed.includes(k))) throw new AgentError('invalid', 'unknown field');
    if (typeof b.question !== 'string' || !b.question.trim()) throw new AgentError('invalid', 'question');
    if (b.question.length > LIMITS.question) throw new AgentError('too-long', 'question');
    const history = b.history ?? [];
    if (!Array.isArray(history) || history.length > LIMITS.historyTurns) throw new AgentError('invalid', 'history');
    for (const h of history) {
      if (!h || typeof h !== 'object' || !['user', 'assistant'].includes((h as { role?: unknown }).role as string) || typeof (h as { content?: unknown }).content !== 'string') {
        throw new AgentError('invalid', 'history turn');
      }
      if (Object.keys(h).some((k) => k !== 'role' && k !== 'content')) throw new AgentError('invalid', 'history turn');
      if ((h as { content: string }).content.length > LIMITS.historyChars) throw new AgentError('too-long', 'history turn');
    }
    if (b.lang !== undefined && b.lang !== null && !['nl', 'en'].includes(b.lang as string)) throw new AgentError('invalid', 'lang');
    if (b.page !== undefined && b.page !== null && (typeof b.page !== 'string' || b.page.length > 200 || !b.page.startsWith('/'))) throw new AgentError('invalid', 'page');
    if (b.conversationId !== undefined && b.conversationId !== null && typeof b.conversationId !== 'string') throw new AgentError('invalid', 'conversationId');
    return {
      question: b.question.trim(),
      history: history as QueryInput['history'],
      lang: (b.lang as 'nl' | 'en' | undefined) ?? undefined,
      page: (b.page as string | undefined) ?? null,
      conversationId: (b.conversationId as string | undefined) ?? null,
    };
  }

  async ask(actor: Actor, input: QueryInput, signal: AbortSignal): Promise<QueryAnswer> {
    const started = Date.now();
    const ai = await this.settings.get('ai');
    // The answer follows the language of the question; the screen language decides only for very short questions.
    const language: 'nl' | 'en' = detectLanguageOr(input.question, input.lang ?? 'nl');
    if (!ai.features.assistant) {
      await this.log(actor, 'failed', 'switched-off', null, [], null, started, null);
      throw new AgentError('switched-off');
    }
    const cfg = agentConfig(ai);
    // The question takes its place in the hourly quota before any work starts, so parallel requests cannot overrun it.
    const slot = await this.reserve(actor.accountId, cfg.hourlyLimit);
    if (!slot) {
      await this.log(actor, 'failed', 'rate-limit', null, [], null, started, null);
      throw new AgentError('rate-limit');
    }
    return this.answer(actor, ai, cfg, input, language, slot, started, signal);
  }

  /**
   * Counts this question against the hourly limit before any work starts, atomically per
   * person, so parallel requests cannot overrun it. The quota row (feature
   * "assistant-quota") holds only who and when; ai_interaction is append-only.
   */
  private async reserve(accountId: string, limit: number): Promise<string | null> {
    return this.db.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext('assistant:' || $1))`, [accountId]);
      const [{ n }] = await m.query(
        `SELECT count(*)::int AS n FROM ai_interaction WHERE account_id = $1 AND feature = 'assistant-quota' AND created_at > now() - interval '1 hour'`,
        [accountId],
      );
      if (n >= limit) return null;
      const [row] = await m.query(
        `INSERT INTO ai_interaction (feature, account_id, provider, model, prompt_summary, output, latency_ms, outcome)
         VALUES ('assistant-quota', $1, 'builtin', '—', 'Assistent', '{}', 0, 'counted') RETURNING id`,
        [accountId],
      );
      return row.id as string;
    });
  }

  private async answer(
    actor: Actor,
    ai: Awaited<ReturnType<SettingsService['get']>>,
    cfg: AgentConfig,
    input: QueryInput,
    language: 'nl' | 'en',
    slot: string,
    started: number,
    signal: AbortSignal,
  ): Promise<QueryAnswer> {
    void ai;
    const conversationId = await this.chat.conversationFor(actor.accountId, input.conversationId);
    const profile = await this.access.profile(actor.accountId);
    const context = await this.pageContext(profile, input.page ?? null);

    await this.db.query(`INSERT INTO chat_message (conversation_id, account_id, role, content, payload) VALUES ($1, $2, 'user', $3, $4)`, [
      conversationId,
      actor.accountId,
      input.question,
      JSON.stringify({ page: input.page ?? null, context: context?.ctx ?? null }),
    ]);

    const offlineReason: string | null =
      cfg.provider === 'builtin' ? 'no language model' : needsKey(cfg.provider) && !cfg.keyPresent ? 'no-key' : ChatService.proposesChanges(input.question) ? 'change proposal' : null;

    let result: { text: string; cards: Card[]; suggestions: string[]; toolsUsed: string[]; model: string; provider: string; offline: boolean; tokens: [number, number] | null; pending?: { kind: 'TASKS'; interactionId: string } | null };
    let outcome = 'success';
    let notice: string | null = null;

    if (offlineReason) {
      if (offlineReason === 'no-key' && !cfg.offlineFallback) {
        await this.log(actor, 'failed', 'no-key', cfg.model, [], null, started, slot);
        throw new AgentError('no-key');
      }
      result = await this.offline(actor, input.question, language, context?.ctx ?? null);
      outcome = offlineReason === 'no language model' || offlineReason === 'change proposal' ? 'offline' : `fallback:${offlineReason}`;
      if (offlineReason === 'no-key') notice = this.noticeFor('no-key', language);
    } else {
      try {
        result = await this.online(actor, profile, cfg, input, language, context?.label ?? null, signal);
      } catch (error) {
        const e = error instanceof AgentError ? error : new AgentError('unavailable', String((error as Error)?.message ?? error).slice(0, 120));
        if (e.reason === 'cancelled' || signal.aborted) {
          await this.log(actor, 'failed', 'cancelled', cfg.model, [], null, started, slot);
          throw new AgentError('cancelled');
        }
        if (!cfg.offlineFallback || !RECOVERABLE.includes(e.reason)) {
          await this.log(actor, 'failed', e.reason, cfg.model, [], null, started, slot);
          throw e;
        }
        result = await this.offline(actor, input.question, language, context?.ctx ?? null);
        outcome = `fallback:${e.reason}`;
        notice = this.noticeFor(e.reason, language);
      }
    }

    const engine = { provider: result.provider, model: result.model, offline: result.offline, local: result.offline || cfg.local };
    const interactionId = await this.log(actor, outcome === 'success' ? 'answered' : outcome.startsWith('fallback') ? 'fallback' : 'offline', outcome.replace(/^fallback:/, ''), result.model, result.toolsUsed, result.tokens, started, slot, engine.provider);
    const pending = result.pending ? { kind: result.pending.kind, interactionId: result.pending.interactionId || interactionId } : null;
    const [saved] = await this.db.query(
      `INSERT INTO chat_message (conversation_id, account_id, role, content, payload, interaction_id)
       VALUES ($1, $2, 'assistant', $3, $4, $5) RETURNING id, created_at`,
      [
        conversationId,
        actor.accountId,
        result.text,
        JSON.stringify({ cards: result.cards, suggestions: result.suggestions, intent: 'assistant', toolsUsed: result.toolsUsed, engine, notice, pending }),
        interactionId,
      ],
    );
    return {
      answer: result.text,
      toolsUsed: result.toolsUsed,
      cards: result.cards,
      suggestions: result.suggestions,
      conversationId,
      messageId: saved.id,
      engine,
      notice,
      pending,
      createdAt: saved.created_at,
    };
  }

  /**
   * No notice in the answer when the built-in assistant takes over: the person
   * simply gets an answer (the badge under it says which engine gave it). Why the
   * model did not answer is in the usage log and the audit log for the administrator.
   */
  private noticeFor(reason: AgentReason, lang: 'nl' | 'en'): null {
    void reason;
    void lang;
    return null;
  }

  private async offline(actor: Actor, question: string, language: 'nl' | 'en', ctx: ChatContext | null) {
    const reply = await this.chat.offlineReply(actor, question, language, ctx);
    return {
      text: reply.content,
      cards: reply.cards,
      suggestions: reply.suggestions,
      toolsUsed: [] as string[],
      model: BUILTIN_MODEL,
      provider: 'builtin',
      offline: true,
      tokens: null,
      pending: reply.pending ? { kind: reply.pending.kind, interactionId: reply.pending.interactionId } : null,
    };
  }

  private async online(
    actor: Actor,
    profile: Awaited<ReturnType<AccessService['profile']>>,
    cfg: AgentConfig,
    input: QueryInput,
    language: 'nl' | 'en',
    pageLabel: string | null,
    signal: AbortSignal,
  ) {
    const line = await this.access.lineScope(profile);
    const today = todayInSuriname();
    const time = new Date().toLocaleTimeString('nl-NL', { timeZone: 'America/Paramaribo', hour: '2-digit', minute: '2-digit' });
    const [me] = await this.db.query(
      `SELECT p.full_name, u.name AS unit FROM account a JOIN person p ON p.id = a.person_id LEFT JOIN organisational_unit u ON u.id = a.organisational_unit_id WHERE a.id = $1`,
      [actor.accountId],
    );
    const standIns: { name: string; until: string }[] = await this.db.query(
      `SELECT p.full_name AS name, to_char(o.ends_on, 'DD-MM-YYYY') AS until FROM out_of_office o
         JOIN account a ON a.id = o.account_id JOIN person p ON p.id = a.person_id
        WHERE o.stand_in_account_id = $1 AND o.ended_at IS NULL AND o.starts_on <= $2::date AND o.ends_on >= $2::date`,
      [actor.accountId, today],
    );
    const lineLabel = `${await this.lineLabel(line)}${standIns.length ? `; standing in for ${standIns.map((x) => `${x.name} until ${x.until}`).join(', ')}, so their line is included` : ''}`;
    const specs = toolsFor(profile.roles, cfg.scope);
    const cards: Card[] = [];
    const ctx: ToolContext = {
      db: this.db,
      access: this.access,
      tasks: this.tasks,
      projects: this.projects,
      dashboard: this.dashboard,
      ai: this.ai,
      workingDays: this.workingDays,
      actor,
      profile,
      line,
      language,
      today,
      dataPolicy: cfg.dataPolicy,
      cards,
      engine: { provider: cfg.provider, model: cfg.model },
    };
    const system = systemPrompt({
      language,
      name: me?.full_name ?? '—',
      roles: profile.roles,
      unit: me?.unit ?? null,
      line: lineLabel,
      tools: specs.map((s) => s.name),
      page: pageLabel,
      today: today.split('-').reverse().join('-'),
      time,
      scope: cfg.scope,
      dataPolicy: cfg.dataPolicy,
    });
    const entries = conversation(input.history, input.question, language);
    const model = AssistantService.modelFactory ? AssistantService.modelFactory(cfg) : createModel(cfg);
    const r = await runLoop({
      model,
      models: [cfg.model, ...cfg.fallbackModels],
      system,
      entries,
      tools: specs.map(({ name, description, parameters }) => ({ name, description, parameters })),
      maxRounds: cfg.maxRounds,
      maxOutputTokens: cfg.maxOutputTokens,
      callTimeoutMs: cfg.callTimeoutMs,
      totalTimeoutMs: cfg.totalTimeoutMs,
      signal,
      runTool: (c) => runTool(ctx, c.name, c.args),
    });
    return {
      text: r.text,
      cards: cards.slice(0, 6),
      suggestions: [] as string[],
      toolsUsed: r.toolsUsed,
      model: r.model,
      provider: cfg.provider,
      offline: false,
      tokens: [r.inputTokens, r.outputTokens] as [number, number],
    };
  }

  private async lineLabel(line: { all: boolean; rootUnitIds: string[]; unitIds: string[] }): Promise<string> {
    if (line.all) return 'the whole ministry';
    if (!line.unitIds.length) return 'only records you are personally involved in';
    const roots: { name: string }[] = await this.db.query(`SELECT name FROM organisational_unit WHERE id = ANY($1::uuid[]) ORDER BY name`, [line.rootUnitIds]);
    const below = line.unitIds.length - line.rootUnitIds.length;
    return `${roots.map((r) => r.name).join(', ')}${below > 0 ? ` and the ${below} unit(s) under it` : ''}, plus records you are personally involved in`;
  }

  /** The page the person has open, as a reference the assistant may mention — only if they may see it. */
  private async pageContext(profile: Awaited<ReturnType<AccessService['profile']>>, page: string | null): Promise<{ ctx: ChatContext | null; label: string } | null> {
    if (!page) return null;
    const m = /^\/(post|zaken|taken)\/([0-9a-f-]{36})/i.exec(page);
    // Other pages by their path only; an id in the path is not passed on.
    if (!m) return { ctx: null, label: page.split('?')[0].replace(/\/[0-9a-f-]{36}.*$/i, ' (one item)') };
    const [, kind, id] = m;
    // A confidential record on screen is named to the model only as "a restricted letter/matter".
    if (kind === 'post' && (await this.access.canViewItem(profile, id))) {
      const [r] = await this.db.query(`SELECT registration_identity, classification FROM correspondence_item WHERE id = $1`, [id]);
      if (RESTRICTED_LEVELS.includes(r?.classification)) return { ctx: { type: 'ITEM', id }, label: 'a restricted letter (details only in the panel)' };
      return { ctx: { type: 'ITEM', id }, label: `letter ${r?.registration_identity ?? '(draft, not yet registered)'}` };
    }
    if (kind === 'zaken' && (await this.access.canViewDossier(profile, id))) {
      const [r] = await this.db.query(`SELECT dossier_identity, classification FROM dossier WHERE id = $1`, [id]);
      if (RESTRICTED_LEVELS.includes(r?.classification)) return { ctx: { type: 'DOSSIER', id }, label: 'a restricted matter (details only in the panel)' };
      return { ctx: { type: 'DOSSIER', id }, label: `matter ${r?.dossier_identity ?? ''}` };
    }
    return { ctx: null, label: `/${kind}` };
  }

  /**
   * One row in ai_interaction (usage and the hourly quota) and one audit
   * event. Neither holds the question or the answer.
   */
  private async log(
    actor: Actor,
    kind: 'answered' | 'fallback' | 'offline' | 'failed',
    reason: string,
    model: string | null,
    toolsUsed: string[],
    tokens: [number, number] | null,
    started: number,
    /** The question's place in the hourly quota; null for a request refused before it counted. */
    slot: string | null,
    provider = 'builtin',
  ): Promise<string> {
    const outcome = kind === 'answered' ? 'success' : kind === 'offline' ? 'offline' : kind === 'fallback' ? `fallback:${reason}` : reason;
    const [row] = await this.db.query(
      `INSERT INTO ai_interaction (feature, account_id, provider, model, prompt_summary, output, latency_ms, outcome, tools_used, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        slot ? 'assistant' : 'assistant-refused',
        actor.accountId,
        provider,
        (model ?? '—').slice(0, 120),
        `Assistent: ${toolsUsed.length ? toolsUsed.join(', ') : kind === 'failed' ? reason : 'geen hulpmiddelen'}`,
        JSON.stringify({ outcome, toolsUsed }),
        Date.now() - started,
        outcome.slice(0, 30),
        toolsUsed,
        tokens?.[0] ?? null,
        tokens?.[1] ?? null,
      ],
    );
    const who = actor.description;
    const summary =
      kind === 'answered'
        ? `${who} asked the assistant a question; answered by ${model} using ${toolsUsed.length ? toolsUsed.join(', ') : 'no tools'}.`
        : kind === 'failed'
          ? `${who} asked the assistant a question; not answered (${reason}).`
          : `${who} asked the assistant a question; answered offline by the built-in assistant (${reason}).`;
    await this.audit.record({
      eventType: kind === 'failed' ? AuditEventType.AI_QUESTION_FAILED : AuditEventType.AI_QUESTION_ANSWERED,
      actorAccountId: actor.accountId,
      actorDescription: who,
      subjectDescription: 'Assistent',
      newValue: JSON.stringify({ outcome, toolsUsed, model, inputTokens: tokens?.[0] ?? null, outputTokens: tokens?.[1] ?? null, ms: Date.now() - started }),
      summary,
    });
    return row.id;
  }
}

/**
 * History and question as the model's conversation: personal details removed,
 * starting with the person, consecutive turns of the same side joined.
 */
export function conversation(history: QueryInput['history'], question: string, language: 'nl' | 'en'): Entry[] {
  const turns = [...history.slice(-LIMITS.historyTurns), { role: 'user' as const, content: question }];
  const out: Entry[] = [];
  for (const t of turns) {
    const text = redact(t.content.slice(0, LIMITS.historyChars), language).text;
    const last = out[out.length - 1];
    if (t.role === 'user') {
      if (last?.kind === 'user') last.text += `\n\n${text}`;
      else out.push({ kind: 'user', text });
    } else {
      if (!out.length) continue;
      if (last?.kind === 'model') last.text += `\n\n${text}`;
      else out.push({ kind: 'model', text, calls: [] });
    }
  }
  return out;
}
