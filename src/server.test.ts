import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { createReadinessReport, createServer } from "./server.js";

const configDir = mkdtempSync(join(tmpdir(), "devspace-readyz-config-test-"));
const stateDir = mkdtempSync(join(tmpdir(), "devspace-readyz-state-test-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_WIDGETS: "off",
});

const ready = await createReadinessReport(config, {
  stateDirWritable: () => true,
  sqlite: () => true,
  uiAssets: () => true,
});

assert.equal(ready.ok, true);
assert.equal(ready.name, "devspace");
assert.deepEqual(ready.checks, {
  configLoaded: true,
  stateDirWritable: true,
  sqlite: true,
  uiAssets: true,
});

const notReady = await createReadinessReport(config, {
  stateDirWritable: () => true,
  sqlite: () => false,
  uiAssets: () => true,
});

assert.equal(notReady.ok, false);
assert.equal(notReady.checks.sqlite, false);

const thrownCheck = await createReadinessReport(config, {
  stateDirWritable: () => true,
  sqlite: () => {
    throw new Error("sqlite unavailable");
  },
  uiAssets: () => true,
});

assert.equal(thrownCheck.ok, false);
assert.equal(thrownCheck.checks.sqlite, false);

const mcpConfigDir = mkdtempSync(join(tmpdir(), "devspace-mcp-session-config-test-"));
const mcpStateDir = mkdtempSync(join(tmpdir(), "devspace-mcp-session-state-test-"));
const mcpToken = "test-access-token-for-expired-session";
const mcpConfig = loadConfig({
  DEVSPACE_CONFIG_DIR: mcpConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_STATE_DIR: mcpStateDir,
  DEVSPACE_WIDGETS: "off",
  DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
  DEVSPACE_LOG_LEVEL: "silent",
  DEVSPACE_LOG_REQUESTS: "0",
});
const mcpResource = resourceUrlFromServerUrl(new URL("/mcp", mcpConfig.publicBaseUrl));
const database = openDatabase(mcpStateDir);
try {
  database.sqlite
    .prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)")
    .run("session-test-client", "{}", Date.now());
  database.sqlite
    .prepare(
      "insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource) values (?, ?, ?, ?, ?)",
    )
    .run(
      hashToken(mcpToken),
      "session-test-client",
      JSON.stringify(["devspace"]),
      Math.floor(Date.now() / 1000) + 60,
      mcpResource.href,
    );
} finally {
  database.close();
}

const runningServer = createServer(mcpConfig);
const httpServer = createHttpServer(runningServer.app);
try {
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = httpServer.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  const port = (address as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${mcpToken}`,
      "content-type": "application/json",
      "mcp-session-id": "unknown-session-id",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  const payload = await response.json() as {
    error?: {
      data?: {
        code?: string;
        recommended_action?: string;
        retry_policy?: {
          reopenWorkspace?: boolean;
          reuseWorkspaceId?: boolean;
        };
      };
    };
  };

  assert.equal(response.status, 400);
  assert.equal(payload.error?.data?.code, "MCP_SESSION_EXPIRED");
  assert.equal(payload.error?.data?.recommended_action, "rediscover_tools_and_reopen_workspace");
  assert.equal(payload.error?.data?.retry_policy?.reopenWorkspace, true);
  assert.equal(payload.error?.data?.retry_policy?.reuseWorkspaceId, false);
} finally {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve());
  });
  runningServer.close();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
