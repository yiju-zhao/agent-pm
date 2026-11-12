// Browser requests use a same-origin HttpOnly session. Existing token helpers remain for legacy clients;
// the account login clears old browser keys and 401 returns the person to the login screen.

// Legacy storage key, cleared when the account flow starts.
export const TOKEN_KEY = 'herdr-pm.userToken';
/** Dispatched on `window` when the server requires a fresh administrator login (401). */
export const AUTH_EVENT = 'herdr-pm:auth';

let cookieAuthentication = false;
/** The account flow never reads or sends a legacy key, even if storage cannot be cleared. */
export function enableCookieAuthentication(): void { cookieAuthentication = true; }

export class ApiError extends Error {
  /** HTTP status, or 0 when the server could not be reached at all. */
  readonly status: number;
  /** The server's `error` code, or `no_token`, `network`, `bad_response`, `http_<status>` raised by this client. */
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// localStorage can throw (blocked site data, some private windows): then there is simply no token.
export function getToken(): string | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    return token === null || token === '' ? null : token;
  } catch {
    return null;
  }
}

/** Stores (or with null, removes) the token; false when the browser refused, so the caller can say so. */
export function setToken(token: string | null): boolean {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
    return true;
  } catch {
    return false;
  }
}

/** Protected reads use the browser cookie; auth also supports a bearer key for legacy consumers. */
export async function apiGet<T>(path: string, opts: { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.auth && !cookieAuthentication && getToken()) headers.Authorization = `Bearer ${getToken()}`;
  return request<T>(path, { method: 'GET', headers, cache: 'no-store' });
}

export async function apiSend<T>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Agent-PM': 'browser' };
  if (!cookieAuthentication && getToken()) headers.Authorization = `Bearer ${getToken()}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return request<T>(path, init);
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, { ...init, credentials: 'same-origin' });
    text = await res.text();
  } catch {
    throw new ApiError(0, 'network', '连不上服务器');
  }
  if (res.status === 401) window.dispatchEvent(new Event(AUTH_EVENT));

  let body: unknown;
  let parsed = true;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = false;
  }

  if (!res.ok) {
    if (parsed && typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') {
      const { error, message } = body as { error: string; message?: unknown };
      throw new ApiError(res.status, error, typeof message === 'string' ? message : undefined);
    }
    throw new ApiError(res.status, `http_${res.status}`, `服务器返回了错误（HTTP ${res.status}）`);
  }
  if (!parsed) throw new ApiError(res.status, 'bad_response', '服务器返回的内容无法解析');
  return body as T;
}

/** A session key holds colons (`claude:abc`), so it must be encoded before it goes into a URL path. */
export function sessionPath(key: string): string {
  return encodeURIComponent(key);
}

// Every code the operation layer can refuse with (RejectCode in src/domain/types.ts), plus the ones this client raises.
const CODE_TEXT: Record<string, string> = {
  no_token: '请先登录管理员账号',
  network: '连不上服务器',
  not_found: '找不到对象，可能已被删除',
  merged: '项目已合并到别的项目',
  vetoed: '这条已被你否决，AI 不会再加回来',
  user_only: '这个操作只能由你来做',
  missing_reason: '缺少理由',
  missing_evidence: '缺少证据',
  not_pending: '这个问题已经处理过了',
  stale: '情况已变，这个问题已撤回',
  question_limit: '待回答的问题太多了',
  recently_rejected: '最近刚被拒绝过',
  conflict: '和后来的改动冲突，没法撤销',
  already_reverted: '已经撤销过了',
  not_revertible: '这条记录不能撤销',
  understanding_disabled: '理解层没有开启',
  too_large: '内容太长',
  // app.onError answers an unexpected exception with this code and no message.
  internal: '服务器内部错误',
};

// For these the server's own words say what exactly is wrong, so they follow a Chinese prefix.
const CODE_PREFIX: Record<string, string> = {
  invalid: '内容不符合要求',
  not_allowed: '不允许这个操作',
};

/** What to tell the person about a failed request: our Chinese text for the codes we know, else the server's own message. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return CODE_TEXT.no_token;
    if (Object.hasOwn(CODE_TEXT, err.code)) return CODE_TEXT[err.code];
    if (Object.hasOwn(CODE_PREFIX, err.code)) {
      // A reply without a `message` leaves the ApiError with the code as its message: that is no detail.
      const detail = err.message === err.code ? '' : err.message;
      return detail === '' ? CODE_PREFIX[err.code] : `${CODE_PREFIX[err.code]}：${detail}`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
