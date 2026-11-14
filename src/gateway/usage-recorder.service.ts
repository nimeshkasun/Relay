import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Store } from '../database/store';
import { C } from '../database/schema';
import { CryptoService } from '../common/crypto.service';

export interface UsageRecord {
  id: string;
  ts: Date;
  requestId: string;
  endpoint: 'chat' | 'embeddings' | 'messages';
  appId: string;
  entityId: string;
  keyId: string;
  providerId?: string;
  modelId?: string;
  routeId?: string;
  requestedModel?: string;
  status: 'success' | 'error' | 'blocked' | 'aborted';
  httpStatus: number;
  errorCode?: string;
  errorMessage?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  savedUsd?: number;
  latencyMs: number;
  ttftMs?: number;
  cacheHit: boolean;
  stream: boolean;
  attempts: number;
  promptId?: string;
  promptVersion?: number;
  piiRedactions?: number;
  guardrailFlags?: string[];
  tags?: string[];
  endUser?: string;
  ip?: string;
  tokensEstimated?: boolean;
}

const FLUSH_INTERVAL_MS = 1000;
const FLUSH_BATCH = 500;
const MAX_BUFFER = 100_000;

/**
 * Write-behind buffer for usage records and request logs. Requests never wait
 * on analytics writes; records are flushed in bulk every second (or every 500
 * records), retried on failure and drained on graceful shutdown.
 */
@Injectable()
export class UsageRecorder implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('UsageRecorder');
  private usage: UsageRecord[] = [];
  private logs: { id: string; ts: Date; appId: string; bodyEnc: string; expiresAt: Date }[] = [];
  private lastUsed = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private flushing = false;

  constructor(private readonly store: Store, private readonly crypto: CryptoService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    for (let i = 0; i < 5 && (this.usage.length || this.logs.length); i++) await this.flush();
  }

  record(r: UsageRecord) {
    if (this.usage.length >= MAX_BUFFER) {
      this.usage.shift();
      this.logger.error('Usage buffer full - dropping oldest record (database unreachable?)');
    }
    this.usage.push(r);
    if (this.usage.length >= FLUSH_BATCH) void this.flush();
    // lastUsedAt is informational; update at most once per minute per key.
    const prev = this.lastUsed.get(r.keyId) ?? 0;
    if (Date.now() - prev > 60_000) {
      this.lastUsed.set(r.keyId, Date.now());
      void this.store.update(C.apiKeys, r.keyId, { lastUsedAt: r.ts }).catch(() => undefined);
    }
  }

  /** Stores the (encrypted) request/response bodies when an app opts in. */
  recordBodies(id: string, appId: string, payload: unknown, retentionDays: number) {
    if (this.logs.length >= 10_000) return;
    this.logs.push({
      id, ts: new Date(), appId, bodyEnc: this.crypto.encryptJson(payload, `requestlog:${id}`), expiresAt: new Date(Date.now() + retentionDays * 86400_000),
    });
  }

  readBodies(row: { id: string; bodyEnc: string }) {
    return this.crypto.decryptJson(row.bodyEnc, `requestlog:${row.id}`);
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.usage.length) {
        const batch = this.usage.slice(0, FLUSH_BATCH);
        await this.store.insertMany(C.usage, batch as any);
        this.usage.splice(0, batch.length);
      }
      while (this.logs.length) {
        const batch = this.logs.slice(0, 100);
        await this.store.insertMany(C.requestLogs, batch);
        this.logs.splice(0, batch.length);
      }
    } catch (e: any) {
      this.logger.error(`Flush failed (will retry): ${e.message}`);
    } finally {
      this.flushing = false;
    }
  }

  static newId() {
    return CryptoService.id();
  }
}
