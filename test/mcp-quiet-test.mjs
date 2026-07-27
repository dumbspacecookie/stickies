// The MCP server's stderr must be clean when it is started the way a stranger starts it.
//
// Every invocation we document passes --disable-warning=ExperimentalWarning, so a test that
// copies our own docs cannot see this: it is the flag, not the code, keeping stderr quiet. The
// published `stickies-mcp` bin has no flag, so `npx stickies-mcp` is the one path that ran
// unguarded — and it printed two ExperimentalWarning lines before saying anything else.
//
// This spawns the bin with NO flag, which is also why it catches the subtle version of the bug:
// a static `import './no-experimental-warning.js'` at the top of the server does NOT suppress it
// (node:sqlite is instantiated while the graph links, before any user module evaluates), and
// that broken fix looks completely correct on inspection.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { scratchDir, cleanup } from './_env.mjs';

const ROOT = scratchDir('mcpquiet');
let fail = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

function runServer(entry) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STICKIES_DB: join(ROOT, 'quiet.db'),
        STICKIES_AUTO_SYNC: '',
        STICKIES_SYNC_REPO: '',
        STICKIES_DISCORD_WEBHOOK: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => { stdout += d; });
    // It is a stdio server: it stays up waiting for a client. Give it long enough to have loaded
    // node:sqlite and announced itself, then take it down and read what it said.
    const timer = setTimeout(() => child.kill(), 2500);
    child.on('close', () => { clearTimeout(timer); resolve({ stderr, stdout }); });
    child.on('error', () => { clearTimeout(timer); resolve({ stderr, stdout }); });
  });
}

const { stderr } = await runServer('src/server.js');

check(!/ExperimentalWarning/.test(stderr), 'src/server.js emits no ExperimentalWarning without the flag');
check(!/sqlite/i.test(stderr) || !/experimental/i.test(stderr), 'no sqlite experimental notice on stderr');
// The server must still actually come up — a fix that suppressed the warning by failing to start
// would pass the assertions above.
check(/running on stdio/.test(stderr), 'server still starts and announces itself');
// Guard the guard: prove the probe can SEE a warning, so a future refactor that quietly stops
// producing stderr can't make this suite vacuously green.
const raw = await runServer('src/server-main.js');
check(/ExperimentalWarning/.test(raw.stderr), 'probe is discriminating (unwrapped server-main.js still warns)');

cleanup(ROOT);
console.log(fail ? `\n${fail} check(s) FAILED` : '\nAll checks passed');
if (fail) process.exit(1);
