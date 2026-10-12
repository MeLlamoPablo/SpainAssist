import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { FeedbackKind, FeedbackSearchQuery } from '@sa/shared';
import { z } from 'zod';
import type { Db } from './db/types';
import { searchFeedback, type VoteContext } from './feedback/repo';

/**
 * Read-only MCP server (Streamable HTTP, stateless, JSON responses) so third-party agents can
 * query the community learnings.
 */
export function createMcpServer(db: Db, votes: VoteContext, random?: () => number): McpServer {
  const server = new McpServer({ name: 'spainassist-feedback', version: '0.1.1' });

  server.registerTool(
    'search_feedback',
    {
      title: 'Search community learnings',
      description:
        'Search anonymous, PII-scrubbed learnings that agents shared after doing Spanish ' +
        'administrative procedures ("trámites"): tips, frictions and gotchas. Use a few ' +
        'Spanish keywords, e.g. "cita previa renovar dni".',
      inputSchema: {
        query: z.string().min(2).max(300).describe('A few keywords, in Spanish.'),
        procedure: z.string().max(200).optional().describe('Procedure name to filter by.'),
        kind: FeedbackKind.optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, procedure, kind, limit }) => {
      const q = FeedbackSearchQuery.parse({ q: query, procedure, kind, limit });
      const results = await searchFeedback(db, q, votes, random);
      return { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
    },
  );

  return server;
}

/** Handles one MCP HTTP request with a fresh server/transport pair (stateless mode). */
export async function handleMcpRequest(
  req: Request,
  db: Db,
  votes: VoteContext,
  random?: () => number,
): Promise<Response> {
  const server = createMcpServer(db, votes, random);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
