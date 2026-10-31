/**
 * The tool loop: ask the model, run the tools it asks for, give it the
 * results, repeat — at most `maxRounds` times. The last round is sent with
 * tools switched off, so the model must answer in words. Each call has its own
 * timeout, the whole question has a total timeout, and Stop in the panel (the
 * browser closing the request) aborts everything at once.
 *
 * When the configured model is busy or over its free limit, the next model in
 * the fallback list (same provider, same key, so the same tier) is tried.
 */
import { Logger } from '@nestjs/common';
import { AgentError, TRY_NEXT_MODEL } from './errors';
import { abortReason } from './providers';
import { ChatModel, Entry, GenerateResponse, ToolCall, ToolDeclaration, ToolResult } from './types';

export interface LoopOptions {
  model: ChatModel;
  models: string[];
  system: string;
  entries: Entry[];
  tools: ToolDeclaration[];
  maxRounds: number;
  maxOutputTokens: number;
  callTimeoutMs: number;
  totalTimeoutMs: number;
  /** Aborted when the person presses Stop or closes the panel. */
  signal: AbortSignal;
  runTool: (call: ToolCall) => Promise<Record<string, unknown>>;
  /** Most calls the model may make in one round. */
  maxCallsPerRound?: number;
}

export interface LoopResult {
  text: string;
  toolsUsed: string[];
  model: string;
  rounds: number;
  inputTokens: number;
  outputTokens: number;
  entries: Entry[];
}

export async function runLoop(o: LoopOptions): Promise<LoopResult> {
  const total = new AbortController();
  const totalTimer = setTimeout(() => total.abort(new AgentError('timeout', 'total time exceeded')), o.totalTimeoutMs);
  const onCancel = () => total.abort(new AgentError('cancelled', 'stopped by the person'));
  if (o.signal.aborted) onCancel();
  else o.signal.addEventListener('abort', onCancel, { once: true });

  const entries: Entry[] = [...o.entries];
  const toolsUsed: string[] = [];
  let input = 0;
  let output = 0;
  let modelIndex = 0;
  let usedModel = o.models[0];
  try {
    for (let round = 1; round <= o.maxRounds; round += 1) {
      const last = round === o.maxRounds;
      let reply: GenerateResponse | null = null;
      while (!reply) {
        const call = new AbortController();
        const timer = setTimeout(() => call.abort(new AgentError('timeout', 'model call took too long')), o.callTimeoutMs);
        const relay = () => call.abort(total.signal.reason);
        if (total.signal.aborted) relay();
        else total.signal.addEventListener('abort', relay, { once: true });
        try {
          reply = await o.model.generate({
            model: o.models[modelIndex],
            system: o.system,
            entries,
            tools: o.tools,
            allowTools: !last,
            maxOutputTokens: o.maxOutputTokens,
            temperature: 0.2,
            signal: call.signal,
          });
          usedModel = reply.model || o.models[modelIndex];
        } catch (error) {
          const e = error instanceof AgentError ? error : call.signal.aborted ? abortReason(call.signal) : new AgentError('unavailable', String((error as Error)?.message ?? error).slice(0, 120));
          if (TRY_NEXT_MODEL.includes(e.reason) && modelIndex + 1 < o.models.length && !total.signal.aborted) {
            modelIndex += 1;
            continue;
          }
          throw e;
        } finally {
          clearTimeout(timer);
          total.signal.removeEventListener('abort', relay);
        }
      }
      input += reply.inputTokens ?? 0;
      output += reply.outputTokens ?? 0;
      entries.push({ kind: 'model', text: reply.text, calls: reply.calls, raw: reply.raw, provider: o.model.provider });

      if (!reply.calls.length) {
        if (!reply.text) throw new AgentError('bad-request', 'empty answer');
        return { text: reply.text, toolsUsed, model: usedModel, rounds: round, inputTokens: input, outputTokens: output, entries };
      }
      if (last) throw new AgentError('too-many-steps', `still calling tools after ${o.maxRounds} rounds`);

      const calls = reply.calls.slice(0, o.maxCallsPerRound ?? 5);
      const results: ToolResult[] = [];
      for (const c of calls) {
        if (total.signal.aborted) throw total.signal.reason as AgentError;
        let response: Record<string, unknown>;
        try {
          response = await o.runTool(c);
        } catch (error) {
          // For the operator: which tool failed and why — never the question.
          new Logger('Assistant').warn(`Tool ${c.name} failed: ${(error as Error)?.message ?? error}`);
          response = { error: 'The tool failed. Do not retry; tell the person the information could not be retrieved.' };
        }
        if (!toolsUsed.includes(c.name)) toolsUsed.push(c.name);
        results.push({ id: c.id, name: c.name, response });
      }
      for (const c of reply.calls.slice(calls.length)) {
        results.push({ id: c.id, name: c.name, response: { error: 'Too many calls in one step; ask again for this one if needed.' } });
      }
      entries.push({ kind: 'results', results });
    }
    throw new AgentError('too-many-steps', 'no answer');
  } finally {
    clearTimeout(totalTimer);
    o.signal.removeEventListener('abort', onCancel);
  }
}
