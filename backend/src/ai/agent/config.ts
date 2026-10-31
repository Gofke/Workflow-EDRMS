/**
 * The assistant's effective configuration. The administrator sets provider and
 * model in Beheer → Assistent; the server environment overrides them, so a
 * deployment can pin the model without anyone being able to change it from the
 * screen. The key lives only in the environment.
 *
 *   AI_PROVIDER            gemini | openai-compatible | ollama | anthropic | builtin
 *   AI_MODEL               e.g. gemini-flash-latest
 *   AI_FALLBACK_MODELS     comma list, same provider and key, e.g. gemini-flash-lite-latest
 *   AI_API_KEY             secret, never in git, settings, logs or the browser
 *   AI_BASE_URL            optional; the provider's default otherwise
 *   AI_TIER                free | paid — paid never falls back to a free model
 *   AI_MAX_OUTPUT_TOKENS   default 1024
 *   AI_CALL_TIMEOUT_MS     per model call, default 30000
 *   AI_TOTAL_TIMEOUT_MS    per question, default 80000
 *   AI_HOURLY_LIMIT        questions per person per hour, default from settings (30)
 *   AI_IP_LIMIT_PER_MINUTE requests per address per minute, default 60
 */
import { Settings } from '../../settings/settings.defaults';
import { isLocalAddress } from '../llm';
import { AnthropicModel, GEMINI_BASE, GeminiModel, OpenAiCompatibleModel } from './providers';
import { ChatModel } from './types';

export type AgentProvider = 'gemini' | 'openai-compatible' | 'ollama' | 'anthropic';
export const AGENT_PROVIDERS: AgentProvider[] = ['gemini', 'openai-compatible', 'ollama', 'anthropic'];

export interface AgentConfig {
  /** builtin when no language model is configured: the offline assistant answers. */
  provider: AgentProvider | 'builtin';
  model: string;
  fallbackModels: string[];
  baseUrl: string;
  tier: 'free' | 'paid';
  local: boolean;
  keyPresent: boolean;
  maxOutputTokens: number;
  callTimeoutMs: number;
  totalTimeoutMs: number;
  hourlyLimit: number;
  maxRounds: number;
  dataPolicy: 'metadata' | 'records';
  scope: 'work' | 'broad';
  offlineFallback: boolean;
  /** Which values come from the environment, so the screen can show them as fixed. */
  pinned: string[];
}

const DEFAULT_BASE: Record<AgentProvider, string> = {
  gemini: GEMINI_BASE,
  'openai-compatible': 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
  anthropic: 'https://api.anthropic.com',
};

function set(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = set(env, name);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : fallback;
}

export function agentConfig(ai: Settings['ai'], env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const pinned: string[] = [];
  const envProvider = set(env, 'AI_PROVIDER') ?? '';
  let provider = ai.provider as AgentConfig['provider'];
  if (envProvider) {
    pinned.push('provider');
    provider = (AGENT_PROVIDERS as string[]).includes(envProvider) ? (envProvider as AgentProvider) : 'builtin';
  }
  let model = ai.model;
  const envModel = set(env, 'AI_MODEL');
  if (envModel) {
    pinned.push('model');
    model = envModel;
  }
  if (provider === 'gemini' && !envModel && !/gemini/i.test(model)) model = 'gemini-flash-latest';
  const envFallback = set(env, 'AI_FALLBACK_MODELS');
  const fallbackSource = envFallback ?? (ai.fallbackModels ?? []).join(',');
  if (envFallback) pinned.push('fallbackModels');
  const fallbackModels = fallbackSource
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && m !== model)
    .slice(0, 3);
  let baseUrl = ai.baseUrl;
  const envBase = set(env, 'AI_BASE_URL');
  if (envBase) {
    pinned.push('baseUrl');
    baseUrl = envBase;
  } else if (provider === 'gemini' || (provider === 'anthropic' && !/anthropic/.test(baseUrl))) {
    baseUrl = DEFAULT_BASE[provider as AgentProvider];
  }
  const tier = set(env, 'AI_TIER') === 'paid' ? 'paid' : 'free';
  const hourly = num(env, 'AI_HOURLY_LIMIT', ai.hourlyLimit ?? 30, 1, 10_000);
  if (set(env, 'AI_HOURLY_LIMIT')) pinned.push('hourlyLimit');
  return {
    provider,
    model,
    fallbackModels,
    baseUrl,
    tier,
    local: provider !== 'builtin' && provider !== 'gemini' && isLocalAddress(baseUrl),
    keyPresent: Boolean(set(env, 'AI_API_KEY')),
    maxOutputTokens: num(env, 'AI_MAX_OUTPUT_TOKENS', 1024, 64, 8192),
    callTimeoutMs: num(env, 'AI_CALL_TIMEOUT_MS', 30_000, 1_000, 120_000),
    totalTimeoutMs: num(env, 'AI_TOTAL_TIMEOUT_MS', 80_000, 2_000, 300_000),
    hourlyLimit: hourly,
    maxRounds: 6,
    // A free model outside the ministry network gets metadata only, whatever the setting says.
    dataPolicy: tier === 'free' && provider !== 'builtin' && (provider === 'gemini' || !isLocalAddress(baseUrl)) ? 'metadata' : ai.dataPolicy ?? 'metadata',
    scope: ai.scope ?? 'broad',
    offlineFallback: ai.offlineFallback ?? true,
    pinned,
  };
}

/** Whether a key is needed for this provider. */
export function needsKey(provider: AgentConfig['provider']): boolean {
  return provider === 'gemini' || provider === 'anthropic';
}

export function createModel(cfg: AgentConfig, env: NodeJS.ProcessEnv = process.env): ChatModel {
  const key = env.AI_API_KEY?.trim() ?? '';
  switch (cfg.provider) {
    case 'gemini':
      return new GeminiModel(key, cfg.baseUrl);
    case 'anthropic':
      return new AnthropicModel(cfg.baseUrl, key);
    case 'openai-compatible':
    case 'ollama':
      return new OpenAiCompatibleModel(cfg.provider, cfg.baseUrl, key);
    default:
      throw new Error('No language model is configured.');
  }
}
