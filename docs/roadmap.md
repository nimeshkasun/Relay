# Roadmap & market comparison

## Where Relay stands

Competitor columns reflect publicly documented features at the time of writing and change frequently; treat them as indicative and re-check before using this table for a decision.

| Capability | Relay | LiteLLM Proxy | Portkey | Helicone | Kong AI Gateway | Cloudflare AI Gateway |
|---|---|---|---|---|---|---|
| OpenAI-compatible unified API | ✅ | ✅ | ✅ | ✅ (proxy) | ✅ | ✅ |
| Major cloud + local + custom HTTP providers | ✅ | ✅ (more providers) | ✅ | ✅ | ✅ | ✅ |
| Virtual keys per app **and** per entity, immutable expiry, regenerate keeps history | ✅ | Partial (keys/teams/users) | ✅ | Partial | Via consumers | Partial |
| Spend caps on any app/entity/key/provider/model combination & period | ✅ | Partial (key/user/team budgets) | ✅ (enterprise) | ❌ | Plugins | Partial |
| Cost per app/entity/key/provider/model, editable & versioned pricing | ✅ | ✅ | ✅ | ✅ | Partial | ✅ |
| Routing: fallback, load balance, cheapest, auto cheap/strong | ✅ | ✅ | ✅ | Partial | ✅ | Partial |
| Prompt versioning with labels | ✅ | Partial | ✅ | ✅ | ❌ | ❌ |
| Response cache (encrypted, per-app) | ✅ exact | ✅ exact + semantic | ✅ exact + semantic | ✅ | ✅ semantic | ✅ exact |
| PII redaction incl. reversible masking | ✅ | Via integrations | ✅ | ❌ | ✅ (plugins) | Partial |
| Guardrails (patterns, injection, token limits) | ✅ built-in | Via integrations | ✅ | ❌ | ✅ | Partial |
| Tamper-evident audit log | ✅ hash chain | Logs | Logs | ❌ | Logs | Logs |
| Encrypted secrets, MFA, RBAC, IP allowlists | ✅ | Partial (enterprise SSO) | ✅ | ✅ | ✅ | ✅ |
| PostgreSQL **and** MongoDB | ✅ | PostgreSQL | SaaS | ClickHouse/PG | — | SaaS |
| Self-hosted, no per-request fees, data stays in our tenant | ✅ | ✅ | Partial | ✅ | ✅ | ❌ |

## Recommended next features

Prioritised by value for Axiom, SCIC, Cleo and future projects.

### Next (high value, low effort)
1. **SSO for the admin console (Microsoft Entra ID / OIDC)** with group → role mapping; keep local accounts as break-glass.
2. **OpenAI Responses API passthrough** so teams can use OpenAI-specific SDK features while still being metered. (Native Anthropic `/v1/messages` is done: see [api.md](api.md#anthropic-messages-api-v1messages).)
3. **Semantic cache** (embedding similarity with a configurable threshold) for FAQ-style workloads.
4. **Distributed rate limiting** (Redis or DB counters) for exact cluster-wide RPM/TPM.
5. **OpenTelemetry traces & Prometheus metrics** (`/metrics`): latency percentiles, TTFT, tokens/sec per model; Azure Monitor integration.
6. **Per-key/app chargeback reports** scheduled by email (monthly PDF/CSV to app owners).

### Later
7. **Evaluations & A/B testing**: split traffic between prompt versions or models, score outputs (LLM-as-judge, user feedback API), compare cost vs. quality.
8. **Request/response feedback API** (`POST /v1/feedback {request_id, score}`) to link quality signals to cost.
9. **Advanced guardrails**: pluggable classifiers (Azure AI Content Safety, Presidio NER for names/addresses, LLM-based moderation), topic allowlists, jailbreak scoring.
10. **Batch/async jobs** using provider batch APIs (≈50% cheaper) with webhooks on completion.
11. **Model health & smart routing**: track live latency/error rates per target and route away automatically (circuit breaker), latency-based load balancing.
12. **Budget forecasting** and anomaly detection (sudden spend spikes per key).
13. **Data residency controls**: tag providers/models by region and restrict apps to compliant regions.
14. **Tool/MCP gateway**: central registry of MCP servers/tools with the same keys, auditing and policies.
15. **Self-service portal for app teams** to request keys with approval workflow.
16. **Usage table partitioning/archival** to cold storage (Azure Blob/Parquet) for multi-year analytics.
17. **AWS Bedrock (SigV4) and Vertex AI (OAuth) native adapters**, in addition to their OpenAI-compatible endpoints.
