import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { getProject } from '../../src/domain/read.ts';
import type { ServerConfig } from '../../src/server/config.ts';
import { createApp } from '../../src/server/http.ts';
import { renderBrief } from '../../src/understand/render.ts';
import { count, NOW, setup } from '../domain/helpers.ts';
import type { Setup } from '../domain/helpers.ts';

const MCP_TOKEN = 'mcp-token-0123456789abcdef';
const USER_TOKEN = 'user-token-0123456789abcdef';
const COLLECTOR_TOKEN = 'collector-token-laptop-0123456789';
const MCP_URL = new URL('http://herdr-pm.test/mcp');

const config: ServerConfig = {
  port: 1,
  dbPath: ':memory:',
  userToken: USER_TOKEN,
  mcpToken: MCP_TOKEN,
  collectors: { laptop: COLLECTOR_TOKEN },
};

let t: Setup;
let app: ReturnType<typeof createApp>;
let client: Client;

beforeEach(async () => {
  t = setup();
  app = createApp(t.db, config, t.deps.now, t.deps.newId);
  client = new Client({ name: 'herdr-pm-test', version: '0.0.0' });
  // No port: the client's fetch goes straight into the Hono app.
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    fetch: async (url, init) => app.request(url, init),
    requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
  });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close();
  t.db.close();
});

/** A raw MCP `initialize` POST with the given Authorization header (or none). */
async function initialize(authorization?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (authorization !== undefined) headers.Authorization = authorization;
  return app.request(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    }),
  });
}

test('without the mcp token the endpoint answers 401', async () => {
  for (const authorization of [undefined, '', 'Bearer', `Basic ${MCP_TOKEN}`, 'Bearer wrong-token-0123456789ab', `Bearer ${MCP_TOKEN}x`]) {
    const res = await initialize(authorization);
    expect(res.status, JSON.stringify(authorization)).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  }
  for (const method of ['GET', 'DELETE']) {
    const res = await app.request(MCP_URL, { method });
    expect(res.status, method).toBe(401);
  }
  // The right token gets through to MCP.
  const ok = await initialize(`Bearer ${MCP_TOKEN}`);
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('herdr-pm');
});

test('the user token and collector tokens are not accepted on /mcp', async () => {
  for (const token of [USER_TOKEN, COLLECTOR_TOKEN]) {
    const res = await initialize(`Bearer ${token}`);
    expect(res.status).toBe(401);
  }
});

test('the mcp token is not accepted on the write routes or on ingest', async () => {
  const write = await app.request('/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${MCP_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });
  expect(write.status).toBe(401);
  const ingest = await app.request('/ingest/offset?machine=laptop&session_key=claude:x', {
    headers: { Authorization: `Bearer ${MCP_TOKEN}` },
  });
  expect(ingest.status).toBe(401);
});

test('a client lists exactly the read tools and pm_report', async () => {
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  expect(names).toEqual(['pm_get_brief', 'pm_get_project', 'pm_list_projects', 'pm_list_sessions', 'pm_report', 'pm_search', 'pm_timeline']);
});

test('calling pm_get_brief over HTTP returns the brief text', async () => {
  const p = t.user('create_project', { title: '做 herdr-pm', stage: 'build', why: '一个地方看清所有项目' }).id;
  t.user('upsert_todo', { project: p, title: '接上 MCP' });

  const result = await client.callTool({ name: 'pm_get_brief', arguments: { project_id: p } });
  expect(result.isError).toBeFalsy();
  expect(result.content).toEqual([{ type: 'text', text: renderBrief(getProject(t.db, new Date(NOW), p)!) }]);
  expect(JSON.stringify(result.content)).toContain('接上 MCP');

  const missing = await client.callTool({ name: 'pm_get_brief', arguments: { project_id: 'p_nope' } });
  expect(missing.isError).toBe(true);
});

test('pm_report over HTTP stores the report as a chunk and acknowledges it', async () => {
  const before = count(t.db, 'chunks');
  const result = await client.callTool({ name: 'pm_report', arguments: { text: '换了一个评测框架，结果更稳定' } });
  expect(result.isError).toBeFalsy();
  expect(JSON.stringify(result.content)).toContain('已收到');
  expect(count(t.db, 'chunks')).toBe(before + 1);
});

test('invalid tool arguments come back as an MCP error, not a 500', async () => {
  const result = await client.callTool({ name: 'pm_get_brief', arguments: { project_id: 5 } });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toMatch(/project_id/);

  // The same call as a raw request: a JSON-RPC answer with HTTP 200, never a 500.
  const res = await app.request(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MCP_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'pm_get_brief', arguments: { project_id: 5 } } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: number; result?: { isError?: boolean } };
  expect(body.id).toBe(7);
  expect(body.result?.isError).toBe(true);
});

test('GET and DELETE on /mcp answer 405: the endpoint is stateless and has no event stream', async () => {
  for (const method of ['GET', 'DELETE']) {
    const res = await app.request(MCP_URL, { method, headers: { Authorization: `Bearer ${MCP_TOKEN}`, accept: 'text/event-stream' } });
    expect(res.status, method).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  }
});

test('a body over 64 KB is refused with 413 once the token checks out; without a token it is still 401', async () => {
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(64 * 1024) } });
  const send = (authorization?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (authorization !== undefined) headers.Authorization = authorization;
    return app.request(MCP_URL, { method: 'POST', headers, body: big });
  };
  expect((await send(`Bearer ${MCP_TOKEN}`)).status).toBe(413);
  expect((await send()).status).toBe(401);
  // A normal request still goes through.
  expect((await initialize(`Bearer ${MCP_TOKEN}`)).status).toBe(200);
});
