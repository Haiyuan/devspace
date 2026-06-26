# DevSpace Resource Refresh Recovery

Date: 2026-06-26

## 0. Problem

A ChatGPT or MCP host can lose a previously discovered direct DevSpace tool
recipient during a long session. The user-visible symptom is usually similar to:

```text
Resource not found: .../write
Call api_tool.list_resources again to rediscover the currently available tools.
Use only the direct recipients returned there, in <namespace>.<function> format.
```

This may happen for tools such as `read`, `write`, `edit`, or `bash` after they
worked earlier in the same conversation.

There are two different recovery cases. Treating them as one case is the main
operational mistake.

## 1. Case A: Tool Recipient Refreshed, Server Still Running

In this case, only the direct tool recipient is stale. The DevSpace server and
workspace session are still valid.

Expected handling:

```text
1. Re-run api_tool.list_resources(paths=["DevSpace"]).
2. Use the newly returned direct recipients.
3. Retry the same request once.
4. Reuse the same workspaceId.
```

Do not call `open_workspace` again for this case. Reopening needlessly creates a
new workspace session and loses useful continuity.

## 2. Case B: MCP Session Expired or Server Restarted

In this case, the underlying MCP session is gone. This can happen after DevSpace
restarts, the connection is recreated, the host reports an unknown or expired MCP
session, or the `workspaceId` itself is rejected.

Expected handling:

```text
1. Re-run api_tool.list_resources(paths=["DevSpace"]).
2. Call open_workspace for the same project path again.
3. Use the newly returned workspaceId for later calls.
4. Continue from repository state, not from the stale session state.
```

This is the correct path after editing DevSpace server code during `npm run dev`,
because the development server restarts on source changes.

## 3. Current Server Behavior

DevSpace tool descriptions and `open_workspace` instructions now describe both
recovery paths:

```text
Resource not found while DevSpace server is still running:
  rediscover tools and retry once with the same workspaceId

Server restarted, MCP session unknown/expired, connection recreated, or
workspaceId rejected:
  rediscover tools and call open_workspace again
```

For unknown MCP sessions, the server returns structured JSON-RPC error data:

```json
{
  "code": "MCP_SESSION_EXPIRED",
  "recoverable": true,
  "recommended_action": "rediscover_tools_and_reopen_workspace",
  "retry_policy": {
    "rediscoverTools": true,
    "reopenWorkspace": true,
    "reuseWorkspaceId": false
  }
}
```

This is intentionally different from ordinary direct-recipient refresh.

## 4. Idempotency for Write/Edit Retries

`write` and `edit` accept optional `idempotencyKey` values. Use them when a host
or client can safely derive a stable key for a retryable file operation.

Suggested shape:

```text
sha256(workspaceId:path:operation-payload)
```

This helps protect against duplicated writes when a response is lost after the
operation has already completed.

Do not blindly retry shell commands. Retry shell only when the command is
read-only or explicitly idempotent.

## 5. Operator Checklist

When a DevSpace call fails:

```text
1. Read the error text.
2. If it says Resource not found for a tool recipient, rediscover tools.
3. Retry once with the same workspaceId only if the server did not restart.
4. If the MCP session is unknown/expired, or DevSpace restarted, reopen workspace.
5. If a file write/edit may have partially executed, inspect git status and diff before retrying.
6. Keep guardgit pre-run/post-run bracketing for repository edits.
```

## 6. Why This Separation Matters

`workspaceId` lifetime and direct tool endpoint lifetime are not the same thing.

```text
direct tool endpoint lifetime != workspaceId lifetime != MCP session lifetime
```

A stale direct recipient can often recover with rediscovery and the same
workspace. A restarted server or expired MCP session requires a fresh workspace
open.

## 7. Bottom Line

The safe recovery model is:

```text
Tool recipient stale, server still running:
  rediscover tools -> retry once -> same workspaceId

Server restart / unknown MCP session / rejected workspaceId:
  rediscover tools -> open_workspace again -> new workspaceId
```
