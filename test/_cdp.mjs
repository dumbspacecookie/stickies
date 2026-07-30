// A minimal Chrome DevTools Protocol client, so the board can be tested in a REAL browser.
//
// Zero dependencies, like the rest of this project: Node ships a global WebSocket, and CDP is
// just JSON over one socket. This exists because the DOM stub in board-client-test.mjs proves
// the JavaScript is correct and says nothing at all about layout — and two of the bugs that
// reached a user (a project label that clipped the wrong end, a header that pushed its own nav
// links off-screen) were pure CSS, invisible to any amount of logic testing.
//
// Skips itself when no Chromium is installed rather than failing: a contributor without Chrome
// should still get a green suite.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { freePort, scratchDir, cleanup } from './_env.mjs';

const CANDIDATES = process.platform === 'win32'
  ? [
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ]
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];

export function findBrowser() {
  // isAbsolute, not just truthy. `${process.env.ProgramFiles}` interpolates the literal string
  // "undefined" when the variable is unset (stripped env, a service account, some containers),
  // producing the RELATIVE path "undefined/Google/Chrome/Application/chrome.exe" — candidate #1,
  // so a file planted at that path inside a cloned repo would be spawned by `npm test` before
  // the real Chrome was ever considered.
  return CANDIDATES.find((p) => p && !p.includes('undefined') && isAbsolute(p) && existsSync(p)) || null;
}

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

// Launch headless Chrome and attach to a page target. Returns a small driver.
export async function launchBrowser() {
  const bin = findBrowser();
  if (!bin) return null;
  const port = await freePort();
  const profile = scratchDir('chrome');
  const proc = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-extensions', '--disable-background-networking',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });

  // From here on, EVERY failure path must take the browser down with it. Without this, a throw
  // between spawn and close (a rejected WebSocket handshake, a CDP timeout) left a live browser
  // with an open debugging port and a profile dir behind — and anything local could attach to it
  // and run arbitrary JS for as long as it lived.
  const abandon = () => {
    try { proc.kill(); } catch { /* already gone */ }
    cleanup(profile); // retries: Chrome does not release the profile the instant it is signalled
  };
  proc.on('error', abandon); // spawn failure arrives async; unhandled it would be fatal
  try {
    return await attach();
  } catch (err) {
    abandon();
    return null; // treated by the caller as "no browser", i.e. a skip rather than a red suite
  }

  async function attach() {
  // Wait for the debugging endpoint. Chrome writes it a beat after the process starts.
  let ws = null;
  for (let i = 0; i < 100 && !ws; i++) {
    try { ws = (await getJson(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!ws) { abandon(); return null; }

  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    sock.addEventListener('open', resolve, { once: true });
    sock.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  sock.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    sock.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error(`CDP timeout: ${method}`)); } }, 20000);
  });

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    async goto(url) {
      await send('Page.navigate', { url });
      // Poll for readiness rather than trusting the loadEventFired ordering.
      for (let i = 0; i < 100; i++) {
        const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (r.result.value === 'complete') return;
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error('page never reached readyState=complete');
    },
    // Evaluate in the page and return a plain value. Awaits promises so tests can drive async UI.
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result.value;
    },
    async setViewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    },
    async close() {
      try { sock.close(); } catch { /* already gone */ }
      // Wait for the process to be GONE rather than for 300ms and hope: Chrome holds the profile
      // until it has exited, and a single delete on a fixed delay left one profile tree in %TEMP%
      // per run whenever it took longer.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
        try { proc.kill(); } catch { clearTimeout(timer); resolve(); }
      });
      cleanup(profile);
    },
  };
  } // end attach()
}
