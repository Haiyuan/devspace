# DevSpace Resource Refresh Issue: Practical Fix Plan

Date: 2026-06-26

## 0. Problem

Observed symptom in ChatGPT / DevSpace tool use:

```text
Resource not found: .../write
Call api_tool.list_resources again to rediscover the currently available tools.
Use only the direct recipients returned there, in <namespace>.<function> format.
```

This usually appears after a tool endpoint such as `DevSpace.write` or `DevSpace.bash` was available earlier, then becomes unavailable during a long session.

## 1. Likely Root Cause

The issue is likely a tool-resource lifecycle problem:

- The ChatGPT connector/tool bridge exposes DevSpace functions through resource-backed direct recipients.
- Those resource links can be refreshed, invalidated, or rebound during the session.
- The `workspaceId` may still be valid, but the tool endpoint resource URI is stale.
- The next direct call to `DevSpace.write`, `DevSpace.bash`, etc. fails until the assistant rediscovers the tool schema.

## 2. Immediate Workaround

When this happens:

```text
1. Re-run api_tool.list_resources(paths=["DevSpace"]).
2. Use the newly returned direct recipients.
3. Reuse the existing workspaceId if it still works.
4. Retry the failed operation.
```

Do not reopen the workspace unless the existing `workspaceId` is rejected.

## 3. Recommended Client-Side Fix

For ChatGPT-side or orchestration-side handling, implement automatic retry:

```text
on ToolResourceNotFound:
  if tool namespace was previously discovered:
    call api_tool.list_resources(paths=["DevSpace"])
    retry the same operation once with the refreshed direct recipient
  else:
    surface the error
```

Rules:

- Retry at most once automatically.
- Never retry non-idempotent operations blindly unless the operation is safe to repeat.
- For file writes, retry only if the first write clearly did not execute.
- For shell commands, retry only if the command is read-only or explicitly idempotent.
- Preserve `workspaceId`.
- Preserve the exact intended file path and content.

## 4. Recommended DevSpace Server-Side Fix

For the DevSpace project, the robust fix is to make tool discovery and invocation more resilient:

### 4.1 Stable Tool Identity

Tool functions should have stable logical names:

```text
DevSpace.open_workspace
DevSpace.read
DevSpace.write
DevSpace.edit
DevSpace.bash
```

Even if internal resource URIs rotate, the client should be able to rediscover and bind to the same logical tool name.

### 4.2 Explicit Error Code

Return a structured error code such as:

```json
{
  "code": "TOOL_RESOURCE_STALE",
  "recoverable": true,
  "recommended_action": "rediscover_tools"
}
```

This is better than a generic `Resource not found`.

### 4.3 Idempotency Keys for Writes

For write/edit operations, support an optional idempotency key:

```json
{
  "idempotencyKey": "sha256(workspaceId:path:content)"
}
```

This allows a client to safely retry a write after a stale resource error without duplicating work.

### 4.4 Keep Workspace State Separate From Tool Resource State

The workspace should remain stable even when tool resources refresh:

```text
workspaceId lifetime != direct tool endpoint lifetime
```

If the workspace is still valid, rediscovery should be enough.

### 4.5 Add a `tools/version` or `session/status` Endpoint

Add a lightweight status endpoint that returns:

```json
{
  "serverVersion": "...",
  "toolSchemaVersion": "...",
  "workspaceId": "...",
  "workspaceValid": true,
  "toolsValid": true
}
```

This helps diagnose whether the stale part is the workspace, the tool schema, or the connection.

## 5. Operational Recommendation

For current use:

- Treat this as a recoverable connector/session issue.
- Do not treat it as a failed repository edit unless the command actually executed.
- After rediscovery, continue with the same `workspaceId`.
- For long document writes, prefer generating downloadable files if repeated write endpoint refresh makes repository writes unreliable.
- For repository changes, keep guardgit pre-run/post-run bracketing.

## 6. Suggested Issue / Patch Text for DevSpace

```text
fix: make tool resource refresh recoverable

DevSpace tool endpoints can become stale during long ChatGPT sessions, producing
`Resource not found` for previously discovered direct recipients such as write or
bash. The workspace may still be valid, but the tool resource binding is no
longer usable.

Proposed changes:
- Return a structured TOOL_RESOURCE_STALE error with recoverable=true.
- Keep workspace state independent from tool resource endpoint lifetime.
- Support rediscovery without requiring open_workspace again.
- Add optional idempotency keys for write/edit calls.
- Add a lightweight session/tool status endpoint for diagnostics.
- Document client behavior: rediscover tools and retry idempotent operations once.
```

## 7. Bottom Line

Yes, there is a practical solution. The immediate workaround is rediscovery and retry. The proper product fix is stable logical tool identity, structured stale-resource errors, idempotent write retries, and a clear separation between workspace lifetime and tool endpoint lifetime.
