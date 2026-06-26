import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
