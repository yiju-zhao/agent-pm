import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LiveStatus } from '../shared/protocol.ts';
import type { SnapshotSession } from '../shared/protocol.ts';
import { makeSessionKey, pendingKey } from '../shared/session-key.ts';

const execFileAsync = promisify(execFile);

const SNAPSHOT_TIMEOUT_MS = 15_000;
const SNAPSHOT_MAX_BUFFER = 64 * 1024 * 1024;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function nonEmptyStr(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Native session id from herdr's `agent_session: { kind: 'id', value }`; null when herdr has none yet. */
function nativeIdOf(agentSession: unknown): string | null {
  if (!isObj(agentSession)) return null;
  if (agentSession.kind !== undefined && agentSession.kind !== 'id') return null;
  return nonEmptyStr(agentSession.value);
}

function liveStatusOf(v: unknown): LiveStatus {
  const parsed = LiveStatus.safeParse(v);
  return parsed.success ? parsed.data : 'unknown';
}

/**
 * Turns the JSON of `herdr api snapshot` (`{ result: { snapshot: { panes } } }`) into sessions:
 * one per pane that has an `agent`. Panes without a pane_id or terminal_id are skipped. Throws when
 * the input does not look like a snapshot at all, so the collector loop backs off instead of
 * pushing an empty session list.
 */
export function parseHerdrSnapshot(json: unknown, machine: string): SnapshotSession[] {
  if (!isObj(json)) throw new Error('invalid herdr snapshot: expected a JSON object');
  const result = json.result;
  const snapshot = isObj(result) ? result.snapshot : undefined;
  const panes = isObj(snapshot) ? snapshot.panes : undefined;
  if (!Array.isArray(panes)) throw new Error('invalid herdr snapshot: result.snapshot.panes is not an array');

  const sessions: SnapshotSession[] = [];
  for (const pane of panes) {
    if (!isObj(pane)) continue;
    const agentKind = nonEmptyStr(pane.agent);
    const paneId = nonEmptyStr(pane.pane_id);
    const terminalId = nonEmptyStr(pane.terminal_id);
    if (agentKind === null || paneId === null || terminalId === null) continue;

    const nativeId = nativeIdOf(pane.agent_session);
    sessions.push({
      key: nativeId === null ? pendingKey(machine, terminalId) : makeSessionKey(agentKind, nativeId),
      agent_kind: agentKind,
      native_id: nativeId,
      pane_id: paneId,
      terminal_id: terminalId,
      workspace_id: str(pane.workspace_id),
      tab_id: str(pane.tab_id),
      cwd: str(pane.cwd),
      title: typeof pane.terminal_title_stripped === 'string' ? pane.terminal_title_stripped : str(pane.terminal_title),
      live_status: liveStatusOf(pane.agent_status),
      // Task 8 upgrades these once it finds the transcript file for the session.
      fidelity: 'screen',
      transcript_path: null,
    });
  }
  return sessions;
}

function describeExecError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const { stderr, killed } = e as Error & { stderr?: unknown; killed?: unknown };
  if (killed === true) return `timed out after ${SNAPSHOT_TIMEOUT_MS / 1000}s`;
  const detail = typeof stderr === 'string' ? stderr.trim() : '';
  return detail === '' ? e.message : detail;
}

/** Runs `<herdrBin> api snapshot` and returns its stdout parsed as JSON. Rejects on failure, with stderr in the message. */
export async function readHerdrSnapshot(herdrBin: string): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(herdrBin, ['api', 'snapshot'], {
      timeout: SNAPSHOT_TIMEOUT_MS,
      maxBuffer: SNAPSHOT_MAX_BUFFER,
    }));
  } catch (e) {
    throw new Error(`herdr api snapshot failed: ${describeExecError(e)}`, { cause: e });
  }
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`herdr api snapshot returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** Runs `<herdrBin> agent read <pane> --source recent-unwrapped --lines 200` and returns the pane's recent text. */
export async function readHerdrScreen(herdrBin: string, paneId: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      herdrBin,
      ['agent', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '200'],
      { timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: SNAPSHOT_MAX_BUFFER },
    );
    return stdout;
  } catch (e) {
    throw new Error(`herdr agent read ${paneId} failed: ${describeExecError(e)}`, { cause: e });
  }
}

/**
 * The agent process of a pane from `herdr pane process-info` JSON
 * (`{ result: { process_info: { foreground_process_group_id, foreground_processes: [{ pid, cwd }] } } }`):
 * the foreground process group leader, else the first foreground process. Null when there is none.
 */
export function parsePaneProcessInfo(json: unknown): { pid: number; cwd: string } | null {
  if (!isObj(json) || !isObj(json.result)) return null;
  const info = json.result.process_info;
  if (!isObj(info) || !Array.isArray(info.foreground_processes)) return null;
  const procs = info.foreground_processes.filter(
    (p): p is Obj => isObj(p) && typeof p.pid === 'number' && Number.isInteger(p.pid) && p.pid > 0,
  );
  const leader = procs.find((p) => p.pid === info.foreground_process_group_id) ?? procs[0];
  return leader === undefined ? null : { pid: leader.pid as number, cwd: str(leader.cwd) };
}

/** Runs `<herdrBin> pane process-info --pane <id>`; null when herdr fails or reports no foreground process. */
export async function readPaneProcess(herdrBin: string, paneId: string): Promise<{ pid: number; cwd: string } | null> {
  try {
    const { stdout } = await execFileAsync(herdrBin, ['pane', 'process-info', '--pane', paneId], {
      timeout: SNAPSHOT_TIMEOUT_MS,
      maxBuffer: SNAPSHOT_MAX_BUFFER,
    });
    return parsePaneProcessInfo(JSON.parse(stdout));
  } catch {
    return null;
  }
}
