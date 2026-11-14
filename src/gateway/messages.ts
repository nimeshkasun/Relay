/**
 * Helpers for the native Anthropic Messages endpoint (POST /v1/messages).
 *
 * The request and response stay in Anthropic's format end to end; Relay only looks at
 * the text inside them for guardrails, PII masking and token estimates. Thinking blocks
 * are never touched: their signature covers their content, and the client must be able
 * to pass them back unchanged.
 */
import { restorePii, StreamRestorer } from '../guardrails/engine';
import { GatewayError } from './router';
import { ChatMessage } from './types';

const MAX_MESSAGES = 2000;

export interface MessagesBody {
  model?: string;
  messages: { role: 'user' | 'assistant'; content: unknown }[];
  system?: unknown;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  metadata?: { user_id?: string };
  relay?: { tags?: string[]; cache?: unknown; providerOptions?: Record<string, unknown>; prompt?: unknown };
  [k: string]: unknown;
}

export function validateMessages(body: unknown): MessagesBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GatewayError(400, 'Request body must be a JSON object');
  const b = body as MessagesBody;
  if (b.model !== undefined && typeof b.model !== 'string') throw new GatewayError(400, '"model" must be a string');
  if (!Array.isArray(b.messages) || !b.messages.length) throw new GatewayError(400, '"messages" must contain at least one message');
  if (b.messages.length > MAX_MESSAGES) throw new GatewayError(400, `Too many messages (max ${MAX_MESSAGES})`);
  for (const m of b.messages) {
    if (!m || typeof m !== 'object' || (m.role !== 'user' && m.role !== 'assistant')) throw new GatewayError(400, 'Each message needs role "user" or "assistant"');
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) throw new GatewayError(400, 'Each message needs "content" as a string or an array of blocks');
  }
  if (b.max_tokens !== undefined && (typeof b.max_tokens !== 'number' || b.max_tokens < 1)) throw new GatewayError(400, '"max_tokens" must be a positive number');
  if (b.relay?.prompt) throw new GatewayError(400, 'Managed prompts (relay.prompt) are not available on /v1/messages; use /v1/chat/completions', 'invalid_request_error', 'unsupported');
  return b;
}

/** Relay tags from the body (relay.tags) and the x-relay-tags header (comma-separated), for clients whose SDK types reject extra body fields. */
export function relayTags(body: MessagesBody, header: string | string[] | undefined): string[] | undefined {
  const fromHeader = (Array.isArray(header) ? header.join(',') : header ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fromBody = Array.isArray(body.relay?.tags) ? body.relay!.tags.filter((t): t is string => typeof t === 'string') : [];
  const all = [...new Set([...fromBody, ...fromHeader])].map((t) => t.slice(0, 200)).slice(0, 20);
  return all.length ? all : undefined;
}

/** A piece of text in the request that guardrails read and may rewrite (PII masking). */
export interface TextSlot {
  role: 'system' | 'user' | 'assistant';
  get(): string;
  set(text: string): void;
}

function blockSlots(role: TextSlot['role'], blocks: any[], out: TextSlot[]) {
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') out.push({ role, get: () => b.text, set: (t) => (b.text = t) });
    else if (b.type === 'tool_result') {
      if (typeof b.content === 'string') out.push({ role: 'user', get: () => b.content, set: (t) => (b.content = t) });
      else if (Array.isArray(b.content)) blockSlots('user', b.content, out);
    }
    // thinking / redacted_thinking (signed), tool_use inputs, images, documents and server-tool blocks are left alone.
  }
}

/** Every guardrail-visible text in a Messages body. The slots write back into `body` (pass a copy). */
export function textSlots(body: MessagesBody): TextSlot[] {
  const out: TextSlot[] = [];
  if (typeof body.system === 'string') out.push({ role: 'system', get: () => body.system as string, set: (t) => (body.system = t) });
  else if (Array.isArray(body.system)) blockSlots('system', body.system, out);
  for (const m of body.messages) {
    if (typeof m.content === 'string') out.push({ role: m.role, get: () => m.content as string, set: (t) => (m.content = t) });
    else blockSlots(m.role, m.content as any[], out);
  }
  return out;
}

/** The OpenAI-shaped view guardrails, routing and token estimates work on. */
export function slotView(slots: TextSlot[]): ChatMessage[] {
  return slots.map((s) => ({ role: s.role, content: s.get() }));
}

/** The vault with values escaped for use inside a JSON string literal (tool_use inputs). */
function jsonVault(vault?: Map<string, string>): Map<string, string> | undefined {
  if (!vault?.size) return undefined;
  return new Map([...vault].map(([k, v]) => [k, JSON.stringify(v).slice(1, -1)]));
}

/** Text of a non-streamed Messages response (for output guardrails). */
export function messageText(msg: any): string {
  return (Array.isArray(msg?.content) ? msg.content : [])
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

/** Puts masked PII back into a non-streamed response: text blocks and client tool inputs. */
export function restoreMessage(msg: any, vault?: Map<string, string>): any {
  if (!vault?.size || !Array.isArray(msg?.content)) return msg;
  const jv = jsonVault(vault);
  for (const b of msg.content) {
    if (b?.type === 'text' && typeof b.text === 'string') b.text = restorePii(b.text, vault);
    else if (b?.type === 'tool_use' && b.input !== undefined) {
      try {
        b.input = JSON.parse(restorePii(JSON.stringify(b.input), jv));
      } catch {
        /* keep the masked input */
      }
    }
  }
  return msg;
}

/**
 * Restores masked PII in a Messages event stream. Text and client tool-input deltas go
 * through a per-block restorer that holds back a possibly split placeholder; the held
 * tail is emitted as one more delta just before the block's content_block_stop.
 */
export class MessagesStreamRestorer {
  private readonly blocks = new Map<number, { kind: 'text' | 'json'; r: StreamRestorer }>();
  private readonly jv?: Map<string, string>;

  constructor(private readonly vault?: Map<string, string>) {
    this.jv = jsonVault(vault);
  }

  transform(ev: any): any[] {
    if (!this.vault?.size || !ev || typeof ev !== 'object') return [ev];
    switch (ev.type) {
      case 'content_block_start': {
        const t = ev.content_block?.type;
        if (t === 'text') {
          this.blocks.set(ev.index, { kind: 'text', r: new StreamRestorer(this.vault) });
          if (typeof ev.content_block.text === 'string' && ev.content_block.text) ev.content_block.text = restorePii(ev.content_block.text, this.vault);
        } else if (t === 'tool_use') this.blocks.set(ev.index, { kind: 'json', r: new StreamRestorer(this.jv) });
        return [ev];
      }
      case 'content_block_delta': {
        const b = this.blocks.get(ev.index);
        if (b?.kind === 'text' && ev.delta?.type === 'text_delta') ev.delta.text = b.r.push(ev.delta.text ?? '');
        else if (b?.kind === 'json' && ev.delta?.type === 'input_json_delta') ev.delta.partial_json = b.r.push(ev.delta.partial_json ?? '');
        return [ev];
      }
      case 'content_block_stop': {
        const b = this.blocks.get(ev.index);
        this.blocks.delete(ev.index);
        const tail = b?.r.flush();
        if (!b || !tail) return [ev];
        const delta = b.kind === 'text' ? { type: 'text_delta', text: tail } : { type: 'input_json_delta', partial_json: tail };
        return [{ type: 'content_block_delta', index: ev.index, delta }, ev];
      }
      default:
        return [ev];
    }
  }
}

/** Relay error -> Anthropic error type, so Anthropic SDKs raise the right exception class. */
export function anthropicErrorType(status: number, type: string): string {
  if (status === 529) return 'overloaded_error';
  if (type === 'insufficient_quota') return 'billing_error';
  if (status === 413) return 'request_too_large';
  if (status === 404) return 'not_found_error';
  if (['invalid_request_error', 'authentication_error', 'permission_error', 'rate_limit_error'].includes(type)) return type;
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  return status >= 500 ? 'api_error' : 'invalid_request_error';
}

export function anthropicErrorBody(status: number, type: string, message: string, requestId?: string) {
  return { type: 'error', error: { type: anthropicErrorType(status, type), message }, ...(requestId ? { request_id: requestId } : {}) };
}
