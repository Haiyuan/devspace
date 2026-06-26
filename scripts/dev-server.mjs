import { spawn } from "node:child_process";
import { readdirSync, statSync, watch } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const watchRoots = ["src"].map((entry) => join(repoRoot, entry));
const restartDelayMs = 750;
const crashDelayMs = 1500;
const gracefulShutdownMs = 3000;

let child;
let restartTimer;
let stoppingForRestart = false;
let shuttingDown = false;
let restartGeneration = 0;
let pendingRestartCause;

function log(message) {
  console.error(`[devspace:dev] ${message}`);
}

function displayPath(path) {
  return relative(repoRoot, path) || ".";
}

function shouldIgnoreWatchPath(path) {
  const name = basename(path);
  return (
    name === ".DS_Store" ||
    name === "4913" ||
    name.endsWith("~") ||
    name.endsWith(".swp") ||
    name.endsWith(".swo") ||
    name.endsWith(".tmp") ||
    name.endsWith(".temp") ||
    name.endsWith(".lock") ||
    name.startsWith(".#") ||
    name.startsWith(".~")
  );
}

function start() {
  stoppingForRestart = false;
  const generation = restartGeneration;
  log(`starting server generation ${generation}`);
  child = spawn("npx", ["tsx", "src/cli.ts", "serve"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    child = undefined;
    if (shuttingDown) return;
    if (stoppingForRestart) return;

    pendingRestartCause = {
      type: "crash",
      detail: `server exited unexpectedly (${signal ?? code ?? "unknown"})`,
    };
    log(`${pendingRestartCause.detail}; scheduling crash restart generation ${restartGeneration + 1} in ${crashDelayMs}ms`);
    scheduleRestart(crashDelayMs, pendingRestartCause);
  });
}

function scheduleRestart(delayMs = restartDelayMs, cause = { type: "manual", detail: "manual restart" }) {
  clearTimeout(restartTimer);
  pendingRestartCause = cause;
  const nextGeneration = restartGeneration + 1;
  log(`scheduled ${cause.type} restart generation ${nextGeneration} in ${delayMs}ms: ${cause.detail}`);
  restartTimer = setTimeout(restart, delayMs);
}

function restart() {
  if (shuttingDown) return;
  clearTimeout(restartTimer);
  restartGeneration += 1;
  const generation = restartGeneration;
  const cause = pendingRestartCause ?? { type: "manual", detail: "manual restart" };
  pendingRestartCause = undefined;
  log(`restarting server generation ${generation} after ${cause.type}: ${cause.detail}`);

  if (!child) {
    start();
    return;
  }

  stoppingForRestart = true;
  child.once("exit", () => {
    if (!shuttingDown) start();
  });
  log(`sending SIGTERM to server generation ${generation - 1} for graceful restart`);
  child.kill("SIGTERM");

  setTimeout(() => {
    if (child && stoppingForRestart) {
      log(`SIGTERM timeout; sending SIGKILL to server generation ${generation - 1}`);
      child.kill("SIGKILL");
    }
  }, gracefulShutdownMs).unref();
}

function watchDirectory(root) {
  const watchers = [];
  const seen = new Set();

  function addDirectory(dir) {
    if (seen.has(dir)) return;
    seen.add(dir);

    const watcher = watch(dir, (event, filename) => {
      if (!filename) {
        scheduleRestart(restartDelayMs, {
          type: "source-change",
          detail: `${displayPath(dir)} changed (${event}; filename unavailable)`,
        });
        return;
      }

      const path = join(dir, filename.toString());
      if (shouldIgnoreWatchPath(path)) {
        log(`ignored temporary editor file change: ${displayPath(path)} (${event})`);
        return;
      }

      if (event === "rename") maybeAddDirectory(path);
      scheduleRestart(restartDelayMs, {
        type: "source-change",
        detail: `${displayPath(path)} changed (${event})`,
      });
    });
    watchers.push(watcher);

    for (const entry of readdirSync(dir)) {
      maybeAddDirectory(join(dir, entry));
    }
  }

  function maybeAddDirectory(path) {
    try {
      const stats = statSync(path);
      if (stats.isDirectory()) addDirectory(path);
    } catch {
      // The file may have been deleted between the watch event and stat call.
    }
  }

  addDirectory(root);
  return watchers;
}

function shutdown(signal = "unknown") {
  shuttingDown = true;
  clearTimeout(restartTimer);
  log(`received ${signal}; starting graceful shutdown`);
  if (!child) return process.exit(0);

  child.once("exit", () => process.exit(0));
  child.kill("SIGTERM");
  setTimeout(() => {
    log("graceful shutdown timed out; exiting with failure");
    process.exit(1);
  }, gracefulShutdownMs).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

for (const root of watchRoots) {
  watchDirectory(root);
}

log("watching src; server restarts on source changes and after crashes");
start();
