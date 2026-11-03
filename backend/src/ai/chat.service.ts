import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AccessService, isUuid } from '../access/access.service';
import { MANAGEMENT_ROLES, readableDate, todayInSuriname } from '../common/actor';
import { DashboardService } from '../dashboard/dashboard.service';
import { ProjectsService } from '../projects/projects.service';
import { Actor } from '../records/registration.service';
import { AiService, BUILTIN_MODEL, Engine } from './ai.service';
import { looksLikeDataQuestion } from './engine/ask';
import { longDutchDate, looseDate } from './engine/dates';
import { HELP, searchHelp } from './engine/help';
import { detectLanguage, distance, excerpt, normalise } from './engine/text';

export interface ChatContext {
  type: 'ITEM' | 'DOSSIER';
  id: string;
}

export interface Card {
  kind: 'LIST' | 'SUMMARY' | 'TASK_PROPOSAL' | 'DRAFT' | 'HELP' | 'RISK' | 'NOTES' | 'TRANSLATION';
  title: string;
  [key: string]: unknown;
}

export interface Reply {
  content: string;
  cards: Card[];
  suggestions: string[];
  /** A proposal waiting for the person's confirmation. */
  pending?: { kind: 'TASKS'; interactionId: string };
  intent: string;
}

const IDENTITY = /\b([A-Z]{2,6}-\d{4}-\d{2,8})\b/i;

const SUGGEST_NL = ['Wat staat er vandaag voor mij klaar?', 'Welke zaken lopen risico op termijnoverschrijding?', 'Welke projecten lopen achter?', 'Hoeveel brieven kwamen deze week binnen?', 'Hoe registreer ik een brief?'];
const SUGGEST_EN = ['What is waiting for me today?', 'Which matters are at risk of missing their deadline?', 'Which projects are behind schedule?', 'How many letters came in this week?', 'How do I register a letter?'];

/**
 * The chatbot on every page. It answers from what the system holds and from
 * its help articles, through the same features and permission checks as the
 * screens: it can only tell a person what that person may already see, and it
 * never changes anything itself — a proposed task waits for confirmation.
 *
 * The conversation is private to the person who had it and is kept, like
 * every assistant answer, so what was said can be shown afterwards.
 */

/** What the chat was asked to do, in the words the history shows. */
const INTENT_NL: Record<string, string> = {
  ask: 'Chat, vraag over het werk',
  capabilities: 'Chat, wat de assistent kan',
  'draft-reply': 'Chat, conceptantwoord',
  fallback: 'Chat',
  greeting: 'Chat, begroeting',
  help: 'Chat, uitleg',
  'meeting-notes': 'Chat, notulen naar taken',
  'my-work': 'Chat, mijn werk',
  'need-context': 'Chat',
  'not-found': 'Chat, niet gevonden',
  refused: 'Chat, geweigerd',
  risk: 'Chat, termijnrisico',
  summary: 'Chat, samenvatting',
  'switched-off': 'Chat, functie uit',
  'task-proposal': 'Chat, taakvoorstel',
  thanks: 'Chat',
  translate: 'Chat, vertalen',
};

@Injectable()
export class ChatService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ai: AiService,
    private readonly access: AccessService,
    private readonly dashboard: DashboardService,
    private readonly projects: ProjectsService,
  ) {}

  async send(actor: Actor, input: { conversationId?: string; message: string; language?: 'nl' | 'en'; context?: ChatContext | null }) {
    const started = Date.now();
    const cfg = await this.ai.require('chat');
    const message = (input.message ?? '').trim().slice(0, 4000);
    if (!message) throw new BadRequestException('Type a message.');
    let conversationId = input.conversationId;
    if (conversationId) {
      if (!isUuid(conversationId)) throw new NotFoundException('Unknown conversation.');
      const [other] = await this.dataSource.query(`SELECT 1 FROM chat_message WHERE conversation_id = $1 AND account_id <> $2 LIMIT 1`, [conversationId, actor.accountId]);
      if (other) throw new NotFoundException('Unknown conversation.');
    } else conversationId = randomUUID();
    const language = input.language ?? (message.split(/\s+/).length >= 3 ? detectLanguage(message) : 'nl');
    let context = input.context ?? null;
    if (context && (!isUuid(context.id) || !['ITEM', 'DOSSIER'].includes(context.type))) context = null;
    if (context) {
      // A context the person may not see is simply ignored, never confirmed.
      const profile = await this.access.profile(actor.accountId);
      const ok = context.type === 'ITEM' ? await this.access.canViewItem(profile, context.id) : await this.access.canViewDossier(profile, context.id);
      if (!ok) context = null;
    }

    await this.dataSource.query(`INSERT INTO chat_message (conversation_id, account_id, role, content, payload) VALUES ($1, $2, 'user', $3, $4)`, [
      conversationId,
      actor.accountId,
      message,
      context ? JSON.stringify({ context }) : null,
    ]);

    let reply: Reply;
    let engine: Engine = { provider: 'builtin', model: BUILTIN_MODEL, local: true };
    try {
      reply = await this.answer(actor, message, language, context);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 403) {
        reply = {
          intent: 'switched-off',
          content: language === 'en' ? 'That assistant function is switched off by the administrator.' : 'Die functie van de assistent is door de beheerder uitgezet.',
          cards: [],
          suggestions: language === 'en' ? SUGGEST_EN : SUGGEST_NL,
        };
      } else if (status === 404) {
        reply = { intent: 'not-found', content: language === 'en' ? 'I could not find that, or you do not have access to it.' : 'Dat kon ik niet vinden, of u hebt er geen toegang toe.', cards: [], suggestions: [] };
      } else if (status === 400) {
        reply = { intent: 'refused', content: (error as Error).message, cards: [], suggestions: [] };
      } else throw error;
    }

    // With a language model configured, the open answers are worded by it,
    // grounded in the help articles and the person's own work.
    if (cfg.provider !== 'builtin' && ['help', 'fallback', 'greeting'].includes(reply.intent)) {
      const history: { role: 'user' | 'assistant'; content: string }[] = (
        await this.dataSource.query(
          `SELECT role, content FROM chat_message WHERE conversation_id = $1 AND account_id = $2 ORDER BY created_at DESC LIMIT 7`,
          [conversationId, actor.accountId],
        )
      ).reverse();
      const help = searchHelp(message, 3).map((h) => `# ${h.article[language].title} (${h.article.link})\n${h.article[language].body}`).join('\n\n');
      const work = await this.workFacts(actor.accountId, language);
      const result = await this.ai.model(cfg, ['INTERNAL'], [
        { role: 'system', content: this.ai.systemPrompt(language, `Help-artikelen:\n${help || '(geen)'}\n\nWerk van deze gebruiker:\n${work}`) },
        ...history.map((h) => ({ role: h.role, content: h.content })),
      ]);
      engine = result.engine;
      if (result.text) reply = { ...reply, content: result.text };
    }

    const interactionId = await this.ai.record(
      actor,
      'chat',
      context,
      engine,
      `${INTENT_NL[reply.intent] ?? 'Chat'}: ${excerpt(message, 200)}`,
      { intent: reply.intent, content: reply.content, cards: reply.cards },
      started,
    );
    if (reply.pending && !reply.pending.interactionId) reply.pending.interactionId = interactionId;
    const [saved] = await this.dataSource.query(
      `INSERT INTO chat_message (conversation_id, account_id, role, content, payload, interaction_id)
       VALUES ($1, $2, 'assistant', $3, $4, $5) RETURNING id, created_at`,
      [conversationId, actor.accountId, reply.content, JSON.stringify({ cards: reply.cards, suggestions: reply.suggestions, pending: reply.pending ?? null, intent: reply.intent }), interactionId],
    );
    return {
      conversationId,
      engine,
      message: { id: saved.id, role: 'assistant', content: reply.content, cards: reply.cards, suggestions: reply.suggestions, pending: reply.pending ?? null, intent: reply.intent, interactionId, createdAt: saved.created_at },
    };
  }

  /**
   * The built-in, offline answer to one message — used by the assistant when
   * no language model is configured or the model cannot answer. Same intents,
   * same permission checks, nothing leaves the server.
   */
  async offlineReply(actor: Actor, message: string, language: 'nl' | 'en', context: ChatContext | null): Promise<Reply> {
    try {
      return await this.answer(actor, message, language, context);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const en = language === 'en';
      if (status === 403) return { intent: 'switched-off', content: en ? 'That assistant function is switched off by the administrator.' : 'Die functie van de assistent is door de beheerder uitgezet.', cards: [], suggestions: en ? SUGGEST_EN : SUGGEST_NL };
      if (status === 404) return { intent: 'not-found', content: en ? 'I could not find that, or you do not have access to it.' : 'Dat kon ik niet vinden, of u hebt er geen toegang toe.', cards: [], suggestions: [] };
      if (status === 400) return { intent: 'refused', content: (error as Error).message, cards: [], suggestions: [] };
      throw error;
    }
  }

  /**
   * Requests that propose changes (a task, tasks from meeting notes) stay with
   * the built-in engine even when a language model is configured: the person's
   * text never leaves the server and nothing happens without their confirmation.
   */
  static proposesChanges(message: string): boolean {
    const t = normalise(message);
    if (/^(maak|creeer|plan|zet|voeg)\b.*\b(taak|actie|herinnering)\b|^herinner (me|mij)\b|^(create|add|make|set up)\b.*\b(task|reminder|action)\b|^remind me\b/.test(t)) return true;
    return message.split('\n').length >= 3 && /(notulen|actiepunten|verslag|meeting notes|minutes|action items)/.test(t);
  }

  /** Checks a conversation id belongs to the person; a new one otherwise. */
  async conversationFor(accountId: string, conversationId?: string | null): Promise<string> {
    if (!conversationId) return randomUUID();
    if (!isUuid(conversationId)) throw new NotFoundException('Unknown conversation.');
    const [other] = await this.dataSource.query(`SELECT 1 FROM chat_message WHERE conversation_id = $1 AND account_id <> $2 LIMIT 1`, [conversationId, accountId]);
    if (other) throw new NotFoundException('Unknown conversation.');
    return conversationId;
  }

  async conversations(accountId: string) {
    return this.dataSource.query(
      `SELECT conversation_id AS id, min(created_at) AS "startedAt", max(created_at) AS "lastAt", count(*)::int AS messages,
              (array_agg(content ORDER BY created_at) FILTER (WHERE role = 'user'))[1] AS "firstQuestion"
         FROM chat_message WHERE account_id = $1 GROUP BY conversation_id ORDER BY max(created_at) DESC LIMIT 30`,
      [accountId],
    );
  }

  async messages(accountId: string, conversationId: string) {
    if (!isUuid(conversationId)) throw new NotFoundException('Unknown conversation.');
    const rows: { id: string; role: string; content: string; payload: Record<string, unknown> | null; interaction_id: string | null; created_at: Date }[] = await this.dataSource.query(
      `SELECT id, role, content, payload, interaction_id, created_at FROM chat_message WHERE conversation_id = $1 AND account_id = $2 ORDER BY created_at`,
      [conversationId, accountId],
    );
    if (!rows.length) throw new NotFoundException('Unknown conversation.');
    return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, ...(r.payload ?? {}), interactionId: r.interaction_id, createdAt: r.created_at }));
  }

  // ------------------------------------------------------------ intents

  private async answer(actor: Actor, message: string, language: 'nl' | 'en', context: ChatContext | null): Promise<Reply> {
    const en = language === 'en';
    const t = normalise(message);
    const words = t.split(/\s+/).filter(Boolean);
    const suggestions = en ? SUGGEST_EN : SUGGEST_NL;

    if (words.length <= 4 && /^(hallo|hoi|hey|hi|hello|goede(morgen|middag|navond)|good (morning|afternoon|evening)|dag|fawaka|morgen)\b/.test(t)) {
      const name = (await this.dataSource.query(`SELECT p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = $1`, [actor.accountId]))[0]?.full_name;
      return {
        intent: 'greeting',
        content: en
          ? `Good day${name ? `, ${name}` : ''}. I am the assistant of this system. I can tell you what is waiting for you, find letters and matters, summarise a matter, draft a reply, spot deadline risks, turn meeting notes into tasks and explain how the system works. What can I do for you?`
          : `Goedendag${name ? `, ${name}` : ''}. Ik ben de assistent van dit systeem. Ik kan vertellen wat er voor u klaarstaat, brieven en zaken zoeken, een zaak samenvatten, een conceptantwoord maken, termijnrisico’s signaleren, notulen omzetten in taken en uitleggen hoe het systeem werkt. Waarmee kan ik u helpen?`,
        cards: [],
        suggestions,
      };
    }
    if (words.length <= 4 && /^(dank|bedankt|thanks|thank you|top|prima|ok(e|ay)?|grantangi)\b/.test(t)) {
      return { intent: 'thanks', content: en ? 'You are welcome.' : 'Graag gedaan.', cards: [], suggestions: [] };
    }
    if (/\b(wat kun je|wat kan je|wat kunt u|wie ben je|wie bent u|what can you do|who are you|wat doe je)\b/.test(t) || t === 'help') {
      const a = HELP.find((h) => h.id === 'assistant')!;
      return { intent: 'capabilities', content: a[language].body, cards: [], suggestions };
    }

    if (/^(maak|creeer|plan|zet|voeg)\b.*\b(taak|actie|herinnering)\b|^herinner (me|mij)\b|^(create|add|make|set up)\b.*\b(task|reminder|action)\b|^remind me\b/.test(t)) {
      return this.taskProposal(actor, message, language, context);
    }

    const referenced = await this.resolveReference(actor.accountId, message);
    const target = referenced ?? context;

    if (/(concept ?antwoord|antwoordbrief|beantwoord|schrijf .*(antwoord|brief|reactie)|maak .*antwoord|draft (a )?(reply|response|answer)|write (a )?(reply|response)|reply to)/.test(t)) {
      if (!target || target.type !== 'ITEM') {
        return { intent: 'need-context', content: en ? 'Open the incoming letter you want to answer, or mention its registration number, and ask again.' : 'Open de binnengekomen brief die u wilt beantwoorden, of noem het registratienummer, en vraag het opnieuw.', cards: [], suggestions: [] };
      }
      const draft = await this.ai.draftReply(actor, target.id, { language });
      return {
        intent: 'draft-reply',
        content: en
          ? `Here is a draft reply. The parts in [square brackets] are for you to fill in: the assistant never decides for the ministry. Open the letter and choose Reply to save it as a draft version.`
          : `Hier is een conceptantwoord. De delen tussen [vierkante haken] vult u zelf in: de assistent neemt geen besluiten namens het ministerie. Open de brief en kies Beantwoorden om het als conceptversie op te slaan.`,
        cards: [{ kind: 'DRAFT', title: en ? 'Draft reply' : 'Conceptantwoord', body: draft.body, itemId: target.id, sourceInteractionId: draft.interactionId, link: `/post/${target.id}` }],
        suggestions: [],
      };
    }

    const project = await this.projectReply(actor, message, language);
    if (project) return project;
    const unit = await this.unitReply(actor, message, language);
    if (unit) return unit;

    if (/(vat .*samen|samenvatting|samenvatten|waar gaat .*over|wat is de stand|hoe staat .* ervoor|summar|what is (this|it) about|status of this|where does .* stand)/.test(t)) {
      if (!target) {
        return { intent: 'need-context', content: en ? 'Open the matter or letter you want summarised, or mention its number (for example DOS-2026-0001).' : 'Open de zaak of brief die u samengevat wilt hebben, of noem het nummer (bijvoorbeeld DOS-2026-0001).', cards: [], suggestions: [] };
      }
      const s = target.type === 'DOSSIER' ? await this.ai.summariseDossier(actor, target.id, language) : await this.ai.summariseItem(actor, target.id, language);
      return {
        intent: 'summary',
        content: `${s.headline}\n${s.bullets.map((b: string) => `• ${b}`).join('\n')}`,
        cards: [{ kind: 'SUMMARY', title: s.headline, bullets: s.bullets, keySentences: s.keySentences, link: target.type === 'DOSSIER' ? `/zaken/${target.id}` : `/post/${target.id}`, sourceInteractionId: s.interactionId }],
        suggestions: [],
      };
    }

    if (/^(vertaal|translate)\b/.test(t)) {
      const text = message.replace(/^\s*(vertaal|translate)\s*(naar|to|into)?\s*(het )?(engels|english|nederlands|dutch)?\s*:?\s*/i, '').trim();
      const to: 'nl' | 'en' = /(engels|english)/i.test(message.slice(0, 40)) ? 'en' : /(nederlands|dutch)/i.test(message.slice(0, 40)) ? 'nl' : detectLanguage(text) === 'nl' ? 'en' : 'nl';
      const result = await this.ai.translate(actor, { text, to, itemId: !text && target?.type === 'ITEM' ? target.id : undefined });
      return { intent: 'translate', content: result.translation, cards: [{ kind: 'TRANSLATION', title: to === 'en' ? 'English' : 'Nederlands', body: result.translation }], suggestions: [] };
    }

    if (message.split('\n').length >= 3 && /(notulen|actiepunten|verslag|meeting notes|minutes|action items)/.test(t)) {
      const notes = await this.ai.meetingNotes(actor, { text: message, dossierId: target?.type === 'DOSSIER' ? target.id : null });
      return {
        intent: 'meeting-notes',
        content: en ? `I found ${notes.proposals.length} possible action items. Tick the ones to create as tasks.` : `Ik heb ${notes.proposals.length} mogelijke actiepunten gevonden. Vink aan welke als taak moeten worden aangemaakt.`,
        cards: [{ kind: 'NOTES', title: en ? 'Proposed tasks' : 'Voorgestelde taken', proposals: notes.proposals, sourceInteractionId: notes.interactionId, dossierId: notes.dossierId }],
        suggestions: [],
        pending: { kind: 'TASKS', interactionId: notes.interactionId },
      };
    }

    if (/(mijn werk|wat moet ik|wat staat er .*(klaar|open|voor mij)|wat ligt er|mijn dag|vandaag voor mij|wat heb ik openstaan|my work|what do i have|what('s| is) (on|waiting)|my day|to ?do list|what should i do)/.test(t)) {
      return this.myWork(actor, language);
    }

    if (/(risico|in gevaar|dreigt .*termijn|termijn .*(halen|gevaar)|te laat dreigen|at risk|risk|in danger|miss .*deadline)/.test(t)) {
      if (!(await this.ai.enabled('risk'))) throw Object.assign(new Error('off'), { status: 403 });
      const profile = await this.access.profile(actor.accountId);
      const manager = profile.roles.some((r) => MANAGEMENT_ROLES.includes(r));
      const r = await this.ai.risk(actor, manager ? 'all' : 'mine', en ? 'en' : 'nl');
      const top = r.dossiers.filter((d) => d.level !== 'LOW').slice(0, 6);
      const content = en
        ? top.length
          ? `${r.counts.high} matter${r.counts.high === 1 ? '' : 's'} at high risk and ${r.counts.medium} at medium risk${manager ? ' across what you may see' : ' in your own work'}.`
          : 'I see no matters at risk of missing their deadline.'
        : top.length
          ? `${r.counts.high} ${r.counts.high === 1 ? 'zaak' : 'zaken'} met hoog risico en ${r.counts.medium} met middel risico${manager ? ' in alles wat u mag zien' : ' in uw eigen werk'}.`
          : 'Ik zie geen zaken die hun termijn dreigen te missen.';
      return {
        intent: 'risk',
        content,
        cards: top.length || r.letters.length
          ? [{ kind: 'RISK', title: en ? 'Deadline risk' : 'Termijnrisico', dossiers: top, letters: r.letters.slice(0, 5), link: '/assistent?tab=risico' }]
          : [],
        suggestions: [],
      };
    }

    const howTo = /^(hoe|waar|kan ik|mag ik|wat is|wat betekent|how|where|can i|what is|what does)\b/.test(t);
    const help = searchHelp(message, 3);
    if (howTo && help[0] && help[0].score >= 0.1) return this.helpReply(help, language);

    if (looksLikeDataQuestion(message)) {
      if (!(await this.ai.enabled('ask'))) throw Object.assign(new Error('off'), { status: 403 });
      const result = await this.ai.answerQuestion(actor, message, language);
      return {
        intent: 'ask',
        content: result.answer,
        cards: result.rows.length ? [{ kind: 'LIST', title: result.understood.join('; '), rows: result.rows, count: result.count }] : [],
        suggestions: [],
      };
    }

    if (help[0] && help[0].score >= 0.12) return this.helpReply(help, language);

    return {
      intent: 'fallback',
      content: en
        ? 'I am not sure I understood that. I can answer questions about your work, letters, matters and tasks, summarise a record, draft a reply, and explain how the system works. Try one of these:'
        : 'Ik weet niet zeker of ik u goed begrijp. Ik kan vragen beantwoorden over uw werk, brieven, zaken en taken, een stuk samenvatten, een antwoord opstellen en uitleggen hoe het systeem werkt. Probeer bijvoorbeeld:',
      cards: help.length ? [{ kind: 'HELP', title: en ? 'Perhaps you mean' : 'Bedoelt u misschien', articles: help.map((h) => ({ id: h.article.id, title: h.article[language].title, link: h.article.link })) }] : [],
      suggestions,
    };
  }

  /**
   * Questions about projects, answered on the server with the same need-to-know
   * as the project screens (ProjectsService): late projects, business cases
   * waiting for the person, one project by number or name, or an overview.
   */
  private async projectReply(actor: Actor, message: string, language: 'nl' | 'en'): Promise<Reply | null> {
    const t = normalise(message);
    const ref = /\bprj-\d{4}-\d{3}\b/i.exec(message)?.[0]?.toUpperCase();
    if (!ref && !/(project|business ?case|opdrachtgever|projectleider|mijlpaal|milestone|gantt)/.test(t)) return null;
    const en = language === 'en';
    const STATUS: Record<string, [string, string]> = { PROPOSED: ['business case', 'business case'], ACTIVE: ['loopt', 'running'], ON_HOLD: ['gepauzeerd', 'on hold'], COMPLETED: ['afgerond', 'completed'], CANCELLED: ['stopgezet', 'cancelled'] };
    const BC: Record<string, [string, string]> = { DRAFT: ['in voorbereiding', 'being written'], SUBMITTED: ['wacht op goedkeuring', 'awaiting approval'], APPROVED: ['goedgekeurd', 'approved'], RETURNED: ['teruggestuurd', 'returned'] };
    const st = (s: string) => (STATUS[s] ?? [s, s])[en ? 1 : 0];
    const all = (await this.projects.list(actor.accountId, { scope: 'all' })).data;
    const row = (p: (typeof all)[number]) => ({
      type: 'PROJECT',
      id: p.id,
      identity: p.reference,
      title: p.name,
      meta: [st(p.status), p.phase ? `${en ? 'phase' : 'fase'} ${p.phase.position}/${p.phase.count}` : null, `${p.progress}%`, p.late ? (en ? 'behind schedule' : 'loopt achter') : null, p.ticketCounts.overdue ? `${p.ticketCounts.overdue} ${en ? 'overdue' : 'te laat'}` : null].filter(Boolean).join(' · '),
      date: null,
      link: `/projecten/${p.id}`,
    });
    const list = (rows: typeof all, title: string): Card[] => [{ kind: 'LIST', title, rows: rows.slice(0, 12).map(row), count: rows.length, link: '/projecten' } as unknown as Card];
    const suggestions = en ? ['Which projects are behind schedule?', 'Which business cases await my approval?', 'Which projects am I on?'] : ['Welke projecten lopen achter?', 'Welke business cases wachten op mijn goedkeuring?', 'Op welke projecten sta ik?'];

    // One project, by number or by a word of its name.
    const words = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 5 && !/^(project|projecten|projects|ervoor|status|staat|hoeveel|welke|which|doing)$/.test(w));
    const named = ref
      ? all.filter((p) => p.reference === ref)
      : all.filter((p) => words.some((w) => normalise(p.name).split(/[^a-z0-9]+/).some((n) => n.length >= 5 && (n.startsWith(w) || w.startsWith(n)))));
    const askingOne = !!ref || (words.length > 0 && /(hoe staat|status|stand|how is|how's|where does|doing|ervoor)/.test(t));
    if (askingOne) {
      if (named.length !== 1) {
        if (named.length > 1) return { intent: 'project', content: en ? `Several projects match. Which one do you mean?` : `Er zijn meerdere projecten die daarop lijken. Welke bedoelt u?`, cards: list(named, en ? 'Projects' : 'Projecten'), suggestions: [] };
        return { intent: 'not-found', content: en ? 'I could not find that project, or you do not have access to it.' : 'Dat project kon ik niet vinden, of u hebt er geen toegang toe.', cards: [], suggestions };
      }
      const p = named[0];
      const d = await this.projects.detail(actor.accountId, p.id);
      const mine = d.tickets.filter((x) => x.overdue);
      const own = d.ticketsShown === 'all';
      const lines = [
        `**${p.reference} ${p.name}**: ${st(p.status)}${p.phase ? `, ${en ? 'phase' : 'fase'} ${p.phase.position} ${en ? 'of' : 'van'} ${p.phase.count} (${p.phase.name})` : ''}, ${p.progress}% ${en ? 'done' : 'gereed'}${p.late ? (en ? ', **behind schedule**' : ', **loopt achter op schema**') : ''}.`,
        `${en ? 'Owner' : 'Opdrachtgever'}: ${p.owner.name}. ${en ? 'Project manager' : 'Projectleider'}: ${p.manager.name}. ${en ? 'Business case' : 'Business case'}: ${(BC[p.businessCaseStatus] ?? [p.businessCaseStatus, p.businessCaseStatus])[en ? 1 : 0]}.`,
        d.access === 'SUMMARY'
          ? en ? `You see a summary: ${p.ticketCounts.open} open tickets, ${p.ticketCounts.overdue} overdue.` : `U ziet een samenvatting: ${p.ticketCounts.open} open tickets, ${p.ticketCounts.overdue} te laat.`
          : own
            ? en ? `All tickets: ${p.ticketCounts.open} open, ${p.ticketCounts.overdue} overdue${mine.length ? ` (${mine.slice(0, 5).map((x) => `${x.reference}, ${x.assignee.name}`).join('; ')})` : ''}.` : `Alle tickets: ${p.ticketCounts.open} open, ${p.ticketCounts.overdue} te laat${mine.length ? ` (${mine.slice(0, 5).map((x) => `${x.reference}, ${x.assignee.name}`).join('; ')})` : ''}.`
            : en ? `You see only your own tickets: ${d.tickets.length}${mine.length ? `, overdue: ${mine.map((x) => x.reference).join(', ')}` : ''}.` : `U ziet alleen uw eigen tickets: ${d.tickets.length}${mine.length ? `, te laat: ${mine.map((x) => x.reference).join(', ')}` : ''}.`,
      ];
      return { intent: 'project', content: lines.join('\n'), cards: list([p], en ? 'Project' : 'Project'), suggestions: [] };
    }
    if (/(achter|te laat|vertraag|behind|late|overdue|delayed)/.test(t)) {
      const late = all.filter((p) => ['PROPOSED', 'ACTIVE'].includes(p.status) && (p.late || p.ticketCounts.overdue > 0));
      const behind = late.filter((p) => p.late);
      const content = late.length
        ? en
          ? `${late.length} project${late.length === 1 ? ' is' : 's are'} behind schedule or ${late.length === 1 ? 'has' : 'have'} overdue tickets${behind.length ? `; behind schedule: ${behind.map((p) => p.reference).join(', ')}` : ''}.`
          : `${late.length} ${late.length === 1 ? 'project loopt' : 'projecten lopen'} achter of ${late.length === 1 ? 'heeft' : 'hebben'} tickets over hun termijn${behind.length ? `; achter op schema: ${behind.map((p) => p.reference).join(', ')}` : ''}.`
        : en ? 'No project you may see is behind schedule.' : 'Geen enkel project dat u mag zien loopt achter.';
      return { intent: 'project', content, cards: late.length ? list(late, en ? 'Projects behind schedule' : 'Projecten die achterlopen') : [], suggestions: [] };
    }
    if (/(business ?case|goedkeur|approv|beslis|decision)/.test(t)) {
      const waiting = all.filter((p) => p.myRole === 'OWNER' && p.businessCaseStatus === 'SUBMITTED' && p.status === 'PROPOSED');
      return {
        intent: 'project',
        content: waiting.length
          ? en ? `${waiting.length} business case${waiting.length === 1 ? ' awaits' : 's await'} your approval. Open the project and choose the Business case tab.` : `${waiting.length} business ${waiting.length === 1 ? 'case wacht' : 'cases wachten'} op uw goedkeuring. Open het project en kies het tabblad Business case.`
          : en ? 'No business case is waiting for your approval.' : 'Er wacht geen business case op uw goedkeuring.',
        cards: waiting.length ? list(waiting, en ? 'Awaiting your approval' : 'Wacht op uw goedkeuring') : [],
        suggestions: [],
      };
    }
    const scoped = /(mijn|ik sta|my|i am on|am i)/.test(t) ? all.filter((p) => p.myRole) : all;
    const running = scoped.filter((p) => ['PROPOSED', 'ACTIVE'].includes(p.status));
    return {
      intent: 'project',
      content: scoped.length
        ? en
          ? `You may see ${scoped.length} project${scoped.length === 1 ? '' : 's'}: ${running.length} running, ${scoped.filter((p) => p.late).length} behind schedule, ${scoped.filter((p) => p.status === 'COMPLETED').length} completed.`
          : `U mag ${scoped.length} ${scoped.length === 1 ? 'project' : 'projecten'} zien: ${running.length} lopend, ${scoped.filter((p) => p.late).length} achter op schema, ${scoped.filter((p) => p.status === 'COMPLETED').length} afgerond.`
        : en ? 'You are not on any project, and none falls under your line.' : 'U staat op geen enkel project, en er valt er geen onder uw lijn.',
      cards: scoped.length ? list(scoped, en ? 'Projects' : 'Projecten') : [],
      suggestions,
    };
  }

  /**
   * "How many matters does <department> have?": only within the person's line.
   * Outside it the answer is a refusal, never a number.
   */
  private async unitReply(actor: Actor, message: string, language: 'nl' | 'en'): Promise<Reply | null> {
    const t = normalise(message);
    if (!/(zaken|dossiers|matters|cases|hoeveel|how many|open)/.test(t)) return null;
    const units: { id: string; name: string; code: string }[] = await this.dataSource.query(`SELECT id, name, code FROM organisational_unit WHERE is_active`);
    const hit = units
      .filter((u) => (normalise(u.name).length >= 6 && t.includes(normalise(u.name))) || new RegExp(`\\b${u.code.replace(/[^A-Za-z0-9-]/g, '')}\\b`).test(message))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!hit) return null;
    const en = language === 'en';
    const profile = await this.access.profile(actor.accountId);
    const line = await this.access.lineScope(profile);
    if (!line.all && !line.unitIds.includes(hit.id)) {
      return {
        intent: 'refused',
        content: en
          ? `${hit.name} is outside your line, so I give no figures about it. You can ask the head of that department.`
          : `${hit.name} valt buiten uw lijn, dus daarover geef ik geen cijfers. U kunt het navragen bij de leiding van die afdeling.`,
        cards: [],
        suggestions: [],
      };
    }
    const visible = await this.access.visibleDossierIds(profile);
    const rows: { id: string; dossier_identity: string; subject: string; due_date: string | null }[] = await this.dataSource.query(
      `WITH RECURSIVE tree AS (SELECT id FROM organisational_unit WHERE id = $1 UNION ALL SELECT u.id FROM organisational_unit u JOIN tree ON u.parent_unit_id = tree.id)
       SELECT d.id, d.dossier_identity, d.subject, to_char(d.due_date, 'YYYY-MM-DD') AS due_date FROM dossier d
        WHERE d.owning_unit_id IN (SELECT id FROM tree) AND d.state <> 'CLOSED' AND d.processing_state <> 'FINALISED'
        ORDER BY d.due_date NULLS LAST`,
      [hit.id],
    );
    const open = rows.filter((r) => visible.has(r.id));
    return {
      intent: 'ask',
      content: en ? `${hit.name} has **${open.length}** open matter${open.length === 1 ? '' : 's'} that you may see.` : `${hit.name} heeft **${open.length}** open ${open.length === 1 ? 'zaak' : 'zaken'} die u mag zien.`,
      cards: open.length
        ? [{ kind: 'LIST', title: hit.name, rows: open.slice(0, 12).map((r) => ({ type: 'DOSSIER', id: r.id, identity: r.dossier_identity, title: r.subject, meta: en ? 'due' : 'termijn', date: r.due_date, link: `/zaken/${r.id}` })), count: open.length } as unknown as Card]
        : [],
      suggestions: [],
    };
  }

  private helpReply(help: ReturnType<typeof searchHelp>, language: 'nl' | 'en'): Reply {
    const best = help[0].article;
    return {
      intent: 'help',
      content: `${best[language].title}\n${best[language].body}`,
      cards: [
        {
          kind: 'HELP',
          title: best[language].title,
          link: best.link,
          articles: help.slice(1).map((h) => ({ id: h.article.id, title: h.article[language].title, link: h.article.link })),
        },
      ],
      suggestions: [],
    };
  }

  private async workFacts(accountId: string, language: 'nl' | 'en'): Promise<string> {
    const w = await this.dashboard.myWork(accountId);
    const s = w.summary;
    return language === 'en'
      ? `Open tasks ${s.openTasks} (${s.overdueTasks} overdue, ${s.dueThisWeek} due this week); awaiting their decision ${s.awaitingMyDecision}; advice to give ${s.adviceToGive}; matters responsible for ${s.responsibleMatters} (${s.overdueMatters} overdue); drafts to register ${s.draftsToRegister}.`
      : `Open taken ${s.openTasks} (${s.overdueTasks} te laat, ${s.dueThisWeek} deze week); wacht op hun besluit ${s.awaitingMyDecision}; advies te geven ${s.adviceToGive}; zaken verantwoordelijk ${s.responsibleMatters} (${s.overdueMatters} over termijn); concepten te registreren ${s.draftsToRegister}.`;
  }

  private async myWork(actor: Actor, language: 'nl' | 'en'): Promise<Reply> {
    const en = language === 'en';
    const w = await this.dashboard.myWork(actor.accountId);
    const s = w.summary;
    const parts: string[] = [];
    if (s.awaitingMyDecision) parts.push(en ? `${n(s.awaitingMyDecision, 'matter awaits', 'matters await')} your decision` : `${n(s.awaitingMyDecision, 'zaak wacht', 'zaken wachten')} op uw besluit`);
    if (s.overdueTasks) parts.push(en ? `${n(s.overdueTasks, 'task is', 'tasks are')} overdue` : `${n(s.overdueTasks, 'taak is', 'taken zijn')} te laat`);
    if (s.dueThisWeek) parts.push(en ? `${n(s.dueThisWeek, 'task is', 'tasks are')} due this week` : `${n(s.dueThisWeek, 'taak verloopt', 'taken verlopen')} deze week`);
    if (s.adviceToGive) parts.push(en ? `${n(s.adviceToGive, 'advice request is', 'advice requests are')} waiting for you` : s.adviceToGive === 1 ? 'er wacht 1 adviesaanvraag op u' : `er wachten ${s.adviceToGive} adviesaanvragen op u`);
    if (s.overdueMatters) parts.push(en ? (s.overdueMatters === 1 ? '1 of your matters is past its deadline' : `${s.overdueMatters} of your matters are past their deadline`) : s.overdueMatters === 1 ? '1 van uw zaken is over termijn' : `${s.overdueMatters} van uw zaken zijn over termijn`);
    if (s.draftsToRegister) parts.push(en ? `${n(s.draftsToRegister, 'draft still needs', 'drafts still need')} registering` : `${n(s.draftsToRegister, 'concept moet', 'concepten moeten')} nog worden geregistreerd`);
    const content = parts.length
      ? `${en ? `Today, ${readableDate(w.today)}` : `Vandaag, ${longDutchDate(w.today)}`}: ${parts.join('; ')}. ${en ? `In total you have ${n(s.openTasks, 'open task', 'open tasks')}.` : `In totaal hebt u ${n(s.openTasks, 'open taak', 'open taken')}.`}`
      : en ? `Nothing urgent is waiting for you today. You have ${n(s.openTasks, 'open task', 'open tasks')}.` : `Er staat vandaag niets dringends voor u klaar. U hebt ${n(s.openTasks, 'open taak', 'open taken')}.`;
    const rows = [
      ...w.reviewQueue.slice(0, 4).map((r: { dossierId: string; dossierIdentity: string; subject: string }) => ({
        type: 'DOSSIER',
        id: r.dossierId,
        identity: r.dossierIdentity,
        title: r.subject,
        meta: en ? 'awaiting your decision' : 'wacht op uw besluit',
        date: null,
        link: `/zaken/${r.dossierId}`,
      })),
      ...w.tasks
        .filter((x) => x.overdue || x.dueDate)
        .slice(0, 6)
        .map((x) => ({ type: 'TASK', id: x.id, identity: x.reference, title: x.title, meta: x.overdue ? (en ? 'overdue' : 'te laat') : en ? 'due' : 'termijn', date: x.dueDate, link: `/taken/${x.id}` })),
    ];
    return {
      intent: 'my-work',
      content,
      cards: rows.length ? [{ kind: 'LIST', title: en ? 'My work' : 'Mijn werk', rows, count: rows.length, link: '/' }] : [],
      suggestions: en ? ['Which matters are at risk?', 'Show my overdue tasks'] : ['Welke zaken lopen risico?', 'Toon mijn taken die te laat zijn'],
    };
  }

  private async taskProposal(actor: Actor, message: string, language: 'nl' | 'en', context: ChatContext | null): Promise<Reply> {
    const en = language === 'en';
    const today = todayInSuriname();
    const people: { id: string; full_name: string }[] = await this.dataSource.query(
      `SELECT a.id, p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE a.is_enabled`,
    );
    let assignee = { accountId: actor.accountId, name: people.find((p) => p.id === actor.accountId)?.full_name ?? '' };
    const forWhom = /\b(?:voor|aan|for|to)\s+(?:mevrouw\s+|meneer\s+|mevr\.\s+|dhr\.\s+|mr\.?\s+|ms\.?\s+|mrs\.?\s+)?([A-Z][\w.\-']+(?:\s[A-Z][\w\-']+)?)/.exec(message);
    if (forWhom) {
      const wanted = forWhom[1].split(/\s+/).pop()!;
      const match = people
        .map((p) => ({ p, d: distance(wanted, p.full_name.split(/\s+/).pop() ?? '') }))
        .filter((x) => x.d <= 1)
        .sort((a, b) => a.d - b.d)[0];
      if (match) assignee = { accountId: match.p.id, name: match.p.full_name };
    }
    const dueDate = looseDate(message, today);
    let title = message
      .replace(/^\s*(maak|creëer|creeer|plan|zet|voeg)\s+(een\s+)?(nieuwe\s+)?(taak|actie|herinnering)\s*(aan|toe)?\s*(om|:|-|voor mij om)?\s*/i, '')
      .replace(/^\s*herinner (me|mij)\s*(eraan)?\s*(om|dat|:)?\s*/i, '')
      .replace(/^\s*(create|add|make|set up)\s+(a\s+)?(new\s+)?(task|reminder|action)\s*(to|:|-|for me to)?\s*/i, '')
      .replace(/^\s*remind me\s*(to|that|:)?\s*/i, '');
    if (forWhom) title = title.replace(forWhom[0], '');
    title = title
      .replace(/\b(uiterlijk|vóór|voor|before|by|op|on)?\s*(morgen|overmorgen|vandaag|volgende week|eind(e)? van de (week|maand)|tomorrow|today|next week|end of (the )?(week|month)|maandag|dinsdag|woensdag|donderdag|vrijdag|monday|tuesday|wednesday|thursday|friday)\b/gi, '')
      .replace(/\b(uiterlijk|vóór|voor|before|by|binnen|within)\s+(\d{1,2}\s+\w+(\s+\d{4})?|\d+\s+(werk)?dagen|\d+\s+(working )?days)\b/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s,:;-]+|[\s,:;.-]+$/g, '')
      .replace(/^(om|to)\s+/i, '')
      .trim();
    if (!title) title = en ? 'New task' : 'Nieuwe taak';
    title = (title.charAt(0).toUpperCase() + title.slice(1)).slice(0, 200);
    const priority = /\b(spoed|urgent|dringend|asap|z\.s\.m\.)\b/i.test(message) ? 'URGENT' : 'MEDIUM';
    let dossier: { id: string; identity: string } | null = null;
    if (context?.type === 'DOSSIER') {
      const [d] = await this.dataSource.query(`SELECT id, dossier_identity FROM dossier WHERE id = $1`, [context.id]);
      if (d) dossier = { id: d.id, identity: d.dossier_identity };
    }
    return {
      intent: 'task-proposal',
      content: en
        ? `Shall I create this task? Check the details and confirm.`
        : `Zal ik deze taak aanmaken? Controleer de gegevens en bevestig.`,
      cards: [
        {
          kind: 'TASK_PROPOSAL',
          title: en ? 'Proposed task' : 'Voorgestelde taak',
          task: { title, assigneeAccountId: assignee.accountId, assigneeName: assignee.name, dueDate: dueDate && dueDate >= today ? dueDate : null, priority, dossierId: dossier?.id ?? null, dossierIdentity: dossier?.identity ?? null },
        },
      ],
      suggestions: [],
      pending: { kind: 'TASKS', interactionId: '' },
    };
  }

  /** A registration, matter or task number in the message, if the person may see it. */
  private async resolveReference(accountId: string, message: string): Promise<ChatContext | null> {
    const m = IDENTITY.exec(message);
    if (!m) return null;
    const ref = m[1].toUpperCase();
    const profile = await this.access.profile(accountId);
    const [d] = await this.dataSource.query(`SELECT id FROM dossier WHERE upper(dossier_identity) = $1`, [ref]);
    if (d && (await this.access.canViewDossier(profile, d.id))) return { type: 'DOSSIER', id: d.id };
    const [i] = await this.dataSource.query(`SELECT id FROM correspondence_item WHERE upper(registration_identity) = $1`, [ref]);
    if (i && (await this.access.canViewItem(profile, i.id))) return { type: 'ITEM', id: i.id };
    return null;
  }
}

/** "1 taak", "3 taken". */
function n(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
