# Smart Suggestions Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Ollama-driven suggestion engine with a scene-first, pattern-learning system that produces useful smart home suggestions and can save them as HA automations.

**Architecture:** A deterministic `StatisticalEngine` handles real-time scoring from a `PatternStore`; an `AnthropicAnalyzer` (configurable AI provider) enriches patterns nightly; `OllamaNarrator` writes human reasons only; `SceneEngine` ranks scenes first; `AutomationBuilder` turns confirmed suggestions into HA automations via REST.

**Tech Stack:** Python 3.11+, asyncio, aiohttp, `anthropic` SDK, `openai` SDK (compatible providers), pytest + pytest-asyncio + pytest-mock, HA REST API (Supervisor proxy)

**Spec:** `docs/superpowers/specs/2026-03-21-smart-suggestions-redesign.md`

**Repos:**
- Add-on: `/Users/jgray/Desktop/smart-suggestions-addon/smart_suggestions/`
- Integration (card): `/Users/jgray/Desktop/smart-suggestions-ha/custom_components/smart_suggestions/`

---

## Parallel Execution Map

Tasks within each phase can be dispatched in parallel. Each phase must complete before the next begins.

```
Phase 1: Task 1 (test infra + const.py)
Phase 2: Task 2 (pattern_store) ║ Task 3 (ha_client)
Phase 3: Task 4 (statistical_engine) ║ Task 5 (anthropic_analyzer) ║ Task 6 (ollama_narrator)
Phase 4: Task 7 (scene_engine) ║ Task 8 (automation_builder)
Phase 5: Task 9 (ws_server) ║ Task 10 (card)
Phase 6: Task 11 (main.py rewrite) → Task 12 (Dockerfile + config.yaml)
```

---

## File Map

### Add-on (`smart_suggestions/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `src/const.py` | **Create** | Shared domain constants (`_ACTION_DOMAINS`, `_SKIP_DOMAINS`, etc.) |
| `src/pattern_store.py` | **Create** | Read/write `/data/patterns.json` with TTL/decay, schema migration |
| `src/statistical_engine.py` | **Create** | Real-time routine scoring from PatternStore; background co-occurrence scan |
| `src/anthropic_analyzer.py` | **Create** | Nightly deep analysis via Anthropic/OpenAI-compatible API |
| `src/scene_engine.py` | **Create** | Scene-first ranking, `can_save_as_automation` logic |
| `src/ollama_narrator.py` | **Create** | Narration-only Ollama wrapper — rewrites `reason` fields, no ranking |
| `src/automation_builder.py` | **Create** | Generate automation YAML via Anthropic, POST to HA REST |
| `src/ha_client.py` | **Update** | Add `create_automation()`, remove `fetch_dow_history()` (replaced by `fetch_history(hours=analysis_depth_days * 24)`), fix import |
| `src/main.py` | **Rewrite** | Wire all new components; keep feedback system + `_WSLogHandler` |
| `src/ws_server.py` | **Update** | Add `save_automation` inbound, `automation_result` outbound; remove `broadcast_token` |
| `src/context_builder.py` | **Delete** | Logic absorbed by `StatisticalEngine` + `SceneEngine` |
| `src/pattern_analyzer.py` | **Delete** | Replaced by `AnthropicAnalyzer` |
| `src/ollama_client.py` | **Delete** | Replaced by `OllamaNarrator` |
| `config.yaml` | **Update** | Add new options + schema keys |
| `Dockerfile` | **Update** | Add pip + `anthropic` + `openai` packages |
| `tests/` | **Create** | pytest suite — one test file per new module |

### Integration (`custom_components/smart_suggestions/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `smart-suggestions-card.js` | **Update** | Scene-first layout, Save as Automation button, `automation_result` handler; remove streaming |

---

## Task 1: Test Infrastructure + Shared Constants

**Phase 1 — Run alone first.**

**Files:**
- Create: `smart_suggestions/tests/__init__.py`
- Create: `smart_suggestions/tests/conftest.py`
- Create: `smart_suggestions/requirements-dev.txt`
- Create: `smart_suggestions/src/const.py`
- Create: `smart_suggestions/tests/test_const.py`

- [ ] **Step 1: Create requirements-dev.txt**

```
pytest==8.3.5
pytest-asyncio==0.24.0
pytest-mock==3.14.0
aiohttp==3.10.11
```

- [ ] **Step 2: Install dev dependencies**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
pip install -r smart_suggestions/requirements-dev.txt
```

Expected: packages install without error.

- [ ] **Step 3: Create test package**

```bash
mkdir -p /Users/jgray/Desktop/smart-suggestions-addon/smart_suggestions/tests
touch /Users/jgray/Desktop/smart-suggestions-addon/smart_suggestions/tests/__init__.py
```

- [ ] **Step 4: Create conftest.py**

```python
# smart_suggestions/tests/conftest.py
import sys
import os

# Add src/ to path so test imports work without packaging
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
```

- [ ] **Step 5: Write the failing test for const.py**

```python
# smart_suggestions/tests/test_const.py
from const import _ACTION_DOMAINS, _SKIP_DOMAINS, _CONTEXT_ONLY_DOMAINS, _INACTIVE_STATES


def test_action_domains_contains_expected():
    assert "light" in _ACTION_DOMAINS
    assert "switch" in _ACTION_DOMAINS
    assert "scene" in _ACTION_DOMAINS
    assert "climate" in _ACTION_DOMAINS


def test_skip_domains_do_not_overlap_action_domains():
    assert _SKIP_DOMAINS.isdisjoint(_ACTION_DOMAINS)


def test_context_only_do_not_overlap_action_domains():
    assert _CONTEXT_ONLY_DOMAINS.isdisjoint(_ACTION_DOMAINS)


def test_inactive_states():
    assert "off" in _INACTIVE_STATES
    assert "locked" in _INACTIVE_STATES
```

- [ ] **Step 6: Run — verify FAIL (ImportError)**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_const.py -v
```

Expected: `ModuleNotFoundError: No module named 'const'`

- [ ] **Step 7: Create src/const.py**

Extract constants verbatim from `context_builder.py` (lines 12–27). Do not modify values:

```python
# smart_suggestions/src/const.py
"""Shared domain constants for Smart Suggestions add-on."""

# Domains to skip entirely from context
_SKIP_DOMAINS = {
    "sun", "zone", "updater", "persistent_notification", "person",
    "device_tracker",
}

# Domains that appear in entity_states (context) but NOT in available_actions
_CONTEXT_ONLY_DOMAINS = {"sensor", "weather", "binary_sensor"}

# Domains that are interesting as potential actions
_ACTION_DOMAINS = {
    "light", "switch", "climate", "media_player", "cover",
    "fan", "lock", "vacuum", "input_boolean", "automation", "script", "scene",
}

# States that count as "inactive" for dormancy filtering
_INACTIVE_STATES = {"off", "idle", "paused", "standby", "closed", "locked"}
```

- [ ] **Step 8: Run — verify PASS**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_const.py -v
```

Expected: 4 tests PASS.

- [ ] **Step 9: Update ha_client.py import**

In `smart_suggestions/src/ha_client.py` line 122, change:
```python
from context_builder import _ACTION_DOMAINS
```
to:
```python
from const import _ACTION_DOMAINS
```

- [ ] **Step 10: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/tests/ smart_suggestions/requirements-dev.txt smart_suggestions/src/const.py smart_suggestions/src/ha_client.py
git commit -m "feat: add test infrastructure, const.py, fix ha_client import"
```

---

## Task 2: PatternStore

**Phase 2 — Run in parallel with Task 3.**

**Files:**
- Create: `smart_suggestions/src/pattern_store.py`
- Create: `smart_suggestions/tests/test_pattern_store.py`

**TTL rules (from spec):**
- `source: "statistical"` → TTL 24h
- `source: "anthropic"` → TTL 7 days
- `anomalies` → filtered by `expires_at` field at read time (default 4h from detection)
- Decay evaluated at **read time** — no background cleanup

**Migration:** If existing file lacks `expires_at`/`source`, add safe defaults on first load. Drop old `right_now` key.

- [ ] **Step 1: Write failing tests**

```python
# smart_suggestions/tests/test_pattern_store.py
import json
import os
import tempfile
from datetime import datetime, timezone, timedelta

import pytest
from pattern_store import PatternStore


@pytest.fixture
def tmp_store(tmp_path):
    path = str(tmp_path / "patterns.json")
    return PatternStore(path=path)


@pytest.fixture
def tmp_store_with_data(tmp_path):
    path = str(tmp_path / "patterns.json")
    data = {
        "routines": [
            {
                "name": "Evening Scene",
                "entity_id": "scene.evening",
                "typical_time": "18:30",
                "days": ["Mon", "Tue", "Wed", "Thu", "Fri"],
                "confidence": 0.87,
                "last_seen": "2026-03-20T18:32:00",
                "source": "anthropic",
                "expires_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
            }
        ],
        "correlations": [],
        "anomalies": [],
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(path, "w") as f:
        json.dump(data, f)
    return PatternStore(path=path)


def test_empty_store_returns_empty_patterns(tmp_store):
    assert tmp_store.get_routines() == []
    assert tmp_store.get_correlations() == []
    assert tmp_store.get_active_anomalies() == []


def test_save_and_load_roundtrip(tmp_store):
    patterns = {
        "routines": [
            {
                "name": "Morning",
                "entity_id": "light.kitchen",
                "typical_time": "07:00",
                "days": ["Mon"],
                "confidence": 0.8,
                "last_seen": "2026-03-20T07:01:00",
                "source": "statistical",
                "expires_at": (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
            }
        ],
        "correlations": [],
        "anomalies": [],
    }
    tmp_store.merge(patterns)
    store2 = PatternStore(path=tmp_store._path)
    routines = store2.get_routines()
    assert len(routines) == 1
    assert routines[0]["entity_id"] == "light.kitchen"


def test_expired_routine_is_excluded(tmp_store):
    patterns = {
        "routines": [
            {
                "name": "Stale",
                "entity_id": "scene.old",
                "typical_time": "10:00",
                "days": ["Mon"],
                "confidence": 0.9,
                "last_seen": "2026-01-01T10:00:00",
                "source": "statistical",
                "expires_at": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
            }
        ],
        "correlations": [],
        "anomalies": [],
    }
    tmp_store.merge(patterns)
    assert tmp_store.get_routines() == []


def test_expired_anomaly_filtered_at_read_time(tmp_store):
    patterns = {
        "routines": [],
        "correlations": [],
        "anomalies": [
            {
                "entity_id": "light.kitchen",
                "description": "on too long",
                "severity": "medium",
                "expires_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
            }
        ],
    }
    tmp_store.merge(patterns)
    assert tmp_store.get_active_anomalies() == []


def test_active_anomaly_returned(tmp_store):
    patterns = {
        "routines": [],
        "correlations": [],
        "anomalies": [
            {
                "entity_id": "light.kitchen",
                "description": "on too long",
                "severity": "medium",
                "expires_at": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
            }
        ],
    }
    tmp_store.merge(patterns)
    anomalies = tmp_store.get_active_anomalies()
    assert len(anomalies) == 1
    assert anomalies[0]["entity_id"] == "light.kitchen"


def test_migration_adds_missing_fields(tmp_path):
    """Old-format patterns.json (no expires_at, no source) should migrate cleanly."""
    path = str(tmp_path / "patterns.json")
    old_data = {
        "routines": [
            {
                "name": "Old routine",
                "entity_id": "scene.old",
                "typical_time": "19:00",
                "days": ["Mon"],
                "confidence": 0.75,
            }
        ],
        "correlations": [],
        "right_now": [{"insight": "ignored", "entity_id": "light.x", "urgency": "high"}],
        "anomalies": [],
    }
    with open(path, "w") as f:
        json.dump(old_data, f)
    store = PatternStore(path=path)
    routines = store.get_routines()
    assert len(routines) == 1
    assert "expires_at" in routines[0]
    assert "source" in routines[0]
    assert store._data.get("right_now") is None


def test_updated_at_absent_triggers_fresh_analysis_flag(tmp_store):
    assert tmp_store.needs_fresh_analysis(analysis_depth_days=14) is True


def test_recent_updated_at_does_not_trigger(tmp_store):
    tmp_store._data["updated_at"] = datetime.now(timezone.utc).isoformat()
    tmp_store._save()
    store2 = PatternStore(path=tmp_store._path)
    assert store2.needs_fresh_analysis(analysis_depth_days=14) is False
```

- [ ] **Step 2: Run — verify FAIL**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_pattern_store.py -v
```

Expected: `ModuleNotFoundError: No module named 'pattern_store'`

- [ ] **Step 3: Implement pattern_store.py**

```python
# smart_suggestions/src/pattern_store.py
"""Persistent pattern store with TTL/decay. Evaluated at read time."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone, timedelta
from typing import Any

_LOGGER = logging.getLogger(__name__)

_DEFAULT_PATH = "/data/patterns.json"
_TTL_STATISTICAL_HOURS = 24
_TTL_ANTHROPIC_DAYS = 7
_TTL_ANOMALY_HOURS = 4


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(s: str) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _is_expired(entry: dict) -> bool:
    expires_at = _parse_dt(entry.get("expires_at", ""))
    if expires_at is None:
        return False
    return _now_utc() > expires_at


def _add_defaults(entry: dict, default_ttl_hours: int, default_source: str) -> dict:
    """Add missing expires_at and source fields (migration path)."""
    out = dict(entry)
    if "source" not in out:
        out["source"] = default_source
    if "expires_at" not in out:
        out["expires_at"] = (_now_utc() + timedelta(hours=default_ttl_hours)).isoformat()
    return out


class PatternStore:
    def __init__(self, path: str = _DEFAULT_PATH) -> None:
        self._path = path
        self._data: dict = self._load()

    def _load(self) -> dict:
        try:
            with open(self._path) as f:
                raw = json.load(f)
            if not isinstance(raw, dict):
                return self._empty()
            return self._migrate(raw)
        except FileNotFoundError:
            return self._empty()
        except Exception as e:
            _LOGGER.warning("PatternStore: could not read %s: %s — starting empty", self._path, e)
            return self._empty()

    def _empty(self) -> dict:
        return {"routines": [], "correlations": [], "anomalies": []}

    def _migrate(self, data: dict) -> dict:
        """Normalise old-format files: add missing fields, drop right_now."""
        data.pop("right_now", None)
        data.setdefault("routines", [])
        data.setdefault("correlations", [])
        data.setdefault("anomalies", [])
        data["routines"] = [
            _add_defaults(r, _TTL_STATISTICAL_HOURS, "statistical")
            for r in data["routines"]
            if isinstance(r, dict)
        ]
        data["correlations"] = [
            _add_defaults(c, _TTL_STATISTICAL_HOURS, "statistical")
            for c in data["correlations"]
            if isinstance(c, dict)
        ]
        data["anomalies"] = [
            _add_defaults(a, _TTL_ANOMALY_HOURS, "statistical")
            for a in data["anomalies"]
            if isinstance(a, dict)
        ]
        return data

    def _save(self) -> None:
        try:
            with open(self._path, "w") as f:
                json.dump(self._data, f, indent=2)
        except Exception as e:
            _LOGGER.error("PatternStore: could not save %s: %s", self._path, e)

    def get_routines(self) -> list[dict]:
        return [r for r in self._data.get("routines", []) if not _is_expired(r)]

    def get_correlations(self) -> list[dict]:
        return [c for c in self._data.get("correlations", []) if not _is_expired(c)]

    def get_active_anomalies(self) -> list[dict]:
        return [a for a in self._data.get("anomalies", []) if not _is_expired(a)]

    def merge(self, patterns: dict) -> None:
        """Merge new patterns into the store. Overwrites by entity_id for routines/correlations."""
        now = _now_utc()
        if "routines" in patterns:
            incoming = [_add_defaults(r, _TTL_STATISTICAL_HOURS * 24, "statistical") for r in patterns["routines"]]
            existing = {r["entity_id"]: r for r in self._data.get("routines", [])}
            for r in incoming:
                ttl_hours = _TTL_ANTHROPIC_DAYS * 24 if r.get("source") == "anthropic" else _TTL_STATISTICAL_HOURS * 24
                r["expires_at"] = (now + timedelta(hours=ttl_hours)).isoformat()
                existing[r["entity_id"]] = r
            self._data["routines"] = list(existing.values())
        if "correlations" in patterns:
            incoming = [_add_defaults(c, _TTL_STATISTICAL_HOURS, "statistical") for c in patterns["correlations"]]
            key = lambda c: (c.get("entity_a"), c.get("entity_b"))
            existing = {key(c): c for c in self._data.get("correlations", [])}
            for c in incoming:
                ttl_hours = _TTL_ANTHROPIC_DAYS * 24 if c.get("source") == "anthropic" else _TTL_STATISTICAL_HOURS
                c["expires_at"] = (now + timedelta(hours=ttl_hours)).isoformat()
                existing[key(c)] = c
            self._data["correlations"] = list(existing.values())
        if "anomalies" in patterns:
            new_anomalies = []
            for a in patterns["anomalies"]:
                a = _add_defaults(a, _TTL_ANOMALY_HOURS, "statistical")
                if "expires_at" not in a or _parse_dt(a["expires_at"]) is None:
                    a["expires_at"] = (now + timedelta(hours=_TTL_ANOMALY_HOURS)).isoformat()
                new_anomalies.append(a)
            self._data["anomalies"] = new_anomalies
        self._data["updated_at"] = now.isoformat()
        self._save()

    def needs_fresh_analysis(self, analysis_depth_days: int = 14) -> bool:
        """Return True if no updated_at or it's older than analysis_depth_days."""
        updated_at = _parse_dt(self._data.get("updated_at", ""))
        if updated_at is None:
            return True
        return (_now_utc() - updated_at).total_seconds() > analysis_depth_days * 86400
```

- [ ] **Step 4: Run — verify PASS**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_pattern_store.py -v
```

Expected: all 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/src/pattern_store.py smart_suggestions/tests/test_pattern_store.py
git commit -m "feat: add PatternStore with TTL/decay and migration"
```

---

## Task 3: HAClient Updates

**Phase 2 — Run in parallel with Task 2.**

**Files:**
- Modify: `smart_suggestions/src/ha_client.py`
- Create: `smart_suggestions/tests/test_ha_client.py`

Changes:
1. Add `create_automation(config_dict)` — POST to `{HA_REST_BASE}/config/automation/config`
2. Remove `fetch_dow_history()` entirely (replaced by `fetch_history(days=N)` calls elsewhere)
3. `_ACTION_DOMAINS` import already fixed in Task 1

- [ ] **Step 1: Write failing tests**

```python
# smart_suggestions/tests/test_ha_client.py
import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from aiohttp import web


@pytest.mark.asyncio
async def test_create_automation_success():
    from ha_client import HAClient

    mock_resp = AsyncMock()
    mock_resp.status = 200
    mock_resp.json = AsyncMock(return_value={"automation_id": "abc123"})
    mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
    mock_resp.__aexit__ = AsyncMock(return_value=False)

    mock_session = MagicMock()
    mock_session.post = MagicMock(return_value=mock_resp)

    client = HAClient(on_states_ready=AsyncMock())
    client._session = mock_session

    result = await client.create_automation({"alias": "Test", "trigger": []})
    assert result["success"] is True
    assert result["automation_id"] == "abc123"
    mock_session.post.assert_called_once()
    call_url = str(mock_session.post.call_args[0][0])
    assert "/config/automation/config" in call_url


@pytest.mark.asyncio
async def test_create_automation_http_error():
    from ha_client import HAClient

    mock_resp = AsyncMock()
    mock_resp.status = 400
    mock_resp.text = AsyncMock(return_value="bad request")
    mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
    mock_resp.__aexit__ = AsyncMock(return_value=False)

    mock_session = MagicMock()
    mock_session.post = MagicMock(return_value=mock_resp)

    client = HAClient(on_states_ready=AsyncMock())
    client._session = mock_session

    result = await client.create_automation({"alias": "Test"})
    assert result["success"] is False
    assert "error" in result


@pytest.mark.asyncio
async def test_create_automation_no_session():
    from ha_client import HAClient

    client = HAClient(on_states_ready=AsyncMock())
    client._session = None

    result = await client.create_automation({"alias": "Test"})
    assert result["success"] is False


def test_fetch_dow_history_not_present():
    """fetch_dow_history must be removed — ensure it no longer exists on HAClient."""
    from ha_client import HAClient
    assert not hasattr(HAClient, "fetch_dow_history"), (
        "fetch_dow_history should have been removed from HAClient"
    )
```

- [ ] **Step 2: Run — verify FAIL**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_ha_client.py -v
```

Expected: `test_fetch_dow_history_not_present` FAIL (method still exists), others may error.

- [ ] **Step 3: Update ha_client.py**

Remove the entire `fetch_dow_history` method (lines 118–155 in current file).

Add `create_automation` method after `write_suggestions_state`:

```python
async def create_automation(self, config_dict: dict) -> dict:
    """Create a new HA automation via REST. Returns {success, automation_id} or {success, error}."""
    if not self._session:
        return {"success": False, "error": "No active session"}
    try:
        async with self._session.post(
            f"{HA_REST_BASE}/config/automation/config",
            json={"config": config_dict},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            if resp.status in (200, 201):
                data = await resp.json()
                return {"success": True, "automation_id": data.get("automation_id", "")}
            else:
                text = await resp.text()
                _LOGGER.warning("create_automation HTTP %s: %s", resp.status, text)
                return {"success": False, "error": f"HTTP {resp.status}: {text}"}
    except Exception as e:
        _LOGGER.error("create_automation failed: %s", e)
        return {"success": False, "error": str(e)}
```

- [ ] **Step 4: Run — verify PASS**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_ha_client.py -v
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/src/ha_client.py smart_suggestions/tests/test_ha_client.py
git commit -m "feat: add create_automation to HAClient, remove fetch_dow_history"
```

---

## Task 4: StatisticalEngine

**Phase 3 — Run in parallel with Tasks 5 and 6. Requires Tasks 1 + 2.**

**Files:**
- Create: `smart_suggestions/src/statistical_engine.py`
- Create: `smart_suggestions/tests/test_statistical_engine.py`

Two paths:
1. **Real-time** (`score_realtime`): uses PatternStore routines + scene match ratio on current states. Fast, no history scan.
2. **Background** (`analyze_correlations`): O(n²) co-occurrence scan on N-day history. Called from `main.py` as a background task every `analysis_interval_hours`.

- [ ] **Step 1: Write failing tests**

```python
# smart_suggestions/tests/test_statistical_engine.py
from datetime import datetime, timezone, timedelta
import pytest
from unittest.mock import MagicMock
from statistical_engine import StatisticalEngine, score_scene_match


def make_state(entity_id: str, state: str, attributes: dict | None = None) -> dict:
    return {
        "entity_id": entity_id,
        "state": state,
        "attributes": attributes or {"friendly_name": entity_id.split(".")[1]},
        "last_changed": datetime.now(timezone.utc).isoformat(),
    }


def make_routine(entity_id: str, typical_time: str, days: list, confidence: float = 0.8) -> dict:
    from datetime import timezone, timedelta
    return {
        "name": f"Test routine {entity_id}",
        "entity_id": entity_id,
        "typical_time": typical_time,
        "days": days,
        "confidence": confidence,
        "source": "anthropic",
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
    }


def test_score_scene_match_full_match():
    states = {
        "scene.evening": {
            "entity_id": "scene.evening",
            "state": "scening",
            "attributes": {
                "friendly_name": "Evening",
                "entities": {
                    "light.living_room": {"state": "on"},
                    "light.kitchen": {"state": "off"},
                }
            },
            "last_changed": datetime.now(timezone.utc).isoformat(),
        },
        "light.living_room": make_state("light.living_room", "on"),
        "light.kitchen": make_state("light.kitchen", "off"),
    }
    ratio = score_scene_match("scene.evening", states)
    assert ratio == 1.0


def test_score_scene_match_partial():
    states = {
        "scene.evening": {
            "entity_id": "scene.evening",
            "state": "scening",
            "attributes": {
                "friendly_name": "Evening",
                "entities": {
                    "light.living_room": {"state": "on"},
                    "light.kitchen": {"state": "off"},
                }
            },
            "last_changed": datetime.now(timezone.utc).isoformat(),
        },
        "light.living_room": make_state("light.living_room", "on"),
        "light.kitchen": make_state("light.kitchen", "on"),  # wrong state
    }
    ratio = score_scene_match("scene.evening", states)
    assert ratio == 0.5


def test_score_scene_match_no_attributes():
    states = {
        "scene.empty": {
            "entity_id": "scene.empty",
            "state": "scening",
            "attributes": {},
            "last_changed": datetime.now(timezone.utc).isoformat(),
        }
    }
    ratio = score_scene_match("scene.empty", states)
    assert ratio == 0.0


def test_score_realtime_returns_scene_candidates(tmp_path):
    from pattern_store import PatternStore
    store = PatternStore(path=str(tmp_path / "patterns.json"))

    # Add a routine for scene.evening matching current day/time
    now = datetime.now()
    day_abbrev = now.strftime("%a")  # Mon, Tue, etc.
    typical_time = now.strftime("%H:%M")
    store.merge({"routines": [
        make_routine("scene.evening", typical_time, [day_abbrev])
    ], "correlations": [], "anomalies": []})

    states = {
        "scene.evening": {
            "entity_id": "scene.evening",
            "state": "scening",
            "attributes": {"friendly_name": "Evening", "entities": {}},
            "last_changed": datetime.now(timezone.utc).isoformat(),
        }
    }
    engine = StatisticalEngine(store)
    candidates = engine.score_realtime(states)
    assert any(c["entity_id"] == "scene.evening" for c in candidates)
    scene_cand = next(c for c in candidates if c["entity_id"] == "scene.evening")
    assert scene_cand["score"] > 0
    assert scene_cand["type"] == "scene"


def test_score_realtime_wrong_day_routine_not_boosted(tmp_path):
    """Routine for a different day should not boost score."""
    from pattern_store import PatternStore
    store = PatternStore(path=str(tmp_path / "patterns.json"))

    now = datetime.now()
    # Use a day that is NOT today
    all_days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    today_abbrev = now.strftime("%a")
    other_day = next(d for d in all_days if d != today_abbrev)
    typical_time = now.strftime("%H:%M")

    store.merge({"routines": [
        make_routine("scene.morning", typical_time, [other_day])
    ], "correlations": [], "anomalies": []})

    states = {
        "scene.morning": {
            "entity_id": "scene.morning",
            "state": "scening",
            "attributes": {"friendly_name": "Morning", "entities": {}},
            "last_changed": datetime.now(timezone.utc).isoformat(),
        }
    }
    engine = StatisticalEngine(store)
    candidates = engine.score_realtime(states)
    scene_cand = next((c for c in candidates if c["entity_id"] == "scene.morning"), None)
    # May appear (scene match path) but should not have high routine-based score
    if scene_cand:
        assert scene_cand.get("routine_match") is False or scene_cand["score"] < 50
```

- [ ] **Step 2: Run — verify FAIL**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_statistical_engine.py -v
```

Expected: `ModuleNotFoundError: No module named 'statistical_engine'`

- [ ] **Step 3: Implement statistical_engine.py**

```python
# smart_suggestions/src/statistical_engine.py
"""Deterministic scoring engine — no LLM. Real-time + background paths."""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import TYPE_CHECKING

from const import _ACTION_DOMAINS, _INACTIVE_STATES

if TYPE_CHECKING:
    from pattern_store import PatternStore

_LOGGER = logging.getLogger(__name__)

_ROUTINE_WINDOW_MINUTES = 30
_SCENE_MATCH_THRESHOLD = 0.6
_DAY_ABBREV_MAP = {0: "Mon", 1: "Tue", 2: "Wed", 3: "Thu", 4: "Fri", 5: "Sat", 6: "Sun"}


def score_scene_match(scene_eid: str, states: dict) -> float:
    """Return fraction of scene members already in their target state (0.0–1.0)."""
    scene_state = states.get(scene_eid, {})
    attrs = scene_state.get("attributes", {})
    entities_dict: dict = attrs.get("entities", {})
    if not entities_dict:
        return 0.0
    matching = sum(
        1 for member_eid, target in entities_dict.items()
        if isinstance(target, dict)
        and states.get(member_eid, {}).get("state") == target.get("state")
    )
    return round(matching / len(entities_dict), 2)


def _time_diff_minutes(t1: str, t2: str) -> float:
    """Return absolute minute difference between two HH:MM strings (circular, max 12h)."""
    try:
        h1, m1 = (int(x) for x in t1.split(":"))
        h2, m2 = (int(x) for x in t2.split(":"))
        total1 = h1 * 60 + m1
        total2 = h2 * 60 + m2
        diff = abs(total1 - total2)
        return min(diff, 1440 - diff)
    except (ValueError, AttributeError):
        return 999.0


def _routine_matches_now(routine: dict, now: datetime) -> tuple[bool, float]:
    """Return (matches, score_boost 0–40)."""
    today_abbrev = _DAY_ABBREV_MAP.get(now.weekday(), "")
    if today_abbrev not in routine.get("days", []):
        return False, 0.0
    current_time = now.strftime("%H:%M")
    diff = _time_diff_minutes(routine.get("typical_time", ""), current_time)
    if diff > _ROUTINE_WINDOW_MINUTES:
        return False, 0.0
    # Score: max 40 pts at 0 diff, scaling to 0 at window edge
    boost = max(0.0, 40.0 * (1.0 - diff / _ROUTINE_WINDOW_MINUTES))
    confidence = routine.get("confidence", 0.5)
    return True, round(boost * confidence, 1)


class StatisticalEngine:
    def __init__(self, pattern_store: "PatternStore", confidence_threshold: float = 0.6) -> None:
        self._store = pattern_store
        self._confidence_threshold = confidence_threshold

    def score_realtime(self, states: dict) -> list[dict]:
        """Score all actionable entities. Scenes first. Returns sorted candidate list."""
        now = datetime.now()
        routines_by_eid = {r["entity_id"]: r for r in self._store.get_routines()}
        correlations = self._store.get_correlations()
        anomalies_by_eid = {a["entity_id"]: a for a in self._store.get_active_anomalies()}

        candidates = []

        for eid, state in states.items():
            domain = eid.split(".")[0]
            if domain not in _ACTION_DOMAINS:
                continue
            s = state.get("state", "")
            if s in ("unavailable", "unknown", ""):
                continue

            score = 0.0
            routine_match = False
            match_ratio = 0.0
            reason_parts = []

            # Scene-specific scoring
            if domain == "scene":
                match_ratio = score_scene_match(eid, states)
                if match_ratio >= _SCENE_MATCH_THRESHOLD:
                    score += match_ratio * 30
                    reason_parts.append(f"{int(match_ratio * 100)}% of members already in target state")

            # Routine match boost
            if eid in routines_by_eid:
                routine = routines_by_eid[eid]
                routine_match, boost = _routine_matches_now(routine, now)
                if routine_match:
                    score += boost
                    reason_parts.append(f"you usually do this around {routine.get('typical_time')} on {routine.get('days', [])}")

            # Anomaly boost
            if eid in anomalies_by_eid:
                anomaly = anomalies_by_eid[eid]
                score += 15
                reason_parts.append(anomaly.get("description", "unusual state"))

            # Active correlation boost — if entity_a is active, boost entity_b
            for corr in correlations:
                if corr.get("entity_b") == eid:
                    entity_a_state = states.get(corr.get("entity_a", ""), {}).get("state", "")
                    if entity_a_state not in _INACTIVE_STATES and entity_a_state not in ("unavailable", "unknown", ""):
                        score += corr.get("confidence", 0.5) * 20
                        reason_parts.append(corr.get("pattern", "correlated with active device"))

            # Only include entities with some signal
            if score > 0 or domain == "scene":
                name = state.get("attributes", {}).get("friendly_name", eid)
                candidates.append({
                    "entity_id": eid,
                    "name": name,
                    "domain": domain,
                    "type": "scene" if domain == "scene" else (
                        "automation" if domain == "automation" else
                        "script" if domain == "script" else "entity"
                    ),
                    "current_state": s,
                    "score": round(score, 1),
                    "match_ratio": match_ratio,
                    "routine_match": routine_match,
                    "reason": "; ".join(reason_parts) if reason_parts else "",
                    "can_save_as_automation": (
                        domain == "scene"
                        and routine_match
                        and eid in routines_by_eid
                        and routines_by_eid[eid].get("confidence", 0) >= self._confidence_threshold
                    ),
                    "automation_context": (
                        {
                            "typical_time": routines_by_eid[eid].get("typical_time"),
                            "days": routines_by_eid[eid].get("days", []),
                        }
                        if domain == "scene" and eid in routines_by_eid else None
                    ),
                })

        # Sort: scenes first (by score), then others
        candidates.sort(key=lambda c: (c["type"] != "scene", -c["score"]))
        return candidates

    async def analyze_correlations(self, history: dict, states: dict, window_minutes: int = 5) -> list[dict]:
        """Background task: scan history for co-occurrence correlations. O(n²) — run infrequently."""
        from const import _ACTION_DOMAINS as DOMAINS  # noqa
        # Filter to actionable entities with history
        action_eids = [
            eid for eid in history
            if eid.split(".")[0] in DOMAINS and len(history[eid]) > 1
        ]

        # Build event timeline: (timestamp, entity_id, state) sorted by time
        events = []
        for eid in action_eids:
            for entry in history[eid]:
                ts_str = entry.get("last_changed", "")
                if not ts_str:
                    continue
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    events.append((ts, eid, entry.get("state", "")))
                except (ValueError, TypeError):
                    continue
        events.sort(key=lambda e: e[0])

        # Count co-occurrence within window
        co_counts: dict[tuple, int] = defaultdict(int)
        total_counts: dict[str, int] = defaultdict(int)
        window = timedelta(minutes=window_minutes)

        for i, (ts_a, eid_a, state_a) in enumerate(events):
            if state_a in _INACTIVE_STATES or state_a in ("unavailable", "unknown"):
                continue
            total_counts[eid_a] += 1
            for j in range(i + 1, len(events)):
                ts_b, eid_b, state_b = events[j]
                if ts_b - ts_a > window:
                    break
                if eid_b != eid_a and state_b not in _INACTIVE_STATES:
                    co_counts[(eid_a, eid_b)] += 1

        correlations = []
        for (eid_a, eid_b), count in co_counts.items():
            if count < 3:  # minimum 3 occurrences
                continue
            total_a = total_counts.get(eid_a, 1)
            confidence = round(min(count / total_a, 1.0), 2)
            if confidence < 0.4:
                continue
            name_a = states.get(eid_a, {}).get("attributes", {}).get("friendly_name", eid_a)
            name_b = states.get(eid_b, {}).get("attributes", {}).get("friendly_name", eid_b)
            correlations.append({
                "entity_a": eid_a,
                "entity_b": eid_b,
                "pattern": f"{name_b} often changes within {window_minutes}min of {name_a}",
                "confidence": confidence,
                "window_minutes": window_minutes,
                "source": "statistical",
            })

        _LOGGER.info("Correlation scan: %d correlations found from %d entities", len(correlations), len(action_eids))
        return correlations
```

- [ ] **Step 4: Run — verify PASS**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_statistical_engine.py -v
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/src/statistical_engine.py smart_suggestions/tests/test_statistical_engine.py
git commit -m "feat: add StatisticalEngine — real-time scoring + background correlation scan"
```

---

## Task 5: AnthropicAnalyzer

**Phase 3 — Run in parallel with Tasks 4 and 6. Requires Task 2.**

**Files:**
- Create: `smart_suggestions/src/anthropic_analyzer.py`
- Create: `smart_suggestions/tests/test_anthropic_analyzer.py`

**Provider support:** `ai_provider = "anthropic"` uses `anthropic` SDK; `ai_provider = "openai_compatible"` uses `openai` SDK with custom `base_url`. Both must be installable via pip (added to Dockerfile in Task 12).

**Prompt contract:** Returns JSON only — `{routines, correlations, anomalies}`. Tight structured prompt, no markdown.

- [ ] **Step 1: Write failing tests**

```python
# smart_suggestions/tests/test_anthropic_analyzer.py
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from anthropic_analyzer import AnthropicAnalyzer, _compact_history


def make_history(entity_id: str, states: list[str]) -> dict:
    from datetime import datetime, timezone, timedelta
    entries = []
    base = datetime.now(timezone.utc)
    for i, s in enumerate(states):
        entries.append({
            "entity_id": entity_id,
            "state": s,
            "last_changed": (base - timedelta(hours=len(states) - i)).isoformat(),
        })
    return {entity_id: entries}


def test_compact_history_excludes_unchanged_entities():
    history = {}
    history.update(make_history("light.kitchen", ["on", "on", "on"]))  # no changes
    history.update(make_history("light.living_room", ["on", "off", "on"]))  # has changes
    states = {
        "light.kitchen": {"attributes": {"friendly_name": "Kitchen Light"}},
        "light.living_room": {"attributes": {"friendly_name": "Living Room"}},
    }
    compact = _compact_history(history, states)
    assert "light.kitchen" not in compact
    assert "light.living_room" in compact


def test_compact_history_excludes_non_action_domains():
    history = make_history("sensor.temperature", ["20", "21", "22"])
    states = {"sensor.temperature": {"attributes": {"friendly_name": "Temp"}}}
    compact = _compact_history(history, states)
    assert "sensor.temperature" not in compact


@pytest.mark.asyncio
async def test_analyze_anthropic_provider_returns_patterns():
    valid_response = json.dumps({
        "routines": [
            {
                "name": "Evening Scene",
                "entity_id": "scene.evening",
                "typical_time": "18:30",
                "days": ["Mon", "Tue"],
                "confidence": 0.85,
            }
        ],
        "correlations": [],
        "anomalies": [],
    })

    mock_message = MagicMock()
    mock_message.content = [MagicMock(text=valid_response)]

    mock_client = MagicMock()
    mock_client.messages = MagicMock()
    mock_client.messages.create = MagicMock(return_value=mock_message)

    history = {}
    history.update(make_history("scene.evening", ["scening", "scening"]))
    states = {"scene.evening": {"attributes": {"friendly_name": "Evening"}}}

    analyzer = AnthropicAnalyzer(
        ai_provider="anthropic",
        ai_api_key="test-key",
        ai_model="claude-opus-4-5",
        analysis_depth_days=7,
    )
    analyzer._client = mock_client

    patterns = await analyzer.analyze(history, states)
    assert len(patterns["routines"]) == 1
    assert patterns["routines"][0]["entity_id"] == "scene.evening"


@pytest.mark.asyncio
async def test_analyze_returns_empty_on_no_history():
    analyzer = AnthropicAnalyzer(
        ai_provider="anthropic",
        ai_api_key="test-key",
        ai_model="claude-opus-4-5",
        analysis_depth_days=7,
    )
    patterns = await analyzer.analyze({}, {})
    assert patterns == {"routines": [], "correlations": [], "anomalies": []}


@pytest.mark.asyncio
async def test_analyze_handles_json_parse_error(caplog):
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text="this is not json")]

    mock_client = MagicMock()
    mock_client.messages = MagicMock()
    mock_client.messages.create = MagicMock(return_value=mock_message)

    history = {}
    history.update(make_history("light.kitchen", ["on", "off", "on"]))
    states = {"light.kitchen": {"attributes": {"friendly_name": "Kitchen"}}}

    analyzer = AnthropicAnalyzer(
        ai_provider="anthropic",
        ai_api_key="test-key",
        ai_model="claude-opus-4-5",
        analysis_depth_days=7,
    )
    analyzer._client = mock_client

    patterns = await analyzer.analyze(history, states)
    assert patterns == {"routines": [], "correlations": [], "anomalies": []}
```

- [ ] **Step 2: Run — verify FAIL**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_anthropic_analyzer.py -v
```

Expected: `ModuleNotFoundError: No module named 'anthropic_analyzer'`

- [ ] **Step 3: Install anthropic SDK locally for tests**

```bash
pip install anthropic openai
```

- [ ] **Step 4: Implement anthropic_analyzer.py**

```python
# smart_suggestions/src/anthropic_analyzer.py
"""Nightly deep pattern analysis via Anthropic (or OpenAI-compatible) API."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

from const import _ACTION_DOMAINS

_LOGGER = logging.getLogger(__name__)

_EMPTY: dict = {"routines": [], "correlations": [], "anomalies": []}
_MAX_HISTORY_ENTRIES = 8


def _summarise_history(entries: list) -> str:
    """Compact state transition string."""
    if not entries:
        return ""
    deduped = [entries[0]]
    for e in entries[1:]:
        if e.get("state") != deduped[-1].get("state"):
            deduped.append(e)
    deduped = deduped[-_MAX_HISTORY_ENTRIES:]
    parts = []
    for e in deduped:
        ts = e.get("last_changed", "")[:16].replace("T", " ")
        parts.append(f"{e.get('state', '?')} at {ts}")
    return " → ".join(parts)


def _compact_history(history: dict, states: dict) -> dict:
    """Return compact summary — only actionable entities with state changes."""
    out = {}
    for eid, entries in history.items():
        domain = eid.split(".")[0]
        if domain not in _ACTION_DOMAINS:
            continue
        if not entries:
            continue
        states_seen = {e.get("state") for e in entries}
        if len(states_seen) < 2:
            continue
        summary = _summarise_history(entries)
        if summary:
            name = states.get(eid, {}).get("attributes", {}).get("friendly_name", eid)
            out[eid] = {"name": name, "history": summary}
    return out


def _build_prompt(compact: dict, now: datetime) -> str:
    history_json = json.dumps(compact, indent=2)
    day_of_week = now.strftime("%A")
    current_time = now.strftime("%H:%M")
    return f"""Analyze this smart home entity history and extract behavioral patterns.

CURRENT TIME: {current_time} on {day_of_week}

ENTITY HISTORY (state transitions):
{history_json}

Return ONLY a valid JSON object (no markdown, no explanation):

{{
  "routines": [
    {{
      "name": "string",
      "entity_id": "exact_entity_id_from_history",
      "typical_time": "HH:MM",
      "days": ["Mon","Tue","Wed","Thu","Fri"],
      "confidence": 0.0
    }}
  ],
  "correlations": [
    {{
      "entity_a": "exact_entity_id",
      "entity_b": "exact_entity_id",
      "pattern": "one sentence description",
      "confidence": 0.0,
      "window_minutes": 5
    }}
  ],
  "anomalies": [
    {{
      "entity_id": "exact_entity_id",
      "description": "one sentence",
      "severity": "low|medium|high"
    }}
  ]
}}

Rules:
- Only patterns with 3+ occurrences
- Use exact entity_ids from the history data
- Return empty arrays if no confident patterns found
- Max 5 items per category
- Days use 3-letter abbreviations: Mon,Tue,Wed,Thu,Fri,Sat,Sun"""


class AnthropicAnalyzer:
    def __init__(
        self,
        ai_provider: str,
        ai_api_key: str,
        ai_model: str,
        analysis_depth_days: int = 14,
        ai_base_url: str = "",
    ) -> None:
        self._provider = ai_provider
        self._model = ai_model
        self._depth = analysis_depth_days
        self._client: Any = None
        if ai_api_key:
            self._init_client(ai_provider, ai_api_key, ai_base_url)

    def _init_client(self, provider: str, api_key: str, base_url: str = "") -> None:
        try:
            if provider == "anthropic":
                import anthropic
                self._client = anthropic.Anthropic(api_key=api_key)
            elif provider == "openai_compatible":
                import openai
                self._client = openai.OpenAI(api_key=api_key, base_url=base_url or None)
            else:
                _LOGGER.warning("Unknown AI provider: %s", provider)
        except ImportError as e:
            _LOGGER.error("Could not import AI SDK for provider %s: %s", provider, e)

    async def analyze(self, history: dict, states: dict) -> dict:
        """Run deep analysis. Returns structured pattern dict or empty on failure."""
        compact = _compact_history(history, states)
        if not compact:
            _LOGGER.info("AnthropicAnalyzer: no actionable history to analyze")
            return dict(_EMPTY)

        if not self._client:
            _LOGGER.warning("AnthropicAnalyzer: no AI client configured — skipping")
            return dict(_EMPTY)

        now = datetime.now()
        prompt = _build_prompt(compact, now)
        _LOGGER.info("AnthropicAnalyzer: analyzing %d entities with %s/%s", len(compact), self._provider, self._model)

        try:
            raw = await asyncio.get_running_loop().run_in_executor(
                None, self._call_api, prompt
            )
            return self._parse(raw)
        except Exception as e:
            _LOGGER.warning("AnthropicAnalyzer: unexpected error: %s", e)
            return dict(_EMPTY)

    def _call_api(self, prompt: str) -> str:
        if self._provider == "anthropic":
            message = self._client.messages.create(
                model=self._model,
                max_tokens=1024,
                messages=[{"role": "user", "content": prompt}],
            )
            return message.content[0].text
        else:
            # OpenAI-compatible
            response = self._client.chat.completions.create(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=1024,
            )
            return response.choices[0].message.content

    def _parse(self, raw: str) -> dict:
        try:
            clean = raw.strip()
            if clean.startswith("```"):
                parts = clean.split("```")
                clean = parts[1] if len(parts) > 1 else clean
                if clean.startswith("json"):
                    clean = clean[4:]
            parsed = json.loads(clean.strip())
            if not isinstance(parsed, dict):
                return dict(_EMPTY)
            return {
                "routines": parsed.get("routines", []),
                "correlations": parsed.get("correlations", []),
                "anomalies": parsed.get("anomalies", []),
            }
        except json.JSONDecodeError as e:
            _LOGGER.warning("AnthropicAnalyzer: JSON parse error: %s | raw: %.300s", e, raw)
            return dict(_EMPTY)
```

- [ ] **Step 5: Run — verify PASS**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_anthropic_analyzer.py -v
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/src/anthropic_analyzer.py smart_suggestions/tests/test_anthropic_analyzer.py
git commit -m "feat: add AnthropicAnalyzer — nightly pattern analysis, configurable provider"
```

---

## Task 6: OllamaNarrator

**Phase 3 — Run in parallel with Tasks 4 and 5.**

**Files:**
- Create: `smart_suggestions/src/ollama_narrator.py`
- Create: `smart_suggestions/tests/test_ollama_narrator.py`

**Contract:** Takes pre-ranked candidates list, returns same list with `reason` fields rewritten. Cannot reorder or remove candidates. Falls back to original reasons on any failure.

- [ ] **Step 1: Write failing tests**

```python
# smart_suggestions/tests/test_ollama_narrator.py
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from ollama_narrator import OllamaNarrator


def make_candidate(entity_id: str, reason: str = "test reason") -> dict:
    return {
        "entity_id": entity_id,
        "name": entity_id.split(".")[1].replace("_", " ").title(),
        "type": "scene",
        "confidence": "high",
        "reason": reason,
    }


@pytest.mark.asyncio
async def test_narrate_rewrites_reasons():
    narrator = OllamaNarrator(ollama_url="http://localhost:11434", model="llama3.2")
    candidates = [make_candidate("scene.evening", "you usually do this")]

    new_reasons = [{"entity_id": "scene.evening", "reason": "Your living room is ready for Evening Scene."}]

    with patch.object(narrator, "_call_ollama", new=AsyncMock(return_value=json.dumps(new_reasons))):
        result = await narrator.narrate(candidates)

    assert result[0]["entity_id"] == "scene.evening"
    assert result[0]["reason"] == "Your living room is ready for Evening Scene."


@pytest.mark.asyncio
async def test_narrate_falls_back_on_ollama_failure():
    narrator = OllamaNarrator(ollama_url="http://localhost:11434", model="llama3.2")
    candidates = [make_candidate("scene.evening", "original reason")]

    with patch.object(narrator, "_call_ollama", new=AsyncMock(side_effect=Exception("connection refused"))):
        result = await narrator.narrate(candidates)

    assert result[0]["reason"] == "original reason"


@pytest.mark.asyncio
async def test_narrate_falls_back_on_bad_json():
    narrator = OllamaNarrator(ollama_url="http://localhost:11434", model="llama3.2")
    candidates = [make_candidate("scene.evening", "original reason")]

    with patch.object(narrator, "_call_ollama", new=AsyncMock(return_value="not valid json")):
        result = await narrator.narrate(candidates)

    assert result[0]["reason"] == "original reason"


@pytest.mark.asyncio
async def test_narrate_preserves_candidate_count_and_order():
    """Ollama cannot remove or reorder candidates."""
    narrator = OllamaNarrator(ollama_url="http://localhost:11434", model="llama3.2")
    candidates = [
        make_candidate("scene.evening", "reason 1"),
        make_candidate("light.kitchen", "reason 2"),
    ]
    # Ollama returns only one item (fewer than input)
    partial = json.dumps([{"entity_id": "scene.evening", "reason": "Better reason"}])

    with patch.object(narrator, "_call_ollama", new=AsyncMock(return_value=partial)):
        result = await narrator.narrate(candidates)

    assert len(result) == 2
    assert result[0]["entity_id"] == "scene.evening"
    assert result[0]["reason"] == "Better reason"
    assert result[1]["reason"] == "reason 2"  # fallback for missing


@pytest.mark.asyncio
async def test_narrate_empty_candidates_returns_empty():
    narrator = OllamaNarrator(ollama_url="http://localhost:11434", model="llama3.2")
    result = await narrator.narrate([])
    assert result == []
```

- [ ] **Step 2: Run — verify FAIL**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_ollama_narrator.py -v
```

Expected: `ModuleNotFoundError: No module named 'ollama_narrator'`

- [ ] **Step 3: Implement ollama_narrator.py**

```python
# smart_suggestions/src/ollama_narrator.py
"""Constrained Ollama wrapper — rewrites 'reason' fields only. No ranking."""
from __future__ import annotations

import json
import logging

import aiohttp

_LOGGER = logging.getLogger(__name__)
_TIMEOUT = aiohttp.ClientTimeout(total=30)


class OllamaNarrator:
    def __init__(self, ollama_url: str, model: str) -> None:
        self._url = ollama_url.rstrip("/")
        self._model = model

    async def narrate(self, candidates: list[dict]) -> list[dict]:
        """Rewrite 'reason' fields for all candidates. Returns candidates unchanged on any failure."""
        if not candidates:
            return []
        try:
            raw = await self._call_ollama(candidates)
            return self._apply_reasons(candidates, raw)
        except Exception as e:
            _LOGGER.warning("OllamaNarrator: failed, using original reasons: %s", e)
            return candidates

    async def _call_ollama(self, candidates: list[dict]) -> str:
        now_str = __import__("datetime").datetime.now().strftime("%H:%M on %A")
        input_json = json.dumps([
            {"entity_id": c["entity_id"], "name": c["name"], "type": c.get("type"), "reason": c.get("reason", "")}
            for c in candidates
        ], indent=2)
        prompt = f"""It is {now_str}. Rewrite the 'reason' field for each smart home suggestion to be natural and specific. Keep it to one sentence.

SUGGESTIONS:
{input_json}

Return ONLY a valid JSON array (no markdown):
[{{"entity_id": "...", "reason": "..."}}]

One object per input item, in the same order. Do not add or remove items."""

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self._url}/api/generate",
                json={"model": self._model, "prompt": prompt, "stream": False},
                timeout=_TIMEOUT,
            ) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"Ollama returned HTTP {resp.status}")
                data = await resp.json()
                return data.get("response", "")

    def _apply_reasons(self, candidates: list[dict], raw: str) -> list[dict]:
        """Apply narrated reasons. Falls back to original for any missing/failed items."""
        try:
            clean = raw.strip()
            if clean.startswith("```"):
                parts = clean.split("```")
                clean = parts[1] if len(parts) > 1 else clean
                if clean.startswith("json"):
                    clean = clean[4:]
            narrated = json.loads(clean.strip())
            if not isinstance(narrated, list):
                return candidates
            narrated_by_eid = {item["entity_id"]: item["reason"] for item in narrated if "entity_id" in item and "reason" in item}
            result = []
            for c in candidates:
                updated = dict(c)
                if c["entity_id"] in narrated_by_eid:
                    updated["reason"] = narrated_by_eid[c["entity_id"]]
                result.append(updated)
            return result
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            _LOGGER.warning("OllamaNarrator: could not parse response: %s", e)
            return candidates
```

- [ ] **Step 4: Run — verify PASS**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_ollama_narrator.py -v
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/src/ollama_narrator.py smart_suggestions/tests/test_ollama_narrator.py
git commit -m "feat: add OllamaNarrator — constrained reason rewriter, no ranking"
```

---

## Task 7: SceneEngine

**Phase 4 — Run in parallel with Task 8. Requires Tasks 4 + 5.**

**Files:**
- Create: `smart_suggestions/src/scene_engine.py`
- Create: `smart_suggestions/tests/test_scene_engine.py`

**Responsibility:** Take `StatisticalEngine` candidate list + feedback dict → apply feedback filtering → produce final ranked list. Scenes always ranked before device suggestions. `_remove_noops` applied here (replaces existing logic in `main.py`).

- [ ] **Step 1: Write failing tests**

```python
# smart_suggestions/tests/test_scene_engine.py
import pytest
from scene_engine import SceneEngine, _remove_noops


def make_candidate(entity_id: str, score: float, type_: str = "entity", routine_match: bool = False) -> dict:
    domain = entity_id.split(".")[0]
    return {
        "entity_id": entity_id,
        "name": entity_id.split(".")[1],
        "domain": domain,
        "type": type_ if type_ != "entity" else ("scene" if domain == "scene" else "entity"),
        "current_state": "off",
        "score": score,
        "match_ratio": 0.0,
        "routine_match": routine_match,
        "reason": "test reason",
        "can_save_as_automation": routine_match and domain == "scene",
        "automation_context": None,
    }


def test_scenes_ranked_before_entities():
    engine = SceneEngine(max_suggestions=5)
    candidates = [
        make_candidate("light.kitchen", score=80),
        make_candidate("scene.evening", score=50, type_="scene"),
    ]
    result = engine.rank(candidates, states={}, feedback={})
    assert result[0]["entity_id"] == "scene.evening"


def test_max_suggestions_respected():
    engine = SceneEngine(max_suggestions=3, confidence_threshold=0.6)
    candidates = [make_candidate(f"light.l{i}", score=float(10 - i)) for i in range(10)]
    result = engine.rank(candidates, states={}, feedback={})
    assert len(result) <= 3


def test_hard_downvoted_entity_excluded():
    """Net vote of -3 or worse is excluded (boundary: exactly -3 excluded)."""
    engine = SceneEngine(max_suggestions=5)
    candidates = [make_candidate("light.kitchen", score=80)]
    # Exactly at boundary (-3): must be excluded
    feedback = {"light.kitchen": {"up": 0, "down": 3}}
    result = engine.rank(candidates, states={"light.kitchen": {"state": "off"}}, feedback=feedback)
    assert not any(c["entity_id"] == "light.kitchen" for c in result)


def test_two_downvotes_not_excluded():
    """Net vote of -2 should NOT be excluded."""
    engine = SceneEngine(max_suggestions=5)
    candidates = [make_candidate("light.kitchen", score=80)]
    feedback = {"light.kitchen": {"up": 0, "down": 2}}
    result = engine.rank(candidates, states={}, feedback=feedback)
    assert any(c["entity_id"] == "light.kitchen" for c in result)


def test_upvoted_entity_gets_score_boost():
    engine = SceneEngine(max_suggestions=5)
    candidates = [
        make_candidate("light.kitchen", score=50),
        make_candidate("light.bedroom", score=55),
    ]
    feedback = {"light.kitchen": {"up": 3, "down": 0}}
    result = engine.rank(candidates, states={}, feedback=feedback)
    kitchen = next(c for c in result if c["entity_id"] == "light.kitchen")
    bedroom = next(c for c in result if c["entity_id"] == "light.bedroom")
    assert kitchen["score"] > bedroom["score"]


def test_remove_noops_filters_already_on():
    states = {"light.kitchen": {"state": "on"}}
    candidates = [{"entity_id": "light.kitchen", "action": "turn_on", "current_state": "on"}]
    result = _remove_noops(candidates, states)
    assert result == []


def test_remove_noops_passes_scenes():
    """Scene activate actions are never filtered as noops."""
    states = {"scene.evening": {"state": "scening"}}
    candidates = [{"entity_id": "scene.evening", "action": "activate", "current_state": "scening"}]
    result = _remove_noops(candidates, states)
    assert len(result) == 1


def test_confidence_label_assigned():
    engine = SceneEngine(max_suggestions=5)
    candidates = [
        make_candidate("scene.evening", score=85, type_="scene", routine_match=True),
        make_candidate("light.kitchen", score=30),
    ]
    result = engine.rank(candidates, states={}, feedback={})
    scene = next(c for c in result if c["entity_id"] == "scene.evening")
    assert scene["confidence"] in ("high", "medium", "low")
```

- [ ] **Step 2: Run — verify FAIL**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_scene_engine.py -v
```

- [ ] **Step 3: Implement scene_engine.py**

```python
# smart_suggestions/src/scene_engine.py
"""Scene-first suggestion ranking. Applies feedback, noop filter, confidence labels."""
from __future__ import annotations

import logging

_LOGGER = logging.getLogger(__name__)


def _remove_noops(candidates: list[dict], states: dict) -> list[dict]:
    """Remove turn_on/turn_off suggestions that match current state. Scenes are never filtered."""
    out = []
    for c in candidates:
        action = c.get("action", "")
        eid = c.get("entity_id", "")
        current = states.get(eid, {}).get("state", "")
        if action == "turn_off" and current == "off":
            continue
        if action == "turn_on" and current == "on":
            continue
        out.append(c)
    return out


def _confidence_label(score: float, routine_match: bool) -> str:
    if routine_match or score >= 70:
        return "high"
    if score >= 40:
        return "medium"
    return "low"


class SceneEngine:
    def __init__(self, max_suggestions: int = 7, confidence_threshold: float = 0.6) -> None:
        self._max = max_suggestions
        self._confidence_threshold = confidence_threshold

    def rank(self, candidates: list[dict], states: dict, feedback: dict) -> list[dict]:
        """Apply feedback + noop filter, sort scenes first, return top N."""
        # Apply feedback signals
        scored = []
        for c in candidates:
            eid = c["entity_id"]
            fb = feedback.get(eid, {})
            net = 0
            if isinstance(fb, dict):
                net = fb.get("up", 0) - fb.get("down", 0)
            # Hard exclude: net vote ≤ -3
            if net <= -3:
                _LOGGER.info("Excluding hard-downvoted entity: %s", eid)
                continue
            updated = dict(c)
            updated["score"] = c.get("score", 0) + (net * 8 if net > 0 else net * 10)
            updated["confidence"] = _confidence_label(updated["score"], c.get("routine_match", False))
            # Assign action if not already set
            if "action" not in updated:
                if updated.get("domain") == "scene":
                    updated["action"] = "activate"
                elif updated.get("current_state") == "on":
                    updated["action"] = "turn_off"
                else:
                    updated["action"] = "turn_on"
            scored.append(updated)

        # Remove noops
        scored = _remove_noops(scored, states)

        # Sort: scenes first (by score), then others (by score)
        scored.sort(key=lambda c: (c.get("type") != "scene", -c.get("score", 0)))

        return scored[:self._max]
```

- [ ] **Step 4: Run — verify PASS**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_scene_engine.py -v
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/src/scene_engine.py smart_suggestions/tests/test_scene_engine.py
git commit -m "feat: add SceneEngine — scene-first ranking, feedback, noop filter"
```

---

## Task 8: AutomationBuilder

**Phase 4 — Run in parallel with Task 7. Requires Tasks 3 + 5.**

**Files:**
- Create: `smart_suggestions/src/automation_builder.py`
- Create: `smart_suggestions/tests/test_automation_builder.py`

**Flow:** Takes `automation_context` from a suggestion → calls Anthropic to generate YAML → parses YAML to dict → passes to `HAClient.create_automation()`.

On Anthropic failure: returns `{success: false, error: ..., yaml: ""}`.

- [ ] **Step 1: Write failing tests**

```python
# smart_suggestions/tests/test_automation_builder.py
import pytest
from unittest.mock import AsyncMock, MagicMock
from automation_builder import AutomationBuilder, _build_automation_prompt


def test_build_prompt_contains_scene_entity():
    ctx = {
        "entity_id": "scene.evening",
        "name": "Evening Scene",
        "typical_time": "18:30",
        "days": ["Mon", "Tue", "Wed", "Thu", "Fri"],
    }
    prompt = _build_automation_prompt(ctx)
    assert "scene.evening" in prompt
    assert "18:30" in prompt
    assert "Mon" in prompt


@pytest.mark.asyncio
async def test_build_calls_anthropic_and_ha():
    valid_yaml = """alias: Evening Scene Weekdays
trigger:
  - platform: time
    at: "18:30:00"
condition:
  - condition: time
    weekday: [mon, tue, wed, thu, fri]
action:
  - service: scene.turn_on
    target:
      entity_id: scene.evening
mode: single"""

    mock_message = MagicMock()
    mock_message.content = [MagicMock(text=valid_yaml)]
    mock_ai_client = MagicMock()
    mock_ai_client.messages = MagicMock()
    mock_ai_client.messages.create = MagicMock(return_value=mock_message)

    mock_ha = MagicMock()
    mock_ha.create_automation = AsyncMock(return_value={"success": True, "automation_id": "xyz"})

    builder = AutomationBuilder(ai_provider="anthropic", ai_api_key="test", ai_model="claude-opus-4-5")
    builder._client = mock_ai_client

    ctx = {
        "entity_id": "scene.evening",
        "name": "Evening Scene",
        "typical_time": "18:30",
        "days": ["Mon", "Tue", "Wed", "Thu", "Fri"],
    }
    result = await builder.build(ctx, mock_ha)
    assert result["success"] is True
    assert result["automation_id"] == "xyz"
    mock_ha.create_automation.assert_called_once()


@pytest.mark.asyncio
async def test_build_returns_yaml_on_ha_failure():
    valid_yaml = "alias: Test\ntrigger: []\naction: []"
    mock_message = MagicMock()
    mock_message.content = [MagicMock(text=valid_yaml)]
    mock_ai_client = MagicMock()
    mock_ai_client.messages = MagicMock()
    mock_ai_client.messages.create = MagicMock(return_value=mock_message)

    mock_ha = MagicMock()
    mock_ha.create_automation = AsyncMock(return_value={"success": False, "error": "HA error"})

    builder = AutomationBuilder(ai_provider="anthropic", ai_api_key="test", ai_model="claude-opus-4-5")
    builder._client = mock_ai_client

    ctx = {"entity_id": "scene.evening", "name": "Evening", "typical_time": "18:30", "days": ["Mon"]}
    result = await builder.build(ctx, mock_ha)
    assert result["success"] is False
    assert "yaml" in result


@pytest.mark.asyncio
async def test_build_returns_error_when_no_client():
    builder = AutomationBuilder(ai_provider="anthropic", ai_api_key="", ai_model="claude-opus-4-5")
    ctx = {"entity_id": "scene.evening", "name": "Evening", "typical_time": "18:30", "days": ["Mon"]}
    result = await builder.build(ctx, MagicMock())
    assert result["success"] is False
```

- [ ] **Step 2: Run — verify FAIL**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_automation_builder.py -v
```

- [ ] **Step 3: Install PyYAML for tests**

```bash
pip install PyYAML
```

- [ ] **Step 4: Implement automation_builder.py**

```python
# smart_suggestions/src/automation_builder.py
"""Generate HA automation YAML via AI, create via HAClient REST."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from ha_client import HAClient

_LOGGER = logging.getLogger(__name__)


def _build_automation_prompt(ctx: dict) -> str:
    entity_id = ctx.get("entity_id", "")
    name = ctx.get("name", entity_id)
    typical_time = ctx.get("typical_time", "18:00")
    days = ctx.get("days", [])
    days_str = ", ".join(d.lower() for d in days) if days else "daily"
    weekday_list = "[" + ", ".join(d.lower() for d in days) + "]" if days else "[]"

    return f"""Generate a valid Home Assistant automation YAML to activate the scene '{name}' ({entity_id}) at {typical_time} on {days_str}.

Return ONLY the raw YAML (no markdown code blocks, no explanation):

alias: {name} — Auto
trigger:
  - platform: time
    at: "{typical_time}:00"
condition:
  - condition: time
    weekday: {weekday_list}
action:
  - service: scene.turn_on
    target:
      entity_id: {entity_id}
mode: single

Adjust the alias and logic to be clean and production-ready. Return only YAML."""


class AutomationBuilder:
    def __init__(self, ai_provider: str, ai_api_key: str, ai_model: str, ai_base_url: str = "") -> None:
        self._provider = ai_provider
        self._model = ai_model
        self._client: Any = None
        if ai_api_key:
            self._init_client(ai_provider, ai_api_key, ai_base_url)

    def _init_client(self, provider: str, api_key: str, base_url: str = "") -> None:
        try:
            if provider == "anthropic":
                import anthropic
                self._client = anthropic.Anthropic(api_key=api_key)
            elif provider == "openai_compatible":
                import openai
                self._client = openai.OpenAI(api_key=api_key, base_url=base_url or None)
        except ImportError as e:
            _LOGGER.error("AutomationBuilder: could not import SDK: %s", e)

    async def build(self, automation_context: dict, ha_client: "HAClient") -> dict:
        """Generate automation YAML and create it in HA. Returns result dict."""
        if not self._client:
            return {"success": False, "error": "No AI client configured — check ai_api_key", "yaml": ""}

        prompt = _build_automation_prompt(automation_context)
        try:
            raw_yaml = await asyncio.get_running_loop().run_in_executor(
                None, self._call_api, prompt
            )
        except Exception as e:
            _LOGGER.error("AutomationBuilder: AI call failed: %s", e)
            return {"success": False, "error": str(e), "yaml": ""}

        # Parse YAML to dict for HA REST API
        try:
            import yaml
            config_dict = yaml.safe_load(raw_yaml)
            if not isinstance(config_dict, dict):
                raise ValueError("YAML did not produce a dict")
        except Exception as e:
            _LOGGER.error("AutomationBuilder: YAML parse error: %s", e)
            return {"success": False, "error": f"YAML parse error: {e}", "yaml": raw_yaml}

        result = await ha_client.create_automation(config_dict)
        if not result.get("success"):
            result["yaml"] = raw_yaml
        return result

    def _call_api(self, prompt: str) -> str:
        if self._provider == "anthropic":
            message = self._client.messages.create(
                model=self._model,
                max_tokens=512,
                messages=[{"role": "user", "content": prompt}],
            )
            return message.content[0].text
        else:
            response = self._client.chat.completions.create(
                model=self._model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=512,
            )
            return response.choices[0].message.content
```

- [ ] **Step 5: Run — verify PASS**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_automation_builder.py -v
```

Expected: all 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/src/automation_builder.py smart_suggestions/tests/test_automation_builder.py
git commit -m "feat: add AutomationBuilder — YAML generation + HA REST create"
```

---

## Task 9: WSServer Updates

**Phase 5 — Run in parallel with Task 10 (card). Requires Task 8.**

**Files:**
- Modify: `smart_suggestions/src/ws_server.py`
- Create: `smart_suggestions/tests/test_ws_server.py`

Changes:
1. Add `save_automation` inbound message handler → calls registered callback
2. Add `automation_result` outbound broadcast
3. Add `POST /save_automation` HTTP endpoint
4. Remove `broadcast_token` (streaming removed)
5. Add `register_automation_handler` method

- [ ] **Step 1: Write failing tests**

```python
# smart_suggestions/tests/test_ws_server.py
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock
from ws_server import WSServer


def test_broadcast_token_removed():
    """broadcast_token must be removed — streaming is gone."""
    server = WSServer()
    assert not hasattr(server, "broadcast_token"), (
        "broadcast_token should have been removed from WSServer"
    )


def test_register_automation_handler():
    server = WSServer()
    handler = AsyncMock()
    server.register_automation_handler(handler)
    assert server._automation_handler is handler


@pytest.mark.asyncio
async def test_broadcast_automation_result_queues_message():
    server = WSServer()
    # No connected clients — just verify it doesn't raise
    await server.broadcast_automation_result({"success": True, "automation_id": "abc"})


@pytest.mark.asyncio
async def test_save_automation_message_calls_handler():
    server = WSServer()
    handler = AsyncMock()
    server.register_automation_handler(handler)

    suggestion = {"entity_id": "scene.evening", "can_save_as_automation": True}
    await server._handle_save_automation(suggestion)
    handler.assert_called_once_with(suggestion)


@pytest.mark.asyncio
async def test_save_automation_without_handler_does_not_raise():
    server = WSServer()
    await server._handle_save_automation({"entity_id": "scene.evening"})
```

- [ ] **Step 2: Run — verify FAIL**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_ws_server.py -v
```

- [ ] **Step 3: Update ws_server.py**

3a. Remove the `broadcast_token` method entirely.

3b. Add to `WSServer` class:

```python
def register_automation_handler(self, handler) -> None:
    self._automation_handler = handler

async def broadcast_automation_result(self, result: dict) -> None:
    msg = json.dumps({"type": "automation_result", **result})
    for ws in list(self._clients):
        try:
            await ws.send_str(msg)
        except Exception:
            pass

async def _handle_save_automation(self, suggestion: dict) -> None:
    if self._automation_handler:
        await self._automation_handler(suggestion)
    else:
        _LOGGER.warning("save_automation received but no handler registered")
```

3c. In `__init__`, add `self._automation_handler = None`.

3d. In the existing `_handle_message` method (where inbound WS messages are dispatched), add a case for `"save_automation"`:

```python
elif msg_type == "save_automation":
    suggestion = data.get("suggestion", {})
    asyncio.get_running_loop().create_task(self._handle_save_automation(suggestion))
```

3e. Add `POST /save_automation` route to the aiohttp app setup:

```python
async def _handle_post_save_automation(self, request: web.Request) -> web.Response:
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)
    asyncio.get_running_loop().create_task(self._handle_save_automation(data.get("suggestion", {})))
    return web.json_response({"status": "queued"})
```

And register it: `app.router.add_post("/save_automation", self._handle_post_save_automation)`

- [ ] **Step 4: Run — verify PASS**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_ws_server.py -v
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/src/ws_server.py smart_suggestions/tests/test_ws_server.py
git commit -m "feat: add save_automation/automation_result to WSServer, remove broadcast_token"
```

---

## Task 10: Card Update (Scene-First UI)

**Phase 5 — Run in parallel with Task 9.**

**Files:**
- Modify: `custom_components/smart_suggestions/smart-suggestions-card.js`

Changes:
1. Remove streaming token handler and streaming UI state
2. Scene suggestions displayed first with larger/distinct card style
3. "Save as Automation" button on cards where `can_save_as_automation: true`
4. Confidence label ("High confidence", "Pattern match", "Contextual") instead of confidence border
5. `automation_result` message handler — show success toast or YAML fallback modal
6. Secondary device suggestions below scene cards

**Note:** Card layout details are intentionally flexible — the implementation should follow the existing card patterns (iOS-style dark UI) but scenes should visually dominate. "Save as Automation" button is the most critical new element.

- [ ] **Step 1: Read the existing card JS thoroughly**

```bash
wc -l /Users/jgray/Desktop/smart-suggestions-ha/custom_components/smart_suggestions/smart-suggestions-card.js
```

Read the file to understand the existing render loop, WS message handling, and how suggestion cards are currently built before making any changes.

- [ ] **Step 2: Remove streaming token handler**

Find and remove the block that handles `type === "streaming"` messages and any UI elements that rendered streaming tokens (the "thinking" state).

- [ ] **Step 3: Add confidence label rendering**

Replace any confidence border/ring rendering with a text label. Map:
- `"high"` → `"High confidence"`
- `"medium"` → `"Pattern match"`
- `"low"` or absent → `"Contextual"`

Add a `.confidence-label` CSS class styled as a small muted badge.

- [ ] **Step 4: Add scene-first rendering**

In the suggestion render loop, check `type === "scene"`. Scene cards should:
- Use a distinct background (e.g. slightly lighter or accented)
- Show the scene icon (`mdi:palette` or entity picture if available)
- Display a "Save as Automation" button when `can_save_as_automation === true`
- Render above all non-scene suggestions (the data is already sorted by the backend; render in order)

"Save as Automation" button sends:
```javascript
this._ws.send(JSON.stringify({
  type: "save_automation",
  suggestion: suggestion
}));
```

Disable the button while waiting for a response.

- [ ] **Step 5: Add automation_result handler**

In the WS message handler, add:
```javascript
} else if (data.type === "automation_result") {
  if (data.success) {
    this._showToast("Automation created!");
  } else {
    this._showYamlFallback(data.yaml || "", data.error || "Unknown error");
  }
}
```

Add `_showToast(message)` — brief floating notification that dismisses after 3s.

Add `_showYamlFallback(yaml, error)` — modal/drawer showing the raw YAML with a copy button and the error message.

- [ ] **Step 6: Bump card version**

In the card JS, bump `CARD_VERSION` to `1.1.0`.

- [ ] **Step 7: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-ha
git add custom_components/smart_suggestions/smart-suggestions-card.js
git commit -m "feat: scene-first card — confidence labels, Save as Automation, automation_result handler"
```

---

## Task 11: main.py Rewrite

**Phase 6 — Requires all previous tasks.**

**Files:**
- Rewrite: `smart_suggestions/src/main.py`
- Delete: `smart_suggestions/src/context_builder.py`
- Delete: `smart_suggestions/src/pattern_analyzer.py`
- Delete: `smart_suggestions/src/ollama_client.py`

**What to keep from existing main.py:**
- `_WSLogHandler` — unchanged
- `_load_feedback()`, `_save_feedback()`, `_load_feedback()` — unchanged
- `_on_feedback()` — keep logic, wire to trigger refresh
- Feedback dict and `_feedback` handling

**What to remove:**
- `_run_refresh_cycle()` — replaced by new pipeline
- `_run_analysis()` / `_analysis_loop()` — replaced by nightly scheduler
- Impression tracking (`shown` counter) — `SceneEngine` handles feedback now
- `_remove_noops()` — moved to `scene_engine.py`

**New pipeline in `_run_refresh_cycle()`:**
```
states → StatisticalEngine.score_realtime()
       → SceneEngine.rank()
       → OllamaNarrator.narrate()  [async, non-blocking]
       → broadcast + write HA state
```

**New background tasks:**
- `_correlation_loop()` — calls `StatisticalEngine.analyze_correlations()` every `analysis_interval_hours`
- `_nightly_analysis_scheduler()` — sleeps until `analysis_schedule` wall-clock time, runs `AnthropicAnalyzer.analyze()`, sleeps 24h

- [ ] **Step 1: Write integration smoke test**

```python
# smart_suggestions/tests/test_main_smoke.py
"""Smoke test: verify all new modules import and wire together without error."""
import pytest


def test_all_modules_importable():
    from const import _ACTION_DOMAINS
    from pattern_store import PatternStore
    from statistical_engine import StatisticalEngine
    from anthropic_analyzer import AnthropicAnalyzer
    from scene_engine import SceneEngine
    from ollama_narrator import OllamaNarrator
    from automation_builder import AutomationBuilder
    assert _ACTION_DOMAINS
    assert PatternStore
    assert StatisticalEngine
    assert AnthropicAnalyzer
    assert SceneEngine
    assert OllamaNarrator
    assert AutomationBuilder


def test_old_modules_do_not_exist():
    import importlib
    for mod in ("context_builder", "pattern_analyzer", "ollama_client"):
        try:
            importlib.import_module(mod)
            assert False, f"{mod} should have been deleted"
        except ModuleNotFoundError:
            pass
```

- [ ] **Step 2: Run smoke test — it will FAIL until old files are deleted and main.py is complete**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_main_smoke.py -v
```

Expected: `test_old_modules_do_not_exist` FAIL.

- [ ] **Step 3: Delete old source files**

```bash
rm /Users/jgray/Desktop/smart-suggestions-addon/smart_suggestions/src/context_builder.py
rm /Users/jgray/Desktop/smart-suggestions-addon/smart_suggestions/src/pattern_analyzer.py
rm /Users/jgray/Desktop/smart-suggestions-addon/smart_suggestions/src/ollama_client.py
```

- [ ] **Step 4: Rewrite main.py**

```python
# smart_suggestions/src/main.py
"""Smart Suggestions Add-on — main event loop (redesigned)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from datetime import datetime, timezone

from pattern_store import PatternStore
from statistical_engine import StatisticalEngine
from anthropic_analyzer import AnthropicAnalyzer
from scene_engine import SceneEngine
from ollama_narrator import OllamaNarrator
from automation_builder import AutomationBuilder
from ha_client import HAClient
from ws_server import WSServer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
_LOGGER = logging.getLogger("smart_suggestions")

_OPTIONS_FILE = "/data/options.json"
_FEEDBACK_FILE = "/data/feedback.json"


def _load_feedback() -> dict:
    try:
        with open(_FEEDBACK_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        _LOGGER.warning("Could not read feedback file: %s", e)
        return {}


def _save_feedback(fb: dict) -> None:
    try:
        with open(_FEEDBACK_FILE, "w") as f:
            json.dump(fb, f)
    except Exception as e:
        _LOGGER.error("Could not save feedback: %s", e)


def _load_options() -> dict:
    try:
        with open(_OPTIONS_FILE) as f:
            return json.load(f)
    except Exception as e:
        _LOGGER.warning("Could not read %s: %s — using defaults", _OPTIONS_FILE, e)
        return {}


class _WSLogHandler(logging.Handler):
    def __init__(self, ws_server: WSServer) -> None:
        super().__init__()
        self._ws = ws_server

    def emit(self, record: logging.LogRecord) -> None:
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._ws.broadcast_log(record.levelname, self.format(record)))
        except Exception:
            pass


class SmartSuggestionsAddon:
    def __init__(self, opts: dict) -> None:
        self._opts = opts
        self._ws_server = WSServer()
        self._pattern_store = PatternStore()
        self._stat_engine = StatisticalEngine(
            self._pattern_store,
            confidence_threshold=float(opts.get("pattern_confidence_threshold", 0.6)),
        )
        self._scene_engine = SceneEngine(
            max_suggestions=int(opts.get("max_suggestions", 7)),
            confidence_threshold=float(opts.get("pattern_confidence_threshold", 0.6)),
        )
        self._narrator = OllamaNarrator(
            ollama_url=opts.get("ollama_url", "http://localhost:11434"),
            model=opts.get("ollama_model", "llama3.2"),
        )
        self._analyzer = AnthropicAnalyzer(
            ai_provider=opts.get("ai_provider", "anthropic"),
            ai_api_key=opts.get("ai_api_key", ""),
            ai_model=opts.get("ai_model", "claude-opus-4-5"),
            analysis_depth_days=int(opts.get("analysis_depth_days", 14)),
            ai_base_url=opts.get("ai_base_url", ""),
        )
        self._automation_builder = AutomationBuilder(
            ai_provider=opts.get("ai_provider", "anthropic"),
            ai_api_key=opts.get("ai_api_key", ""),
            ai_model=opts.get("ai_model", "claude-opus-4-5"),
            ai_base_url=opts.get("ai_base_url", ""),
        )
        self._ha: HAClient | None = None
        self._refresh_lock = asyncio.Lock()
        self._last_suggestions: list = []
        self._last_states: dict = {}
        self._running = True
        self._feedback: dict = _load_feedback()
        self._ha_connected: bool = False
        self._ollama_connected: bool = False
        self._last_refresh_str: str = "Never"
        self._last_analysis_str: str = "Never"

    def _push_system_status(self) -> None:
        status = {
            "ha_connected": self._ha_connected,
            "ollama_connected": self._ollama_connected,
            "ollama_url": self._opts.get("ollama_url", ""),
            "ollama_model": self._opts.get("ollama_model", ""),
            "entity_count": len(self._last_states),
            "last_refresh": self._last_refresh_str,
            "last_analysis": self._last_analysis_str,
            "patterns_loaded": bool(self._pattern_store.get_routines()),
            "pattern_routines": len(self._pattern_store.get_routines()),
            "feedback_count": len(self._feedback),
        }
        self._ws_server.set_system_status(status)

    async def _on_states_ready(self, states: dict) -> None:
        self._last_states = states
        if not self._ha_connected:
            self._ha_connected = True
            self._push_system_status()
        await self._run_refresh_cycle(states)

    async def _run_refresh_cycle(self, states: dict) -> None:
        if self._refresh_lock.locked():
            return
        async with self._refresh_lock:
            await self._ws_server.broadcast_status("updating")
            try:
                # Score candidates deterministically
                candidates = self._stat_engine.score_realtime(states)
                # Rank scenes first, apply feedback
                ranked = self._scene_engine.rank(candidates, states, self._feedback)
                # Narrate reasons (non-blocking: if Ollama fails, falls back to raw reasons)
                try:
                    ranked = await asyncio.wait_for(
                        self._narrator.narrate(ranked), timeout=15.0
                    )
                    self._ollama_connected = True
                except (asyncio.TimeoutError, Exception) as e:
                    self._ollama_connected = False
                    _LOGGER.warning("Narration skipped: %s", e)

                suggestions = ranked
                if suggestions:
                    self._last_suggestions = suggestions
                else:
                    suggestions = self._last_suggestions

                await self._ws_server.broadcast_suggestions(suggestions)
                await self._ha.write_suggestions_state(suggestions)
                self._last_refresh_str = datetime.now().strftime("%H:%M:%S")
                self._push_system_status()
                _LOGGER.info("Refresh complete: %d suggestions", len(suggestions))
            except Exception as e:
                _LOGGER.error("Refresh cycle error: %s", e)
                await self._ws_server.broadcast_status("error")
                self._push_system_status()

    async def _run_analysis(self) -> None:
        if not self._last_states:
            return
        try:
            history = await self._ha.fetch_history(self._opts.get("analysis_depth_days", 14) * 24)
            patterns = await self._analyzer.analyze(history, self._last_states)
            if any(patterns.values()):
                self._pattern_store.merge(patterns)
                self._last_analysis_str = datetime.now().strftime("%H:%M:%S")
                self._push_system_status()
                _LOGGER.info(
                    "Analysis complete: %d routines, %d correlations, %d anomalies",
                    len(patterns.get("routines", [])),
                    len(patterns.get("correlations", [])),
                    len(patterns.get("anomalies", [])),
                )
        except Exception as e:
            _LOGGER.warning("Analysis failed: %s", e)

    async def _correlation_loop(self) -> None:
        interval = int(self._opts.get("analysis_interval_hours", 6)) * 3600
        while self._running:
            await asyncio.sleep(interval)
            if self._last_states:
                try:
                    history = await self._ha.fetch_history(
                        int(self._opts.get("analysis_depth_days", 14)) * 24
                    )
                    correlations = await self._stat_engine.analyze_correlations(
                        history,
                        self._last_states,
                        window_minutes=int(self._opts.get("correlation_window_minutes", 5)),
                    )
                    if correlations:
                        self._pattern_store.merge({"routines": [], "correlations": correlations, "anomalies": []})
                        _LOGGER.info("Correlation scan: %d correlations stored", len(correlations))
                except Exception as e:
                    _LOGGER.warning("Correlation loop error: %s", e)

    async def _nightly_analysis_scheduler(self) -> None:
        # First-run: trigger immediately if store needs fresh analysis
        if self._pattern_store.needs_fresh_analysis(int(self._opts.get("analysis_depth_days", 14))):
            _LOGGER.info("First-run analysis triggered")
            await self._run_analysis()
        # Then schedule nightly
        schedule_str = self._opts.get("analysis_schedule", "03:00")
        while self._running:
            try:
                h, m = (int(x) for x in schedule_str.split(":"))
            except ValueError:
                h, m = 3, 0
            now = datetime.now()
            target = now.replace(hour=h, minute=m, second=0, microsecond=0)
            if target <= now:
                from datetime import timedelta
                target = target + timedelta(days=1)
            sleep_seconds = (target - now).total_seconds()
            _LOGGER.info("Nightly analysis scheduled in %.0f seconds (at %s)", sleep_seconds, schedule_str)
            await asyncio.sleep(sleep_seconds)
            await self._run_analysis()
            # Sleep until same time tomorrow by recomputing from the scheduled target
            from datetime import timedelta as _td
            await asyncio.sleep(max(0, (target + _td(days=1) - datetime.now()).total_seconds()))

    async def _on_feedback(self, entity_id: str, vote: str) -> None:
        entry = self._feedback.setdefault(entity_id, {"up": 0, "down": 0})
        entry[vote] = entry.get(vote, 0) + 1
        _save_feedback(self._feedback)
        self._ws_server.set_feedback(self._feedback)
        _LOGGER.info("Feedback: %s %s (net %d)", entity_id, vote, entry["up"] - entry["down"])
        if self._last_states:
            asyncio.get_running_loop().create_task(self._run_refresh_cycle(self._last_states))

    async def _on_save_automation(self, suggestion: dict) -> None:
        _LOGGER.info("Save as automation requested: %s", suggestion.get("entity_id"))
        ctx = suggestion.get("automation_context") or {}
        ctx["entity_id"] = suggestion.get("entity_id", "")
        ctx["name"] = suggestion.get("name", "")
        result = await self._automation_builder.build(ctx, self._ha)
        await self._ws_server.broadcast_automation_result(result)

    async def _on_trigger_analysis(self) -> None:
        asyncio.get_running_loop().create_task(self._run_analysis())

    async def _on_trigger_refresh(self) -> None:
        if self._last_states:
            asyncio.get_running_loop().create_task(self._run_refresh_cycle(self._last_states))

    async def run(self) -> None:
        _LOGGER.info("Smart Suggestions starting")
        self._ws_server.set_feedback(self._feedback)
        self._ws_server.register_feedback_handler(self._on_feedback)
        self._ws_server.register_refresh_handler(self._on_trigger_refresh)
        self._ws_server.register_analyze_handler(self._on_trigger_analysis)
        self._ws_server.register_automation_handler(self._on_save_automation)
        self._push_system_status()
        await self._ws_server.start()

        log_handler = _WSLogHandler(self._ws_server)
        log_handler.setFormatter(logging.Formatter("%(name)s: %(message)s"))
        log_handler.setLevel(logging.DEBUG)
        logging.getLogger().addHandler(log_handler)

        self._ha = HAClient(
            on_states_ready=self._on_states_ready,
            refresh_interval_seconds=int(self._opts.get("refresh_interval", 10)),
        )

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, lambda: loop.create_task(self._shutdown()))

        await self._ha.start()
        loop.create_task(self._correlation_loop())
        loop.create_task(self._nightly_analysis_scheduler())

    async def _shutdown(self) -> None:
        _LOGGER.info("Shutting down...")
        self._running = False
        if self._ha:
            await self._ha.stop()
        await self._ws_server.stop()


if __name__ == "__main__":
    opts = _load_options()
    addon = SmartSuggestionsAddon(opts)
    asyncio.run(addon.run())
```

- [ ] **Step 5: Run smoke tests**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/test_main_smoke.py -v
```

Expected: both tests PASS.

- [ ] **Step 6: Run full test suite**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/ -v
```

Expected: all tests PASS (no failures from deleted modules).

- [ ] **Step 7: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/src/main.py
git rm smart_suggestions/src/context_builder.py smart_suggestions/src/pattern_analyzer.py smart_suggestions/src/ollama_client.py
git add smart_suggestions/tests/test_main_smoke.py
git commit -m "feat: rewrite main.py — wire new pipeline, delete old modules"
```

---

## Task 12: Dockerfile + config.yaml Updates

**Phase 6 — Run after Task 11.**

**Files:**
- Modify: `smart_suggestions/Dockerfile`
- Modify: `smart_suggestions/config.yaml`

- [ ] **Step 1: Update Dockerfile**

Replace existing Dockerfile content with:

```dockerfile
ARG BUILD_FROM
FROM $BUILD_FROM

# Install Python and core packages via apk
RUN apk add --no-cache python3 py3-pip py3-aiohttp py3-websockets py3-yaml

# Install AI SDKs via pip (not in Alpine repos)
RUN pip3 install --no-cache-dir --break-system-packages anthropic openai

# Copy source
WORKDIR /app
COPY src/ ./

# Register as s6 service
COPY run.sh /etc/services.d/smart_suggestions/run
RUN chmod a+x /etc/services.d/smart_suggestions/run
```

- [ ] **Step 2: Update config.yaml**

Replace the `options` and `schema` blocks with all new keys (keep all other fields unchanged):

```yaml
options:
  ollama_url: "http://homeassistant.local:11434"
  ollama_model: "llama3:latest"
  refresh_interval: 10
  max_suggestions: 7
  history_hours: 4
  analysis_depth_days: 14
  analysis_schedule: "03:00"
  analysis_interval_hours: 6
  ai_provider: "anthropic"
  ai_api_key: ""
  ai_base_url: ""
  ai_model: "claude-opus-4-5"
  correlation_window_minutes: 5
  pattern_confidence_threshold: 0.6
schema:
  ollama_url: str
  ollama_model: str
  refresh_interval: int
  max_suggestions: int
  history_hours: int
  analysis_depth_days: int
  analysis_schedule: str
  analysis_interval_hours: int
  ai_provider: str
  ai_api_key: password?
  ai_base_url: str?
  ai_model: str
  correlation_window_minutes: int
  pattern_confidence_threshold: float
```

- [ ] **Step 3: Bump version in config.yaml**

Update `version` to `"2.0.0"` (major version bump — breaking change from old config schema).

- [ ] **Step 4: Run full test suite one final time**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/ -v --tb=short
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/Dockerfile smart_suggestions/config.yaml
git commit -m "feat: update Dockerfile (add anthropic/openai SDKs), update config.yaml schema v2.0.0"
```

---

## Final Verification

- [ ] **Run full test suite across both repos**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
python -m pytest smart_suggestions/tests/ -v

cd /Users/jgray/Desktop/smart-suggestions-ha
git log --oneline -5
```

- [ ] **Verify no imports of deleted modules remain**

```bash
grep -r "context_builder\|pattern_analyzer\|ollama_client" \
  /Users/jgray/Desktop/smart-suggestions-addon/smart_suggestions/src/
```

Expected: no output.

- [ ] **Verify card version bumped**

```bash
grep "CARD_VERSION" /Users/jgray/Desktop/smart-suggestions-ha/custom_components/smart_suggestions/smart-suggestions-card.js
```

Expected: `1.1.0` or higher.
