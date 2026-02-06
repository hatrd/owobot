# Environment Observation: Algorithm Essence & Integration Plan

This document turns the environment-observation discussion into an actionable plan for this repo.

Scope:

- Explain the core ideas behind proven exploration/mapping methods.
- Define how to integrate them into `observe_detail` with minimal AI context.
- Define dry-only verification checkpoints for AI-driven iteration.

## Design Targets (Project-Aligned)

- First output is always **structured evidence**, not prose guess.
- Keep observation modules read-only and composable.
- Separate layers: sensing -> map state -> geometry/topology -> classification.
- Make every conclusion replayable from state snapshots.

## Algorithm Essence (What Actually Matters)

### 1) Frontier-Based Exploration (Yamauchi)

Essence:

- Exploration is an **information gain** problem.
- The best next viewpoint lies on boundaries between known-free and unknown cells (frontiers).

Why it matters here:

- Gives a principled way to decide where the bot still needs evidence.
- Prevents random probing and context bloat.

### 2) WFD (Wavefront Frontier Detector)

Essence:

- Detect frontier efficiently by wavefront expansion from reachable free space.
- Avoid full-map scans when only local reachable area matters.

Why it matters here:

- Keeps nearby-space observation fast enough for repeated dry verification.
- Reduces compute while preserving frontier quality.

### 3) Occupancy Grid + Bayesian Update

Essence:

- World state is probabilistic, not hard binary.
- Fuse repeated observations per cell (e.g. log-odds) to fight sensor/line-of-sight noise.

Why it matters here:

- Stable enclosure/room judgment needs confidence accumulation.
- Enables diagnostic output (`unknown_ratio`, `occupied_confidence`, `free_confidence`).

### 4) OctoMap-Style Multi-Resolution 3D Map

Essence:

- Represent sparse 3D space with adaptive resolution (octree).
- Preserve unknown space explicitly while controlling memory.

Why it matters here:

- Minecraft environment is vertically rich (ceilings, hanging signs, stacked spaces).
- Better than flattening to 2D too early.

### 5) Topological / Semantic Segmentation

Essence:

- Convert cell-level geometry into human-usable regions: room/corridor/open area/doorway.
- Use structural evidence (closure, opening count, rectangularity, ceiling continuity), not just nearest blocks.

Why it matters here:

- Needed for robust statements like “inside a square room”.
- Produces low-context, high-value summaries for LLM calls.

## Integration Architecture (for `bot_impl/agent/observer.js`)

Implement as a staged read-only pipeline behind `observe_detail`.

### Stage A: Local Sampling (read-only)

Input:

- Bot pose + nearby blocks/entities from mineflayer runtime.

Output (raw evidence):

- 3D occupancy samples around bot (`occupied/free/unknown`, confidence).
- Optional category tags for key blocks (wall-like, transparent, door-like).

### Stage B: Local Map State

Responsibilities:

- Build bounded local occupancy structure (start with 2.5D grid; evolve to octree-like cache).
- Fuse repeated samples (Bayesian/log-odds style).

Output:

- `map_state` snapshot with confidence stats and frontier candidates.

### Stage C: Geometry / Topology Features

Responsibilities:

- Reachable free-space flood fill from bot.
- Boundary extraction from reachable component.
- Feature calculation:
  - enclosure ratio
  - opening count / doorway candidates
  - rectangularity fit score
  - ceiling coverage ratio
  - dominant wall orientations

Output:

- `features` object with numeric evidence.

### Stage D: Environment Classification

Responsibilities:

- Classify into controlled labels:
  - `room_enclosed`
  - `corridor_like`
  - `semi_enclosed`
  - `open_outdoor`
- Produce confidence + reasons + uncertainty notes.

Output:

- `environment` object suitable for direct LLM/tool consumption.

## API Plan (`observe_detail`)

### Planned `what` Targets

- `what=space_snapshot`:
  - returns map evidence + features, no strong semantic claim.
- `what=environment`:
  - returns classification + confidence + compact explanation.
- `what=room_probe`:
  - strict “room-like?” decision with rectangularity evidence.

### Response Contract (example fields)

- `classification`: enum above.
- `confidence`: `0..1`.
- `evidence`:
  - `enclosure_ratio`
  - `opening_count`
  - `rectangularity_score`
  - `ceiling_coverage`
  - `unknown_ratio`
- `anchors`: nearest boundary points and doorway candidates.
- `notes`: uncertainty/failure reasons.

## Rollout Plan (Incremental)

### Milestone 1: Stable Local Features

- Replace nearest-ray-only heuristics with reachable-component + boundary features.
- Keep output diagnostic-first.

Done when:

- Same location repeated dry calls produce stable classification/confidence (low variance).

### Milestone 2: Frontier-Aware Evidence Completion

- Add local frontier detection and “missing evidence directions”.
- Return explicit `next_observation_hints` (read-only suggestion, no movement execution).

Done when:

- Classification flips can be explained by reduced unknown/frontier evidence.

### Milestone 3: 3D/Vertical Robustness

- Add multi-layer vertical occupancy evidence (ceiling/floor continuity).
- Improve handling of hanging blocks, stairs, uneven roofs.

Done when:

- Indoor/outdoor confusion drops in mixed-height builds.

### Milestone 4: Semantic Regionization

- Add region graph (`room`, `corridor`, `opening` nodes + connectivity).
- Expose compact topology summary for planning modules.

Done when:

- Bot can explain location context with structure-level evidence rather than raw block lists.

## Dry Verification Protocol (AI-Only)

AI must verify by dry path only:

1. `npm run interaction:dry`
2. targeted checks:

```bash
node scripts/botctl.js dry observe_detail what=space_snapshot radius=12
node scripts/botctl.js dry observe_detail what=environment radius=16
node scripts/botctl.js dry observe_detail what=room_probe radius=16
```

Verification expectations:

- Output contains machine-readable evidence fields.
- Failure contains diagnostics (`notes`, error details), not opaque “failed”.
- Repeated dry calls in same static scene are stable.

## References

- Frontier exploration: Yamauchi, 1997 (DOI: 10.1109/CIRA.1997.613851)
- WFD frontier detection: Keidar & Kaminka, 2018 (arXiv:1806.03581)
- OctoMap: Hornung et al., 2013 (DOI: 10.1007/s10514-012-9321-0)
- Semantic indoor mapping from occupancy grids (DOI: 10.1016/j.robot.2012.10.004)
- Survey on semantic mapping (DOI: 10.1016/j.robot.2014.12.006)
