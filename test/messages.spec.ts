import { describe, expect, it } from 'vitest';
import { checkInput, mergePolicies } from '../src/guardrails/engine';
import { anthropicErrorBody, anthropicErrorType, messageText, MessagesStreamRestorer, relayTags, restoreMessage, slotView, textSlots, validateMessages } from '../src/gateway/messages';
import { AnthropicAdapter } from '../src/providers/adapters/anthropic.adapter';

const pii = mergePolicies([{ id: 'p', config: { pii: { mode: 'mask_restore', entities: ['email'] } } as any }])!;

describe('/v1/messages helpers', () => {
  it('validates the Messages body', () => {
    expect(() => validateMessages([])).toThrow(/JSON object/);
    expect(() => validateMessages({ messages: [] })).toThrow(/at least one/);
    expect(() => validateMessages({ messages: [{ role: 'system', content: 'x' }] })).toThrow(/role/);
    expect(() => validateMessages({ messages: [{ role: 'user', content: 1 }] })).toThrow(/content/);
    expect(() => validateMessages({ messages: [{ role: 'user', content: 'x' }], relay: { prompt: { slug: 'p' } } })).toThrow(/Managed prompts/);
    expect(validateMessages({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }).model).toBe('m');
  });

  it('merges relay.tags with the x-relay-tags header', () => {
    expect(relayTags({ messages: [], relay: { tags: ['a', 'b'] } }, 'b, c ,')).toEqual(['a', 'b', 'c']);
    expect(relayTags({ messages: [] }, undefined)).toBeUndefined();
  });

  it('masks PII in text, system and tool results but never in thinking blocks or tool inputs', () => {
    const body: any = {
      system: [{ type: 'text', text: 'Owner: boss@corp.com', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: 'Mail jane@example.com' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'user wants jane@example.com', signature: 'sig' },
            { type: 'tool_use', id: 't1', name: 'send', input: { to: 'jane@example.com' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'sent to jane@example.com' }] }] },
      ],
    };
    const slots = textSlots(body);
    expect(slots.map((s) => s.role)).toEqual(['system', 'user', 'user']);
    const check = checkInput(slotView(slots), pii);
    check.messages.forEach((m, i) => slots[i].set(m.content as string));
    expect(body.system[0].text).toBe('Owner: [EMAIL_1]');
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[0].content).toBe('Mail [EMAIL_2]');
    expect(body.messages[2].content[0].content[0].text).toBe('sent to [EMAIL_2]');
    expect(body.messages[1].content[0].thinking).toBe('user wants jane@example.com');
    expect(body.messages[1].content[1].input.to).toBe('jane@example.com');

    const msg = restoreMessage(
      { content: [{ type: 'thinking', thinking: '[EMAIL_2]', signature: 's' }, { type: 'text', text: 'Done, [EMAIL_2].' }, { type: 'tool_use', id: 't', name: 'n', input: { to: '[EMAIL_2]' } }] },
      check.vault,
    );
    expect(msg.content[0].thinking).toBe('[EMAIL_2]');
    expect(msg.content[1].text).toBe('Done, jane@example.com.');
    expect(msg.content[2].input.to).toBe('jane@example.com');
    expect(messageText(msg)).toBe('Done, jane@example.com.');
  });

  it('restores placeholders split across stream deltas, escaping inside tool JSON', () => {
    const vault = new Map([['[EMAIL_1]', 'a"b@x.io']]);
    const r = new MessagesStreamRestorer(vault);
    const out: any[] = [];
    const feed = (ev: any) => out.push(...r.transform(ev));
    feed({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    feed({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '[EMAIL_1]' } });
    feed({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    feed({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi [EMA' } });
    feed({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'IL_1] and [EMAIL' } });
    feed({ type: 'content_block_stop', index: 1 });
    feed({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't', name: 'n', input: {} } });
    feed({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"to":"[EMAIL_1]"}' } });
    feed({ type: 'content_block_stop', index: 2 });
    const text = out.filter((e) => e.index === 1 && e.delta?.type === 'text_delta').map((e) => e.delta.text).join('');
    expect(text).toBe('Hi a"b@x.io and [EMAIL');
    expect(out.find((e) => e.delta?.type === 'thinking_delta').delta.thinking).toBe('[EMAIL_1]');
    const json = out.filter((e) => e.index === 2 && e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join('');
    expect(JSON.parse(json)).toEqual({ to: 'a"b@x.io' });
    expect(out[out.length - 1]).toEqual({ type: 'content_block_stop', index: 2 });
  });

  it('passes events through untouched without a vault', () => {
    const ev = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '[EMAIL_1]' } };
    expect(new MessagesStreamRestorer(undefined).transform(ev)).toEqual([ev]);
  });

  it('maps errors to Anthropic error types', () => {
    expect(anthropicErrorType(429, 'insufficient_quota')).toBe('billing_error');
    expect(anthropicErrorType(529, 'api_error')).toBe('overloaded_error');
    expect(anthropicErrorType(401, 'authentication_error')).toBe('authentication_error');
    expect(anthropicErrorType(502, 'api_error')).toBe('api_error');
    expect(anthropicErrorType(400, 'whatever')).toBe('invalid_request_error');
    expect(anthropicErrorBody(400, 'invalid_request_error', 'bad', 'r1')).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' }, request_id: 'r1' });
  });

  it('meters Anthropic usage with cache reads and writes', () => {
    expect(AnthropicAdapter.usageOf({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 })).toEqual({
      inputTokens: 130, outputTokens: 5, cachedTokens: 100, cacheWriteTokens: 20,
    });
  });
});
