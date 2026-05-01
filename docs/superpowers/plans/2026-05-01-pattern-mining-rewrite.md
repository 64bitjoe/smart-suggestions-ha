# Pattern Mining Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current LLM-as-pattern-detector pipeline with algorithmic pattern miners that read directly from the HA recorder DB; use Claude only at the last mile to write descriptions and YAML for surviving candidates.

**Architecture:** Four isolated miners (Temporal, Sequence, Cross-area, Waste) read from `db_reader.py`, emit `Candidate` dataclasses, pass through a four-criteria filter, then go to `llm_describer.py` for description + YAML generation. Output writes to `smart_suggestions.suggestions` HA state as today. Card adds two visual zones (Suggestions / Noticed) with per-zone actions.

**Tech Stack:** Python 3.11+, aiosqlite, SQLAlchemy (for non-SQLite recorder fallback), pytest + pytest-asyncio, anthropic SDK (existing), JS Lovelace card (existing).

**Repos affected:**
- `smart-suggestions-addon` — Tasks 1-10 (most of the work)
- `smart-suggestions-ha` — Tasks 11-12 (card UX)

**Spec:** `docs/superpowers/specs/2026-05-01-pattern-mining-rewrite-design.md`

---

## File Structure

### Add-on (smart-suggestions-addon)

**New files:**
- `smart_suggestions/src/db_reader.py` — recorder DB access (SQLite default, MariaDB/PG fallback)
- `smart_suggestions/src/candidate.py` — `Candidate` dataclass + types shared across miners
- `smart_suggestions/src/dismissal_store.py` — local SQLite for user dismissals
- `smart_suggestions/src/miners/__init__.py`
- `smart_suggestions/src/miners/temporal.py` — miner A
- `smart_suggestions/src/miners/sequence.py` — miner B
- `smart_suggestions/src/miners/cross_area.py` — miner F
- `smart_suggestions/src/miners/waste.py` — miner E
- `smart_suggestions/src/candidate_filter.py` — four-criteria filter
- `smart_suggestions/src/llm_describer.py` — last-mile LLM call + cache
- `smart_suggestions/tests/test_db_reader.py`
- `smart_suggestions/tests/test_candidate.py`
- `smart_suggestions/tests/test_dismissal_store.py`
- `smart_suggestions/tests/miners/__init__.py`
- `smart_suggestions/tests/miners/test_temporal.py`
- `smart_suggestions/tests/miners/test_sequence.py`
- `smart_suggestions/tests/miners/test_cross_area.py`
- `smart_suggestions/tests/miners/test_waste.py`
- `smart_suggestions/tests/test_candidate_filter.py`
- `smart_suggestions/tests/test_llm_describer.py`

**Modified files:**
- `smart_suggestions/src/main.py` — replace pattern-analysis call sites with miner pipeline; add scheduler for hourly mining + 5-min waste check
- `smart_suggestions/config.yaml` — add new options for thresholds, drop options for removed analyzer/narrator
- `smart_suggestions/requirements-dev.txt` — add `freezegun` for time-based tests if missing

**Deleted files (Task 10):**
- `smart_suggestions/src/anthropic_analyzer.py`
- `smart_suggestions/src/ollama_narrator.py`
- `smart_suggestions/tests/test_anthropic_analyzer.py`
- `smart_suggestions/tests/test_ollama_narrator.py`

### HA repo (smart-suggestions-ha)

**Modified files:**
- `custom_components/smart_suggestions/smart-suggestions-card.js` — two-zone rendering, per-zone actions, dismissal wiring
- `custom_components/smart_suggestions/manifest.json` — bump version

---

## Phase A: Foundation

### Task 1: DB reader — SQLite path

**Files:**
- Create: `smart_suggestions/src/db_reader.py`
- Test: `smart_suggestions/tests/test_db_reader.py`

The HA recorder schema we care about:
- `states` table: `state_id, entity_id, state, last_changed_ts, last_updated_ts, attributes_id, metadata_id`
- `states_meta`: `metadata_id, entity_id` (HA ≥ 2023.4)
- `events`: not needed for v1

We expose two queries: "all state changes since timestamp T" and "state changes for one entity since T".

- [ ] **Step 1: Write test for `get_state_changes_for_entity`**

```python
# smart_suggestions/tests/test_db_reader.py
import aiosqlite
import pytest
from datetime import datetime, timezone, timedelta
from smart_suggestions.src.db_reader import DbReader, StateChange


@pytest.fixture
async def fake_db(tmp_path):
    """Build a minimal HA-recorder-shaped SQLite DB."""
    db_path = tmp_path / "home-assistant_v2.db"
    async with aiosqlite.connect(db_path) as db:
        await db.execute("""
            CREATE TABLE states_meta (
                metadata_id INTEGER PRIMARY KEY,
                entity_id TEXT NOT NULL UNIQUE
            )
        """)
        await db.execute("""
            CREATE TABLE states (
                state_id INTEGER PRIMARY KEY,
                metadata_id INTEGER NOT NULL,
                state TEXT,
                last_updated_ts REAL NOT NULL
            )
        """)
        await db.execute("INSERT INTO states_meta (metadata_id, entity_id) VALUES (1, 'light.kitchen')")
        await db.execute("INSERT INTO states_meta (metadata_id, entity_id) VALUES (2, 'light.living_room')")
        # 5 kitchen on/off pairs
        base = datetime(2026, 5, 1, 6, 45, 0, tzinfo=timezone.utc).timestamp()
        for day in range(5):
            await db.execute(
                "INSERT INTO states (metadata_id, state, last_updated_ts) VALUES (1, 'on', ?)",
                (base + day * 86400,),
            )
            await db.execute(
                "INSERT INTO states (metadata_id, state, last_updated_ts) VALUES (1, 'off', ?)",
                (base + day * 86400 + 3600,),
            )
        await db.commit()
    return db_path


async def test_get_state_changes_for_entity_returns_only_that_entity(fake_db):
    reader = DbReader(sqlite_path=fake_db)
    since = datetime(2026, 4, 25, tzinfo=timezone.utc)
    changes = await reader.get_state_changes_for_entity("light.kitchen", since)
    assert len(changes) == 10  # 5 on + 5 off
    assert all(c.entity_id == "light.kitchen" for c in changes)
    assert all(c.state in {"on", "off"} for c in changes)


async def test_get_state_changes_for_entity_respects_since(fake_db):
    reader = DbReader(sqlite_path=fake_db)
    since = datetime(2026, 5, 3, 12, 0, 0, tzinfo=timezone.utc)  # after first 2 days
    changes = await reader.get_state_changes_for_entity("light.kitchen", since)
    assert 4 <= len(changes) <= 6  # last 2-3 days
```

- [ ] **Step 2: Run test — expect ImportError or NameError**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
pytest smart_suggestions/tests/test_db_reader.py -v
```

Expected: import error for `DbReader` / `StateChange`.

- [ ] **Step 3: Implement `DbReader` (SQLite-only for now)**

```python
# smart_suggestions/src/db_reader.py
from __future__ import annotations
import aiosqlite
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Iterable


@dataclass(frozen=True)
class StateChange:
    entity_id: str
    state: str
    ts: datetime  # UTC


class DbReader:
    """Reads HA recorder state-changed history. SQLite only in v1."""

    def __init__(self, sqlite_path: str | Path):
        self.sqlite_path = Path(sqlite_path)

    async def get_state_changes_for_entity(
        self, entity_id: str, since: datetime
    ) -> list[StateChange]:
        since_ts = since.timestamp()
        async with aiosqlite.connect(self.sqlite_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                """
                SELECT s.state, s.last_updated_ts
                FROM states s
                JOIN states_meta m ON s.metadata_id = m.metadata_id
                WHERE m.entity_id = ?
                  AND s.last_updated_ts >= ?
                ORDER BY s.last_updated_ts ASC
                """,
                (entity_id, since_ts),
            )
            rows = await cursor.fetchall()
        return [
            StateChange(
                entity_id=entity_id,
                state=row["state"],
                ts=datetime.fromtimestamp(row["last_updated_ts"], tz=timezone.utc),
            )
            for row in rows
        ]

    async def get_all_state_changes(
        self, since: datetime, entity_id_prefix: str | None = None
    ) -> list[StateChange]:
        since_ts = since.timestamp()
        sql = """
            SELECT m.entity_id, s.state, s.last_updated_ts
            FROM states s
            JOIN states_meta m ON s.metadata_id = m.metadata_id
            WHERE s.last_updated_ts >= ?
        """
        params: list = [since_ts]
        if entity_id_prefix:
            sql += " AND m.entity_id LIKE ?"
            params.append(f"{entity_id_prefix}%")
        sql += " ORDER BY s.last_updated_ts ASC"

        async with aiosqlite.connect(self.sqlite_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(sql, params)
            rows = await cursor.fetchall()
        return [
            StateChange(
                entity_id=row["entity_id"],
                state=row["state"],
                ts=datetime.fromtimestamp(row["last_updated_ts"], tz=timezone.utc),
            )
            for row in rows
        ]
```

- [ ] **Step 4: Run test — expect PASS**

```bash
pytest smart_suggestions/tests/test_db_reader.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Add test for `get_all_state_changes` with prefix**

```python
async def test_get_all_state_changes_filters_by_prefix(fake_db):
    reader = DbReader(sqlite_path=fake_db)
    since = datetime(2026, 4, 25, tzinfo=timezone.utc)
    changes = await reader.get_all_state_changes(since, entity_id_prefix="light.")
    assert len(changes) == 10  # only kitchen has data; living_room has none
    assert all(c.entity_id.startswith("light.") for c in changes)
```

- [ ] **Step 6: Run all db_reader tests**

```bash
pytest smart_suggestions/tests/test_db_reader.py -v
```

Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/src/db_reader.py smart_suggestions/tests/test_db_reader.py
git commit -m "feat: add DbReader for HA recorder SQLite access"
```

---

### Task 2: DB reader — non-SQLite fallback (MariaDB/PostgreSQL)

**Files:**
- Modify: `smart_suggestions/src/db_reader.py`
- Modify: `smart_suggestions/tests/test_db_reader.py`
- Modify: `smart_suggestions/requirements-dev.txt` (add `sqlalchemy[asyncio]`, `aiosqlite` already present)

If the HA user has configured an external recorder DB, our SQLite path won't exist. We need a SQLAlchemy-backed fallback.

- [ ] **Step 1: Write a test that the reader can be constructed with a `db_url`**

```python
# add to test_db_reader.py
def test_db_reader_accepts_db_url():
    reader = DbReader(db_url="sqlite+aiosqlite:///tmp/test.db")
    assert reader.db_url == "sqlite+aiosqlite:///tmp/test.db"
    assert reader.sqlite_path is None


def test_db_reader_requires_one_of_path_or_url():
    with pytest.raises(ValueError, match="must provide"):
        DbReader()
```

- [ ] **Step 2: Run tests — expect failures**

```bash
pytest smart_suggestions/tests/test_db_reader.py -v
```

Expected: 2 new tests fail with TypeError or AttributeError.

- [ ] **Step 3: Add db_url constructor branch to DbReader**

In `db_reader.py`, change `__init__` signature and store both:

```python
def __init__(
    self,
    sqlite_path: str | Path | None = None,
    db_url: str | None = None,
):
    if not (sqlite_path or db_url):
        raise ValueError("DbReader must provide one of sqlite_path or db_url")
    self.sqlite_path = Path(sqlite_path) if sqlite_path else None
    self.db_url = db_url
```

For the actual SQLAlchemy query path, add this method (kept minimal — same SQL, run via SQLAlchemy):

```python
async def _query_via_sqlalchemy(self, sql: str, params: dict) -> list[dict]:
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy import text
    engine = create_async_engine(self.db_url)
    async with engine.connect() as conn:
        result = await conn.execute(text(sql), params)
        rows = [dict(row._mapping) for row in result]
    await engine.dispose()
    return rows
```

Then in each query method, branch:

```python
if self.sqlite_path:
    # existing aiosqlite path
    ...
else:
    rows = await self._query_via_sqlalchemy(...)
```

(For the SQL, use `:entity_id` and `:since_ts` named params instead of `?` when going via SQLAlchemy.)

- [ ] **Step 4: Run tests — expect PASS**

```bash
pytest smart_suggestions/tests/test_db_reader.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Add `sqlalchemy[asyncio]` to requirements-dev.txt and prod requirements**

Append to `smart_suggestions/requirements-dev.txt`:
```
sqlalchemy[asyncio]==2.0.36
asyncpg==0.30.0
aiomysql==0.2.0
```

(Production deps live in Dockerfile or `requirements.txt`; check there too — if separate, mirror these.)

- [ ] **Step 6: Commit**

```bash
git add smart_suggestions/src/db_reader.py smart_suggestions/tests/test_db_reader.py smart_suggestions/requirements-dev.txt
git commit -m "feat: add SQLAlchemy fallback for non-SQLite HA recorder"
```

---

### Task 3: Candidate dataclass + factory function `factory_for(miner_type)`

**Files:**
- Create: `smart_suggestions/src/candidate.py`
- Create: `smart_suggestions/tests/test_candidate.py`

A unified `Candidate` shape consumed by filter and LLM describer.

- [ ] **Step 1: Write test for Candidate construction and signature**

```python
# smart_suggestions/tests/test_candidate.py
from smart_suggestions.src.candidate import Candidate, MinerType


def test_candidate_signature_is_stable():
    c1 = Candidate(
        miner_type=MinerType.TEMPORAL,
        entity_id="light.kitchen",
        action="turn_on",
        details={"hour": 6, "minute": 45, "weekdays": [0,1,2,3,4]},
        occurrences=12,
        conditional_prob=0.85,
    )
    c2 = Candidate(
        miner_type=MinerType.TEMPORAL,
        entity_id="light.kitchen",
        action="turn_on",
        details={"weekdays": [0,1,2,3,4], "minute": 45, "hour": 6},  # different order
        occurrences=99,  # different count, same pattern identity
        conditional_prob=0.99,
    )
    assert c1.signature() == c2.signature()


def test_candidate_signature_includes_miner_type_entity_action_and_key_details():
    c = Candidate(
        miner_type=MinerType.SEQUENCE,
        entity_id="light.lamp_a",
        action="turn_on",
        details={"target_entity": "light.lamp_b", "target_action": "turn_on", "delta_seconds": 30},
        occurrences=8,
        conditional_prob=0.9,
    )
    sig = c.signature()
    assert "sequence" in sig
    assert "light.lamp_a" in sig
    assert "light.lamp_b" in sig
```

- [ ] **Step 2: Run test — expect ImportError**

```bash
pytest smart_suggestions/tests/test_candidate.py -v
```

- [ ] **Step 3: Implement Candidate**

```python
# smart_suggestions/src/candidate.py
from __future__ import annotations
import hashlib
import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class MinerType(str, Enum):
    TEMPORAL = "temporal"
    SEQUENCE = "sequence"
    CROSS_AREA = "cross_area"
    WASTE = "waste"


# Keys that participate in pattern identity per miner type. occurrences/probability
# are *measurements* of the pattern, not part of its identity.
_SIG_KEYS: dict[MinerType, tuple[str, ...]] = {
    MinerType.TEMPORAL: ("hour", "minute", "weekdays"),
    MinerType.SEQUENCE: ("target_entity", "target_action", "delta_seconds"),
    MinerType.CROSS_AREA: ("trigger_entity", "latency_bucket"),
    MinerType.WASTE: ("condition",),
}


@dataclass
class Candidate:
    miner_type: MinerType
    entity_id: str
    action: str  # e.g. "turn_on", "turn_off", or for waste: "currently_on"
    details: dict[str, Any] = field(default_factory=dict)
    occurrences: int = 0
    conditional_prob: float = 0.0  # not all miners use this; default 0.0
    confidence: float = 0.0  # final confidence the filter computes

    def signature(self) -> str:
        """Stable identity hash used for LLM cache keys and dismissal matching."""
        keys = _SIG_KEYS.get(self.miner_type, ())
        identity = {k: self.details.get(k) for k in keys}
        # Normalize lists for stable serialization.
        for k, v in identity.items():
            if isinstance(v, list):
                identity[k] = sorted(v)
        payload = {
            "miner": self.miner_type.value,
            "entity": self.entity_id,
            "action": self.action,
            "id": identity,
        }
        blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha1(blob.encode()).hexdigest()[:16]
        return f"{self.miner_type.value}:{self.entity_id}:{self.action}:{digest}"
```

- [ ] **Step 4: Run test — expect PASS**

```bash
pytest smart_suggestions/tests/test_candidate.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/candidate.py smart_suggestions/tests/test_candidate.py
git commit -m "feat: add Candidate dataclass with stable signature for cache/dismissal keys"
```

---

### Task 4: Dismissal store (local SQLite)

**Files:**
- Create: `smart_suggestions/src/dismissal_store.py`
- Create: `smart_suggestions/tests/test_dismissal_store.py`

The add-on writes to `/data/dismissals.db` (the `/data` dir is the HA add-on persistent volume).

- [ ] **Step 1: Write tests for `add_dismissal`, `is_dismissed`, `dismissals_per_miner_in_window`**

```python
# smart_suggestions/tests/test_dismissal_store.py
import pytest
from datetime import datetime, timezone, timedelta
from smart_suggestions.src.dismissal_store import DismissalStore
from smart_suggestions.src.candidate import MinerType


@pytest.fixture
async def store(tmp_path):
    s = DismissalStore(db_path=tmp_path / "dismissals.db")
    await s.init()
    return s


async def test_dismissal_round_trip(store):
    sig = "temporal:light.kitchen:turn_on:abc123"
    await store.add_dismissal(sig, MinerType.TEMPORAL, datetime.now(timezone.utc))
    assert await store.is_dismissed(sig, within=timedelta(days=14))


async def test_dismissal_expires(store):
    sig = "temporal:light.kitchen:turn_on:abc123"
    old = datetime.now(timezone.utc) - timedelta(days=20)
    await store.add_dismissal(sig, MinerType.TEMPORAL, old)
    assert not await store.is_dismissed(sig, within=timedelta(days=14))


async def test_dismissals_per_miner_in_window(store):
    now = datetime.now(timezone.utc)
    for i in range(3):
        await store.add_dismissal(f"temporal:e{i}:on:x", MinerType.TEMPORAL, now - timedelta(days=i))
    await store.add_dismissal("sequence:e0:on:y", MinerType.SEQUENCE, now)
    count = await store.dismissals_per_miner_in_window(MinerType.TEMPORAL, timedelta(days=7))
    assert count == 3
    assert await store.dismissals_per_miner_in_window(MinerType.SEQUENCE, timedelta(days=7)) == 1
```

- [ ] **Step 2: Run tests — expect ImportError**

```bash
pytest smart_suggestions/tests/test_dismissal_store.py -v
```

- [ ] **Step 3: Implement DismissalStore**

```python
# smart_suggestions/src/dismissal_store.py
from __future__ import annotations
import aiosqlite
from datetime import datetime, timedelta, timezone
from pathlib import Path
from smart_suggestions.src.candidate import MinerType


class DismissalStore:
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)

    async def init(self):
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS dismissals (
                    signature TEXT NOT NULL,
                    miner_type TEXT NOT NULL,
                    dismissed_at REAL NOT NULL
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS idx_sig ON dismissals(signature)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_miner_ts ON dismissals(miner_type, dismissed_at)")
            await db.commit()

    async def add_dismissal(self, signature: str, miner_type: MinerType, when: datetime):
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "INSERT INTO dismissals (signature, miner_type, dismissed_at) VALUES (?, ?, ?)",
                (signature, miner_type.value, when.timestamp()),
            )
            await db.commit()

    async def is_dismissed(self, signature: str, within: timedelta) -> bool:
        cutoff = (datetime.now(timezone.utc) - within).timestamp()
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "SELECT 1 FROM dismissals WHERE signature = ? AND dismissed_at >= ? LIMIT 1",
                (signature, cutoff),
            )
            return await cursor.fetchone() is not None

    async def dismissals_per_miner_in_window(
        self, miner_type: MinerType, window: timedelta
    ) -> int:
        cutoff = (datetime.now(timezone.utc) - window).timestamp()
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "SELECT COUNT(*) FROM dismissals WHERE miner_type = ? AND dismissed_at >= ?",
                (miner_type.value, cutoff),
            )
            row = await cursor.fetchone()
            return int(row[0]) if row else 0
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pytest smart_suggestions/tests/test_dismissal_store.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/dismissal_store.py smart_suggestions/tests/test_dismissal_store.py
git commit -m "feat: add DismissalStore for per-pattern user feedback persistence"
```

---

## Phase B: Miners

### Task 5: Temporal miner (A) — time-of-day routines

**Files:**
- Create: `smart_suggestions/src/miners/__init__.py` (empty)
- Create: `smart_suggestions/src/miners/temporal.py`
- Create: `smart_suggestions/tests/miners/__init__.py` (empty)
- Create: `smart_suggestions/tests/miners/test_temporal.py`

**Algorithm:** For each entity, group state changes by (state, weekday). Within each group, find time-of-day clusters of width ≤ ±15 min that contain ≥5 occurrences across distinct days. Conditional probability ≈ (occurrences in cluster) / (occurrences of that state on that weekday).

- [ ] **Step 1: Write tests for the temporal miner**

```python
# smart_suggestions/tests/miners/test_temporal.py
import pytest
from datetime import datetime, timezone, timedelta
from smart_suggestions.src.db_reader import StateChange
from smart_suggestions.src.miners.temporal import TemporalMiner


def _make_changes(entity, state, days, hour, minute):
    """Generate `days` state changes at the given time-of-day, one per day."""
    base = datetime(2026, 4, 1, hour, minute, 0, tzinfo=timezone.utc)
    return [
        StateChange(entity_id=entity, state=state, ts=base + timedelta(days=d))
        for d in range(days)
    ]


async def test_finds_morning_routine_with_tight_cluster():
    changes = _make_changes("light.kitchen", "on", days=10, hour=6, minute=45)
    miner = TemporalMiner()
    candidates = await miner.run(changes, now=datetime(2026, 4, 15, tzinfo=timezone.utc))

    assert len(candidates) == 1
    c = candidates[0]
    assert c.entity_id == "light.kitchen"
    assert c.action == "turn_on"
    assert c.details["hour"] == 6
    assert 30 <= c.details["minute"] <= 60  # cluster center near 45
    assert c.occurrences >= 5
    assert c.conditional_prob >= 0.7


async def test_ignores_random_distribution():
    """If state changes are scattered across the day, no cluster should form."""
    base = datetime(2026, 4, 1, 0, 0, 0, tzinfo=timezone.utc)
    # 14 changes spread across 24h, no two within an hour of each other on same day
    changes = []
    for d in range(14):
        for h in range(0, 24, 3):
            if (d + h) % 5 != 0:
                continue
            changes.append(StateChange("light.kitchen", "on", base + timedelta(days=d, hours=h)))

    miner = TemporalMiner()
    candidates = await miner.run(changes, now=base + timedelta(days=15))
    assert candidates == []


async def test_separates_by_state():
    """on at 6:45 and off at 22:30 should produce two candidates."""
    on_changes = _make_changes("light.kitchen", "on", days=10, hour=6, minute=45)
    off_changes = _make_changes("light.kitchen", "off", days=10, hour=22, minute=30)
    miner = TemporalMiner()
    candidates = await miner.run(on_changes + off_changes, now=datetime(2026, 4, 15, tzinfo=timezone.utc))

    actions = sorted(c.action for c in candidates)
    assert actions == ["turn_off", "turn_on"]
```

- [ ] **Step 2: Run tests — expect ImportError**

```bash
pytest smart_suggestions/tests/miners/test_temporal.py -v
```

- [ ] **Step 3: Implement TemporalMiner**

```python
# smart_suggestions/src/miners/temporal.py
from __future__ import annotations
from collections import defaultdict
from datetime import datetime, timedelta
from smart_suggestions.src.candidate import Candidate, MinerType
from smart_suggestions.src.db_reader import StateChange


# Tunable knobs (also exposed via config in a later task).
CLUSTER_WIDTH_MINUTES = 15
MIN_OCCURRENCES = 5
MIN_CONDITIONAL_PROB = 0.7


def _state_to_action(state: str) -> str | None:
    if state == "on":
        return "turn_on"
    if state == "off":
        return "turn_off"
    return None


class TemporalMiner:
    async def run(
        self, changes: list[StateChange], now: datetime
    ) -> list[Candidate]:
        # Group: entity_id -> action -> list of datetime
        buckets: dict[tuple[str, str], list[datetime]] = defaultdict(list)
        for c in changes:
            action = _state_to_action(c.state)
            if action is None:
                continue
            buckets[(c.entity_id, action)].append(c.ts)

        candidates: list[Candidate] = []
        for (entity_id, action), timestamps in buckets.items():
            cluster = self._find_tightest_cluster(timestamps)
            if cluster is None:
                continue
            cluster_count, center_minute_of_day, weekdays = cluster
            total_for_action = len(timestamps)
            cond_prob = cluster_count / total_for_action if total_for_action else 0
            if cluster_count < MIN_OCCURRENCES or cond_prob < MIN_CONDITIONAL_PROB:
                continue
            candidates.append(
                Candidate(
                    miner_type=MinerType.TEMPORAL,
                    entity_id=entity_id,
                    action=action,
                    details={
                        "hour": center_minute_of_day // 60,
                        "minute": center_minute_of_day % 60,
                        "weekdays": sorted(weekdays),
                    },
                    occurrences=cluster_count,
                    conditional_prob=cond_prob,
                )
            )
        return candidates

    def _find_tightest_cluster(
        self, timestamps: list[datetime]
    ) -> tuple[int, int, set[int]] | None:
        """Sliding-window cluster on minute-of-day. Returns (count, center, weekdays_set) or None."""
        if len(timestamps) < MIN_OCCURRENCES:
            return None
        minutes_of_day = sorted((t.hour * 60 + t.minute, t.weekday()) for t in timestamps)

        best_count = 0
        best_center = 0
        best_weekdays: set[int] = set()
        width = CLUSTER_WIDTH_MINUTES

        # Sliding window across minute-of-day axis. Wrap at midnight handled by also
        # sliding over [m + 1440 for m in minutes] union; for v1 we skip wrap to keep it simple.
        n = len(minutes_of_day)
        left = 0
        for right in range(n):
            while minutes_of_day[right][0] - minutes_of_day[left][0] > 2 * width:
                left += 1
            count = right - left + 1
            if count > best_count:
                best_count = count
                best_center = (minutes_of_day[left][0] + minutes_of_day[right][0]) // 2
                best_weekdays = {wd for _, wd in minutes_of_day[left : right + 1]}

        if best_count < MIN_OCCURRENCES:
            return None
        return best_count, best_center, best_weekdays
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pytest smart_suggestions/tests/miners/test_temporal.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/miners/ smart_suggestions/tests/miners/__init__.py smart_suggestions/tests/miners/test_temporal.py
git commit -m "feat: add TemporalMiner for time-of-day routine detection"
```

---

### Task 6: Sequence miner (B) — "X then Y within Δt" pairs

**Files:**
- Create: `smart_suggestions/src/miners/sequence.py`
- Create: `smart_suggestions/tests/miners/test_sequence.py`

**Algorithm:** Given a stream of state changes sorted by time, find pairs (A→B) where B follows A within Δt ≤ 60s. Score by lift = P(B|A) / P(B). Require P(B|A) ≥ 0.7 and ≥5 occurrences.

- [ ] **Step 1: Write tests**

```python
# smart_suggestions/tests/miners/test_sequence.py
import pytest
from datetime import datetime, timezone, timedelta
from smart_suggestions.src.db_reader import StateChange
from smart_suggestions.src.miners.sequence import SequenceMiner


async def test_finds_lamp_a_then_lamp_b_pattern():
    base = datetime(2026, 4, 1, 20, 0, 0, tzinfo=timezone.utc)
    changes = []
    # 6 nights: A on, then B on within 30s. Plus background noise.
    for d in range(6):
        t = base + timedelta(days=d)
        changes.append(StateChange("light.lamp_a", "on", t))
        changes.append(StateChange("light.lamp_b", "on", t + timedelta(seconds=30)))
    # Add noise: lamp_b also turns on at random other times rarely
    for d in range(2):
        changes.append(StateChange("light.lamp_b", "on", base + timedelta(days=d, hours=12)))

    changes.sort(key=lambda c: c.ts)
    miner = SequenceMiner()
    candidates = await miner.run(changes)

    sig_match = [
        c for c in candidates
        if c.entity_id == "light.lamp_a"
        and c.details.get("target_entity") == "light.lamp_b"
    ]
    assert len(sig_match) == 1
    c = sig_match[0]
    assert c.occurrences >= 5
    assert c.conditional_prob >= 0.7  # P(B|A) high
    assert c.details["delta_seconds"] <= 60


async def test_rejects_pair_without_high_conditional_prob():
    """If A turns on often but B almost never follows within 60s, reject."""
    base = datetime(2026, 4, 1, 20, 0, 0, tzinfo=timezone.utc)
    changes = []
    for d in range(20):
        changes.append(StateChange("light.lamp_a", "on", base + timedelta(days=d)))
    # B on only 2 times, not even close to A
    for d in [3, 7]:
        changes.append(StateChange("light.lamp_b", "on", base + timedelta(days=d, hours=10)))

    changes.sort(key=lambda c: c.ts)
    miner = SequenceMiner()
    candidates = await miner.run(changes)
    pair = [c for c in candidates if c.details.get("target_entity") == "light.lamp_b"]
    assert pair == []
```

- [ ] **Step 2: Run tests — expect ImportError**

```bash
pytest smart_suggestions/tests/miners/test_sequence.py -v
```

- [ ] **Step 3: Implement SequenceMiner**

```python
# smart_suggestions/src/miners/sequence.py
from __future__ import annotations
from collections import defaultdict
from smart_suggestions.src.candidate import Candidate, MinerType
from smart_suggestions.src.db_reader import StateChange

DELTA_SECONDS = 60
MIN_OCCURRENCES = 5
MIN_CONDITIONAL_PROB = 0.7


class SequenceMiner:
    async def run(self, changes: list[StateChange]) -> list[Candidate]:
        if not changes:
            return []

        # Count: how often each entity's "on" event is followed within Δt by each other entity's "on"
        # following[A] = total times A turned on (across the dataset)
        # follows_with[(A,B)] = times B turned on within Δt after A
        # any_b_count[B] = total times B turned on (used for lift if we want, but cond_prob = follows_with[(A,B)] / following[A])
        followings: dict[str, int] = defaultdict(int)
        follows_with: dict[tuple[str, str], list[float]] = defaultdict(list)

        # Filter to "on" transitions only for v1.
        ons = [c for c in changes if c.state == "on"]
        ons.sort(key=lambda c: c.ts)

        for i, a in enumerate(ons):
            followings[a.entity_id] += 1
            j = i + 1
            seen_in_window: set[str] = set()
            while j < len(ons) and (ons[j].ts - a.ts).total_seconds() <= DELTA_SECONDS:
                b = ons[j]
                if b.entity_id != a.entity_id and b.entity_id not in seen_in_window:
                    follows_with[(a.entity_id, b.entity_id)].append(
                        (b.ts - a.ts).total_seconds()
                    )
                    seen_in_window.add(b.entity_id)
                j += 1

        candidates: list[Candidate] = []
        for (a, b), deltas in follows_with.items():
            occurrences = len(deltas)
            cond_prob = occurrences / followings[a] if followings[a] else 0
            if occurrences < MIN_OCCURRENCES or cond_prob < MIN_CONDITIONAL_PROB:
                continue
            avg_delta = sum(deltas) / len(deltas)
            candidates.append(
                Candidate(
                    miner_type=MinerType.SEQUENCE,
                    entity_id=a,
                    action="turn_on",
                    details={
                        "target_entity": b,
                        "target_action": "turn_on",
                        "delta_seconds": int(round(avg_delta)),
                    },
                    occurrences=occurrences,
                    conditional_prob=cond_prob,
                )
            )
        return candidates
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pytest smart_suggestions/tests/miners/test_sequence.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/miners/sequence.py smart_suggestions/tests/miners/test_sequence.py
git commit -m "feat: add SequenceMiner for X-then-Y pattern detection"
```

---

### Task 7: Cross-area miner (F) — presence trigger → entity action

**Files:**
- Create: `smart_suggestions/src/miners/cross_area.py`
- Create: `smart_suggestions/tests/miners/test_cross_area.py`

**Algorithm:** For each presence-type entity (`person.*`, `device_tracker.*`, `binary_sensor.*motion*`) state change to "home"/"on", look at non-presence entity changes within next N minutes. Same lift / conditional-probability filter as Sequence, with longer window (5 min).

- [ ] **Step 1: Write tests**

```python
# smart_suggestions/tests/miners/test_cross_area.py
import pytest
from datetime import datetime, timezone, timedelta
from smart_suggestions.src.db_reader import StateChange
from smart_suggestions.src.miners.cross_area import CrossAreaMiner


async def test_arrival_home_triggers_office_heater():
    base = datetime(2026, 4, 1, 17, 30, 0, tzinfo=timezone.utc)
    changes = []
    for d in range(7):  # 7 weekdays
        t = base + timedelta(days=d)
        changes.append(StateChange("person.joe", "home", t))
        changes.append(StateChange("climate.office", "heat", t + timedelta(minutes=4)))

    changes.sort(key=lambda c: c.ts)
    miner = CrossAreaMiner()
    candidates = await miner.run(changes)

    matching = [
        c for c in candidates
        if c.details.get("trigger_entity") == "person.joe"
        and c.entity_id == "climate.office"
    ]
    assert len(matching) == 1
    c = matching[0]
    assert c.occurrences >= 5
    assert c.conditional_prob >= 0.7
    assert c.details["latency_bucket"] in {"0-2m", "2-5m"}


async def test_ignores_presence_to_presence_pairs():
    base = datetime(2026, 4, 1, 17, 30, 0, tzinfo=timezone.utc)
    changes = []
    for d in range(7):
        t = base + timedelta(days=d)
        changes.append(StateChange("person.joe", "home", t))
        changes.append(StateChange("device_tracker.phone", "home", t + timedelta(seconds=10)))
    miner = CrossAreaMiner()
    candidates = await miner.run(changes)
    assert candidates == []
```

- [ ] **Step 2: Run tests — expect ImportError**

```bash
pytest smart_suggestions/tests/miners/test_cross_area.py -v
```

- [ ] **Step 3: Implement CrossAreaMiner**

```python
# smart_suggestions/src/miners/cross_area.py
from __future__ import annotations
from collections import defaultdict
from smart_suggestions.src.candidate import Candidate, MinerType
from smart_suggestions.src.db_reader import StateChange


WINDOW_MINUTES = 5
MIN_OCCURRENCES = 5
MIN_CONDITIONAL_PROB = 0.7


_PRESENCE_PREFIXES = ("person.", "device_tracker.", "binary_sensor.")
_PRESENCE_BINARY_HINT = "motion"  # only treat binary_sensor.* as presence if name hints at motion


def _is_presence(entity_id: str) -> bool:
    if entity_id.startswith("person.") or entity_id.startswith("device_tracker."):
        return True
    if entity_id.startswith("binary_sensor.") and _PRESENCE_BINARY_HINT in entity_id:
        return True
    return False


def _is_arrival(state: str) -> bool:
    return state in {"home", "on"}


def _latency_bucket(seconds: float) -> str:
    if seconds <= 120:
        return "0-2m"
    if seconds <= 300:
        return "2-5m"
    return ">5m"


class CrossAreaMiner:
    async def run(self, changes: list[StateChange]) -> list[Candidate]:
        if not changes:
            return []
        ordered = sorted(changes, key=lambda c: c.ts)

        trigger_counts: dict[str, int] = defaultdict(int)
        # (trigger_entity, target_entity, target_action) -> list of latencies
        co: dict[tuple[str, str, str], list[float]] = defaultdict(list)

        for i, t in enumerate(ordered):
            if not _is_presence(t.entity_id) or not _is_arrival(t.state):
                continue
            trigger_counts[t.entity_id] += 1
            j = i + 1
            seen: set[tuple[str, str]] = set()
            while j < len(ordered) and (ordered[j].ts - t.ts).total_seconds() <= WINDOW_MINUTES * 60:
                target = ordered[j]
                if not _is_presence(target.entity_id):
                    key = (target.entity_id, target.state)
                    if key not in seen:
                        co[(t.entity_id, target.entity_id, target.state)].append(
                            (target.ts - t.ts).total_seconds()
                        )
                        seen.add(key)
                j += 1

        candidates: list[Candidate] = []
        for (trig, tgt_entity, tgt_state), latencies in co.items():
            occurrences = len(latencies)
            cond_prob = occurrences / trigger_counts[trig] if trigger_counts[trig] else 0
            if occurrences < MIN_OCCURRENCES or cond_prob < MIN_CONDITIONAL_PROB:
                continue
            avg_lat = sum(latencies) / len(latencies)
            candidates.append(
                Candidate(
                    miner_type=MinerType.CROSS_AREA,
                    entity_id=tgt_entity,
                    action=f"set_state_{tgt_state}",
                    details={
                        "trigger_entity": trig,
                        "latency_bucket": _latency_bucket(avg_lat),
                        "latency_seconds": int(round(avg_lat)),
                    },
                    occurrences=occurrences,
                    conditional_prob=cond_prob,
                )
            )
        return candidates
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pytest smart_suggestions/tests/miners/test_cross_area.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/miners/cross_area.py smart_suggestions/tests/miners/test_cross_area.py
git commit -m "feat: add CrossAreaMiner for presence-triggered action detection"
```

---

### Task 8: Waste detector (E) — devices on too long given context

**Files:**
- Create: `smart_suggestions/src/miners/waste.py`
- Create: `smart_suggestions/tests/miners/test_waste.py`

**Algorithm:** For each "on" entity right now, compute its current uninterrupted-on duration. Compare against a 30-day baseline of the median on-duration *for that hour-of-day*. If current exceeds baseline by 3× and is ≥ 1 hour, emit a waste candidate. (Also handles "heater on with window open" via additional context rule.)

- [ ] **Step 1: Write tests**

```python
# smart_suggestions/tests/miners/test_waste.py
import pytest
from datetime import datetime, timezone, timedelta
from smart_suggestions.src.db_reader import StateChange
from smart_suggestions.src.miners.waste import WasteDetector


async def test_detects_garage_light_left_on_far_longer_than_baseline():
    """Baseline: garage light typically on for ~30 min in afternoon. Today: 14h."""
    now = datetime(2026, 4, 30, 14, 0, 0, tzinfo=timezone.utc)
    history = []
    # 30 days of normal: on for 30 min around 11am
    for d in range(1, 31):
        on_t = now - timedelta(days=d, hours=3)  # 11am d days ago
        history.append(StateChange("light.garage", "on", on_t))
        history.append(StateChange("light.garage", "off", on_t + timedelta(minutes=30)))
    # Today: turned on 14 hours ago, still on
    today_on = now - timedelta(hours=14)
    history.append(StateChange("light.garage", "on", today_on))
    current = {"light.garage": ("on", today_on)}

    detector = WasteDetector()
    candidates = await detector.run(history, current_states=current, now=now)

    matching = [c for c in candidates if c.entity_id == "light.garage"]
    assert len(matching) == 1
    c = matching[0]
    assert c.action == "currently_on"
    assert c.details["duration_seconds"] >= 14 * 3600
    assert c.details["baseline_seconds"] <= 60 * 60


async def test_does_not_flag_normal_duration():
    now = datetime(2026, 4, 30, 14, 0, 0, tzinfo=timezone.utc)
    history = []
    for d in range(1, 31):
        on_t = now - timedelta(days=d, hours=3)
        history.append(StateChange("light.garage", "on", on_t))
        history.append(StateChange("light.garage", "off", on_t + timedelta(minutes=30)))
    # Today: on for 20 minutes, normal
    today_on = now - timedelta(minutes=20)
    history.append(StateChange("light.garage", "on", today_on))
    current = {"light.garage": ("on", today_on)}

    detector = WasteDetector()
    candidates = await detector.run(history, current_states=current, now=now)
    assert candidates == []
```

- [ ] **Step 2: Run tests — expect ImportError**

```bash
pytest smart_suggestions/tests/miners/test_waste.py -v
```

- [ ] **Step 3: Implement WasteDetector**

```python
# smart_suggestions/src/miners/waste.py
from __future__ import annotations
from collections import defaultdict
from datetime import datetime, timedelta
from statistics import median
from smart_suggestions.src.candidate import Candidate, MinerType
from smart_suggestions.src.db_reader import StateChange


MIN_DURATION_HOURS = 1
ANOMALY_MULTIPLIER = 3.0


class WasteDetector:
    async def run(
        self,
        history: list[StateChange],
        current_states: dict[str, tuple[str, datetime]],
        now: datetime,
    ) -> list[Candidate]:
        baseline = self._compute_baseline_durations(history)
        candidates: list[Candidate] = []

        for entity_id, (state, since) in current_states.items():
            if state != "on":
                continue
            current_dur = (now - since).total_seconds()
            if current_dur < MIN_DURATION_HOURS * 3600:
                continue

            base = baseline.get(entity_id)
            if base is None:
                continue
            if current_dur < base * ANOMALY_MULTIPLIER:
                continue

            candidates.append(
                Candidate(
                    miner_type=MinerType.WASTE,
                    entity_id=entity_id,
                    action="currently_on",
                    details={
                        "condition": "on_duration_anomaly",
                        "duration_seconds": int(current_dur),
                        "baseline_seconds": int(base),
                        "since": since.isoformat(),
                    },
                    occurrences=1,
                    conditional_prob=1.0,
                )
            )
        return candidates

    def _compute_baseline_durations(
        self, history: list[StateChange]
    ) -> dict[str, float]:
        """Return median on-duration per entity over the history window."""
        by_entity: dict[str, list[StateChange]] = defaultdict(list)
        for c in history:
            by_entity[c.entity_id].append(c)

        out: dict[str, float] = {}
        for entity_id, changes in by_entity.items():
            changes.sort(key=lambda c: c.ts)
            durations = []
            on_at: datetime | None = None
            for c in changes:
                if c.state == "on" and on_at is None:
                    on_at = c.ts
                elif c.state == "off" and on_at is not None:
                    durations.append((c.ts - on_at).total_seconds())
                    on_at = None
            if durations:
                out[entity_id] = median(durations)
        return out
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pytest smart_suggestions/tests/miners/test_waste.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/miners/waste.py smart_suggestions/tests/miners/test_waste.py
git commit -m "feat: add WasteDetector for anomalously-long on-duration alerts"
```

---

## Phase C: Filter & LLM

### Task 9: Candidate filter

**Files:**
- Create: `smart_suggestions/src/candidate_filter.py`
- Create: `smart_suggestions/tests/test_candidate_filter.py`

The filter applies the four spec criteria. It is given:
- A list of candidates
- A set of `entity_id`s already covered by active HA automations (from `ha_client`)
- A `DismissalStore`
- A per-miner-type threshold map (default 0.7 conditional probability; can be raised by feedback loop)

- [ ] **Step 1: Write tests**

```python
# smart_suggestions/tests/test_candidate_filter.py
import pytest
from datetime import timedelta
from smart_suggestions.src.candidate import Candidate, MinerType
from smart_suggestions.src.candidate_filter import CandidateFilter


class FakeDismissalStore:
    def __init__(self, dismissed_signatures=()):
        self.dismissed = set(dismissed_signatures)
        self.dismissals_by_miner: dict[MinerType, int] = {}

    async def is_dismissed(self, sig, within):
        return sig in self.dismissed

    async def dismissals_per_miner_in_window(self, mt, window):
        return self.dismissals_by_miner.get(mt, 0)


def _temporal(entity, occ=10, prob=0.85):
    return Candidate(
        miner_type=MinerType.TEMPORAL,
        entity_id=entity,
        action="turn_on",
        details={"hour": 6, "minute": 45, "weekdays": [0,1,2,3,4]},
        occurrences=occ,
        conditional_prob=prob,
    )


async def test_filters_by_min_occurrences():
    f = CandidateFilter(
        automated_entities=set(),
        dismissal_store=FakeDismissalStore(),
    )
    weak = _temporal("light.weak", occ=4)
    strong = _temporal("light.strong", occ=10)
    out = await f.filter([weak, strong])
    ids = [c.entity_id for c in out]
    assert ids == ["light.strong"]


async def test_filters_by_conditional_prob():
    f = CandidateFilter(
        automated_entities=set(),
        dismissal_store=FakeDismissalStore(),
    )
    weak = _temporal("light.weak", prob=0.5)
    strong = _temporal("light.strong", prob=0.85)
    out = await f.filter([weak, strong])
    assert [c.entity_id for c in out] == ["light.strong"]


async def test_drops_already_automated():
    f = CandidateFilter(
        automated_entities={"light.already"},
        dismissal_store=FakeDismissalStore(),
    )
    out = await f.filter([_temporal("light.already"), _temporal("light.new")])
    assert [c.entity_id for c in out] == ["light.new"]


async def test_drops_dismissed():
    c = _temporal("light.kitchen")
    store = FakeDismissalStore(dismissed_signatures={c.signature()})
    f = CandidateFilter(automated_entities=set(), dismissal_store=store)
    out = await f.filter([c])
    assert out == []


async def test_threshold_bumps_with_dismissal_history():
    """If 3+ dismissals on same miner type in last 7d, bump threshold by 5pp."""
    store = FakeDismissalStore()
    store.dismissals_by_miner[MinerType.TEMPORAL] = 3
    f = CandidateFilter(automated_entities=set(), dismissal_store=store)

    borderline = _temporal("light.borderline", prob=0.71)  # passes default 0.7
    out = await f.filter([borderline])
    assert out == []  # threshold should now be 0.75 → fails
```

- [ ] **Step 2: Run tests — expect ImportError**

```bash
pytest smart_suggestions/tests/test_candidate_filter.py -v
```

- [ ] **Step 3: Implement CandidateFilter**

```python
# smart_suggestions/src/candidate_filter.py
from __future__ import annotations
from datetime import timedelta
from smart_suggestions.src.candidate import Candidate, MinerType


DEFAULT_MIN_OCCURRENCES = 5
DEFAULT_MIN_CONDITIONAL_PROB = 0.7
DISMISSAL_WINDOW = timedelta(days=14)
THRESHOLD_BUMP_WINDOW = timedelta(days=7)
THRESHOLD_BUMP_PER_3_DISMISSALS = 0.05
MAX_THRESHOLD = 0.9


class CandidateFilter:
    def __init__(
        self,
        automated_entities: set[str],
        dismissal_store,
        min_occurrences: int = DEFAULT_MIN_OCCURRENCES,
        min_conditional_prob: float = DEFAULT_MIN_CONDITIONAL_PROB,
    ):
        self.automated_entities = automated_entities
        self.dismissal_store = dismissal_store
        self.min_occurrences = min_occurrences
        self.min_conditional_prob = min_conditional_prob

    async def filter(self, candidates: list[Candidate]) -> list[Candidate]:
        # Compute per-miner-type effective threshold (potentially bumped by dismissals).
        thresholds: dict[MinerType, float] = {}
        for mt in MinerType:
            n = await self.dismissal_store.dismissals_per_miner_in_window(
                mt, THRESHOLD_BUMP_WINDOW
            )
            bumps = n // 3
            thresholds[mt] = min(
                MAX_THRESHOLD,
                self.min_conditional_prob + bumps * THRESHOLD_BUMP_PER_3_DISMISSALS,
            )

        survivors: list[Candidate] = []
        for c in candidates:
            if c.occurrences < self.min_occurrences:
                continue
            # Waste candidates have synthetic conditional_prob = 1.0; they pass this gate.
            if c.conditional_prob < thresholds[c.miner_type]:
                continue
            if c.entity_id in self.automated_entities:
                continue
            if await self.dismissal_store.is_dismissed(c.signature(), DISMISSAL_WINDOW):
                continue
            survivors.append(c)
        return survivors
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pytest smart_suggestions/tests/test_candidate_filter.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/candidate_filter.py smart_suggestions/tests/test_candidate_filter.py
git commit -m "feat: add CandidateFilter applying four-criteria gate + dismissal-driven threshold bumps"
```

---

### Task 10: LLM describer with cache

**Files:**
- Create: `smart_suggestions/src/llm_describer.py`
- Create: `smart_suggestions/tests/test_llm_describer.py`

Single Claude call per surviving candidate. Output: `{title, description, automation_yaml}`. Cache keyed by `Candidate.signature()` with 7-day TTL.

- [ ] **Step 1: Write tests using a mock anthropic client**

```python
# smart_suggestions/tests/test_llm_describer.py
import pytest
from datetime import datetime, timezone, timedelta
from smart_suggestions.src.candidate import Candidate, MinerType
from smart_suggestions.src.llm_describer import LlmDescriber, Description


class FakeAnthropic:
    def __init__(self):
        self.calls = 0
        self.messages = self
    async def create(self, **kwargs):
        self.calls += 1
        # Return a faux response that the describer parses
        class R:
            content = [type("X", (), {"text": (
                '{"title": "Morning kitchen lights", '
                '"description": "Every weekday at 6:45am you turn on the kitchen lights.", '
                '"automation_yaml": "alias: Morning Kitchen\\ntrigger:\\n  - platform: time\\n    at: 06:45:00\\naction:\\n  - service: light.turn_on\\n    target:\\n      entity_id: light.kitchen"}'
            )})()]
        return R()


@pytest.fixture
def candidate():
    return Candidate(
        miner_type=MinerType.TEMPORAL,
        entity_id="light.kitchen",
        action="turn_on",
        details={"hour": 6, "minute": 45, "weekdays": [0,1,2,3,4]},
        occurrences=10,
        conditional_prob=0.85,
    )


async def test_describer_returns_parsed_response(candidate, tmp_path):
    fake = FakeAnthropic()
    d = LlmDescriber(client=fake, cache_path=tmp_path / "llm.db")
    await d.init()
    desc = await d.describe(candidate)
    assert isinstance(desc, Description)
    assert "kitchen" in desc.title.lower()
    assert "06:45" in desc.automation_yaml or "6:45" in desc.automation_yaml


async def test_describer_caches_by_signature(candidate, tmp_path):
    fake = FakeAnthropic()
    d = LlmDescriber(client=fake, cache_path=tmp_path / "llm.db")
    await d.init()
    await d.describe(candidate)
    await d.describe(candidate)  # second call should hit cache
    assert fake.calls == 1


async def test_describer_cache_expires_after_ttl(candidate, tmp_path, monkeypatch):
    import smart_suggestions.src.llm_describer as mod
    fake = FakeAnthropic()
    d = LlmDescriber(client=fake, cache_path=tmp_path / "llm.db", ttl=timedelta(seconds=1))
    await d.init()
    await d.describe(candidate)
    # Fast-forward by 2s by monkeypatching now()
    real_now = datetime.now(timezone.utc) + timedelta(seconds=2)
    monkeypatch.setattr(mod, "_now", lambda: real_now)
    await d.describe(candidate)
    assert fake.calls == 2
```

- [ ] **Step 2: Run tests — expect ImportError**

```bash
pytest smart_suggestions/tests/test_llm_describer.py -v
```

- [ ] **Step 3: Implement LlmDescriber**

```python
# smart_suggestions/src/llm_describer.py
from __future__ import annotations
import aiosqlite
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from smart_suggestions.src.candidate import Candidate


DEFAULT_TTL = timedelta(days=7)
DEFAULT_MODEL = "claude-haiku-4-5-20251001"


@dataclass(frozen=True)
class Description:
    title: str
    description: str
    automation_yaml: str


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _build_prompt(c: Candidate) -> str:
    return f"""You generate Home Assistant automation suggestions from already-validated patterns.
Pattern: {c.miner_type.value}
Entity: {c.entity_id}
Action: {c.action}
Details: {json.dumps(c.details, sort_keys=True)}
Occurrences: {c.occurrences}
Conditional probability: {c.conditional_prob:.2f}

Respond with a single JSON object with keys: title (string, ≤60 chars), description (string, one sentence), automation_yaml (string, valid HA automation YAML — alias, trigger, action). No prose, no markdown fences. Just JSON.
"""


class LlmDescriber:
    def __init__(
        self,
        client,
        cache_path: str | Path,
        model: str = DEFAULT_MODEL,
        ttl: timedelta = DEFAULT_TTL,
    ):
        self.client = client
        self.cache_path = Path(cache_path)
        self.model = model
        self.ttl = ttl

    async def init(self):
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.cache_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS llm_cache (
                    signature TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    automation_yaml TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
            """)
            await db.commit()

    async def describe(self, candidate: Candidate) -> Description:
        sig = candidate.signature()
        cached = await self._get_cached(sig)
        if cached:
            return cached

        prompt = _build_prompt(candidate)
        resp = await self.client.messages.create(
            model=self.model,
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        text = resp.content[0].text
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"LLM returned non-JSON: {text!r}") from e

        desc = Description(
            title=payload["title"],
            description=payload["description"],
            automation_yaml=payload["automation_yaml"],
        )
        await self._store(sig, desc)
        return desc

    async def _get_cached(self, sig: str) -> Description | None:
        cutoff = (_now() - self.ttl).timestamp()
        async with aiosqlite.connect(self.cache_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM llm_cache WHERE signature = ? AND created_at >= ?",
                (sig, cutoff),
            )
            row = await cursor.fetchone()
        if not row:
            return None
        return Description(
            title=row["title"],
            description=row["description"],
            automation_yaml=row["automation_yaml"],
        )

    async def _store(self, sig: str, desc: Description):
        async with aiosqlite.connect(self.cache_path) as db:
            await db.execute(
                """INSERT OR REPLACE INTO llm_cache
                   (signature, title, description, automation_yaml, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (sig, desc.title, desc.description, desc.automation_yaml, _now().timestamp()),
            )
            await db.commit()
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
pytest smart_suggestions/tests/test_llm_describer.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add smart_suggestions/src/llm_describer.py smart_suggestions/tests/test_llm_describer.py
git commit -m "feat: add LlmDescriber with SQLite-backed signature cache"
```

---

## Phase D: Pipeline integration & cleanup

### Task 11: Integrate pipeline into main.py

**Files:**
- Modify: `smart_suggestions/src/main.py`

The current `main.py` runs an async loop that calls `statistical_engine`, `anthropic_analyzer`, and writes suggestions. We are *adding* a new path: the miner pipeline. Old paths come out in Task 12.

This task is small in code but high in coordination — re-read `main.py` at the start.

- [ ] **Step 1: Re-read the current `main.py` and identify the existing scheduler loop**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
wc -l smart_suggestions/src/main.py
grep -n "async def" smart_suggestions/src/main.py | head -30
```

This locates the scheduler functions and the main analysis call. Note line numbers.

- [ ] **Step 2: Add a new `mine_and_emit_suggestions` async function**

Insert after the existing analysis function (look for whatever currently calls `anthropic_analyzer`).

```python
# in main.py, near the top with other imports:
from smart_suggestions.src.db_reader import DbReader
from smart_suggestions.src.dismissal_store import DismissalStore
from smart_suggestions.src.candidate_filter import CandidateFilter
from smart_suggestions.src.llm_describer import LlmDescriber
from smart_suggestions.src.miners.temporal import TemporalMiner
from smart_suggestions.src.miners.sequence import SequenceMiner
from smart_suggestions.src.miners.cross_area import CrossAreaMiner
from smart_suggestions.src.miners.waste import WasteDetector
from datetime import datetime, timezone, timedelta
```

```python
# new function:
async def mine_and_emit_suggestions(
    db_reader: DbReader,
    dismissal_store: DismissalStore,
    llm_describer: LlmDescriber,
    ha_client,  # existing module
    history_window_days: int = 30,
    include_waste: bool = True,
):
    since = datetime.now(timezone.utc) - timedelta(days=history_window_days)
    all_changes = await db_reader.get_all_state_changes(since)

    # Run miners in parallel-ish (each is CPU-bound but fast)
    temporal = await TemporalMiner().run(all_changes, now=datetime.now(timezone.utc))
    sequence = await SequenceMiner().run(all_changes)
    cross = await CrossAreaMiner().run(all_changes)
    candidates = list(temporal) + list(sequence) + list(cross)

    if include_waste:
        current_states = await ha_client.get_current_on_states()  # see Step 3
        waste = await WasteDetector().run(all_changes, current_states, datetime.now(timezone.utc))
        candidates += waste

    automated_entities = await ha_client.get_automated_entities()  # see Step 3
    candidate_filter = CandidateFilter(
        automated_entities=automated_entities,
        dismissal_store=dismissal_store,
    )
    survivors = await candidate_filter.filter(candidates)

    suggestions = []
    for c in survivors:
        desc = await llm_describer.describe(c)
        suggestions.append({
            "miner_type": c.miner_type.value,
            "entity_id": c.entity_id,
            "action": c.action,
            "title": desc.title,
            "description": desc.description,
            "automation_yaml": desc.automation_yaml,
            "confidence": c.conditional_prob,
            "signature": c.signature(),
            "zone": "noticed" if c.miner_type.value == "waste" else "suggestion",
        })

    await ha_client.write_suggestions(suggestions)  # existing endpoint
```

- [ ] **Step 3: Add `get_current_on_states` and `get_automated_entities` to `ha_client.py`**

Open `smart_suggestions/src/ha_client.py`. Add two helper methods to whatever class is there (likely `HAClient`):

```python
async def get_current_on_states(self) -> dict[str, tuple[str, datetime]]:
    """Return {entity_id: (state, last_changed_dt)} for entities currently 'on'."""
    states = await self.get_states()  # existing method that hits /api/states
    out = {}
    for s in states:
        if s.get("state") == "on":
            last = s.get("last_changed")  # ISO 8601
            if last:
                out[s["entity_id"]] = ("on", datetime.fromisoformat(last.replace("Z", "+00:00")))
    return out


async def get_automated_entities(self) -> set[str]:
    """Return set of entity_ids referenced as `target.entity_id` in any active automation."""
    automations = await self._get("/api/states", filter_prefix="automation.")
    # Each automation entity has attributes.entity_id (list), or we read /api/config/automation/config
    out: set[str] = set()
    config_resp = await self._get("/api/config/automation/config")
    if isinstance(config_resp, list):
        for auto in config_resp:
            for action in auto.get("action", []):
                target = action.get("target") or {}
                eid = target.get("entity_id")
                if isinstance(eid, str):
                    out.add(eid)
                elif isinstance(eid, list):
                    out.update(eid)
    return out
```

If `ha_client.py` does not yet have a generic `_get`, mirror whatever existing GET helper it has. The exact signatures must match the surrounding code style — read first, copy.

- [ ] **Step 4: Wire the pipeline into the existing scheduler**

Find the current scheduler in `main.py` (likely an `asyncio.create_task(...)` of a periodic loop). Replace its call to `anthropic_analyzer` with a call to `mine_and_emit_suggestions`. Add a separate 5-min loop just for waste:

```python
async def hourly_mining_loop(...):
    while True:
        try:
            await mine_and_emit_suggestions(..., include_waste=False)
        except Exception:
            log.exception("hourly mining failed")
        await asyncio.sleep(3600)


async def waste_check_loop(state, db_reader, dismissal_store, llm_describer, ha_client):
    while True:
        try:
            await mine_and_emit_waste_only(state, db_reader, dismissal_store, llm_describer, ha_client)
        except Exception:
            log.exception("waste check failed")
        await asyncio.sleep(300)
```

The `state` object is a simple dict held at module level (or on the main app object): `state = {"last_suggestion_zone": [], "last_noticed_zone": []}`. Implement `mine_and_emit_waste_only`:

```python
async def mine_and_emit_waste_only(state, db_reader, dismissal_store, llm_describer, ha_client):
    since = datetime.now(timezone.utc) - timedelta(days=30)
    history = await db_reader.get_all_state_changes(since)
    current = await ha_client.get_current_on_states()
    waste = await WasteDetector().run(history, current, datetime.now(timezone.utc))

    automated = await ha_client.get_automated_entities()
    cf = CandidateFilter(automated_entities=automated, dismissal_store=dismissal_store)
    survivors = await cf.filter(waste)

    noticed = []
    for c in survivors:
        desc = await llm_describer.describe(c)
        noticed.append({
            "miner_type": c.miner_type.value,
            "entity_id": c.entity_id,
            "action": c.action,
            "title": desc.title,
            "description": desc.description,
            "automation_yaml": desc.automation_yaml,
            "confidence": c.conditional_prob,
            "signature": c.signature(),
            "zone": "noticed",
        })
    state["last_noticed_zone"] = noticed
    combined = state.get("last_suggestion_zone", []) + noticed
    await ha_client.write_suggestions(combined)
```

And update `mine_and_emit_suggestions` (from Step 2) to write to `state["last_suggestion_zone"]` instead of just the local list, so the merge in `mine_and_emit_waste_only` works.

- [ ] **Step 5: Smoke-test the integration**

```bash
pytest smart_suggestions/tests/test_main_smoke.py -v
```

If smoke tests reference removed modules (anthropic_analyzer), update them to import from the new modules — but only minimally. Do NOT delete the old modules yet (Task 12 does that).

- [ ] **Step 6: Commit**

```bash
git add smart_suggestions/src/main.py smart_suggestions/src/ha_client.py
git commit -m "feat: wire miner pipeline into main scheduler with hourly + 5-min loops"
```

---

### Task 12: Remove deprecated analyzer/narrator paths

**Files:**
- Delete: `smart_suggestions/src/anthropic_analyzer.py`
- Delete: `smart_suggestions/src/ollama_narrator.py`
- Delete: `smart_suggestions/tests/test_anthropic_analyzer.py`
- Delete: `smart_suggestions/tests/test_ollama_narrator.py`
- Modify: `smart_suggestions/src/main.py` (drop unused imports)
- Modify: `smart_suggestions/config.yaml` (drop options for removed modules)

- [ ] **Step 1: Verify no other module still imports the deprecated ones**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
grep -rn "anthropic_analyzer\|ollama_narrator" smart_suggestions/src/ smart_suggestions/tests/ | grep -v __pycache__
```

Expected: only references in the files about to be deleted, plus possibly historical mentions in `narrator.py` (separate from `ollama_narrator.py` — leave `narrator.py` alone unless it imports the deleted ones).

- [ ] **Step 2: Delete the four files**

```bash
rm smart_suggestions/src/anthropic_analyzer.py
rm smart_suggestions/src/ollama_narrator.py
rm smart_suggestions/tests/test_anthropic_analyzer.py
rm smart_suggestions/tests/test_ollama_narrator.py
```

- [ ] **Step 3: Run the full test suite**

```bash
pytest smart_suggestions/tests/ -v
```

Expected: all green. If any test now fails because of an import to a deleted module, fix the test (or delete it if it was testing only the removed behavior).

- [ ] **Step 4: Trim `config.yaml` options**

In `smart_suggestions/config.yaml`, remove the options that fed only the deleted modules:
- `deep_analysis_model` (was anthropic_analyzer's deep model)
- `pattern_confidence_threshold` if only used there (verify with grep first)
- `analysis_schedule` and `analysis_interval_hours` if those were the analyzer's schedule (the new pipeline uses fixed 1h/5min)

Keep: `ha_url`, `ha_token`, `ai_provider`, `ai_api_key`, `ai_base_url`, `ai_model` (now used by `LlmDescriber`), `domains`, `max_suggestions`.

Add new options if needed:
```yaml
mining_history_days: 30
mining_interval_hours: 1
waste_check_interval_minutes: 5
min_pattern_occurrences: 5
min_pattern_confidence: 0.7
```

And mirror these in the `schema:` block at the bottom of `config.yaml` so HA validates them.

- [ ] **Step 5: Bump add-on version**

In `config.yaml`:
```yaml
version: "3.0.0"
```

This is a breaking config change (removed options) so a major bump is appropriate.

- [ ] **Step 6: Commit**

```bash
git add -A smart_suggestions/
git commit -m "feat: remove deprecated anthropic_analyzer and ollama_narrator; bump to v3.0.0"
```

---

## Phase E: Card UX (HA repo)

### Task 13: Two-zone card layout

**Files:**
- Modify: `custom_components/smart_suggestions/smart-suggestions-card.js`

The card currently renders a flat list of suggestions. We split into two zones based on `suggestion.zone` field (set by `mine_and_emit_suggestions` in Task 11).

Switch repos:
```bash
cd /Users/jgray/Desktop/smart-suggestions-ha
```

- [ ] **Step 1: Re-read the card to find the rendering function**

```bash
wc -l custom_components/smart_suggestions/smart-suggestions-card.js
grep -n "render\|suggestion" custom_components/smart_suggestions/smart-suggestions-card.js | head -30
```

Identify the function that maps suggestions → DOM (likely `_render` or the lit-html `render()` method).

- [ ] **Step 2: Split rendering into two arrays**

Inside the render function, near where `this._suggestions` is iterated, split into:

```js
const suggestionsTop = (this._suggestions || []).filter(s => s.zone !== "noticed").slice(0, 3);
const noticedBottom = (this._suggestions || []).filter(s => s.zone === "noticed").slice(0, 5);
```

Then render two visually-distinct sections. The exact HTML/CSS depends on the existing card structure; copy the existing per-card style and just produce two grouped sections with section headers:

```js
return html`
  ${suggestionsTop.length > 0 ? html`
    <div class="zone zone-suggestions">
      <div class="zone-header"><span class="zone-icon">●</span> Suggestions</div>
      ${suggestionsTop.map(s => this._renderSuggestion(s, "suggestion"))}
    </div>
  ` : ""}
  ${noticedBottom.length > 0 ? html`
    <div class="zone zone-noticed">
      <div class="zone-header"><span class="zone-icon">●</span> Noticed</div>
      ${noticedBottom.map(s => this._renderSuggestion(s, "noticed"))}
    </div>
  ` : ""}
`;
```

Add CSS:
```js
// in the static get styles() return value:
.zone-header {
  font-size: 0.85em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--secondary-text-color);
  padding: 8px 12px 4px;
}
.zone-suggestions .zone-icon { color: #4caf50; }
.zone-noticed .zone-icon { color: #f9a825; }
.zone-noticed .suggestion-card { border-left: 3px solid #f9a825; }
.zone-suggestions .suggestion-card { border-left: 3px solid #4caf50; }
```

- [ ] **Step 3: Add per-zone primary action button**

In `_renderSuggestion(suggestion, zoneKind)` (rename or extract from existing renderer):

```js
const primaryAction = zoneKind === "noticed"
  ? html`<button @click=${() => this._turnOff(suggestion)}>Turn off</button>`
  : html`<button @click=${() => this._createAutomation(suggestion)}>Create Automation</button>`;
```

`_turnOff(s)` should call HA service `<domain>.turn_off` with `target.entity_id = s.entity_id`. `_createAutomation(s)` should match the existing "Get Automation YAML" behavior — open the YAML modal that already exists, prefilled with `s.automation_yaml`.

- [ ] **Step 4: Manual smoke test**

This is a JS card — no automated tests in this repo. To verify:

1. Bump card version: edit `manifest.json` to bump version (e.g., `2.1.0 → 3.0.0`).
2. Update the `?v=` query string in `__init__.py` (or wherever the card URL is registered) to bust HA's cache.
3. Build the dist if there's a bundler (check `dist/` dir — if yes, run the build).
4. In HA: hard-refresh the dashboard, confirm two zones render with synthetic suggestions.

If you don't yet have synthetic suggestions, write a small JSON to `smart_suggestions.suggestions` state via the HA dev tools to simulate (one in each zone).

- [ ] **Step 5: Commit**

```bash
git add custom_components/smart_suggestions/smart-suggestions-card.js custom_components/smart_suggestions/manifest.json custom_components/smart_suggestions/__init__.py
git commit -m "feat: render suggestions in two zones (Suggestions/Noticed) with per-zone actions"
```

---

### Task 14: Wire dismissal feedback

**Files:**
- Modify: `custom_components/smart_suggestions/smart-suggestions-card.js`
- Verify: `smart_suggestions/src/ws_server.py` (in addon) handles a `dismiss` message

The card needs to send a dismissal message back to the add-on WS so it lands in `DismissalStore`.

- [ ] **Step 1: Check addon WS server for a dismiss handler**

Switch back to addon repo:
```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
grep -n "dismiss\|feedback" smart_suggestions/src/ws_server.py
```

If a `dismiss` handler exists, note its message shape. If not, add one:

```python
# in ws_server.py, message dispatch:
elif msg_type == "dismiss":
    sig = data.get("signature")
    miner_type_str = data.get("miner_type")
    if sig and miner_type_str:
        from smart_suggestions.src.candidate import MinerType
        await self.dismissal_store.add_dismissal(
            sig, MinerType(miner_type_str), datetime.now(timezone.utc)
        )
        await ws.send_json({"type": "dismiss_ack", "signature": sig})
```

(The `self.dismissal_store` reference assumes the WS server holds a reference; pass it in during construction in `main.py`.)

- [ ] **Step 2: Card sends dismiss on 👎**

Switch to HA repo:
```bash
cd /Users/jgray/Desktop/smart-suggestions-ha
```

In the card's existing thumbs-down handler, add:

```js
async _dismiss(suggestion) {
  if (this._ws && this._ws.readyState === WebSocket.OPEN) {
    this._ws.send(JSON.stringify({
      type: "dismiss",
      signature: suggestion.signature,
      miner_type: suggestion.miner_type,
    }));
  }
  // Also remove from local state so it disappears immediately:
  this._suggestions = this._suggestions.filter(s => s.signature !== suggestion.signature);
  this.requestUpdate();
}
```

Make sure `_renderSuggestion` wires the existing 👎 button to `this._dismiss(suggestion)` (or whatever the existing function name is — check first).

- [ ] **Step 3: Smoke test**

In HA:
1. Open card with at least one suggestion visible.
2. Click 👎.
3. Confirm: suggestion disappears from card, AND on the next mining cycle, the same pattern does *not* reappear (it's in `DismissalStore`).

(For step 3, you can shorten the cycle by manually triggering `refresh_all` via the existing endpoint.)

- [ ] **Step 4: Commit (in both repos)**

In addon repo:
```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
git add smart_suggestions/src/ws_server.py
git commit -m "feat: WS server handles dismiss messages, persists to DismissalStore"
```

In HA repo:
```bash
cd /Users/jgray/Desktop/smart-suggestions-ha
git add custom_components/smart_suggestions/smart-suggestions-card.js
git commit -m "feat: card sends dismiss over WS and removes suggestion from view"
```

---

## Final verification

- [ ] **Step 1: Full test suite passes**

```bash
cd /Users/jgray/Desktop/smart-suggestions-addon
pytest smart_suggestions/tests/ -v
```

Expected: all green, including all new miner / filter / describer tests.

- [ ] **Step 2: Manual end-to-end smoke**

1. Install the new add-on version on a real HA instance.
2. Wait for one hourly mining cycle (or manually trigger).
3. Verify: card shows suggestions in two zones; LLM token usage in `usage_log.py` is dramatically lower than before; no entries reference `anthropic_analyzer` or `ollama_narrator`.
4. Click 👎 on one suggestion; verify it stays gone after next cycle.

- [ ] **Step 3: Tag releases**

If smoke passes:
```bash
# in addon repo
git tag v3.0.0 && git push --tags
# in HA repo (after bumping CARD_VERSION + manifest.json)
git tag v3.0.0 && git push --tags
```

(Only run these if user explicitly asks — do not auto-tag.)
