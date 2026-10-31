/**
 * The assistant's provider-neutral conversation. Each adapter turns it into
 * its own wire format; a model turn keeps the provider's original content in
 * `raw` so it can be sent back unchanged (Gemini's thought signatures, for one,
 * must be echoed exactly or the next call is refused).
 */

export interface ToolCall {
  /** Set by providers that number their calls (OpenAI, Anthropic, newer Gemini). */
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id?: string;
  name: string;
  response: Record<string, unknown>;
}

export type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'model'; text: string; calls: ToolCall[]; raw?: unknown; provider?: string }
  | { kind: 'results'; results: ToolResult[] };

/** A JSON-schema subset every provider accepts. */
export interface Schema {
  type: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Schema;
}

export interface GenerateRequest {
  model: string;
  system: string;
  entries: Entry[];
  tools: ToolDeclaration[];
  /** false on the last round: the model must answer in words. */
  allowTools: boolean;
  maxOutputTokens: number;
  temperature: number;
  signal: AbortSignal;
}

export interface GenerateResponse {
  text: string;
  calls: ToolCall[];
  raw: unknown;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ChatModel {
  readonly provider: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}
