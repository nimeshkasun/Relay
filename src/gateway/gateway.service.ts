import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CryptoService } from '../common/crypto.service';
import { clientIp, sleep } from '../common/util';
import { ApiKeyRow, AppRow, CatalogService, EntityRow, ModelRow, Snapshot } from '../catalog/catalog.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ipAllowed, SlidingWindowLimiter } from '../auth/security';
import { adapterFor, AdapterContext, ProviderError, sseEvents, StreamItem } from '../providers/adapters';
import { AnthropicAdapter } from '../providers/adapters/anthropic.adapter';
import { anthropicErrorType, messageText, MessagesBody, MessagesStreamRestorer, relayTags, restoreMessage, slotView, textSlots, validateMessages } from './messages';
import { checkInput, checkOutput, EffectivePolicy, mergePolicies, restorePii, StreamRestorer } from '../guardrails/engine';
import { PromptsService, renderPrompt } from '../prompts/prompts.controller';
import { BudgetsService } from './budgets.service';
import { ResponseCacheService } from './response-cache.service';
import { UsageRecord, UsageRecorder } from './usage-recorder.service';
import { computeCost, filterByKey, GatewayError, resolveModel, ResolvedRoute } from './router';
import { ChatChunk, ChatRequest, ChatResponse, EmbeddingRequest, emptyUsage, estimateMessagesTokens, estimateTokens, Usage } from './types';
import { KEY_PREFIX } from '../keys/keys.controller';

export interface KeyContext {
  key: ApiKeyRow;
  app: AppRow;
  entity: EntityRow;
  ip: string;
}

interface Prepared {
  requestId: string;
  started: number;
  kc: KeyContext;
  req: ChatRequest;
  requestedModel: string;
  policy: EffectivePolicy | null;
  vault?: Map<string, string>;
  flags: string[];
  redactions: number;
  promptId?: string;
  promptVersion?: number;
  resolved: ResolvedRoute;
  cacheKey?: string;
  cacheTtl: number;
  snap: Snapshot;
  timeoutMs: number;
  defaultRetries: number;
  logBodies: boolean;
  logRetentionDays: number;
  exposeCost: boolean;
  /** Set for POST /v1/messages: the Anthropic body sent upstream (after guardrails) and the client's version/beta headers. */
  native?: { body: MessagesBody; version?: string; betas?: string };
}

interface Outcome {
  model?: ModelRow;
  usage: Usage;
  status: UsageRecord['status'];
  httpStatus: number;
  attempts: number;
  cacheHit?: boolean;
  savedUsd?: number;
  ttftMs?: number;
  error?: GatewayError | ProviderError;
  response?: unknown;
}

const MAX_MESSAGES = 2000;

/**
 * The request pipeline behind the public /v1 API. Everything here is async and
 * lock-free: per-request state lives on the stack, shared state is read from the
 * in-memory catalog, and analytics are written behind the request, so a single
 * instance handles many concurrent requests and instances scale horizontally.
 */
@Injectable()
export class GatewayService {
  private readonly logger = new Logger('Gateway');
  private readonly rpm = new SlidingWindowLimiter(60_000);
  private readonly tpm = new SlidingWindowLimiter(60_000);
  private readonly authFailures = new SlidingWindowLimiter(60_000);
  private readonly inflight = new Map<string, number>();
  private readonly providerAlerted = new Map<string, number>();

  constructor(
    private readonly crypto: CryptoService,
    private readonly catalog: CatalogService,
    private readonly settings: SettingsService,
    private readonly budgets: BudgetsService,
    private readonly cache: ResponseCacheService,
    private readonly recorder: UsageRecorder,
    private readonly prompts: PromptsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------------ auth
  async authenticate(req: Request): Promise<KeyContext> {
    const ip = clientIp(req);
    if (this.authFailures.count(ip) >= 30) throw new GatewayError(429, 'Too many failed authentication attempts', 'rate_limit_error', 'auth_rate_limited');
    const header = (req.headers.authorization as string | undefined) ?? '';
    const secret = (header.toLowerCase().startsWith('bearer ') ? header.slice(7) : (req.headers['x-api-key'] as string) || (req.headers['api-key'] as string) || '').trim();
    const fail = (msg: string, status = 401, code = 'invalid_api_key') => {
      this.authFailures.add(ip, 1);
      return new GatewayError(status, msg, status === 401 ? 'authentication_error' : 'permission_error', code);
    };
    if (!secret.startsWith(KEY_PREFIX) || secret.length < 40 || secret.length > 80) throw fail('Missing or malformed Relay API key');
    const hash = this.crypto.hmac(`apikey:${secret}`);
    const prev = this.crypto.hmacPrevious(`apikey:${secret}`);
    const key = await this.catalog.keyByHash(hash, prev);
    if (!key) throw fail('Invalid API key');
    if (key.status === 'revoked') throw fail('API key has been revoked');
    if (key.status !== 'active') throw fail('API key is inactive');
    if (key.expiresAt && new Date(key.expiresAt) <= new Date()) throw fail('API key has expired');
    let snap = await this.catalog.snapshot();
    // A key can reference an app/entity created moments ago (possibly on another instance)
    // that this process's cached snapshot doesn't contain yet: reload once before deciding.
    if (!snap.apps.has(key.appId) || !snap.entities.has(key.entityId)) snap = await this.catalog.refresh();
    const app = snap.apps.get(key.appId);
    const entity = snap.entities.get(key.entityId);
    if (!app || app.status !== 'active') throw fail('The application for this key is disabled', 403, 'app_disabled');
    if (!entity || entity.status !== 'active') throw fail('The entity for this key is disabled', 403, 'entity_disabled');
    if (!ipAllowed(ip, key.ipAllowlist)) throw fail('Requests from this IP address are not allowed for this key', 403, 'ip_not_allowed');
    return { key, app, entity, ip };
  }

  private async rateLimit(kc: KeyContext, defaultRpm: number) {
    const rpm = kc.key.limits?.rpm || defaultRpm;
    if (rpm && !this.rpm.hit(`k:${kc.key.id}`, rpm)) throw new GatewayError(429, `Rate limit exceeded (${rpm} requests/min for this key)`, 'rate_limit_error', 'rate_limit_exceeded');
    const appRpm = kc.app.settings?.rpm;
    if (appRpm && !this.rpm.hit(`a:${kc.app.id}`, appRpm)) throw new GatewayError(429, `Rate limit exceeded (${appRpm} requests/min for this app)`, 'rate_limit_error', 'rate_limit_exceeded');
    const tpm = kc.key.limits?.tpm;
    if (tpm && this.tpm.count(`k:${kc.key.id}`) >= tpm) throw new GatewayError(429, `Token rate limit exceeded (${tpm} tokens/min for this key)`, 'rate_limit_error', 'token_rate_limit_exceeded');
  }

  private acquire(kc: KeyContext): () => void {
    const max = kc.key.limits?.maxConcurrent;
    const n = (this.inflight.get(kc.key.id) ?? 0) + 1;
    if (max && n > max) throw new GatewayError(429, `Too many concurrent requests (max ${max} for this key)`, 'rate_limit_error', 'concurrency_limit_exceeded');
    this.inflight.set(kc.key.id, n);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.inflight.get(kc.key.id) ?? 1) - 1;
      if (left <= 0) this.inflight.delete(kc.key.id);
      else this.inflight.set(kc.key.id, left);
    };
  }

  // ------------------------------------------------------------------ prepare
  private validateChat(body: any): ChatRequest {
    if (!body || typeof body !== 'object') throw new GatewayError(400, 'Request body must be a JSON object');
    if (body.model !== undefined && typeof body.model !== 'string') throw new GatewayError(400, '"model" must be a string');
    if (!Array.isArray(body.messages)) body.messages = [];
    if (body.messages.length > MAX_MESSAGES) throw new GatewayError(400, `Too many messages (max ${MAX_MESSAGES})`);
    for (const m of body.messages) {
      if (!m || typeof m !== 'object' || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) throw new GatewayError(400, 'Each message needs a valid "role"');
    }
    if (body.n !== undefined && body.n !== 1) throw new GatewayError(400, 'Only n=1 is supported');
    return body as ChatRequest;
  }

  private async prepare(kc: KeyContext, body: unknown): Promise<Prepared> {
    const started = Date.now();
    const requestId = CryptoService.id();
    const gw = await this.settings.get('gateway');
    const routing = await this.settings.get('routing');
    await this.rateLimit(kc, gw.defaultKeyRpm);
    const snap = await this.catalog.snapshot();
    let req = this.validateChat(body);
    const requestedModel = req.model;

    // Managed prompt templates
    let promptId: string | undefined;
    let promptVersion: number | undefined;
    if (req.relay?.prompt) {
      const { prompt, version } = await this.prompts.resolve(req.relay.prompt).catch((e) => {
        throw new GatewayError(400, e.message, 'invalid_request_error', 'prompt_error');
      });
      if (prompt.appId && prompt.appId !== kc.app.id) throw new GatewayError(403, 'This prompt belongs to another application', 'permission_error', 'prompt_not_allowed');
      let rendered;
      try {
        rendered = renderPrompt(version.template, req.relay.prompt.variables ?? {});
      } catch (e: any) {
        throw new GatewayError(400, e.message, 'invalid_request_error', 'prompt_variables');
      }
      req = { ...version.template.params, ...req, model: req.model || version.template.model || '', messages: [...rendered, ...req.messages] };
      promptId = prompt.id;
      promptVersion = version.version;
    }
    if (!req.messages.length) throw new GatewayError(400, '"messages" must contain at least one message');

    // Guardrails: default policies + the app's policies
    const policies = snap.guardrails.filter((g) => g.isDefault || kc.app.settings?.guardrailPolicyIds?.includes(g.id));
    const policy = mergePolicies(policies.map((g) => ({ id: g.id, config: g.config })));
    const check = checkInput(req.messages, policy);
    if (check.blocked) {
      const err = new GatewayError(400, check.blocked, 'invalid_request_error', 'guardrail_blocked');
      this.recordBlocked(kc, requestId, started, requestedModel, err, check.flags, !!req.stream);
      throw err;
    }
    req = { ...req, messages: check.messages };
    if (policy?.maxOutputTokens) {
      const cap = policy.maxOutputTokens;
      if (req.max_completion_tokens !== undefined) req.max_completion_tokens = Math.min(req.max_completion_tokens, cap);
      else req.max_tokens = Math.min(req.max_tokens ?? cap, cap);
    }
    const perReq = kc.key.limits?.maxTokensPerRequest;
    if (perReq) {
      const est = estimateMessagesTokens(req.messages) + (req.max_completion_tokens ?? req.max_tokens ?? 0);
      if (est > perReq) throw new GatewayError(400, `Request exceeds this key's limit of ${perReq} tokens per request (estimated ${est})`, 'invalid_request_error', 'request_too_large');
    }

    const resolved = resolveModel(snap, req.model, kc.key, kc.app, 'chat', {
      messages: req.messages, hasTools: !!req.tools?.length, autoThreshold: routing.autoThresholdTokens, autoKeywords: routing.autoStrongKeywords,
    });
    resolved.candidates = filterByKey(resolved.candidates, kc.key, resolved.route);
    if (!resolved.candidates.length) throw new GatewayError(403, 'This key is not allowed to use any model behind this route', 'permission_error', 'model_not_allowed');

    const relayCache = req.relay?.cache;
    const cacheOn = relayCache === false ? false : relayCache ? true : !!kc.app.settings?.cacheEnabled;
    const cacheTtl = (typeof relayCache === 'object' && relayCache.ttlSeconds) || kc.app.settings?.cacheTtlSeconds || gw.defaultCacheTtlSeconds;
    return {
      requestId, started, kc, req, requestedModel, policy, vault: check.vault, flags: check.flags, redactions: check.redactions, promptId, promptVersion,
      resolved, cacheKey: cacheOn ? this.cache.key(kc.app.id, { ...req, model: requestedModel || req.model }) : undefined, cacheTtl, snap,
      timeoutMs: gw.requestTimeoutMs, defaultRetries: gw.defaultMaxRetries, logBodies: kc.app.settings?.logBodies ?? gw.storeRequestBodies,
      logRetentionDays: gw.requestLogRetentionDays, exposeCost: gw.exposeCostHeaders,
    };
  }

  // ------------------------------------------------------------------ chat
  async chat(kc: KeyContext, body: unknown, req: Request, res: Response): Promise<void> {
    const release = this.acquire(kc);
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', onClose);
    try {
      const p = await this.prepare(kc, body);
      res.setHeader('x-relay-request-id', p.requestId);
      if (p.resolved.decision) res.setHeader('x-relay-route-decision', p.resolved.decision);
      if (p.req.stream) await this.runStream(p, res, abort.signal);
      else {
        const result = await this.runChat(p, abort.signal);
        res.setHeader('x-relay-model', result.response.model);
        res.setHeader('x-relay-cache', result.cacheHit ? 'HIT' : 'MISS');
        if (p.exposeCost) res.setHeader('x-relay-cost-usd', result.costUsd.toFixed(8));
        res.status(200).json(result.response);
      }
    } finally {
      res.off('close', onClose);
      release();
    }
  }

  /** Non-streaming execution with cache, budgets, retries and fallback. Also used by /v1/batch. */
  async runChat(p: Prepared, signal?: AbortSignal): Promise<{ response: ChatResponse; costUsd: number; cacheHit: boolean }> {
    if (p.cacheKey) {
      const hit = await this.cache.get(p.cacheKey);
      if (hit) {
        const model = p.snap.models.get(hit.modelId);
        const response = this.finalizeResponse(p, structuredClone(hit.response));
        const saved = computeCost(hit.usage, model?.pricing).costUsd;
        this.finish(p, { model, usage: hit.usage, status: 'success', httpStatus: 200, attempts: 0, cacheHit: true, savedUsd: saved, response });
        return { response, costUsd: 0, cacheHit: true };
      }
    }
    let attempts = 0;
    let lastError: GatewayError | ProviderError | undefined;
    for (const model of p.resolved.candidates) {
      const blocked = await this.budgetBlock(p, model);
      if (blocked) {
        lastError = blocked;
        continue;
      }
      const provider = p.snap.providers.get(model.providerId)!;
      const ctx = this.adapterCtx(p, model, signal);
      const retries = provider.maxRetries ?? p.defaultRetries;
      for (let attempt = 0; attempt <= retries; attempt++) {
        attempts++;
        try {
          const { response, usage } = await adapterFor(provider.type).chat(ctx, p.req);
          const raw = structuredClone(response);
          const blockedOut = checkOutput(response.choices[0]?.message?.content ?? '', p.policy);
          if (blockedOut) {
            const err = new GatewayError(422, blockedOut, 'invalid_request_error', 'output_blocked');
            this.finish(p, { model, usage, status: 'blocked', httpStatus: 422, attempts, error: err });
            throw err;
          }
          const final = this.finalizeResponse(p, response);
          const cost = this.finish(p, { model, usage, status: 'success', httpStatus: 200, attempts, response: final });
          if (p.cacheKey && response.choices[0]?.finish_reason !== 'length') {
            void this.cache.set(p.cacheKey, p.kc.app.id, { response: raw, usage, modelId: model.id, providerId: model.providerId }, p.cacheTtl);
          }
          return { response: final, costUsd: cost, cacheHit: false };
        } catch (e: any) {
          if (e instanceof GatewayError) throw e;
          const err = e instanceof ProviderError ? e : new ProviderError(e?.message ?? 'Unknown error', 502, true);
          lastError = err;
          if (err.code === 'client_aborted') {
            this.finish(p, { model, usage: emptyUsage(), status: 'aborted', httpStatus: 499, attempts, error: err });
            throw new GatewayError(499, 'Client closed request', 'api_error', 'client_aborted');
          }
          this.alertProvider(provider.id, provider.name, err);
          if (err.retryable && attempt < retries) {
            await sleep(Math.min(8000, 300 * 2 ** attempt) + Math.random() * 200);
            continue;
          }
          if (!this.canFallback(err)) {
            this.finish(p, { model, usage: emptyUsage(), status: 'error', httpStatus: err.status, attempts, error: err });
            throw this.toGatewayError(err);
          }
          break;
        }
      }
    }
    const final = lastError ?? new GatewayError(503, 'No model available');
    this.finish(p, { model: p.resolved.candidates[0], usage: emptyUsage(), status: 'error', httpStatus: this.toGatewayError(final).status, attempts, error: final });
    throw this.toGatewayError(final);
  }

  private async runStream(p: Prepared, res: Response, signal: AbortSignal) {
    const created = Math.floor(Date.now() / 1000);
    const writeHead = (model: ModelRow, cacheHit: boolean) => {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('x-relay-model', model.slug);
      res.setHeader('x-relay-cache', cacheHit ? 'HIT' : 'MISS');
      res.flushHeaders();
    };
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const wantUsage = !!p.req.stream_options?.include_usage;

    // Cache hit: replay as a stream
    if (p.cacheKey) {
      const hit = await this.cache.get(p.cacheKey);
      if (hit) {
        const model = p.snap.models.get(hit.modelId);
        writeHead(model ?? ({ slug: hit.response.model } as ModelRow), true);
        const msg = hit.response.choices[0]?.message;
        const base = { id: hit.response.id, object: 'chat.completion.chunk', created, model: hit.response.model };
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: restorePii(msg?.content ?? '', p.vault) }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: hit.response.choices[0]?.finish_reason ?? 'stop' }] });
        if (wantUsage) send({ ...base, choices: [], usage: { prompt_tokens: hit.usage.inputTokens, completion_tokens: hit.usage.outputTokens, total_tokens: hit.usage.inputTokens + hit.usage.outputTokens } });
        res.write('data: [DONE]\n\n');
        res.end();
        this.finish(p, { model, usage: hit.usage, status: 'success', httpStatus: 200, attempts: 0, cacheHit: true, savedUsd: computeCost(hit.usage, model?.pricing).costUsd });
        return;
      }
    }

    let attempts = 0;
    let lastError: GatewayError | ProviderError | undefined;
    for (const model of p.resolved.candidates) {
      const blocked = await this.budgetBlock(p, model);
      if (blocked) {
        lastError = blocked;
        continue;
      }
      const provider = p.snap.providers.get(model.providerId)!;
      const retries = provider.maxRetries ?? p.defaultRetries;
      for (let attempt = 0; attempt <= retries; attempt++) {
        attempts++;
        const gen = adapterFor(provider.type).chatStream(this.adapterCtx(p, model, signal), p.req);
        let first: IteratorResult<StreamItem>;
        try {
          first = await gen.next(); // fallback is only possible before the first byte reaches the client
        } catch (e: any) {
          const err = e instanceof ProviderError ? e : new ProviderError(e?.message ?? 'Unknown error', 502, true);
          lastError = err;
          if (err.code === 'client_aborted') {
            this.finish(p, { model, usage: emptyUsage(), status: 'aborted', httpStatus: 499, attempts, error: err });
            return;
          }
          this.alertProvider(provider.id, provider.name, err);
          if (err.retryable && attempt < retries) {
            await sleep(Math.min(8000, 300 * 2 ** attempt) + Math.random() * 200);
            continue;
          }
          if (!this.canFallback(err)) {
            this.finish(p, { model, usage: emptyUsage(), status: 'error', httpStatus: err.status, attempts, error: err });
            throw this.toGatewayError(err);
          }
          break;
        }
        await this.pipeStream(p, model, gen, first, res, writeHead, send, wantUsage, attempts);
        return;
      }
    }
    const final = lastError ?? new GatewayError(503, 'No model available');
    this.finish(p, { model: p.resolved.candidates[0], usage: emptyUsage(), status: 'error', httpStatus: this.toGatewayError(final).status, attempts, error: final });
    throw this.toGatewayError(final);
  }

  private async pipeStream(
    p: Prepared, model: ModelRow, gen: AsyncGenerator<StreamItem>, first: IteratorResult<StreamItem>, res: Response,
    writeHead: (m: ModelRow, hit: boolean) => void, send: (o: unknown) => void, wantUsage: boolean, attempts: number,
  ) {
    writeHead(model, false);
    const ttftMs = Date.now() - p.started;
    const restorer = new StreamRestorer(p.vault);
    let usage: Usage | undefined;
    let text = '';
    let finish: string | null = null;
    let hasTools = false;
    let lastChunk: ChatChunk | undefined;
    let status: UsageRecord['status'] = 'success';
    let error: ProviderError | undefined;
    const handle = (item: StreamItem) => {
      if ('usage' in item) {
        usage = item.usage;
        return;
      }
      const chunk = item.chunk;
      lastChunk = chunk;
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        text += choice.delta.content;
        choice.delta.content = restorer.push(choice.delta.content);
      }
      if (choice?.delta?.tool_calls) hasTools = true;
      if (choice?.finish_reason) {
        finish = choice.finish_reason;
        const tail = restorer.flush();
        if (tail) send({ ...chunk, choices: [{ index: 0, delta: { content: tail }, finish_reason: null }], usage: undefined });
      }
      if (chunk.usage && !wantUsage) {
        if (!chunk.choices?.length) return; // usage-only chunk the client did not ask for
        delete chunk.usage;
      }
      send(chunk);
    };
    try {
      if (!first.done) handle(first.value);
      for (;;) {
        const n = await gen.next();
        if (n.done) break;
        handle(n.value);
      }
      const tail = restorer.flush();
      if (tail && lastChunk) send({ ...lastChunk, choices: [{ index: 0, delta: { content: tail }, finish_reason: null }], usage: undefined });
      res.write('data: [DONE]\n\n');
    } catch (e: any) {
      error = e instanceof ProviderError ? e : new ProviderError(e?.message ?? 'Stream failed', 502, false);
      status = error.code === 'client_aborted' ? 'aborted' : 'error';
      if (status === 'error' && !res.writableEnded) send({ error: { message: error.message, type: 'api_error', code: error.code } });
    } finally {
      if (!res.writableEnded) res.end();
    }
    // Providers that omit streaming usage get an estimate (flagged as such).
    let u = usage ?? emptyUsage();
    if (!usage || (u.inputTokens === 0 && u.outputTokens === 0)) {
      u = { ...u, inputTokens: estimateMessagesTokens(p.req.messages), outputTokens: estimateTokens(text), estimated: true };
    }
    this.finish(p, { model, usage: u, status, httpStatus: status === 'success' ? 200 : status === 'aborted' ? 499 : 502, attempts, ttftMs, error });
    if (status === 'success' && p.cacheKey && !hasTools && finish && finish !== 'length' && text) {
      const response: ChatResponse = {
        id: lastChunk?.id ?? p.requestId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: model.slug,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }],
      };
      void this.cache.set(p.cacheKey, p.kc.app.id, { response, usage: u, modelId: model.id, providerId: model.providerId }, p.cacheTtl);
    }
  }

  // ------------------------------------------------------------------ messages (native Anthropic)
  /**
   * POST /v1/messages: the Anthropic Messages API, passed through natively to Anthropic
   * models so thinking blocks, cache_control, server tools, citations and beta features
   * survive. Keys, rate limits, guardrails, routing, budgets, retries, fallback and
   * metering work as on /v1/chat/completions; route targets that are not Anthropic
   * models are skipped. The response cache does not apply.
   */
  async messages(kc: KeyContext, body: unknown, req: Request, res: Response): Promise<void> {
    const release = this.acquire(kc);
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', onClose);
    try {
      const p = await this.prepareMessages(kc, body, req);
      res.setHeader('x-relay-request-id', p.requestId);
      if (p.resolved.decision) res.setHeader('x-relay-route-decision', p.resolved.decision);
      if (p.native!.body.stream) await this.runMessagesStream(p, res, abort.signal);
      else {
        const r = await this.runMessages(p, abort.signal);
        res.setHeader('x-relay-model', r.model.slug);
        res.setHeader('x-relay-cache', 'MISS');
        if (p.exposeCost) res.setHeader('x-relay-cost-usd', r.costUsd.toFixed(8));
        res.status(200).json(r.response);
      }
    } finally {
      res.off('close', onClose);
      release();
    }
  }

  private async prepareMessages(kc: KeyContext, body: unknown, httpReq: Request): Promise<Prepared> {
    const started = Date.now();
    const requestId = CryptoService.id();
    const gw = await this.settings.get('gateway');
    const routing = await this.settings.get('routing');
    await this.rateLimit(kc, gw.defaultKeyRpm);
    const snap = await this.catalog.snapshot();
    const input = validateMessages(body);
    const tags = relayTags(input, httpReq.headers['x-relay-tags']);
    const { relay, ...rest } = input;
    const upstream: MessagesBody = structuredClone(rest);
    Object.assign(upstream, relay?.providerOptions ?? {});
    const requestedModel = upstream.model ?? '';

    // Guardrails read (and, when masking PII, rewrite) the text inside the Anthropic blocks.
    const policies = snap.guardrails.filter((g) => g.isDefault || kc.app.settings?.guardrailPolicyIds?.includes(g.id));
    const policy = mergePolicies(policies.map((g) => ({ id: g.id, config: g.config })));
    const slots = textSlots(upstream);
    const view = slotView(slots);
    const check = checkInput(view, policy);
    if (check.blocked) {
      const err = new GatewayError(400, check.blocked, 'invalid_request_error', 'guardrail_blocked');
      this.recordBlocked(kc, requestId, started, requestedModel, err, check.flags, !!upstream.stream, 'messages');
      throw err;
    }
    if (check.messages !== view) check.messages.forEach((m, i) => slots[i].set(typeof m.content === 'string' ? m.content : ''));
    if (policy?.maxOutputTokens) upstream.max_tokens = Math.min(upstream.max_tokens ?? policy.maxOutputTokens, policy.maxOutputTokens);
    const perReq = kc.key.limits?.maxTokensPerRequest;
    if (perReq) {
      const est = estimateMessagesTokens(check.messages) + estimateTokens(JSON.stringify(upstream.tools ?? '')) + (upstream.max_tokens ?? 0);
      if (est > perReq) throw new GatewayError(400, `Request exceeds this key's limit of ${perReq} tokens per request (estimated ${est})`, 'invalid_request_error', 'request_too_large');
    }

    const resolved = resolveModel(snap, upstream.model, kc.key, kc.app, 'chat', {
      messages: check.messages, hasTools: !!upstream.tools?.length, autoThreshold: routing.autoThresholdTokens, autoKeywords: routing.autoStrongKeywords,
    });
    resolved.candidates = filterByKey(resolved.candidates, kc.key, resolved.route);
    if (!resolved.candidates.length) throw new GatewayError(403, 'This key is not allowed to use any model behind this route', 'permission_error', 'model_not_allowed');
    resolved.candidates = resolved.candidates.filter((m) => snap.providers.get(m.providerId)?.type === 'anthropic');
    if (!resolved.candidates.length) {
      throw new GatewayError(400, `"${requestedModel || 'default model'}" has no Anthropic model behind it. /v1/messages serves Anthropic models only; use /v1/chat/completions for other providers.`, 'invalid_request_error', 'model_not_supported');
    }

    const header = (n: string) => (Array.isArray(httpReq.headers[n]) ? (httpReq.headers[n] as string[]).join(',') : (httpReq.headers[n] as string | undefined));
    const req: ChatRequest = { model: requestedModel, messages: check.messages, stream: !!upstream.stream, relay: { tags }, user: upstream.metadata?.user_id };
    return {
      requestId, started, kc, req, requestedModel, policy, vault: check.vault, flags: check.flags, redactions: check.redactions, resolved, cacheTtl: 0, snap,
      timeoutMs: gw.requestTimeoutMs, defaultRetries: gw.defaultMaxRetries, logBodies: kc.app.settings?.logBodies ?? gw.storeRequestBodies,
      logRetentionDays: gw.requestLogRetentionDays, exposeCost: gw.exposeCostHeaders,
      native: { body: upstream, version: header('anthropic-version'), betas: header('anthropic-beta') },
    };
  }

  /**
   * Tries each candidate with retries, falling back like runChat. `open` either finishes
   * the request (non-streaming) or opens the upstream stream; failures before the first
   * byte reaches the client can still fall back.
   */
  private async withFallback<T>(p: Prepared, signal: AbortSignal | undefined, open: (model: ModelRow, ctx: AdapterContext, attempts: number) => Promise<T>): Promise<{ value: T; model: ModelRow; attempts: number } | undefined> {
    let attempts = 0;
    let lastError: GatewayError | ProviderError | undefined;
    for (const model of p.resolved.candidates) {
      const blocked = await this.budgetBlock(p, model);
      if (blocked) {
        lastError = blocked;
        continue;
      }
      const provider = p.snap.providers.get(model.providerId)!;
      const retries = provider.maxRetries ?? p.defaultRetries;
      for (let attempt = 0; attempt <= retries; attempt++) {
        attempts++;
        try {
          return { value: await open(model, this.adapterCtx(p, model, signal), attempts), model, attempts };
        } catch (e: any) {
          if (e instanceof GatewayError) throw e;
          const err = e instanceof ProviderError ? e : new ProviderError(e?.message ?? 'Unknown error', 502, true);
          lastError = err;
          if (err.code === 'client_aborted') {
            this.finish(p, { model, usage: emptyUsage(), status: 'aborted', httpStatus: 499, attempts, error: err });
            return undefined;
          }
          this.alertProvider(provider.id, provider.name, err);
          if (err.retryable && attempt < retries) {
            await sleep(Math.min(8000, 300 * 2 ** attempt) + Math.random() * 200);
            continue;
          }
          if (!this.canFallback(err)) {
            this.finish(p, { model, usage: emptyUsage(), status: 'error', httpStatus: err.status, attempts, error: err });
            throw this.toGatewayError(err);
          }
          break;
        }
      }
    }
    const final = lastError ?? new GatewayError(503, 'No model available');
    this.finish(p, { model: p.resolved.candidates[0], usage: emptyUsage(), status: 'error', httpStatus: this.toGatewayError(final).status, attempts, error: final });
    throw this.toGatewayError(final);
  }

  private nativeAdapter(): AnthropicAdapter {
    return adapterFor('anthropic') as AnthropicAdapter;
  }

  private async runMessages(p: Prepared, signal: AbortSignal) {
    const native = p.native!;
    const r = await this.withFallback(p, signal, async (model, ctx, attempts) => {
      const res = await this.nativeAdapter().native(ctx, { ...native.body, stream: false }, native);
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError('Upstream returned invalid JSON', 502, true, 'bad_upstream_response', text.slice(0, 500));
      }
      const usage = AnthropicAdapter.usageOf(json.usage);
      const blockedOut = checkOutput(messageText(json), p.policy);
      if (blockedOut) {
        const err = new GatewayError(422, blockedOut, 'invalid_request_error', 'output_blocked');
        this.finish(p, { model, usage, status: 'blocked', httpStatus: 422, attempts, error: err });
        throw err;
      }
      const response = restoreMessage(json, p.vault);
      const costUsd = this.finish(p, { model, usage, status: 'success', httpStatus: 200, attempts, response });
      return { response, costUsd };
    });
    if (!r) throw new GatewayError(499, 'Client closed request', 'api_error', 'client_aborted');
    return { ...r.value, model: r.model };
  }

  private async runMessagesStream(p: Prepared, res: Response, signal: AbortSignal) {
    const native = p.native!;
    const opened = await this.withFallback(p, signal, (_model, ctx) => this.nativeAdapter().native(ctx, { ...native.body, stream: true }, native));
    if (!opened) return;
    const { value: upstream, model, attempts } = opened;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('x-relay-model', model.slug);
    res.setHeader('x-relay-cache', 'MISS');
    res.flushHeaders();
    const ttftMs = Date.now() - p.started;
    const send = (ev: any) => res.write(`event: ${ev?.type ?? 'message'}\ndata: ${JSON.stringify(ev)}\n\n`);
    const restorer = new MessagesStreamRestorer(p.vault);
    let rawUsage: Record<string, unknown> | undefined;
    let outText = 0;
    let status: UsageRecord['status'] = 'success';
    let error: ProviderError | undefined;
    try {
      for await (const sse of sseEvents(upstream)) {
        let ev: any;
        try {
          ev = JSON.parse(sse.data);
        } catch {
          continue;
        }
        if (ev?.type === 'message_start') rawUsage = { ...(ev.message?.usage ?? {}) };
        else if (ev?.type === 'message_delta' && ev.usage) rawUsage = { ...(rawUsage ?? {}), ...ev.usage };
        else if (ev?.type === 'content_block_delta') outText += String(ev.delta?.text ?? ev.delta?.thinking ?? ev.delta?.partial_json ?? '').length;
        else if (ev?.type === 'error') {
          status = 'error';
          error = new ProviderError(`Upstream stream error: ${ev.error?.message ?? 'unknown'}`, 502, false, 'upstream_stream_error');
        }
        for (const out of restorer.transform(ev)) send(out);
      }
    } catch (e: any) {
      error = e instanceof ProviderError ? e : new ProviderError(e?.message ?? 'Stream failed', 502, false);
      status = error.code === 'client_aborted' ? 'aborted' : 'error';
      if (status === 'error' && !res.writableEnded) send({ type: 'error', error: { type: anthropicErrorType(error.status, 'api_error'), message: error.message } });
    } finally {
      if (!res.writableEnded) res.end();
    }
    let usage = rawUsage ? AnthropicAdapter.usageOf(rawUsage) : emptyUsage();
    if (!rawUsage || (usage.inputTokens === 0 && usage.outputTokens === 0)) {
      usage = { ...usage, inputTokens: estimateMessagesTokens(p.req.messages), outputTokens: Math.ceil(outText / 4), estimated: true };
    }
    this.finish(p, { model, usage, status, httpStatus: status === 'success' ? 200 : status === 'aborted' ? 499 : 502, attempts, ttftMs, error });
  }

  // ------------------------------------------------------------------ embeddings
  async embeddings(kc: KeyContext, body: any, res: Response) {
    const release = this.acquire(kc);
    const started = Date.now();
    const requestId = CryptoService.id();
    try {
      const gw = await this.settings.get('gateway');
      await this.rateLimit(kc, gw.defaultKeyRpm);
      if (!body || (typeof body.input !== 'string' && !Array.isArray(body.input))) throw new GatewayError(400, '"input" must be a string or an array of strings');
      if (Array.isArray(body.input) && (body.input.length > 2048 || body.input.some((s: unknown) => typeof s !== 'string'))) throw new GatewayError(400, '"input" must be at most 2048 strings');
      const snap = await this.catalog.snapshot();
      const resolved = resolveModel(snap, body.model, kc.key, kc.app, 'embedding', { autoThreshold: 0, autoKeywords: [] });
      resolved.candidates = filterByKey(resolved.candidates, kc.key, resolved.route);
      const p = { requestId, started, kc, requestedModel: body.model, resolved, snap, flags: [], redactions: 0, req: { model: body.model, messages: [] } } as unknown as Prepared;
      let lastError: GatewayError | ProviderError | undefined;
      let attempts = 0;
      for (const model of resolved.candidates) {
        const blocked = await this.budgetBlock(p, model);
        if (blocked) {
          lastError = blocked;
          continue;
        }
        const provider = snap.providers.get(model.providerId)!;
        const adapter = adapterFor(provider.type);
        if (!adapter.embeddings) {
          lastError = new GatewayError(400, `Provider "${provider.name}" does not support embeddings`, 'invalid_request_error', 'unsupported');
          continue;
        }
        attempts++;
        try {
          const ctx: AdapterContext = { provider, model: this.catalog.modelRuntime(model), timeoutMs: provider.timeoutMs ?? gw.requestTimeoutMs };
          const { response, usage } = await adapter.embeddings(ctx, body as EmbeddingRequest);
          const cost = this.record(p, 'embeddings', { model, usage, status: 'success', httpStatus: 200, attempts });
          res.setHeader('x-relay-request-id', requestId);
          res.setHeader('x-relay-model', model.slug);
          if (gw.exposeCostHeaders) res.setHeader('x-relay-cost-usd', cost.toFixed(8));
          res.status(200).json(response);
          return;
        } catch (e: any) {
          lastError = e instanceof ProviderError ? e : new ProviderError(e?.message ?? 'Unknown error', 502, true);
          if (!this.canFallback(lastError as ProviderError)) break;
        }
      }
      const err = this.toGatewayError(lastError ?? new GatewayError(503, 'No model available'));
      this.record(p, 'embeddings', { model: resolved.candidates[0], usage: emptyUsage(), status: 'error', httpStatus: err.status, attempts, error: lastError });
      throw err;
    } finally {
      release();
    }
  }

  // ------------------------------------------------------------------ batch
  /** Runs many chat requests in parallel (bounded concurrency); each is metered individually. */
  async batch(kc: KeyContext, body: any) {
    const items: { custom_id?: string; body: unknown }[] = Array.isArray(body?.requests) ? body.requests : [];
    if (!items.length || items.length > 100) throw new GatewayError(400, '"requests" must contain 1-100 items');
    const concurrency = Math.min(Math.max(Number(body?.concurrency) || 10, 1), 25);
    const results: unknown[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        const item = items[i];
        const custom_id = item?.custom_id ?? String(i);
        try {
          const reqBody = { ...(item.body as object), stream: false };
          const release = this.acquire(kc);
          try {
            const p = await this.prepare(kc, reqBody);
            const r = await this.runChat(p);
            results[i] = { custom_id, status: 200, request_id: p.requestId, response: r.response };
          } finally {
            release();
          }
        } catch (e: any) {
          const err = this.toGatewayError(e);
          results[i] = { custom_id, status: err.status, error: { message: err.message, type: err.type, code: err.code } };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return { object: 'batch.result', results };
  }

  // ------------------------------------------------------------------ models
  async listModels(kc: KeyContext) {
    const snap = await this.catalog.snapshot();
    const data: { id: string; object: 'model'; created: number; owned_by: string; type?: string }[] = [];
    for (const m of snap.models.values()) {
      const prov = snap.providers.get(m.providerId);
      if (m.status !== 'active' || prov?.status !== 'active') continue;
      if (kc.app.settings?.allowedModelIds?.length && !kc.app.settings.allowedModelIds.includes(m.id)) continue;
      if (kc.key.access?.mode === 'restricted' && !kc.key.access.modelIds?.includes(m.id) && !kc.key.access.providerIds?.includes(m.providerId)) continue;
      data.push({ id: m.slug, object: 'model', created: Math.floor(new Date(m.createdAt).getTime() / 1000), owned_by: prov.name, type: m.type });
    }
    for (const r of snap.routesBySlug.values()) {
      if (r.status !== 'active') continue;
      if (kc.key.access?.mode === 'restricted' && !kc.key.access.routeIds?.includes(r.id)) continue;
      data.push({ id: r.slug, object: 'model', created: Math.floor(new Date(r.createdAt).getTime() / 1000), owned_by: 'relay-route', type: 'route' });
    }
    return { object: 'list', data: data.sort((a, b) => a.id.localeCompare(b.id)) };
  }

  // ------------------------------------------------------------------ helpers
  private adapterCtx(p: Prepared, model: ModelRow, signal?: AbortSignal): AdapterContext {
    const provider = p.snap.providers.get(model.providerId)!;
    return { provider, model: this.catalog.modelRuntime(model), timeoutMs: provider.timeoutMs ?? p.timeoutMs, signal };
  }

  private async budgetBlock(p: Prepared, model: ModelRow): Promise<GatewayError | undefined> {
    const b = await this.budgets.findExceeded({ appId: p.kc.app.id, entityId: p.kc.entity.id, keyId: p.kc.key.id, providerId: model.providerId, modelId: model.id });
    return b ? new GatewayError(429, `Spend cap "${b.name}" has been reached for this ${b.period} period`, 'insufficient_quota', 'budget_exceeded') : undefined;
  }

  private canFallback(err: ProviderError | GatewayError): boolean {
    if (err instanceof GatewayError) return true;
    // Upstream availability / auth / unknown-model problems are worth trying the next target; bad requests are not.
    return err.retryable || [401, 403, 404].includes(err.status);
  }

  private toGatewayError(e: unknown): GatewayError {
    if (e instanceof GatewayError) return e;
    if (e instanceof ProviderError) {
      const status = e.status === 401 || e.status === 403 ? 502 : e.status; // never leak upstream auth failures as client auth failures
      return new GatewayError(status, e.message, status >= 500 ? 'api_error' : 'invalid_request_error', e.code);
    }
    return new GatewayError(500, 'Internal error', 'api_error', 'internal_error');
  }

  private finalizeResponse(p: Prepared, response: ChatResponse): ChatResponse {
    if (p.vault?.size) {
      for (const c of response.choices ?? []) {
        if (typeof c.message?.content === 'string') c.message.content = restorePii(c.message.content, p.vault);
        for (const tc of c.message?.tool_calls ?? []) tc.function.arguments = restorePii(tc.function.arguments, p.vault);
      }
    }
    return response;
  }

  private finish(p: Prepared, o: Outcome): number {
    const cost = this.record(p, p.native ? 'messages' : 'chat', o);
    if (p.logBodies && o.status !== 'aborted') {
      this.recorder.recordBodies(p.requestId, p.kc.app.id, { request: p.native?.body ?? p.req, response: o.response, error: o.error?.message }, p.logRetentionDays);
    }
    return cost;
  }

  private record(p: Prepared, endpoint: UsageRecord['endpoint'], o: Outcome): number {
    const pricing = o.model?.pricing;
    const cost = o.cacheHit ? { costUsd: 0, inputCostUsd: 0, outputCostUsd: 0 } : computeCost(o.usage, pricing);
    const ctx = { appId: p.kc.app.id, entityId: p.kc.entity.id, keyId: p.kc.key.id, providerId: o.model?.providerId ?? '', modelId: o.model?.id ?? '' };
    this.recorder.record({
      id: p.requestId, ts: new Date(), requestId: p.requestId, endpoint, ...ctx, providerId: o.model?.providerId, modelId: o.model?.id,
      routeId: p.resolved?.route?.id, requestedModel: p.requestedModel, status: o.status, httpStatus: o.httpStatus,
      errorCode: o.error ? (o.error as any).code : undefined, errorMessage: o.error?.message?.slice(0, 1000),
      inputTokens: o.usage.inputTokens, outputTokens: o.usage.outputTokens, cachedTokens: o.usage.cachedTokens,
      totalTokens: o.usage.inputTokens + o.usage.outputTokens, ...cost, savedUsd: o.savedUsd, latencyMs: Date.now() - p.started,
      ttftMs: o.ttftMs, cacheHit: !!o.cacheHit, stream: !!p.req?.stream, attempts: o.attempts, promptId: p.promptId, promptVersion: p.promptVersion,
      piiRedactions: p.redactions, guardrailFlags: p.flags?.length ? p.flags : undefined, tags: p.req?.relay?.tags?.slice(0, 20),
      endUser: typeof p.req?.user === 'string' ? p.req.user.slice(0, 200) : undefined, ip: p.kc.ip, tokensEstimated: o.usage.estimated,
    });
    this.tpm.add(`k:${p.kc.key.id}`, o.usage.inputTokens + o.usage.outputTokens);
    if (cost.costUsd > 0 && o.model) void this.budgets.record(ctx, cost.costUsd);
    return cost.costUsd;
  }

  private recordBlocked(kc: KeyContext, requestId: string, started: number, requestedModel: string, err: GatewayError, flags: string[], stream: boolean, endpoint: UsageRecord['endpoint'] = 'chat') {
    this.recorder.record({
      id: requestId, ts: new Date(), requestId, endpoint, appId: kc.app.id, entityId: kc.entity.id, keyId: kc.key.id, requestedModel,
      status: 'blocked', httpStatus: err.status, errorCode: err.code, errorMessage: err.message, inputTokens: 0, outputTokens: 0, cachedTokens: 0,
      totalTokens: 0, costUsd: 0, inputCostUsd: 0, outputCostUsd: 0, latencyMs: Date.now() - started, cacheHit: false, stream, attempts: 0,
      guardrailFlags: flags, ip: kc.ip,
    });
  }

  private alertProvider(providerId: string, name: string, err: ProviderError) {
    if (!(err.status === 401 || err.status === 403 || err.status >= 500)) return;
    const last = this.providerAlerted.get(providerId) ?? 0;
    if (Date.now() - last < 15 * 60_000) return;
    this.providerAlerted.set(providerId, Date.now());
    this.logger.warn(`Provider ${name} failing: ${err.message}`);
    void this.notifications.notify({
      event: 'provider.failure', subject: `Relay: provider ${name} is failing`, title: `Provider ${name} returned errors`,
      lines: [err.message, 'Relay will fall back to other route targets where configured. Check the provider status and credentials.'],
      includeAdmins: true, relatedId: providerId,
    });
  }
}
