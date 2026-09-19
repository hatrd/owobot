# Mineflayer Bot Helper

This repository is a hot-reloadable Mineflayer bot project with an AI chat/control layer.

## Quick Start

- Install dependencies: `npm install`
- Run bot: `npm start`
- Dev mode (restart on `bot.js` changes): `npm run dev`

## Runtime Principles

- Runtime behavior changes should be validated through the interaction contract first.
- Hot reload is gate-controlled by `open_fire` in default workflow.
- AI has standing authorization to operate this project, including real in-world execution. Verify through dry checks first, then confirm actual outcomes through structured state.

## Documentation Index

- Operations runbook for AI agents: `AGENT_OPS.md`
- Interaction contract (first-class): `docs/interaction.md`
- Interaction schema snapshot (generated): `docs/interaction.generated.md`
- Hot reload manual: `docs/hot-reload.md`
- Memory/GC/event-loop diagnostics: `docs/runtime-diagnostics.md`
- External LLM control and hot-loaded behaviors: `docs/external-controller.md`
- Runtime shared-state map: `docs/runtime-map.md`
- Actions contract (tool register/dry/run): `docs/actions-contract.md`
- Observer contract (snapshot/prompt/detail): `docs/observer-contract.md`
- AI chat pipeline: `docs/ai-chat.md`
- Agent workflow skill notes: `docs/agent-skills.md`
- Context bus design: `docs/context-bus.md`
- Environment observation roadmap: `docs/environment-observation.md`
- Parallel worktree workflow: `docs/git-worktree-parallel.md`

## Archive / Pitfalls

- Deprecated Minimal Self implementation and notes: `trash/minimal-self/README.md`

### External model controller

Versioned JSON behaviors can now be installed without code reload. Read status with `node scripts/controller-client.js status`; validate the example with `node scripts/run-behavior.js examples/behaviors/neighborhood-tour.json --dry`. Includes leased task control and on-demand voxel images. See [controller protocol and limitations](docs/external-controller.md).

Persistent exploration memory and bounded resumable walks: see [exploration memory](docs/exploration-memory.md). Preview with `node scripts/explore-survival.js --dry`; `--resume <missionId>` continues a saved mission.

### Autonomous life

Optional persistent daytime wandering, night return to a configured home, and cooldown-based cat feeding. Read `node scripts/botctl.js dry observe_detail what=life`; AI may enable it after dry checks under the standing project authorization. See [autonomous life](docs/autonomous-life.md).

External agent survival primitives and durable world/player evidence: [Cerebellum guide](docs/cerebellum.md). Run one leased action with a terminal receipt using `node scripts/cerebellum.js <action> '<json>'`; use `--dry` to validate first.
