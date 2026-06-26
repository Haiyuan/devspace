# DevSpace Operations Runbook

This runbook covers stable local operation, recovery after MCP/tool refresh
issues, and the minimum verification commands for DevSpace maintainers.

## 1. Normal Startup

For development:

```bash
npm run dev
```

The development runner watches `src/` and restarts the server after source
changes. A restart invalidates the previous MCP session.

For a built package:

```bash
npm run build
npm start
```

The server prints the local MCP URL, public base URL, allowed roots, allowed
hosts, authentication mode, and logging mode at startup.

## 2. Health Check

DevSpace exposes a lightweight process health endpoint:

```bash
curl http://127.0.0.1:7676/healthz
```

Expected response:

```json
{ "ok": true, "name": "devspace" }
```

`/healthz` means the process is alive. It does not prove OAuth, Cloudflare
Tunnel, MCP session state, or a particular workspace is healthy.

DevSpace also exposes a readiness endpoint:

```bash
curl http://127.0.0.1:7676/readyz
```

`/readyz` checks non-sensitive local readiness only: loaded config, writable
state directory, SQLite store initialization, and UI asset availability. It
returns HTTP 200 when ready and HTTP 503 when one or more checks fail.

## 3. Doctor Command

Use doctor for local runtime and configuration inspection:

```bash
npx @waishnav/devspace doctor
```

Doctor reports configuration paths, Node version and ABI, platform, Git, Bash,
SQLite native dependency status, local/public MCP URLs, `/healthz` and `/readyz`
URLs, state/worktree paths, writable checks, allowed roots, allowed hosts, and
configuration warnings.

If `better-sqlite3` cannot load after changing Node versions, rebuild it under
the active Node runtime:

```bash
npm rebuild better-sqlite3
```

## 4. Tool and Session Recovery

DevSpace has two different recovery paths.

### Tool recipient refresh, server still running

Symptom:

```text
Resource not found: .../read
Resource not found: .../write
Resource not found: .../edit
Resource not found: .../bash
```

Recovery:

```text
1. Rediscover DevSpace tools.
2. Retry the same request once.
3. Reuse the same workspaceId.
```

This covers direct tool recipient refresh when the underlying DevSpace server and
workspace session still exist.

### Server restart or expired MCP session

Symptoms include:

```text
Unknown MCP session
MCP_SESSION_EXPIRED
workspaceId rejected as unknown
connection recreated after DevSpace restarted
```

Recovery:

```text
1. Rediscover DevSpace tools.
2. Call open_workspace again for the same project path.
3. Continue with the new workspaceId.
```

Use this path after editing DevSpace source while `npm run dev` is running,
because the server restarts on source changes.

## 5. Repository Edit Safety

Before repository edits, prefer:

```bash
guardgit agent pre-run --json
```

If it passes, keep edits small and inspectable. After edits, run relevant project
verification and guardgit checks. If guardgit is unavailable or has no configured
verification commands, do not treat that as proof of project correctness; run the
package scripts below.

## 6. Verification Commands

Fast local verification:

```bash
npm run verify
```

Full local verification, including build:

```bash
npm run verify:full
```

Individual commands:

```bash
npm test
npm run typecheck
npm run build
git diff --check
guardgit scan --all
```

`guardgit verify` is useful only when this repository has configured Guardgit
verification commands.

## 7. Cloudflare Tunnel and OAuth Symptoms

If ChatGPT cannot connect or create the connector:

- Confirm the public base URL points to this DevSpace server.
- Confirm Cloudflare Tunnel routes `/mcp`, `/authorize`, `/token`, `/register`,
  and the OAuth well-known metadata paths to DevSpace.
- Confirm the Owner password from `~/.devspace/auth.json` is the one used during
  approval.
- Confirm the host header is allowed by `DEVSPACE_ALLOWED_HOSTS` or the config
  file.
- Run `npx @waishnav/devspace doctor` and compare the public MCP URL against the
  ChatGPT connector configuration.

If DCR or CIMD fails, check that `/register` and the well-known OAuth metadata
paths are not blocked by proxy, geo, firewall, or custom WAF rules.

## 8. Allowed Roots Gotcha

In JSON config, allowed roots must be separate array entries:

```json
{
  "allowedRoots": [
    "/Users/example/work",
    "/Users/example/devspace"
  ]
}
```

Do not put comma-separated paths inside one array entry:

```json
{
  "allowedRoots": [
    "/Users/example/work,/Users/example/devspace"
  ]
}
```

That is one invalid root string, not two roots.

## 9. When to Restart DevSpace

Restart DevSpace after changing server source, configuration, dependencies, or
Node runtime. After restart, clients should rediscover tools and call
`open_workspace` again.

Do not assume an old MCP session or old `workspaceId` is still valid after a
server restart.
