# Documentation Map

Use this map to choose the first document to read before a DevSpace task.

## README.md

Purpose: public overview, installation, MCP client connection, platform support,
and local development commands.

Read this first when you need to install DevSpace, understand the basic mental
model, connect an MCP client, or find the top-level documentation index.

## AGENTS.md

Purpose: repository-local instructions for AI agents working inside this project.
It explains the workspace-based model, `open_workspace` reuse, instruction-file
loading, and core safety constraints.

Read this first when an AI agent opens this repository or before making any code
or documentation change through DevSpace.

## docs/operations.md

Purpose: maintainer runbook for startup, health checks, doctor output, tool and
session recovery, edit safety, verification, state-store maintenance, and common
OAuth/tunnel symptoms.

Read this first when DevSpace is running incorrectly, a connector fails, a
session expires, a tunnel/proxy issue is suspected, or a maintainer needs the
standard verification commands.

## docs/devspace_resource_refresh_solution.md

Purpose: focused explanation of stale direct tool recipients versus expired MCP
sessions, including the correct recovery path for each case.

Read this first when a host loses a previously working DevSpace tool, the MCP
connection has gone stale, or an old workspace identifier is no longer accepted.

## docs/agent_efficiency.md

Purpose: concise operational workflow for AI agents using DevSpace safely and
quickly. It covers tool choice, recovery, dirty worktrees, Guardgit gates, and
verification.

Read this first when an AI agent needs to perform a repo task through DevSpace
with minimal wasted tool calls and safe edit boundaries.

## docs/task_prompts.md

Purpose: reusable prompt templates for common DevSpace work: repo inspection,
small code changes, documentation updates, commit-message drafting, regression
tests, verification, connector/OAuth/DCR diagnosis, and DevSpace self-improvement.

Read this first when preparing a new task prompt for ChatGPT or another
MCP-capable coding agent.
