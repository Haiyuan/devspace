import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  authToken?: string;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  minimalTools: boolean;
  persistResults: boolean;
  resultTtlMs: number;
  stateDir: string;
}

function parsePort(value: string | undefined): number {
  if (!value) return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | undefined): string[] {
  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(root));
}

function parseAllowedHosts(value: string | undefined): string[] {
  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return rawHosts.length > 0 ? rawHosts : ["localhost", "127.0.0.1"];
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parseMinimalTools(env: NodeJS.ProcessEnv): boolean {
  return env.PI_ON_MCP_TOOL_MODE === "minimal" || parseBoolean(env.PI_ON_MCP_MINIMAL_TOOLS);
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "pi-on-mcp");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: parsePort(env.PORT),
    authToken: env.PI_ON_MCP_TOKEN,
    allowedRoots: parseAllowedRoots(env.PI_ON_MCP_ALLOWED_ROOTS),
    allowedHosts: parseAllowedHosts(env.PI_ON_MCP_ALLOWED_HOSTS),
    publicBaseUrl: env.PI_ON_MCP_PUBLIC_BASE_URL ?? "https://agent.gitcms.blog",
    minimalTools: parseMinimalTools(env),
    persistResults: env.PI_ON_MCP_PERSIST_RESULTS === "0" ? false : true,
    resultTtlMs: parsePositiveInteger(env.PI_ON_MCP_RESULT_TTL_DAYS, 14, "PI_ON_MCP_RESULT_TTL_DAYS") * 24 * 60 * 60 * 1000,
    stateDir: resolve(env.PI_ON_MCP_STATE_DIR ?? defaultStateDir()),
  };
}
