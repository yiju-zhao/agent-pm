const PENDING_PREFIX = 'pending';
/** Paseo agents whose provider session id is not known yet: `paseo-pending:<server id>:<agent id>`. */
const PASEO_PENDING_PREFIX = 'paseo-pending';
const MIN_SHORT_ID_LENGTH = 8;

export type ParsedSessionKey =
  | { kind: 'native'; agentKind: string; nativeId: string }
  | { kind: 'pending'; machine: string; terminalId: string }
  | { kind: 'source_pending'; source: 'paseo'; serverId: string; agentId: string };

/** Primary key for a session that has a native id: `<agent kind>:<native session id>`. */
export function makeSessionKey(agentKind: string, nativeId: string): string {
  return `${agentKind}:${nativeId}`;
}

/** Temporary key for a session whose native id is not known yet. */
export function pendingKey(machine: string, terminalId: string): string {
  return `${PENDING_PREFIX}:${machine}:${terminalId}`;
}

/**
 * Temporary key for a Paseo agent whose provider session id is not known yet. It is scoped by the daemon's server id,
 * never shares the herdr `pending:` namespace, and gets its short id from the agent id.
 */
export function paseoPendingKey(serverId: string, agentId: string): string {
  return `${PASEO_PENDING_PREFIX}:${serverId}:${agentId}`;
}

/**
 * The key of a provider session seen on `machine` when the plain native key already belongs to a session observed on
 * another machine: the same native id on two machines is kept apart (a copied or forked session), never merged.
 */
export function crossMachineKey(agentKind: string, nativeId: string, machine: string): string {
  return `${makeSessionKey(agentKind, nativeId)}@${machine}`;
}

/**
 * Splits on the first `:`; a `pending` prefix is split once more into machine and terminal id, a `paseo-pending`
 * prefix into server id and agent id.
 */
export function parseSessionKey(key: string): ParsedSessionKey {
  const sep = key.indexOf(':');
  if (sep <= 0 || sep === key.length - 1) {
    throw new Error(`invalid session key: ${JSON.stringify(key)}`);
  }
  const prefix = key.slice(0, sep);
  const rest = key.slice(sep + 1);
  if (prefix !== PENDING_PREFIX && prefix !== PASEO_PENDING_PREFIX) {
    return { kind: 'native', agentKind: prefix, nativeId: rest };
  }
  const sep2 = rest.indexOf(':');
  if (sep2 <= 0 || sep2 === rest.length - 1) {
    throw new Error(`invalid pending session key: ${JSON.stringify(key)}`);
  }
  if (prefix === PASEO_PENDING_PREFIX) {
    return { kind: 'source_pending', source: 'paseo', serverId: rest.slice(0, sep2), agentId: rest.slice(sep2 + 1) };
  }
  return { kind: 'pending', machine: rest.slice(0, sep2), terminalId: rest.slice(sep2 + 1) };
}

/** What a key's short id is cut from: the native id, the herdr terminal id, or the Paseo agent id. */
export function shortIdSource(key: string): string {
  const parsed = parseSessionKey(key);
  if (parsed.kind === 'native') return parsed.nativeId;
  return parsed.kind === 'pending' ? parsed.terminalId : parsed.agentId;
}

/**
 * Short id = first 8 chars of the native id (terminal id for pending sessions, agent id for Paseo pending ones), extended one
 * char at a time while another id shares the same-length prefix. An id is never extended past its
 * own length, so two keys with identical source ids still end up sharing a short id.
 */
export function assignShortIds(keys: string[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const key of keys) sources.set(key, shortIdSource(key));

  const result = new Map<string, string>();
  const unresolved = new Set(sources.keys());
  const maxLength = Math.max(MIN_SHORT_ID_LENGTH, ...[...sources.values()].map((s) => s.length));

  for (let length = MIN_SHORT_ID_LENGTH; unresolved.size > 0 && length <= maxLength; length++) {
    const prefixCounts = new Map<string, number>();
    for (const source of sources.values()) {
      const prefix = source.slice(0, length);
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
    for (const key of unresolved) {
      const source = sources.get(key)!;
      const prefix = source.slice(0, length);
      if (prefixCounts.get(prefix) === 1 || length >= source.length) {
        result.set(key, prefix);
        unresolved.delete(key);
      }
    }
  }
  return result;
}
