import { eq, and } from "drizzle-orm";
import { databasePath, openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceSessions,
  toolIdempotencyKeys,
  type WorkspaceSessionRow,
} from "./db/schema.js";

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSession {
  id: string;
  root: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface StateStoreDiagnostics {
  databasePath: string;
  workspaceSessionCount: number;
  toolIdempotencyKeyCount: number;
}

export interface StateStorePruneOptions {
  workspaceDays?: number;
  idempotencyDays?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface StateStorePruneResult {
  dryRun: boolean;
  workspaceDays: number;
  idempotencyDays: number;
  workspaceCutoffIso: string;
  idempotencyCutoffMs: number;
  deletedWorkspaceSessions: number;
  deletedToolIdempotencyKeys: number;
}

export interface WorkspaceStore {
  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession;
  getSession(id: string): WorkspaceSession | undefined;
  touchSession(id: string): void;
  getIdempotencyResult(workspaceId: string, key: string): string | undefined;
  saveIdempotencyResult(workspaceId: string, key: string, resultJson: string): void;
  close?(): void;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  createSession(input: {
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        root: session.root,
        status: session.status,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        managed: String(session.managed),
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  getSession(id: string): WorkspaceSession | undefined {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(eq(workspaceSessions.id, id))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  touchSession(id: string): void {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(workspaceSessions.id, id))
      .run();
  }

  getIdempotencyResult(workspaceId: string, key: string): string | undefined {
    const row = this.database.db
      .select({ resultJson: toolIdempotencyKeys.resultJson })
      .from(toolIdempotencyKeys)
      .where(
        and(
          eq(toolIdempotencyKeys.workspaceSessionId, workspaceId),
          eq(toolIdempotencyKeys.idempotencyKey, key)
        )
      )
      .get();
    return row?.resultJson;
  }

  saveIdempotencyResult(workspaceId: string, key: string, resultJson: string): void {
    this.database.db
      .insert(toolIdempotencyKeys)
      .values({
        workspaceSessionId: workspaceId,
        idempotencyKey: key,
        resultJson: resultJson,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [toolIdempotencyKeys.workspaceSessionId, toolIdempotencyKeys.idempotencyKey],
        set: { resultJson },
      })
      .run();
  }

  close(): void {
    this.database.close();
  }

}

export function createWorkspaceStore(stateDir: string): WorkspaceStore {
  return new SqliteWorkspaceStore(stateDir);
}

export function getStateStoreDiagnostics(stateDir: string): StateStoreDiagnostics {
  const database = openDatabase(stateDir);
  try {
    return {
      databasePath: databasePath(stateDir),
      workspaceSessionCount: countRows(database, "workspace_sessions"),
      toolIdempotencyKeyCount: countRows(database, "tool_idempotency_keys"),
    };
  } finally {
    database.close();
  }
}

export function pruneStateStore(
  stateDir: string,
  options: StateStorePruneOptions = {},
): StateStorePruneResult {
  const workspaceDays = options.workspaceDays ?? 30;
  const idempotencyDays = options.idempotencyDays ?? 7;
  validatePositiveDays(workspaceDays, "workspaceDays");
  validatePositiveDays(idempotencyDays, "idempotencyDays");

  const nowMs = options.now?.getTime() ?? Date.now();
  const workspaceCutoffIso = new Date(nowMs - workspaceDays * 24 * 60 * 60 * 1000).toISOString();
  const idempotencyCutoffMs = nowMs - idempotencyDays * 24 * 60 * 60 * 1000;
  const dryRun = Boolean(options.dryRun);
  const database = openDatabase(stateDir);

  try {
    const deletedWorkspaceSessions = countStaleWorkspaceSessions(database, workspaceCutoffIso);
    const deletedToolIdempotencyKeys = countPrunedIdempotencyKeys(
      database,
      idempotencyCutoffMs,
      workspaceCutoffIso,
    );

    if (!dryRun) {
      database.sqlite
        .prepare("delete from tool_idempotency_keys where created_at < ?")
        .run(idempotencyCutoffMs);
      database.sqlite
        .prepare("delete from workspace_sessions where last_used_at < ?")
        .run(workspaceCutoffIso);
    }

    return {
      dryRun,
      workspaceDays,
      idempotencyDays,
      workspaceCutoffIso,
      idempotencyCutoffMs,
      deletedWorkspaceSessions,
      deletedToolIdempotencyKeys,
    };
  } finally {
    database.close();
  }
}

function countRows(database: DatabaseHandle, table: "workspace_sessions" | "tool_idempotency_keys"): number {
  const row = database.sqlite.prepare(`select count(*) as count from ${table}`).get() as { count: number };
  return row.count;
}

function countStaleWorkspaceSessions(database: DatabaseHandle, workspaceCutoffIso: string): number {
  const row = database.sqlite
    .prepare("select count(*) as count from workspace_sessions where last_used_at < ?")
    .get(workspaceCutoffIso) as { count: number };
  return row.count;
}

function countPrunedIdempotencyKeys(
  database: DatabaseHandle,
  idempotencyCutoffMs: number,
  workspaceCutoffIso: string,
): number {
  const row = database.sqlite
    .prepare(
      [
        "select count(*) as count from tool_idempotency_keys",
        "where created_at < ?",
        "or workspace_session_id in (",
        "  select id from workspace_sessions where last_used_at < ?",
        ")",
      ].join(" "),
    )
    .get(idempotencyCutoffMs, workspaceCutoffIso) as { count: number };
  return row.count;
}

function validatePositiveDays(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    root: row.root,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
