// Unit tests for the shared relativeTime() helper embedded into both the dashboard and the
// flow board. Pure/offline — computes inputs as offsets from Date.now() so it never flakes.

import { relativeTime } from '../src/flow/relative-time.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS ', msg); } else { fail++; console.log('  FAIL ', msg); } };

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

// --- empty / unparseable inputs => '' (caller skips rendering) ---
ok(relativeTime(null) === '', 'null => ""');
ok(relativeTime(undefined) === '', 'undefined => ""');
ok(relativeTime('') === '', 'empty string => ""');
ok(relativeTime('not a date') === '', 'unparseable string => ""');
ok(relativeTime(NaN) === '', 'NaN => ""');

// --- ISO string inputs across the buckets ---
ok(relativeTime(iso(0)) === 'just now', 'now => "just now"');
ok(relativeTime(iso(30 * 1000)) === 'just now', '30s ago => "just now"');
ok(relativeTime(iso(5 * 60 * 1000)) === '5m ago', '5 min ago => "5m ago"');
ok(relativeTime(iso(59 * 60 * 1000)) === '59m ago', '59 min ago => "59m ago"');
ok(relativeTime(iso(3 * 3600 * 1000)) === '3h ago', '3 hours ago => "3h ago"');
ok(relativeTime(iso(23 * 3600 * 1000)) === '23h ago', '23 hours ago => "23h ago"');
ok(relativeTime(iso(3 * 86400 * 1000)) === '3d ago', '3 days ago => "3d ago"');
ok(relativeTime(iso(29 * 86400 * 1000)) === '29d ago', '29 days ago => "29d ago"');

// --- >= 30 days falls back to a locale date (not a relative phrase) ---
const old = relativeTime(iso(45 * 86400 * 1000));
ok(old !== '' && !/ago$/.test(old), '45 days ago => absolute date, not an "… ago" phrase');

// --- epoch-millisecond inputs behave the same as ISO strings ---
ok(relativeTime(now - 5 * 60 * 1000) === '5m ago', 'accepts epoch ms (5m ago)');
ok(relativeTime(now) === 'just now', 'accepts epoch ms (now)');

// --- future timestamps (clock skew) never go negative — they read "just now" ---
ok(relativeTime(now + 10 * 60 * 1000) === 'just now', 'future timestamp => "just now"');

console.log(fail ? `\nRELATIVE-TIME ${fail} FAILURES` : '\nRELATIVE-TIME OK');
process.exit(fail ? 1 : 0);
