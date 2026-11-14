# Integrating an application (public API)

Relay exposes one public surface: an **OpenAI-compatible API under `/v1`**. If your code already uses an OpenAI SDK, you only change the base URL and the key.

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat/completions` | Chat completions for every provider (streaming and non-streaming, tools, vision) |
| `POST /v1/embeddings` | Embeddings (OpenAI-compatible providers, Azure OpenAI, Gemini) |
| `POST /v1/batch` | Run up to 100 chat requests in parallel in one call |
| `GET /v1/models` | Models and routes this key may use |

## Authentication

Send your Relay key (`rly_...`) as a bearer token. `x-api-key: rly_...` is also accepted.

```
Authorization: Bearer rly_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are bound to one app and one entity. They can be restricted to providers, models or routes, to IP ranges, and limited by requests/minute, tokens/minute, tokens per request, concurrency and spend caps. Store keys in your secret store (Key Vault, GitHub secrets...), never in source control.

## Choosing a model

The `model` field accepts:

| Value | Example | Meaning |
|---|---|---|
| Model slug | `openai/gpt-4.1-mini`, `anthropic/claude-sonnet-5-5` | `<provider-slug>/<model-id>` exactly as listed by `GET /v1/models` |
| Bare model id | `gpt-4.1-mini` | Accepted when only one provider offers it |
| Route | `smart`, `cheap`, `resilient` | A Relay route that picks the model (fallback, load balancing, cheapest, or auto cheap/strong) |
| *(empty)* | | The app's default model, if configured |

Prefer **routes** in application code: admins can then change providers, fail over or cut costs without a redeploy.

## Examples

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="https://relay.example.com/v1", api_key=os.environ["RELAY_API_KEY"])

resp = client.chat.completions.create(
    model="smart",
    messages=[{"role": "user", "content": "Summarise this ticket in one line: ..."}],
    user="customer-1234",            # optional end-user id, appears in reports
)
print(resp.choices[0].message.content)
```

### TypeScript / JavaScript

```ts
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'https://relay.example.com/v1', apiKey: process.env.RELAY_API_KEY });

const stream = await client.chat.completions.create({
  model: 'anthropic/claude-sonnet-5-5',
  messages: [{ role: 'user', content: 'Write a haiku about gateways' }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
```

### C# (.NET, OpenAI library)

```csharp
var client = new OpenAI.Chat.ChatClient(
    model: "smart",
    credential: new System.ClientModel.ApiKeyCredential(Environment.GetEnvironmentVariable("RELAY_API_KEY")),
    options: new OpenAI.OpenAIClientOptions { Endpoint = new Uri("https://relay.example.com/v1") });
var result = await client.CompleteChatAsync("Hello from .NET");
```

### LangChain / LlamaIndex / others

Use their OpenAI integration with `base_url`/`baseURL` pointed at Relay.

## Request format

Standard OpenAI Chat Completions fields are supported: `messages` (system, developer, user, assistant, tool; text and `image_url` parts), `temperature`, `top_p`, `max_tokens` / `max_completion_tokens`, `stop`, `tools`, `tool_choice`, `response_format`, `reasoning_effort`, `seed`, `user`, `stream`, `stream_options.include_usage`. Relay translates them for Anthropic, Gemini and custom providers.

Notes:
- `n` must be 1.
- Some newer models reject sampling parameters; Relay drops `temperature`/`top_p` for models flagged that way in the catalog.
- `reasoning_effort` is mapped to Anthropic's `output_config.effort`.

### Relay extensions (`relay` field)

Optional, ignored by providers:

```json
{
  "model": "smart",
  "messages": [{ "role": "user", "content": "Classify: {{ticket}}" }],
  "relay": {
    "prompt": { "slug": "ticket-classifier", "label": "production", "variables": { "ticket": "..." } },
    "cache": false,
    "tags": ["feature:triage", "tenant:acme"],
    "providerOptions": { "top_k": 40 }
  }
}
```

| Field | Effect |
|---|---|
| `prompt` | Use a managed prompt: `slug` or `id`, plus `version` or `label` (default `production`). The template's messages are prepended to yours; `{{variables}}` are filled from `variables`. The prompt version is recorded with the request. |
| `cache` | `false` bypasses the response cache; `true` or `{ "ttlSeconds": 600 }` enables it for this request even if the app has caching off. |
| `tags` | Up to 20 labels stored with the usage record for reporting. |
| `providerOptions` | Raw fields merged into the upstream request body (escape hatch for provider-specific features). |

## Streaming

`stream: true` returns Server-Sent Events in the OpenAI chunk format for every provider, ending with `data: [DONE]`. Add `stream_options: {"include_usage": true}` to receive a final usage chunk. Relay can fall back to another route target only **before** the first byte is sent; after that an upstream failure is reported as an `error` event in the stream.

## Anthropic Messages API (`/v1/messages`)

For Anthropic models Relay also speaks the native [Messages API](https://docs.anthropic.com/en/api/messages), so the Anthropic SDKs work unchanged. Point them at Relay with a Relay key:

```python
import anthropic
client = anthropic.Anthropic(base_url="https://relay.example.com", api_key=os.environ["RELAY_API_KEY"])
msg = client.messages.create(model="anthropic/claude-opus-5-5", max_tokens=4096, thinking={"type": "adaptive"},
                             messages=[{"role": "user", "content": "Hello"}])
```

```ts
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ baseURL: 'https://relay.example.com', apiKey: process.env.RELAY_API_KEY });
```

The request body is forwarded to Anthropic as sent, with only `model` swapped for the provider's model id. Everything the Messages API supports therefore works: thinking blocks and their signatures, `cache_control` breakpoints and top-level caching, server tools (web search, code execution and the rest), citations, `output_config`, and beta features. Your `anthropic-beta` header is merged with the provider's configured betas, and your `anthropic-version` header is forwarded. Responses and stream events come back exactly as Anthropic sends them.

What still applies, as on `/v1/chat/completions`:

- Keys, rate limits, concurrency limits, IP allowlists and spend caps.
- Routing and fallback. `model` may be a model slug or a route; route targets that are not Anthropic models are skipped. If nothing Anthropic remains, the request fails with `400` and you should use `/v1/chat/completions`.
- Guardrails. They read the text in `system`, `text` blocks and `tool_result` blocks. Masked PII is restored in the response's text blocks and client `tool_use` inputs, streamed or not. Thinking blocks are never changed, because their signature covers their content.
- Metering. Cache reads and cache writes are recorded and priced separately; usage rows show endpoint `messages`.
- Tags: `relay.tags` in the body (stripped before forwarding), or an `x-relay-tags: a,b` header for SDKs whose types reject extra fields. `relay.providerOptions` is merged into the body.

Differences:

- The response cache is never used. Messages requests usually carry tool loops, thinking or cache breakpoints, where replaying a stored answer is wrong.
- Managed prompts (`relay.prompt`) are not available.
- Errors use Anthropic's envelope: `{"type":"error","error":{"type":"rate_limit_error","message":"..."}}`. A reached spend cap is `billing_error`.

## Embeddings

```bash
curl https://relay.example.com/v1/embeddings -H "Authorization: Bearer $RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/text-embedding-3-small","input":["first text","second text"]}'
```

## Batch (parallel requests in one call)

```json
POST /v1/batch
{
  "concurrency": 10,
  "requests": [
    { "custom_id": "row-1", "body": { "model": "cheap", "messages": [{ "role": "user", "content": "..." }] } },
    { "custom_id": "row-2", "body": { "model": "cheap", "messages": [{ "role": "user", "content": "..." }] } }
  ]
}
```

Response: `{ "object": "batch.result", "results": [{ "custom_id": "row-1", "status": 200, "request_id": "...", "response": { ... } }, { "custom_id": "row-2", "status": 429, "error": { ... } }] }`. Up to 100 requests, concurrency 1–25 (default 10). Each item is authorised, limited and metered individually. You can also simply send many requests concurrently: Relay is designed for high parallelism (see [scaling.md](scaling.md)).

## Response headers

| Header | Meaning |
|---|---|
| `x-relay-request-id` | Unique id; quote it when asking for support (searchable in **Requests**) |
| `x-relay-model` | The model slug that actually served the request (after routing/fallback) |
| `x-relay-cache` | `HIT` or `MISS` |
| `x-relay-cost-usd` | Cost of this request (non-streaming; can be disabled in Settings → Gateway) |
| `x-relay-route-decision` | For `auto` routes: which tier was chosen and why |

## Errors

Errors use the OpenAI envelope so SDKs surface them normally:

```json
{ "error": { "message": "Spend cap \"SCIC monthly\" has been reached for this monthly period", "type": "insufficient_quota", "code": "budget_exceeded", "param": null } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `bad_request`, `invalid_json`, `model_required`, `guardrail_blocked`, `prompt_error`, `request_too_large` | Fix the request |
| 401 | `invalid_api_key` | Missing, wrong, inactive, expired or revoked key |
| 403 | `model_not_allowed`, `ip_not_allowed`, `app_disabled`, `entity_disabled` | Key not permitted |
| 404 | `model_not_found` | Unknown or disabled model/route |
| 422 | `output_blocked` | The response violated an output policy |
| 429 | `rate_limit_exceeded`, `token_rate_limit_exceeded`, `concurrency_limit_exceeded`, `budget_exceeded` | Back off (`Retry-After`) or ask an admin to raise limits |
| 502/503/504 | `upstream_error`, `no_available_model`, `upstream_timeout` | Provider problem after retries and fallbacks |

Retry 429 and 5xx with exponential backoff; do not retry 400–404.

## Guardrails and PII

Admins attach guardrail policies to your app. Depending on the policy, Relay may:
- **redact** personal data (`jane@acme.com` → `[EMAIL]`) before it reaches the model,
- **mask and restore** it (the model sees `[EMAIL_1]`, your app receives the original value back),
- **block** requests containing PII, blocked keywords/patterns, prompt-injection attempts or too many tokens.

Blocked requests return `400 guardrail_blocked` with the reason.
