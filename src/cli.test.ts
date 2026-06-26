import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
