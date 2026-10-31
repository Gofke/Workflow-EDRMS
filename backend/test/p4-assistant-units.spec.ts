import { agentConfig } from '../src/ai/agent/config';
import { isLocalAddress } from '../src/ai/llm';
import { environmentProblems, fingerprint } from '../src/config/environment-guard';
import { mapHttpError } from '../src/ai/agent/providers';
import { redact } from '../src/ai/agent/redact';
import { periodRange } from '../src/ai/agent/tools';
import { conversation } from '../src/ai/agent/assistant.service';
import { runLoop } from '../src/ai/agent/loop';
import { AgentError } from '../src/ai/agent/errors';
import { ChatModel, GenerateRequest, GenerateResponse } from '../src/ai/agent/types';
import { SETTING_DEFAULTS } from '../src/settings/settings.defaults';

/** Pure parts of the assistant: no database, no network, no keys. */
describe('V0.4.0 assistant — units', () => {
  describe('redact', () => {
    it.each([
      ['bel 8812345', 'bel [nummer]'],
      ['bel +597 881-2345 nu', 'bel [nummer] nu'],
      ['mail a.b@juspol.sr', 'mail [e-mailadres]'],
      ['ID 123456789', 'ID [nummer]'],
      ['IBAN SR12 DSBB 0001 2345 67', 'IBAN [rekeningnummer]'],
    ])('%s → %s', (input, out) => expect(redact(input).text).toBe(out));

    it('keeps registration numbers, matter and task numbers, dates and small numbers', () => {
      const t = 'IN-2026-00012, DOS-2026-0003 en TAAK-2026-0007 op 12-10-2026 en 2026-10-31, 3 brieven in 2026';
      expect(redact(t)).toEqual({ text: t, removed: 0 });
    });

    it('does not protect look-alike numbers (review finding 8)', () => {
      for (const t of ['tel-0597-8123456', 'AB-1234-567890', 'SR-0001-23456789', 'T-08123456', 'FB123456']) {
        expect(redact(t).text).not.toMatch(/\d{6,}/);
      }
      expect(redact('zaak dos-2026-0003 en IN-2026-00012').text).toBe('zaak dos-2026-0003 en IN-2026-00012');
    });

    it('labels in English for an English question', () => {
      expect(redact('call 8812345', 'en').text).toBe('call [number]');
    });
  });

  describe('periodRange (Monday weeks, Suriname dates)', () => {
    it('works out weeks, months and years from today', () => {
      expect(periodRange('this_week', '2026-10-31')).toEqual({ from: '2026-10-26', to: '2026-11-01' });
      expect(periodRange('last_week', '2026-10-31')).toEqual({ from: '2026-10-19', to: '2026-10-25' });
      expect(periodRange('this_month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
      expect(periodRange('last_month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
      expect(periodRange('this_year', '2026-10-31')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
      expect(periodRange('nonsense', '2026-10-31')).toBeNull();
    });
  });

  describe('provider error mapping', () => {
    it.each([
      [429, 'Quota exceeded', 'free-limit'],
      [400, 'INVALID_ARGUMENT API key not valid', 'bad-key'],
      [401, 'UNAUTHENTICATED', 'bad-key'],
      [403, 'PERMISSION_DENIED', 'bad-key'],
      [404, 'NOT_FOUND models/foo is not found', 'bad-model'],
      [500, 'INTERNAL', 'unavailable'],
      [503, 'UNAVAILABLE overloaded', 'unavailable'],
      [504, 'DEADLINE_EXCEEDED', 'timeout'],
      [400, 'INVALID_ARGUMENT bad payload', 'bad-request'],
    ])('%i %s → %s', (status, message, reason) => expect(mapHttpError(status, message)).toBe(reason));
  });

  describe('configuration: the environment wins, the key stays out', () => {
    const ai = { ...SETTING_DEFAULTS.ai, provider: 'builtin' as const };

    it('AI_PROVIDER, AI_MODEL and AI_FALLBACK_MODELS override the settings and are reported as fixed', () => {
      const c = agentConfig(ai, { AI_PROVIDER: 'gemini', AI_MODEL: 'gemini-flash-latest', AI_FALLBACK_MODELS: 'gemini-flash-lite-latest, gemini-flash-latest', AI_API_KEY: 'x' });
      expect(c).toMatchObject({ provider: 'gemini', model: 'gemini-flash-latest', fallbackModels: ['gemini-flash-lite-latest'], keyPresent: true, local: false });
      expect(c.pinned).toEqual(expect.arrayContaining(['provider', 'model', 'fallbackModels']));
      expect(JSON.stringify(c)).not.toContain('"x"');
    });

    it('empty values in .env count as not set', () => {
      const c = agentConfig(ai, { AI_PROVIDER: '', AI_MODEL: '', AI_HOURLY_LIMIT: '' });
      expect(c.provider).toBe('builtin');
      expect(c.pinned).toEqual([]);
      expect(c.hourlyLimit).toBe(30);
    });

    it('a free model outside the network gets metadata only, whichever provider (finding 7)', () => {
      expect(agentConfig({ ...ai, provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', dataPolicy: 'records' }, {}).dataPolicy).toBe('metadata');
      expect(agentConfig({ ...ai, provider: 'ollama', baseUrl: 'http://ai-server:11434/v1', dataPolicy: 'records' }, {}).dataPolicy).toBe('records');
    });

    it('local means a private address or an intranet name, parsed — not a look-alike public name', () => {
      for (const u of ['http://localhost:11434/v1', 'http://127.0.0.1:8080', 'http://10.1.2.3/v1', 'http://192.168.0.5', 'http://172.20.1.1', 'http://ai-server:11434/v1', 'http://[::1]:80']) expect(isLocalAddress(u)).toBe(true);
      for (const u of ['http://10.evil.example.com', 'http://localhost.evil.com', 'http://192.168.attacker.net', 'https://api.openai.com/v1', 'http://172.32.0.1', 'not a url']) expect(isLocalAddress(u)).toBe(false);
    });

    it('a free Gemini tier always gets metadata only, whatever the setting', () => {
      expect(agentConfig({ ...ai, dataPolicy: 'records' }, { AI_PROVIDER: 'gemini' }).dataPolicy).toBe('metadata');
      expect(agentConfig({ ...ai, dataPolicy: 'records' }, { AI_PROVIDER: 'gemini', AI_TIER: 'paid' }).dataPolicy).toBe('records');
    });

    it('defaults: 6 rounds, 30 s per call, 80 s per question, 30 questions per hour', () => {
      const c = agentConfig(ai, {});
      expect(c).toMatchObject({ maxRounds: 6, callTimeoutMs: 30_000, totalTimeoutMs: 80_000, hourlyLimit: 30, offlineFallback: true });
    });
  });

  describe('conversation', () => {
    it('starts with the person, joins turns of the same side and redacts every turn', () => {
      const e = conversation(
        [
          { role: 'assistant', content: 'Welkom' },
          { role: 'user', content: 'a 8812345' },
          { role: 'user', content: 'b' },
          { role: 'assistant', content: 'c' },
        ],
        'd x@y.sr',
        'nl',
      );
      expect(e).toEqual([
        { kind: 'user', text: 'a [nummer]\n\nb' },
        { kind: 'model', text: 'c', calls: [] },
        { kind: 'user', text: 'd [e-mailadres]' },
      ]);
    });
  });

  describe('loop', () => {
    const base = { system: 's', tools: [], maxRounds: 6, maxOutputTokens: 100, callTimeoutMs: 500, totalTimeoutMs: 1500, runTool: async () => ({ ok: true }) };
    const model = (fn: (r: GenerateRequest) => Promise<Partial<GenerateResponse>>): ChatModel => ({
      provider: 'fake',
      generate: async (r) => ({ text: '', calls: [], raw: null, model: r.model, inputTokens: 1, outputTokens: 1, ...(await fn(r)) }),
    });

    it('stops at once when the person presses Stop', async () => {
      const stop = new AbortController();
      const m = model((r) => new Promise((_, reject) => r.signal.addEventListener('abort', () => reject(r.signal.reason))));
      const p = runLoop({ ...base, model: m, models: ['m'], entries: [{ kind: 'user', text: 'q' }], signal: stop.signal });
      setTimeout(() => stop.abort(), 20);
      await expect(p).rejects.toMatchObject({ reason: 'cancelled' });
    });

    it('a question that takes longer than the total time ends with timeout', async () => {
      let n = 0;
      const m = model(async () => {
        n += 1;
        await new Promise((r) => setTimeout(r, 400));
        return { calls: [{ name: 't', args: {} }] };
      });
      await expect(runLoop({ ...base, model: m, models: ['m'], entries: [{ kind: 'user', text: 'q' }], signal: new AbortController().signal })).rejects.toMatchObject({ reason: 'timeout' });
      expect(n).toBeLessThan(6);
    });

    it('a failing tool becomes an error result, not a crash; at most 5 calls per round', async () => {
      let round = 0;
      const seen: unknown[] = [];
      const m = model(async (r) => {
        round += 1;
        if (round === 1) return { calls: Array.from({ length: 7 }, (_, i) => ({ name: `t${i}`, args: {} })) };
        seen.push(r.entries[r.entries.length - 1]);
        return { text: 'klaar' };
      });
      const out = await runLoop({
        ...base,
        model: m,
        models: ['m'],
        entries: [{ kind: 'user', text: 'q' }],
        signal: new AbortController().signal,
        runTool: async (c) => {
          if (c.name === 't0') throw new Error('boom');
          return { ok: c.name };
        },
      });
      expect(out.text).toBe('klaar');
      expect(out.toolsUsed).toHaveLength(5);
      const results = (seen[0] as { results: { response: Record<string, unknown> }[] }).results;
      expect(results).toHaveLength(7);
      expect(results[0].response.error).toMatch(/failed/);
      expect(results[6].response.error).toMatch(/Too many calls/);
    });

    it('an empty answer is a bad request, not a blank bubble', async () => {
      const m = model(async () => ({ text: '' }));
      await expect(runLoop({ ...base, model: m, models: ['m'], entries: [{ kind: 'user', text: 'q' }], signal: new AbortController().signal })).rejects.toBeInstanceOf(AgentError);
    });
  });

  describe('environment separation (AU-28)', () => {
    const prodKey = 'prod-key-value-123';
    const prints = `${fingerprint(prodKey)},${fingerprint('db.prod.local/juspol')}`;

    it('a staging server refuses the production key or the production database', () => {
      expect(environmentProblems({ APP_ENV: 'staging', AI_API_KEY: prodKey, PRODUCTION_FINGERPRINTS: prints })).toEqual([expect.stringMatching(/production AI key/)]);
      expect(environmentProblems({ APP_ENV: 'staging', DB_HOST: 'db.prod.local', DB_DATABASE: 'juspol', PRODUCTION_FINGERPRINTS: prints })).toEqual([expect.stringMatching(/production database/)]);
    });

    it('starts with its own key and database, and only fingerprints are configured', () => {
      expect(environmentProblems({ APP_ENV: 'staging', AI_API_KEY: 'staging-key', DB_HOST: 'localhost', DB_DATABASE: 'juspol_staging', PRODUCTION_FINGERPRINTS: prints })).toEqual([]);
      expect(prints).not.toContain(prodKey);
    });

    it('refuses an unknown environment name and a short production session secret', () => {
      expect(environmentProblems({ APP_ENV: 'prod' })).toEqual([expect.stringMatching(/APP_ENV must be/)]);
      expect(environmentProblems({ APP_ENV: 'production', SESSION_SECRET: 'short' })).toEqual([expect.stringMatching(/SESSION_SECRET/)]);
    });
  });
});
