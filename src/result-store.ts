import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import { toolResults, type ToolResultRow } from "./db/schema.js";

export interface DiffStats {
  additions: number;
  removals: number;
}

export type StoredToolName =
  | "open_workspace"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "grep_files"
  | "find_files"
  | "list_directory"
  | "run_shell";

type StoredContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface StoredToolPayload {
  content?: StoredContent[];
  diff?: string;
  patch?: string;
}

export interface StoredToolResult {
  id: string;
  workspaceId?: string;
  workspaceRoot?: string;
  tool: StoredToolName;
  path?: string;
  label?: string;
  createdAt: string;
  summary: Record<string, unknown>;
  payload: StoredToolPayload;
}

export type NewStoredToolResult = Omit<StoredToolResult, "id" | "createdAt">;

export interface ToolResultStore {
  put(input: NewStoredToolResult): StoredToolResult;
  get(resultId: string, workspaceId?: string): StoredToolResult;
  close?(): void;
}

export class SqliteResultStore implements ToolResultStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.migrate();
  }

  put(input: NewStoredToolResult): StoredToolResult {
    const result: StoredToolResult = {
      ...input,
      id: `res_${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };

    this.database.db
      .insert(toolResults)
      .values({
        id: result.id,
        workspaceId: result.workspaceId ?? null,
        workspaceRoot: result.workspaceRoot ?? null,
        tool: result.tool,
        path: result.path ?? null,
        label: result.label ?? null,
        createdAt: result.createdAt,
        summaryJson: JSON.stringify(result.summary),
        payloadJson: JSON.stringify(result.payload),
      })
      .run();

    return result;
  }

  get(resultId: string, workspaceId?: string): StoredToolResult {
    const row = this.database.db
      .select()
      .from(toolResults)
      .where(eq(toolResults.id, resultId))
      .get();

    if (!row || (workspaceId && row.workspaceId !== workspaceId)) {
      throw new Error(`Unknown tool result: ${resultId}`);
    }

    return rowToStoredToolResult(row);
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.sqlite.exec(`
      create table if not exists tool_results (
        id text primary key,
        workspace_id text,
        workspace_root text,
        tool text not null,
        path text,
        label text,
        created_at text not null,
        summary_json text not null,
        payload_json text not null
      );

      create index if not exists tool_results_workspace_idx
        on tool_results(workspace_id, created_at desc);

      create index if not exists tool_results_root_idx
        on tool_results(workspace_root, created_at desc);

      create index if not exists tool_results_tool_idx
        on tool_results(tool, created_at desc);
    `);
  }
}

export function createResultStore(stateDir: string): ToolResultStore {
  return new SqliteResultStore(stateDir);
}

function rowToStoredToolResult(row: ToolResultRow): StoredToolResult {
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? undefined,
    workspaceRoot: row.workspaceRoot ?? undefined,
    tool: row.tool as StoredToolName,
    path: row.path ?? undefined,
    label: row.label ?? undefined,
    createdAt: row.createdAt,
    summary: JSON.parse(row.summaryJson) as Record<string, unknown>,
    payload: JSON.parse(row.payloadJson) as StoredToolPayload,
  };
}

export function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}
