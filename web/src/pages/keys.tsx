import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { KeyView } from '../../../src/server/keys.ts';
import { apiSend, errorText } from '../api.ts';
import { ConfirmButton } from '../components/confirm-button.tsx';
import { useToast } from '../components/toast.tsx';
import { copyText } from '../copy.ts';
import { relTime, shortDate } from '../format.ts';
import { useApi } from '../use-api.ts';
import { useNow } from '../use-now.ts';

type KeysResponse = { keys: KeyView[]; machines: string[]; paseo_sources: string[] };
type Kind = 'mcp' | 'herdr' | 'paseo' | 'admin';

const KIND_LABEL: Record<Kind, string> = {
  mcp: 'Agent（MCP：读看板、上报进展）',
  herdr: 'herdr 采集器（一台机器）',
  paseo: 'Paseo 采集器（一个来源）',
  admin: '管理员（网页修改、管理 key 和设置）',
};

/** A scope in words, as the list shows it. */
export function scopeLabel(scope: string): string {
  if (scope === 'admin') return '管理员';
  if (scope === 'mcp') return 'Agent（MCP）';
  const herdr = /^ingest:herdr:(.+)$/.exec(scope);
  if (herdr) return `herdr 采集器 · ${herdr[1]}`;
  const paseo = /^ingest:paseo:(.+)$/.exec(scope);
  if (paseo) return `Paseo 采集器 · ${paseo[1]}`;
  return scope;
}

/** Where a freshly made key goes, by scope. */
function usageHint(scope: string, key: string): string {
  if (scope === 'mcp') {
    return `claude mcp add --scope user --transport http herdr-pm ${window.location.origin}/mcp --header "Authorization: Bearer ${key}"`;
  }
  if (scope.startsWith('ingest:herdr:')) return '写进这台机器 collector.json 的 "token"，然后重启 herdr 采集器。';
  if (scope.startsWith('ingest:paseo:')) return '写进这个 Paseo 采集器配置里 tokenFile 指向的文件（chmod 600），然后重启它。';
  return '在 设置 → 访问 里粘贴，就能用这个 key 修改网页上的内容。';
}

function CreateForm({ data, onCreated }: { data: KeysResponse; onCreated: (made: KeyView & { key: string }) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('mcp');
  const [machine, setMachine] = useState('');
  const [source, setSource] = useState(data.paseo_sources[0] ?? '');
  const [busy, setBusy] = useState(false);
  const ids = { name: useId(), kind: useId(), machine: useId(), source: useId() };

  const scope = kind === 'mcp' ? 'mcp' : kind === 'admin' ? 'admin' : kind === 'herdr' ? `ingest:herdr:${machine.trim()}` : `ingest:paseo:${source}`;
  const ready = name.trim() !== '' && (kind !== 'herdr' || machine.trim() !== '') && (kind !== 'paseo' || source !== '');

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onCreated(await apiSend<KeyView & { key: string }>('POST', '/admin/keys', { name: name.trim(), scope }));
      setName('');
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="keys-create" onSubmit={create}>
      <h3>新建 key</h3>
      <label htmlFor={ids.name}>名称</label>
      <input id={ids.name} value={name} placeholder="例如：gx10-090e 上的 agent" onChange={(e) => setName(e.target.value)} />
      <label htmlFor={ids.kind}>权限</label>
      <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k]}
          </option>
        ))}
      </select>
      {kind === 'herdr' ? (
        <>
          <label htmlFor={ids.machine}>机器</label>
          <input id={ids.machine} list={`${ids.machine}-list`} value={machine} onChange={(e) => setMachine(e.target.value)} placeholder="机器 label" />
          <datalist id={`${ids.machine}-list`}>
            {data.machines.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </>
      ) : null}
      {kind === 'paseo' ? (
        data.paseo_sources.length === 0 ? (
          <p className="dim">中心配置的 paseoCollectors 里还没有 Paseo 来源。</p>
        ) : (
          <>
            <label htmlFor={ids.source}>来源</label>
            <select id={ids.source} value={source} onChange={(e) => setSource(e.target.value)}>
              {data.paseo_sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </>
        )
      ) : null}
      {kind === 'admin' ? <p className="warn-text">管理员 key 能改项目和设置，只给你自己的浏览器或脚本用，不要放进 agent 的配置。</p> : null}
      <button type="submit" disabled={busy || !ready}>
        新建
      </button>
    </form>
  );
}

function Revealed({ made, onDone }: { made: KeyView & { key: string }; onDone: () => void }) {
  const toast = useToast();
  return (
    <section className="keys-revealed" role="status">
      <h3>{`已新建「${made.name}」`}</h3>
      <p className="warn-text">这个 key 只显示这一次，现在复制保存好。</p>
      <div className="keys-secret">
        <input readOnly aria-label="新的 key" value={made.key} onFocus={(e) => e.target.select()} />
        <button type="button" onClick={async () => toast((await copyText(made.key)) ? '已复制' : '复制失败，请手动选中复制')}>
          复制
        </button>
      </div>
      <p className="dim">用法：</p>
      <pre className="keys-usage">{usageHint(made.scope, made.key)}</pre>
      <button type="button" onClick={onDone}>
        我已保存
      </button>
    </section>
  );
}

/** The API key page: every key (config ones read-only), making a key for one scope, revoking one. */
export function KeysPage() {
  const toast = useToast();
  const now = useNow();
  const { data, error, reload } = useApi<KeysResponse>('/admin/keys', [], { auth: true });
  const [made, setMade] = useState<(KeyView & { key: string }) | null>(null);

  const revoke = async (k: KeyView) => {
    try {
      await apiSend('DELETE', `/admin/keys/${encodeURIComponent(k.id)}`);
      toast(`已吊销「${k.name}」`);
      reload();
    } catch (err) {
      toast(errorText(err));
    }
  };

  return (
    <main data-page="keys" className="keys-page">
      <h2>API Keys</h2>
      <p className="dim">每个 key 只有一个权限范围。agent 只用「Agent（MCP）」权限的 key；采集器各用自己那台机器或那个来源的 key。</p>
      {error !== null ? <p role="alert">{errorText(error)}</p> : null}
      {data === undefined && error === null ? <p className="dim">加载中…</p> : null}
      {made !== null ? <Revealed made={made} onDone={() => setMade(null)} /> : null}
      {data !== undefined ? (
        <>
          <CreateForm
            data={data}
            onCreated={(k) => {
              setMade(k);
              reload();
            }}
          />
          <table className="keys-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>权限</th>
                <th>key</th>
                <th>创建</th>
                <th>最近使用</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.keys.map((k) => (
                <tr key={k.id} className={k.revoked_at !== null ? 'revoked' : undefined}>
                  <td>{k.name}</td>
                  <td>{scopeLabel(k.scope)}</td>
                  <td>{k.prefix === null ? <span className="dim">配置文件</span> : <code>{`${k.prefix}…`}</code>}</td>
                  <td>{k.created_at === null ? '—' : shortDate(k.created_at)}</td>
                  <td>{k.last_used_at === null ? '—' : relTime(k.last_used_at, now)}</td>
                  <td>
                    {k.origin === 'config' ? (
                      <span className="dim">改配置文件</span>
                    ) : k.revoked_at !== null ? (
                      <span className="dim">{`已吊销 ${shortDate(k.revoked_at)}`}</span>
                    ) : (
                      <ConfirmButton label="吊销" confirmLabel="确认吊销" onConfirm={() => revoke(k)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </main>
  );
}
