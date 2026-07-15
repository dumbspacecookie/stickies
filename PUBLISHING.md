# Publishing stickies to npm + the MCP Registry

Everything is prepped: `package.json` has `mcpName`, an MCP-server bin, and a `files`
allowlist; `server.json` is the registry manifest. What's left needs **your** npm and GitHub
accounts, so run these yourself. Do them in order — the registry validates against the
already-published npm package.

Prereqs: Node ≥ 22.5, an [npmjs.com](https://www.npmjs.com) account, and the GitHub account
`dumbspacecookie` (the registry namespace `io.github.dumbspacecookie/*` is gated to it).

## 1. Publish the npm package

The registry only stores metadata — the package itself lives on npm.

```powershell
cd C:\Users\ash\Documents\4_Experiment\stickies-public
npm login                      # once, opens browser
npm publish --access public    # publishes stickies-mcp@0.9.0
```

Verify: <https://www.npmjs.com/package/stickies-mcp>. The published `package.json` must contain
`"mcpName": "io.github.dumbspacecookie/stickies"` — it does; that's what the registry checks.

## 2. Install the registry publisher CLI

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"
tar xf mcp-publisher.tar.gz mcp-publisher.exe
rm mcp-publisher.tar.gz
.\mcp-publisher.exe --help
```

## 3. Authenticate (GitHub device flow)

```powershell
.\mcp-publisher.exe login github
```

Opens a device-code prompt — go to <https://github.com/login/device>, enter the code, authorize.
This grants publish rights to the `io.github.dumbspacecookie/*` namespace.

## 4. Validate, then publish

```powershell
.\mcp-publisher.exe publish --dry-run    # validates server.json + npm match, no write
.\mcp-publisher.exe publish              # the real thing
```

Verify it's live:

```powershell
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.dumbspacecookie/stickies"
```

## Re-publishing a new version

Bump the version in **three** places, then repeat steps 1 + 4:
`package.json` (`version`), `.claude-plugin/plugin.json` (`version`), and `server.json`
(both the top-level `version` and `packages[0].version`). All must match.

## Notes

- `mcpName` in `package.json` and `name` in `server.json` must stay identical
  (`io.github.dumbspacecookie/stickies`).
- The registry is in **preview** — expect occasional breaking changes (see the
  [quickstart](https://modelcontextprotocol.io/registry/quickstart)).
- This publishes the **MCP-server** face of stickies. The Claude Code **plugin** face still
  installs via `claude plugin marketplace add dumbspacecookie/stickies` (now a public repo).
