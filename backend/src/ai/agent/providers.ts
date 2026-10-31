/**
 * Provider adapters. One small class per provider; everything else in the
 * assistant speaks the neutral conversation in ./types. Switching provider or
 * model is a matter of settings or environment only.
 *
 *   gemini              Google Gemini API, generateContent with function calling
 *   openai-compatible   any /chat/completions server with tools (OpenAI, Groq, vLLM…)
 *   ollama              the same API on the ministry's own hardware
 *   anthropic           Anthropic Messages API with tool use
 *
 * Keys come from the environment (AI_API_KEY) and are sent only in a request
 * header, never in a URL, a log line or an error message.
 */
import { AgentError, AgentReason } from './errors';
import { ChatModel, Entry, GenerateRequest, GenerateResponse, Schema, ToolCall, ToolDeclaration } from './types';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface HttpReply {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

async function postJson(url: string, headers: Record<string, string>, payload: unknown, signal: AbortSignal): Promise<HttpReply> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload), signal });
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw new AgentError('unavailable', `network: ${(error as Error).message.slice(0, 120)}`);
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    if (signal.aborted) throw abortReason(signal);
    throw new AgentError('unavailable', 'the answer was cut off');
  }
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    if (res.ok) throw new AgentError('bad-request', 'the answer was not JSON');
  }
  return { status: res.status, body, text };
}

/** Why a request was aborted: the caller's timeout or the person pressing Stop. */
export function abortReason(signal: AbortSignal): AgentError {
  const r = signal.reason as unknown;
  if (r instanceof AgentError) return r;
  return new AgentError('cancelled', 'stopped');
}

/** HTTP status and provider error text to one reason code. */
export function mapHttpError(status: number, message: string): AgentReason {
  const m = message.toLowerCase();
  if (status === 429 || /resource_exhausted|quota|rate.?limit/.test(m)) return 'free-limit';
  if (status === 401 || status === 403 || /api.?key|permission_denied|unauthenticated|invalid x-api-key|authentication/.test(m)) return 'bad-key';
  if (status === 404 || /not.?found.*model|model.*not.?found|is not supported for generatecontent|unknown model|no such model/.test(m)) return 'bad-model';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'unavailable';
  return 'bad-request';
}

function errorText(reply: HttpReply): string {
  const e = reply.body.error as { message?: string; status?: string; type?: string } | string | undefined;
  if (typeof e === 'string') return e;
  return [e?.status, e?.type, e?.message].filter(Boolean).join(' ') || reply.text.slice(0, 200);
}

function fail(reply: HttpReply): never {
  const text = errorText(reply);
  throw new AgentError(mapHttpError(reply.status, text), `HTTP ${reply.status}: ${text.slice(0, 160)}`);
}

// ---------------------------------------------------------------- Gemini

/** Gemini's schema dialect: OpenAPI 3 subset; types in upper case are also accepted, lower case is fine. */
function geminiSchema(s: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: s.type };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = geminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, geminiSchema(v)]));
    if (s.required?.length) out.required = s.required;
  }
  return out;
}

export class GeminiModel implements ChatModel {
  readonly provider = 'gemini';

  constructor(
    private readonly key: string,
    private readonly base = GEMINI_BASE,
  ) {}

  private contents(entries: Entry[]): unknown[] {
    return entries.map((e) => {
      if (e.kind === 'user') return { role: 'user', parts: [{ text: e.text }] };
      if (e.kind === 'results') {
        return {
          role: 'user',
          parts: e.results.map((r) => ({ functionResponse: { name: r.name, response: r.response, ...(r.id ? { id: r.id } : {}) } })),
        };
      }
      // The model's own turn goes back exactly as it came: thought signatures included.
      if (e.raw && e.provider === 'gemini') return e.raw;
      const parts: unknown[] = [];
      if (e.text) parts.push({ text: e.text });
      for (const c of e.calls) parts.push({ functionCall: { name: c.name, args: c.args, ...(c.id ? { id: c.id } : {}) } });
      return { role: 'model', parts: parts.length ? parts : [{ text: '' }] };
    });
  }

  async generate(r: GenerateRequest): Promise<GenerateResponse> {
    const payload: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: r.system }] },
      contents: this.contents(r.entries),
      generationConfig: { maxOutputTokens: r.maxOutputTokens, temperature: r.temperature },
    };
    if (r.tools.length) {
      payload.tools = [{ functionDeclarations: r.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
      payload.toolConfig = { functionCallingConfig: { mode: r.allowTools ? 'AUTO' : 'NONE' } };
    }
    const url = `${this.base.replace(/\/+$/, '')}/models/${encodeURIComponent(r.model)}:generateContent`;
    const reply = await postJson(url, { 'x-goog-api-key': this.key }, payload, r.signal);
    if (reply.status < 200 || reply.status >= 300) fail(reply);

    const candidate = (reply.body.candidates as { content?: { role?: string; parts?: Record<string, unknown>[] }; finishReason?: string }[] | undefined)?.[0];
    const blocked = (reply.body.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
    if (!candidate) throw new AgentError('bad-request', blocked ? `blocked: ${blocked}` : 'no candidate in the answer');
    const parts = candidate.content?.parts ?? [];
    const calls: ToolCall[] = [];
    let text = '';
    for (const p of parts) {
      if (p.thought === true) continue;
      if (typeof p.text === 'string') text += p.text;
      const fc = p.functionCall as { name?: string; args?: Record<string, unknown>; id?: string } | undefined;
      if (fc?.name) calls.push({ name: fc.name, args: fc.args ?? {}, ...(fc.id ? { id: fc.id } : {}) });
    }
    if (!text && !calls.length && candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
      throw new AgentError('bad-request', `finished with ${candidate.finishReason}`);
    }
    const usage = reply.body.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    return {
      text: text.trim(),
      calls,
      raw: { role: 'model', parts },
      model: String(reply.body.modelVersion ?? r.model),
      inputTokens: usage?.promptTokenCount ?? null,
      outputTokens: usage?.candidatesTokenCount ?? null,
    };
  }
}

// ---------------------------------------------------------------- OpenAI-compatible (and Ollama)

export class OpenAiCompatibleModel implements ChatModel {
  constructor(
    readonly provider: string,
    private readonly base: string,
    private readonly key: string,
  ) {}

  private messages(system: string, entries: Entry[]): unknown[] {
    const out: unknown[] = [{ role: 'system', content: system }];
    for (const e of entries) {
      if (e.kind === 'user') out.push({ role: 'user', content: e.text });
      else if (e.kind === 'model') {
        if (e.raw && e.provider === this.provider) out.push(e.raw);
        else
          out.push({
            role: 'assistant',
            content: e.text || null,
            ...(e.calls.length
              ? { tool_calls: e.calls.map((c, i) => ({ id: c.id ?? `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
              : {}),
          });
      } else for (const [i, r] of e.results.entries()) out.push({ role: 'tool', tool_call_id: r.id ?? `call_${i}`, content: JSON.stringify(r.response) });
    }
    return out;
  }

  async generate(r: GenerateRequest): Promise<GenerateResponse> {
    const payload: Record<string, unknown> = {
      model: r.model,
      messages: this.messages(r.system, r.entries),
      max_tokens: r.maxOutputTokens,
      temperature: r.temperature,
      stream: false,
    };
    if (r.tools.length) {
      payload.tools = r.tools.map((t: ToolDeclaration) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      payload.tool_choice = r.allowTools ? 'auto' : 'none';
    }
    const reply = await postJson(`${this.base.replace(/\/+$/, '')}/chat/completions`, this.key ? { Authorization: `Bearer ${this.key}` } : {}, payload, r.signal);
    if (reply.status < 200 || reply.status >= 300) fail(reply);
    const message = (reply.body.choices as { message?: Record<string, unknown> }[] | undefined)?.[0]?.message;
    if (!message) throw new AgentError('bad-request', 'no message in the answer');
    const calls: ToolCall[] = ((message.tool_calls as { id?: string; function?: { name?: string; arguments?: string } }[] | undefined) ?? [])
      .filter((c) => c.function?.name)
      .map((c) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.function?.arguments || '{}');
        } catch {
          args = {};
        }
        return { id: c.id, name: c.function!.name!, args };
      });
    const usage = reply.body.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    return {
      text: String(message.content ?? '').trim(),
      calls,
      raw: message,
      model: String(reply.body.model ?? r.model),
      inputTokens: usage?.prompt_tokens ?? null,
      outputTokens: usage?.completion_tokens ?? null,
    };
  }
}

// ---------------------------------------------------------------- Anthropic

export class AnthropicModel implements ChatModel {
  readonly provider = 'anthropic';

  constructor(
    private readonly base: string,
    private readonly key: string,
  ) {}

  private messages(entries: Entry[]): unknown[] {
    return entries.map((e) => {
      if (e.kind === 'user') return { role: 'user', content: e.text };
      if (e.kind === 'results') {
        return { role: 'user', content: e.results.map((r, i) => ({ type: 'tool_result', tool_use_id: r.id ?? `toolu_${i}`, content: JSON.stringify(r.response) })) };
      }
      if (e.raw && e.provider === 'anthropic') return e.raw;
      const content: unknown[] = [];
      if (e.text) content.push({ type: 'text', text: e.text });
      e.calls.forEach((c, i) => content.push({ type: 'tool_use', id: c.id ?? `toolu_${i}`, name: c.name, input: c.args }));
      return { role: 'assistant', content };
    });
  }

  async generate(r: GenerateRequest): Promise<GenerateResponse> {
    const payload: Record<string, unknown> = {
      model: r.model,
      max_tokens: r.maxOutputTokens,
      temperature: r.temperature,
      system: r.system,
      messages: this.messages(r.entries),
    };
    if (r.tools.length) {
      payload.tools = r.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      payload.tool_choice = r.allowTools ? { type: 'auto' } : { type: 'none' };
    }
    const reply = await postJson(`${this.base.replace(/\/+$/, '')}/v1/messages`, { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' }, payload, r.signal);
    if (reply.status < 200 || reply.status >= 300) fail(reply);
    const content = (reply.body.content as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[] | undefined) ?? [];
    const usage = reply.body.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    return {
      text: content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim(),
      calls: content.filter((c) => c.type === 'tool_use' && c.name).map((c) => ({ id: c.id, name: c.name!, args: c.input ?? {} })),
      raw: { role: 'assistant', content },
      model: String(reply.body.model ?? r.model),
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
    };
  }
}
