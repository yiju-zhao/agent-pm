import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { KeyView } from '../../../src/server/keys.ts';
import { apiSend, errorText } from '../api.ts';
import { Dialog } from '../components/dialog.tsx';
import { useToast } from '../components/toast.tsx';
import { copyText } from '../copy.ts';
import { relTime, shortDate } from '../format.ts';
import { useApi } from '../use-api.ts';
import { useNow } from '../use-now.ts';

type KeysResponse = { keys: KeyView[]; machines: string[]; paseo_sources: string[] };
type Kind = 'mcp' | 'herdr' | 'paseo' | 'admin';
type CreatedKey = KeyView & { key: string };
const PURPOSE: Record<Kind, { title: string; detail: string }> = {
  mcp: { title: 'Agent · MCP', detail: '读取项目看板、上报工作进展。不能直接修改项目或设置。' },
  herdr: { title: 'herdr 采集器', detail: '仅上传指定机器的会话数据。' },
  paseo: { title: 'Paseo 采集器', detail: '仅上传指定 Paseo 来源的会话数据。' },
  admin: { title: '管理员脚本', detail: '可修改项目、读取对话原文、管理所有密钥和设置。' },
};
export function scopeLabel(scope: string): string {
  if (scope === 'admin') return '管理员';
  if (scope === 'mcp') return 'Agent（MCP）';
  if (scope.startsWith('ingest:herdr:')) return `herdr 采集器 · ${scope.slice(13)}`;
  if (scope.startsWith('ingest:paseo:')) return `Paseo 采集器 · ${scope.slice(13)}`;
  return scope;
}
function usageHint(scope: string): string {
  if (scope === 'mcp') return `claude mcp add --scope user --transport http agent-pm ${window.location.origin}/mcp --header "Authorization: Bearer <API_KEY>"`;
  if (scope.startsWith('ingest:herdr:')) return '将密钥填入对应机器的 collector.json 的 token 字段，然后重启采集器。';
  if (scope.startsWith('ingest:paseo:')) return '将密钥保存到对应采集器的 tokenFile 文件，设置文件权限为 600，然后重启采集器。';
  return '在受信任的服务端脚本中，通过 Authorization: Bearer <API_KEY> 发送请求。';
}
function CreateKeyDialog({ data, onClose, onCreated }: { data: KeysResponse; onClose(): void; onCreated(): void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('mcp');
  const [machine, setMachine] = useState('');
  const [source, setSource] = useState(data.paseo_sources[0] ?? '');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<CreatedKey | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const id = useId();
  const ready = name.trim() !== '' && (kind !== 'herdr' || /^[A-Za-z0-9._-]+$/.test(machine.trim())) && (kind !== 'paseo' || source !== '');
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true); setError(null);
    const scope = kind === 'mcp' || kind === 'admin' ? kind : kind === 'herdr' ? `ingest:herdr:${machine.trim()}` : `ingest:paseo:${source}`;
    try {
      setMade(await apiSend<CreatedKey>('POST', '/admin/keys', { name: name.trim(), scope }));
      onCreated();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };
  return <Dialog title={made ? '保存接入密钥' : '创建接入密钥'} onClose={onClose} locked={busy || made !== null} className="key-dialog">
    <div className="dialog-heading"><div><p className="eyebrow">{made ? '密钥已创建' : '新建连接'}</p><h2>{made ? '保存接入密钥' : '创建接入密钥'}</h2></div>
      {!made && <button type="button" className="icon-btn" aria-label="关闭" disabled={busy} onClick={onClose}>×</button>}</div>
    {made ? <section className="keys-revealed">
      <p>「{made.name}」已准备就绪。完整密钥仅在此显示一次，关闭后无法再次查看。</p>
      <label htmlFor={`${id}-secret`}>接入密钥</label>
      <div className="keys-secret"><input id={`${id}-secret`} aria-label="新的 key" readOnly value={made.key} onFocus={(e) => e.target.select()} />
        <button type="button" onClick={async () => { const ok = await copyText(made.key); setCopied(ok); setError(ok ? null : '复制失败，请手动选中密钥复制。'); }}>{copied ? '已复制' : '复制密钥'}</button></div>
      <p className="dim">权限：{scopeLabel(made.scope)}</p>
      <details className="connection-help"><summary>如何接入</summary><pre className="keys-usage">{usageHint(made.scope)}</pre>{made.scope === 'mcp' && <p className="dim">将 &lt;API_KEY&gt; 替换为上方密钥。接入命令不包含真实密钥。</p>}</details>
      <label className="checkbox-row"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />我已安全保存密钥</label>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="dialog-footer"><button type="button" className="primary" disabled={!saved} onClick={onClose}>完成</button></div>
    </section> : <form className="key-form" onSubmit={create}>
      <p className="dim">为每个 agent 或采集器单独创建密钥，方便识别和独立吊销。</p>
      <fieldset disabled={busy} className="key-fields">
        <label htmlFor={`${id}-name`}>名称</label><input autoFocus id={`${id}-name`} value={name} maxLength={120} placeholder="例如：MacBook 上的 Codex" onChange={(e) => setName(e.target.value)} required />
        <label htmlFor={`${id}-kind`}>用途</label><select id={`${id}-kind`} value={kind} onChange={(e) => { setKind(e.target.value as Kind); setError(null); }}>
          {(['mcp', 'herdr', 'paseo', ...(advanced ? ['admin'] : [])] as Kind[]).map((k) => <option key={k} value={k}>{PURPOSE[k].title}</option>)}
        </select>
        <div className={`permission-preview ${kind === 'admin' ? 'permission-admin' : ''}`}><span className="eyebrow">授权范围</span><p>{PURPOSE[kind].detail}</p></div>
        {kind === 'herdr' && <><label htmlFor={`${id}-machine`}>绑定机器</label><input id={`${id}-machine`} list={`${id}-machines`} value={machine} placeholder="例如：laptop" onChange={(e) => setMachine(e.target.value)} required /><datalist id={`${id}-machines`}>{data.machines.map((m) => <option key={m} value={m} />)}</datalist><p className="field-help">机器标识使用字母、数字、点、下划线或连字符。</p></>}
        {kind === 'paseo' && <><label htmlFor={`${id}-source`}>绑定来源</label><select id={`${id}-source`} value={source} onChange={(e) => setSource(e.target.value)}><option value="" disabled>选择 Paseo 来源</option>{data.paseo_sources.map((s) => <option key={s} value={s}>{s}</option>)}</select>{data.paseo_sources.length === 0 && <p className="field-help">尚无可用来源，请先在中心配置中添加 Paseo 来源。</p>}</>}
        <details onToggle={(e) => { const open = e.currentTarget.open; setAdvanced(open); if (!open && kind === 'admin') setKind('mcp'); }}><summary>高级权限</summary><p className="dim">受信任的管理脚本可在“用途”中选择管理员权限。网页登录使用账号和密码。</p></details>
      </fieldset>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="dialog-footer"><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" type="submit" disabled={busy || !ready}>{busy ? '正在创建…' : '创建密钥'}</button></div>
    </form>}
  </Dialog>;
}
function RevokeKeyDialog({ target, onClose, onRevoked }: { target: KeyView; onClose(): void; onRevoked(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <Dialog title="吊销接入密钥" onClose={onClose} locked={busy} className="key-dialog revoke-dialog">
    <div className="dialog-heading"><h2>吊销接入密钥</h2></div>
    <p>确定吊销「<strong>{target.name}</strong>」？使用此密钥的 {target.scope === 'mcp' ? 'agent' : target.scope === 'admin' ? '管理脚本' : '采集器'} 将立即失去访问权限，此操作无法撤销。</p>
    <div className="permission-preview"><code>{target.prefix}…</code><p>{scopeLabel(target.scope)}</p></div>
    <p className="dim">如果正在更换密钥，请先创建新密钥并更新连接，再吊销旧密钥。</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="dialog-footer"><button type="button" autoFocus disabled={busy} onClick={onClose}>取消</button><button className="danger-solid" type="button" disabled={busy} onClick={async () => {
      setBusy(true); setError(null);
      try { await apiSend('DELETE', `/admin/keys/${encodeURIComponent(target.id)}`); onRevoked(); }
      catch (err) { setError(errorText(err)); setBusy(false); }
    }}>{busy ? '正在吊销…' : '确认吊销'}</button></div>
  </Dialog>;
}
export function KeysPage() {
  const toast = useToast();
  const now = useNow();
  const { data, error, reload } = useApi<KeysResponse>('/admin/keys', [], { auth: true });
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<KeyView | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  const [purpose, setPurpose] = useState('all');
  const managed = data?.keys.filter((key) => key.origin !== 'config') ?? [];
  const configKeys = data?.keys.filter((key) => key.origin === 'config') ?? [];
  const filtered = managed.filter((key) => (status === 'all' || (status === 'active' ? key.revoked_at === null : key.revoked_at !== null))
    && (purpose === 'all' || (purpose === 'collector' ? key.scope.startsWith('ingest:') : key.scope === purpose))
    && `${key.name} ${scopeLabel(key.scope)} ${key.prefix ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <main data-page="keys" className="keys-page">
    <header className="keys-page-head"><div><p className="eyebrow">开发者 / 连接管理</p><h2>接入密钥 <span className="heading-en">API Keys</span></h2><p className="dim">让 agent 和采集器连接 agent-pm。模型服务的凭据在设置中管理。</p></div><button className="primary" type="button" disabled={!data} onClick={() => setCreating(true)}>＋ 创建密钥</button></header>
    {error && <div className="error-state" role="alert"><p>{errorText(error)}</p><button type="button" onClick={reload}>重新加载</button></div>}
    {!data && !error && <p role="status" className="dim">正在加载接入密钥…</p>}
    {data && <>
      <section className="keys-register" aria-label="接入密钥列表">
        <div className="keys-register-heading"><h3>管理的密钥 <span className="count-badge">{managed.filter((k) => !k.revoked_at).length} 个有效</span></h3><span className="dim">完整密钥仅在创建时显示</span></div>
        <div className="keys-toolbar"><input type="search" aria-label="搜索密钥" placeholder="搜索名称、权限或前缀…" value={query} onChange={(e) => setQuery(e.target.value)} /><select aria-label="筛选用途" value={purpose} onChange={(e) => setPurpose(e.target.value)}><option value="all">所有用途</option><option value="mcp">Agent · MCP</option><option value="collector">采集器</option><option value="admin">管理员脚本</option></select><select aria-label="筛选状态" value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">有效密钥</option><option value="revoked">已吊销</option><option value="all">全部状态</option></select></div>
        <div className="keys-table-scroll"><table className="keys-table" role="table"><thead role="rowgroup"><tr role="row"><th scope="col">名称 / 密钥</th><th scope="col">授权范围</th><th scope="col">状态</th><th scope="col">创建时间</th><th scope="col">最近使用</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead><tbody role="rowgroup">{filtered.map((key) => <tr role="row" key={key.id}>
          <td><strong>{key.name}</strong><code className="key-prefix">{key.prefix}…</code></td><td><span className={`scope-badge ${key.scope === 'admin' ? 'scope-admin' : ''}`}>{scopeLabel(key.scope)}</span></td><td><span className={`key-status ${key.revoked_at ? 'is-revoked' : ''}`}>{key.revoked_at ? '已吊销' : '有效'}</span></td>
          <td data-label="创建">{key.created_at ? <time dateTime={key.created_at} title={key.created_at}>{shortDate(key.created_at)}</time> : '—'}</td><td data-label="最近使用">{key.last_used_at ? <time dateTime={key.last_used_at} title={key.last_used_at}>{relTime(key.last_used_at, now)}</time> : <span className="dim">尚未使用</span>}</td><td>{key.revoked_at ? <span className="dim" title={key.revoked_at}>{shortDate(key.revoked_at)}</span> : <button type="button" className="text-danger" aria-label={`吊销 ${key.name}`} onClick={() => setRevoking(key)}>吊销</button>}</td>
        </tr>)}</tbody></table></div>
        {filtered.length === 0 && <div className="keys-empty"><h3>{managed.length === 0 ? '连接你的第一个 agent' : '没有符合条件的密钥'}</h3><p className="dim">{managed.length === 0 ? '创建专属密钥，再将它配置到 agent 或采集器中。' : '试试其他搜索词，或调整用途和状态筛选。'}</p>{managed.length === 0 && <button type="button" onClick={() => setCreating(true)}>创建接入密钥</button>}</div>}
      </section>
      {configKeys.length > 0 && <details className="config-keys"><summary>配置文件中的密钥 <span className="count-badge">{configKeys.length}</span><span className="dim">由中心配置管理</span></summary><p className="dim">这些密钥仍然有效。要更换或停用，请修改中心配置并重启服务。</p><ul>{configKeys.map((key) => <li key={key.id}><strong>{key.name}</strong><span className="scope-badge">{scopeLabel(key.scope)}</span><span className="dim">只读</span></li>)}</ul></details>}
      <aside className="keys-guidance"><div><h3>按连接分配，按需授权</h3><p>每个 agent 或采集器使用独立密钥。更换时，先更新连接，再吊销旧密钥。</p></div><div><h3>模型凭据在哪里？</h3><p>Claude 登录、OAuth token 和 Anthropic API key 用于调用模型，在“设置 → 模型服务”中配置。</p></div></aside>
    </>}
    {creating && data && <CreateKeyDialog data={data} onClose={() => setCreating(false)} onCreated={reload} />}
    {revoking && <RevokeKeyDialog target={revoking} onClose={() => setRevoking(null)} onRevoked={() => { toast(`已吊销「${revoking.name}」`); setRevoking(null); reload(); }} />}
  </main>;
}
