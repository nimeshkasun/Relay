import { ChatMessage, ChatRequest, ChatResponse, ContentPart, emptyUsage, textOf, ToolCall, Usage } from '../../gateway/types';
import { AdapterContext, ChatResult, chunkId, doFetch, httpJson, ProviderAdapter, ProviderError, ProviderRuntime, sseEvents, StreamItem, upstreamError } from './base';

const FINISH: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter', pause_turn: 'stop' };

function imageBlock(part: any) {
  const url: string = part.image_url?.url ?? '';
  const m = url.match(/^data:([^;]+);base64,(.*)$/);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  return { type: 'image', source: { type: 'url', url } };
}

function contentBlocks(content: ChatMessage['content']): any[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return (content as ContentPart[])
    .map((p: any) => (p.type === 'text' ? { type: 'text', text: p.text } : p.type === 'image_url' ? imageBlock(p) : p))
    .filter((b: any) => !(b.type === 'text' && !b.text));
}

/** Converts OpenAI-style messages to the Anthropic Messages API format. */
export function toAnthropic(messages: ChatMessage[]): { system?: string; messages: any[] } {
  const system: string[] = [];
  const out: { role: 'user' | 'assistant'; content: any[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      system.push(textOf(m.content));
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: textOf(m.content) }]);
    } else if (m.role === 'assistant') {
      const blocks = contentBlocks(m.content);
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          input = { _raw: tc.function.arguments };
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      push('assistant', blocks);
    } else {
      push('user', contentBlocks(m.content));
    }
  }
  return { system: system.length ? system.join('\n\n') : undefined, messages: out };
}

export class AnthropicAdapter implements ProviderAdapter {
  private base(p: ProviderRuntime) {
    return (p.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  }

  private headers(p: ProviderRuntime): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': p.secrets.apiKey ?? '',
      'anthropic-version': p.config.anthropicVersion || '2023-06-01',
    };
    if (p.config.betas) h['anthropic-beta'] = String(p.config.betas);
    for (const [k, v] of Object.entries<string>(p.config.headers ?? {})) h[k] = v;
    return h;
  }

  body(ctx: AdapterContext, req: ChatRequest, stream: boolean): Record<string, unknown> {
    const { system, messages } = toAnthropic(req.messages);
    const body: Record<string, unknown> = {
      model: ctx.model.providerModelId,
      messages,
      max_tokens: req.max_completion_tokens ?? req.max_tokens ?? ctx.model.maxOutputTokens ?? 8192,
      stream,
    };
    if (system) body.system = system;
    if (ctx.model.capabilities.sampling !== false) {
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.top_p !== undefined) body.top_p = req.top_p;
    }
    if (req.stop) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: 'object', properties: {} } }));
    }
    if (req.tool_choice) {
      const tc = req.tool_choice;
      body.tool_choice = tc === 'auto' ? { type: 'auto' } : tc === 'none' ? { type: 'none' } : tc === 'required' ? { type: 'any' } : { type: 'tool', name: tc.function.name };
    }
    if (req.reasoning_effort) body.output_config = { effort: req.reasoning_effort };
    if (req.user) body.metadata = { user_id: String(req.user).slice(0, 256) };
    Object.assign(body, req.relay?.providerOptions ?? {});
    return body;
  }

  private usage(u: any): Usage {
    return AnthropicAdapter.usageOf(u);
  }

  async chat(ctx: AdapterContext, req: ChatRequest): Promise<ChatResult> {
    const json = await httpJson(`${this.base(ctx.provider)}/v1/messages`, {
      method: 'POST',
      headers: this.headers(ctx.provider),
      body: JSON.stringify(this.body(ctx, req, false)),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const b of json.content ?? []) {
      if (b.type === 'text') text += b.text;
      else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
    }
    const usage = this.usage(json.usage);
    const response: ChatResponse = {
      id: json.id ?? chunkId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: ctx.model.slug,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text || (toolCalls.length ? null : ''), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
          finish_reason: FINISH[json.stop_reason] ?? json.stop_reason ?? 'stop',
        },
      ],
      usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens, prompt_tokens_details: { cached_tokens: usage.cachedTokens } },
    };
    return { response, usage };
  }

  async *chatStream(ctx: AdapterContext, req: ChatRequest): AsyncGenerator<StreamItem> {
    const res = await doFetch(`${this.base(ctx.provider)}/v1/messages`, {
      method: 'POST',
      headers: { ...this.headers(ctx.provider), Accept: 'text/event-stream' },
      body: JSON.stringify(this.body(ctx, req, true)),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    if (!res.ok) throw upstreamError(res.status, await res.text());
    const id = chunkId();
    const created = Math.floor(Date.now() / 1000);
    const mk = (delta: any, finish: string | null = null) => ({
      chunk: { id, object: 'chat.completion.chunk' as const, created, model: ctx.model.slug, choices: [{ index: 0, delta, finish_reason: finish }] },
    });
    const usage = emptyUsage();
    const toolIndex = new Map<number, number>();
    let toolCount = 0;
    for await (const ev of sseEvents(res)) {
      let d: any;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (d.type) {
        case 'message_start': {
          const u = this.usage(d.message?.usage);
          Object.assign(usage, { ...u, outputTokens: u.outputTokens });
          yield mk({ role: 'assistant', content: '' });
          break;
        }
        case 'content_block_start':
          if (d.content_block?.type === 'tool_use') {
            const idx = toolCount++;
            toolIndex.set(d.index, idx);
            yield mk({ tool_calls: [{ index: idx, id: d.content_block.id, type: 'function', function: { name: d.content_block.name, arguments: '' } }] });
          }
          break;
        case 'content_block_delta':
          if (d.delta?.type === 'text_delta') yield mk({ content: d.delta.text });
          else if (d.delta?.type === 'input_json_delta') yield mk({ tool_calls: [{ index: toolIndex.get(d.index) ?? 0, function: { arguments: d.delta.partial_json } }] });
          break;
        case 'message_delta':
          if (d.usage) {
            usage.outputTokens = d.usage.output_tokens ?? usage.outputTokens;
            if (d.usage.input_tokens !== undefined) {
              const u = this.usage(d.usage);
              usage.inputTokens = u.inputTokens;
              usage.cachedTokens = u.cachedTokens;
              usage.cacheWriteTokens = u.cacheWriteTokens;
            }
          }
          if (d.delta?.stop_reason) yield mk({}, FINISH[d.delta.stop_reason] ?? 'stop');
          break;
        case 'error':
          throw new ProviderError(`Upstream stream error: ${d.error?.message ?? 'unknown'}`, 502, d.error?.type === 'overloaded_error', 'upstream_stream_error');
        default:
          break;
      }
    }
    yield { usage };
  }

  /**
   * Native Messages API passthrough (POST /v1/messages on Relay): the client's body is sent
   * as-is with the model id swapped, so thinking blocks, cache_control, server tools and
   * every other Messages feature survive. Client beta flags are merged with the provider's.
   * Returns the raw upstream response; non-2xx statuses are thrown as ProviderError.
   */
  async native(ctx: AdapterContext, body: Record<string, unknown>, client: { version?: string; betas?: string }): Promise<Response> {
    const headers = this.headers(ctx.provider);
    if (client.version) headers['anthropic-version'] = client.version;
    const betas = new Set(
      [headers['anthropic-beta'], client.betas]
        .filter(Boolean)
        .flatMap((s) => String(s).split(','))
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (betas.size) headers['anthropic-beta'] = [...betas].join(',');
    else delete headers['anthropic-beta'];
    if (body.stream) headers.Accept = 'text/event-stream';
    const res = await doFetch(`${this.base(ctx.provider)}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, model: ctx.model.providerModelId }),
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
    if (!res.ok) throw upstreamError(res.status, await res.text());
    return res;
  }

  /** Anthropic usage block -> Relay usage (inputTokens includes cache reads and writes). */
  static usageOf(u: any): Usage {
    if (!u) return emptyUsage();
    const cached = u.cache_read_input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    return { inputTokens: (u.input_tokens ?? 0) + cached + write, outputTokens: u.output_tokens ?? 0, cachedTokens: cached, cacheWriteTokens: write };
  }

  async listModels(provider: ProviderRuntime, timeoutMs: number): Promise<string[]> {
    const json = await httpJson(`${this.base(provider)}/v1/models?limit=100`, { method: 'GET', headers: this.headers(provider), timeoutMs });
    return (json.data ?? []).map((m: any) => m.id);
  }
}
