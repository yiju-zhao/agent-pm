// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError, AUTH_EVENT, TOKEN_KEY, apiGet, apiSend, errorText, getToken, sessionPath, setToken } from '../../web/src/api.ts';

const fetchMock = vi.fn<typeof fetch>();
const onAuth = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  onAuth.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.addEventListener(AUTH_EVENT, onAuth);
  localStorage.clear();
});

afterEach(() => {
  window.removeEventListener(AUTH_EVENT, onAuth);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('expected the promise to reject');
}

test('apiSend without a token does not fetch', async () => {
  const err = await rejection(apiSend('POST', '/sync'));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(err.status).toBe(401);
  expect(err.code).toBe('no_token');
  expect(onAuth).toHaveBeenCalledTimes(1);
});

test('apiSend sends the bearer token and JSON body', async () => {
  setToken('tok-123');
  fetchMock.mockResolvedValue(json({ status: 'ok' }, 201));
  await expect(apiSend('POST', '/projects', { title: '新项目' })).resolves.toEqual({ status: 'ok' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/projects');
  expect(init?.method).toBe('POST');
  expect(init?.headers).toEqual({ Authorization: 'Bearer tok-123', 'Content-Type': 'application/json' });
  expect(init?.body).toBe(JSON.stringify({ title: '新项目' }));
  expect(onAuth).not.toHaveBeenCalled();
});

test('apiSend without a body sends no body and no content type', async () => {
  setToken('tok-123');
  fetchMock.mockResolvedValue(json({ accepted: true }, 202));
  await apiSend('POST', '/sync');
  const [, init] = fetchMock.mock.calls[0];
  expect(init?.headers).toEqual({ Authorization: 'Bearer tok-123' });
  expect(init?.body).toBeUndefined();
});

test('an empty 2xx body resolves to undefined', async () => {
  setToken('tok-123');
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  await expect(apiSend('DELETE', '/x')).resolves.toBeUndefined();
});

test('a 2xx body that is not JSON is a bad_response error', async () => {
  fetchMock.mockResolvedValue(new Response('<!doctype html>', { status: 200 }));
  const err = await rejection(apiGet('/projects'));
  expect(err.status).toBe(200);
  expect(err.code).toBe('bad_response');
});

test('401 dispatches AUTH_EVENT', async () => {
  setToken('wrong');
  fetchMock.mockResolvedValue(json({ error: 'unauthorized', message: 'missing or invalid user token' }, 401));
  const err = await rejection(apiSend('POST', '/sync'));
  expect(err.status).toBe(401);
  expect(err.code).toBe('unauthorized');
  expect(errorText(err)).toBe('需要先设置 token');
  expect(onAuth).toHaveBeenCalledTimes(1);
});

test('a 401 on apiGet also dispatches AUTH_EVENT', async () => {
  setToken('wrong');
  fetchMock.mockResolvedValue(json({ error: 'unauthorized', message: 'nope' }, 401));
  const err = await rejection(apiGet('/evidence/digest:3', { auth: true }));
  expect(err.status).toBe(401);
  expect(onAuth).toHaveBeenCalledTimes(1);
});

test('409 {error:"stale"} becomes an ApiError with the server status and code', async () => {
  setToken('tok');
  fetchMock.mockResolvedValue(json({ error: 'stale', message: 'the question changed' }, 409));
  const err = await rejection(apiSend('POST', '/questions/q1/answer', { option_id: 'o1' }));
  expect(err.status).toBe(409);
  expect(err.code).toBe('stale');
  expect(err.message).toBe('the question changed');
  expect(errorText(err)).toBe('情况已变，这个问题已撤回');
  expect(onAuth).not.toHaveBeenCalled();
});

test('a non-JSON error body becomes http_<status>', async () => {
  setToken('tok');
  fetchMock.mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 }));
  const err = await rejection(apiSend('POST', '/sync'));
  expect(err.status).toBe(502);
  expect(err.code).toBe('http_502');
  expect(errorText(err)).toContain('502');
});

test('a fetch that rejects becomes a network error', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  const err = await rejection(apiGet('/projects'));
  expect(err.status).toBe(0);
  expect(err.code).toBe('network');
  expect(errorText(err)).toBe('连不上服务器');
});

test('apiGet never sends the token unless auth is asked for', async () => {
  setToken('tok');
  fetchMock.mockResolvedValue(json([]));
  await apiGet('/projects');
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/projects');
  expect(init?.method).toBe('GET');
  expect(init?.headers).toEqual({});
});

test('apiGet with auth sends the bearer token', async () => {
  setToken('tok');
  fetchMock.mockResolvedValue(json({ text: 'x' }));
  await apiGet('/evidence/digest:3', { auth: true });
  expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer tok' });
});

test('apiGet with auth and no token does not fetch, dispatches AUTH_EVENT and throws no_token', async () => {
  const err = await rejection(apiGet('/evidence/digest:3', { auth: true }));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(err.status).toBe(401);
  expect(err.code).toBe('no_token');
  expect(onAuth).toHaveBeenCalledTimes(1);
});

test('a stored empty token counts as no token', async () => {
  localStorage.setItem(TOKEN_KEY, '');
  expect(getToken()).toBeNull();
});

test('setToken stores and clears the token under the agreed key', () => {
  setToken('abc');
  expect(localStorage.getItem(TOKEN_KEY)).toBe('abc');
  expect(getToken()).toBe('abc');
  setToken(null);
  expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  expect(getToken()).toBeNull();
});

test('getToken survives a throwing localStorage', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(getToken()).toBeNull();
});

test('setToken survives a throwing localStorage', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(() => setToken('abc')).not.toThrow();
  expect(() => setToken(null)).not.toThrow();
});

test('sessionPath encodes the colons in a session key', () => {
  expect(sessionPath('claude:abc')).toBe('claude%3Aabc');
  expect(sessionPath('a/b c')).toBe('a%2Fb%20c');
});

test('errorText maps the known codes to Chinese and passes other server messages through', () => {
  const table: Array<[number, string, string]> = [
    [401, 'no_token', '需要先设置 token'],
    [401, 'unauthorized', '需要先设置 token'],
    [0, 'network', '连不上服务器'],
    [409, 'not_pending', '这个问题已经处理过了'],
    [409, 'stale', '情况已变，这个问题已撤回'],
    [409, 'conflict', '和后来的改动冲突，没法撤销'],
    [409, 'already_reverted', '已经撤销过了'],
    [409, 'not_revertible', '这条记录不能撤销'],
    [409, 'understanding_disabled', '理解层没有开启'],
    [413, 'too_large', '内容太长'],
  ];
  for (const [status, code, text] of table) expect(errorText(new ApiError(status, code, 'server words'))).toBe(text);
  expect(errorText(new ApiError(404, 'not_found', '没有这个项目'))).toBe('没有这个项目');
  expect(errorText(new Error('boom'))).toBe('boom');
  expect(errorText('weird')).toBe('weird');
});
