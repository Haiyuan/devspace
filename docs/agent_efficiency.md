# Agent Efficiency Workflow

Use this page when an AI agent is working through DevSpace and needs the
shortest safe path from request to verified diff.

## Fast Safe Loop

1. Call `open_workspace` once for the target repository checkout or managed
   worktree.
2. Reuse the returned `workspaceId` for later `read`, `edit`, `write`, and
   `bash` calls in that same workspace.
3. Read `AGENTS.md` and any nested instruction files returned by DevSpace before
   editing under those paths.
4. Inspect the relevant files before editing. Do not edit from memory.
5. Run the pre-edit gate:

   ```bash
   guardgit agent pre-run --json
   ```

6. Make the smallest focused change that satisfies the task.
7. Run the narrowest useful verification first, then broader checks required by
   the task.
8. Inspect the diff and run the post-edit gate:

   ```bash
   guardgit agent post-run --json
   ```

Do not tag, publish, deploy, change global config, rewrite history, or run
destructive repository cleanup as part of a normal DevSpace task.

## Tool Choice

Use `read` for direct file inspection when the path is known. Prefer it over
shell commands such as `cat` or `sed`.

Use `bash` for tests, builds, Git inspection, package scripts, search, and
read-only repository discovery. Good examples include `npm test`, `npm run
verify`, `git status`, `git diff`, `rg`, and `find`.

Do not use `bash` to create, edit, or overwrite files. Avoid shell redirection,
heredocs, `tee`, `sed -i`, `perl -i`, generated scripts, or one-off
`node`/`python` scripts that write project files. Use DevSpace file tools
instead. If a file mutation tool is denied by the host approval UI, stop and
report the denial; do not bypass it with `bash`.

Use `create` for new files. It must fail when the target path already exists
with different content.

Use `edit` for targeted changes to existing files. Keep each replacement block
small but unique. Combine nearby replacements when that reduces churn.

Use `write` only for explicit full overwrites. Do not use it for small patches
to existing files.

## Guardgit Gates

Before any edit or write, run:

```bash
guardgit agent pre-run --json
```

Proceed only when the result is pass/ready, or when a warning is understood,
low-risk, and consistent with the user's request. Stop on blocked states.

After edits and verification, run:

```bash
guardgit agent post-run --json
```

Treat Guardgit as a safety gate and evidence recorder. It does not replace
reading files, inspecting diffs, running project tests, or applying judgment.

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

`npm run verify` runs the test suite and TypeScript typecheck. `npm run
verify:full` adds the production build.

For documentation-only changes, still run the verification requested by the task,
`git diff --check`, `guardgit scan --all`, and the Guardgit post-run gate.
