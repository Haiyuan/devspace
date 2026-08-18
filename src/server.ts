import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants, readFileSync } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  createOAuthMetadata,
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { applyPatch } from "./apply-patch.js";
import {
  isArtifactDownloadSupportedPlatform,
  registerArtifactTools,
} from "./artifact-tools.js";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import {
  createOpenAIIncomingArtifactAdapter,
  type IncomingArtifactAdapter,
} from "./incoming-artifacts.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { openDatabase } from "./db/client.js";
import { SqliteOAuthClientsStore } from "./oauth-store.js";
import {
  McpSessionRegistry,
  type McpSessionCloseResult,
} from "./mcp-sessions.js";
import { ProcessSessionManager, type ProcessSnapshot } from "./process-sessions.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { openAiConversationScopeId } from "./request-meta.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { formatPathForPrompt } from "./skills.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import { summarizeLocalAgentProfile } from "./local-agent-profiles.js";
import {
  formatLocalAgentProviderAvailabilitySummary,
  getLocalAgentProviderAvailabilitySnapshot,
  type LocalAgentProviderAvailability,
} from "./local-agent-availability.js";

type Transport = StreamableHTTPServerTransport;
// MCP clients can reconnect without closing the previous transport. Bound stale
// session retention so abandoned MCP servers do not accumulate for the life of the process.
const MCP_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MCP_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const CREATE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

// ── Agent detection ─────────────────────────────────────────────────
// DevSpace detects the connecting AI agent from the MCP initialize
// request's clientInfo.name and loads the correct global instruction file:
//   Claude Code → ~/.claude/CLAUDE.md
//   ChatGPT / Codex → ~/.codex/AGENTS.md
//   Agy / Gemini → ~/.gemini/GEMINI.md
//   OpenCode → ~/.config/opencode/OPENCODE.md

interface SessionAgentContext {
  agentGlobalDir: string;
  agentName: string;
}

const sessionContext = new AsyncLocalStorage<SessionAgentContext>();

function getSessionAgentContext(): SessionAgentContext | undefined {
  return sessionContext.getStore();
}

function detectAgentConfig(clientInfoName: string | undefined): SessionAgentContext {
  const name = (clientInfoName ?? "").toLowerCase().trim();
  for (const [key, config] of Object.entries(AGENT_DIR_MAP)) {
    if (name.includes(key)) {
      return { agentGlobalDir: config.dir, agentName: config.label };
    }
  }
  // Default: Codex / ChatGPT
  return {
    agentGlobalDir: resolvePath(homedir(), ".codex"),
    agentName: "codex",
  };
}

const AGENT_DIR_MAP: Record<string, { dir: string; label: string }> = {
  claude: { dir: resolvePath(homedir(), ".claude"), label: "claude" },
  "claude-code": { dir: resolvePath(homedir(), ".claude"), label: "claude" },
  anthropic: { dir: resolvePath(homedir(), ".claude"), label: "claude" },
  codex: { dir: resolvePath(homedir(), ".codex"), label: "codex" },
  "codex-cli": { dir: resolvePath(homedir(), ".codex"), label: "codex" },
  chatgpt: { dir: resolvePath(homedir(), ".codex"), label: "codex" },
  openai: { dir: resolvePath(homedir(), ".codex"), label: "codex" },
  agy: { dir: resolvePath(homedir(), ".gemini"), label: "gemini" },
  gemini: { dir: resolvePath(homedir(), ".gemini"), label: "gemini" },
  opencode: { dir: resolvePath(homedir(), ".config/opencode"), label: "opencode" },
};

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
  localAgentProviders: LocalAgentProviderAvailability[];
  close(): Promise<void>;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  create: "create",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
} as const;

type ToolNames = typeof toolNames;
const workspaceIdDescription =
  "Workspace to use. Reuse the current project's workspaceId.";
const WORKSPACE_GUIDE_PATHS = [
  "docs/agent_efficiency.md",
  "docs/task_prompts.md",
  "docs/documentation_map.md",
];

function resourceRefreshRecoveryNote(): string {
  return `Recovery: if a DevSpace tool reports "Resource not found" while the server is still running, rediscover DevSpace tools and retry the same request once with the same workspaceId. If the server restarted, the MCP session is unknown or expired, the connection was recreated, or the workspaceId is rejected, rediscover tools and call ${toolNames.openWorkspace} again.`;
}

function serverInstructions(config: ServerConfig): string {
  const artifactInstruction = config.artifactsEnabled && isArtifactDownloadSupportedPlatform()
    ? " When the user supplies or generates a file that is not present on the DevSpace host, use download_artifact with its native file value, the existing workspace ID, and a suitable relative destination path chosen from the user's request and project structure. The tool refuses to overwrite an existing destination and returns the normalized workspace-relative path. Use normal workspace tools when explicit inspection, replacement, movement, renaming, or deletion is needed. Do not recreate binary files with write/edit calls or place signed URLs, native file objects, base64 content, or invented host paths in shell commands or logs."
    : "";
  const showChangesInstruction =
    config.widgets === "changes"
      ? " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs."
      : "";


  if (config.toolMode === "codex") {
    return `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again. Open another workspace only when changing projects, switching checkout/worktree mode, creating another isolated worktree, or when the current workspaceId is rejected. Use ${toolNames.read} for direct file reads, apply_patch for all file modifications, exec_command for inspection, tests, builds, and other commands, and write_stdin to poll or interact with running processes. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.${artifactInstruction}${showChangesInstruction}`;
  }

  const inspection = config.toolMode !== "full"
    ? `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with command-line tools such as grep, rg, find, ls, and tree for search and directory inspection. `
    : `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `;

  const skills = config.skillsEnabled
    ? `If ${toolNames.openWorkspace} returns matching skills, read the skill path with ${toolNames.read} before proceeding.`
    : "";

  const showChanges =
    config.widgets === "changes"
      ? "After file changes, call show_changes once for the aggregate diff."
      : "";

  return [
    `Use DevSpace for coding work. Call ${toolNames.openWorkspace} once for each project folder or isolated worktree, then keep using its workspaceId. During continued work in the same project or worktree, do not call ${toolNames.openWorkspace} again unless the workspaceId is rejected, the project changes, checkout/worktree mode changes, another isolated worktree is needed, or the user asks to reopen.`,
    `Tool choice: ${toolNames.read}=direct inspection; ${toolNames.create}=new files without overwriting; ${toolNames.edit}=targeted exact replacements; ${toolNames.write}=full overwrites only when explicitly needed; ${toolNames.shell}=tests, builds, git inspection, package scripts, search, and read-only shell inspection. Do not create, edit, or overwrite files with ${toolNames.shell}; if a mutating file tool is denied by the host approval UI, stop and report the denial instead of bypassing it with ${toolNames.shell}.`,
    `After ${toolNames.openWorkspace}, follow returned agentsFiles, availableAgentsFiles, skills, and workspace guidance.`,
    skills,
    inspection,
    artifactInstruction,
    showChanges,
    resourceRefreshRecoveryNote(),
  ].filter(Boolean).join(" ");
}

async function existingWorkspaceGuidePaths(root: string): Promise<string[]> {
  const existing: string[] = [];

  for (const docPath of WORKSPACE_GUIDE_PATHS) {
    try {
      await access(join(root, docPath), constants.R_OK);
      existing.push(docPath);
    } catch {
      // Optional workspace guidance docs may not exist in every opened project.
    }
  }

  return existing;
}

function workspaceInstruction(
  config: ServerConfig,
  guidePaths: string[],
): string {
  const nestedInstructions =
    "Follow loaded agentsFiles instructions. Before working under paths listed in availableAgentsFiles, read those instruction files.";
  const skills = config.skillsEnabled
    ? "If a task matches a returned skill, read that skill path before proceeding."
    : "";
  const guideReferences = guidePaths.length > 0
    ? `Workspace references: ${guidePaths.join(", ")}.`
    : "";

  return [
    `Use this workspaceId for this project or worktree. Keep reusing it until it stops working, the user asks to reopen, or you switch project folders or checkout/worktree mode.`,
    `Fastest safe workflow: inspect with ${toolNames.read}; ${toolNames.create} for new files without overwriting; ${toolNames.edit} for targeted exact replacements; ${toolNames.write} for full overwrites only when explicitly needed; ${toolNames.shell} for tests, builds, git inspection, search, and read-only shell inspection, not file creation or edits. If a mutating file tool is denied by the host approval UI, stop and report the denial instead of bypassing it with ${toolNames.shell}.`,
    nestedInstructions,
    skills,
    guideReferences,
    resourceRefreshRecoveryNote(),
  ].filter(Boolean).join(" ");
}

function formatVisibleAgent(agent: {
  name: string;
  provider: string;
  model?: string;
  thinking?: string;
  providerAvailable?: boolean;
  providerUnavailableReason?: string;
}): string {
  const model = agent.model ? `, model ${agent.model}` : "";
  const thinking = agent.thinking ? `, thinking ${agent.thinking}` : "";
  const availability = agent.providerAvailable === false
    ? `, unavailable: ${agent.providerUnavailableReason ?? "provider unavailable"}`
    : "";
  return `${agent.name} (${agent.provider}${model}${thinking}${availability})`;
}

function formatUnavailableAgentProvider(provider: LocalAgentProviderAvailability): string {
  return `${provider.name} (${provider.reason ?? "unavailable"})`;
}

function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe(
        "Model-readable result text for follow-up reasoning and plain MCP hosts.",
      ),
    ...extra,
  };
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceLocalAgentOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  providerAvailable: z.boolean().optional(),
  providerUnavailableReason: z.string().optional(),
});

const workspaceLocalAgentProviderOutputSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
  data?: unknown,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message, ...(data !== undefined ? { data } : {}) },
    id: null,
  });
}

function ensureMcpAcceptHeader(req: Request): void {
  const headers = req.headers as Record<string, string | string[] | undefined>;
  const current = headers.accept;
  const currentAccept = Array.isArray(current) ? current.join(", ") : current;
  const acceptParts = new Set(
    (currentAccept ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );

  acceptParts.add("application/json");
  acceptParts.add("text/event-stream");
  const nextAccept = [...acceptParts].join(", ");
  headers.accept = nextAccept;

  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === "accept") {
      req.rawHeaders[i + 1] = nextAccept;
      return;
    }
  }
  req.rawHeaders.push("Accept", nextAccept);
}

function ensureInitializeParams(req: Request): void {
  const body = req.body as { method?: unknown; params?: unknown } | undefined;
  if (
    req.method !== "POST" ||
    !body ||
    body.method !== "initialize" ||
    (body.params && Object.keys(body.params).length > 0)
  ) {
    return;
  }

  body.params = {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "chatgpt", version: "unknown" },
  };
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  return JSON.parse(readFileSync(uiManifestUrl(), "utf8")) as WorkspaceAppManifest;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="app" class="shell">
      <section class="empty">Waiting for a tool result.</section>
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
}

export interface ReadinessReport {
  ok: boolean;
  name: "devspace";
  checks: {
    configLoaded: boolean;
    stateDirWritable: boolean;
    sqlite: boolean;
    uiAssets: boolean;
  };
}

export interface ReadinessCheckers {
  stateDirWritable(): boolean | Promise<boolean>;
  sqlite(): boolean | Promise<boolean>;
  uiAssets(): boolean | Promise<boolean>;
}

async function booleanCheck(check: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return Boolean(await check());
  } catch {
    return false;
  }
}

async function stateDirWritable(stateDir: string): Promise<boolean> {
  await access(stateDir, constants.R_OK | constants.W_OK);
  return true;
}

function sqliteStoreReady(stateDir: string): boolean {
  const database = openDatabase(stateDir);
  database.close();
  return true;
}

export async function createReadinessReport(
  config: ServerConfig,
  checkers: ReadinessCheckers = {
    stateDirWritable: () => stateDirWritable(config.stateDir),
    sqlite: () => sqliteStoreReady(config.stateDir),
    uiAssets: async () => {
      await assertWorkspaceAppAssets();
      return true;
    },
  },
): Promise<ReadinessReport> {
  const checks = {
    configLoaded: true,
    stateDirWritable: await booleanCheck(checkers.stateDirWritable),
    sqlite: await booleanCheck(checkers.sqlite),
    uiAssets: await booleanCheck(checkers.uiAssets),
  };

  return {
    ok: Object.values(checks).every(Boolean),
    name: "devspace",
    checks,
  };
}

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output ? `${snapshot.output.replace(/\n$/, "")}\n${status}` : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    sessionId: z.number().optional(),
    running: z.boolean(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    wallTimeMs: z.number().nonnegative(),
    outputTruncated: z.boolean(),
  });
}

function processToolResponse(
  tool: "exec_command" | "write_stdin",
  workspaceId: string,
  snapshot: ProcessSnapshot,
  summary: Record<string, unknown>,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  const outputSummary = textSummary(snapshot.output ? [textBlock(snapshot.output)] : []);
  return {
    content,
    _meta: {
      tool,
      card: {
        workspaceId,
        summary: { ...summary, ...outputSummary },
        payload: { content },
      },
    },
    structuredContent: {
      result,
      sessionId: snapshot.sessionId,
      running: snapshot.running,
      exitCode: snapshot.exitCode,
      signal: snapshot.signal,
      wallTimeMs: snapshot.wallTimeMs,
      outputTruncated: snapshot.outputTruncated,
    },
  };
}

function registerCodexProcessTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  processSessions: ProcessSessionManager,
): void {
  registerAppTool(
    server,
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a command in a workspace. Returns its result when it exits during the yield window, otherwise returns a sessionId for write_stdin. Use this for file inspection, tests, builds, package scripts, and long-running processes.",
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe("Allocate a pseudo-terminal for interactive commands. Defaults to false."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Initial PTY width. Defaults to 80."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Initial PTY height. Defaults to 24."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory relative to the workspace root. Defaults to the workspace root."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait before returning a running session. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, cmd, tty, columns, rows, workingDirectory, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(workspace, workingDirectory);
      const snapshot = await processSessions.start({
        workspaceId,
        command: cmd,
        cwd,
        workspaceRoot: workspace.root,
        tty,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "exec_command",
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: cmd,
        commandLength: cmd.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("exec_command", workspaceId, snapshot, {
        command: cmd,
        workingDirectory: workingDirectory ?? ".",
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );

  registerAppTool(
    server,
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace identifier used to start the process."),
        sessionId: z.number().describe("Process session identifier returned by exec_command."),
        chars: z.string().optional().describe("Characters to write. Omit or pass an empty string to poll."),
        columns: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this width."),
        rows: z.number().int().min(1).max(1_000).optional().describe("Resize a PTY to this height."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .optional()
          .describe("Milliseconds to wait for process output or completion. Defaults to 10000."),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, sessionId, chars, columns, rows, yieldTimeMs, maxOutputTokens }) => {
      const startedAt = performance.now();
      workspaces.getWorkspace(workspaceId);
      const snapshot = await processSessions.write({
        workspaceId,
        sessionId,
        chars,
        columns,
        rows,
        yieldTimeMs,
        maxOutputTokens,
      });

      logToolCall(config, {
        tool: "write_stdin",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return processToolResponse("write_stdin", workspaceId, snapshot, {
        sessionId,
        charactersWritten: chars?.length ?? 0,
        running: snapshot.running,
        exitCode: snapshot.exitCode,
        wallTimeMs: snapshot.wallTimeMs,
      });
    },
  );
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  processSessions: ProcessSessionManager,
  localAgentProviders: LocalAgentProviderAvailability[],
  incomingArtifactAdapters: readonly IncomingArtifactAdapter[],
): McpServer {
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: "0.1.0",
      description:
        "Coding tools for project workspaces. Open each project or worktree once, then reuse its workspaceId.",
    },
    {
      instructions: serverInstructions(config),
    },
  );

  registerAppResource(
    server,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "session_status",
    {
      title: "Session status",
      description: "Return session diagnostic information, including serverVersion, toolSchemaVersion, workspaceValid, and toolsValid. Use this to check if a workspace is still valid before calling tools if you suspect resources are stale.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Optional workspaceId to validate."),
      },
      outputSchema: resultOutputSchema(),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      _meta: {},
    },
    async ({ workspaceId }) => {
      let workspaceValid = false;
      if (workspaceId) {
        try {
          const workspace = workspaces.getWorkspace(workspaceId);
          if (workspace) workspaceValid = true;
        } catch {
          workspaceValid = false;
        }
      }
      
      const status = {
        serverVersion: process.env.npm_package_version || "unknown",
        toolSchemaVersion: "1.0",
        workspaceId,
        workspaceValid,
        toolsValid: true,
      };

      return {
        content: [textBlock(JSON.stringify(status, null, 2))],
      };
    },
  );

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        `Start work in a project directory or isolated worktree when no usable workspaceId exists for it. During continued work in the same project or worktree, reuse the existing workspaceId instead of calling this tool again. Defaults to the actual checkout; set mode=\"worktree\" for an isolated managed worktree. Returns workspace instructions, loaded instruction files, nested instruction paths, and matching skills.`,
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path, or a leading-tilde home path such as ~/project, to a project directory inside an allowed root.",
          ),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe(
            "Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work.",
          ),
        baseRef: z
          .string()
          .optional()
          .describe("Git ref to base a worktree on. Only used with mode=\"worktree\". Defaults to HEAD."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema).optional(),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema).optional(),
        skills: z.array(workspaceSkillOutputSchema).optional(),
        agentProviders: z.array(workspaceLocalAgentProviderOutputSchema).optional(),
        agents: z.array(workspaceLocalAgentOutputSchema).optional(),
        skillDiagnostics: z.array(z.unknown()).optional(),
        instruction: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ path, mode, baseRef }, { _meta }) => {
      const startedAt = performance.now();
      const sessionAgent = getSessionAgentContext();
      const {
        workspace,
        agentsFiles,
        availableAgentsFiles,
        workspaceReused,
        includeBootstrapContext,
      } = await workspaces.openWorkspace(
        { path, mode, baseRef, agentGlobalDir: sessionAgent?.agentGlobalDir },
        { conversationScopeId: openAiConversationScopeId(_meta) },
      );
      if (config.widgets === "changes") {
        await reviewCheckpoints.initializeWorkspace({
          workspaceId: workspace.id,
          root: workspace.root,
        });
      }
      const cardSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const cardAgentProviders = config.subagents ? localAgentProviders : [];
      const cardAgents = workspace.agentProfiles.map((profile) => {
        const summary = summarizeLocalAgentProfile(profile);
        const availability = cardAgentProviders.find((provider) => provider.name === summary.provider);
        return {
          ...summary,
          providerAvailable: availability?.available,
          providerUnavailableReason: availability?.reason,
        };
      });
      const cardAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const cardAvailableAgentsFiles = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const guidePaths = await existingWorkspaceGuidePaths(workspace.root);
      const cardInstruction = workspaceInstruction(config, guidePaths);
      const visibleSkills = includeBootstrapContext ? cardSkills : [];
      const visibleAgentProviders = includeBootstrapContext ? cardAgentProviders : [];
      const visibleAgents = includeBootstrapContext ? cardAgents : [];
      const loadedAgentsFiles = includeBootstrapContext ? cardAgentsFiles : [];
      const availableAgentsFileOutputs = includeBootstrapContext ? cardAvailableAgentsFiles : [];
      const instruction = workspaceReused
        ? [
            `Workspace already open as ${workspace.id}.`,
            "Continue with this workspaceId.",
            "Keep following the project instructions, nested instruction files, skills, agent profiles, diagnostics, workspace guidance, and recovery rules already provided for this workspace.",
          ].join("\n\n")
        : cardInstruction;
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            workspaceReused
              ? `Workspace already open as ${workspace.id}.`
              : workspace.mode === "worktree"
                ? `Opened isolated worktree workspace ${workspace.id}.`
                : `Opened workspace ${workspace.id}.`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => provider.available)
              ? `Available subagent providers: ${visibleAgentProviders.filter((provider) => provider.available).map((provider) => provider.name).join(", ")}`
              : undefined,
            visibleAgentProviders.some((provider) => !provider.available)
              ? `Unavailable subagent providers: ${visibleAgentProviders.filter((provider) => !provider.available).map(formatUnavailableAgentProvider).join(", ")}`
              : undefined,
            visibleAgents.length > 0
              ? `Available subagent profiles: ${visibleAgents.map(formatVisibleAgent).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            mode: workspace.mode,
            workspaceReused,
            includeBootstrapContext,
            sourceRoot: workspace.sourceRoot,
            worktree: workspace.worktree,
            agentsFiles: cardAgentsFiles,
            availableAgentsFiles: cardAvailableAgentsFiles,
            skills: cardSkills,
            agentProviders: cardAgentProviders,
            agents: cardAgents,
            instruction: cardInstruction,
            summary: {
              mode: workspace.mode,
              agentsFiles: cardAgentsFiles.length,
              availableAgentsFiles: cardAvailableAgentsFiles.length,
              skills: cardSkills.length,
              agentProviders: cardAgentProviders.length,
              agents: cardAgents.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          ...(includeBootstrapContext
            ? {
                agentsFiles: loadedAgentsFiles,
                availableAgentsFiles: availableAgentsFileOutputs,
                skills: visibleSkills,
                agentProviders: visibleAgentProviders,
                agents: visibleAgents,
                skillDiagnostics: workspace.skillDiagnostics,
              }
            : {}),
          instruction,
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        [
          "Inspect a file in a workspace. Prefer this over shell commands like cat or sed for direct file reads.",
          "Use it for project instruction files returned by open_workspace before working in nested directories.",
          config.skillsEnabled
            ? "Use it for advertised skill paths when a returned skill matches the task."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe(
            config.skillsEnabled
              ? "File path to read, relative to the workspace root. May also be an advertised skill path from open_workspace skills."
              : "File path to read, relative to the workspace root.",
          ),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line number to start reading from."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum number of lines to read."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.create,
    {
      title: "Create file",
      description:
        `Create a new file in a workspace and fail if the path already exists with different content. Prefer this over ${toolNames.write} for new files. Do not use ${toolNames.shell} as a fallback when this tool is denied by the host approval UI.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe("New file path to create, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema({
        status: z.enum(["created", "already_exists"]),
      }),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: CREATE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const absolutePath = workspaces.resolvePath(workspace, input.path);
      let status: "created" | "already_exists" = "created";
      let patch: string | undefined;

      try {
        await access(absolutePath, constants.F_OK);
        const existingContent = await readFile(absolutePath, "utf8");
        if (existingContent !== input.content) {
          const content = [
            textBlock(
              `File already exists with different content: ${input.path}. Use ${toolNames.edit} for targeted changes or ${toolNames.write} only when a full overwrite is explicitly intended.`,
            ),
          ];
          logFailedToolResponse(config, {
            tool: toolNames.create,
            workspaceId,
            path: input.path,
          }, content, startedAt);
          return { content, isError: true };
        }
        status = "already_exists";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          const content = [textBlock(error instanceof Error ? error.message : String(error))];
          logFailedToolResponse(config, {
            tool: toolNames.create,
            workspaceId,
            path: input.path,
          }, content, startedAt);
          return { content, isError: true };
        }

        const response = await writeFileTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });
        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.create,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }
        patch = newFilePatch(input.path, input.content);
      }

      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        status,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      const resultText = status === "created"
        ? `Created ${input.path} (+${stats.additions} -${stats.removals}).`
        : `File already exists with matching content: ${input.path}.`;
      const content = [textBlock(resultText)];
      logToolCall(config, {
        tool: toolNames.create,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        content,
        _meta: {
          tool: toolNames.create,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content,
              patch,
            },
          },
        },
        structuredContent: {
          status,
          result: contentText(content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Completely overwrite a file in a workspace. Prefer ${toolNames.create} for new files and ${toolNames.edit} for targeted changes to existing files. Do not use ${toolNames.shell} as a fallback when this tool is denied by the host approval UI.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
        idempotencyKey: z.string().optional().describe("Optional key to safely retry the write operation."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, idempotencyKey, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      
      if (idempotencyKey && workspaces["store"]) {
        const cached = workspaces["store"].getIdempotencyResult(workspaceId, idempotencyKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          return { content: [{ type: "text", text: parsed.result }], structuredContent: parsed };
        }
      }

      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      const finalResponse = {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };

      if (idempotencyKey && workspaces["store"]) {
        workspaces["store"].saveIdempotencyResult(workspaceId, idempotencyKey, JSON.stringify(finalResponse.structuredContent));
      }

      return finalResponse;
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit one existing file in a workspace with targeted exact-text replacements. Prefer this over ${toolNames.write} for small changes. Each oldText must match a unique, non-overlapping region; keep oldText as small as practical while still unique and merge nearby changes when that reduces churn.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
        idempotencyKey: z.string().optional().describe("Optional key to safely retry the edit operation."),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, idempotencyKey, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);

      if (idempotencyKey && workspaces["store"]) {
        const cached = workspaces["store"].getIdempotencyResult(workspaceId, idempotencyKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          return { content: [{ type: "text", text: parsed.result }], structuredContent: parsed };
        }
      }

      workspaces.resolvePath(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      const finalResponse = {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };

      if (idempotencyKey && workspaces["store"]) {
        workspaces["store"].saveIdempotencyResult(workspaceId, idempotencyKey, JSON.stringify(finalResponse.structuredContent));
      }

      return finalResponse;
    },
  );
  }

  if (config.toolMode === "codex") {
    registerAppTool(
      server,
      "apply_patch",
      {
        title: "Apply patch",
        description:
          "Apply one Codex-style patch in a workspace. Supports adding, overwriting, updating, deleting, and moving files. Use this for all file modifications. Paths must be relative to the workspace.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          patch: z
            .string()
            .describe("Patch text enclosed by *** Begin Patch and *** End Patch markers."),
        },
        outputSchema: resultOutputSchema({
          additions: z.number(),
          removals: z.number(),
          files: z.array(
            z.object({
              path: z.string(),
              previousPath: z.string().optional(),
              operation: z.enum(["add", "update", "delete", "move"]),
            }),
          ),
        }),
        ...toolWidgetDescriptorMeta(config, "edit"),
        annotations: EDIT_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, patch }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const applied = await applyPatch(workspace.root, patch);
        const paths = applied.files.map((file) => file.path).join(", ");
        const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
        const content = [textBlock(result)];
        const displayPath = applied.files.length === 1
          ? applied.files[0]?.path
          : `${applied.files.length} files`;

        logToolCall(config, {
          tool: "apply_patch",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "apply_patch",
            card: {
              workspaceId,
              path: displayPath,
              summary: {
                files: applied.files.length,
                additions: applied.additions,
                removals: applied.removals,
              },
              files: applied.files,
              payload: { patch: applied.patch },
            },
          },
          structuredContent: {
            result,
            additions: applied.additions,
            removals: applied.removals,
            files: applied.files,
          },
        };
      },
    );
  }

  if (config.widgets === "changes") {
    registerAppTool(
      server,
      "show_changes",
      {
        title: "Show changes",
        description:
          "Show the changes made in this turn for an open workspace. Call this once after the final related file change and before your final response so the user can review the combined diff. Do not call it after each individual file change.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "show_changes"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const review = await reviewCheckpoints.reviewChanges({
          workspaceId,
          root: workspace.root,
          markReviewed: true,
        });

        const content = [textBlock(review.result)];
        logToolCall(config, {
          tool: "show_changes",
          workspaceId,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          content,
          _meta: {
            tool: "show_changes",
            card: {
              workspaceId,
              summary: review.summary,
              files: review.files,
              payload: {
                patch: review.patch,
              },
            },
          },
          structuredContent: {
            result: contentText(content),
          },
        };
      },
    );
  }

  if (config.toolMode === "full") {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: "Grep",
        description:
          "Search file contents in a workspace. Use this before broad reads when looking for symbols, text, or usage sites. Respects project ignore rules.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          pattern: z.string().describe("Search pattern."),
          path: z
            .string()
            .optional()
            .describe(
              "Optional path or glob scope relative to the workspace root.",
            ),
          include: z.string().optional().describe("Optional include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: "Glob",
        description:
          "Find files by glob pattern in a workspace. Use this to discover filenames or narrow file sets before reading. Respects project ignore rules.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          pattern: z.string().describe("File glob pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional path scope relative to the workspace root."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: "Ls",
        description:
          "List a directory in a workspace. Use this for directory inspection before reading files.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe(workspaceIdDescription),
          path: z
            .string()
            .describe(
              "Directory path to list, relative to the workspace root.",
            ),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );
  }

  if (config.toolMode !== "codex") {
  registerAppTool(
    server,
    toolNames.shell,
    {
      title: "Bash",
      description: config.toolMode !== "full"
        ? `Run a shell command in a workspace. Use only for tests, builds, git inspection, package scripts, search, file discovery, and directory inspection. In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use command-line tools such as grep, rg, find, ls, and tree for those read-only inspection actions. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read} for direct file reads. This is powerful local execution and should only be exposed behind strong authentication.`
        : `Run a shell command in a workspace. Use only for tests, builds, git inspection, package scripts, and commands that are better executed by the shell. Do not use ${toolNames.shell} to create or modify files. Do not use shell redirection, heredocs, tee, sed -i, perl -i, node/python/ruby scripts, or generated scripts to write project files; use ${toolNames.edit} for targeted changes and ${toolNames.write} for new files or full rewrites. Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. This is powerful local execution and should only be exposed behind strong authentication.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe(workspaceIdDescription),
        command: z
          .string()
          .describe(
            `Shell command to run. Must not create or modify project files; use ${toolNames.create}, ${toolNames.edit}, or ${toolNames.write} for file changes.`,
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, workingDirectory, ...input }) => {
      const startedAt = performance.now();
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
      });

      if (response.isError) {
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.shell,
          card: {
            workspaceId,
            path: workingDirectory,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );
  }

  if (config.toolMode === "codex") {
    registerCodexProcessTools(server, config, workspaces, processSessions);
  }

  if (config.artifactsEnabled && isArtifactDownloadSupportedPlatform()) {
    registerArtifactTools(server, {
      config,
      workspaces,
      incomingArtifactAdapters,
    });
  }

  return server;
}

export interface CreateServerOptions {
  incomingArtifactAdapters?: readonly IncomingArtifactAdapter[];
}

export function createServer(
  config = loadConfig(),
  options: CreateServerOptions = {},
): RunningServer {
  const incomingArtifactAdapters = options.incomingArtifactAdapters
    ?? [createOpenAIIncomingArtifactAdapter()];
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new McpSessionRegistry<Transport>();
  const sessionAgents = new Map<string, SessionAgentContext>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(config.oauth, mcpUrl, config.stateDir);
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const processSessions = new ProcessSessionManager();
  const localAgentProviders = config.subagents
    ? getLocalAgentProviderAvailabilitySnapshot()
    : [];

  const logSessionCloseResults = (
    reason: "idle_timeout" | "server_shutdown",
    results: McpSessionCloseResult[],
  ) => {
    for (const result of results) {
      sessionAgents.delete(result.sessionId);
      if (result.error) {
        logEvent(config.logging, "warn", "mcp_session_close_failed", {
          reason,
          sessionIdPrefix: sessionIdPrefix(result.sessionId),
          error:
            result.error instanceof Error
              ? result.error.message
              : String(result.error),
        });
        continue;
      }

      logEvent(config.logging, "info", "mcp_session_closed", {
        reason,
        sessionIdPrefix: sessionIdPrefix(result.sessionId),
      });
    }
  };

  const sessionCleanupTimer = setInterval(() => {
    void transports
      .closeIdle(MCP_SESSION_IDLE_TIMEOUT_MS)
      .then((results) => logSessionCloseResults("idle_timeout", results));
  }, MCP_SESSION_CLEANUP_INTERVAL_MS);
  sessionCleanupTimer.unref();

  if (config.logging.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (!config.logging.assets && path.startsWith("/mcp-app-assets")) return;

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.get(
    [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ],
    (_req, res) => {
      const metadata = createOAuthMetadata({
        provider: oauthProvider,
        issuerUrl: new URL(config.publicBaseUrl),
        baseUrl: new URL(config.publicBaseUrl),
        scopesSupported: config.oauth.scopes,
      }) as any;

      res
        .status(200)
        .setHeader("Cache-Control", "no-store, max-age=0")
        .setHeader("Access-Control-Allow-Origin", "*")
        .json({
          ...metadata,
          token_endpoint_auth_methods_supported: [
            "client_secret_basic",
            "client_secret_post",
            "none",
          ],
          client_id_metadata_document_supported: true,
        });
    },
  );

  // Custom CIMD-aware registration handler
  // Registered before mcpAuthRouter so it takes priority over the SDK's
  // DCR-only handler. Supports both:
  //   - DCR (RFC 7591):  no client_id in body → server mints devspace-<uuid>
  //   - CIMD:            client_id is an HTTPS URL → server validates & stores
  app.post("/register", async (req, res) => {
    try {
      const schema = OAuthClientMetadataSchema.extend({
        client_id: z.string().optional(),
      });
      const parseResult = schema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          error: "invalid_client_metadata",
          error_description: parseResult.error.message,
        });
        return;
      }

      const metadata = parseResult.data;
      const isPublicClient =
        !metadata.token_endpoint_auth_method ||
        metadata.token_endpoint_auth_method === "none";
      const clientSecret = isPublicClient
        ? undefined
        : randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

      const clientInfo = await oauthProvider.clientsStore.registerClient!({
        ...metadata,
        client_secret: clientSecret,
        client_id: (metadata as Record<string, unknown>).client_id as
          | string
          | undefined,
      } as any);

      res.setHeader("Cache-Control", "no-store");
      res.status(201).json(clientInfo);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Internal Server Error";
      const isBadRequest =
        message.startsWith("Invalid") || message.startsWith("Client");
      res.status(isBadRequest ? 400 : 500).json({
        error: isBadRequest ? "invalid_request" : "server_error",
        error_description: message,
      });
    }
  });

  // ChatGPT-compatibility middleware for /authorize:
  //   1. Auto-register dynamic redirect URIs on first use
  //   2. Inject PKCE params when the client omits them (ChatGPT does)
  //   3. Inject resource param when the client omits it
  //   4. Convert localhost 302 redirects to HTML page (browsers block
  //      HTTPS→http://localhost redirects as mixed content)
  app.use("/authorize", express.urlencoded({ extended: false }), (req, res, next) => {
    // Intercept res.redirect() to convert localhost 302 → HTML page.
    // Browsers block HTTPS→http://localhost redirects (mixed content);
    // rendering an HTML page with a clickable link avoids the block.
    const origRedirect = res.redirect.bind(res);
    res.redirect = ((...args: [string] | [number, string]) => {
      const target = typeof args[0] === "string" ? args[0] : (args[1] ?? "");
      if (
        target.startsWith("http://localhost") ||
        target.startsWith("http://127.0.0.1")
      ) {
        const safe = target.replace(/"/g, "&quot;");
        res
          .status(200)
          .setHeader("Content-Type", "text/html; charset=utf-8")
          .send(
            "<!doctype html><html lang=en><meta charset=utf-8>" +
              "<title>DevSpace Authorized</title>" +
              "<style>body{font-family:system-ui,sans-serif;max-width:440px;" +
              "margin:12vh auto;padding:32px;text-align:center}" +
              "a{color:#38bdf8;word-break:break-all}</style>" +
              "<h1>DevSpace Authorized</h1>" +
              '<p>Click the link to complete the connection:</p>' +
              `<p><a href="${safe}">Complete OAuth callback</a></p>`,
          );
        return;
      }
      if (typeof args[0] === "string") {
        origRedirect(args[0]);
      } else {
        origRedirect(args[0], args[1]!);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    try {

      // For GET requests, Express re-parses req.query when entering a Router.
      // Modifying req.url ensures injected params survive.
      let urlObj: URL | undefined;
      if (req.method === "GET") {
        urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      }

      const params = (
        req.method === "POST" ? req.body : req.query
      ) as Record<string, string> | undefined;

      if (params) {
        const clientId = params.client_id;
        const redirectUri = params.redirect_uri;

        // Auto-register chatgpt.com redirect URIs
        if (clientId && redirectUri) {
          try {
            const redirectUrl = new URL(redirectUri);
            if (redirectUrl.hostname === "chatgpt.com" || redirectUrl.hostname.endsWith(".chatgpt.com")) {
              const store = oauthProvider.clientsStore as SqliteOAuthClientsStore;
              store.addRedirectUri(clientId, redirectUri);
            }
          } catch {
            // Ignore invalid URL
          }
        }
      }

      // Inject placeholder PKCE params when the client omits them.
      if (!params || !params.code_challenge) {
        if (req.method === "POST" && req.body) {
          req.body = { ...req.body, code_challenge: "lMQLhXz1Z9OV4zcJb1UDz49bwGteWSgdPzX4Sdwpu8E", code_challenge_method: "S256" };
        } else if (req.method === "GET" && urlObj) {
          urlObj.searchParams.set("code_challenge", "lMQLhXz1Z9OV4zcJb1UDz49bwGteWSgdPzX4Sdwpu8E");
          urlObj.searchParams.set("code_challenge_method", "S256");
        }
      }

      // Inject resource param when the client omits it.
      if (!params || !params.resource) {
        if (req.method === "POST" && req.body) {
          req.body = { ...req.body, resource: resourceServerUrl.href };
        } else if (req.method === "GET" && urlObj) {
          urlObj.searchParams.set("resource", resourceServerUrl.href);
        }
      }

      if (req.method === "GET" && urlObj) {
        req.url = urlObj.pathname + urlObj.search;
      }
    } catch {
      // best-effort — never block the authorize flow
    }
    next();
  });

  // ChatGPT-compatibility middleware for /token:
  //   1. Support Basic Auth (ChatGPT "In header" option) by converting to body params
  //   2. Inject a placeholder code_verifier when the client omits it.
  //   Must parse the urlencoded body BEFORE the SDK's token handler.
  app.use("/token", express.urlencoded({ extended: false }), (req, _res, next) => {
    try {
      if (req.method === "POST" && req.body) {
        // 1. Support Basic Auth
        const auth = req.headers.authorization;
        if (auth && auth.toLowerCase().startsWith("basic ")) {
          const credentials = Buffer.from(auth.slice(6), "base64").toString("utf-8");
          const [clientId, clientSecret] = credentials.split(":");
          if (clientId) req.body.client_id = clientId;
          if (clientSecret) req.body.client_secret = clientSecret;
        }

        if (!req.body.client_id && req.body.grant_type === "authorization_code" && req.body.code) {
          const clientId = oauthProvider.clientIdForAuthorizationCode(String(req.body.code));
          if (clientId) req.body.client_id = clientId;
        }

        // 2. Inject code_verifier if omitted (ChatGPT does not do PKCE)
        if (!req.body.code_verifier && req.body.grant_type === "authorization_code") {
          req.body.code_verifier = "chatgpt-no-pkce";
        }
      }

      logEvent(config.logging, "info", "oauth_token_probe", {
        requestId: _res.locals.requestId as string | undefined,
        method: req.method,
        grantType: typeof req.body?.grant_type === "string" ? req.body.grant_type : undefined,
        hasAuthorization: Boolean(req.headers.authorization),
        hasClientId: Boolean(req.body?.client_id),
        hasClientSecret: Boolean(req.body?.client_secret),
        hasCode: Boolean(req.body?.code),
        hasCodeVerifier: Boolean(req.body?.code_verifier),
        hasResource: Boolean(req.body?.resource),
        ...requestLogFields(req, config),
      });
    } catch {
      // best-effort
    }
    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
      clientRegistrationOptions: {
        // ChatGPT may retry connector creation several times; the SDK default
        // 20/hour DCR limit can make a valid server look RFC7591-incompatible.
        rateLimit: { max: 300 },
        // Allow client-provided client_id for CIMD; our custom /register
        // handler above handles both DCR and CIMD flows.
        clientIdGeneration: false,
      },
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "devspace" });
  });

  app.get("/readyz", async (_req, res) => {
    const report = await createReadinessReport(config);
    res.status(report.ok ? 200 : 503).json(report);
  });

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    ensureInitializeParams(req);
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    // ChatGPT sometimes omits the MCP-required Accept values. The SDK's
    // Node wrapper rebuilds Web Headers from rawHeaders, so keep both views
    // in sync before handing the request to the transport.
    ensureMcpAcceptHeader(req);

    logEvent(config.logging, "info", "mcp_probe", {
      requestId,
      method: req.method,
      hasAuthorization: Boolean(req.headers.authorization),
      hasSessionId: Boolean(sessionId),
      bodyMethod: typeof req.body?.method === "string" ? req.body.method : undefined,
      isInitialize: initializeRequest,
      paramsKeys:
        req.body?.params && typeof req.body.params === "object"
          ? Object.keys(req.body.params)
          : undefined,
      ...requestLogFields(req, config),
    });

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      let transport: Transport | undefined;
      let agentConfig: SessionAgentContext | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        agentConfig = sessionAgents.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 400, -32000, "Unknown MCP session", {
            code: "MCP_SESSION_EXPIRED",
            recoverable: true,
            recommended_action: "rediscover_tools_and_reopen_workspace",
            retry_policy: {
              rediscoverTools: true,
              reopenWorkspace: true,
              reuseWorkspaceId: false,
            },
          });
          return;
        }
      } else if (initializeRequest) {
        // Detect which AI agent is connecting and load the appropriate
        // global instruction file directory.
        const clientInfoName =
          (req.body?.params as Record<string, unknown> | undefined)
            ?.clientInfo as
            | { name?: unknown }
            | undefined;
        agentConfig = detectAgentConfig(
          typeof clientInfoName?.name === "string"
            ? clientInfoName.name
            : undefined,
        );
        logEvent(config.logging, "info", "mcp_agent_detected", {
          requestId,
          agentName: agentConfig.agentName,
          agentGlobalDir: agentConfig.agentGlobalDir,
          clientInfoName:
            typeof clientInfoName?.name === "string"
              ? clientInfoName.name
              : undefined,
        });

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) {
              transports.register(newSessionId, transport);
              sessionAgents.set(newSessionId, agentConfig!);
            }
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              agentName: agentConfig!.agentName,
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            const removed = transports.remove(closedSessionId);
            sessionAgents.delete(closedSessionId);
            if (!removed) return;
            logEvent(config.logging, "info", "mcp_session_closed", {
              reason: "transport_close",
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(
          config,
          workspaces,
          reviewCheckpoints,
          processSessions,
          localAgentProviders,
          incomingArtifactAdapters,
        );
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await sessionContext.run(
        agentConfig ?? { agentGlobalDir: resolvePath(homedir(), ".codex"), agentName: "codex" },
        () => transport!.handleRequest(req, res, req.body),
      );
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    localAgentProviders,
    close: () => {
      closePromise ??= (async () => {
        clearInterval(sessionCleanupTimer);
        const results = await transports.closeAll();
        logSessionCloseResults("server_shutdown", results);
        processSessions.shutdown();
        oauthProvider.close();
        workspaceStore.close?.();
      })();
      return closePromise;
    },
  };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host);
  httpServer.on("listening", () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
    const artifactDownloadStatus = !config.artifactsEnabled
      ? "disabled"
      : isArtifactDownloadSupportedPlatform()
        ? "enabled"
        : `unsupported on ${process.platform}`;
    console.log(`native artifact download: ${artifactDownloadStatus}`);
    if (config.subagents) {
      console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
    }
  });
  httpServer.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`error: Port ${config.port} is already in use.`);
    } else {
      console.error("Server error:", error);
    }
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}
