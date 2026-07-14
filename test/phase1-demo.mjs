// Phase 1 acceptance demo.
// SESSION 1: connect to the real MCP server and write 3 stickies (2 projects + global).
// Then SESSION 2: invoke the real SessionStart hook for each project and print CLAUDE.md.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ALPHA = join(tmpdir(), 'stk_demo_alpha');
const BETA = join(tmpdir(), 'stk_demo_beta');
mkdirSync(ALPHA, { recursive: true });
mkdirSync(BETA, { recursive: true });

const env = { ...process.env }; // STICKIES_DB already set by caller

function banner(t) {
  console.log('\n' + '='.repeat(64) + '\n' + t + '\n' + '='.repeat(64));
}

// ---- SESSION 1: write via the MCP server ----
banner('SESSION 1 — write 3 stickies via the stickies MCP server');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', 'src/server.js'],
  env,
});
const client = new Client({ name: 'demo', version: '0.0.0' });
await client.connect(transport);

async function write(args) {
  const res = await client.callTool({ name: 'stickies_write', arguments: args });
  console.log('  •', res.content[0].text);
}

await write({
  content: 'Phase 1 storage is local SQLite via better-sqlite3; cloud sync deferred to a later phase.',
  category: 'decision',
  importance: 'P1',
  tags: ['storage', 'arch'],
  project_path: ALPHA,
});
await write({
  content:
    'The integration test suite cannot run until staging credentials are provisioned — this blocks the end-to-end verification step and any work that depends on a green pipeline.',
  category: 'blocker',
  importance: 'P2',
  tags: ['ci'],
  project_path: BETA,
});
await write({
  content: 'User prefers terse, direct answers with no preamble.',
  category: 'preference',
  importance: 'P3',
  project_path: null, // global
});

await client.close();
console.log('\n  Session 1 ended (MCP server connection closed).');

// ---- SESSION 2: run the SessionStart hook exactly as Claude Code would ----
function runHook(cwd) {
  const event = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd });
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/session-start.js'], { input: event, env, encoding: 'utf8' });
  if (r.stderr) process.stderr.write(r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

banner('SESSION 2 — new session in project ALPHA: injected CLAUDE.md digest');
runHook(ALPHA);
console.log(readFileSync(join(ALPHA, 'CLAUDE.md'), 'utf8'));

banner('SESSION 2 — new session in project BETA: injected CLAUDE.md digest');
runHook(BETA);
console.log(readFileSync(join(BETA, 'CLAUDE.md'), 'utf8'));

console.log('\nDemo complete.');
