import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccessProfile, AccessService, isUuid } from '../access/access.service';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { MANAGEMENT_ROLES, todayInSuriname } from '../common/actor';
import { addDays, WorkingDaysService } from '../core/working-days.service';
import { LettersService } from '../letters/letters.service';
import { Actor } from '../records/registration.service';
import { Settings } from '../settings/settings.defaults';
import { SettingsService } from '../settings/settings.service';
import { TasksService } from '../tasks/tasks.service';
import { AskQuery, parseQuestion } from './engine/ask';
import { longDutchDate } from './engine/dates';
import { extractIntake, IntakeProposals } from './engine/extract';
import { topicsIn } from './engine/lexicon';
import { ActionProposal, Person, proposeActions } from './engine/notes';
import { KeySentence, keySentences } from './engine/summarise';
import { cosine, detectLanguage, excerpt, idfOf, trigramSimilarity, vector } from './engine/text';
import { complete, isLocalAddress, LlmError, Turn } from './llm';

export type AiFeature = keyof Settings['ai']['features'];

export interface Engine {
  provider: string;
  model: string;
  local: boolean;
  /** Set when a configured language model was not used, with the reason. */
  fallback?: string;
}

export const BUILTIN_MODEL = 'juspol-assistent 1.0 (ingebouwd)';
const BUILTIN: Engine = { provider: 'builtin', model: BUILTIN_MODEL, local: true };
const NIL = '00000000-0000-0000-0000-000000000000';

const STATE_NL: Record<string, string> = {
  ACTIVE: 'in behandeling',
  UNDER_REVIEW: 'ter beoordeling',
  RETURNED: 'teruggestuurd',
  APPROVED: 'goedgekeurd',
  FINALISED: 'afgerond',
};
const STATE_EN: Record<string, string> = {
  ACTIVE: 'in progress',
  UNDER_REVIEW: 'under review',
  RETURNED: 'returned',
  APPROVED: 'approved',
  FINALISED: 'finalised',
};
const EVENT_NL: Record<string, string> = {
  SUBMITTED: 'ingediend ter beoordeling',
  APPROVED: 'goedgekeurd',
  RETURNED: 'teruggestuurd',
  REJECTED: 'afgewezen',
  FINALISED: 'afgerond',
  FORWARDED: 'doorgestuurd',
  WITHDRAWN: 'ingetrokken',
};

export interface ItemContext {
  id: string;
  registrationIdentity: string | null;
  subject: string;
  party: string | null;
  direction: string;
  state: string;
  classification: string;
  documentDate: string | null;
  senderReference: string | null;
  replyRequestedBy: string | null;
  registeredOn: string | null;
  text: string;
  documents: { id: string; filename: string; textStatus: string | null }[];
}

/**
 * The assistant. Free: by default everything runs in this server with the
 * built-in engine, and no data leaves it. When the administrator connects a
 * language model (a free open-source model in Ollama on the ministry's own
 * hardware, or — after explicit confirmation — an outside service), it is used
 * to word summaries, replies and chat answers; the built-in engine still does
 * the finding, counting and checking.
 *
 * The rules every feature keeps:
 *   - it is switched off until the administrator switches it on;
 *   - it sees only what the person asking may see — every record goes through
 *     the same permission evaluator as the screens;
 *   - it proposes; a person decides. Nothing is changed until someone accepts;
 *   - every suggestion is kept (ai_interaction), with whether it was accepted,
 *     changed or rejected (ai_feedback), and acceptance is audited;
 *   - confidential and secret material never goes to a model outside the
 *     ministry network.
 */
@Injectable()
export class AiService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly workingDays: WorkingDaysService,
    private readonly tasks: TasksService,
    private readonly letters: LettersService,
  ) {}

  // ------------------------------------------------------------ plumbing

  async config(): Promise<Settings['ai']> {
    return this.settings.get('ai');
  }

  async require(feature: AiFeature): Promise<Settings['ai']> {
    const cfg = await this.config();
    if (!cfg.features[feature]) throw new ForbiddenException('This assistant feature is switched off by the administrator.');
    return cfg;
  }

  async enabled(feature: AiFeature): Promise<boolean> {
    return (await this.config()).features[feature];
  }

  async record(
    actor: Actor,
    feature: string,
    subject: { type: string; id: string } | null,
    engine: Engine,
    prompt: string,
    output: unknown,
    started: number,
  ): Promise<string> {
    const [row] = await this.dataSource.query(
      `INSERT INTO ai_interaction (feature, account_id, subject_type, subject_id, provider, model, prompt_summary, output, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        feature,
        actor.accountId,
        subject?.type ?? null,
        subject?.id ?? null,
        engine.provider,
        engine.model.slice(0, 120),
        prompt.replace(/\s+/g, ' ').slice(0, 600),
        JSON.stringify(output ?? {}),
        Date.now() - started,
      ],
    );
    return row.id;
  }

  /**
   * Asks the configured language model, when there is one and it may be used
   * for this material. Returns null when the built-in engine should answer,
   * with the reason in `engine.fallback` when a model was configured.
   */
  async model(cfg: Settings['ai'], levels: string[], turns: Turn[], maxTokens = 700): Promise<{ text: string | null; engine: Engine }> {
    if (cfg.provider === 'builtin') return { text: null, engine: BUILTIN };
    const local = isLocalAddress(cfg.baseUrl);
    if (!local && levels.some((l) => l === 'CONFIDENTIAL' || l === 'SECRET')) {
      return {
        text: null,
        engine: { ...BUILTIN, fallback: 'Vertrouwelijke stukken gaan niet naar een taalmodel buiten het netwerk van het ministerie; de ingebouwde assistent is gebruikt.' },
      };
    }
    try {
      const c = await complete(cfg, turns, { maxTokens });
      return { text: c.text, engine: { provider: cfg.provider, model: c.model, local } };
    } catch (error) {
      const reason = error instanceof LlmError ? error.message : 'unknown error';
      return { text: null, engine: { ...BUILTIN, fallback: `Het taalmodel gaf geen antwoord (${reason.slice(0, 160)}); de ingebouwde assistent is gebruikt.` } };
    }
  }

  systemPrompt(language: 'nl' | 'en', extra = ''): string {
    const base =
      language === 'en'
        ? 'You are the assistant in the document and workflow system of the Ministry of Justice and Police of Suriname. Answer in English. Use only the information given below; never invent names, dates, numbers or decisions. If something is not in the information, say so. Never take decisions or make promises on behalf of the ministry. Be brief and businesslike.'
        : 'Je bent de assistent in het document- en werkstroomsysteem van het Ministerie van Justitie en Politie van Suriname. Antwoord in het Nederlands. Gebruik alleen de gegevens hieronder; verzin geen namen, data, nummers of besluiten. Staat iets niet in de gegevens, zeg dat dan. Neem geen besluiten en doe geen toezeggingen namens het ministerie. Wees kort en zakelijk.';
    return extra ? `${base}\n\n${extra}` : base;
  }

  // ------------------------------------------------------------ gathering

  async item(accountId: string, itemId: string): Promise<{ item: ItemContext; profile: AccessProfile }> {
    const profile = await this.access.assertItem(accountId, itemId);
    const [row] = await this.dataSource.query(
      `SELECT ci.id, ci.registration_identity, ci.subject, ci.party, ci.direction, ci.state, ci.classification,
              to_char(ci.document_date, 'YYYY-MM-DD') AS document_date, ci.sender_reference,
              to_char(ci.reply_requested_by, 'YYYY-MM-DD') AS reply_requested_by,
              to_char(ci.registered_at AT TIME ZONE 'America/Paramaribo', 'YYYY-MM-DD') AS registered_on
         FROM correspondence_item ci WHERE ci.id = $1`,
      [itemId],
    );
    const docs: { id: string; original_filename: string; status: string | null; extracted_text: string | null }[] = await this.dataSource.query(
      `SELECT cd.id, cd.original_filename, dt.status, dt.extracted_text
         FROM captured_document cd LEFT JOIN document_text dt ON dt.captured_document_id = cd.id
        WHERE cd.correspondence_item_id = $1 ORDER BY cd.captured_at`,
      [itemId],
    );
    const text = docs
      .filter((d) => d.status === 'EXTRACTED' && d.extracted_text)
      .map((d) => d.extracted_text as string)
      .join('\n\n')
      .slice(0, 60_000);
    return {
      profile,
      item: {
        id: row.id,
        registrationIdentity: row.registration_identity,
        subject: row.subject,
        party: row.party,
        direction: row.direction,
        state: row.state,
        classification: row.classification,
        documentDate: row.document_date,
        senderReference: row.sender_reference,
        replyRequestedBy: row.reply_requested_by,
        registeredOn: row.registered_on,
        text,
        documents: docs.map((d) => ({ id: d.id, filename: d.original_filename, textStatus: d.status })),
      },
    };
  }

  private async people(): Promise<Person[]> {
    const rows: { id: string; full_name: string }[] = await this.dataSource.query(
      `SELECT DISTINCT a.id, p.full_name FROM account a JOIN person p ON p.id = a.person_id
         JOIN role_assignment ra ON ra.account_id = a.id AND ra.revoked_at IS NULL
         JOIN functional_role r ON r.id = ra.functional_role_id
        WHERE a.is_enabled AND r.code IN ('SUPPORT_STAFF','DIRECTEUR','ONDER_DIRECTEUR','MINISTER','RECORDS_MANAGER')`,
    );
    return rows.map((r) => ({ accountId: r.id, name: r.full_name }));
  }

  private async nameOf(accountId: string): Promise<string> {
    const [r] = await this.dataSource.query(`SELECT p.full_name FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = $1`, [accountId]);
    return r?.full_name ?? '';
  }

  // ------------------------------------------------------------ intake

  /** Proposals for the registration form, read from the letter's documents. */
  async intakeForItem(actor: Actor, itemId: string) {
    const started = Date.now();
    const cfg = await this.require('intake');
    const { item, profile } = await this.item(actor.accountId, itemId);
    const source = item.text.trim() ? item.text : [item.subject, item.party].filter(Boolean).join('\n');
    const proposals = await this.intake(source, item.documentDate ?? item.registeredOn ?? todayInSuriname());
    const extras = await this.extrasFor(cfg, profile, `${item.subject}\n${item.party ?? ''}\n${item.text.slice(0, 6000)}`, item);
    const output = {
      proposals,
      ...extras,
      readable: Boolean(item.text.trim()),
      current: {
        subject: item.subject,
        party: item.party,
        documentDate: item.documentDate,
        senderReference: item.senderReference,
        replyRequestedBy: item.replyRequestedBy,
        classification: item.classification,
      },
    };
    const interactionId = await this.record(actor, 'intake', { type: 'ITEM', id: item.id }, BUILTIN, `Registratievoorstel voor ${item.registrationIdentity ?? 'concept'}: ${item.subject}`, output, started);
    return { interactionId, engine: BUILTIN, ...output };
  }

  /** The same proposals from text the person pastes or a photo's recognised text. */
  async intakeFromText(actor: Actor, text: string) {
    const started = Date.now();
    const cfg = await this.require('intake');
    if (!text?.trim()) throw new BadRequestException('Paste the text of the letter.');
    const profile = await this.access.profile(actor.accountId);
    const proposals = await this.intake(text.slice(0, 60_000), todayInSuriname());
    const extras = await this.extrasFor(cfg, profile, text.slice(0, 6000), null, proposals);
    const output = { proposals, ...extras, readable: true };
    const interactionId = await this.record(actor, 'intake', null, BUILTIN, `Registratievoorstel uit geplakte tekst (${proposals.wordCount} woorden)`, output, started);
    return { interactionId, engine: BUILTIN, ...output };
  }

  private async intake(text: string, reference: string): Promise<IntakeProposals> {
    const proposals = extractIntake(text, reference);
    const from = proposals.documentDate?.value ?? reference;
    for (const d of proposals.deadlines) {
      if (d.kind === 'RELATIVE_WORKING_DAYS' && d.workingDays) d.dueDate = await this.workingDays.addWorkingDays(from, d.workingDays);
    }
    return proposals;
  }

  private async extrasFor(cfg: Settings['ai'], profile: AccessProfile, text: string, item: ItemContext | null, proposals?: IntakeProposals) {
    const subject = item?.subject ?? proposals?.subject?.value ?? '';
    const party = item?.party ?? proposals?.party?.value ?? null;
    const [routing, category, duplicates] = await Promise.all([
      cfg.features.routing ? this.routingFor(profile, text, item?.id ?? null) : Promise.resolve(null),
      cfg.features.routing ? this.categoryFor(profile, text) : Promise.resolve(null),
      cfg.features.duplicates
        ? this.nearDuplicates(profile, { id: item?.id ?? null, subject, party, reference: item?.senderReference ?? proposals?.senderReference?.value ?? null, text })
        : Promise.resolve(null),
    ]);
    return { routing, category, duplicates };
  }

  /** Deadlines asked for in a letter or a pasted text. */
  async deadlines(actor: Actor, input: { itemId?: string; text?: string }) {
    const started = Date.now();
    await this.require('deadlines');
    let text = input.text ?? '';
    let reference = todayInSuriname();
    let subject: { type: string; id: string } | null = null;
    if (input.itemId) {
      const { item } = await this.item(actor.accountId, input.itemId);
      text = item.text || item.subject;
      reference = item.documentDate ?? item.registeredOn ?? reference;
      subject = { type: 'ITEM', id: item.id };
    }
    if (!text.trim()) throw new BadRequestException('There is no text to read deadlines from.');
    const proposals = await this.intake(text, reference);
    const output = { deadlines: proposals.deadlines, documentDate: proposals.documentDate };
    const interactionId = await this.record(actor, 'deadlines', subject, BUILTIN, `Termijnen herkennen (${proposals.wordCount} woorden)`, output, started);
    return { interactionId, engine: BUILTIN, ...output };
  }

  // ------------------------------------------------------------ routing

  /**
   * Which unit should handle this, and who there. Learns from where earlier,
   * similar letters were handled (only letters this person may see), and
   * falls back to the subject areas of the ministry.
   */
  async routingFor(profile: AccessProfile, text: string, excludeItemId: string | null) {
    const units: { id: string; code: string; name: string; head_account_id: string | null; head_name: string | null }[] = await this.dataSource.query(
      `SELECT u.id, u.code, u.name, u.head_account_id, p.full_name AS head_name
         FROM organisational_unit u LEFT JOIN account a ON a.id = u.head_account_id LEFT JOIN person p ON p.id = a.person_id
        WHERE u.is_active`,
    );
    const dp = this.access.dossierPredicate(profile, 'd', 2);
    const ip = this.access.itemPredicate(profile, 'ci', 2 + dp.params.length);
    const history: { subject: string; party: string | null; unit: string; responsible: string | null; text: string | null }[] = await this.dataSource.query(
      `SELECT ci.subject, ci.party, d.owning_unit_id AS unit, ra.responsible_account_id AS responsible,
              (SELECT substr(string_agg(dt.extracted_text, ' '), 1, 1200) FROM captured_document cd
                 JOIN document_text dt ON dt.captured_document_id = cd.id
                WHERE cd.correspondence_item_id = ci.id AND dt.status = 'EXTRACTED') AS text
         FROM dossier_link dl
         JOIN correspondence_item ci ON ci.id = dl.correspondence_item_id
         JOIN dossier d ON d.id = dl.dossier_id
         LEFT JOIN responsibility_assignment ra ON ra.dossier_id = d.id AND ra.superseded_at IS NULL
        WHERE ci.id <> $1 AND d.owning_unit_id IS NOT NULL AND ${dp.sql} AND ${ip.sql}
        ORDER BY dl.linked_at DESC LIMIT 800`,
      [excludeItemId ?? NIL, ...dp.params, ...ip.params],
    );
    const docs = history.map((h) => `${h.subject} ${h.party ?? ''} ${h.text ?? ''}`);
    const idf = idfOf([...docs, text]);
    const q = vector(text, idf);
    const perUnit = new Map<string, { sims: number[]; people: Map<string, number> }>();
    history.forEach((h, i) => {
      const sim = cosine(q, vector(docs[i], idf));
      const entry = perUnit.get(h.unit) ?? { sims: [] as number[], people: new Map<string, number>() };
      entry.sims.push(sim);
      if (h.responsible && sim > 0.2) entry.people.set(h.responsible, (entry.people.get(h.responsible) ?? 0) + 1);
      perUnit.set(h.unit, entry);
    });
    const topics = topicsIn(text);
    const scored = units.map((u) => {
      const reasons: string[] = [];
      let learned = 0;
      const h = perUnit.get(u.id);
      if (h) {
        const top = [...h.sims].sort((a, b) => b - a).slice(0, 3);
        learned = top.reduce((a, b) => a + b, 0) / Math.max(top.length, 1);
        const similar = h.sims.filter((s) => s > 0.25).length;
        if (similar) reasons.push(`${similar} vergelijkbare brief${similar === 1 ? '' : 'ven'} werd${similar === 1 ? '' : 'en'} hier behandeld`);
      }
      let lexical = 0;
      const name = u.name.toLowerCase();
      for (const { topic, hits } of topics) {
        if (topic.unitHints.some((hint) => name.includes(hint))) {
          lexical = Math.max(lexical, Math.min(0.75, 0.35 + 0.1 * hits.length));
          reasons.push(`onderwerp ${topic.nl.toLowerCase()} (${hits.slice(0, 4).join(', ')})`);
        }
      }
      const score = Math.min(0.97, Math.max(learned, lexical) + (learned > 0.2 && lexical > 0 ? 0.1 : 0));
      const person = h ? [...h.people.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null : null;
      return { unit: u, score, reasons, person };
    });
    const best = scored.filter((s) => s.score >= 0.15).sort((a, b) => b.score - a.score).slice(0, 3);
    const out = [];
    for (const s of best) {
      const personId = s.person ?? s.unit.head_account_id;
      let person: { accountId: string; name: string; openTasks: number; basis: string } | null = null;
      if (personId) {
        const [w] = await this.dataSource.query(
          `SELECT p.full_name AS name, (SELECT count(*)::int FROM task t WHERE t.assignee_account_id = a.id AND t.status IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW') AND t.archived_at IS NULL) AS open
             FROM account a JOIN person p ON p.id = a.person_id WHERE a.id = $1 AND a.is_enabled`,
          [personId],
        );
        if (w) person = { accountId: personId, name: w.name, openTasks: w.open, basis: s.person ? 'behandelde vergelijkbare zaken' : 'hoofd van de afdeling' };
      }
      out.push({
        unitId: s.unit.id,
        unitCode: s.unit.code,
        unitName: s.unit.name,
        confidence: Math.round(s.score * 100) / 100,
        reasons: s.reasons.slice(0, 3),
        person,
      });
    }
    return out;
  }

  /** A file-plan category, from category descriptions and earlier matters. */
  async categoryFor(profile: AccessProfile, text: string) {
    const categories: { id: string; code: string; name: string; description: string | null; handling_working_days: number | null }[] = await this.dataSource.query(
      `SELECT id, code, name, description, handling_working_days FROM dossier_category WHERE is_active`,
    );
    if (!categories.length) return [];
    const dp = this.access.dossierPredicate(profile, 'd', 1);
    const history: { category_id: string; subject: string }[] = await this.dataSource.query(
      `SELECT d.category_id, d.subject FROM dossier d WHERE d.category_id IS NOT NULL AND ${dp.sql} ORDER BY d.created_at DESC LIMIT 600`,
      dp.params,
    );
    const catTexts = categories.map((c) => `${c.name} ${c.name} ${c.description ?? ''}`);
    const idf = idfOf([...catTexts, ...history.map((h) => h.subject), text]);
    const q = vector(text, idf);
    const learned = new Map<string, number[]>();
    for (const h of history) {
      const list = learned.get(h.category_id) ?? [];
      list.push(cosine(q, vector(h.subject, idf)));
      learned.set(h.category_id, list);
    }
    return categories
      .map((c, i) => {
        const described = cosine(q, vector(catTexts[i], idf));
        const sims = (learned.get(c.id) ?? []).sort((a, b) => b - a).slice(0, 3);
        const fromHistory = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;
        const score = Math.min(0.95, Math.max(described * 1.4, fromHistory) + (described > 0.1 && fromHistory > 0.2 ? 0.1 : 0));
        const reasons = [];
        if (described > 0.1) reasons.push('past bij de omschrijving van de categorie');
        if (fromHistory > 0.2) reasons.push('eerdere zaken met een vergelijkbaar onderwerp');
        return { categoryId: c.id, code: c.code, name: c.name, handlingWorkingDays: c.handling_working_days, confidence: Math.round(score * 100) / 100, reasons };
      })
      .filter((c) => c.confidence >= 0.12)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
  }

  async routing(actor: Actor, itemId: string) {
    const started = Date.now();
    const cfg = await this.require('routing');
    const { item, profile } = await this.item(actor.accountId, itemId);
    const text = `${item.subject}\n${item.party ?? ''}\n${item.text.slice(0, 6000)}`;
    const [units, categories] = await Promise.all([this.routingFor(profile, text, item.id), this.categoryFor(profile, text)]);
    void cfg;
    const output = { units, categories };
    const interactionId = await this.record(actor, 'routing', { type: 'ITEM', id: item.id }, BUILTIN, `Afdeling voorstellen voor ${item.registrationIdentity ?? 'concept'}: ${item.subject}`, output, started);
    return { interactionId, engine: BUILTIN, ...output };
  }

  // ------------------------------------------------------------ duplicates

  /**
   * Letters that may be the same matter written again or sent twice: similar
   * subject, same sender, matching text, same sender reference. Beyond the
   * exact checks of the registry, and only among letters this person may see.
   */
  async nearDuplicates(profile: AccessProfile, me: { id: string | null; subject: string; party: string | null; reference: string | null; text: string }) {
    const pred = this.access.itemPredicate(profile, 'ci', 2);
    const rows: {
      id: string;
      registration_identity: string;
      subject: string;
      party: string | null;
      sender_reference: string | null;
      direction: string;
      registered_at: Date;
      text: string | null;
    }[] = await this.dataSource.query(
      `SELECT ci.id, ci.registration_identity, ci.subject, ci.party, ci.sender_reference, ci.direction, ci.registered_at,
              (SELECT substr(string_agg(dt.extracted_text, ' '), 1, 1500) FROM captured_document cd
                 JOIN document_text dt ON dt.captured_document_id = cd.id
                WHERE cd.correspondence_item_id = ci.id AND dt.status = 'EXTRACTED') AS text
         FROM correspondence_item ci
        WHERE ci.state = 'REGISTERED' AND ci.id <> $1 AND ci.registered_at > now() - interval '2 years' AND ${pred.sql}
        ORDER BY ci.registered_at DESC LIMIT 1500`,
      [me.id ?? NIL, ...pred.params],
    );
    if (!rows.length || !me.subject.trim()) return [];
    const docs = rows.map((r) => `${r.subject} ${r.text ?? ''}`);
    const idf = idfOf([...docs, `${me.subject} ${me.text}`]);
    const q = vector(`${me.subject} ${me.text.slice(0, 1500)}`, idf);
    const found = rows
      .map((r, i) => {
        const reasons: string[] = [];
        const subj = trigramSimilarity(me.subject, r.subject);
        const textSim = cosine(q, vector(docs[i], idf));
        const sameParty = me.party && r.party ? trigramSimilarity(me.party, r.party) > 0.5 : false;
        const sameRef = Boolean(me.reference && r.sender_reference && me.reference.replace(/\s/g, '').toLowerCase() === r.sender_reference.replace(/\s/g, '').toLowerCase());
        let score = 0.55 * subj + 0.3 * textSim + (sameParty ? 0.15 : 0) + (sameRef ? 0.35 : 0);
        score = Math.min(0.99, score);
        if (subj > 0.35) reasons.push(`onderwerp lijkt ${Math.round(subj * 100)}% op elkaar`);
        if (textSim > 0.3) reasons.push(`tekst komt ${Math.round(textSim * 100)}% overeen`);
        if (sameParty) reasons.push('zelfde afzender');
        if (sameRef) reasons.push('zelfde kenmerk van de afzender');
        return {
          itemId: r.id,
          registrationIdentity: r.registration_identity,
          subject: r.subject,
          party: r.party,
          direction: r.direction,
          registeredAt: r.registered_at,
          score: Math.round(score * 100) / 100,
          reasons,
        };
      })
      .filter((r) => r.score >= 0.42 && r.reasons.length)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    return found;
  }

  async duplicates(actor: Actor, itemId: string) {
    const started = Date.now();
    await this.require('duplicates');
    const { item, profile } = await this.item(actor.accountId, itemId);
    const candidates = await this.nearDuplicates(profile, { id: item.id, subject: item.subject, party: item.party, reference: item.senderReference, text: item.text });
    const output = { candidates };
    const interactionId = await this.record(actor, 'duplicates', { type: 'ITEM', id: item.id }, BUILTIN, `Mogelijke dubbele stukken voor ${item.registrationIdentity ?? 'concept'}`, output, started);
    return { interactionId, engine: BUILTIN, ...output };
  }

  // ------------------------------------------------------------ summaries

  async summariseItem(actor: Actor, itemId: string, language?: 'nl' | 'en') {
    const started = Date.now();
    const cfg = await this.require('summary');
    const { item } = await this.item(actor.accountId, itemId);
    const lang = language ?? 'nl';
    const proposals = await this.intake(item.text || item.subject, item.documentDate ?? item.registeredOn ?? todayInSuriname());
    const sentences = keySentences([{ text: item.text, source: item.registrationIdentity ?? 'concept' }], 4);
    const facts = this.itemFacts(item, proposals, lang);
    const builtin = {
      headline: `${item.registrationIdentity ?? (lang === 'en' ? 'Draft' : 'Concept')}: ${item.subject}`,
      bullets: [...facts, ...sentences.map((s) => `“${excerpt(s.text, 260)}”`)],
      keySentences: sentences,
    };
    const { text, engine } = await this.model(cfg, [item.classification], [
      { role: 'system', content: this.systemPrompt(lang, lang === 'en' ? 'Summarise the letter in at most 5 short bullet points starting with "- ".' : 'Vat de brief samen in hoogstens 5 korte punten die beginnen met "- ".') },
      { role: 'user', content: `${facts.join('\n')}\n\nTekst van de brief:\n${item.text.slice(0, 9000) || '(geen leesbare tekst)'}` },
    ]);
    const output = text ? { ...builtin, bullets: bulletsOf(text), modelText: text } : builtin;
    const interactionId = await this.record(actor, 'summary', { type: 'ITEM', id: item.id }, engine, `Samenvatting van ${builtin.headline}`, output, started);
    return { interactionId, engine, ...output };
  }

  private itemFacts(item: ItemContext, p: IntakeProposals, lang: 'nl' | 'en'): string[] {
    const en = lang === 'en';
    item = { ...item, documentDate: item.documentDate ?? p.documentDate?.value ?? null, senderReference: item.senderReference ?? p.senderReference?.value ?? null };
    const facts: string[] = [];
    const dir = en ? { INCOMING: 'Incoming', OUTGOING: 'Outgoing', INTERNAL: 'Internal' }[item.direction] : { INCOMING: 'Inkomend', OUTGOING: 'Uitgaand', INTERNAL: 'Intern' }[item.direction];
    facts.push(
      en
        ? `${dir} letter${item.party ? ` from ${item.party}` : ''}${item.documentDate ? `, dated ${item.documentDate}` : ''}${item.senderReference ? `, their reference ${item.senderReference}` : ''}.`
        : `${dir} stuk${item.party ? ` van ${item.party}` : ''}${item.documentDate ? `, gedateerd ${longDutchDate(item.documentDate)}` : ''}${item.senderReference ? `, kenmerk afzender ${item.senderReference}` : ''}.`,
    );
    if (p.requests.length) facts.push(en ? `Request: ${excerpt(p.requests[0], 220)}` : `Verzoek: ${excerpt(p.requests[0], 220)}`);
    const deadline = item.replyRequestedBy ?? p.deadlines[0]?.dueDate;
    if (deadline) facts.push(en ? `A response is asked for by ${deadline}.` : `Er wordt een reactie gevraagd vóór ${longDutchDate(deadline)}.`);
    if (!item.text.trim()) facts.push(en ? 'No readable text in the documents; summary based on the registration details.' : 'Geen leesbare tekst in de documenten; samenvatting op basis van de registratiegegevens.');
    return facts;
  }

  async dossierContext(accountId: string, dossierId: string) {
    const profile = await this.access.assertDossier(accountId, dossierId);
    const today = todayInSuriname();
    const [d] = await this.dataSource.query(
      `SELECT d.id, d.dossier_identity, d.subject, d.state, d.processing_state, d.classification,
              to_char(d.due_date, 'YYYY-MM-DD') AS due_date, c.name AS category, u.name AS unit,
              p.full_name AS responsible, ra.responsible_account_id
         FROM dossier d
         LEFT JOIN dossier_category c ON c.id = d.category_id
         LEFT JOIN organisational_unit u ON u.id = d.owning_unit_id
         LEFT JOIN responsibility_assignment ra ON ra.dossier_id = d.id AND ra.superseded_at IS NULL
         LEFT JOIN account a ON a.id = ra.responsible_account_id LEFT JOIN person p ON p.id = a.person_id
        WHERE d.id = $1`,
      [dossierId],
    );
    const ip = this.access.itemPredicate(profile, 'ci', 2);
    const items: { id: string; registration_identity: string | null; subject: string; party: string | null; direction: string; classification: string; registered_on: string | null; text: string | null }[] =
      await this.dataSource.query(
        `SELECT ci.id, ci.registration_identity, ci.subject, ci.party, ci.direction, ci.classification,
                to_char(ci.registered_at AT TIME ZONE 'America/Paramaribo', 'YYYY-MM-DD') AS registered_on,
                (SELECT substr(string_agg(dt.extracted_text, E'\n'), 1, 5000) FROM captured_document cd
                   JOIN document_text dt ON dt.captured_document_id = cd.id
                  WHERE cd.correspondence_item_id = ci.id AND dt.status = 'EXTRACTED') AS text
           FROM dossier_link dl JOIN correspondence_item ci ON ci.id = dl.correspondence_item_id
          WHERE dl.dossier_id = $1 AND ${ip.sql}
          ORDER BY ci.registered_at NULLS LAST`,
        [dossierId, ...ip.params],
      );
    const [tasks] = await this.dataSource.query(
      `SELECT count(*) FILTER (WHERE status IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW'))::int AS open,
              count(*) FILTER (WHERE status IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW') AND due_date < $2::date)::int AS overdue,
              count(*) FILTER (WHERE status = 'COMPLETED')::int AS done
         FROM task WHERE dossier_id = $1 AND archived_at IS NULL`,
      [dossierId, today],
    );
    const events: { event_type: string; name: string; reason: string | null; occurred_on: string }[] = await this.dataSource.query(
      `SELECT we.event_type, p.full_name AS name, we.reason, to_char(we.occurred_at AT TIME ZONE 'America/Paramaribo', 'YYYY-MM-DD') AS occurred_on
         FROM workflow_event we JOIN account a ON a.id = we.actor_account_id JOIN person p ON p.id = a.person_id
        WHERE we.dossier_id = $1 ORDER BY we.occurred_at DESC LIMIT 6`,
      [dossierId],
    );
    const advice: { status: string; question: string; answer: string | null; due: string | null; who: string | null }[] = await this.dataSource.query(
      `SELECT ar.status, ar.question, ar.answer, to_char(ar.due_date, 'YYYY-MM-DD') AS due, coalesce(p.full_name, u.name) AS who
         FROM advice_request ar LEFT JOIN account a ON a.id = ar.requested_from_account_id LEFT JOIN person p ON p.id = a.person_id
         LEFT JOIN organisational_unit u ON u.id = ar.requested_from_unit_id
        WHERE ar.dossier_id = $1 ORDER BY ar.requested_at DESC`,
      [dossierId],
    );
    const workingDaysLeft = d.due_date ? await this.workingDays.workingDaysBetween(today, d.due_date) : null;
    return { profile, dossier: d, items, tasks, events, advice, workingDaysLeft, today };
  }

  async summariseDossier(actor: Actor, dossierId: string, language?: 'nl' | 'en') {
    const started = Date.now();
    const cfg = await this.require('summary');
    const ctx = await this.dossierContext(actor.accountId, dossierId);
    const lang = language ?? 'nl';
    const en = lang === 'en';
    const { dossier: d, items, tasks, events, advice, workingDaysLeft } = ctx;
    const bullets: string[] = [];
    bullets.push(
      en
        ? `${d.dossier_identity}: ${d.subject}.${d.category ? ` Category ${d.category}.` : ''} Status: ${STATE_EN[d.processing_state] ?? d.processing_state}${d.state === 'CLOSED' ? ' (closed)' : ''}.`
        : `${d.dossier_identity}: ${d.subject}.${d.category ? ` Categorie ${d.category}.` : ''} Status: ${STATE_NL[d.processing_state] ?? d.processing_state}${d.state === 'CLOSED' ? ' (gesloten)' : ''}.`,
    );
    const deadline =
      d.due_date === null
        ? en ? 'no deadline set' : 'geen termijn vastgesteld'
        : workingDaysLeft! < 0
          ? en ? `deadline ${d.due_date}, ${-workingDaysLeft!} working days overdue` : `termijn ${longDutchDate(d.due_date)}, ${-workingDaysLeft!} werkdagen over termijn`
          : en ? `deadline ${d.due_date}, ${workingDaysLeft} working days left` : `termijn ${longDutchDate(d.due_date)}, nog ${workingDaysLeft} werkdagen`;
    bullets.push(en ? `Responsible: ${d.responsible ?? 'nobody assigned'}${d.unit ? ` (${d.unit})` : ''}; ${deadline}.` : `Verantwoordelijk: ${d.responsible ?? 'nog niemand'}${d.unit ? ` (${d.unit})` : ''}; ${deadline}.`);
    if (items.length) {
      const incoming = items.filter((i) => i.direction === 'INCOMING').length;
      const outgoing = items.filter((i) => i.direction === 'OUTGOING').length;
      const last = items[items.length - 1];
      bullets.push(
        en
          ? `${items.length} record${items.length === 1 ? '' : 's'} (${incoming} incoming, ${outgoing} outgoing); latest: "${excerpt(last.subject, 90)}"${last.party ? ` from ${last.party}` : ''}${last.registered_on ? ` (${last.registered_on})` : ''}.`
          : `${items.length} stuk${items.length === 1 ? '' : 'ken'} (${incoming} inkomend, ${outgoing} uitgaand); laatste: "${excerpt(last.subject, 90)}"${last.party ? ` van ${last.party}` : ''}${last.registered_on ? ` (${last.registered_on})` : ''}.`,
      );
    } else bullets.push(en ? 'No records linked yet.' : 'Er zijn nog geen stukken gekoppeld.');
    if (tasks.open || tasks.done) {
      bullets.push(en ? `Tasks: ${tasks.open} open${tasks.overdue ? ` (${tasks.overdue} overdue)` : ''}, ${tasks.done} done.` : `Taken: ${tasks.open} open${tasks.overdue ? ` (${tasks.overdue} te laat)` : ''}, ${tasks.done} afgerond.`);
    }
    const openAdvice = advice.filter((a) => a.status === 'OPEN');
    const answered = advice.find((a) => a.status === 'ANSWERED' && a.answer);
    if (advice.length) {
      bullets.push(
        en
          ? `Advice: ${openAdvice.length} open${answered ? `; ${answered.who} advised: "${excerpt(answered.answer!, 140)}"` : ''}.`
          : `Advies: ${openAdvice.length} openstaand${answered ? `; ${answered.who} adviseerde: "${excerpt(answered.answer!, 140)}"` : ''}.`,
      );
    }
    if (events.length) {
      const e = events[0];
      bullets.push(
        en
          ? `Last step: ${e.event_type.toLowerCase().replace(/_/g, ' ')} by ${e.name} on ${e.occurred_on}${e.reason ? ` — "${excerpt(e.reason, 120)}"` : ''}.`
          : `Laatste stap: ${EVENT_NL[e.event_type] ?? e.event_type.toLowerCase()} door ${e.name} op ${e.occurred_on}${e.reason ? ` — "${excerpt(e.reason, 120)}"` : ''}.`,
      );
    }
    const sentences: KeySentence[] = keySentences(
      items.filter((i) => i.text).map((i) => ({ text: i.text as string, source: i.registration_identity ?? i.subject })),
      4,
    );
    const builtin = { headline: `${d.dossier_identity}: ${d.subject}`, bullets, keySentences: sentences };
    const levels = [d.classification, ...items.map((i) => i.classification)];
    const material = items.map((i) => `--- ${i.registration_identity ?? 'concept'} · ${i.direction} · ${i.party ?? ''} · ${i.subject}\n${(i.text ?? '').slice(0, 2500)}`).join('\n');
    const { text, engine } = await this.model(cfg, levels, [
      { role: 'system', content: this.systemPrompt(lang, en ? 'Summarise the matter for a busy decision-maker in at most 6 bullet points starting with "- ": what it is about, what is asked, where it stands, what is needed next.' : 'Vat de zaak samen voor een drukke beslisser in hoogstens 6 punten die beginnen met "- ": waar het over gaat, wat er gevraagd wordt, hoe het ervoor staat, wat er nu nodig is.') },
      { role: 'user', content: `${bullets.join('\n')}\n\nStukken:\n${material.slice(0, 12_000) || '(geen)'}` },
    ]);
    const output = text ? { ...builtin, bullets: bulletsOf(text), facts: bullets, modelText: text } : builtin;
    const interactionId = await this.record(actor, 'summary', { type: 'DOSSIER', id: dossierId }, engine, `Samenvatting van ${builtin.headline}`, output, started);
    return { interactionId, engine, ...output };
  }

  // ------------------------------------------------------------ draft reply

  async draftReply(actor: Actor, itemId: string, options: { tone?: 'formal' | 'short'; language?: 'nl' | 'en' } = {}) {
    const started = Date.now();
    const cfg = await this.require('draftReply');
    const { item } = await this.item(actor.accountId, itemId);
    if (item.direction !== 'INCOMING') throw new BadRequestException('A reply can be drafted for an incoming letter only.');
    const lang = options.language ?? (item.text ? detectLanguage(item.text) : 'nl');
    const proposals = await this.intake(item.text || item.subject, item.documentDate ?? item.registeredOn ?? todayInSuriname());
    const branding = await this.settings.get('branding');
    const builtinBody = composeReply(item, proposals, branding.signatoryTitle, lang, options.tone ?? 'formal');
    const facts = this.itemFacts(item, proposals, lang).join('\n');
    const { text, engine } = await this.model(cfg, [item.classification], [
      {
        role: 'system',
        content: this.systemPrompt(
          lang,
          lang === 'en'
            ? `Write the body of a reply letter (no letterhead or address). Begin with "Dear Sir or Madam," and end with "Yours faithfully," followed by "${branding.signatoryTitle}". Where a decision or information is needed that is not given, write a placeholder in square brackets, for example [state the decision]. ${options.tone === 'short' ? 'Keep it to three short paragraphs.' : ''}`
            : `Schrijf de tekst van een antwoordbrief (zonder briefhoofd en adres). Begin met "Geachte heer/mevrouw," en eindig met "Hoogachtend," met daaronder "${branding.signatoryTitle}". Waar een besluit of informatie nodig is die niet gegeven is, schrijf je een invulplek tussen vierkante haken, bijvoorbeeld [besluit invullen]. ${options.tone === 'short' ? 'Houd het bij drie korte alinea’s.' : ''}`,
        ),
      },
      { role: 'user', content: `${facts}\nRegistratienummer: ${item.registrationIdentity ?? '—'}\n\nOntvangen brief:\n${item.text.slice(0, 8000) || item.subject}` },
    ], 900);
    const body = text ?? builtinBody;
    const output = { body, language: lang, placeholders: (body.match(/\[[^\]]+\]/g) ?? []).length };
    const interactionId = await this.record(actor, 'draftReply', { type: 'ITEM', id: item.id }, engine, `Conceptantwoord op ${item.registrationIdentity ?? 'concept'}: ${item.subject}`, output, started);
    return { interactionId, engine, ...output };
  }

  // ------------------------------------------------------------ translate

  async translate(actor: Actor, input: { text: string; to: 'nl' | 'en'; itemId?: string }) {
    const started = Date.now();
    const cfg = await this.require('translate');
    if (cfg.provider === 'builtin') {
      throw new BadRequestException('Translation needs a language model. The administrator can connect a free open-source model (Ollama) under Administration → Assistant.');
    }
    let text = input.text ?? '';
    let levels: string[] = ['INTERNAL'];
    let subject: { type: string; id: string } | null = null;
    if (input.itemId) {
      const { item } = await this.item(actor.accountId, input.itemId);
      text = text || item.text;
      levels = [item.classification];
      subject = { type: 'ITEM', id: item.id };
    }
    if (!text.trim()) throw new BadRequestException('There is no text to translate.');
    const target = input.to === 'en' ? 'English' : 'Dutch (as used in Suriname)';
    const result = await this.model(cfg, levels, [
      { role: 'system', content: `Translate the user's text into ${target}. Keep names, numbers, dates and references exactly as they are. Output only the translation.` },
      { role: 'user', content: text.slice(0, 12_000) },
    ], 2000);
    if (!result.text) throw new BadRequestException(result.engine.fallback ?? 'The language model gave no translation.');
    const output = { translation: result.text, to: input.to };
    const interactionId = await this.record(actor, 'translate', subject, result.engine, `Vertaling naar ${input.to} (${text.length} tekens)`, output, started);
    return { interactionId, engine: result.engine, ...output };
  }

  // ------------------------------------------------------------ risk

  /**
   * Which matters are at risk of missing their deadline, and why. Decision-
   * makers may look across everything they may see; others see their own.
   */
  async risk(actor: Actor, scope: 'mine' | 'all' = 'mine') {
    const started = Date.now();
    await this.require('risk');
    const profile = await this.access.profile(actor.accountId);
    const manager = profile.roles.some((r) => MANAGEMENT_ROLES.includes(r));
    const all = scope === 'all' && manager;
    const today = todayInSuriname();
    const dp = this.access.dossierPredicate(profile, 'd', 3);
    const rows: {
      id: string;
      dossier_identity: string;
      subject: string;
      processing_state: string;
      due_date: string | null;
      responsible: string | null;
      last_activity: string;
      advice_open: number;
      advice_late: number;
      tasks_late: number;
      tasks_open: number;
      route_waiting_days: number | null;
    }[] = await this.dataSource.query(
      `SELECT d.id, d.dossier_identity, d.subject, d.processing_state, to_char(d.due_date, 'YYYY-MM-DD') AS due_date,
              p.full_name AS responsible,
              to_char(GREATEST(d.created_at,
                coalesce((SELECT max(we.occurred_at) FROM workflow_event we WHERE we.dossier_id = d.id), d.created_at),
                coalesce((SELECT max(dl.linked_at) FROM dossier_link dl WHERE dl.dossier_id = d.id), d.created_at),
                coalesce((SELECT max(te.occurred_at) FROM task_event te JOIN task t ON t.id = te.task_id WHERE t.dossier_id = d.id), d.created_at),
                coalesce((SELECT max(rs.occurred_at) FROM route_step_decision rs WHERE rs.dossier_id = d.id), d.created_at)
              ) AT TIME ZONE 'America/Paramaribo', 'YYYY-MM-DD') AS last_activity,
              (SELECT count(*)::int FROM advice_request ar WHERE ar.dossier_id = d.id AND ar.status = 'OPEN') AS advice_open,
              (SELECT count(*)::int FROM advice_request ar WHERE ar.dossier_id = d.id AND ar.status = 'OPEN' AND ar.due_date < $1::date) AS advice_late,
              (SELECT count(*)::int FROM task t WHERE t.dossier_id = d.id AND t.archived_at IS NULL AND t.status IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW') AND t.due_date < $1::date) AS tasks_late,
              (SELECT count(*)::int FROM task t WHERE t.dossier_id = d.id AND t.archived_at IS NULL AND t.status IN ('OPEN','ACCEPTED','IN_PROGRESS','WAITING','IN_REVIEW')) AS tasks_open,
              (SELECT ($1::date - (coalesce((SELECT max(rs.occurred_at) FROM route_step_decision rs WHERE rs.dossier_route_id = dr.id), dr.started_at) AT TIME ZONE 'America/Paramaribo')::date)
                 FROM dossier_route dr WHERE dr.dossier_id = d.id AND dr.completed_at IS NULL AND dr.ended_reason IS NULL LIMIT 1) AS route_waiting_days
         FROM dossier d
         LEFT JOIN responsibility_assignment ra ON ra.dossier_id = d.id AND ra.superseded_at IS NULL
         LEFT JOIN account a ON a.id = ra.responsible_account_id LEFT JOIN person p ON p.id = a.person_id
        WHERE d.state <> 'CLOSED' AND d.processing_state <> 'FINALISED' AND ${dp.sql}
          AND (${all ? 'true' : 'false'} OR ra.responsible_account_id = $2 OR d.created_by_account_id = $2
               OR EXISTS (SELECT 1 FROM task t WHERE t.dossier_id = d.id AND t.assignee_account_id = $2))
        ORDER BY d.due_date NULLS LAST LIMIT 400`,
      [today, actor.accountId, ...dp.params],
    );
    const dossiers = [];
    for (const r of rows) {
      const reasons: string[] = [];
      let score = 0;
      let wdLeft: number | null = null;
      if (r.due_date) {
        wdLeft = await this.workingDays.workingDaysBetween(today, r.due_date);
        if (wdLeft < 0) {
          score = 100;
          reasons.push(`${-wdLeft} werkdag${wdLeft === -1 ? '' : 'en'} over termijn`);
        } else if (wdLeft <= 2) {
          score += 50;
          reasons.push(wdLeft === 0 ? 'termijn verloopt vandaag' : `nog ${wdLeft} werkdag${wdLeft === 1 ? '' : 'en'}`);
        } else if (wdLeft <= 5) {
          score += 30;
          reasons.push(`nog ${wdLeft} werkdagen`);
        } else if (wdLeft <= 10) {
          score += 10;
        }
        if (wdLeft >= 0 && wdLeft <= 5 && ['ACTIVE', 'RETURNED'].includes(r.processing_state)) {
          score += 15;
          reasons.push(r.processing_state === 'RETURNED' ? 'teruggestuurd en nog niet opnieuw ingediend' : 'nog niet ter beoordeling aangeboden');
        }
      } else {
        score += 5;
        reasons.push('geen termijn vastgesteld');
      }
      const idle = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${r.last_activity}T12:00:00Z`)) / 86400000);
      if (idle >= 10) {
        score += idle >= 20 ? 20 : 12;
        reasons.push(`${idle} dagen geen activiteit`);
      }
      if (r.advice_late) {
        score += 20;
        reasons.push(`${r.advice_late} adviesaanvra${r.advice_late === 1 ? 'ag' : 'gen'} over termijn`);
      } else if (r.advice_open && wdLeft !== null && wdLeft <= 5) {
        score += 10;
        reasons.push('advies nog niet ontvangen');
      }
      if (r.tasks_late) {
        score += Math.min(30, 15 * r.tasks_late);
        reasons.push(`${r.tasks_late} ta${r.tasks_late === 1 ? 'ak' : 'ken'} te laat`);
      }
      if (!r.responsible) {
        score += 10;
        reasons.push('geen verantwoordelijke');
      }
      if (r.route_waiting_days !== null && r.route_waiting_days >= 5) {
        score += 10;
        reasons.push(`goedkeuringsstap wacht ${r.route_waiting_days} dagen`);
      }
      score = wdLeft !== null && wdLeft < 0 ? 100 : Math.min(99, score);
      const level = score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';
      dossiers.push({
        dossierId: r.id,
        dossierIdentity: r.dossier_identity,
        subject: r.subject,
        dueDate: r.due_date,
        workingDaysLeft: wdLeft,
        responsible: r.responsible,
        processingState: r.processing_state,
        score,
        level,
        reasons,
        openTasks: r.tasks_open,
      });
    }
    dossiers.sort((a, b) => b.score - a.score || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
    // Letters with a requested reply date and no reply yet.
    const ip = this.access.itemPredicate(profile, 'ci', 3);
    const letterRows: { id: string; registration_identity: string; subject: string; party: string | null; reply_requested_by: string }[] = await this.dataSource.query(
      `SELECT ci.id, ci.registration_identity, ci.subject, ci.party, to_char(ci.reply_requested_by, 'YYYY-MM-DD') AS reply_requested_by
         FROM correspondence_item ci
        WHERE ci.state = 'REGISTERED' AND ci.direction = 'INCOMING' AND ci.reply_requested_by IS NOT NULL
          AND ci.reply_requested_by <= ($1::date + 10)
          AND NOT EXISTS (SELECT 1 FROM correspondence_item r WHERE r.in_reply_to_item_id = ci.id AND r.state = 'REGISTERED')
          AND (${all ? 'true' : 'false'} OR ci.created_by_account_id = $2
               OR EXISTS (SELECT 1 FROM dossier_link dl JOIN responsibility_assignment ra ON ra.dossier_id = dl.dossier_id AND ra.superseded_at IS NULL
                           WHERE dl.correspondence_item_id = ci.id AND ra.responsible_account_id = $2))
          AND ${ip.sql}
        ORDER BY ci.reply_requested_by LIMIT 50`,
      [today, actor.accountId, ...ip.params],
    );
    const letters = [];
    for (const l of letterRows) {
      const wd = await this.workingDays.workingDaysBetween(today, l.reply_requested_by);
      letters.push({
        itemId: l.id,
        registrationIdentity: l.registration_identity,
        subject: l.subject,
        party: l.party,
        replyRequestedBy: l.reply_requested_by,
        workingDaysLeft: wd,
        level: wd < 0 ? 'HIGH' : wd <= 3 ? 'HIGH' : 'MEDIUM',
        reasons: [wd < 0 ? `antwoord ${-wd} werkdagen te laat` : `antwoord gevraagd binnen ${wd} werkdag${wd === 1 ? '' : 'en'}`],
      });
    }
    const counts = {
      high: dossiers.filter((d) => d.level === 'HIGH').length,
      medium: dossiers.filter((d) => d.level === 'MEDIUM').length,
      low: dossiers.filter((d) => d.level === 'LOW').length,
      letters: letters.length,
    };
    const output = { scope: all ? 'all' : 'mine', generatedOn: today, counts, dossiers: dossiers.slice(0, 50), letters };
    const interactionId = await this.record(actor, 'risk', null, BUILTIN, `Termijnrisico (${all ? 'alles' : 'eigen werk'}): ${counts.high} hoog, ${counts.medium} middel`, { counts, top: dossiers.slice(0, 10).map((d) => d.dossierIdentity) }, started);
    return { interactionId, engine: BUILTIN, ...output };
  }

  // ------------------------------------------------------------ meeting notes

  async meetingNotes(actor: Actor, input: { text: string; dossierId?: string | null }) {
    const started = Date.now();
    await this.require('meetingNotes');
    if (!input.text?.trim()) throw new BadRequestException('Paste the meeting notes.');
    if (input.dossierId) await this.access.assertDossier(actor.accountId, input.dossierId);
    const people = await this.people();
    const me = { accountId: actor.accountId, name: await this.nameOf(actor.accountId) };
    const proposals: ActionProposal[] = proposeActions(input.text.slice(0, 30_000), people, me, todayInSuriname());
    const output = { proposals, dossierId: input.dossierId ?? null };
    const interactionId = await this.record(
      actor,
      'meetingNotes',
      input.dossierId ? { type: 'DOSSIER', id: input.dossierId } : null,
      BUILTIN,
      `Actiepunten uit notulen (${input.text.split('\n').length} regels): ${proposals.length} voorstellen`,
      output,
      started,
    );
    return { interactionId, engine: BUILTIN, ...output };
  }

  // ------------------------------------------------------------ ask

  async ask(actor: Actor, question: string, language: 'nl' | 'en' = 'nl') {
    const started = Date.now();
    await this.require('ask');
    if (!question?.trim()) throw new BadRequestException('Ask a question.');
    const result = await this.answerQuestion(actor, question.slice(0, 500), language);
    const interactionId = await this.record(actor, 'ask', null, BUILTIN, `Vraag: ${question}`, { query: result.query, count: result.count, ids: result.rows.map((r) => r.id) }, started);
    return { interactionId, engine: BUILTIN, ...result };
  }

  async answerQuestion(actor: Actor, question: string, language: 'nl' | 'en') {
    const today = todayInSuriname();
    const q = parseQuestion(question, today, language);
    const profile = await this.access.profile(actor.accountId);
    let rows: { type: string; id: string; identity: string | null; title: string; meta: string; date: string | null; link: string }[] = [];
    let count = 0;
    if (q.entity === 'TASK') {
      const result = await this.tasks.list(actor.accountId, {
        scope: q.mine ? 'my' : 'all',
        status: q.status === 'DONE' ? 'COMPLETED' : q.status === 'REVIEW' ? 'IN_REVIEW' : undefined,
        includeClosed: q.status === 'DONE' ? undefined : false,
        priority: q.priority ?? undefined,
        q: q.about ?? undefined,
        due: q.overdue ? 'overdue' : q.dueSoon ? 'week' : undefined,
        from: q.from ?? undefined,
        to: q.to ?? undefined,
        limit: 20,
      });
      count = result.total;
      rows = result.data.map((t) => ({
        type: 'TASK',
        id: t.id,
        identity: t.reference,
        title: t.title,
        meta: `${t.assignee.name}${t.dueDate ? ` · ${t.dueDate}` : ''}${t.overdue ? ' · te laat' : ''}`,
        date: t.dueDate,
        link: `/taken/${t.id}`,
      }));
    } else if (q.entity === 'ITEM') {
      const r = await this.askItems(profile, q, today);
      count = r.count;
      rows = r.rows;
    } else {
      const r = await this.askDossiers(profile, q, today);
      count = r.count;
      rows = r.rows;
    }
    const en = language === 'en';
    const what = q.understood.join(', ');
    const answer = en
      ? count === 0
        ? `I found nothing for: ${what}.`
        : q.count
          ? `There ${count === 1 ? 'is' : 'are'} ${count} — ${what}.`
          : `${count} found — ${what}.${count > rows.length ? ` The first ${rows.length} are shown.` : ''}`
      : count === 0
        ? `Ik heb niets gevonden voor: ${what}.`
        : q.count
          ? `Het zijn er ${count} — ${what}.`
          : `${count} gevonden — ${what}.${count > rows.length ? ` De eerste ${rows.length} staan hieronder.` : ''}`;
    return { query: q, understood: q.understood, answer, count, rows };
  }

  private async askItems(profile: AccessProfile, q: AskQuery, today: string) {
    const params: unknown[] = [];
    const where: string[] = [];
    const ip = this.access.itemPredicate(profile, 'ci', 1);
    params.push(...ip.params);
    where.push(ip.sql);
    where.push(`ci.state IN ('DRAFT','REGISTERED')`);
    const date = `(coalesce(ci.registered_at, ci.created_at) AT TIME ZONE 'America/Paramaribo')::date`;
    if (q.direction) {
      params.push(q.direction);
      where.push(`ci.direction = $${params.length}`);
    }
    if (q.from) {
      params.push(q.from);
      where.push(`${date} >= $${params.length}::date`);
    }
    if (q.to) {
      params.push(q.to);
      where.push(`${date} <= $${params.length}::date`);
    }
    if (q.party) {
      params.push(`%${q.party}%`);
      where.push(`ci.party ILIKE $${params.length}`);
    }
    if (q.about) {
      params.push(q.about);
      where.push(`(to_tsvector('dutch', coalesce(ci.subject,'') || ' ' || coalesce(ci.party,'')) @@ websearch_to_tsquery('dutch', $${params.length})
                    OR ci.subject ILIKE '%' || $${params.length} || '%'
                    OR EXISTS (SELECT 1 FROM captured_document cd JOIN document_text dt ON dt.captured_document_id = cd.id
                                WHERE cd.correspondence_item_id = ci.id AND to_tsvector('dutch', coalesce(dt.extracted_text,'')) @@ websearch_to_tsquery('dutch', $${params.length})))`);
    }
    if (q.classification) {
      params.push(q.classification);
      where.push(`ci.classification = $${params.length}`);
    }
    if (q.mine) {
      params.push(profile.accountId);
      where.push(`(ci.created_by_account_id = $${params.length} OR EXISTS (SELECT 1 FROM dossier_link dl JOIN responsibility_assignment ra ON ra.dossier_id = dl.dossier_id AND ra.superseded_at IS NULL WHERE dl.correspondence_item_id = ci.id AND ra.responsible_account_id = $${params.length}))`);
    }
    if (q.overdue || q.dueSoon) {
      params.push(today);
      where.push(q.overdue ? `ci.reply_requested_by < $${params.length}::date` : `ci.reply_requested_by BETWEEN $${params.length}::date AND $${params.length}::date + 7`);
      where.push(`NOT EXISTS (SELECT 1 FROM correspondence_item r WHERE r.in_reply_to_item_id = ci.id AND r.state = 'REGISTERED')`);
    }
    const sql = where.join(' AND ');
    const [{ n }] = await this.dataSource.query(`SELECT count(*)::int AS n FROM correspondence_item ci WHERE ${sql}`, params);
    const list: { id: string; registration_identity: string | null; subject: string; party: string | null; direction: string; state: string; d: string }[] = await this.dataSource.query(
      `SELECT ci.id, ci.registration_identity, ci.subject, ci.party, ci.direction, ci.state, to_char(${date}, 'YYYY-MM-DD') AS d
         FROM correspondence_item ci WHERE ${sql} ORDER BY coalesce(ci.registered_at, ci.created_at) DESC LIMIT 20`,
      params,
    );
    void today;
    return {
      count: n as number,
      rows: list.map((r) => ({
        type: 'ITEM',
        id: r.id,
        identity: r.registration_identity,
        title: r.subject,
        meta: `${r.party ?? '—'} · ${r.state === 'DRAFT' ? 'concept' : r.direction.toLowerCase()}`,
        date: r.d,
        link: `/post/${r.id}`,
      })),
    };
  }

  private async askDossiers(profile: AccessProfile, q: AskQuery, today: string) {
    const params: unknown[] = [];
    const where: string[] = [];
    const dp = this.access.dossierPredicate(profile, 'd', 1);
    params.push(...dp.params);
    where.push(dp.sql);
    if (q.status === 'DONE') where.push(`(d.processing_state = 'FINALISED' OR d.state = 'CLOSED')`);
    else if (q.status === 'REVIEW') where.push(`d.processing_state = 'UNDER_REVIEW'`);
    else where.push(`d.state <> 'CLOSED' AND d.processing_state <> 'FINALISED'`);
    if (q.overdue) {
      params.push(today);
      where.push(`d.due_date < $${params.length}::date`);
    } else if (q.dueSoon) {
      params.push(today);
      where.push(`d.due_date BETWEEN $${params.length}::date AND $${params.length}::date + 7`);
    }
    if (q.from) {
      params.push(q.from);
      where.push(`(d.created_at AT TIME ZONE 'America/Paramaribo')::date >= $${params.length}::date`);
    }
    if (q.to) {
      params.push(q.to);
      where.push(`(d.created_at AT TIME ZONE 'America/Paramaribo')::date <= $${params.length}::date`);
    }
    if (q.about) {
      params.push(q.about);
      where.push(`(to_tsvector('dutch', coalesce(d.subject,'')) @@ websearch_to_tsquery('dutch', $${params.length}) OR d.subject ILIKE '%' || $${params.length} || '%')`);
    }
    if (q.party) {
      params.push(`%${q.party}%`);
      where.push(`EXISTS (SELECT 1 FROM dossier_link dl JOIN correspondence_item ci ON ci.id = dl.correspondence_item_id WHERE dl.dossier_id = d.id AND ci.party ILIKE $${params.length})`);
    }
    if (q.classification) {
      params.push(q.classification);
      where.push(`d.classification = $${params.length}`);
    }
    if (q.mine) {
      params.push(profile.accountId);
      where.push(`(d.created_by_account_id = $${params.length} OR EXISTS (SELECT 1 FROM responsibility_assignment ra WHERE ra.dossier_id = d.id AND ra.superseded_at IS NULL AND ra.responsible_account_id = $${params.length}))`);
    }
    const sql = where.join(' AND ');
    const [{ n }] = await this.dataSource.query(`SELECT count(*)::int AS n FROM dossier d WHERE ${sql}`, params);
    const list: { id: string; dossier_identity: string; subject: string; processing_state: string; due: string | null; responsible: string | null }[] = await this.dataSource.query(
      `SELECT d.id, d.dossier_identity, d.subject, d.processing_state, to_char(d.due_date, 'YYYY-MM-DD') AS due, p.full_name AS responsible
         FROM dossier d
         LEFT JOIN responsibility_assignment ra ON ra.dossier_id = d.id AND ra.superseded_at IS NULL
         LEFT JOIN account a ON a.id = ra.responsible_account_id LEFT JOIN person p ON p.id = a.person_id
        WHERE ${sql} ORDER BY d.due_date NULLS LAST, d.created_at DESC LIMIT 20`,
      params,
    );
    return {
      count: n as number,
      rows: list.map((r) => ({
        type: 'DOSSIER',
        id: r.id,
        identity: r.dossier_identity,
        title: r.subject,
        meta: `${STATE_NL[r.processing_state] ?? r.processing_state}${r.responsible ? ` · ${r.responsible}` : ''}`,
        date: r.due,
        link: `/zaken/${r.id}`,
      })),
    };
  }

  // ------------------------------------------------------------ feedback

  /**
   * A person's verdict on a suggestion. ACCEPTED and EDITED may carry what to
   * apply — the draft text to save, the tasks to create — and that is done in
   * the person's own name, with the ordinary checks.
   */
  async feedback(
    actor: Actor,
    interactionId: string,
    input: {
      outcome: 'ACCEPTED' | 'EDITED' | 'REJECTED';
      note?: string;
      apply?: {
        targetItemId?: string;
        body?: string;
        tasks?: { title: string; assigneeAccountId: string; dueDate?: string | null; priority?: string; dossierId?: string | null; description?: string }[];
      };
    },
  ) {
    if (!isUuid(interactionId)) throw new NotFoundException('Unknown suggestion.');
    const [interaction] = await this.dataSource.query(
      `SELECT id, feature, account_id, subject_type, subject_id, output, prompt_summary FROM ai_interaction WHERE id = $1`,
      [interactionId],
    );
    if (!interaction || interaction.account_id !== actor.accountId) throw new NotFoundException('Unknown suggestion.');
    const [existing] = await this.dataSource.query(`SELECT outcome FROM ai_feedback WHERE interaction_id = $1 AND account_id = $2`, [interactionId, actor.accountId]);
    if (existing) throw new ConflictException(`This suggestion was already marked ${existing.outcome.toLowerCase()}.`);
    if (!['ACCEPTED', 'EDITED', 'REJECTED'].includes(input.outcome)) throw new BadRequestException('Unknown outcome.');
    const applied: Record<string, unknown> = {};
    if (input.outcome !== 'REJECTED' && input.apply) {
      if (interaction.feature === 'draftReply' && input.apply.targetItemId) {
        const body = (input.apply.body ?? interaction.output.body ?? '').trim();
        if (!body) throw new BadRequestException('There is no text to save.');
        await this.access.assertItem(actor.accountId, input.apply.targetItemId);
        const [target] = await this.dataSource.query(`SELECT direction, state, in_reply_to_item_id FROM correspondence_item WHERE id = $1`, [input.apply.targetItemId]);
        if (target.direction !== 'OUTGOING' || target.state !== 'DRAFT') throw new BadRequestException('The reply text can be saved only to an outgoing draft.');
        applied.draftVersion = await this.letters.saveVersion(actor, input.apply.targetItemId, {
          body,
          note: input.outcome === 'EDITED' ? 'Opgesteld met de assistent, aangepast' : 'Opgesteld met de assistent',
          aiInteractionId: interactionId,
        });
      }
      if (['meetingNotes', 'chat'].includes(interaction.feature) && input.apply.tasks?.length) {
        if (input.apply.tasks.length > 40) throw new BadRequestException('Too many tasks at once.');
        const created = [];
        for (const t of input.apply.tasks) {
          created.push(
            await this.tasks.create(actor, {
              title: t.title,
              description: t.description,
              assigneeAccountId: t.assigneeAccountId,
              dueDate: t.dueDate ?? null,
              priority: t.priority,
              dossierId: t.dossierId ?? null,
              source: interaction.feature === 'chat' ? 'CHAT' : 'MEETING_NOTES',
            }),
          );
        }
        applied.tasks = created.map((t) => ({ id: t.id, reference: t.reference, title: t.title }));
      }
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`INSERT INTO ai_feedback (interaction_id, account_id, outcome, note) VALUES ($1, $2, $3, $4)`, [
        interactionId,
        actor.accountId,
        input.outcome,
        input.note?.slice(0, 600) ?? null,
      ]);
      await this.audit.recordInTransaction(manager, {
        eventType: input.outcome === 'REJECTED' ? AuditEventType.AI_SUGGESTION_REJECTED : AuditEventType.AI_SUGGESTION_ACCEPTED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        representedAuthority: actor.representedAuthority ?? null,
        subjectDescription: `${interaction.feature}: ${interaction.prompt_summary}`.slice(0, 260),
        newValue: input.outcome,
        summary: `${actor.description} ${input.outcome === 'REJECTED' ? 'rejected' : input.outcome === 'EDITED' ? 'accepted with changes' : 'accepted'} an assistant suggestion (${interaction.feature})${applied.tasks ? `, creating ${(applied.tasks as unknown[]).length} task(s)` : ''}${applied.draftVersion ? ', saving it as a draft version' : ''}.`.slice(0, 600),
      });
    });
    return { outcome: input.outcome, applied };
  }

  // ------------------------------------------------------------ overview

  async status(accountId: string) {
    const cfg = await this.config();
    const profile = await this.access.profile(accountId);
    return {
      provider: cfg.provider,
      model: cfg.provider === 'builtin' ? BUILTIN_MODEL : cfg.model,
      local: cfg.provider === 'builtin' || isLocalAddress(cfg.baseUrl),
      free: cfg.provider !== 'anthropic',
      features: cfg.features,
      canSeeEverything: profile.roles.some((r) => MANAGEMENT_ROLES.includes(r)),
    };
  }

  async history(accountId: string, limit = 30) {
    return this.dataSource.query(
      `SELECT i.id, i.feature, i.subject_type AS "subjectType", i.subject_id AS "subjectId", i.provider, i.model,
              i.prompt_summary AS "summary", i.latency_ms AS "latencyMs", i.created_at AS "createdAt", f.outcome
         FROM ai_interaction i LEFT JOIN ai_feedback f ON f.interaction_id = i.id
        WHERE i.account_id = $1 ORDER BY i.created_at DESC LIMIT $2`,
      [accountId, Math.min(Math.max(limit, 1), 200)],
    );
  }

  /** How the assistant is used and how often its suggestions are taken: counts only, no content. */
  async usage(days = 30) {
    const rows: { feature: string; total: number; accepted: number; edited: number; rejected: number; avg_ms: number }[] = await this.dataSource.query(
      `SELECT i.feature, count(*)::int AS total,
              count(*) FILTER (WHERE f.outcome = 'ACCEPTED')::int AS accepted,
              count(*) FILTER (WHERE f.outcome = 'EDITED')::int AS edited,
              count(*) FILTER (WHERE f.outcome = 'REJECTED')::int AS rejected,
              coalesce(round(avg(i.latency_ms)), 0)::int AS avg_ms
         FROM ai_interaction i LEFT JOIN ai_feedback f ON f.interaction_id = i.id
        WHERE i.created_at > now() - make_interval(days => $1)
        GROUP BY i.feature ORDER BY total DESC`,
      [days],
    );
    const [users] = await this.dataSource.query(
      `SELECT count(DISTINCT account_id)::int AS n FROM ai_interaction WHERE created_at > now() - make_interval(days => $1)`,
      [days],
    );
    return {
      days,
      people: users.n,
      features: rows.map((r) => {
        const judged = r.accepted + r.edited + r.rejected;
        return { ...r, avgMs: r.avg_ms, acceptanceRate: judged ? Math.round(((r.accepted + r.edited) / judged) * 100) : null };
      }),
    };
  }
}

function bulletsOf(text: string): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 3);
  return lines.slice(0, 8);
}

/**
 * A reply in the ministry's usual form. The parts only a person can supply —
 * the decision, the substance — are left as [placeholders], never invented.
 */
export function composeReply(item: ItemContext, p: IntakeProposals, signatory: string, lang: 'nl' | 'en', tone: 'formal' | 'short'): string {
  const received = item.documentDate ?? p.documentDate?.value ?? item.registeredOn;
  const reference = item.senderReference ?? p.senderReference?.value ?? null;
  const request = p.requests[0];
  if (lang === 'en') {
    const lines = ['Dear Sir or Madam,', ''];
    lines.push(
      `We acknowledge receipt of your letter${received ? ` of ${received}` : ''}${reference ? ` (your reference ${reference})` : ''} concerning "${item.subject}". It has been registered under number ${item.registrationIdentity ?? '[registration number]'}.`,
    );
    lines.push('');
    if (request) {
      lines.push(`In your letter you ${/request|ask/i.test(request) ? 'request' : 'raise'} the following: “${excerpt(request, 260)}”`);
      lines.push('');
    }
    lines.push('[State the decision or the substantive answer here.]');
    if (tone === 'formal') {
      lines.push('');
      lines.push('[Add any conditions, next steps or the documents still required.]');
      lines.push('');
      lines.push('Should you have any questions, please quote the registration number above in your correspondence.');
    }
    lines.push('', 'Yours faithfully,', '', signatory);
    return lines.join('\n');
  }
  const lines = ['Geachte heer/mevrouw,', ''];
  lines.push(
    `Wij bevestigen de ontvangst van uw brief${received ? ` van ${longDutchDate(received)}` : ''}${reference ? ` met kenmerk ${reference}` : ''} inzake "${item.subject}". Uw brief is bij ons geregistreerd onder nummer ${item.registrationIdentity ?? '[registratienummer]'}.`,
  );
  lines.push('');
  if (request) {
    lines.push(`In uw brief ${/verzoek|vraag|vraagt|verzoekt/i.test(request) ? 'verzoekt u' : 'brengt u het volgende naar voren'}: “${excerpt(request, 260)}”`);
    lines.push('');
  }
  lines.push('[Vermeld hier het besluit of het inhoudelijke antwoord.]');
  if (tone === 'formal') {
    lines.push('');
    lines.push('[Vermeld eventuele voorwaarden, vervolgstappen of nog benodigde stukken.]');
    lines.push('');
    lines.push('Mocht u nog vragen hebben, dan verzoeken wij u bij correspondentie het bovenvermelde registratienummer te vermelden.');
  }
  lines.push('', 'Hoogachtend,', '', signatory);
  return lines.join('\n');
}

export { addDays };
