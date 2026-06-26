# DevSpace Release Readiness

Date: 2026-06-27
Repository: `<local-devspace-repository>`
Branch observed: `master`

## Evidence Observed

[KNOWN] Current working tree before this document had one tracked change and five untracked session archive docs:

| Path | Status | Classification | Release action |
| --- | --- | --- | --- |
| `package-lock.json` | modified | generated/build artifact | Do not include in release unless a human accepts lockfile normalization. |
| `docs/DevSpace/00_index.md` | untracked | needs human decision | Session archive; keep outside release unless intentionally publishing process notes. |
| `docs/DevSpace/01_stability_timeline.md` | untracked | needs human decision | Session archive; keep outside release unless intentionally publishing process notes. |
| `docs/DevSpace/02_all_prompts.md` | untracked | needs human decision | Session archive/prompt log; keep outside release by default. |
| `docs/DevSpace/03_commit_messages.md` | untracked | needs human decision | Session archive; keep outside release by default. |
| `docs/DevSpace/04_efficiency_next_steps.md` | untracked | documentation-only / needs human decision | Future planning doc; not release-required. |
| `docs/release_readiness.md` | new | documentation-only | Optional docs-only readiness commit. |

[KNOWN] `package-lock.json` only changes the nested `@earendil-works/pi-ai` bin path:

```diff
- "pi-ai": "./dist/cli.js"
+ "pi-ai": "dist/cli.js"
```

[INFERRED] This is harmless npm lockfile normalization because no dependency version or integrity field changed. It is not release-required.

## Smoke Test Status

[KNOWN] User-provided external smoke evidence says:

- Public `/mcp` connector creation or refresh succeeded.
- OAuth approval completed.
- MCP host opened this repository with `open_workspace`.
- Instruction loading succeeded via `AGENTS.md`; `CLAUDE.md` is absent and not required.
- `npm run verify` passed.
- `/healthz` returned ok.
- `/readyz` passed `configLoaded`, `stateDirWritable`, `sqlite`, and `uiAssets`.
- `devspace doctor` reported normal runtime status externally.
- Restart/session-expiry recovery was confirmed externally.

[KNOWN] Local verification run during this triage:

| Command | Result |
| --- | --- |
| `npm run verify:full` | Passed when rerun outside the sandbox. Initial sandbox run failed with `tsx` IPC `EPERM`. |
| `git diff --check` | Passed. |
| `guardgit scan --all` | Passed: no secrets found. |
| `npx @waishnav/devspace doctor` | Failed locally: `devspace: command not found`. |
| `npm exec -- devspace doctor` | Failed locally with Node heap OOM in npm/npx wrapper. |
| `node dist/cli.js doctor` | Passed after migration v3; state-store diagnostics reported DB path, workspace sessions, and tool idempotency keys. |
| `GET http://127.0.0.1:7676/healthz` | 200, `{"ok":true,"name":"devspace"}`. |
| `GET http://127.0.0.1:7676/readyz` | 200, all readiness checks true. |

## Remaining Risks

[KNOWN] The earlier `doctor` failure was reproduced as a legacy state DB migration gap:

```text
State store status: unavailable (no such table: tool_idempotency_keys)
```

[KNOWN] This is fixed by migration v3, `workspace-state-compatibility`, which reruns idempotent workspace-state DDL for databases that recorded v1 before these tables existed.

[KNOWN] Current `node dist/cli.js doctor` output now includes:

```text
State DB path: <local-state-dir>/devspace.sqlite
Workspace sessions: 34
Tool idempotency keys: 0
```

[KNOWN] The exact requested `npx @waishnav/devspace doctor` command was not usable in this local checkout. The built CLI fallback was usable.

[KNOWN] Vite emitted chunk-size warnings during `npm run verify:full`. The build still passed.

## Release Blockers

1. [KNOWN] Current checkout is not clean: `package-lock.json` is modified and `docs/DevSpace/*` are untracked.
2. [RESOLVED] Built `doctor` no longer reports state-store diagnostics unavailable on the current local state DB.
3. [KNOWN] The exact `npx @waishnav/devspace doctor` command did not run successfully in this checkout; use built CLI or package bin resolution for final release checks.

## Recommended Final Action

Do not tag, publish, or deploy from this working tree yet.

Recommended path:

1. Exclude or intentionally commit the `docs/DevSpace/*` session archive docs.
2. Exclude `package-lock.json` from the release unless a human accepts the one-line lockfile normalization.
3. Include migration v3 in the release.
4. Optionally commit this readiness document with the migration fix.

Suggested docs-only commit message:

```text
docs: add release readiness triage
```
