// Usage: node test/e2e/mock-llm.js  (listens on :18080), then
//        node test/e2e/smoke.mjs http://localhost:8080 <initial-admin-username> <initial-admin-password>
// Run against a FRESH database: it signs in with the generated admin and changes the password.
// End-to-end smoke test: node smoke.mjs <baseUrl> <username> <password>
const [base, username, password] = process.argv.slice(2);
let cookies = {};
const NEWPW = 'Sm0ke-Test-Passw0rd!';
const MOCK = process.env.MOCK_URL || 'http://localhost:18080';
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); };

async function admin(method, path, body) {
  const headers = { 'Content-Type': 'application/json', Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
  if (cookies.relay_csrf) headers['x-csrf-token'] = cookies.relay_csrf;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); cookies[k] = v; }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
async function gw(key, path, body, method = 'POST') {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, json: ct.includes('json') ? await res.json() : await res.text() };
}

let r = await admin('POST', '/api/admin/auth/login', { username, password });
ok(r.status === 200, 'login');
r = await admin('GET', '/api/admin/apps');
ok(r.status === 403 && r.json.code === 'PASSWORD_CHANGE_REQUIRED', 'forced password change blocks API');
r = await admin('POST', '/api/admin/auth/change-password', { currentPassword: password, newPassword: 'short' });
ok(r.status === 400, 'password policy enforced');
r = await admin('POST', '/api/admin/auth/change-password', { currentPassword: password, newPassword: NEWPW });
ok(r.status === 200, 'password changed');
r = await admin('POST', '/api/admin/auth/login', { username, password: NEWPW });
ok(r.status === 200, 're-login');
r = await admin('POST', '/api/admin/apps', { name: 'x' }, ); // csrf present -> fine
const csrf = cookies.relay_csrf; delete cookies.relay_csrf;
r = await admin('POST', '/api/admin/apps', { name: 'nocsrf' });
ok(r.status === 403, 'CSRF required for mutations');
cookies.relay_csrf = csrf;

const prov = (await admin('POST', '/api/admin/providers', { name: 'Mock OpenAI', type: 'openai', baseUrl: `${MOCK}/v1`, apiKey: 'sk-mock-1234567890', config: {} })).json;
ok(prov.hasApiKey && !JSON.stringify(prov).includes('sk-mock-1234567890'), 'provider created, api key never returned');
const failing = (await admin('POST', '/api/admin/providers', { name: 'Failing', type: 'openai', baseUrl: `${MOCK}/fail`, config: {}, maxRetries: 0 })).json;
const anth = (await admin('POST', '/api/admin/providers', { name: 'Mock Anthropic', type: 'anthropic', baseUrl: MOCK, apiKey: 'sk-ant-mock', config: {} })).json;
r = await admin('POST', `/api/admin/providers/${prov.id}/test`);
ok(r.json.ok, 'provider connection test: ' + r.json.message);

const mk = async (providerId, providerModelId, tier, pricing) => (await admin('POST', '/api/admin/models', { providerId, providerModelId, displayName: providerModelId, tier, pricing })).json;
const small = await mk(prov.id, 'mock-small', 'cheap', { input: 0.1, output: 0.2 });
const large = await mk(prov.id, 'mock-large', 'strong', { input: 10, output: 30 });
const bad = await mk(failing.id, 'mock-bad', 'standard', { input: 1, output: 1 });
const claude = await mk(anth.id, 'mock-claude', 'standard', { input: 3, output: 15, cachedInput: 0.3 });
ok(small.slug === 'mock-openai/mock-small', 'model slug ' + small.slug);

r = await admin('POST', '/api/admin/routes', { slug: 'smart', name: 'Smart', strategy: 'auto', targets: [], autoConfig: { cheap: [small.id], strong: [large.id], thresholdTokens: 50 } });
ok(r.status === 201, 'auto route');
r = await admin('POST', '/api/admin/routes', { slug: 'resilient', name: 'Resilient', strategy: 'fallback', targets: [{ modelId: bad.id }, { modelId: small.id }] });
ok(r.status === 201, 'fallback route');

const guard = (await admin('GET', '/api/admin/guardrails')).json.find((g) => g.name.startsWith('Strict PII'));
const app = (await admin('POST', '/api/admin/apps', { name: 'SCIC', settings: { cacheEnabled: true, guardrailPolicyIds: [guard.id], logBodies: true } })).json;
const keyRes = (await admin('POST', '/api/admin/keys', { name: 'dev key', appId: app.id, newEntity: { name: 'Jane Developer', type: 'user' }, expiresAt: new Date(Date.now() + 30 * 86400e3).toISOString(), limits: { rpm: 1000 } })).json;
const key = keyRes.secret;
ok(key?.startsWith('rly_'), 'key created');

r = await gw(key, '/v1/models', null, 'GET');
ok(r.status === 200 && r.json.data.length >= 5, `models listed (${r.json.data?.length})`);
r = await gw('rly_' + 'x'.repeat(43), '/v1/chat/completions', { model: 'x', messages: [] });
ok(r.status === 401 && r.json.error?.type === 'authentication_error', 'invalid key rejected (OpenAI error shape)');

r = await gw(key, '/v1/chat/completions', { model: 'mock-openai/mock-small', messages: [{ role: 'user', content: 'hi there' }] });
ok(r.status === 200 && r.json.choices[0].message.content === 'Echo: hi there', 'non-stream chat');
ok(Number(r.headers.get('x-relay-cost-usd')) > 0 && r.headers.get('x-relay-cache') === 'MISS', 'cost header ' + r.headers.get('x-relay-cost-usd'));
r = await gw(key, '/v1/chat/completions', { model: 'mock-openai/mock-small', messages: [{ role: 'user', content: 'hi there' }] });
ok(r.headers.get('x-relay-cache') === 'HIT', 'cache hit');

r = await gw(key, '/v1/chat/completions', { model: 'mock-small', messages: [{ role: 'user', content: 'Mail me at jane.doe@example.com' }], relay: { cache: false } });
ok(r.json.choices?.[0].message.content === 'Echo: Mail me at jane.doe@example.com', 'PII masked upstream and restored in response: ' + r.json.choices?.[0].message.content);

r = await gw(key, '/v1/chat/completions', { model: 'smart', messages: [{ role: 'user', content: 'yo' }], relay: { cache: false } });
ok(r.headers.get('x-relay-model') === 'mock-openai/mock-small', 'auto route -> cheap ' + r.headers.get('x-relay-route-decision'));
r = await gw(key, '/v1/chat/completions', { model: 'smart', messages: [{ role: 'user', content: 'please analyze this architecture '.repeat(20) }], relay: { cache: false } });
ok(r.headers.get('x-relay-model') === 'mock-openai/mock-large', 'auto route -> strong ' + r.headers.get('x-relay-route-decision'));
r = await gw(key, '/v1/chat/completions', { model: 'resilient', messages: [{ role: 'user', content: 'fallback?' }], relay: { cache: false } });
ok(r.status === 200 && r.headers.get('x-relay-model') === 'mock-openai/mock-small', 'fallback after upstream 503');

// streaming
let res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-openai/mock-small', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'stream please' }], relay: { cache: false } }) });
let sse = await res.text();
ok(sse.includes('"content":"Echo: "') && sse.trim().endsWith('data: [DONE]') && sse.includes('"usage"'), 'openai stream');
res = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-anthropic/mock-claude', stream: true, messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hello claude' }] }) });
sse = await res.text();
ok(sse.includes('Hello ') && sse.includes('"finish_reason":"stop"'), 'anthropic stream translated to OpenAI chunks');
r = await gw(key, '/v1/chat/completions', { model: 'mock-anthropic/mock-claude', messages: [{ role: 'user', content: 'hello claude' }], relay: { cache: false } });
ok(r.json.choices?.[0].message.content.startsWith('Hello from mock claude'), 'anthropic non-stream');

// native Anthropic Messages API (/v1/messages)
const anthHeaders = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'client-beta-1', 'Content-Type': 'application/json' };
const messages = (body, extra = {}) => fetch(base + '/v1/messages', { method: 'POST', headers: { ...anthHeaders, ...extra }, body: JSON.stringify(body) });
const native = { model: 'mock-anthropic/mock-claude', max_tokens: 200, thinking: { type: 'adaptive' }, system: [{ type: 'text', text: 'be nice', cache_control: { type: 'ephemeral' } }] };
res = await messages({ ...native, messages: [{ role: 'user', content: 'Mail jane.doe@example.com' }], relay: { tags: ['agent:smoke'] } }, { 'x-relay-tags': 'run:1' });
let j = await res.json();
ok(res.status === 200 && j.content?.[0]?.type === 'thinking' && j.content[0].signature === 'sig-mock', 'messages: thinking block and signature passed through');
ok(j._seen?.model === 'mock-claude' && !j._seen.relay && j._seen.beta.includes('client-beta-1') && j._seen.cacheControl, 'messages: model id swapped, relay stripped, beta and cache_control forwarded');
ok(j._seen?.firstUser.includes('[EMAIL_') && j.content?.[1]?.text.includes('jane.doe@example.com'), 'messages: PII masked upstream and restored in response');
ok(Number(res.headers.get('x-relay-cost-usd')) > 0 && res.headers.get('x-relay-model') === 'mock-anthropic/mock-claude', 'messages: metered, cost ' + res.headers.get('x-relay-cost-usd'));
res = await messages({ ...native, stream: true, messages: [{ role: 'user', content: 'Mail jane.doe@example.com' }] });
sse = await res.text();
ok(sse.includes('event: message_start') && sse.includes('"thinking_delta"') && sse.includes('"signature":"sig-mock"') && sse.trim().endsWith('data: {"type":"message_stop"}'), 'messages stream: Anthropic events passed through');
ok(sse.includes('jane.doe@example.com') && !sse.includes('[EMAIL_'), 'messages stream: PII restored in text deltas');
res = await messages({ model: 'mock-openai/mock-small', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
j = await res.json();
ok(res.status === 400 && j.type === 'error' && j.error?.type === 'invalid_request_error' && /Anthropic models only/.test(j.error.message), 'messages: non-Anthropic model rejected (Anthropic error shape)');
res = await messages({ model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }, { 'x-api-key': 'rly_' + 'x'.repeat(43) });
j = await res.json();
ok(res.status === 401 && j.type === 'error' && j.error?.type === 'authentication_error', 'messages: invalid key rejected (Anthropic error shape)');

// parallel load
const t0 = Date.now();
const many = await Promise.all(Array.from({ length: 200 }, (_, i) => gw(key, '/v1/chat/completions', { model: 'mock-openai/mock-small', messages: [{ role: 'user', content: 'p' + i }], relay: { cache: false } })));
ok(many.every((x) => x.status === 200), `200 concurrent requests all succeeded in ${Date.now() - t0}ms (upstream latency 50ms each)`);
r = await gw(key, '/v1/batch', { requests: Array.from({ length: 30 }, (_, i) => ({ custom_id: 'b' + i, body: { model: 'mock-small', messages: [{ role: 'user', content: 'batch ' + i }], relay: { cache: false } } })), concurrency: 15 });
ok(r.status === 200 && r.json.results.length === 30 && r.json.results.every((x) => x.status === 200), 'batch endpoint (30 items)');

// budgets
const budget = (await admin('POST', '/api/admin/budgets', { name: 'tiny', scope: { keyId: keyRes.key.id, modelId: large.id }, period: 'daily', amountUsd: 0.0001, action: 'block' })).json;
await new Promise((r2) => setTimeout(r2, 100));
r = await gw(key, '/v1/chat/completions', { model: 'mock-openai/mock-large', messages: [{ role: 'user', content: 'expensive' }], relay: { cache: false } });
ok(r.status === 200, 'first request under cap');
await new Promise((r2) => setTimeout(r2, 300));
r = await gw(key, '/v1/chat/completions', { model: 'mock-openai/mock-large', messages: [{ role: 'user', content: 'expensive again' }], relay: { cache: false } });
ok(r.status === 429 && r.json.error?.code === 'budget_exceeded', 'spend cap blocks model for this key');
r = await gw(key, '/v1/chat/completions', { model: 'mock-openai/mock-small', messages: [{ role: 'user', content: 'cheap still ok' }], relay: { cache: false } });
ok(r.status === 200, 'other models unaffected by model-scoped cap');

// analytics
await new Promise((r2) => setTimeout(r2, 1500));
r = await admin('GET', '/api/admin/analytics/overview');
ok(r.json.totals?.requests >= 240 && r.json.totals.costUsd > 0, `analytics overview: ${r.json.totals?.requests} requests, $${r.json.totals?.costUsd?.toFixed(4)}, cache hits ${r.json.totals?.cacheHits}`);
r = await admin('GET', '/api/admin/analytics/report?groupBy=modelId,keyId&bucket=day');
ok(r.status === 200 && r.json.rows.length > 0, 'report by model+key per day');
r = await admin('GET', '/api/admin/analytics/logs?pageSize=5');
ok(r.json.rows?.length === 5, 'request logs');
const logged = r.json.rows[0];
r = await admin('GET', `/api/admin/analytics/logs/${logged.id}/body`);
ok(r.status === 200 && r.json.request, 'encrypted request body retrievable');

// key lifecycle
r = await admin('POST', `/api/admin/keys/${keyRes.key.id}/deactivate`, {});
ok(r.json.status === 'inactive', 'deactivate');
r = await gw(key, '/v1/models', null, 'GET');
ok(r.status === 401, 'inactive key rejected immediately');
r = await admin('POST', `/api/admin/keys/${keyRes.key.id}/reactivate`, {});
r = await admin('POST', `/api/admin/keys/${keyRes.key.id}/regenerate`, { reason: 'leak drill' });
const newKey = r.json.secret;
ok((await gw(key, '/v1/models', null, 'GET')).status === 401 && (await gw(newKey, '/v1/models', null, 'GET')).status === 200, 'regenerate: old secret dead, new works');
r = await admin('PATCH', `/api/admin/keys/${keyRes.key.id}`, { expiresAt: new Date().toISOString() });
r = await admin('GET', `/api/admin/keys/${keyRes.key.id}`);
ok(new Date(r.json.expiresAt) > new Date(), 'expiry immutable');
r = await admin('POST', `/api/admin/keys/${keyRes.key.id}/revoke`, { reason: 'done' });
ok(r.json.status === 'revoked' && (await admin('POST', `/api/admin/keys/${keyRes.key.id}/reactivate`, {})).status === 400, 'revoke is permanent');

r = await admin('GET', '/api/admin/audit/verify');
ok(r.json.ok, `audit chain verified (${r.json.checked} entries)`);
r = await admin('POST', '/api/admin/users', { username: 'second.admin', email: 'second@example.com', name: 'Second Admin', role: 'admin', sendEmail: false });
ok(r.status === 201 && r.json.inviteUrl.includes('/invite/'), 'user invited');
const token = r.json.inviteUrl.split('/invite/')[1];
r = await admin('POST', '/api/admin/auth/invite/accept', { token, password: 'An0ther-Str0ng-Pass!' });
ok(r.status === 200, 'invite accepted');
console.log(process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED');
