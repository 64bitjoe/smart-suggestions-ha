# Smart Suggestions v2 — Add-on Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the add-on backend to produce contextually-aware suggestions (time, motion, presence, existing automations, usage history) with SQLite-backed outcome learning, domain filtering, randomized entity sampling, and on-demand YAML generation.

**Architecture:** New `usage_log.py` replaces `feedback.json` with SQLite; `statistical_engine.py` gains domain filtering and hourly-seeded random sampling; `ollama_narrator.py` gains rich context injection and reranking; `ws_server.py` gains `outcome` and `build_yaml` WS message handlers; `main.py` wires everything together with a `_build_narrator_context()` helper.

**Tech Stack:** Python 3.11+, asyncio, aiosqlite, aiohttp, existing test suite (pytest + pytest-asyncio)

**Working directory for all commands:** `/Users/jgray/Desktop/smart-suggestions-addon`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `smart_suggestions/src/usage_log.py` | **Create** | SQLite wrapper — log outcomes, get feedback scores, get avoided pairs, migrate from JSON |
| `smart_suggestions/tests/test_usage_log.py` | **Create** | Tests for UsageLog |
| `smart_suggestions/src/statistical_engine.py` | **Modify** | Add `allowed_domains` filtering + hourly-seeded random sampling |
| `smart_suggestions/tests/test_statistical_engine.py` | **Modify** | Add domain filter + sampling tests |
| `smart_suggestions/src/ha_client.py` | **Modify** | Add `get_automations()` method |
| `smart_suggestions/tests/test_ha_client.py` | **Modify** | Add test for `get_automations()` |
| `smart_suggestions/src/ollama_narrator.py` | **Modify** | Accept context dict, inject into prompt, support reranking output |
| `smart_suggestions/tests/test_ollama_narrator.py` | **Modify** | Add context + reranking tests, update order test |
| `smart_suggestions/src/main.py` | **Modify** | Wire UsageLog, add `_build_narrator_context()`, pass context to narrator, pass feedback scores to scene engine |
| `smart_suggestions/src/ws_server.py` | **Modify** | Add `outcome` and `build_yaml`/`yaml_result` WS message handlers |
| `smart_suggestions/tests/test_ws_server.py` | **Modify** | Add tests for new message handlers |
| `smart_suggestions/Dockerfile` | **Modify** | Add `aiosqlite` to pip install |
| `smart_suggestions/requirements-dev.txt` | **Modify** | Add `aiosqlite` |
| `smart_suggestions/config.yaml` | **Modify** | Add `domains` option, bump version to 1.1.0 |

---

## Task 1: Add aiosqlite Dependency

**Files:**
- Modify: `smart_suggestions/Dockerfile`
- Modify: `smart_suggestions/requirements-dev.txt`

- [ ] **Step 1: Add to Dockerfile**

In `smart_suggestions/Dockerfile`, change:
```dockerfile
RUN pip3 install --no-cache-dir --break-system-packages anthropic openai
```
to:
```dockerfile
RUN pip3 install --no-cache-dir --break-system-packages anthropic openai aiosqlite
```

- [ ] **Step 2: Add to dev requirements**

In `smart_suggestions/requirements-dev.txt`, add a line:
```
aiosqlite==0.20.0
```

- [ ] **Step 3: Install locally**

```bash
pip install aiosqlite==0.20.0
```

Expected: `Successfully installed aiosqlite-0.20.0` (or "already satisfied")

- [ ] **Step 4: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/Dockerfile smart_suggestions/requirements-dev.txt
git commit -m "deps: add aiosqlite for SQLite usage log"
```

---

## Task 2: Create `usage_log.py`

**Files:**
- Create: `smart_suggestions/src/usage_log.py`
- Create: `smart_suggestions/tests/test_usage_log.py`

- [ ] **Step 1: Write the failing tests**

Create `smart_suggestions/tests/test_usage_log.py`:

```python
import json
import os
import pytest
import aiosqlite
from usage_log import UsageLog


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "usage.db")


@pytest.fixture
async def log(db_path):
    ul = UsageLog(db_path)
    await ul.start()
    yield ul
    await ul.stop()


@pytest.mark.asyncio
async def test_log_and_get_avoided_pairs(log):
    await log.log("light.study", "turn_off", "dismissed", 0.8)
    await log.log("light.study", "turn_off", "dismissed", 0.8)
    await log.log("light.kitchen", "turn_on", "run", 0.9)

    avoided = await log.get_avoided_pairs(hours=24, limit=10)
    assert any(p["entity_id"] == "light.study" and p["action"] == "turn_off" for p in avoided)
    assert not any(p["entity_id"] == "light.kitchen" for p in avoided)


@pytest.mark.asyncio
async def test_get_feedback_scores(log):
    await log.log("light.study", "turn_off", "run", 0.8)
    await log.log("light.study", "turn_off", "run", 0.8)
    await log.log("light.study", "turn_off", "dismissed", 0.8)

    scores = await log.get_feedback_scores(["light.study", "light.kitchen"])
    assert scores["light.study"]["up"] == 2
    assert scores["light.study"]["down"] == 1
    assert scores["light.kitchen"] == {"up": 0, "down": 0}


@pytest.mark.asyncio
async def test_migrate_from_json(db_path, tmp_path):
    json_path = str(tmp_path / "feedback.json")
    data = {
        "light.study": {"up": 3, "down": 1},
        "scene.evening": {"up": 0, "down": 2},
    }
    with open(json_path, "w") as f:
        json.dump(data, f)

    ul = UsageLog(db_path)
    await ul.start()
    await ul.migrate_from_json(json_path)

    scores = await ul.get_feedback_scores(["light.study", "scene.evening"])
    assert scores["light.study"]["up"] == 3
    assert scores["light.study"]["down"] == 1
    assert scores["scene.evening"]["down"] == 2

    # Original file renamed to .bak
    assert os.path.exists(json_path + ".bak")
    assert not os.path.exists(json_path)
    await ul.stop()


@pytest.mark.asyncio
async def test_migrate_caps_at_100_rows(db_path, tmp_path):
    json_path = str(tmp_path / "feedback.json")
    data = {"light.x": {"up": 999, "down": 0}}
    with open(json_path, "w") as f:
        json.dump(data, f)

    ul = UsageLog(db_path)
    await ul.start()
    await ul.migrate_from_json(json_path)
    scores = await ul.get_feedback_scores(["light.x"])
    assert scores["light.x"]["up"] == 100
    await ul.stop()


@pytest.mark.asyncio
async def test_avoided_pairs_only_last_24h(log):
    import aiosqlite
    from datetime import datetime, timezone, timedelta

    # Insert an old dismissed record manually
    old_ts = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
    async with aiosqlite.connect(log._db_path) as db:
        await db.execute(
            "INSERT INTO outcomes (timestamp, entity_id, action, outcome, confidence) VALUES (?, ?, ?, ?, ?)",
            (old_ts, "light.old", "turn_off", "dismissed", 0.5)
        )
        await db.commit()

    avoided = await log.get_avoided_pairs(hours=24, limit=10)
    assert not any(p["entity_id"] == "light.old" for p in avoided)
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_usage_log.py -v
```

Expected: `ModuleNotFoundError: No module named 'usage_log'`

- [ ] **Step 3: Implement `usage_log.py`**

Create `smart_suggestions/src/usage_log.py`:

```python
"""SQLite-backed usage log for suggestion outcomes."""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone, timedelta

import aiosqlite

_LOGGER = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_entity_action ON outcomes (entity_id, action);
CREATE INDEX IF NOT EXISTS idx_timestamp ON outcomes (timestamp);
"""


class UsageLog:
    def __init__(self, db_path: str = "/data/usage.db") -> None:
        self._db_path = db_path

    async def start(self) -> None:
        async with aiosqlite.connect(self._db_path) as db:
            await db.executescript(_SCHEMA)
            await db.commit()

    async def stop(self) -> None:
        pass  # aiosqlite connections are context-managed per operation

    async def log(self, entity_id: str, action: str, outcome: str, confidence: float) -> None:
        ts = datetime.now(timezone.utc).isoformat()
        try:
            async with aiosqlite.connect(self._db_path) as db:
                await db.execute(
                    "INSERT INTO outcomes (timestamp, entity_id, action, outcome, confidence) VALUES (?, ?, ?, ?, ?)",
                    (ts, entity_id, action, outcome, confidence),
                )
                await db.commit()
        except Exception as e:
            _LOGGER.warning("UsageLog.log failed: %s", e)

    async def get_avoided_pairs(self, hours: int = 24, limit: int = 10) -> list[dict]:
        """Return top dismissed entity+action pairs from the last `hours` hours."""
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        try:
            async with aiosqlite.connect(self._db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    """
                    SELECT entity_id, action, COUNT(*) as n
                    FROM outcomes
                    WHERE outcome = 'dismissed' AND timestamp > ?
                    GROUP BY entity_id, action
                    ORDER BY n DESC
                    LIMIT ?
                    """,
                    (cutoff, limit),
                )
                rows = await cursor.fetchall()
                return [{"entity_id": r["entity_id"], "action": r["action"], "count": r["n"]} for r in rows]
        except Exception as e:
            _LOGGER.warning("UsageLog.get_avoided_pairs failed: %s", e)
            return []

    async def get_feedback_scores(self, entity_ids: list[str]) -> dict[str, dict]:
        """Return {entity_id: {"up": N, "down": N}} all-time counts.
        'run' and 'saved' outcomes count as up; 'dismissed' counts as down.
        """
        result = {eid: {"up": 0, "down": 0} for eid in entity_ids}
        if not entity_ids:
            return result
        placeholders = ",".join("?" * len(entity_ids))
        try:
            async with aiosqlite.connect(self._db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    f"""
                    SELECT entity_id, outcome, COUNT(*) as n
                    FROM outcomes
                    WHERE entity_id IN ({placeholders})
                    GROUP BY entity_id, outcome
                    """,
                    entity_ids,
                )
                rows = await cursor.fetchall()
                for row in rows:
                    eid = row["entity_id"]
                    if eid not in result:
                        continue
                    if row["outcome"] in ("run", "saved"):
                        result[eid]["up"] += row["n"]
                    elif row["outcome"] == "dismissed":
                        result[eid]["down"] += row["n"]
        except Exception as e:
            _LOGGER.warning("UsageLog.get_feedback_scores failed: %s", e)
        return result

    async def migrate_from_json(self, json_path: str) -> None:
        """Migrate feedback.json to SQLite. Renames source file to .bak on success."""
        try:
            with open(json_path) as f:
                data: dict = json.load(f)
        except FileNotFoundError:
            return
        except Exception as e:
            _LOGGER.warning("Could not read %s for migration: %s", json_path, e)
            return

        _MAX_ROWS = 100
        ts = datetime.now(timezone.utc).isoformat()
        rows: list[tuple] = []
        for entity_id, votes in data.items():
            up_count = min(int(votes.get("up", 0)), _MAX_ROWS)
            down_count = min(int(votes.get("down", 0)), _MAX_ROWS)
            for _ in range(up_count):
                rows.append((ts, entity_id, "", "run", 0.0))
            for _ in range(down_count):
                rows.append((ts, entity_id, "", "dismissed", 0.0))

        try:
            async with aiosqlite.connect(self._db_path) as db:
                await db.executemany(
                    "INSERT INTO outcomes (timestamp, entity_id, action, outcome, confidence) VALUES (?, ?, ?, ?, ?)",
                    rows,
                )
                await db.commit()
            os.rename(json_path, json_path + ".bak")
            _LOGGER.info("Migrated %d feedback entries from %s", len(rows), json_path)
        except Exception as e:
            _LOGGER.error("UsageLog migration failed: %s", e)
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_usage_log.py -v
```

Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/usage_log.py smart_suggestions/tests/test_usage_log.py
git commit -m "feat: add SQLite UsageLog — outcome tracking, feedback scores, JSON migration"
```

---

## Task 3: Wire `UsageLog` into `main.py`

**Files:**
- Modify: `smart_suggestions/src/main.py`

- [ ] **Step 1: Import and initialise UsageLog**

In `main.py`, add at the top with other imports:
```python
from usage_log import UsageLog
```

In `SmartSuggestionsAddon.__init__`, add after existing instance vars:
```python
self._usage_log = UsageLog("/data/usage.db")
```

- [ ] **Step 2: Start UsageLog and run migration in `run()`**

Find the `async def run(self)` method. Before the main loop starts (after WSServer starts), add:
```python
await self._usage_log.start()
await self._usage_log.migrate_from_json(_FEEDBACK_FILE)
```

- [ ] **Step 3: Replace feedback in `_run_refresh_cycle`**

Find `_run_refresh_cycle`. Replace:
```python
ranked = self._scene_engine.rank(candidates, states, self._feedback)
```
With:
```python
entity_ids = [c["entity_id"] for c in candidates]
feedback_scores = await self._usage_log.get_feedback_scores(entity_ids)
ranked = self._scene_engine.rank(candidates, states, feedback_scores)
```

Remove `self._feedback` from `__init__` and delete the `_load_feedback` / `_save_feedback` module-level functions and any `self._feedback` assignments.

- [ ] **Step 3b: Remove feedback wiring from `run()` and clean up `ws_server.py`**

In `run()`, remove the `self._ws_server.set_feedback(self._feedback)` call (if present) and the `register_feedback_handler(self._on_feedback)` call (or equivalent). The new `_on_feedback` is wired differently via `UsageLog` — `_on_feedback` is called directly and logs to the DB, so no feedback dict needs to be passed to the WS server.

Also check `ws_server.py` for any `set_feedback()` method and remove it. Search for `__FEEDBACK__` or similar template substitution in the web UI HTML inside `ws_server.py` — if present, replace the feedback dict substitution with an empty dict `{}`. If the web UI renders feedback counts from the dict, replace the data with `{}` so the page still renders without error.

- [ ] **Step 4: Update `_on_feedback` to use UsageLog**

Find `async def _on_feedback(self, entity_id: str, vote: str)`. Replace the body with:
```python
outcome = "run" if vote == "up" else "dismissed"
await self._usage_log.log(entity_id, "", outcome, 0.0)
_LOGGER.info("Feedback logged: %s %s", entity_id, outcome)
```

- [ ] **Step 5: Run smoke test**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_main_smoke.py -v
```

Expected: all smoke tests PASS (they mock HA and Ollama)

- [ ] **Step 6: Commit**

```bash
git add smart_suggestions/src/main.py
git commit -m "feat: wire UsageLog into main — replace feedback.json with SQLite"
```

---

## Task 4: Domain Filtering in `statistical_engine.py`

**Files:**
- Modify: `smart_suggestions/src/statistical_engine.py`
- Modify: `smart_suggestions/tests/test_statistical_engine.py`

- [ ] **Step 1: Write failing tests**

Add to the end of `smart_suggestions/tests/test_statistical_engine.py`:

```python
def test_domain_filter_excludes_unlisted_domains():
    """Entities not in allowed_domains must not appear in candidates."""
    from unittest.mock import MagicMock
    store = MagicMock()
    store.get_routines.return_value = []
    store.get_correlations.return_value = []
    store.get_active_anomalies.return_value = []

    engine = StatisticalEngine(store, allowed_domains=["light"])
    states = {
        "light.kitchen": {"state": "on", "attributes": {"friendly_name": "Kitchen"}},
        "switch.fan": {"state": "on", "attributes": {"friendly_name": "Fan"}},
        "climate.bedroom": {"state": "cool", "attributes": {"friendly_name": "Bedroom"}},
    }
    result = engine.score_realtime(states)
    domains = {c["entity_id"].split(".")[0] for c in result}
    assert "switch" not in domains
    assert "climate" not in domains


def test_domain_filter_none_means_all_action_domains():
    """allowed_domains=None keeps existing _ACTION_DOMAINS behaviour."""
    from unittest.mock import MagicMock
    store = MagicMock()
    store.get_routines.return_value = []
    store.get_correlations.return_value = []
    store.get_active_anomalies.return_value = []

    engine = StatisticalEngine(store, allowed_domains=None)
    states = {
        "switch.fan": {"state": "on", "attributes": {"friendly_name": "Fan"}},
    }
    result = engine.score_realtime(states)
    # switch is in _ACTION_DOMAINS so it should appear (score 0 but domain valid)
    # Note: score_realtime only includes entities with score > 0 OR domain == "scene"
    # switch.fan has no routine/correlation/anomaly so score == 0 → not included
    # Just verify no crash occurs
    assert isinstance(result, list)
```

- [ ] **Step 2: Run to confirm fail**

```bash
python -m pytest smart_suggestions/tests/test_statistical_engine.py::test_domain_filter_excludes_unlisted_domains -v
```

Expected: `TypeError` — `__init__` doesn't accept `allowed_domains`

- [ ] **Step 3: Implement domain filtering**

In `statistical_engine.py`, update `__init__`:
```python
def __init__(self, pattern_store: "PatternStore", confidence_threshold: float = 0.6, allowed_domains: list[str] | None = None) -> None:
    self._store = pattern_store
    self._confidence_threshold = confidence_threshold
    self._allowed_domains = set(allowed_domains) if allowed_domains else None
```

In `score_realtime`, after `domain = eid.split(".")[0]`, add:
```python
if self._allowed_domains is not None and domain not in self._allowed_domains:
    continue
```
(Place this immediately after the existing `if domain not in _ACTION_DOMAINS: continue` check.)

- [ ] **Step 4: Run tests**

```bash
python -m pytest smart_suggestions/tests/test_statistical_engine.py -v
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/statistical_engine.py smart_suggestions/tests/test_statistical_engine.py
git commit -m "feat: add domain filtering to StatisticalEngine"
```

---

## Task 5: Randomized Entity Sampling in `statistical_engine.py`

**Files:**
- Modify: `smart_suggestions/src/statistical_engine.py`
- Modify: `smart_suggestions/tests/test_statistical_engine.py`

- [ ] **Step 1: Write failing test**

Add to `test_statistical_engine.py`:

```python
def test_entity_sampling_respects_max_entities():
    """When states exceed max_entities, only max_entities non-scene entities are scored."""
    from unittest.mock import MagicMock
    store = MagicMock()
    store.get_routines.return_value = []
    store.get_correlations.return_value = []
    store.get_active_anomalies.return_value = []

    engine = StatisticalEngine(store, max_entities=3)
    # 10 lights — all have an anomaly so they'd all score > 0 without sampling
    anomalies = [{"entity_id": f"light.l{i}", "description": "anomaly"} for i in range(10)]
    store.get_active_anomalies.return_value = anomalies

    states = {f"light.l{i}": {"state": "on", "attributes": {"friendly_name": f"L{i}"}} for i in range(10)}
    result = engine.score_realtime(states)
    assert len(result) <= 3


def test_scene_entities_not_affected_by_sampling():
    """Scenes are always included, not subject to max_entities sampling."""
    from unittest.mock import MagicMock
    store = MagicMock()
    store.get_routines.return_value = []
    store.get_correlations.return_value = []
    store.get_active_anomalies.return_value = []

    engine = StatisticalEngine(store, max_entities=1)
    states = {
        "scene.evening": {"state": "scening", "attributes": {"friendly_name": "Evening", "entities": {}}},
        "scene.morning": {"state": "scening", "attributes": {"friendly_name": "Morning", "entities": {}}},
        "light.l1": {"state": "on", "attributes": {"friendly_name": "L1"}},
        "light.l2": {"state": "on", "attributes": {"friendly_name": "L2"}},
    }
    result = engine.score_realtime(states)
    scene_ids = {c["entity_id"] for c in result if c["domain"] == "scene"}
    assert "scene.evening" in scene_ids
    assert "scene.morning" in scene_ids
```

- [ ] **Step 2: Run to confirm fail**

```bash
python -m pytest smart_suggestions/tests/test_statistical_engine.py::test_entity_sampling_respects_max_entities -v
```

Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'max_entities'`

- [ ] **Step 3: Implement sampling**

Add `import random` and `import time` at the top of `statistical_engine.py`.

Update `__init__`:
```python
def __init__(self, pattern_store: "PatternStore", confidence_threshold: float = 0.6,
             allowed_domains: list[str] | None = None, max_entities: int = 150) -> None:
    self._store = pattern_store
    self._confidence_threshold = confidence_threshold
    self._allowed_domains = set(allowed_domains) if allowed_domains else None
    self._max_entities = max_entities
```

In `score_realtime`, split the entity loop into a sampling step first:

```python
def score_realtime(self, states: dict) -> list[dict]:
    now = datetime.now(timezone.utc)
    routines_by_eid = {r["entity_id"]: r for r in self._store.get_routines()}
    correlations = self._store.get_correlations()
    anomalies_by_eid = {a["entity_id"]: a for a in self._store.get_active_anomalies()}

    # Separate scenes (always included) from other entities
    scene_eids = [eid for eid in states if eid.split(".")[0] == "scene"]
    other_eids = [
        eid for eid in states
        if eid.split(".")[0] != "scene"
        and eid.split(".")[0] in _ACTION_DOMAINS
        and (self._allowed_domains is None or eid.split(".")[0] in self._allowed_domains)
    ]

    # Hourly-seeded random sample of non-scene entities
    if len(other_eids) > self._max_entities:
        seed = int(time.time() // 3600)
        rng = random.Random(seed)
        other_eids = rng.sample(other_eids, self._max_entities)

    eids_to_score = scene_eids + other_eids

    candidates = []
    for eid in eids_to_score:
        state = states.get(eid, {})
        domain = eid.split(".")[0]
        # IMPLEMENTER NOTE: Read the full `score_realtime` method before editing.
        # Replace it in its entirety with the new version shown above — the loop
        # body (from `state = states.get(eid, {})` through to `candidates.sort(...)`)
        # is unchanged from the existing code; only the preamble that builds
        # `eids_to_score` is new. Copy the existing inner loop body exactly.
        # Do NOT leave this comment in the final implementation.
```

Remove the existing domain filtering lines that are now handled in the split above:
```python
# DELETE these lines from inside the loop (they're now pre-filtered):
# if domain not in _ACTION_DOMAINS: continue
# if self._allowed_domains is not None and domain not in self._allowed_domains: continue
```

- [ ] **Step 4: Run all statistical engine tests**

```bash
python -m pytest smart_suggestions/tests/test_statistical_engine.py -v
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/statistical_engine.py smart_suggestions/tests/test_statistical_engine.py
git commit -m "feat: add hourly-seeded random entity sampling to StatisticalEngine"
```

---

## Task 6: Wire Domain Config + StatisticalEngine Update into `main.py`

**Files:**
- Modify: `smart_suggestions/src/main.py`
- Modify: `smart_suggestions/config.yaml`

- [ ] **Step 1: Add `domains` to config.yaml**

In `smart_suggestions/config.yaml`, add to the `options:` / `schema:` sections (follow existing option format):

```yaml
# In options: section
domains:
  - light
  - switch
  - climate
  - lock
  - media_player
  - cover
  - fan

# In schema: section, add:
domains:
  - str
```

Check the existing schema entries in `config.yaml` for the correct list-of-strings format used by this project. Common valid formats are `domains: [str]` or a YAML block list (`domains:\n  - str`). Match the existing style exactly.

Also bump the `version:` field to `1.1.0`.

- [ ] **Step 2: Pass `domains` and `max_entities` to StatisticalEngine in `main.py`**

Find where `StatisticalEngine` is instantiated in `SmartSuggestionsAddon.__init__`. Update:
```python
self._stat_engine = StatisticalEngine(
    self._pattern_store,
    confidence_threshold=float(opts.get("pattern_confidence_threshold", 0.6)),
    allowed_domains=opts.get("domains") or None,
    max_entities=int(opts.get("max_entities", 150)),
)
```

- [ ] **Step 3: Run smoke test**

```bash
python -m pytest smart_suggestions/tests/test_main_smoke.py -v
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add smart_suggestions/src/main.py smart_suggestions/config.yaml
git commit -m "feat: wire domains config into StatisticalEngine, bump add-on version to 1.1.0"
```

---

## Task 7: Add `get_automations()` to `ha_client.py`

**Files:**
- Modify: `smart_suggestions/src/ha_client.py`
- Modify: `smart_suggestions/tests/test_ha_client.py`

- [ ] **Step 1: Add `_api_get` helper to `ha_client.py`**

Before writing any test that patches `_api_get`, first add the helper to `HAClient`. Check `ha_client.py` to confirm attribute names — in the current codebase the base URL is `self._base` (already ends with `/api`) and the session is `self._session` with auth already in its default headers. Add this method to `HAClient`:

```python
async def _api_get(self, path: str) -> list:
    """Thin REST GET helper returning parsed JSON list."""
    url = self._base.rstrip("/") + path
    async with self._session.get(url) as resp:
        resp.raise_for_status()
        return await resp.json()
```

Note: `self._session` is created in `start()` with the `Authorization` header already set, so no extra header is needed here. If you are calling `_api_get` before `start()` in tests, ensure the session is mocked or initialised first.

Also update (or add) `get_automations()` to call `self._api_get("/states")` (the base already contains `/api`, so the path is `/states` not `/api/states`):

```python
async def get_automations(self) -> list[str]:
    """Return list of existing automation friendly names from HA states."""
    try:
        states = await self._api_get("/states")
        return [
            s.get("attributes", {}).get("friendly_name", s["entity_id"])
            for s in states
            if s.get("entity_id", "").startswith("automation.")
        ]
    except Exception as e:
        _LOGGER.warning("get_automations failed: %s", e)
        return []
```

- [ ] **Step 2: Write failing test**

Add to `test_ha_client.py`:

```python
@pytest.mark.asyncio
async def test_get_automations_returns_friendly_names():
    from unittest.mock import AsyncMock, patch
    from ha_client import HAClient

    client = HAClient(ha_url="http://homeassistant.local:8123", token="test_token")

    mock_states = [
        {"entity_id": "automation.goodnight", "state": "on",
         "attributes": {"friendly_name": "Goodnight routine"}},
        {"entity_id": "automation.motion_hall", "state": "off",
         "attributes": {"friendly_name": "Hallway motion light"}},
        {"entity_id": "light.kitchen", "state": "on",  # non-automation, should be excluded
         "attributes": {"friendly_name": "Kitchen Light"}},
    ]

    with patch.object(client, "_api_get", new=AsyncMock(return_value=mock_states)):
        result = await client.get_automations()

    assert "Goodnight routine" in result
    assert "Hallway motion light" in result
    assert len(result) == 2
```

- [ ] **Step 3: Run to confirm fail**

```bash
python -m pytest smart_suggestions/tests/test_ha_client.py::test_get_automations_returns_friendly_names -v
```

Expected: `AttributeError: 'HAClient' object has no attribute '_api_get'` (before Step 1) or `'get_automations'` (if Step 1 is done first, as required).

- [ ] **Step 4: Run tests**

```bash
python -m pytest smart_suggestions/tests/test_ha_client.py -v
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/ha_client.py smart_suggestions/tests/test_ha_client.py
git commit -m "feat: add _api_get helper and get_automations() to HAClient"
```

---

## Task 8: Add `_build_narrator_context()` to `main.py`

**Files:**
- Modify: `smart_suggestions/src/main.py`

- [ ] **Step 1: Implement the helper**

Add this method to `SmartSuggestionsAddon`:

```python
async def _build_narrator_context(self, states: dict) -> dict:
    """Assemble rich context dict for the Ollama narrator."""
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)
    current_time = now.strftime("%H:%M on %A")

    # Entities changed in last 60 minutes
    recent_changes = []
    cutoff = now - timedelta(minutes=60)
    for eid, state in states.items():
        lc = state.get("last_changed", "")
        try:
            changed = datetime.fromisoformat(lc.replace("Z", "+00:00"))
            if changed >= cutoff:
                mins_ago = int((now - changed).total_seconds() / 60)
                recent_changes.append({
                    "entity_id": eid,
                    "state": state.get("state"),
                    "changed_ago_minutes": mins_ago,
                })
        except (ValueError, TypeError):
            pass

    # Motion / occupancy sensors
    motion_sensors = []
    for eid, state in states.items():
        if eid.startswith("binary_sensor.") and any(
            kw in eid for kw in ("motion", "occupancy", "presence")
        ):
            lc = state.get("last_changed", "")
            mins_since = None
            try:
                changed = datetime.fromisoformat(lc.replace("Z", "+00:00"))
                mins_since = int((now - changed).total_seconds() / 60)
            except (ValueError, TypeError):
                pass
            motion_sensors.append({
                "entity_id": eid,
                "state": state.get("state"),
                "minutes_since_triggered": mins_since,
            })

    # Presence
    presence = [
        eid for eid, s in states.items()
        if eid.startswith("person.") and s.get("state") == "home"
    ]

    # Weather — check sensor first, then weather entity for condition
    temp_val = None
    condition_val = None
    outdoor_temp = states.get("sensor.outdoor_temperature")
    if outdoor_temp:
        temp_val = outdoor_temp.get("state")
    for eid, state in states.items():
        if eid.startswith("weather."):
            condition_val = state.get("state")
            if temp_val is None:
                temp_val = state.get("attributes", {}).get("temperature")
            break
    weather = {"temperature": temp_val, "condition": condition_val} if (temp_val or condition_val) else None

    # Avoided pairs from usage log
    avoided = await self._usage_log.get_avoided_pairs(hours=24, limit=10)

    # Existing automations
    existing_automations: list[str] = []
    if self._ha:
        existing_automations = await self._ha.get_automations()

    return {
        "current_time": current_time,
        "recent_changes": recent_changes[:10],
        "motion_sensors": motion_sensors[:10],
        "presence": presence,
        "weather": weather,
        "avoided_pairs": avoided,
        "existing_automations": existing_automations[:30],
    }
```

- [ ] **Step 2: Write unit tests for `_build_narrator_context()`**

In `test_main_smoke.py` or a new `test_context_builder.py`, add tests that verify:

```python
@pytest.mark.asyncio
async def test_build_narrator_context_presence():
    """person.home states appear in presence list."""
    # Construct a minimal SmartSuggestionsAddon with mocked dependencies,
    # then call _build_narrator_context with states that include person.* entities.
    # Assert the returned dict has presence == ["person.alice"] for a home person.

@pytest.mark.asyncio
async def test_build_narrator_context_weather_entity():
    """weather.* condition comes from .state and temperature from .attributes.temperature."""
    # States: {"weather.home": {"state": "sunny", "attributes": {"temperature": 22}}}
    # Assert weather == {"condition": "sunny", "temperature": 22}

@pytest.mark.asyncio
async def test_build_narrator_context_outdoor_temp_sensor():
    """sensor.outdoor_temperature is used for temperature when present, even alongside weather entity."""
    # States: {
    #   "sensor.outdoor_temperature": {"state": "18.5", "attributes": {}},
    #   "weather.home": {"state": "cloudy", "attributes": {"temperature": 20}},
    # }
    # Assert weather["temperature"] == "18.5"  (sensor takes priority)
    # Assert weather["condition"] == "cloudy"   (still comes from weather entity)
```

Run the tests and confirm they pass against the `_build_narrator_context` implementation above.

- [ ] **Step 3: Wire into `_run_refresh_cycle`**

In `_run_refresh_cycle`, after building `ranked` and before the narrator call, add:
```python
context = await self._build_narrator_context(states)
```

Then pass it to the narrator:
```python
ranked = await asyncio.wait_for(
    self._narrator.narrate(ranked, context=context), timeout=20.0
)
```

(Timeout increased from 15s to 20s to accommodate larger prompt.)

- [ ] **Step 4: Run smoke test**

```bash
python -m pytest smart_suggestions/tests/test_main_smoke.py -v
```

Expected: PASS (narrator mock accepts kwargs)

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/main.py
git commit -m "feat: add _build_narrator_context() to main — injects time, motion, presence, weather, avoided pairs, existing automations"
```

---

## Task 9: Enhance `ollama_narrator.py` — Context + Reranking

**Files:**
- Modify: `smart_suggestions/src/ollama_narrator.py`
- Modify: `smart_suggestions/tests/test_ollama_narrator.py`

- [ ] **Step 1: Write failing tests**

Add to `test_ollama_narrator.py`:

```python
@pytest.mark.asyncio
async def test_narrate_accepts_context_kwarg():
    """narrate() must accept a context= kwarg without error."""
    narrator = OllamaNarrator(ollama_url="http://localhost:11434", model="llama3.2")
    candidates = [make_candidate("light.study", "original reason")]
    new_reasons = [{"entity_id": "light.study", "reason": "It has been on for an hour with no motion."}]

    context = {"current_time": "22:00 on Wednesday", "motion_sensors": [], "presence": ["person.john"],
               "weather": None, "avoided_pairs": [], "existing_automations": [], "recent_changes": []}

    with patch.object(narrator, "_call_ollama", new=AsyncMock(return_value=json.dumps(new_reasons))):
        result = await narrator.narrate(candidates, context=context)

    assert result[0]["reason"] == "It has been on for an hour with no motion."


@pytest.mark.asyncio
async def test_narrate_reranks_on_reordered_response():
    """If Ollama returns items in a different order, output respects that order."""
    narrator = OllamaNarrator(ollama_url="http://localhost:11434", model="llama3.2")
    candidates = [
        make_candidate("scene.evening", "reason 1"),
        make_candidate("light.kitchen", "reason 2"),
    ]
    # Ollama reorders: kitchen first
    reordered = json.dumps([
        {"entity_id": "light.kitchen", "reason": "Kitchen reordered reason"},
        {"entity_id": "scene.evening", "reason": "Evening reordered reason"},
    ])

    with patch.object(narrator, "_call_ollama", new=AsyncMock(return_value=reordered)):
        result = await narrator.narrate(candidates)

    assert result[0]["entity_id"] == "light.kitchen"
    assert result[1]["entity_id"] == "scene.evening"


@pytest.mark.asyncio
async def test_narrate_appends_missing_items_at_end_on_partial_rerank():
    """Items missing from Ollama reranked response are appended at the end."""
    narrator = OllamaNarrator(ollama_url="http://localhost:11434", model="llama3.2")
    candidates = [
        make_candidate("scene.evening", "reason 1"),
        make_candidate("light.kitchen", "reason 2"),
        make_candidate("switch.fan", "reason 3"),
    ]
    # Ollama only returns 2 of 3
    partial = json.dumps([
        {"entity_id": "light.kitchen", "reason": "Kitchen reason"},
        {"entity_id": "scene.evening", "reason": "Evening reason"},
    ])

    with patch.object(narrator, "_call_ollama", new=AsyncMock(return_value=partial)):
        result = await narrator.narrate(candidates)

    assert len(result) == 3
    assert result[0]["entity_id"] == "light.kitchen"
    assert result[1]["entity_id"] == "scene.evening"
    assert result[2]["entity_id"] == "switch.fan"  # appended at end
```

- [ ] **Step 2: Update existing order-preservation test**

The existing test `test_narrate_preserves_candidate_count_and_order` now needs updating — narrate() can change order. Update the test name and assertion:

```python
@pytest.mark.asyncio
async def test_narrate_preserves_candidate_count_appends_missing():
    """Ollama cannot remove candidates — missing items appended at end."""
    narrator = OllamaNarrator(ollama_url="http://localhost:11434", model="llama3.2")
    candidates = [
        make_candidate("scene.evening", "reason 1"),
        make_candidate("light.kitchen", "reason 2"),
    ]
    partial = json.dumps([{"entity_id": "scene.evening", "reason": "Better reason"}])

    with patch.object(narrator, "_call_ollama", new=AsyncMock(return_value=partial)):
        result = await narrator.narrate(candidates)

    assert len(result) == 2
    eids = [r["entity_id"] for r in result]
    assert "scene.evening" in eids
    assert "light.kitchen" in eids
    assert result[0]["reason"] == "Better reason"
    assert result[1]["reason"] == "reason 2"  # fallback for missing
```

- [ ] **Step 3: Run to confirm new tests fail**

```bash
python -m pytest smart_suggestions/tests/test_ollama_narrator.py -v
```

Expected: 3 new tests FAIL, existing tests PASS

- [ ] **Step 4: Update `ollama_narrator.py`**

Update `narrate()` signature:
```python
async def narrate(self, candidates: list[dict], context: dict | None = None) -> list[dict]:
```

Update `_call_ollama()` to accept and inject context:
```python
async def _call_ollama(self, candidates: list[dict], context: dict | None = None) -> str:
    now_str = context.get("current_time") if context else datetime.now().strftime("%H:%M on %A")

    context_lines = []
    if context:
        if context.get("motion_sensors"):
            no_motion = [s for s in context["motion_sensors"] if s.get("state") == "off"]
            if no_motion:
                context_lines.append("No motion in: " + ", ".join(
                    f"{s['entity_id']} ({s.get('minutes_since_triggered', '?')}m)"
                    for s in no_motion[:5]
                ))
        if context.get("presence"):
            context_lines.append("Home: " + ", ".join(context["presence"]))
        if context.get("weather"):
            w = context["weather"]
            context_lines.append(f"Weather: {w.get('condition', '')} {w.get('temperature', '')}°")
        if context.get("existing_automations"):
            context_lines.append("Already automated: " + "; ".join(context["existing_automations"][:10]))
        if context.get("avoided_pairs"):
            context_lines.append("User has dismissed: " + "; ".join(
                f"{p['entity_id']} {p['action']}" for p in context["avoided_pairs"][:5]
            ))

    context_block = "\n".join(context_lines) if context_lines else "No additional context."

    input_json = json.dumps([
        {"entity_id": c["entity_id"], "name": c["name"], "type": c.get("type"), "reason": c.get("reason", "")}
        for c in candidates
    ], indent=2)

    prompt = f"""It is {now_str}.

CONTEXT:
{context_block}

SUGGESTIONS (reorder and rewrite reasons for relevance):
{input_json}

Instructions:
1. Reorder the suggestions so the most contextually relevant items come first.
2. Rewrite each 'reason' to be natural and specific (one sentence).
3. Do NOT suggest anything already in "Already automated".
4. Do NOT suggest anything in "User has dismissed".
5. Return ONLY a valid JSON array (no markdown), same items as input, possibly reordered:
[{{"entity_id": "...", "reason": "..."}}]"""

    session = self._session
    if session:
        return await self._post(session, prompt)
    async with aiohttp.ClientSession() as tmp_session:
        return await self._post(tmp_session, prompt)
```

Update `narrate()` to pass context:
```python
async def narrate(self, candidates: list[dict], context: dict | None = None) -> list[dict]:
    if not candidates:
        return []
    try:
        raw = await self._call_ollama(candidates, context=context)
        return self._apply_reasons(candidates, raw)
    except Exception as e:
        _LOGGER.warning("OllamaNarrator: failed, using original reasons: %s", e)
        return candidates
```

Update `_apply_reasons()` to support reordering:
```python
def _apply_reasons(self, candidates: list[dict], raw: str) -> list[dict]:
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, list):
            return candidates

        # Build lookup from original candidates
        by_eid = {c["entity_id"]: c for c in candidates}
        seen = set()
        result = []

        # Follow LLM's order
        for item in parsed:
            eid = item.get("entity_id")
            if not eid or eid not in by_eid or eid in seen:
                continue
            candidate = dict(by_eid[eid])
            if item.get("reason"):
                candidate["reason"] = item["reason"]
            result.append(candidate)
            seen.add(eid)

        # Append any candidates the LLM dropped
        for c in candidates:
            if c["entity_id"] not in seen:
                result.append(c)

        return result if result else candidates
    except (json.JSONDecodeError, TypeError):
        return candidates
```

- [ ] **Step 5: Run all narrator tests**

```bash
python -m pytest smart_suggestions/tests/test_ollama_narrator.py -v
```

Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add smart_suggestions/src/ollama_narrator.py smart_suggestions/tests/test_ollama_narrator.py
git commit -m "feat: enhance OllamaNarrator — rich context injection and candidate reranking"
```

---

## Task 10: Add `outcome` and `build_yaml` WS Handlers to `ws_server.py`

**Files:**
- Modify: `smart_suggestions/src/ws_server.py`
- Modify: `smart_suggestions/tests/test_ws_server.py`

- [ ] **Step 1: Extract `_handle_client_message` from the WS handler closure**

Before writing tests, create the testable seam. In `ws_server.py`, find the WebSocket handler function (likely an `async def` registered with aiohttp that receives and dispatches incoming messages from the card). Extract the message dispatch logic into a standalone method on `WSServer`:

```python
async def _handle_client_message(self, msg: dict, ws=None) -> None:
    """Dispatch an incoming WS message from a card client."""
    # Move existing per-type dispatch logic here.
    # (Implementation added in Step 3 below; for now, create the method stub.)
    pass
```

Then in the WS handler closure, replace the inline dispatch with:
```python
await self._handle_client_message(msg, ws=ws)
```

This creates the testable seam that `test_outcome_handler_calls_usage_log` and `test_build_yaml_handler_calls_automation_builder` rely on (they call `server._handle_client_message(msg)` directly).

- [ ] **Step 2: Write failing tests**

Add to `test_ws_server.py`:

```python
@pytest.mark.asyncio
async def test_outcome_handler_calls_usage_log():
    from unittest.mock import AsyncMock, MagicMock
    from ws_server import WSServer

    server = WSServer()
    mock_usage_log = AsyncMock()
    server.set_usage_log(mock_usage_log)

    msg = {"type": "outcome", "entity_id": "light.study", "action": "turn_off",
           "outcome": "dismissed", "confidence": 0.8}
    await server._handle_client_message(msg)

    mock_usage_log.log.assert_called_once_with("light.study", "turn_off", "dismissed", 0.8)


@pytest.mark.asyncio
async def test_build_yaml_handler_calls_automation_builder():
    from unittest.mock import AsyncMock, MagicMock, patch
    from ws_server import WSServer

    server = WSServer()
    mock_ws = AsyncMock()
    mock_builder = MagicMock()
    mock_builder.build = AsyncMock(return_value={"yaml": "alias: Test\n..."})
    server.set_automation_builder(mock_builder)
    server.set_ha_client(AsyncMock())

    msg = {"type": "build_yaml", "entity_id": "light.study", "action": "turn_off",
           "name": "Study Light", "reason": "No motion for 45 min"}
    await server._handle_client_message(msg, ws=mock_ws)

    mock_builder.build.assert_called_once()
    mock_ws.send_str.assert_called_once()
    sent = json.loads(mock_ws.send_str.call_args[0][0])
    assert sent["type"] == "yaml_result"
    assert sent["entity_id"] == "light.study"
```

- [ ] **Step 3: Run to confirm fail**

```bash
python -m pytest smart_suggestions/tests/test_ws_server.py -v -k "outcome or build_yaml"
```

Expected: FAIL — `AttributeError: 'WSServer' has no attribute 'set_usage_log'` (or `_handle_client_message` not yet fully implemented)

- [ ] **Step 4: Implement in `ws_server.py`**

Add setter methods to `WSServer`:
```python
def set_usage_log(self, usage_log) -> None:
    self._usage_log = usage_log

def set_automation_builder(self, builder) -> None:
    self._automation_builder = builder

def set_ha_client(self, ha_client) -> None:
    self._ha_client = ha_client
```

Find the existing client message handler (likely a method that handles incoming WS messages from the card). Add or extend it to handle the new message types:

```python
async def _handle_client_message(self, msg: dict, ws=None) -> None:
    msg_type = msg.get("type")

    if msg_type == "outcome":
        if hasattr(self, "_usage_log") and self._usage_log:
            await self._usage_log.log(
                entity_id=msg.get("entity_id", ""),
                action=msg.get("action", ""),
                outcome=msg.get("outcome", "shown"),
                confidence=float(msg.get("confidence", 0.0)),
            )

    elif msg_type == "build_yaml":
        if ws and hasattr(self, "_automation_builder") and self._automation_builder:
            entity_id = msg.get("entity_id", "")
            action = msg.get("action", "")
            try:
                ctx = {
                    "entity_id": entity_id,
                    "name": msg.get("name", entity_id),
                    "typical_time": None,
                    "days": [],
                }
                result = await self._automation_builder.build(
                    ctx, self._ha_client if hasattr(self, "_ha_client") else None
                )
                await ws.send_str(json.dumps({
                    "type": "yaml_result",
                    "entity_id": entity_id,
                    "action": action,
                    "yaml": result.get("yaml"),
                }))
            except Exception as e:
                await ws.send_str(json.dumps({
                    "type": "yaml_result",
                    "entity_id": entity_id,
                    "action": action,
                    "yaml": None,
                    "error": str(e),
                }))
```

Wire `set_usage_log` and `set_automation_builder` calls into `main.py` after the WSServer is created:
```python
self._ws_server.set_usage_log(self._usage_log)
self._ws_server.set_automation_builder(self._automation_builder)
self._ws_server.set_ha_client(self._ha)
```

- [ ] **Step 5: Run all ws_server tests**

```bash
python -m pytest smart_suggestions/tests/test_ws_server.py -v
```

Expected: all PASS

- [ ] **Step 6: Run full test suite**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest -v
```

Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add smart_suggestions/src/ws_server.py smart_suggestions/src/main.py smart_suggestions/tests/test_ws_server.py
git commit -m "feat: add outcome and build_yaml WS message handlers to WSServer"
```

---

## Task 11: Final Add-on Integration Check

- [ ] **Step 1: Run full test suite one final time**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest -v --tb=short
```

Expected: all PASS, zero failures

- [ ] **Step 2: Verify config.yaml version**

```bash
grep "version:" smart_suggestions/config.yaml
```

Expected: `version: "1.1.0"`

- [ ] **Step 3: Final commit**

```bash
git add -u
git commit -m "chore: add-on v2 complete — context-aware suggestions, SQLite usage log, domain filtering, sampling"
```
