# Task Prompt Templates

These prompts are for DevSpace sessions where an AI agent works in a local
checkout. Replace bracketed values before use. Keep every task small and
reviewable.

Common constraints for every prompt:

```text
Do not tag, publish, deploy, modify global config, rewrite history, or run
destructive cleanup. Run guardgit agent pre-run --json before edits and
guardgit agent post-run --json after edits. Keep changes small and focused.
Report exact verification commands and results.
```

## Inspect Repo and Propose Next Work Package

```text
@DevSpace Working in [absolute project path], inspect the repository and
propose the next small work package.

Goals:
1. Read AGENTS.md and relevant docs/manifests.
2. Inspect current git status and recent project structure.
3. Identify the highest-leverage small next task.
4. Return a concrete work package with goals, files likely touched, verification,
   and expected commit message.

Constraints:
- Do not edit files.
- Do not tag, publish, deploy, or modify global config.
- Prefer evidence from the live repo over memory.
```

## Implement a Small Code Change

```text
@DevSpace Working in [absolute project path], implement [small behavior
change].

Goals:
1. Read AGENTS.md and inspect the relevant implementation/tests.
2. Run guardgit agent pre-run --json before edits.
3. Make the smallest focused code change.
4. Add or update narrow tests when behavior changes.
5. Run npm run verify. Run npm run verify:full if build/runtime output may be
   affected.
6. Run git diff --check, guardgit scan --all, and guardgit agent post-run --json.

Constraints:
- Do not tag, publish, deploy, modify global config, or change unrelated files.
- Do not add dependencies unless strictly necessary and justified first.
- Preserve existing behavior outside the requested change.

Expected commit:
[type(scope): concise subject]
```

## Update Docs to Match Implementation

```text
@DevSpace Working in [absolute project path], update documentation to match
the current implementation for [topic].

Goals:
1. Read AGENTS.md and the relevant source files before editing docs.
2. Run guardgit agent pre-run --json before edits.
3. Update only docs that are stale or incomplete.
4. Keep wording operational and precise; do not add marketing prose.
5. Run npm run verify if docs reference runtime commands or behavior. Run
   npm run verify:full when requested or when generated output/build behavior is
   relevant.
6. Run git diff --check, guardgit scan --all, and guardgit agent post-run --json.

Constraints:
- Do not change core behavior unless the documentation task explicitly requires
  it.
- Do not tag, publish, deploy, or modify global config.
- Keep changes small and focused.

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
- Do not tag, publish, deploy, or modify global config.
- Do not invent tests, motivations, issue numbers, or behavior not shown in the
  diff.
```

## Add Regression Tests for a Bug

```text
@DevSpace Working in [absolute project path], add regression coverage for
[bug or failure mode].

Goals:
1. Read AGENTS.md and inspect the existing tests around [area].
2. Reproduce or encode the failing case with the narrowest test possible.
3. Run guardgit agent pre-run --json before edits.
4. Add the regression test first when practical.
5. Implement the smallest fix only if requested or necessary for the test to
   pass.
6. Run the targeted test command, npm run verify, git diff --check,
   guardgit scan --all, and guardgit agent post-run --json.
7. Run npm run verify:full if the fix affects build output or server behavior.

Constraints:
- Do not broaden the test suite structure unnecessarily.
- Do not remove or weaken existing tests.
- Do not tag, publish, deploy, or modify global config.

Expected commit:
test: [concise regression subject]
```

## Run Verification and Summarize Risks

```text
@DevSpace Working in [absolute project path], run verification and summarize
remaining risks.

Goals:
1. Inspect git status and current diff.
2. Run npm run verify.
3. Run npm run verify:full when the current diff affects build output, packaging,
   server behavior, or when requested.
4. Run git diff --check, guardgit scan --all, and guardgit agent post-run --json.
5. Summarize pass/fail results, exact failing command excerpts, likely cause,
   and whether failures appear pre-existing or caused by the diff.

Constraints:
- Do not edit files unless explicitly asked to fix failures.
- Do not tag, publish, deploy, or modify global config.
- Do not claim verified unless the command actually passed.
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
5. Run npm run verify and npm run verify:full after code changes.
6. Run git diff --check, guardgit scan --all, and guardgit agent post-run --json.

Constraints:
- Do not print secrets, tokens, cookies, or owner passwords.
- Do not modify global config, DNS, Cloudflare settings, or deployment state
  unless explicitly requested.
- Do not tag, publish, or deploy.

Expected commit if files change:
fix(oauth): [concise subject]
```

## Improve DevSpace Itself Safely

```text
@DevSpace Working in [absolute project path], improve DevSpace itself by
[small improvement].

Goals:
1. Read AGENTS.md and inspect the current implementation before editing.
2. Identify the riskiest assumption and cheapest verification step.
3. Run guardgit agent pre-run --json before edits.
4. Keep the patch narrow; avoid broad refactors.
5. Add or update tests for behavior changes.
6. Run npm run verify, npm run verify:full, git diff --check,
   guardgit scan --all, and guardgit agent post-run --json.

Constraints:
- Do not change core server behavior outside the stated goal.
- Do not add dependencies unless explicitly justified and approved.
- Do not tag, publish, deploy, modify global config, or change unrelated files.

Expected commit:
[type(scope): concise subject]
```
