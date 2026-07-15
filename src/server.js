#!/usr/bin/env node
// Stickies MCP server (phase 1): exposes stickies_write / stickies_read / stickies_dismiss
// over stdio. All business logic lives in store.js; this file is just the MCP transport.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createSticky, readStickies, dismissSticky } from './store.js';
import { notify } from './notify.js';
import { CATEGORIES, IMPORTANCES } from './db.js';

// Read the version from package.json so it can never drift from the published version.
const { version: PKG_VERSION } = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
);

const server = new McpServer(
  { name: 'stickies', version: PKG_VERSION },
  {
    instructions: [
      'Stickies is a persistent sticky-note layer that survives session resets.',
      '',
      'AUTO-WRITE: During a session, proactively capture a durable fact whenever one',
      'emerges that future sessions should know. Categories and their triggers:',
      '  - decision : an architectural/design choice was made ("we chose X over Y")',
      '  - blocker  : something is blocking progress (failing CI, missing creds)',
      '  - preference: a stable user preference ("prefers concise answers")',
      '  - context  : background a future session would otherwise have to rediscover',
      '  - todo     : a concrete follow-up that must not be forgotten',
      '',
      'TWO WAYS TO CAPTURE (pick one per fact):',
      '  1. Lightweight inline directive — write a line in your reply of the form:',
      '       !!sticky <category> [P1|P2|P3] [#tag ...] :: <content>',
      '     e.g.  !!sticky decision P1 #storage :: storage is node:sqlite, no native deps',
      '     A post-turn hook persists these automatically (scoped to the project),',
      '     deduped. importance defaults to P2; tags optional. This is the low-friction',
      '     default — no tool round-trip needed.',
      '  2. Explicit tool — call stickies_write when you need the id back immediately or',
      '     are writing a global note (project_path: null).',
      '',
      'Keep content under 500 chars. Do not duplicate stickies that already exist;',
      'prefer one crisp note. Secrets are auto-redacted, but do not capture them anyway.',
    ].join('\n'),
  }
);

server.registerTool(
  'stickies_write',
  {
    title: 'Write a sticky',
    description:
      'Create a persistent sticky note. Call this when a durable fact emerges ' +
      '(a decision, blocker, preference, context, or todo) that future sessions should retain.',
    inputSchema: {
      content: z.string().min(1).max(500).describe('Freeform note text, max 500 chars.'),
      category: z
        .enum(CATEGORIES)
        .describe('decision | blocker | preference | context | todo (sets the TTL).'),
      importance: z
        .enum(IMPORTANCES)
        .default('P2')
        .describe('P1 critical, P2 normal, P3 minor.'),
      tags: z.array(z.string().max(40)).max(20).default([]).describe('Optional string tags (max 20, each ≤40 chars).'),
      project_path: z
        .string()
        .nullish()
        .describe('Absolute project root this note belongs to. Omit/null for a global note.'),
    },
  },
  async ({ content, category, importance, tags, project_path }) => {
    const sticky = createSticky({
      content,
      category,
      importance,
      tags,
      project_path: project_path ?? null,
      source: 'auto',
    });
    await notify(sticky, 'created');
    const note = sticky.redacted
      ? ' (a suspected secret was redacted from the content before saving)'
      : '';
    return {
      content: [
        {
          type: 'text',
          text: `Wrote sticky ${sticky.id} [${sticky.importance} ${sticky.category}] expires ${sticky.expires_at}${note}`,
        },
      ],
      structuredContent: sticky,
    };
  }
);

server.registerTool(
  'stickies_read',
  {
    title: 'Read stickies',
    description:
      'Retrieve active stickies relevant to the current session, ordered by importance.',
    inputSchema: {
      project_path: z
        .string()
        .nullish()
        .describe('Absolute project root to scope to. Omit to read across all projects.'),
      limit: z.number().int().positive().max(500).default(50).describe('Max stickies to return.'),
      include_global: z
        .boolean()
        .default(true)
        .describe('Also include global (no project) stickies.'),
      min_importance: z
        .enum(IMPORTANCES)
        .default('P3')
        .describe('Lowest importance to include (P1 = only critical).'),
    },
  },
  async ({ project_path, limit, include_global, min_importance }) => {
    const stickies = readStickies({
      project_path: project_path ?? null,
      limit,
      include_global,
      min_importance,
    });
    const summary =
      stickies.length === 0
        ? 'No active stickies match.'
        : stickies
            .map((s) => `- [${s.importance} ${s.category}] ${s.content} (${s.id})`)
            .join('\n');
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: { count: stickies.length, stickies },
    };
  }
);

server.registerTool(
  'stickies_dismiss',
  {
    title: 'Dismiss a sticky',
    description: 'Soft-delete a sticky by id (marks it dismissed; it is no longer read back).',
    inputSchema: {
      id: z.string().describe('The sticky id to dismiss.'),
      reason: z.string().nullish().describe('Optional reason for dismissal.'),
    },
  },
  async ({ id, reason }) => {
    const result = dismissSticky(id, reason ?? null);
    if (!result.ok) {
      return {
        content: [{ type: 'text', text: `Could not dismiss: ${result.error}` }],
        isError: true,
        structuredContent: result,
      };
    }
    await notify(result.sticky, 'dismissed');
    return {
      content: [{ type: 'text', text: `Dismissed sticky ${id}.` }],
      structuredContent: result,
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is reserved for the MCP protocol.
  process.stderr.write('stickies MCP server running on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`stickies MCP server failed: ${err?.stack || err}\n`);
  process.exit(1);
});
