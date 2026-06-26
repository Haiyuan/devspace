# Task Prompt Templates

These prompts are for DevSpace sessions where an AI agent works in a local
checkout. Replace bracketed placeholders before use. Keep each task small,
reviewable, and easy to verify.

Common constraints for every prompt:

```text
Do not tag, publish, deploy, modify global config, rewrite history, add
dependencies, or run destructive cleanup. Run guardgit agent pre-run --json
before edits and guardgit agent post-run --json after edits. Keep changes small
and focused. Report exact verification commands and results.
```

## Inspect Repo and Propose Next Work Package

```text
@DevSpace Working in [absolute project path], inspect the repository and propose
the next small work package.

Goals:
1. Read AGENTS.md and relevant docs/manifests.
2. Inspect current git status and recent project structure.
3. Identify the highest-leverage small next task.
4. Return a concrete work package with goals, likely files touched, constraints,
   verification, risks, and expected commit message.

Constraints:
- Do not edit files.
- Do not tag, publish, deploy, modify global config, rewrite history, add
  dependencies, or run destructive cleanup.
- Prefer live repository evidence over memory.

Verification commands:
- git rev-parse --is-inside-work-tree
- git branch --show-current
- git status --porcelain=v1 -b --untracked-files=all
- [read-only search commands needed for the inspected area]

Expected commit:
[no commit; inspection-only task]
```

## Implement a Small Code Change

```text
@DevSpace Working in [absolute project path], implement [small behavior change].

Goals:
1. Read AGENTS.md and inspect the relevant implementation and tests.
2. Run guardgit agent pre-run --json before edits.
3. Make the smallest focused code change.
4. Add or update narrow tests when behavior changes.
5. Inspect the final diff and summarize risks.

Constraints:
- Do not tag, publish, deploy, modify global config, rewrite history, add
  dependencies, or run destructive cleanup.
- Do not change unrelated files.
- Preserve existing behavior outside the requested change.

Verification commands:
- [targeted test command, if available]
- npm run verify
- npm run verify:full [when build/runtime output may be affected]
- git diff --check
- guardgit scan --all
- guardgit agent post-run --json

Expected commit:
[type(scope): concise subject]
```

## Add Regression Test for a Bug

```text
@DevSpace Working in [absolute project path], add regression coverage for [bug or
failure mode].

Goals:
1. Read AGENTS.md and inspect existing tests around [area].
2. Reproduce or encode the failing case with the narrowest test possible.
3. Run guardgit agent pre-run --json before edits.
4. Add the regression test first when practical.
5. Implement the smallest fix only if requested or necessary for the regression
   test to pass.
6. Inspect the final diff and summarize the before/after behavior.

Constraints:
- Do not broaden the test structure unnecessarily.
- Do not remove or weaken existing tests.
- Do not tag, publish, deploy, modify global config, rewrite history, add
  dependencies, or run destructive cleanup.

Verification commands:
- [targeted regression test command]
- npm run verify
- npm run verify:full [when server behavior, build output, or packaging may be affected]
- git diff --check
- guardgit scan --all
- guardgit agent post-run --json

Expected commit:
test: [concise regression subject]
```

## Update Docs to Match Implementation

```text
@DevSpace Working in [absolute project path], update documentation to match the
current implementation for [topic].

Goals:
1. Read AGENTS.md and inspect the relevant source files before editing docs.
2. Run guardgit agent pre-run --json before edits.
3. Update only docs that are stale or incomplete.
4. Keep wording operational and precise; do not add marketing prose.
5. Inspect the final diff and call out any implementation behavior that remains
   undocumented or uncertain.

Constraints:
- Documentation-first change.
- Do not change runtime behavior unless explicitly requested.
- Do not tag, publish, deploy, modify global config, rewrite history, add
  dependencies, or run destructive cleanup.
- Keep changes small and focused.

Verification commands:
- npm run verify [if docs reference runtime commands or behavior]
- npm run verify:full [when requested or when generated output/build behavior is relevant]
- git diff --check
- guardgit scan --all
- guardgit agent post-run --json

Expected commit:
docs: [concise subject]
```

## Write an English Git Commit Message from Current Diff

```text
@DevSpace Working in [absolute project path], write an English git commit
message from the current diff.

Goals:
1. Inspect git status, staged diff, and unstaged diff.
2. Summarize only changes visible in the diff.
3. Produce a Conventional Commit subject and concise body.
4. Mention verification only if the diff or provided logs prove it ran.

Constraints:
- Do not edit files.
- Do not tag, publish, deploy, modify global config, rewrite history, add
  dependencies, or run destructive cleanup.
- Do not invent tests, motivations, issue numbers, or behavior not shown in the
  diff.

Verification commands:
- git status --porcelain=v1 -b --untracked-files=all
- git diff --staged
- git diff

Expected commit:
[type(scope): concise subject]

[optional body based only on the diff]
```

## Run Verification and Summarize Risks

```text
@DevSpace Working in [absolute project path], run verification and summarize
remaining risks.

Goals:
1. Inspect git status and current diff.
2. Run the requested verification commands.
3. Summarize pass/fail results with exact command names.
4. For failures, include a short relevant error excerpt, likely cause, and whether
   the failure appears pre-existing or caused by the diff.
5. Do not claim verified unless the command actually passed.

Constraints:
- Do not edit files unless explicitly asked to fix failures.
- Do not tag, publish, deploy, modify global config, rewrite history, add
  dependencies, or run destructive cleanup.
- Redact secrets if command output exposes any.

Verification commands:
- npm run verify
- npm run verify:full [when the current diff affects build output, packaging,
  server behavior, or when requested]
- git diff --check
- guardgit scan --all
- guardgit agent post-run --json

Expected commit:
[no commit; verification-only task]
```

## Diagnose ChatGPT Connector/OAuth/DCR Issues

```text
@DevSpace Working in [absolute project path], diagnose the ChatGPT
connector/OAuth/DCR issue: [symptom].

Goals:
1. Read AGENTS.md, docs/operations.md, docs/setup.md, docs/configuration.md, and
   relevant OAuth/server code.
2. Inspect config examples and routes for /mcp, /authorize, /token, /register,
   and OAuth well-known metadata.
3. Distinguish Cloudflare/proxy/WAF failures from DevSpace server failures.
4. If editing is needed, run guardgit agent pre-run --json first and keep the
   patch focused.
5. Inspect the final diff and summarize the operational risk.

Constraints:
- Do not print secrets, tokens, cookies, owner passwords, or authorization
  headers.
- Do not modify global config, DNS, Cloudflare settings, or deployment state
  unless explicitly requested.
- Do not tag, publish, deploy, rewrite history, add dependencies, or run
  destructive cleanup.

Verification commands:
- [targeted local command or curl check, if safe and applicable]
- npm run verify [after code or route changes]
- npm run verify:full [after server behavior changes]
- git diff --check
- guardgit scan --all
- guardgit agent post-run --json

Expected commit:
fix(oauth): [concise subject]
```

## Improve DevSpace Itself Safely

```text
@DevSpace Working in [absolute project path], improve DevSpace itself by [small
improvement].

Goals:
1. Read AGENTS.md and inspect the current implementation before editing.
2. Identify the riskiest assumption and cheapest verification step.
3. Run guardgit agent pre-run --json before edits.
4. Keep the patch narrow; avoid broad refactors.
5. Add or update tests for behavior changes.
6. Inspect the final diff and summarize remaining risks.

Constraints:
- Do not change core server behavior outside the stated goal.
- Do not add dependencies unless explicitly justified and approved.
- Do not tag, publish, deploy, modify global config, rewrite history, or run
  destructive cleanup.
- Do not change unrelated files.

Verification commands:
- [targeted test command, if available]
- npm run verify
- npm run verify:full
- git diff --check
- guardgit scan --all
- guardgit agent post-run --json

Expected commit:
[type(scope): concise subject]
```
