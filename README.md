# openharness

An [OpenCode](https://github.com/anomalyco/opencode) fork that adds **Harness2-style self-improving harness recursion** for coding.

The model weights stay fixed. The harness around the model — system prompt, guardrails, memory, tool guidance, skills, subagents, scripts, plugins — can improve in-session against a real coding task.

Repository: [github.com/birchamp/openharness](https://github.com/birchamp/openharness)

## How it differs

| | openharness | Upstream OpenCode | Google Harness2 |
| --- | --- | --- | --- |
| Product | OpenCode fork with in-app recursion | AI coding agent | Research / benchmark harness search |
| Where search runs | Inside a coding session via the `harness` tool | No propose–probe–compose loop | External Python pipelines over benchmarks |
| What improves | User-level and project harness layers | Config you edit by hand | Experiment artifacts outside the app |
| Adoption | Writes live harness + library; final rollout on your tree | N/A | Not an interactive coding product |

openharness keeps OpenCode’s session, worktree, and permission model. Harness recursion is the addition: Propose → Probe → Compose, scheduled as child sessions.

## Build from source

This fork is meant to be built and run from this monorepo with Bun. That is the primary path — not the upstream `opencode.ai` install script or published npm packages.

Requires **Bun 1.3+** (repo pin: Bun 1.4.x).

```bash
git clone https://github.com/birchamp/openharness.git
cd openharness
bun install
bun dev [directory]
```

`bun dev` runs the V2 CLI and TUI (`packages/cli`). Pass a project directory, or `.` to open this repository.

To attach a development TUI to an already-running OpenCode V2 background service and live sessions:

```bash
bun run dev:live [directory]
```

Other root scripts (web, desktop, docs site) exist for OpenCode packaging work; openharness itself is exercised from source via `bun dev` / `bun run dev:live`.

## Start a session

1. Open a **git** project (`bun dev /path/to/project`).
2. Work in a normal coding session as you would in OpenCode.
3. When you want the harness improved for a concrete task, ask the agent to refine it (see below).

## Refine the harness

Ask for refinement against a specific coding task, for example:

> Refine the harness for adding rate limiting to the login handler.

That invokes the `harness` tool. **Approve the permission** when prompted. The permission metadata includes mode, `k`, planned session count, and a short budget summary — default sequential `k=1` already runs several full coding sessions; higher `k` multiplies them.

### Default: sequential `k=1`

One round:

1. **Reference** — one rollout of the current harness on the task  
2. **Propose** — one invariant proposal and one domain proposal  
3. **Probe** — a rollout of each proposal  
4. **Compose** — one composition into a candidate harness  

Then, if a composition is adopted, a **final rollout** runs on your working tree. Until then, every stage uses its own session in a **separate git worktree**. Progress shows up as synthetic messages in the parent session. Your tree is updated only after adoption, via that final rollout.

### Sequential vs parallel / `k`

- **`mode`**: `"sequential"` (default) or `"parallel"`.
- **`k`**: integer ≥ 1 (default `1`).
  - **Sequential**: repeats the full k=1 round `k` times, carrying a refined harness between rounds when a round succeeds.
  - **Parallel**: one round with `k` reference rollouts, `k` invariant proposals, `k` domain proposals, a probe of each, and `k` compositions; the last valid composition can be adopted.

Invalid proposals/compositions get one retry; a second failure keeps the current harness for that stage.

### Cost and permissions

Harness refinement is expensive: each stage is a real session that can write and review code inside a worktree. Prefer the default (`sequential`, `k=1`) until you know you need a wider search. Deny the permission if you did not intend a multi-session run.

## User-level vs project harness

| Layer | Location | What lands there |
| --- | --- | --- |
| **User** | under your OpenCode config directory, `harness/` | **Invariant** lessons (subject `harness`) — carried into later projects |
| **Project** | `<project>/.opencode/harness/` | **Domain** lessons for this repository |

Live trees sit under each root’s `live/`; adopted experiences are also recorded in that layer’s `library/`. A proposer in any project sees the user library; in this project it also sees the project library.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for Bun workflow, package layout, checks, and PR conventions. Base branches on `dev`. Style and architecture notes live in [AGENTS.md](./AGENTS.md).

This repository does not use Changesets.

## Upstream

openharness is a fork of [anomalyco/opencode](https://github.com/anomalyco/opencode). Upstream docs, Discord, and installers describe OpenCode, not this fork’s harness recursion. Prefer this repository and the commands above when working on openharness.
