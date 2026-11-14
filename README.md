# Relay — Internal LLM Gateway

One secure, OpenAI-compatible API in front of every local and cloud LLM. Applications call Relay instead of providers; Relay handles routing, token and cost metering, spend caps, prompt versioning, caching, PII redaction, guardrails and a tamper-evident audit trail, so each team doesn't have to rebuild these.

- **Providers**: OpenAI, Anthropic, Google Gemini, Azure OpenAI, DeepSeek, Mistral, Groq, xAI, Together, Fireworks, OpenRouter, Perplexity, Cohere, Azure AI Foundry, Bedrock (OpenAI endpoint), Ollama/vLLM/LM Studio, any OpenAI-compatible API, and templated custom HTTP APIs.
- **APIs**: OpenAI Chat Completions for every provider, plus the native Anthropic Messages API (`/v1/messages`) for Anthropic models, with thinking, prompt caching and server tools intact ([docs/api.md](docs/api.md#anthropic-messages-api-v1messages)).
- **Keys** per app and entity (developer, environment, service) with access scopes, limits, IP allowlists and immutable expiry; deactivate, reactivate, regenerate or revoke, never delete.
- **Cost tracking** per app, entity, key, provider and model with editable, versioned pricing; dashboards, reports and CSV export.
- **Spend caps** on any combination of app / entity / key / provider / model, per day / week / month / lifetime, block or notify.
- **Routing**: fallback, load balancing, cheapest, auto cheap-vs-strong; retries with backoff.
- **Security**: AES-256-GCM encrypted secrets, HMAC-hashed keys, Argon2id, TOTP MFA, RBAC, CSRF, IP allowlists, hash-chained audit log.
- **Email notifications** via Microsoft Graph or SMTP (configured in the UI), plus Slack/Teams/JSON webhooks.
- **Runs on** PostgreSQL or MongoDB; Docker and Azure Web App ready.

```bash
cp .env.example .env    # set RELAY_MASTER_KEY (npm run gen:key) and POSTGRES_PASSWORD
docker compose up -d --build
docker compose logs relay | grep -A3 "Initial owner"
# open http://localhost:8080
```

```python
from openai import OpenAI
client = OpenAI(base_url="https://relay.example.com/v1", api_key="rly_...")
client.chat.completions.create(model="smart", messages=[{"role": "user", "content": "Hello"}])
```

Documentation: [docs/](docs/README.md) — start with [Getting started](docs/getting-started.md) and [Integrating an application](docs/api.md).

## Development

```bash
npm install && npm --prefix web install
npm run dev          # API with watch (needs DB_TYPE, DATABASE_URL, RELAY_MASTER_KEY)
npm run dev:web      # admin UI on :5173
npm test             # unit tests
npm run typecheck
```
