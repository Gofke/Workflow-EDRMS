import { isLocalAddress } from '../ai/llm';
import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditEventType } from '../audit/audit-event.entity';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../records/registration.service';
import { PUBLIC_SETTING_KEYS, SETTING_DEFAULTS, SettingKey, Settings } from './settings.defaults';

const KNOWN_ROLES = [
  'MINISTER',
  'DIRECTEUR',
  'ONDER_DIRECTEUR',
  'SUPPORT_STAFF',
  'SYS_ADMIN',
  'AUDITOR',
  'RECORDS_MANAGER',
];
const LEVELS = ['OPEN', 'INTERNAL', 'CONFIDENTIAL', 'SECRET'];
const PROVIDERS = ['builtin', 'gemini', 'ollama', 'openai-compatible', 'anthropic'];

/**
 * Screen-editable configuration.
 *
 * A stored value is merged over its default, so adding a field in a later
 * version never leaves an older stored value incomplete. Every change is one
 * transaction with its audit event: the setting and the evidence of who
 * changed it, from what, to what.
 *
 * Values are cached for a few seconds. One process sees its own writes at once;
 * a second process sees them within the cache window.
 */
@Injectable()
export class SettingsService {
  private cache = new Map<SettingKey, { value: unknown; at: number }>();
  private static readonly TTL_MS = 5000;

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<Settings[K]> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < SettingsService.TTL_MS) {
      return cached.value as Settings[K];
    }
    const rows = await this.dataSource.query(`SELECT value FROM system_setting WHERE key = $1`, [key]);
    const stored = rows[0]?.value as Partial<Settings[K]> | undefined;
    const value = merge(SETTING_DEFAULTS[key], stored) as Settings[K];
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  async all(): Promise<Settings> {
    const result = {} as Record<string, unknown>;
    for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
      result[key] = await this.get(key);
    }
    return result as unknown as Settings;
  }

  async publicSettings(): Promise<Partial<Settings>> {
    const result: Record<string, unknown> = {};
    for (const key of PUBLIC_SETTING_KEYS) result[key] = await this.get(key);
    return result as Partial<Settings>;
  }

  async set<K extends SettingKey>(actor: Actor, key: K, value: unknown): Promise<Settings[K]> {
    if (!(key in SETTING_DEFAULTS)) throw new BadRequestException('Unknown setting.');
    const merged = merge(SETTING_DEFAULTS[key], value as Partial<Settings[K]>) as Settings[K];
    validate(key, merged);
    const previous = await this.get(key);
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO system_setting (key, value, updated_by_account_id, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
           updated_by_account_id = EXCLUDED.updated_by_account_id, updated_at = now()`,
        [key, JSON.stringify(merged), actor.accountId],
      );
      await this.audit.recordInTransaction(manager, {
        eventType: AuditEventType.SETTING_CHANGED,
        actorAccountId: actor.accountId,
        actorDescription: actor.description,
        subjectDescription: `setting: ${key}`,
        previousValue: truncate(JSON.stringify(redact(previous))),
        newValue: truncate(JSON.stringify(redact(merged))),
        summary: `${actor.description} changed the ${key} settings.`,
      });
    });
    this.cache.delete(key);
    return merged;
  }

  /** For tests and for a second process that must see a change at once. */
  invalidate(): void {
    this.cache.clear();
  }
}

function merge<T>(defaults: T, stored: Partial<T> | undefined | null): T {
  if (stored === undefined || stored === null) return structuredClone(defaults);
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
    return stored as T;
  }
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (!(k in out)) continue; // unknown fields are dropped, never stored
    const d = (defaults as Record<string, unknown>)[k];
    out[k] =
      d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object' && !Array.isArray(v)
        ? merge(d, v as Record<string, unknown>)
        : v;
  }
  return out as T;
}

function redact(value: unknown): unknown {
  if (value && typeof value === 'object' && 'logoDataUrl' in (value as Record<string, unknown>)) {
    const v = { ...(value as Record<string, unknown>) };
    if (v.logoDataUrl) v.logoDataUrl = '[image]';
    return v;
  }
  return value;
}

function truncate(s: string): string {
  return s.length > 390 ? `${s.slice(0, 387)}...` : s;
}

function fail(message: string): never {
  throw new BadRequestException(message);
}

function isInt(n: unknown, min: number, max: number): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
}

function rolesOk(list: unknown): boolean {
  return Array.isArray(list) && list.every((r) => KNOWN_ROLES.includes(String(r)));
}

/** Each setting is checked for shape and range before it is stored. */
function validate(key: SettingKey, v: Settings[SettingKey]): void {
  switch (key) {
    case 'branding': {
      const b = v as Settings['branding'];
      if (!b.organisationName?.trim() || !b.productName?.trim()) fail('The organisation and product names are required.');
      const hex = /^#[0-9a-fA-F]{6}$/;
      if (!hex.test(b.primaryColor) || !hex.test(b.accentColor)) fail('Colours must be written as #RRGGBB.');
      if (b.logoDataUrl && (!/^data:image\/(png|jpeg|svg\+xml);base64,/.test(b.logoDataUrl) || b.logoDataUrl.length > 700_000)) {
        fail('The logo must be a PNG, JPEG or SVG image under 500 KB.');
      }
      if (!Array.isArray(b.letterheadLines) || b.letterheadLines.length > 6) fail('At most six letterhead lines.');
      break;
    }
    case 'numbering': {
      const n = v as Settings['numbering'];
      for (const p of [n.registrationPattern, n.dossierPattern, n.taskPattern]) {
        if (p !== null && (!p.includes('{SEQ}') || p.length > 60)) fail('A numbering pattern must contain {SEQ}.');
      }
      for (const pad of [n.registrationPadding, n.dossierPadding, n.taskPadding]) {
        if (pad !== null && !isInt(pad, 1, 10)) fail('Padding must be a whole number from 1 to 10.');
      }
      break;
    }
    case 'deadlines': {
      const d = v as Settings['deadlines'];
      if (!Array.isArray(d.reminderDaysBefore) || !d.reminderDaysBefore.every((x) => isInt(x, 0, 60))) {
        fail('Reminder days must be whole numbers from 0 to 60.');
      }
      if (!isInt(d.escalateAfterWorkingDays, 0, 60) || !isInt(d.secondEscalationAfterWorkingDays, 1, 120)) {
        fail('Escalation days are out of range.');
      }
      if (!isInt(d.defaultIncomingWorkingDays, 1, 365)) fail('The standard handling time is out of range.');
      break;
    }
    case 'security': {
      const s = v as Settings['security'];
      if (!rolesOk(s.mfaRequiredForRoles)) fail('Unknown role in the two-step verification list.');
      if (!isInt(s.lockoutThreshold, 3, 20) || !isInt(s.lockoutWindowMinutes, 1, 1440) || !isInt(s.lockoutMinutes, 1, 1440)) {
        fail('Lockout values are out of range.');
      }
      if (!isInt(s.passwordMinLength, 8, 64)) fail('The minimum password length must be between 8 and 64.');
      break;
    }
    case 'classification': {
      const c = v as Settings['classification'];
      if (!LEVELS.includes(c.defaultLevel)) fail('Unknown classification level.');
      if (!rolesOk(c.confidentialRoles) || !rolesOk(c.secretRoles)) fail('Unknown role in a clearance list.');
      if (c.confidentialRoles.includes('SYS_ADMIN') || c.secretRoles.includes('SYS_ADMIN')) {
        fail('System administration never grants access to record content.');
      }
      break;
    }
    case 'ai': {
      const a = v as Settings['ai'];
      if (!PROVIDERS.includes(a.provider)) fail('Unknown AI provider.');
      if (!['builtin', 'gemini'].includes(a.provider) && !/^https?:\/\/[^\s]+$/.test(a.baseUrl)) fail('The AI address must be a URL.');
      if (!['metadata', 'records'].includes(a.dataPolicy)) fail('Unknown data policy.');
      if (!['work', 'broad'].includes(a.scope)) fail('Unknown assistant scope.');
      if (!isInt(a.hourlyLimit, 1, 1000)) fail('Questions per hour must be between 1 and 1000.');
      if (!Array.isArray(a.fallbackModels) || a.fallbackModels.length > 3 || a.fallbackModels.some((m) => typeof m !== 'string' || !/^[\w.:/-]{1,80}$/.test(m))) {
        fail('Fallback models must be up to three model names.');
      }
      if (!/^[\w.:/-]{1,80}$/.test(a.model)) fail('The model name is not valid.');
      const external = a.provider === 'gemini' || (a.provider !== 'builtin' && !isLocalAddress(a.baseUrl));
      if (external && !a.externalProviderAcknowledged) {
        fail('This AI address is outside the ministry network. Confirm that data may leave the server before choosing it.');
      }
      break;
    }
    case 'notifications': {
      const n = v as Settings['notifications'];
      if (!isInt(n.digestHour, 0, 23) || !isInt(n.weeklyReportHour, 0, 23) || !isInt(n.weeklyReportWeekday, 0, 6)) {
        fail('Notification times are out of range.');
      }
      break;
    }
    case 'language': {
      if (!['nl', 'en'].includes((v as Settings['language']).default)) fail('Unknown language.');
      break;
    }
    default:
      break;
  }
}
