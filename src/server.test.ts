import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createReadinessReport } from "./server.js";

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
