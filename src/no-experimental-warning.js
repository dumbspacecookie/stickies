// Silence Node's "SQLite is an experimental feature" warning for the CLI process.
//
// The whole tool is built on node:sqlite by design, so the warning is pure noise on every
// command — and `stickies status` is meant to be wired into a shell prompt / statusline,
// where those two stderr lines would print on *every* render. The npm scripts pass
// --disable-warning=ExperimentalWarning, but the installed `stickies` bin is `node cli.js`
// with no flag, so we suppress it in-process instead.
//
// Import this FIRST (before anything that loads node:sqlite) so the override is in place
// before the warning would fire. Only the SQLite ExperimentalWarning is dropped — every
// other warning still propagates.
const original = process.emitWarning.bind(process);
process.emitWarning = function (warning, ...rest) {
  const opt = rest[0];
  const type = typeof opt === 'string' ? opt : opt && opt.type;
  const msg = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (type === 'ExperimentalWarning' && /sqlite/i.test(msg)) return;
  return original(warning, ...rest);
};
