// Verifies the DEPLOYED cached server.js (what the next live session spawns).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = process.argv[2];
const t = new StdioClientTransport({
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', serverPath],
  env: process.env,
});
const c = new Client({ name: 'cache-verify', version: '0.0.0' });
await c.connect(t);

const tools = await c.listTools();
console.log('cached server tools:', tools.tools.map((x) => x.name).join(', '));

const w = await c.callTool({
  name: 'stickies_write',
  arguments: { content: 'cache copy works on node:sqlite', category: 'context', importance: 'P1', project_path: 'C:/x' },
});
console.log('write ->', w.content[0].text);

const r = await c.callTool({ name: 'stickies_read', arguments: { project_path: 'C:/x' } });
console.log('read count ->', r.structuredContent.count);

await c.close();
console.log('CACHE SERVER OK');
