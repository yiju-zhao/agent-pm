// Pure core of `herdr-pm open`: list the agents on this machine and on every enabled herdr remote
// machine, and match a short id against them. It is bundled into a single-file bun binary, so it
// must import nothing but node built-ins (and src/lookup, src/shared, zod): no server, no domain.

export type LookupAgent = {
  /** Remote machine label; null = this machine. */
  machine: string | null;
  /** ssh target of a remote machine; null for this machine. */
  target: string | null;
  pane_id: string;
  agent_kind: string;
  native_id: string | null;
  terminal_id: string;
  title: string;
  cwd: string;
  status: string;
};

/** Runs `herdr <args>` and returns its stdout; rejects on failure or when `timeoutMs` runs out. */
export type RunHerdr = (args: string[], timeoutMs: number) => Promise<string>;

export const MACHINE_TIMEOUT_MS = 8000;

const LOCAL_NAME = '本机';
const MACHINE_LIST_NAME = '机器列表';
const SHORT_ID = /^[a-z0-9_-]{4,64}$/;
const QUOTES = new Set(['"', "'", '`']);

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyStr(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Cleans up a pasted short id: surrounding whitespace and paired quotes / backticks go, a pasted
 * key (`claude:0d67…`, `pending:gx10:term_…`) is cut down to what follows its last `:`, and the
 * result is lower-cased. `null` when what is left cannot be a short id.
 */
export function normalizeShortId(input: string): string | null {
  let s = input.trim();
  while (s.length >= 2 && QUOTES.has(s[0]!) && s[0] === s[s.length - 1]) s = s.slice(1, -1).trim();
  s = s.slice(s.lastIndexOf(':') + 1).toLowerCase();
  return SHORT_ID.test(s) ? s : null;
}

/**
 * Turns the JSON of `herdr agent list` (`{ result: { agents: [...] } }`) into agents of `machine`
 * (null = this machine). Entries without a pane_id or terminal_id are skipped. Throws, naming the
 * machine, when the input does not look like an agent list at all.
 */
export function parseAgentList(json: unknown, machine: { label: string; target: string } | null): LookupAgent[] {
  const result = isObj(json) ? json.result : undefined;
  const agents = isObj(result) ? result.agents : undefined;
  if (!Array.isArray(agents)) {
    throw new Error(`${machine?.label ?? LOCAL_NAME}: herdr agent list 的输出格式不对（result.agents 不是数组）`);
  }

  const out: LookupAgent[] = [];
  for (const entry of agents) {
    if (!isObj(entry)) continue;
    const paneId = nonEmptyStr(entry.pane_id);
    const terminalId = nonEmptyStr(entry.terminal_id);
    if (paneId === null || terminalId === null) continue;
    const session = entry.agent_session;
    out.push({
      machine: machine?.label ?? null,
      target: machine?.target ?? null,
      pane_id: paneId,
      agent_kind: nonEmptyStr(entry.agent) ?? 'unknown',
      native_id: isObj(session) && session.kind === 'id' ? nonEmptyStr(session.value) : null,
      terminal_id: terminalId,
      title: nonEmptyStr(entry.terminal_title_stripped) ?? nonEmptyStr(entry.terminal_title) ?? '',
      cwd: nonEmptyStr(entry.cwd) ?? '',
      status: nonEmptyStr(entry.agent_status) ?? 'unknown',
    });
  }
  return out;
}

/** Enabled machines from `herdr machine list --json` (`[{ label, target, enabled, … }]`). */
export function parseMachineList(json: unknown): Array<{ label: string; target: string }> {
  if (!Array.isArray(json)) throw new Error('herdr machine list 的输出格式不对（不是数组）');
  const machines: Array<{ label: string; target: string }> = [];
  for (const entry of json) {
    if (!isObj(entry) || entry.enabled !== true) continue;
    const label = nonEmptyStr(entry.label);
    const target = nonEmptyStr(entry.target);
    if (label !== null && target !== null) machines.push({ label, target });
  }
  return machines;
}

/** First line of an error message, so an ssh failure with a long trailer stays readable. */
function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0]!.trim() || '未知错误';
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** Never rejects, not even when `fn` throws before returning a promise. */
async function settle<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: reasonOf(err) };
  }
}

async function queryAgents(
  run: RunHerdr,
  args: string[],
  machine: { label: string; target: string } | null,
): Promise<LookupAgent[]> {
  const stdout = await run(args, MACHINE_TIMEOUT_MS);
  return parseAgentList(JSON.parse(stdout) as unknown, machine);
}

/**
 * Agents on this machine and on every enabled remote machine, all asked at the same time with the
 * same timeout, so one dead machine costs at most `MACHINE_TIMEOUT_MS` and hides nothing else. A
 * machine that fails is listed in `unreachable` with the first line of its error. The result
 * puts this machine first, then the remote machines in `herdr machine list` order.
 */
export async function listAllAgents(
  run: RunHerdr,
): Promise<{ agents: LookupAgent[]; unreachable: Array<{ machine: string; error: string }> }> {
  // The local query does not wait for the machine list: both are local herdr calls.
  const localQuery = settle(() => queryAgents(run, ['agent', 'list'], null));
  const machineList = await settle(async () =>
    parseMachineList(JSON.parse(await run(['machine', 'list', '--json'], MACHINE_TIMEOUT_MS)) as unknown),
  );
  const machines = machineList.ok ? machineList.value : [];
  const remoteQueries = machines.map((m) =>
    settle(() => queryAgents(run, ['--machine', m.label, 'agent', 'list'], m)),
  );

  const named: Array<[string, Outcome<LookupAgent[]>]> = [
    [LOCAL_NAME, await localQuery],
    ...(await Promise.all(remoteQueries)).map((o, i): [string, Outcome<LookupAgent[]>] => [machines[i]!.label, o]),
  ];

  const agents: LookupAgent[] = [];
  const unreachable: Array<{ machine: string; error: string }> = [];
  if (!machineList.ok) unreachable.push({ machine: MACHINE_LIST_NAME, error: machineList.error });
  for (const [machine, outcome] of named) {
    if (outcome.ok) agents.push(...outcome.value);
    else unreachable.push({ machine, error: outcome.error });
  }
  return { agents, unreachable };
}

/**
 * Agents whose session id starts with `sid`: the native id when herdr has one, else the terminal
 * id (a session that has not been given its native id yet). Case-insensitive. Panes with the same
 * pane id on the same machine count once. Two panes resuming one session both match, so the
 * caller can ask which one is meant.
 */
export function matchShortId(agents: LookupAgent[], sid: string): LookupAgent[] {
  const prefix = sid.toLowerCase();
  if (prefix === '') return [];
  const seen = new Set<string>();
  const matches: LookupAgent[] = [];
  for (const a of agents) {
    if (!(a.native_id ?? a.terminal_id).toLowerCase().startsWith(prefix)) continue;
    const key = `${a.machine ?? ''}\u0000${a.pane_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(a);
  }
  return matches;
}
