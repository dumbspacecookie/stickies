#!/usr/bin/env node
// Statusline renderer: one line summarising the active stickies for a project.
//
// Three consumers, one renderer:
//   1. Claude Code  - configured as settings.json `statusLine.command`; Claude Code pipes
//                     a JSON event on stdin (workspace.current_dir / cwd) and renders the
//                     first line of stdout under the prompt.
//   2. Any shell    - `stickies status` from a PowerShell/bash prompt function.
//   3. Scripts      - `--json` for anything that wants the raw counts.
//
// Contract: never throw, never hang, never print more than one line. A statusline that
// errors would garble the user's terminal on every render, so all failures degrade to
// empty output.

import { readStickies } from './store.js';

const ESC = '[';
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const RESET = `${ESC}0m`;

// Zero stickies renders as empty output, not "0 pending": an always-on counter that
// usually reads zero trains the eye to ignore the line, which defeats the point.
const EMPTY = '';

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    // A hung pipe must not stall the prompt.
    setTimeout(() => resolve(data), 250).unref?.();
  });
}

function truncate(text, max) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function buildStatusline(stickies, { color = true, width = 60, icon = '🟨', verbose = false } = {}) {
  if (!stickies.length) return EMPTY;

  const p1 = stickies.filter((s) => s.importance === 'P1');
  const paint = (c, s) => (color ? `${c}${s}${RESET}` : s);
  const total = stickies.length;

  // Compact by default: counts only — total, plus a `N!` urgency flag when P1s exist
  // (e.g. "🟨 2!·19"). Keeping this segment tiny stops it crowding the other statusline
  // segments (flow board, GSD context) off a narrow prompt. The note text lives one click
  // away in the dashboard; the statusline just needs to say "there are notes, N are hot".
  if (!verbose) {
    if (p1.length) return paint(BOLD + RED, `${icon} ${p1.length}!·${total}`);
    return paint(DIM, `${icon} ${total}`);
  }

  // Verbose (STICKIES_STATUSLINE_VERBOSE=1): also surface the newest P1's text.
  // readStickies orders P1 first, newest first, so p1[0] is that note.
  const head = `${icon} ${total}`;
  if (!p1.length) return paint(DIM, `${head} pending`);
  const rest = total - 1;
  const budget = Math.max(12, width - head.length - (rest > 0 ? 10 : 0));
  const lead = truncate(p1[0].content, budget);
  const parts = [
    paint(BOLD + RED, head),
    paint(YELLOW, lead),
    rest > 0 ? paint(DIM, `+${rest} more`) : '',
  ];
  return parts.filter(Boolean).join(' ');
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const opt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
  };

  // Claude Code pipes session JSON on stdin; a plain shell pipes nothing.
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

  const stickies = readStickies({
    project_path: projectPath,
    include_global: true,
    limit: 100,
  });

  if (flag('--json')) {
    const by = (p) => stickies.filter((s) => s.importance === p).length;
    process.stdout.write(
      JSON.stringify({
        total: stickies.length,
        p1: by('P1'),
        p2: by('P2'),
        p3: by('P3'),
        project_path: projectPath,
        top: stickies[0]?.content ?? null,
      })
    );
    return;
  }

  const line = buildStatusline(stickies, {
    color: !flag('--no-color') && !process.env.NO_COLOR,
    width: Number(opt('--width', 60)) || 60,
    icon: flag('--no-icon') ? '*' : opt('--icon', '🟨'),
    verbose: flag('--verbose') || process.env.STICKIES_STATUSLINE_VERBOSE === '1',
  });

  // Make the whole segment a Ctrl+click hyperlink that opens the dashboard (the full,
  // clickable board — this project + global). Works in Windows Terminal, iTerm2/WezTerm/
  // Kitty/Ghostty. Skipped under tmux (mangles OSC 8) and with --no-link. If OSC 8
  // interferes with mouse select-to-copy in your terminal, pass --no-link. Needs the
  // dashboard running (`stickies dashboard`) for the click to land.
  const linkable = line && !flag('--no-link') && !process.env.TMUX;
  if (linkable) {
    const port = process.env.STICKIES_DASHBOARD_PORT || 4317;
    const url = `http://127.0.0.1:${port}/`;
    process.stdout.write(`\x1b]8;;${url}\x1b\\${line}\x1b]8;;\x1b\\`);
  } else {
    process.stdout.write(line);
  }
}

// Any failure prints nothing and exits clean — a broken statusline must never break the
// prompt it renders into.
main().catch(() => {
  process.stdout.write(EMPTY);
  process.exit(0);
});
