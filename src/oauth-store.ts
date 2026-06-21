import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  OAuthClientMetadataSchema,
  type OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export interface PersistedAccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedRefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedTokenPair {
  accessTokenHash: string;
  accessToken: PersistedAccessTokenRecord;
  refreshTokenHash: string;
  refreshToken: PersistedRefreshTokenRecord;
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  return allowedHosts.includes(parsed.hostname);
}

// ── CIMD helpers ──────────────────────────────────────────────────

const CLIENT_METADATA_TIMEOUT_MS = 5_000;
const CLIENT_METADATA_MAX_BYTES = 64 * 1024;

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizedHost(hostname);
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

function hostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const host = normalizedHost(hostname);
  return allowedHosts.some((allowed) => normalizedHost(allowed) === host);
}

function clientMetadataUrl(clientId: string, allowedHosts: string[]): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(clientId);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "https:") {
    throw new InvalidRequestError("Client metadata document URL must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new InvalidRequestError("Client metadata document URL must not include credentials or fragment");
  }
  if (isLoopbackHost(parsed.hostname)) {
    throw new InvalidRequestError("Client metadata document URL host must not be loopback");
  }
  if (!hostAllowed(parsed.hostname, allowedHosts)) {
    throw new InvalidRequestError("Client metadata document URL host is not allowed");
  }

  return parsed;
}

async function readLimitedResponse(response: globalThis.Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new InvalidRequestError("Client metadata document is too large");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new InvalidRequestError("Client metadata document is too large");
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

async function fetchClientMetadata(url: URL): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLIENT_METADATA_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new InvalidRequestError("Client metadata document fetch failed");
    }
    return JSON.parse(await readLimitedResponse(response, CLIENT_METADATA_MAX_BYTES));
  } catch (error) {
    if (error instanceof InvalidRequestError) throw error;
    throw new InvalidRequestError("Client metadata document is invalid");
  } finally {
    clearTimeout(timeout);
  }
}

function clientFromMetadata(
  clientId: string,
  metadata: unknown,
  allowedRedirectHosts: string[],
  supportedScopes: string[],
): OAuthClientInformationFull {
  const parsed = OAuthClientMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    throw new InvalidRequestError("Client metadata document failed validation");
  }

  const client = parsed.data;
  if (!client.redirect_uris.every((uri) => redirectHostAllowed(uri, allowedRedirectHosts))) {
    throw new InvalidRequestError("Client metadata redirect_uri is not allowed");
  }
  if (client.token_endpoint_auth_method && client.token_endpoint_auth_method !== "none") {
    throw new InvalidRequestError("Client metadata token_endpoint_auth_method must be none");
  }
  if (client.grant_types && !client.grant_types.includes("authorization_code")) {
    throw new InvalidRequestError("Client metadata grant_types must include authorization_code");
  }
  if (client.response_types && !client.response_types.includes("code")) {
    throw new InvalidRequestError("Client metadata response_types must include code");
  }
  if (client.scope) {
    const requestedScopes = client.scope.split(" ").filter(Boolean);
    if (!requestedScopes.every((s) => supportedScopes.includes(s))) {
      throw new InvalidRequestError("Client metadata scope is not supported");
    }
  }

  return {
    ...client,
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: "none",
    grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
    response_types: client.response_types ?? ["code"],
  };
}

export class SqliteOAuthStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.deleteExpiredTokens(Math.floor(Date.now() / 1000));
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.database.sqlite
      .prepare("select client_json from oauth_clients where client_id = ?")
      .get(clientId) as { client_json: string } | undefined;

    return row ? (JSON.parse(row.client_json) as OAuthClientInformationFull) : undefined;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    allowedRedirectHosts: string[],
  ): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), allowedRedirectHosts))) {
      throw new InvalidRequestError("Client redirect_uri is not allowed for this DevSpace server");
    }

    const now = Math.floor(Date.now() / 1000);

    // CIMD: if the client provides a client_id URL, validate and use it
    // DCR:  if no client_id is provided, generate a server-minted one
    const providedClientId = (client as Record<string, unknown>).client_id as string | undefined;
    let clientId: string;

    if (providedClientId) {
      const url = clientMetadataUrl(providedClientId, allowedRedirectHosts);
      if (!url) {
        throw new InvalidRequestError(
          "Invalid client_id URL for CIMD registration — must be an HTTPS URL on an allowed host",
        );
      }
      clientId = providedClientId;
    } else {
      clientId = `devspace-${randomUUID()}`;
    }

    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
    };

    this.database.sqlite
      .prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)")
      .run(registered.client_id, JSON.stringify(registered), now);

    return registered;
  }

  /** Add a redirect URI to an existing client, or auto-register if missing. */
  addRedirectUri(clientId: string, redirectUri: string): boolean {
    const client = this.getClient(clientId);
    if (!client) {
      const now = Math.floor(Date.now() / 1000);
      const newClient: OAuthClientInformationFull = {
        client_id: clientId,
        client_name: clientId,
        redirect_uris: [redirectUri],
        client_id_issued_at: now,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
      this.database.sqlite
        .prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)")
        .run(clientId, JSON.stringify(newClient), now);
      return true;
    }
    if (client.redirect_uris.includes(redirectUri)) return true;

    client.redirect_uris.push(redirectUri);
    this.database.sqlite
      .prepare("update oauth_clients set client_json = ? where client_id = ?")
      .run(JSON.stringify(client), clientId);
    return true;
  }

  saveAccessToken(tokenHash: string, record: PersistedAccessTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
      );
  }

  getAccessToken(tokenHash: string): PersistedAccessTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_access_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToAccessTokenRecord(row) : undefined;
  }

  deleteAccessToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where token_hash = ?").run(tokenHash);
  }

  saveRefreshToken(tokenHash: string, record: PersistedRefreshTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_refresh_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
      );
  }

  saveTokenPair(pair: PersistedTokenPair, consumedRefreshTokenHash?: string): boolean {
    const save = this.database.sqlite.transaction(() => {
      if (consumedRefreshTokenHash) {
        const result = this.database.sqlite
          .prepare("delete from oauth_refresh_tokens where token_hash = ?")
          .run(consumedRefreshTokenHash);
        if (result.changes !== 1) return false;
      }

      this.saveAccessToken(pair.accessTokenHash, pair.accessToken);
      this.saveRefreshToken(pair.refreshTokenHash, pair.refreshToken);
      return true;
    });

    return save.immediate();
  }

  getRefreshToken(tokenHash: string): PersistedRefreshTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_refresh_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToRefreshTokenRecord(row) : undefined;
  }

  deleteRefreshToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where token_hash = ?").run(tokenHash);
  }

  close(): void {
    this.database.close();
  }

  private deleteExpiredTokens(nowSeconds: number): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where expires_at < ?").run(nowSeconds);
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where expires_at < ?").run(nowSeconds);
  }
}

export class SqliteOAuthClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly store: SqliteOAuthStore,
    private readonly allowedRedirectHosts: string[],
    private readonly supportedScopes: string[] = [],
  ) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const registered = this.store.getClient(clientId);
    if (registered) return registered;

    // CIMD: fetch metadata from the client_id URL
    const url = clientMetadataUrl(clientId, this.allowedRedirectHosts);
    if (!url) return undefined;

    const client = clientFromMetadata(
      clientId,
      await fetchClientMetadata(url),
      this.allowedRedirectHosts,
      this.supportedScopes,
    );
    // Cache in the store for subsequent lookups
    try {
      this.store.registerClient(client, this.allowedRedirectHosts);
    } catch {
      // Already exists or constraint violation — safe to ignore
    }
    return client;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    return this.store.registerClient(client, this.allowedRedirectHosts);
  }

  addRedirectUri(clientId: string, redirectUri: string): boolean {
    return this.store.addRedirectUri(clientId, redirectUri);
  }
}

function rowToAccessTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedAccessTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

function rowToRefreshTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedRefreshTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}
