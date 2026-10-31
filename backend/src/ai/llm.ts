/**
 * Connectors to a language model, used only when the administrator chooses
 * one. The default is the built-in engine, which needs none of this.
 *
 *   ollama, openai-compatible   POST {baseUrl}/chat/completions — Ollama, LM
 *                               Studio, vLLM, llama.cpp server: free, open
 *                               models, on the ministry's own hardware.
 *   anthropic                   POST {baseUrl}/v1/messages — a paid external
 *                               service; only after explicit confirmation.
 *
 * The key, when one is needed, is read from AI_API_KEY in the server's
 * environment. It is never stored in the settings and never sent to a browser.
 */
import { Settings } from '../settings/settings.defaults';
import { agentConfig } from './agent/config';
import { AgentError } from './agent/errors';
import { GeminiModel } from './agent/providers';

export interface Turn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Completion {
  text: string;
  model: string;
}

export class LlmError extends Error {}

/**
 * Inside the ministry network: localhost, a private IPv4 address or a bare host
 * name without dots (an intranet name). The host is parsed, so a public name
 * such as 10.example.com or localhost.example.com is not mistaken for local.
 */
export function isLocalAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '::1') return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  return /^[a-z0-9-]+$/.test(host);
}

function timeoutMs(): number {
  return Number(process.env.AI_TIMEOUT_MS ?? 90_000);
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new LlmError(`The language model answered ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if ((error as Error).name === 'AbortError') throw new LlmError('The language model did not answer in time.');
    throw new LlmError(`The language model could not be reached: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function complete(cfg: Settings['ai'], turns: Turn[], options: { maxTokens?: number; temperature?: number } = {}): Promise<Completion> {
  const key = process.env.AI_API_KEY ?? '';
  const maxTokens = options.maxTokens ?? 700;
  const temperature = options.temperature ?? 0.2;
  if (cfg.provider === 'gemini') {
    const effective = agentConfig(cfg);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effective.callTimeoutMs);
    try {
      const r = await new GeminiModel(key, effective.baseUrl).generate({
        model: effective.model,
        system: turns.filter((t) => t.role === 'system').map((t) => t.content).join('\n\n'),
        entries: turns.filter((t) => t.role !== 'system').map((t) => (t.role === 'user' ? { kind: 'user' as const, text: t.content } : { kind: 'model' as const, text: t.content, calls: [] })),
        tools: [],
        allowTools: false,
        maxOutputTokens: maxTokens,
        temperature,
        signal: controller.signal,
      });
      if (!r.text) throw new LlmError('The language model returned no text.');
      return { text: r.text, model: r.model };
    } catch (error) {
      if (error instanceof LlmError) throw error;
      throw new LlmError(`The language model gave no answer (${(error as AgentError).reason ?? 'error'}).`);
    } finally {
      clearTimeout(timer);
    }
  }
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (cfg.provider === 'anthropic') {
    const system = turns.filter((t) => t.role === 'system').map((t) => t.content).join('\n\n');
    const body = await post(
      `${base}/v1/messages`,
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model: cfg.model, max_tokens: maxTokens, temperature, system, messages: turns.filter((t) => t.role !== 'system') },
    );
    const content = (body.content as { type: string; text?: string }[] | undefined) ?? [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    if (!text) throw new LlmError('The language model returned no text.');
    return { text, model: String(body.model ?? cfg.model) };
  }
  const body = await post(
    `${base}/chat/completions`,
    key ? { Authorization: `Bearer ${key}` } : {},
    { model: cfg.model, messages: turns, max_tokens: maxTokens, temperature, stream: false },
  );
  const choice = (body.choices as { message?: { content?: string } }[] | undefined)?.[0];
  const text = (choice?.message?.content ?? '').trim();
  if (!text) throw new LlmError('The language model returned no text.');
  return { text, model: String(body.model ?? cfg.model) };
}

/** Whether the configured model answers, and which models it offers. */
export async function probe(cfg: Settings['ai']): Promise<{ reachable: boolean; models: string[]; error?: string }> {
  if (cfg.provider === 'builtin') return { reachable: true, models: ['builtin'] };
  if (cfg.provider === 'gemini') {
    const effective = agentConfig(cfg);
    const key = process.env.AI_API_KEY ?? '';
    if (!key) return { reachable: false, models: [], error: 'AI_API_KEY is not set on the server.' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${effective.baseUrl.replace(/\/+$/, '')}/models?pageSize=100`, { headers: { 'x-goog-api-key': key }, signal: controller.signal });
      if (!res.ok) return { reachable: false, models: [], error: `HTTP ${res.status}` };
      const body = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      return {
        reachable: true,
        models: (body.models ?? []).filter((m) => (m.supportedGenerationMethods ?? ['generateContent']).includes('generateContent')).map((m) => m.name.replace(/^models\//, '')).slice(0, 50),
      };
    } catch (error) {
      return { reachable: false, models: [], error: (error as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const key = process.env.AI_API_KEY ?? '';
    const url = cfg.provider === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
    const headers: Record<string, string> =
      cfg.provider === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : key ? { Authorization: `Bearer ${key}` } : {};
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return { reachable: false, models: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id: string }[] };
    return { reachable: true, models: (body.data ?? []).map((m) => m.id).slice(0, 50) };
  } catch (error) {
    return { reachable: false, models: [], error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
