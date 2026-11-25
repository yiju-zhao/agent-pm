export class ContextAddressError extends Error {}

export type Address =
  | { kind: 'session'; session: string }
  | { kind: 'turn'; session: string; turn: number }
  | { kind: 'item'; session: string; turn: number; item: number };

export function parseAddress(text: string): Address {
  const parts = /^s:([^\s#]+)(?:#([1-9]\d*)(?:\.([1-9]\d*))?)?$/.exec(text);
  if (!parts) throw new ContextAddressError(`无效的地址：${text}`);
  const [, session, turn, item] = parts;
  if (!turn) return { kind: 'session', session };
  if (!Number.isSafeInteger(Number(turn)) || (item && !Number.isSafeInteger(Number(item))))
    throw new ContextAddressError(`地址序号超出范围：${text}`);
  if (!item) return { kind: 'turn', session, turn: Number(turn) };
  return { kind: 'item', session, turn: Number(turn), item: Number(item) };
}

export function formatAddress(address: Address): string {
  const session = 's:' + address.session;
  if (address.kind === 'session') return session;
  if (address.kind === 'turn') return session + '#' + address.turn;
  return session + '#' + address.turn + '.' + address.item;
}
