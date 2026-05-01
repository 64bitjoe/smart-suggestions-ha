# Smart Suggestions — Pattern Mining Rewrite

**Date:** 2026-05-01
**Status:** Approved (design phase) — pending implementation plan

## Problem

The current Smart Suggestions system surfaces statistical co-occurrences as "suggestions" (e.g., "Turn off Wall Sconce — linked to Tall lamp & Tall lamp2 +55 more"). These are not actionable: they reflect that many things happen at the same time in a smart home, not that the user wants to change anything. The user is also paying meaningful Claude tokens to "rerank" this noise via `anthropic_analyzer.py`, with little perceived value.

Root cause: the LLM is being used as a *pattern detector* (expensive, weak signal in, noise out), and the statistical engine is doing naive co-occurrence without conditional probability or specificity filters. Roles are inverted.

## Goal

Surface a small number of *genuinely useful* observations across two zones:

1. **Suggestions** — automation candidates the user would want to create (temporal routines, sequences, cross-area triggers).
2. **Things I noticed** — waste / forgotten devices the user would want to know about (e.g., heater on with window open).

Pay LLM tokens only for the last mile (human description + automation YAML), not for pattern detection.

## Non-goals

- No full rewrite of the add-on or card from scratch — incremental changes to existing modules.
- No new ML models, embeddings, or training pipelines.
- No multi-user / multi-household support.
- No changes to the existing 6-card-types system in the HACS integration (only card content changes).

## Architecture

```
HA recorder DB (SQLite/MariaDB) ──┐
                                  ├──> Pattern Miners (scheduled, hourly)
HA WebSocket (live state) ────────┤        ├── Temporal miner   (A)
                                  │        ├── Sequence miner   (B)
                                  │        ├── Cross-area miner (F)
                                  │        └── Waste detector   (E) [uses live WS state]
                                  │
                                  ▼
                          Candidate Filter (4 criteria)
                                  │
                                  ▼
                          Claude (last-mile only)
                          ├── Human description
                          └── Automation YAML
                                  │
                                  ▼
                              Card (two zones)
                          ├── 🟢 Suggestions (A/B/F)
                          └── 🟡 Noticed     (E)
```

## Components

### 1. DB access layer (new)

- New module `smart_suggestions/src/db_reader.py` in the add-on.
- Detects HA recorder backend at startup:
  - Default: SQLite at `/config/home-assistant_v2.db` (mount `/config` into the add-on container).
  - If `recorder.db_url` in HA config indicates MariaDB/PostgreSQL, connect via SQLAlchemy using the same URL.
- Exposes typed query helpers (e.g., `get_state_changes(entity_id, since)`, `get_all_state_changes(since)`).
- All miners read through this module — never query the DB directly.

### 2. Pattern miners (new)

Four isolated modules under `smart_suggestions/src/miners/`. Each miner:
- Has a single `run()` entry point that returns a list of `Candidate` dataclasses.
- Reads only what it needs from `db_reader`.
- Is independently testable with synthetic state-change data.
- ≤ ~250 lines of Python each.

| Miner | Detects | Output candidate fields |
|---|---|---|
| **Temporal** (A) | Time-of-day routines | `entity, action, time_window, days, occurrences, conditional_prob` |
| **Sequence** (B) | "X then Y within Δt ≤ 60s" pairs | `entity_a, action_a, entity_b, action_b, lift, occurrences` |
| **Cross-area** (F) | Presence/arrival → entity action | `trigger_entity, target_entity, target_action, latency_seconds, occurrences, conditional_prob` |
| **Waste** (E) | Devices on too long given context | `entity, condition, duration, baseline_duration` |

Mining cadence: **hourly** for A/B/F, **every 5 minutes** for E (waste needs to be timely).

History window: **30 days** for A/B/F. E uses last 24h vs. 30d baseline.

### 3. Candidate filter

Drop a candidate that fails any of:
1. **Frequency:** ≥5 occurrences in last 30d.
2. **Specificity:** Conditional probability ≥ 70% (i.e., `P(action | trigger) ≥ 0.7`).
3. **Not already automated:** Read HA `/api/config/automation/config`; if any active automation already covers the trigger→action pair, drop.
4. **Not previously dismissed:** Maintain a per-pattern dismissal store; if user thumbs-down'd this same pattern within last 14d, drop.

### 4. LLM stage (drastically reduced)

- Delete `anthropic_analyzer.py` (LLM-as-pattern-detector).
- Delete `ollama_narrator.py` (reranker — no longer needed once candidates are pre-filtered).
- New `smart_suggestions/src/llm_describer.py`:
  - One Claude call per surviving candidate.
  - Input: structured candidate.
  - Output: `{title, description, automation_yaml}`.
  - Cache by candidate signature (e.g., `temporal:light.kitchen:on:weekday:06:45`) so repeated runs of the same pattern don't re-prompt. TTL: 7 days.
- Estimated token usage: **~95% reduction** vs. current.

### 5. Card UX (two zones)

Single card, two visually distinct zones:

- **🟢 Suggestions** (top section, A/B/F)
  - Title + 1-line description + confidence badge.
  - Primary button: **Create Automation** → creates an HA automation from the YAML (exact mechanism — REST automation config endpoint vs. writing to `automations.yaml` and reloading — to be picked during implementation; existing card already has a "Get Automation YAML" button to model on).
  - Secondary: 👍 / 👎 / dismiss.
  - Max 3 visible at a time.

- **🟡 Noticed** (bottom section, E)
  - Title + 1-line context (e.g., "Garage light on for 14h — usually 2h").
  - Primary button: **Turn off** (direct service call).
  - Secondary: dismiss / "ignore for 24h".
  - Max 5 visible at a time.

The 6 existing card types stay; this design changes the *content* feeding the cards, not the rendering layer.

### 6. Feedback loop

- 👎 on a candidate → store dismissal in a local SQLite DB inside the add-on (`/data/dismissals.db`). HA state attributes have size limits that don't scale to weeks of dismissals.
- Three 👎s on the same miner type within 7 days → raise that miner's conditional-probability threshold by 5 pp (capped at 90%).
- 👍 → no behavioral change yet (logged for future training; out of scope for v1).

## Data flow per cycle

1. Cron (hourly): each miner runs, produces candidates, writes to in-memory candidate pool.
2. Filter pass drops disqualified candidates.
3. For each survivor, check LLM cache; if miss, call Claude.
4. Write final suggestions to `smart_suggestions.suggestions` HA state (existing mechanism).
5. Card subscribes via WS as today.

## Defaults / assumptions (callable out)

- 30-day history window (A/B/F); 24h vs. 30d baseline (E).
- Hourly mining for A/B/F; 5-min for E.
- SQLite recorder at `/config/home-assistant_v2.db`; auto-detect MariaDB.
- Conditional probability threshold: 70%.
- Min occurrences: 5 in 30d.
- Existing 6-card-types layout preserved.

## Cross-repo impact

This work spans both repos:

- **`smart-suggestions-addon`** (most of the work): new `db_reader.py`, four miners under `src/miners/`, new `llm_describer.py`, deletion of `anthropic_analyzer.py` and `ollama_narrator.py`, filter module, scheduler changes in `main.py`.
- **`smart-suggestions-ha`** (smaller): card content changes for two-zone layout, per-zone action buttons, dismissal feedback handling.

## Out of scope (for v1)

- Anomaly detection (category D from brainstorming).
- State-conditional patterns (category C).
- ML-trained per-user thresholds (only simple bump-on-3-dismissals heuristic in v1).
- Multi-recorder support beyond SQLite/MariaDB/PostgreSQL.
- Energy-cost integration.
- Backfill of historical suggestions from before v1 ships.

## Open questions

None blocking. Confirm during implementation:
- Add-on container needs read access to `/config/home-assistant_v2.db` — verify Supervisor permits this mount.
- Schema for HA recorder may differ across HA versions; pin to current LTS schema and version-gate.
