#!/usr/bin/env node
// Thin bin wrapper. It exists only to install the node:sqlite warning suppressor BEFORE any
// module that loads node:sqlite is linked — then it hands off to the real CLI via a dynamic
// import, so that load happens after the suppressor is in place. (A static `import
// './cli-main.js'` would link node:sqlite during THIS module's linking, before the suppressor
// runs, and the "SQLite is an experimental feature" warning would leak to stderr on every
// `stickies status` call — a papercut for anyone wiring it into a shell prompt.)
import './no-experimental-warning.js';
await import('./cli-main.js');
