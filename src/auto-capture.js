#!/usr/bin/env node
// Stop hook entry point: deterministic post-turn auto-write.
//
// Claude Code runs this after the assistant finishes a turn, piping a JSON event on
// stdin: { session_id, transcript_path, cwd, stop_hook_active, hook_event_name }.
// We read the assistant text from the just-completed turn, parse `!!sticky ...`
// directives out of it, and persist them (deduped, scoped to cwd).
//
// Non-blocking and best-effort: any failure exits 0 so a sticky problem never wedges
// the session. We never emit a `block` decision, so there is no risk of a stop loop.

import { readFileSync } from 'node:fs';
import { parseDirectives } from './directives.js';
import { autoCapture } from './store.js';
import { notify } from './notify.js';
import { maybeAutoSync } from './git-sync.js';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 1000).unref?.();
  });
}

// A turn boundary is a message the *human* sent. Tool results are also logged with
// type 'user', so keying the boundary off `type === 'user'` alone would treat every tool
// call as the start of a new turn — and silently drop any directive written before the
// turn's last tool use.
function isHumanTurnStart(obj) {
  if (!obj || obj.type !== 'user') return false;
  if (obj.isSidechain) return false; // subagent traffic, not the operator
  const content = obj.message?.content;
  if (Array.isArray(content)) return !content.some((b) => b?.type === 'tool_result');
  return true;
}

// Collect assistant text from the final turn (everything after the last human message).
function lastTurnAssistantText(transcriptPath) {
  const raw = readFileSync(transcriptPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);

  let lastUserIdx = -1;
  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      obj = null;
    }
    parsed.push(obj);
    if (isHumanTurnStart(obj)) lastUserIdx = i;
  }

  const texts = [];
  for (let i = lastUserIdx + 1; i < parsed.length; i++) {
    const obj = parsed[i];
    if (!obj || obj.type !== 'assistant') continue;
    if (obj.isSidechain) continue; // don't capture directives out of subagent replies
    const content = obj.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      }
    } else if (typeof content === 'string') {
      texts.push(content);
    }
  }
  return texts.join('\n');
}

async function main() {
  let event = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) event = JSON.parse(raw);
  } catch {
    return; // no usable event
  }

  const transcriptPath = event.transcript_path;
  const projectPath = event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!transcriptPath) return;

  let text = '';
  try {
    text = lastTurnAssistantText(transcriptPath);
  } catch {
    return; // transcript unreadable
  }

  const directives = parseDirectives(text);
  if (directives.length === 0) return;

  try {
    const { created } = autoCapture(directives, projectPath);
    if (created.length) {
      process.stderr.write(`stickies: auto-captured ${created.length} sticky(ies) this turn\n`);
      // Only sync when we actually captured something new (opt-in, best-effort).
      const synced = maybeAutoSync();
      if (synced && !synced.error) process.stderr.write('stickies: auto-synced new sticky(ies)\n');
      // One batched post for the turn, not one per note.
      await notify(created, 'created');
    }
  } catch (err) {
    process.stderr.write(`stickies auto-capture failed: ${err.message}\n`);
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
