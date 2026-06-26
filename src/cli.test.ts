import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { openDatabase } from "./db/client.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
assert.match(
  serverSource,
  /rediscover DevSpace tools and retry the same request once with the same workspaceId/,
);
assert.match(serverSource, /MCP_SESSION_EXPIRED/);
assert.match(serverSource, /rediscover_tools_and_reopen_workspace/);
assert.match(serverSource, /reuseWorkspaceId: false/);

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const doctorConfigDir = mkdtempSync(join(tmpdir(), "devspace-cli-doctor-test-"));
const doctorStateDir = join(doctorConfigDir, "state");
const doctorWorktreeRoot = join(doctorConfigDir, "worktrees");
writeFileSync(
  join(doctorConfigDir, "config.json"),
  JSON.stringify({
    allowedRoots: [`${process.cwd()},${process.cwd()}`],
    publicBaseUrl: "https://devspace.example.com",
  }),
);
writeFileSync(
  join(doctorConfigDir, "auth.json"),
  JSON.stringify({ ownerToken: "persisted-owner-token-long-enough" }),
);

const doctorOutput = execFileSync("node", ["--import", "tsx", "src/cli.ts", "doctor"], {
  encoding: "utf8",
  env: {
    ...process.env,
    DEVSPACE_CONFIG_DIR: doctorConfigDir,
    DEVSPACE_STATE_DIR: doctorStateDir,
    DEVSPACE_WORKTREE_ROOT: doctorWorktreeRoot,
    DEVSPACE_ALLOWED_HOSTS: "localhost",
  },
});

assert.match(doctorOutput, /Local health URL: http:\/\/127\.0\.0\.1:7676\/healthz/);
assert.match(doctorOutput, /Local readiness URL: http:\/\/127\.0\.0\.1:7676\/readyz/);
assert.match(doctorOutput, new RegExp(`State dir: ${doctorStateDir.replaceAll("\\", "\\\\")}`));
assert.match(doctorOutput, /State dir writable: ok/);
assert.match(doctorOutput, new RegExp(`Worktree root: ${doctorWorktreeRoot.replaceAll("\\", "\\\\")}`));
assert.match(doctorOutput, /Worktree root writable: ok/);
assert.match(doctorOutput, /Warning: publicBaseUrl host devspace\.example\.com is not covered by allowedHosts/);
assert.match(doctorOutput, /Warning: allowedRoots config entry contains a comma/);

const wildcardDoctorOutput = execFileSync("node", ["--import", "tsx", "src/cli.ts", "doctor"], {
  encoding: "utf8",
  env: {
    ...process.env,
    DEVSPACE_CONFIG_DIR: doctorConfigDir,
    DEVSPACE_STATE_DIR: doctorStateDir,
    DEVSPACE_WORKTREE_ROOT: doctorWorktreeRoot,
    DEVSPACE_ALLOWED_HOSTS: "*",
  },
});

assert.match(wildcardDoctorOutput, /Warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=\*/);
assert.match(doctorOutput, /State DB path: .*devspace\.sqlite/);
assert.match(doctorOutput, /Workspace sessions: 0/);
assert.match(doctorOutput, /Tool idempotency keys: 0/);
assert.doesNotMatch(doctorOutput, /old-session-secret/);
assert.doesNotMatch(doctorOutput, /old-key-secret/);

const maintenanceConfigDir = mkdtempSync(join(tmpdir(), "devspace-cli-maintenance-test-"));
const maintenanceStateDir = join(maintenanceConfigDir, "state");
writeFileSync(
  join(maintenanceConfigDir, "config.json"),
  JSON.stringify({ allowedRoots: [process.cwd()] }),
);
writeFileSync(
  join(maintenanceConfigDir, "auth.json"),
  JSON.stringify({ ownerToken: "persisted-owner-token-long-enough" }),
);

const maintenanceDb = openDatabase(maintenanceStateDir);
try {
  maintenanceDb.sqlite
    .prepare(
      [
        "insert into workspace_sessions",
        "(id, root, status, mode, managed, created_at, last_used_at)",
        "values (?, ?, 'active', 'checkout', 'false', ?, ?)",
      ].join(" "),
    )
    .run(
      "old-session-secret",
      "/redacted/old",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  maintenanceDb.sqlite
    .prepare(
      [
        "insert into workspace_sessions",
        "(id, root, status, mode, managed, created_at, last_used_at)",
        "values (?, ?, 'active', 'checkout', 'false', ?, ?)",
      ].join(" "),
    )
    .run(
      "recent-session-secret",
      "/redacted/recent",
      "2026-06-25T00:00:00.000Z",
      new Date().toISOString(),
    );
  maintenanceDb.sqlite
    .prepare("insert into tool_idempotency_keys (workspace_session_id, idempotency_key, result_json, created_at) values (?, ?, ?, ?)")
    .run("old-session-secret", "old-key-secret", "{}", Date.now());
  maintenanceDb.sqlite
    .prepare("insert into tool_idempotency_keys (workspace_session_id, idempotency_key, result_json, created_at) values (?, ?, ?, ?)")
    .run("recent-session-secret", "recent-key-secret", "{}", Date.now());
} finally {
  maintenanceDb.close();
}

const dryRunOutput = execFileSync(
  "node",
  ["--import", "tsx", "src/cli.ts", "maintenance", "prune", "--dry-run", "--workspace-days", "30", "--idempotency-days", "7"],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: maintenanceConfigDir,
      DEVSPACE_STATE_DIR: maintenanceStateDir,
    },
  },
);

assert.match(dryRunOutput, /Would prune DevSpace state store/);
assert.match(dryRunOutput, /Workspace sessions would delete: 1/);
assert.match(dryRunOutput, /Tool idempotency keys would delete: 1/);
assert.match(dryRunOutput, /OAuth clients, grants, and tokens are not pruned/);
assert.doesNotMatch(dryRunOutput, /old-session-secret/);
assert.doesNotMatch(dryRunOutput, /old-key-secret/);

const afterDryRun = openDatabase(maintenanceStateDir);
try {
  const sessions = afterDryRun.sqlite.prepare("select count(*) as count from workspace_sessions").get() as { count: number };
  const keys = afterDryRun.sqlite.prepare("select count(*) as count from tool_idempotency_keys").get() as { count: number };
  assert.equal(sessions.count, 2);
  assert.equal(keys.count, 2);
} finally {
  afterDryRun.close();
}

const pruneOutput = execFileSync(
  "node",
  ["--import", "tsx", "src/cli.ts", "maintenance", "prune", "--workspace-days", "30", "--idempotency-days", "7"],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: maintenanceConfigDir,
      DEVSPACE_STATE_DIR: maintenanceStateDir,
    },
  },
);

assert.match(pruneOutput, /Pruned DevSpace state store/);
assert.match(pruneOutput, /Workspace sessions deleted: 1/);
assert.match(pruneOutput, /Tool idempotency keys deleted: 1/);
assert.doesNotMatch(pruneOutput, /old-session-secret/);
assert.doesNotMatch(pruneOutput, /old-key-secret/);

const afterPrune = openDatabase(maintenanceStateDir);
try {
  const sessions = afterPrune.sqlite.prepare("select count(*) as count from workspace_sessions").get() as { count: number };
  const keys = afterPrune.sqlite.prepare("select count(*) as count from tool_idempotency_keys").get() as { count: number };
  assert.equal(sessions.count, 1);
  assert.equal(keys.count, 1);
} finally {
  afterPrune.close();
}
