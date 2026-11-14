import { useEffect, useState } from 'react';
import { Download, Eye, Search } from 'lucide-react';
import { api, ApiError, qs } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi, useApps, useDebounced, useModels, useProviders } from '../hooks';
import type { ApiKey, Paged, UsageLog } from '../types';
import { Alert, Badge, CodeBlock, ErrorState, FormField, KV, Loading, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { DataTable, Pager, type Column } from '../components/DataTable';
import { Drawer } from '../components/Modal';
import { DateRangePicker, presetRange, type DateRange } from '../components/DateRangePicker';
import { LiveToggle, useLiveMode, useNewRowKeys } from '../components/Live';
import { fmtDateTimeSec, fmtMs, fmtNum, fmtUsd } from '../format';

function LogDrawer({ row, onClose }: { row: UsageLog | null; onClose: () => void }) {
  const { isAdmin } = useAuth();
  const [body, setBody] = useState<unknown>(undefined);
  const [bodyErr, setBodyErr] = useState<string | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    setBody(undefined);
    setBodyErr(null);
  }, [row?.id]);
  if (!row) return null;
  const loadBody = () =>
    run(async () => {
      try {
        setBody(await api.get(`/api/admin/analytics/logs/${row.id}/body`));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setBodyErr('No stored body for this request. Body logging is disabled for this app (or the body expired).');
        else throw e;
      }
    });
  return (
    <Drawer open title={`Request ${row.requestId}`} onClose={onClose} wide headerExtra={<StatusBadge status={row.status} />}>
      <KV
        items={[
          ['Time', fmtDateTimeSec(row.ts)],
          ['Request ID', <code key="r">{row.requestId}</code>],
          ['Status', <>{row.status} · HTTP {row.httpStatus}</>],
          ['Endpoint', row.endpoint],
          ['App', row.appName ?? row.appId],
          ['Entity', row.entityName ?? row.entityId],
          ['API key', row.keyName ?? row.keyId],
          ['Requested model', row.requestedModel],
          ['Resolved model', row.modelSlug ?? row.modelId],
          ['Provider', row.providerName ?? row.providerId],
          ['Route', row.routeId],
          ['Input tokens', fmtNum(row.inputTokens)],
          ['Output tokens', fmtNum(row.outputTokens)],
          ['Cached tokens', fmtNum(row.cachedTokens)],
          ['Total tokens', <>{fmtNum(row.totalTokens)}{row.tokensEstimated ? <span className="muted"> (estimated)</span> : null}</>],
          ['Cost', <>{fmtUsd(row.costUsd)} <span className="muted">(in {fmtUsd(row.inputCostUsd)} · out {fmtUsd(row.outputCostUsd)})</span></>],
          ['Saved by cache', row.savedUsd ? fmtUsd(row.savedUsd) : undefined],
          ['Latency', fmtMs(row.latencyMs)],
          ['Time to first token', row.ttftMs !== undefined ? fmtMs(row.ttftMs) : undefined],
          ['Cache', row.cacheHit ? <Badge tone="success">HIT</Badge> : 'MISS'],
          ['Streaming', row.stream ? 'yes' : 'no'],
          ['Attempts', row.attempts],
          ['Prompt', row.promptId ? `${row.promptId} v${row.promptVersion ?? '?'}` : undefined],
          ['PII redactions', row.piiRedactions || undefined],
          ['Guardrail flags', row.guardrailFlags?.length ? <div className="chips">{row.guardrailFlags.map((f) => <span className="chip" key={f}>{f}</span>)}</div> : undefined],
          ['Tags', row.tags?.length ? <div className="chips">{row.tags.map((f) => <span className="chip" key={f}>{f}</span>)}</div> : undefined],
          ['End user', row.endUser],
          ['Client IP', row.ip],
          ['Error code', row.errorCode],
          ['Error message', row.errorMessage ? <span className="danger-text">{row.errorMessage}</span> : undefined],
        ]}
      />
      {isAdmin && (
        <div className="mt-3">
          <div className="section-title">Stored request / response body</div>
          {body !== undefined ? (
            <CodeBlock code={JSON.stringify(body, null, 2)} wrap />
          ) : bodyErr ? (
            <Alert tone="info">{bodyErr}</Alert>
          ) : (
            <button className="btn" onClick={loadBody} disabled={busy}>
              {busy ? <Spinner size={14} /> : <Eye size={14} />} View stored body
            </button>
          )}
          <div className="hint mt-1">Bodies are encrypted at rest and only stored for apps with body logging enabled. Viewing is restricted to admins.</div>
        </div>
      )}
    </Drawer>
  );
}

export default function Requests() {
  const [range, setRange] = useState<DateRange>(() => presetRange('24h'));
  const [f, setF] = useState({ appId: '', keyId: '', providerId: '', modelId: '', status: '', endpoint: '' });
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 350);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sel, setSel] = useState<UsageLog | null>(null);
  const apps = useApps();
  const providers = useProviders();
  const models = useModels();
  const keys = useApi<ApiKey[]>('/api/admin/keys', { cached: true });

  // Reset paging when the user changes the range (not when live mode slides it forward).
  const rangeKey = range.preset === 'custom' ? `${range.from}|${range.to}` : range.preset;
  useEffect(() => setPage(1), [rangeKey, f, q, pageSize]);
  const filterQs = qs({ from: range.from, to: range.to, ...f, q });
  const { data, error, loading, reload } = useApi<Paged<UsageLog>>(`/api/admin/analytics/logs${qs({ from: range.from, to: range.to, ...f, q, page, pageSize })}`);
  const live = useLiveMode('requests', () => (range.preset === 'custom' ? reload() : setRange(presetRange(range.preset as '24h'))));
  const fresh = useNewRowKeys(data?.rows, (r) => r.id, live.on, JSON.stringify([rangeKey, f, q, page, pageSize]));

  const columns: Column<UsageLog>[] = [
    { key: 'ts', header: 'Time', render: (r) => <span className="nowrap">{fmtDateTimeSec(r.ts)}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} label={r.status === 'success' ? String(r.httpStatus) : `${r.status} ${r.httpStatus}`} /> },
    { key: 'appName', header: 'App', render: (r) => r.appName ?? <span className="muted">{r.appId?.slice(0, 8)}</span> },
    { key: 'keyName', header: 'Key', hideSm: true, render: (r) => <span className="truncate" style={{ maxWidth: 180 }} title={r.keyName}>{r.keyName ?? r.keyId}</span> },
    {
      key: 'modelSlug',
      header: 'Model',
      render: (r) => (
        <span className="truncate" style={{ maxWidth: 220 }} title={`requested: ${r.requestedModel ?? '-'}`}>
          {r.modelSlug ?? r.requestedModel ?? '-'}
        </span>
      ),
    },
    { key: 'inputTokens', header: 'In', numeric: true, render: (r) => fmtNum(r.inputTokens) },
    { key: 'outputTokens', header: 'Out', numeric: true, render: (r) => fmtNum(r.outputTokens) },
    { key: 'costUsd', header: 'Cost', numeric: true, render: (r) => fmtUsd(r.costUsd) },
    { key: 'latencyMs', header: 'Latency', numeric: true, render: (r) => fmtMs(r.latencyMs) },
    { key: 'cacheHit', header: 'Cache', hideSm: true, render: (r) => (r.cacheHit ? <Badge tone="success">HIT</Badge> : <span className="muted">-</span>) },
  ];

  const sel_ = (key: keyof typeof f, label: string, opts: { value: string; label: string }[]) => (
    <FormField label={label}>
      <select className="select select-sm" value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })}>
        <option value="">All</option>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FormField>
  );

  return (
    <>
      <PageHeader
        title="Requests"
        subtitle="Every gateway call with tokens, cost and latency. Click a row for full details."
        actions={
          <>
            <LiveToggle live={live} />
            <a className="btn" href={`/api/admin/analytics/logs.csv${filterQs}`} download title="Exports up to 500 most recent matching rows">
              <Download size={14} /> Export CSV
            </a>
          </>
        }
      />
      <div className="card mb-2">
        <div className="card-body">
          <div className="toolbar" style={{ marginBottom: 10 }}>
            <FormField label="Date range">
              <DateRangePicker value={range} onChange={setRange} />
            </FormField>
            <FormField label="Search" className="search">
              <div className="input-icon">
                <Search size={14} />
                <input className="input input-sm" placeholder="Request ID, model, error, end user…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </FormField>
          </div>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            {sel_('appId', 'App', (apps.data ?? []).map((a) => ({ value: a.id, label: a.name })))}
            {sel_('keyId', 'API key', (keys.data ?? []).map((a) => ({ value: a.id, label: `${a.name} (${a.displayKey})` })))}
            {sel_('providerId', 'Provider', (providers.data ?? []).map((a) => ({ value: a.id, label: a.name })))}
            {sel_('modelId', 'Model', (models.data ?? []).map((a) => ({ value: a.id, label: a.slug })))}
            {sel_('status', 'Status', ['success', 'error', 'blocked', 'aborted'].map((s) => ({ value: s, label: s })))}
            {sel_('endpoint', 'Endpoint', ['chat', 'messages', 'embeddings'].map((s) => ({ value: s, label: s })))}
          </div>
        </div>
      </div>
      <div className="card">
        {error && !data ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data ? (
          <Loading />
        ) : (
          <div style={{ opacity: loading && !live.on ? 0.6 : 1 }}>
            {error ? <Alert tone="warning" title="Live refresh failed; showing the last results." /> : null}
            <DataTable columns={columns} rows={data.rows} rowKey={(r) => r.id} onRowClick={setSel} selectedKey={sel?.id} highlightKeys={fresh} emptyTitle="No requests match these filters" compact />
            <div className="row between" style={{ borderTop: '1px solid var(--border)', gap: 0 }}>
              <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
              <label className="row small muted" style={{ paddingRight: 14 }}>
                Rows
                <select className="select select-sm" style={{ width: 80 }} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                  {[25, 50, 100, 200].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        )}
      </div>
      <LogDrawer row={sel} onClose={() => setSel(null)} />
    </>
  );
}
