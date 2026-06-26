import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./db/client.js";
import {
  getStateStoreDiagnostics,
  pruneStateStore,
  SqliteWorkspaceStore,
} from "./workspace-store.js";

const stateDir = mkdtempSync(join(tmpdir(), "devspace-state-store-test-"));
const legacyStateDir = mkdtempSync(join(tmpdir(), "devspace-state-store-legacy-test-"));
const now = new Date("2026-06-26T12:00:00.000Z");
const oldWorkspaceDate = new Date("2026-05-01T12:00:00.000Z").toISOString();
const recentWorkspaceDate = new Date("2026-06-25T12:00:00.000Z").toISOString();
const oldKeyMs = new Date("2026-06-01T12:00:00.000Z").getTime();
const recentKeyMs = new Date("2026-06-25T12:00:00.000Z").getTime();

const store = new SqliteWorkspaceStore(stateDir);
store.createSession({ id: "old-session", root: "/redacted/old" });
store.createSession({ id: "recent-session", root: "/redacted/recent" });
store.saveIdempotencyResult("old-session", "old-session-recent-key", "{\"ok\":true}");
store.saveIdempotencyResult("recent-session", "recent-session-old-key", "{\"ok\":true}");
store.saveIdempotencyResult("recent-session", "recent-session-recent-key", "{\"ok\":true}");
store.close();

const database = openDatabase(stateDir);
try {
  database.sqlite
    .prepare("update workspace_sessions set last_used_at = ? where id = ?")
    .run(oldWorkspaceDate, "old-session");
  database.sqlite
    .prepare("update workspace_sessions set last_used_at = ? where id = ?")
    .run(recentWorkspaceDate, "recent-session");
  database.sqlite
    .prepare("update tool_idempotency_keys set created_at = ? where idempotency_key = ?")
    .run(recentKeyMs, "old-session-recent-key");
  database.sqlite
    .prepare("update tool_idempotency_keys set created_at = ? where idempotency_key = ?")
    .run(oldKeyMs, "recent-session-old-key");
  database.sqlite
    .prepare("update tool_idempotency_keys set created_at = ? where idempotency_key = ?")
    .run(recentKeyMs, "recent-session-recent-key");
  database.sqlite
    .prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)")
    .run("client-for-prune-test", "{}", now.getTime());
} finally {
  database.close();
}

const diagnostics = getStateStoreDiagnostics(stateDir);
assert.equal(diagnostics.workspaceSessionCount, 2);
assert.equal(diagnostics.toolIdempotencyKeyCount, 3);
assert.match(diagnostics.databasePath, /devspace\.sqlite$/);

mkdirSync(legacyStateDir, { recursive: true });
const legacy = new Database(databasePath(legacyStateDir));
try {
  legacy.exec(`
    create table devspace_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
    insert into devspace_schema_migrations (version, name, applied_at)
      values (1, 'workspace-state', '2026-01-01T00:00:00.000Z');
    create table workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      created_at text not null,
      last_used_at text not null
    );
  `);
} finally {
  legacy.close();
}

const legacyDiagnostics = getStateStoreDiagnostics(legacyStateDir);
assert.equal(legacyDiagnostics.workspaceSessionCount, 0);
assert.equal(legacyDiagnostics.toolIdempotencyKeyCount, 0);

const dryRun = pruneStateStore(stateDir, {
  dryRun: true,
  workspaceDays: 30,
  idempotencyDays: 7,
  now,
});

assert.equal(dryRun.dryRun, true);
assert.equal(dryRun.deletedWorkspaceSessions, 1);
assert.equal(dryRun.deletedToolIdempotencyKeys, 2);
assert.equal(getStateStoreDiagnostics(stateDir).workspaceSessionCount, 2);
assert.equal(getStateStoreDiagnostics(stateDir).toolIdempotencyKeyCount, 3);

const pruned = pruneStateStore(stateDir, {
  workspaceDays: 30,
  idempotencyDays: 7,
  now,
});

assert.equal(pruned.dryRun, false);
assert.equal(pruned.deletedWorkspaceSessions, 1);
assert.equal(pruned.deletedToolIdempotencyKeys, 2);
assert.equal(getStateStoreDiagnostics(stateDir).workspaceSessionCount, 1);
assert.equal(getStateStoreDiagnostics(stateDir).toolIdempotencyKeyCount, 1);

const afterPrune = openDatabase(stateDir);
try {
  const recentSession = afterPrune.sqlite
    .prepare("select count(*) as count from workspace_sessions where id = ?")
    .get("recent-session") as { count: number };
  const recentKey = afterPrune.sqlite
    .prepare("select count(*) as count from tool_idempotency_keys where idempotency_key = ?")
    .get("recent-session-recent-key") as { count: number };
  const oauthClient = afterPrune.sqlite
    .prepare("select count(*) as count from oauth_clients where client_id = ?")
    .get("client-for-prune-test") as { count: number };

  assert.equal(recentSession.count, 1);
  assert.equal(recentKey.count, 1);
  assert.equal(oauthClient.count, 1);
} finally {
  afterPrune.close();
}

assert.throws(() => pruneStateStore(stateDir, { workspaceDays: 0 }), /workspaceDays/);
assert.throws(() => pruneStateStore(stateDir, { idempotencyDays: 0 }), /idempotencyDays/);
