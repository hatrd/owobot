# Mineflayer Bot Helper

This repository is a hot-reloadable Mineflayer bot project with an AI chat/control layer.

## Quick Start

- Install dependencies: `npm install`
- Run bot: `npm start`
- Dev mode (restart on `bot.js` changes): `npm run dev`

## Runtime Principles

- Runtime behavior changes should be validated through the interaction contract first.
- Hot reload is gate-controlled by `open_fire` in default workflow.
- AI-side verification is dry-run only; real in-world execution is manual.

## Documentation Index

- Interaction contract (first-class): `docs/interaction.md`
- Interaction schema snapshot (generated): `docs/interaction.generated.md`
- Hot reload manual: `docs/hot-reload.md`
- Runtime shared-state map: `docs/runtime-map.md`
- Actions contract (tool register/dry/run): `docs/actions-contract.md`
- Observer contract (snapshot/prompt/detail): `docs/observer-contract.md`
- AI chat pipeline: `docs/ai-chat.md`
- Context bus design: `docs/context-bus.md`
- Environment observation roadmap: `docs/environment-observation.md`
- Parallel worktree workflow: `docs/git-worktree-parallel.md`

## Archive / Pitfalls

- Deprecated Minimal Self implementation and notes: `trash/minimal-self/README.md`
