// A `fetch` stub installed with `node --import` in front of src/repo-mode/engine.mjs.
//
// The engine is a standalone script that a test can only SPAWN — there is no module to import and
// no seam to inject, which is exactly why its webhook egress went unexamined while src/notify.js
// (importable, therefore stubbable) was hardened twice. Preloading replaces globalThis.fetch
// before the engine's first line runs, so the real artifact's real call is observed, with no
// packet leaving the machine and no chance of a test posting into somebody's Discord channel.
//
// Configured entirely through env so the spawning test stays a plain execFileSync call:
//   STICKIES_TEST_FETCH_LOG   file to write the observed calls to (JSON array)
//   STICKIES_TEST_FETCH_MODE  'ok'   -> answer 204 immediately
//                             'hang' -> never answer, and hold the event loop open, which is what
//                                       a webhook host that accepts the connection and then says
//                                       nothing does to a Stop hook
import { writeFileSync } from 'node:fs';

const LOG = process.env.STICKIES_TEST_FETCH_LOG;
const MODE = process.env.STICKIES_TEST_FETCH_MODE || 'ok';
const calls = [];

globalThis.fetch = (url, init = {}) => {
  calls.push({
    url: String(url),
    method: init.method || 'GET',
    redirect: init.redirect ?? null,
    hasSignal: Boolean(init.signal),
    body: typeof init.body === 'string' ? init.body.slice(0, 4000) : null,
  });
  if (LOG) writeFileSync(LOG, JSON.stringify(calls, null, 2));

  if (MODE === 'hang') {
    return new Promise((_resolve, reject) => {
      // NOT unref'd: an unresolved promise on its own lets node exit, which would make a missing
      // timeout look like a pass. This is the socket that never answers.
      const keepalive = setTimeout(() => {}, 30000);
      if (init.signal) {
        init.signal.addEventListener('abort', () => {
          clearTimeout(keepalive);
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  }
  return Promise.resolve({ ok: true, status: 204, text: async () => '' });
};
