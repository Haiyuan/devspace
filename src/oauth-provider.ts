import { timingSafeEqual, randomBytes, randomUUID, createHash } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { AccessDeniedError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  OAuthClientMetadataSchema,
  type OAuthClientInformationFull,
  type OAuthTokenRevocationRequest,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";

const CODE_TTL_MS = 5 * 60 * 1000;
const CLIENT_METADATA_TIMEOUT_MS = 5_000;
const CLIENT_METADATA_MAX_BYTES = 64 * 1024;

export interface OAuthConfig {
  ownerToken: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

interface AccessTokenRecord {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

interface RefreshTokenRecord {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formHtml(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
}): string {
  const scopeText = params.scopes.length > 0 ? params.scopes.join(" ") : "devspace";
  const resourceText = params.resource?.href ?? "DevSpace MCP endpoint";
  const error = params.error
    ? `<p class="error">${htmlEscape(params.error)}</p>`
    : "";
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `        <input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect DevSpace</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      main { max-width: 440px; margin: 12vh auto; padding: 32px; background: #111827; border: 1px solid #334155; border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { line-height: 1.5; color: #cbd5e1; }
      dl { padding: 16px; background: #020617; border-radius: 12px; }
      dt { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
      dd { margin: 4px 0 12px; word-break: break-word; }
      label { display: block; margin: 18px 0 8px; font-weight: 600; }
      input { box-sizing: border-box; width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #475569; background: #020617; color: #e2e8f0; font-size: 16px; }
      button { margin-top: 18px; width: 100%; border: 0; border-radius: 10px; padding: 12px 14px; font-weight: 700; color: #020617; background: #38bdf8; cursor: pointer; }
      .error { color: #fecaca; background: #7f1d1d; border-radius: 10px; padding: 10px 12px; }
      .warning { color: #fde68a; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect DevSpace</h1>
      <p class="warning">Only approve this if you are intentionally connecting your own ChatGPT or MCP client to this local machine.</p>
      ${error}
      <dl>
        <dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd>
        <dt>Scope</dt><dd>${htmlEscape(scopeText)}</dd>
        <dt>Resource</dt><dd>${htmlEscape(resourceText)}</dd>
      </dl>
      <form method="post">
${hiddenFields}
        <label for="owner_token">Owner password</label>
        <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Authorize DevSpace</button>
      </form>
    </main>
  </body>
</html>`;
}

function requestedScopesAllowed(requested: string[], supported: string[]): boolean {
  return requested.every((scope) => supported.includes(scope));
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
    if (!requestedScopesAllowed(requestedScopes, supportedScopes)) {
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

export class InMemoryOAuthClientsStore implements OAuthRegisteredClientsStore {
  protected readonly clients = new Map<string, OAuthClientInformationFull>();

  constructor(
    private readonly allowedRedirectHosts: string[],
    private readonly supportedScopes: string[],
  ) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const registered = this.clients.get(clientId);
    if (registered) return registered;

    const url = clientMetadataUrl(clientId, this.allowedRedirectHosts);
    if (!url) return undefined;

    const client = clientFromMetadata(
      clientId,
      await fetchClientMetadata(url),
      this.allowedRedirectHosts,
      this.supportedScopes,
    );
    this.clients.set(clientId, client);
    return client;
  }

  /**
   * Auto-add a redirect URI to an already-registered client.
   *
   * ChatGPT generates unique per-connector redirect URIs like
   * https://chatgpt.com/connector/oauth/<random-id> that can't be
   * predicted at registration time. This method allows the authorize
   * middleware to inject the URI on first use so the SDK's exact-match
   * check passes.
   */
  addRedirectUri(clientId: string, redirectUri: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (!client.redirect_uris.includes(redirectUri)) {
      client.redirect_uris.push(redirectUri);
    }
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(uri, this.allowedRedirectHosts))) {
      throw new InvalidRequestError("Client redirect_uri is not allowed for this DevSpace server");
    }

    // Validate requested scopes against supported scopes
    const requestedScopes = (client as Record<string, unknown>).scope
      ? String((client as Record<string, unknown>).scope).split(" ").filter(Boolean)
      : [];
    if (!requestedScopesAllowed(requestedScopes, this.supportedScopes)) {
      throw new InvalidRequestError("Requested scope is not supported");
    }

    const now = Math.floor(Date.now() / 1000);

    // CIMD: if the client provides a client_id URL, validate and use it
    // DCR:  if no client_id is provided, generate a server-minted one
    const providedClientId = (client as Record<string, unknown>).client_id as string | undefined;
    let clientId: string;

    if (providedClientId) {
      // CIMD flow — client_id must be a valid HTTPS metadata document URL
      const url = clientMetadataUrl(providedClientId, this.allowedRedirectHosts);
      if (!url) {
        throw new InvalidRequestError(
          "Invalid client_id URL for CIMD registration — must be an HTTPS URL on an allowed host",
        );
      }
      clientId = providedClientId;
    } else {
      // DCR flow — generate a server-minted client_id
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
    this.clients.set(registered.client_id, registered);
    return registered;
  }
}

const OAUTH_CLIENTS_DDL = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  data      TEXT NOT NULL
)`;

/**
 * SQLite-backed OAuth client store that survives server restarts.
 *
 * Extends {@link InMemoryOAuthClientsStore} by persisting every registered
 * client (and any dynamically-added redirect URIs) to the DevSpace SQLite
 * database so ChatGPT connectors stay valid across restarts.
 */
export class PersistentOAuthClientsStore extends InMemoryOAuthClientsStore {
  private readonly db: Database.Database;
  private readonly saveStmt: Database.Statement;

  constructor(
    stateDir: string,
    allowedRedirectHosts: string[],
    supportedScopes: string[],
  ) {
    super(allowedRedirectHosts, supportedScopes);

    const dbPath = join(stateDir, "devspace.sqlite");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(OAUTH_CLIENTS_DDL);

    this.saveStmt = this.db.prepare(
      "INSERT OR REPLACE INTO oauth_clients (client_id, data) VALUES (?, ?)",
    );

    // Restore clients from previous runs
    const rows = this.db
      .prepare("SELECT client_id, data FROM oauth_clients")
      .all() as Array<{ client_id: string; data: string }>;
    for (const row of rows) {
      try {
        const client = JSON.parse(row.data) as OAuthClientInformationFull;
        this.clients.set(row.client_id, client);
      } catch {
        // corrupt row — skip
      }
    }
  }

  override registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const registered = super.registerClient(client);
    this.persist(registered.client_id, registered);
    return registered;
  }

  override addRedirectUri(clientId: string, redirectUri: string): void {
    super.addRedirectUri(clientId, redirectUri);
    const client = this.clients.get(clientId);
    if (client) this.persist(clientId, client);
  }

  private persist(clientId: string, client: OAuthClientInformationFull): void {
    try {
      this.saveStmt.run(clientId, JSON.stringify(client));
    } catch {
      // best-effort — never let a DB write break the OAuth flow
    }
  }
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  /**
   * When true the SDK's token handler skips its built-in PKCE validation
   * so we can accept clients (e.g. ChatGPT) that don't send PKCE params.
   */
  readonly skipLocalPkceValidation = true;

  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  private readonly resourceServerUrl: URL;

  constructor(
    private readonly config: OAuthConfig,
    resourceServerUrl: URL,
    stateDir?: string,
  ) {
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.clientsStore = stateDir
      ? new PersistentOAuthClientsStore(stateDir, config.allowedRedirectHosts, config.scopes)
      : new InMemoryOAuthClientsStore(config.allowedRedirectHosts, config.scopes);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (!params.resource || !checkResourceAllowed({ requestedResource: params.resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidRequestError("Invalid or missing OAuth resource");
    }
    if (!requestedScopesAllowed(params.scopes ?? [], this.config.scopes)) {
      throw new InvalidRequestError("Requested scope is not supported");
    }

    if (res.req.method !== "POST") {
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const providedToken = String(res.req.body?.owner_token ?? "");
    if (!safeEquals(providedToken, this.config.ownerToken)) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: "The Owner password was not accepted.",
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      clientId: client.client_id,
      params,
      expiresAtMs: Date.now() + CODE_TTL_MS,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state);
    res.redirect(302, redirectUrl.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.validCodeRecord(client, authorizationCode);
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.validCodeRecord(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, record.params.scopes ?? this.config.scopes, record.params.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.refreshTokens.get(hashToken(refreshToken));
    if (!record || record.clientId !== client.client_id || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
      throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    }

    this.refreshTokens.delete(hashToken(refreshToken));
    return this.issueTokens(client.client_id, requestedScopes, resource ?? record.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.accessTokens.get(hashToken(token));
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hashed = hashToken(request.token);
    this.accessTokens.delete(hashed);
    this.refreshTokens.delete(hashed);
  }

  private validCodeRecord(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCodeRecord {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record;
  }

  private issueTokens(clientId: string, scopes: string[], resource?: URL): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds;

    this.accessTokens.set(hashToken(accessToken), {
      token: accessToken,
      clientId,
      scopes,
      expiresAt: accessExpiresAt,
      resource,
    });
    this.refreshTokens.set(hashToken(refreshToken), {
      token: refreshToken,
      clientId,
      scopes,
      expiresAt: refreshExpiresAt,
      resource,
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

function authorizationFormFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" "),
    state: params.state,
    resource: params.resource?.href,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
