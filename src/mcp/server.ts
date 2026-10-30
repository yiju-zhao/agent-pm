import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';
import type { DomainDeps } from '../domain/types.ts';
import { requireToken } from '../server/bearer.ts';
import type { ServerConfig } from '../server/config.ts';
import { readTools } from './read-tools.ts';

/** The version the MCP server reports in `initialize`: the package's own. */
const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * Mounts the external MCP endpoint at `/mcp` (Streamable HTTP, stateless, JSON responses). Only the read tools and
 * `pm_report` are on it; the write tools exist only inside the curator. Every request needs
 * `Authorization: Bearer <mcpToken>` (the user and collector tokens are refused), checked before any MCP handling.
 *
 * Stateless means each POST gets a fresh server and transport, closed once the response is built. There is no
 * session and nothing for the server to push, so GET (the event stream) and DELETE (session end) answer 405, which
 * clients take as "no stream here".
 */
export function mountMcp(app: Hono, db: DatabaseSync, config: ServerConfig, deps: DomainDeps): void {
  app.all('/mcp', requireToken(config.mcpToken, 'missing or invalid mcp token'), async (c) => {
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST');
      return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, 405);
    }
    const server = new McpServer({ name: 'herdr-pm', version: VERSION });
    for (const tool of readTools(db, deps)) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args) => {
        const out = await tool.handler(args);
        return { content: [{ type: 'text', text: out.text }], isError: out.isError };
      });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
}
