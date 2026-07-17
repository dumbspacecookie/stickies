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

import { pathToFileURL } from 'node:url';
import { readStickies } from './store.js';
import { dueStatus } from './due.js';

const ESC = '[';
const BOLD = `${ESC}1m`;
const RESET = `${ESC}0m`;
const rgb = (r, g, b) => `${ESC}38;2;${r};${g};${b}m`;

// Two palettes. DARK relies on the terminal's own bright colours (as before). LIGHT uses
// truecolour, because we can't set the terminal's background — a plain ANSI yellow is
// invisible on a pale one, so the light palette hard-codes darker, higher-contrast values
// that read on white regardless of the terminal's theme.
const PALETTES = {
  dark: { dim: `${ESC}2m`, red: `${ESC}31m`, yellow: `${ESC}33m` },
  // Truecolour values chosen to clear WCAG AA text contrast (>=4.5:1) on a light terminal
  // background (~#f5f6f8): dim 4.56, red 5.98, gold 4.55. These render as TEXT (the count,
  // the ⏰ pip, the verbose note), so the text bar applies, not the 3:1 UI bar.
  light: { dim: rgb(106, 113, 122), red: rgb(178, 42, 34), yellow: rgb(149, 104, 16) },
};

// Shared so the flow-board segment paints with the same two palettes (its amber "doing"
// marker is the same 33m that vanishes on a light terminal).
export function statuslinePalette(theme) {
  return PALETTES[theme] || PALETTES.dark;
}

// Which palette to paint with. Explicit arg (CLI --theme) wins, then $STICKIES_THEME, then
// a best-effort read of $COLORFGBG (terminals that set it encode the bg colour last; 7 or
// 15 == a light background). Defaults to dark — the common dev terminal, and the safe
// choice since a dark palette on a dark bg never disappears.
export function resolveStatuslineTheme(explicit) {
  const pick = (v) => (v === 'light' || v === 'dark' ? v : null);
  if (pick(explicit)) return explicit;
  const env = pick((process.env.STICKIES_THEME || '').toLowerCase());
  if (env) return env;
  const fgbg = process.env.COLORFGBG;
  if (fgbg) {
    const bg = Number(fgbg.split(';').pop());
    if (Number.isFinite(bg)) return bg === 7 || bg === 15 ? 'light' : 'dark';
  }
  return 'dark';
}

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

export function buildStatusline(stickies, { color = true, width = 60, icon = '🟨', verbose = false, theme = 'dark' } = {}) {
  if (!stickies.length) return EMPTY;

  const pal = PALETTES[theme] || PALETTES.dark;
  const p1 = stickies.filter((s) => s.importance === 'P1');
  const paint = (c, s) => (color ? `${c}${s}${RESET}` : s);
  const total = stickies.length;

  // Deadlines: how many notes are overdue vs. coming due within the soon-window. Rendered
  // as a clock pip appended to the count (e.g. "🟨 2!·19 ⏰3" or, when overdue, "⏰1!").
  // Overdue outranks soon — a passed deadline is the thing you need to see.
  let overdue = 0, soon = 0;
  for (const s of stickies) {
    const d = dueStatus(s.due_at);
    if (d === 'overdue') overdue++;
    else if (d === 'soon') soon++;
  }
  const duePip = (() => {
    if (overdue) return ' ' + paint(BOLD + pal.red, `⏰${overdue}!`);
    if (soon) return ' ' + paint(pal.yellow, `⏰${soon}`);
    return '';
  })();

  // Compact by default: counts only — total, plus a `N!` urgency flag when P1s exist
  // (e.g. "🟨 2!·19"). Keeping this segment tiny stops it crowding the other statusline
  // segments (flow board, GSD context) off a narrow prompt. The note text lives one click
  // away in the dashboard; the statusline just needs to say "there are notes, N are hot".
  if (!verbose) {
    if (p1.length) return paint(BOLD + pal.red, `${icon} ${p1.length}!·${total}`) + duePip;
    return paint(pal.dim, `${icon} ${total}`) + duePip;
  }

  // Verbose (STICKIES_STATUSLINE_VERBOSE=1): also surface the newest P1's text.
  // readStickies orders P1 first, newest first, so p1[0] is that note.
  const head = `${icon} ${total}`;
  if (!p1.length) return paint(pal.dim, `${head} pending`);
  const rest = total - 1;
  const budget = Math.max(12, width - head.length - (rest > 0 ? 10 : 0));
  const lead = truncate(p1[0].content, budget);
  const parts = [
    paint(BOLD + pal.red, head),
    paint(pal.yellow, lead),
    rest > 0 ? paint(pal.dim, `+${rest} more`) : '',
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

  // Palette: --theme light|dark or --light beats $STICKIES_THEME beats $COLORFGBG autodetect.
  const themeArg = flag('--light') ? 'light' : opt('--theme', null);
  const line = buildStatusline(stickies, {
    color: !flag('--no-color') && !process.env.NO_COLOR,
    width: Number(opt('--width', 60)) || 60,
    icon: flag('--no-icon') ? '*' : opt('--icon', '🟨'),
    verbose: flag('--verbose') || process.env.STICKIES_STATUSLINE_VERBOSE === '1',
    theme: resolveStatuslineTheme(themeArg),
  });

  // Make the whole segment a Ctrl+click hyperlink that opens the dashboard (the full,
  // clickable board — this project + global). Works in Windows Terminal, iTerm2/WezTerm/
  // Kitty/Ghostty. Skipped under tmux (mangles OSC 8) and with --no-link. If OSC 8
  // interferes with mouse select-to-copy in your terminal, pass --no-link. Needs the
  // dashboard running (`stickies dashboard`) for the click to land.
  const linkable = line && !flag('--no-link') && !process.env.TMUX;
  if (linkable) {
    const port = process.env.STICKIES_DASHBOARD_PORT || 4317;
    // Link to the dashboard root. (An earlier build appended a #note-<id> fragment to deep-
    // link the hottest note, but that broke Ctrl+click in Windows Terminal — the fragment is
    // dropped here. The dashboard still honours #note-<id> from Discord links and wikilinks.)
    const url = `http://127.0.0.1:${port}/`;
    process.stdout.write(`\x1b]8;;${url}\x1b\\${line}\x1b]8;;\x1b\\`);
  } else {
    process.stdout.write(line);
  }
}

// Run main() ONLY when this file is the process entrypoint — not when it is imported for
// its exports (statuslinePalette / resolveStatuslineTheme are pulled in by the flow
// statusline). An unguarded main() on import made the flow segment drag a second stickies
// render into its own stdout (double-count + a stdin double-read race).
//
// Any failure prints nothing and exits clean — a broken statusline must never break the
// prompt it renders into.
const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch(() => {
    process.stdout.write(EMPTY);
    process.exit(0);
  });
}
