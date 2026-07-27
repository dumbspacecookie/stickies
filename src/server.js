#!/usr/bin/env node
// Thin bin wrapper for the MCP server, the same shape as cli.js — and for the same reason.
//
// node:sqlite emits "SQLite is an experimental feature" when it is instantiated, which happens
// during the module graph's linking phase, BEFORE any user module in that graph evaluates. So
// putting `import './no-experimental-warning.js'` first among server-main.js's static imports
// does not work — measured, the warning still printed. The suppressor has to be evaluated in a
// module whose graph does not contain node:sqlite at all, and the real server pulled in behind a
// dynamic import afterwards.
//
// It matters here because every documented invocation passes --disable-warning explicitly
// (.mcp.json, the README config block, the Dockerfile, npm start) — but the published `stickies-mcp`
// bin does not, so `npx stickies-mcp` opened with two warning lines on stderr. That is the face
// of the package for anyone arriving from the MCP registry, and stderr on a stdio transport is a
// stream a client is reading.
import './no-experimental-warning.js';
await import('./server-main.js');
