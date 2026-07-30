#!/usr/bin/env node
// Statusline renderer: a compact flow-board summary for the active project, e.g.
//   🟦 ▶2 ☐10 ✓4   (doing / to-do / done)
//
// Same contract as the stickies statusline: never throw, never hang, never print more
// than one line, degrade to empty output on any failure. Renders nothing when the
// project has no board (no .planning/ROADMAP.md), so the segment only appears when it
// has something to say. Made Ctrl+clickable (OSC 8) to open the board in the dashboard.

import { buildBoard } from './board.mjs';
import { resolveStatuslineTheme, statuslinePalette } from '../statusline.js';
import { normalizeProjectPath } from '../store-path.js';
import { authorizedUrl } from '../dashboard-auth.js';
import { dashboardPort } from '../dashboard-port.js';

const ESC = '\x1b[';
const BOLD = `${ESC}1m`;
const RESET = `${ESC}0m`;
const EMPTY = '';

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    setTimeout(() => resolve(data), 250).unref?.();
  });
}

export function buildFlowStatusline(board, { color = true, theme = 'dark' } = {}) {
  if (!board || !board.ok) return EMPTY;
  const { todo, doing, done } = board.counts;
  if (todo + doing + done === 0) return EMPTY;
  const pal = statuslinePalette(theme);
  const paint = (c, s) => (color ? `${c}${s}${RESET}` : s);

  // Doing is the live signal — bold amber when work is in flight. To-do/done stay dim.
  // On a light terminal the palette swaps amber/dim for truecolour that stays legible.
  const parts = ['📋'];
  if (doing > 0) parts.push(paint(BOLD + pal.yellow, `▶${doing}`));
  parts.push(paint(pal.dim, `☐${todo}`));
  parts.push(paint(pal.dim, `✓${done}`));
  return parts.join(' ');
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const opt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
  };

  let event = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) event = JSON.parse(raw);
  } catch {
    // malformed stdin -> fall through to cwd
  }

  const projectPath =
    opt('--project', null) ||
    event.workspace?.current_dir ||
    event.cwd ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();

  let board;
  try {
    board = buildBoard(projectPath);
  } catch {
    return process.stdout.write(EMPTY);
  }

  if (flag('--json')) {
    process.stdout.write(JSON.stringify({ ok: board.ok, counts: board.counts, source: board.source ?? null }));
    return;
  }

  const themeArg = flag('--light') ? 'light' : opt('--theme', null);
  const line = buildFlowStatusline(board, {
    color: !flag('--no-color') && !process.env.NO_COLOR,
    theme: resolveStatuslineTheme(themeArg),
  });

  // Whole segment becomes a Ctrl+click hyperlink to the board (same as stickies).
  // Skipped under tmux (mangles OSC 8) and with --no-link (pass --no-link if OSC 8
  // interferes with select-to-copy in your terminal).
  //
  // ?project= is what makes the click honest. The counts above are computed from THIS
  // terminal's cwd, but one dashboard serves the whole machine — so a bare /board link
  // opened whichever project happened to launch the server, showing another folder's plans
  // under this folder's numbers. Naming the project makes the page match the segment.
  const linkable = line && !flag('--no-link') && !process.env.TMUX;
  if (linkable) {
    const port = dashboardPort();
    // Normalized so the link is byte-identical to the path the dashboard stores and echoes
    // back (forward slashes, upper-case drive letter) — the server would normalize a raw
    // Windows path anyway, but a stable URL keeps browser history and bookmarks from forking.
    // Carries the read key, same as the stickies segment — see src/dashboard-auth.js.
    const url = authorizedUrl(port, `/board?project=${encodeURIComponent(normalizeProjectPath(projectPath) || '')}`);
    process.stdout.write(`\x1b]8;;${url}\x1b\\${line}\x1b]8;;\x1b\\`);
  } else {
    process.stdout.write(line);
  }
}

main().catch(() => {
  process.stdout.write(EMPTY);
  process.exit(0);
});
