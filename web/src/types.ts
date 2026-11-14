// Shapes returned by the Relay admin API (dates arrive as ISO strings).

export type Role = 'owner' | 'admin' | 'viewer';
export type Status = 'active' | 'disabled';

export interface Me {
  id: string;
  username: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  mfaEnrollmentRequired: boolean;
}

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled' | 'invited';
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: string;
  lockedUntil?: string;
  inviteExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInfo {
  id: string;
  ip?: string;
  userAgent?: string;
  createdAt: string;
  lastSeenAt?: string;
  expiresAt: string;
  current: boolean;
}

export interface Pricing {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
  perRequest?: number;
}

export interface Capabilities {
  vision?: boolean;
  tools?: boolean;
  streaming?: boolean;
  json?: boolean;
  sampling?: boolean;
  reasoning?: boolean;
}

export type ProviderType = 'openai' | 'azure-openai' | 'anthropic' | 'gemini' | 'custom';

export interface Provider {
  id: string;
  name: string;
  slug: string;
  type: ProviderType;
  presetId?: string;
  baseUrl: string;
  config?: Record<string, unknown>;
  status: Status;
  timeoutMs?: number;
  maxRetries?: number;
  lastTestAt?: string;
  lastTestOk?: boolean;
  lastTestMessage?: string;
  hasApiKey: boolean;
  apiKeyHint?: string;
  hasSecretHeaders: boolean;
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PresetModel {
  id: string;
  name: string;
  type?: 'chat' | 'embedding';
  tier: Tier;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing: Pricing;
  capabilities?: Capabilities;
}

export interface ProviderPreset {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  docsUrl?: string;
  needsApiKey: boolean;
  configHints?: string[];
  config?: Record<string, unknown>;
  models: PresetModel[];
}

export type Tier = 'cheap' | 'standard' | 'strong';

export interface Model {
  id: string;
  providerId: string;
  slug: string;
  providerModelId: string;
  displayName: string;
  type: 'chat' | 'embedding';
  tier?: Tier;
  status: Status;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing: Pricing;
  capabilities?: Capabilities;
  notes?: string;
  providerName?: string;
  providerSlug?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PricingHistoryRow {
  id: string;
  modelId: string;
  pricing: Pricing;
  previous?: Pricing;
  changedBy?: string;
  createdAt: string;
}

export interface AppSettings {
  cacheEnabled?: boolean;
  cacheTtlSeconds?: number;
  logBodies?: boolean;
  guardrailPolicyIds?: string[];
  allowedModelIds?: string[];
  defaultModel?: string;
  rpm?: number;
}

export interface App {
  id: string;
  name: string;
  slug: string;
  description?: string;
  owner?: string;
  ownerEmail?: string;
  status: Status;
  settings?: AppSettings;
  tags?: string[];
  activeKeys?: number;
  totalKeys?: number;
  createdAt: string;
  updatedAt: string;
}

export type EntityType = 'user' | 'environment' | 'service' | 'team' | 'other';
export const ENTITY_TYPES: EntityType[] = ['user', 'environment', 'service', 'team', 'other'];

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  email?: string;
  description?: string;
  status: Status;
  createdAt: string;
  updatedAt: string;
}

export interface KeyAccess {
  mode: 'all' | 'restricted';
  providerIds?: string[];
  modelIds?: string[];
  routeIds?: string[];
}
export interface KeyLimits {
  rpm?: number;
  tpm?: number;
  maxTokensPerRequest?: number;
  maxConcurrent?: number;
}

export interface ApiKey {
  id: string;
  name: string;
  appId: string;
  entityId: string;
  prefix: string;
  last4: string;
  displayKey: string;
  status: 'active' | 'inactive' | 'revoked';
  expired: boolean;
  expiresAt?: string;
  access: KeyAccess;
  limits?: KeyLimits;
  ipAllowlist?: string[];
  metadata?: Record<string, string>;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  revokeReason?: string;
  rotatedAt?: string;
  rotationCount?: number;
  appName?: string;
  entityName?: string;
  entityType?: string;
  spend30d?: number;
  requests30d?: number;
  createdAt: string;
  updatedAt: string;
}

export interface KeyEvent {
  id: string;
  keyId: string;
  event: string;
  actorId?: string;
  actorName?: string;
  reason?: string;
  createdAt: string;
}

export interface KeyDetail extends ApiKey {
  events: KeyEvent[];
}

export interface KeySecretResponse {
  key: ApiKey;
  secret: string;
}

export type RouteStrategy = 'fallback' | 'loadbalance' | 'auto' | 'cheapest';
export interface RouteTarget {
  modelId: string;
  weight?: number;
}
export interface RouteRow {
  id: string;
  slug: string;
  name: string;
  description?: string;
  strategy: RouteStrategy;
  targets: RouteTarget[];
  autoConfig?: { cheap: string[]; strong: string[]; thresholdTokens?: number; strongKeywords?: string[] };
  retry?: { maxAttempts?: number };
  status: Status;
  createdAt: string;
  updatedAt: string;
}

export type PiiMode = 'off' | 'redact' | 'mask_restore' | 'block';
export interface PatternRule {
  pattern: string;
  description?: string;
}
export interface GuardrailConfig {
  pii?: { mode: PiiMode; entities?: string[] };
  blockedPatterns?: PatternRule[];
  blockedKeywords?: string[];
  promptInjection?: 'off' | 'flag' | 'block';
  maxInputTokens?: number;
  maxOutputTokens?: number;
  outputBlockedPatterns?: PatternRule[];
}
export interface Guardrail {
  id: string;
  name: string;
  description?: string;
  status: Status;
  isDefault?: boolean;
  config: GuardrailConfig;
  createdAt: string;
  updatedAt: string;
}
export interface GuardrailTestResult {
  blocked?: string;
  flags: string[];
  redactions: number;
  output: unknown;
  vault?: Record<string, string>;
}

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly' | 'total';
export interface BudgetScope {
  appId?: string;
  entityId?: string;
  keyId?: string;
  providerId?: string;
  modelId?: string;
}
export interface Budget {
  id: string;
  name: string;
  scope: BudgetScope;
  period: BudgetPeriod;
  amountUsd: number;
  action: 'block' | 'notify';
  thresholds: number[];
  notifyEmails?: string[];
  status: Status;
  periodKey: string;
  spentUsd: number;
  requests: number;
  percent: number;
  exceeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PromptRole = 'system' | 'user' | 'assistant' | 'developer';
export interface PromptTemplate {
  messages: { role: PromptRole; content: string }[];
  model?: string;
  params?: { temperature?: number; max_tokens?: number; top_p?: number };
}
export interface Prompt {
  id: string;
  slug: string;
  name: string;
  description?: string;
  appId?: string;
  labels: Record<string, number>;
  latestVersion: number;
  createdAt: string;
  updatedAt: string;
}
export interface PromptVersion {
  id: string;
  promptId: string;
  version: number;
  template: PromptTemplate;
  variables: string[];
  changelog?: string;
  createdBy?: string;
  createdAt: string;
}
export interface PromptDetail extends Prompt {
  versions: PromptVersion[];
}

// ---------- Analytics ----------
export interface Totals {
  requests?: number;
  costUsd?: number;
  inputCostUsd?: number;
  outputCostUsd?: number;
  savedUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  errors?: number;
  blocked?: number;
  cacheHits?: number;
  avgLatencyMs?: number;
  maxLatencyMs?: number;
  errorRate?: number;
  cacheHitRate?: number;
}
export interface SeriesPoint {
  bucket: string;
  costUsd: number;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
  cacheHits: number;
}
export interface TopRow {
  id: string | null;
  name: string;
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
}
export interface Overview {
  range: { from: string; to: string; bucket: 'hour' | 'day' | 'week' };
  totals: Totals;
  previous: { costUsd: number; requests: number };
  series: SeriesPoint[];
  top: { apps: TopRow[]; models: TopRow[]; providers: TopRow[]; entities: TopRow[]; keys: TopRow[] };
  statuses: { status: string; requests: number }[];
}
export type ReportRow = Totals & Record<string, unknown> & { bucket?: string };
export interface Report {
  range: { from: string; to: string };
  groupBy: string[];
  bucket?: string;
  rows: ReportRow[];
}
export interface UsageLog {
  id: string;
  ts: string;
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
  appName?: string;
  entityName?: string;
  keyName?: string;
  providerName?: string;
  modelSlug?: string;
}
export interface Paged<T> {
  page: number;
  pageSize: number;
  total: number;
  rows: T[];
}

export interface AuditRow {
  id: string;
  seq: number;
  ts: string;
  actorType: string;
  actorId: string;
  actorName: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  outcome: 'success' | 'failure' | string;
  ip?: string;
  userAgent?: string;
  details?: unknown;
  prevHash: string;
  hash: string;
  kid?: string;
}
export interface AuditVerify {
  ok: boolean;
  checked: number;
  brokenAt?: number;
  reason?: string;
}

// ---------- Settings ----------
export interface SecuritySettings {
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  maxFailedLogins: number;
  lockoutMinutes: number;
  passwordMinLength: number;
  requireMfa: boolean;
  adminIpAllowlist: string[];
  inviteExpiryHours: number;
}
export interface GatewaySettings {
  publicBaseUrl: string;
  requestTimeoutMs: number;
  defaultMaxRetries: number;
  defaultCacheTtlSeconds: number;
  storeRequestBodies: boolean;
  requestLogRetentionDays: number;
  usageRetentionDays: number;
  auditRetentionDays: number;
  keyExpiryWarningDays: number[];
  exposeCostHeaders: boolean;
  defaultKeyRpm: number;
}
export interface RoutingSettings {
  autoThresholdTokens: number;
  autoStrongKeywords: string[];
}
export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  events: string[];
  format: 'json' | 'slack' | 'teams';
  enabled: boolean;
}
export interface NotificationSettings {
  enabled: boolean;
  channel: 'none' | 'smtp' | 'graph';
  fromAddress: string;
  fromName: string;
  adminRecipients: string[];
  events: Record<string, boolean>;
  smtp: { host: string; port: number; secure: boolean; username: string; password?: string };
  graph: { tenantId: string; clientId: string; clientSecret?: string; senderUpn: string };
  webhooks: WebhookConfig[];
  _secretsSet?: Record<string, boolean>;
}
export const NOTIFICATION_EVENTS = [
  'user.onboarding',
  'user.password_reset',
  'budget.warning',
  'budget.reached',
  'key.created',
  'key.expiring',
  'key.revoked',
  'provider.failure',
  'security.alert',
] as const;
export const SECRET_MASK = '••••••••';

export interface NotificationLog {
  id: string;
  ts: string;
  event: string;
  channel: string;
  recipients?: string[] | string;
  subject?: string;
  status: string;
  error?: string;
  relatedId?: string;
}

export interface SystemInfo {
  version: string;
  node: string;
  database: string;
  masterKeyId: string;
  rotationKeyLoaded: boolean;
  installedAt?: string;
  uptimeSeconds: number;
  counts: { users: number; apps: number; keys: number; providers: number; models: number };
  pid: number;
}
