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

export interface Turn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Completion {
  text: string;
  model: string;
}

export class LlmError extends Error {}

const LOCAL = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[a-z0-9-]+(:\d+)?(\/|$))/i;

/** Inside the ministry network: localhost, a private address, or a bare host name. */
export function isLocalAddress(url: string): boolean {
  return LOCAL.test(url);
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
