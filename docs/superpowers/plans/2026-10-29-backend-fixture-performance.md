# Backend Fixture Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce repeated PostgreSQL test setup cost without weakening per-test schema isolation or permission coverage.

**Architecture:** Keep the existing random-schema fixture and FastAPI TestClient flow. Use a shared, cached, test-only bcrypt helper with cost 4 for fixture users, then verify login through the production verifier. Do not reuse schemas or engines.

**Tech Stack:** pytest, FastAPI TestClient, SQLAlchemy, PostgreSQL, bcrypt

## Global Constraints

- Keep a random schema per database test and drop it after each test.
- Do not change production password hashing or login behavior.
- Do not delete tests or weaken assertions for speed.
- Compare performance with the same six test files and the same local PostgreSQL database.
- Run backend tests with `APP_ENV=test` and a non-production `TEST_DATABASE_URL`.

---

### Task 1: Reuse Default Account Password Hashes

**Files:**
- Modify: `tests/conftest.py:1`
- Create: `tests/test_fixture_performance.py`

**Interfaces:**
- Consumes: `api.core.security.hash_password(raw: str) -> str`
- Produces: `tests.conftest._default_password_hash(password: str) -> str`, a process-local cached wrapper used only by the default fixture users.

- [x] **Step 1: Write the failing test**

```python
from tests import conftest


def test_default_password_hash_reuses_result_per_password(monkeypatch):
    calls = []
    password = "fixture-performance-probe"

    def fake_hash(raw: str) -> str:
        calls.append(raw)
        return f"hashed:{raw}"

    monkeypatch.setattr(conftest, "hash_password", fake_hash)
    first = conftest._default_password_hash(password)
    second = conftest._default_password_hash(password)

    assert first == second == f"hashed:{password}"
    assert calls == [password]
```

- [x] **Step 2: Run the test to verify it fails**

Run:

```bash
env TEST_DATABASE_URL="$TEST_DATABASE_URL" APP_ENV=test \
  pytest tests/test_fixture_performance.py -q
```

Expected: FAIL because `_default_password_hash` does not exist.

- [x] **Step 3: Implement the cached wrapper**

Add `from functools import lru_cache` and:

```python
@lru_cache(maxsize=None)
def _default_password_hash(password: str) -> str:
    return hash_password(password)
```

Use `_default_password_hash(password)` inside the fixture's `mk` helper.

- [x] **Step 4: Run the focused test**

Run:

```bash
env TEST_DATABASE_URL="$TEST_DATABASE_URL" APP_ENV=test \
  pytest tests/test_fixture_performance.py -q
```

Expected: PASS.

- [x] **Step 5: Re-run the six-file performance sample**

Run:

```bash
/usr/bin/time -p env \
  TEST_DATABASE_URL="$TEST_DATABASE_URL" \
  APP_ENV=test pytest \
  tests/test_project_change_autosave.py \
  tests/test_project_changes_ledger.py \
  tests/test_blf1150_client_fields.py \
  tests/test_blf1148_owner_dept.py \
  tests/test_project_receivables.py \
  tests/test_mvp.py \
  -q --durations=30
```

Expected: 87 tests pass, and total runtime is materially below the 199.87-second baseline.

Result: 87 tests passed in 77.04 seconds, down from 199.87 seconds.

Task 3 replaces `_default_password_hash` with the shared `tests.support.hash_test_password` helper so test-created users receive the same optimization.

### Task 2: Measure Remaining Fixture Cost

**Files:**
- Modify only if measurements justify it: `tests/conftest.py`

**Interfaces:**
- Consumes: the Task 1 fixture.
- Produces: a measured decision on whether schema initialization needs further work.

- [x] **Step 1: Compare setup durations**

Compare the slowest `setup` entries with the baseline recorded in this session.

- [x] **Step 2: Profile one setup-only case if setup still exceeds 1 second**

Run:

```bash
env TEST_DATABASE_URL="$TEST_DATABASE_URL" APP_ENV=test \
  python -m cProfile -s cumulative -m pytest tests/test_mvp.py::test_unauth_401 -q
```

Expected: identify whether remaining time is PostgreSQL connections, `create_all`, seed writes, or test execution.

Result: the first fixture in a process still pays 1.39 seconds for the six cached hashes. After warm-up, two consecutive fixture-backed tests take 2.45 seconds total including imports; `create_all` is about 0.20 seconds per test, and one real login bcrypt check is about 0.25 seconds.

- [x] **Step 3: Stop and review before sharing schemas or engines**

Do not reuse a schema or replace the fixture transaction model unless the profile demonstrates the benefit and the permission, audit, migration, and concurrent-payment tests remain isolated.

Decision: no schema or engine sharing in this change. The remaining per-test `create_all` cost is much smaller than the saved repeated hashing, while sharing schemas would put concurrent-payment, audit rollback, and migration coverage at risk.

### Task 3: Use Fast Test-Only Password Hashes

**Files:**
- Create: `tests/support.py`
- Modify: `tests/conftest.py`
- Modify: `tests/test_blf1148_owner_dept.py`
- Modify: `tests/test_project_receivables.py`
- Modify: `tests/test_mvp.py`
- Modify: `tests/test_stage4a_closure.py`
- Test: `tests/test_fixture_performance.py`

**Interfaces:**
- Consumes: `bcrypt.hashpw`, `bcrypt.gensalt`, and production `api.core.security.verify_password`
- Produces: `tests.support.hash_test_password(password: str) -> str`, a cached bcrypt hash using test-only cost 4

- [x] **Step 1: Write failing compatibility, cost, and cache tests**

```python
from tests import support


def test_test_password_hash_is_compatible_with_production_verifier():
    from api.core.security import verify_password

    hashed = support._hash_test_password("fixture-performance-probe")

    assert verify_password("fixture-performance-probe", hashed)


def test_test_password_hash_uses_fast_test_cost():
    hashed = support._hash_test_password("fixture-performance-cost")

    assert hashed.split("$")[2] == "04"


def test_test_password_hash_reuses_result_per_password(monkeypatch):
    calls = []
    password = "fixture-performance-probe"

    def fake_hash(raw: str) -> str:
        calls.append(raw)
        return f"hashed:{raw}"

    monkeypatch.setattr(support, "_hash_test_password", fake_hash)
    first = support.hash_test_password(password)
    second = support.hash_test_password(password)

    assert first == second == f"hashed:{password}"
    assert calls == [password]
```

- [x] **Step 2: Run the tests to verify they fail**

Run:

```bash
env TEST_DATABASE_URL="$TEST_DATABASE_URL" APP_ENV=test \
  pytest tests/test_fixture_performance.py -q
```

Expected: collection fails because `tests.support` does not exist.

- [x] **Step 3: Add the shared test-only helper**

```python
"""Shared test-only helpers."""
from functools import lru_cache

import bcrypt


def _hash_test_password(password: str) -> str:
    # Test fixtures do not need production KDF hardness; login still verifies by bcrypt.
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=4)).decode()


@lru_cache(maxsize=None)
def hash_test_password(password: str) -> str:
    return _hash_test_password(password)
```

- [x] **Step 4: Use the helper for fixture-created users**

Replace direct `api.core.security.hash_password` calls in test helpers with `tests.support.hash_test_password`. Keep API-created users on the production hashing path.

- [x] **Step 5: Run the business sample**

Run:

```bash
env TEST_DATABASE_URL="$TEST_DATABASE_URL" APP_ENV=test pytest \
  tests/test_fixture_performance.py \
  tests/test_project_change_autosave.py \
  tests/test_project_changes_ledger.py \
  tests/test_blf1150_client_fields.py \
  tests/test_blf1148_owner_dept.py \
  tests/test_project_receivables.py \
  tests/test_mvp.py \
  -q
```

Result: 90 tests passed in 29.86 seconds. The original six-file sample then passed 87 tests in 29.53 seconds.

- [x] **Step 6: Run the directly affected stage-4A suite**

Run:

```bash
env TEST_DATABASE_URL="$TEST_DATABASE_URL" APP_ENV=test pytest \
  tests/test_stage4a_closure.py tests/test_fixture_performance.py -q
```

Result: 27 tests passed in 7.55 seconds.

Final same-sample comparison: 87 tests passed in 29.53 seconds, down from 199.87 seconds (about 85.2% faster).
