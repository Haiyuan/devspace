import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { InMemoryOAuthClientsStore } from "./oauth-provider.js";
import { createServer } from "./server.js";

const originalFetch = globalThis.fetch;

async function withFetch(metadata: unknown, fn: () => Promise<void>): Promise<void> {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(metadata), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "devspace-oauth-test-config-")),
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.com",
  DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com",
  DEVSPACE_STATE_DIR: mkdtempSync(join(tmpdir(), "devspace-oauth-test-state-")),
});

const running = createServer(config);
const httpServer = await new Promise<Server>((resolve) => {
  const server = running.app.listen(0, "127.0.0.1", () => resolve(server));
});
const port = (httpServer.address() as AddressInfo).port;
const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
const metadata = await response.json();
assert.equal(response.headers.get("cache-control"), "no-store");
assert.equal(metadata.client_id_metadata_document_supported, true);
assert.equal(metadata.registration_endpoint, "https://devspace.example.com/register");
await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));

await withFetch(
  {
    redirect_uris: ["https://chatgpt.com/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    scope: "devspace",
  },
  async () => {
    const store = new InMemoryOAuthClientsStore(["chatgpt.com"], ["devspace"]);
    const client = await store.getClient("https://chatgpt.com/client-metadata.json");
    assert.equal(client?.client_id, "https://chatgpt.com/client-metadata.json");
    assert.equal(client?.token_endpoint_auth_method, "none");
    assert.equal(await store.getClient("https://chatgpt.com/client-metadata.json"), client);
  },
);

const store = new InMemoryOAuthClientsStore(["chatgpt.com"], ["devspace"]);
await assert.rejects(() => store.getClient("http://chatgpt.com/client.json"), /HTTPS/);

await withFetch(
  { redirect_uris: ["https://example.com/callback"] },
  async () => {
    await assert.rejects(
      () => new InMemoryOAuthClientsStore(["chatgpt.com"], ["devspace"]).getClient("https://chatgpt.com/bad-redirect.json"),
      /redirect_uri/,
    );
  },
);

await withFetch(
  { redirect_uris: ["https://chatgpt.com/callback"], scope: "admin" },
  async () => {
    await assert.rejects(
      () => new InMemoryOAuthClientsStore(["chatgpt.com"], ["devspace"]).getClient("https://chatgpt.com/bad-scope.json"),
      /scope/,
    );
  },
);
