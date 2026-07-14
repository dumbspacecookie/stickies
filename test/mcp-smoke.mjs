// Spins up the real MCP server as a subprocess and exercises the tools over stdio.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Private temp DB unless caller pinned one, so the smoke test never hits ~/.stickies.
const dbPath = process.env.STICKIES_DB || join(tmpdir(), 'stickies_mcp_npmtest.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { rmSync(dbPath + suffix); } catch {}
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', 'src/server.js'],
  env: { ...process.env, STICKIES_DB: dbPath },
});

const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

const w = await client.callTool({
  name: 'stickies_write',
  arguments: {
    content: 'MCP smoke: chose stdio transport',
    category: 'decision',
    importance: 'P1',
    tags: ['mcp'],
    project_path: 'C:/proj/alpha',
  },
});
console.log('write ->', w.content[0].text);
const newId = w.structuredContent.id;

const r = await client.callTool({
  name: 'stickies_read',
  arguments: { project_path: 'C:/proj/alpha', include_global: true },
});
console.log('read count ->', r.structuredContent.count);

const d = await client.callTool({
  name: 'stickies_dismiss',
  arguments: { id: newId, reason: 'smoke cleanup' },
});
console.log('dismiss ->', d.content[0].text);

await client.close();
console.log('MCP smoke OK');
