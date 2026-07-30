// The dashboard's port, in one place.
//
// It used to be a bare literal in five modules — the server, the autostarter, both statuslines,
// and the Discord link builder. Changing it meant finding all five, and a missed one silently
// points a link at a port nobody serves.
//
// 4317 was the wrong default: it is the OpenTelemetry OTLP gRPC port. On a machine running a
// collector — ordinary on a developer's box — the dashboard either lost the bind race or, worse,
// the statusline link handed the user to somebody else's server. 7317 is not a registered
// service and does not collide with anything we ship near.
export const DEFAULT_PORT = 7317;

// An out-of-range or non-numeric STICKIES_DASHBOARD_PORT falls back to the default rather than
// producing NaN — `Number('')` is 0 and `Number('abc')` is NaN, and both would have been passed
// to listen() as a request for a random port, which is the one behaviour nothing can find again.
export function dashboardPort() {
  const n = Number(process.env.STICKIES_DASHBOARD_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}
