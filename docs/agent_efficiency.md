# Agent Efficiency Workflow

Use this page when an AI agent is working through DevSpace and needs the fastest
safe path from request to verified diff.

## Fast Safe Loop

1. Open the workspace once for the target checkout or worktree.
2. Read `AGENTS.md` and any nested instruction files returned by
   `open_workspace` before editing under those paths.
3. Run the pre-edit gate:

   ```bash
   guardgit agent pre-run --json
   ```

4. Inspect only the files and symbols needed for the task.
5. Make the smallest focused change.
6. Run the narrowest useful verification first, then broader checks when the
   task requires them.
7. Inspect the diff and run the post-edit gate:

   ```bash
   guardgit agent post-run --json
   ```

Do not tag, publish, deploy, change global config, rewrite history, or run
destructive repository cleanup as part of a normal DevSpace task.

## Tool Choice

Use `read` for direct file inspection. Prefer it over shell commands such as
`cat` or `sed` when the path is known.

Use search tools or read-only shell commands for discovery. `rg`, `find`, `git
status`, `git diff`, and package-script inspection are good shell uses.

Use `edit` for targeted changes to existing files. Keep replacement blocks small
but unique. Combine nearby edits when that reduces churn.

Use `write` for new files or complete rewrites only. Do not use it for small
patches to existing files.

Use `bash` for tests, builds, Git inspection, package scripts, and read-only
repository discovery. Do not use shell redirection, heredocs, in-place editing
commands, or generated scripts to create or modify project files; use `edit` or
`write` instead.

## Recovery Paths

There are two different failures that look similar.

If a direct tool recipient is stale while the DevSpace server is still running:

```text
Resource not found: .../read
Resource not found: .../write
Resource not found: .../edit
Resource not found: .../bash
```

Recover by rediscovering DevSpace tools, retrying the same request once, and
reusing the same `workspaceId`.

If the MCP session expired, the connection was recreated, DevSpace restarted, or
the `workspaceId` is rejected as unknown, rediscover DevSpace tools, call
`open_workspace` again for the same project path, and continue with the new
`workspaceId`.

After any failed `write` or `edit`, inspect `git status` and `git diff` before
retrying. A lost response does not prove the operation failed.

## Dirty Worktrees

If Guardgit blocks on a dirty worktree, stop and report the existing changes.
Do not stack new edits unless the user explicitly approves it.

Safe options are:

1. create a Guardgit stash backup,
2. commit existing work after review,
3. stack the requested change only with explicit approval,
4. discard changes only with explicit destructive-action approval.

Do not use destructive cleanup merely to make the tree clean.

## Verification

For DevSpace itself, use:

```bash
npm run verify
npm run verify:full
git diff --check
guardgit scan --all
guardgit agent post-run --json
```

For documentation-only changes, still run `git diff --check`, the relevant npm
verification requested by the task, secret scanning, and the Guardgit post-run
gate.
