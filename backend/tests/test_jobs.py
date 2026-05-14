import time

import pytest

from app import jobs


async def test_create_then_get():
    store = jobs.JobStore()
    job = await store.create(total=3)
    assert job.status == "pending"
    assert job.total == 3
    fetched = await store.get(job.id)
    assert fetched is job


async def test_progress_transitions_to_running():
    store = jobs.JobStore()
    job = await store.create(total=4)
    await store.update_progress(job.id, 1, 4)
    fetched = await store.get(job.id)
    assert fetched.status == "running"
    assert fetched.completed == 1


async def test_mark_done_populates_results_and_eta_zero():
    store = jobs.JobStore()
    job = await store.create(total=2)
    await store.update_progress(job.id, 1, 2)
    await store.mark_done(job.id, [{"artist": "A"}, {"artist": "B"}])
    fetched = await store.get(job.id)
    d = fetched.to_dict()
    assert d["status"] == "done"
    assert d["completed"] == 2
    assert d["eta_seconds"] == 0
    assert len(d["results"]) == 2


async def test_running_eta_is_estimated_from_elapsed():
    store = jobs.JobStore()
    job = await store.create(total=10)
    # backdate the start so we have measurable elapsed time
    job.started_at = time.time() - 2.0
    await store.update_progress(job.id, 5, 10)
    d = (await store.get(job.id)).to_dict()
    # 2 seconds for half the work → ~2 seconds left
    assert d["eta_seconds"] is not None
    assert 1.0 <= d["eta_seconds"] <= 5.0


async def test_mark_error_records_message():
    store = jobs.JobStore()
    job = await store.create(total=1)
    await store.mark_error(job.id, "boom")
    d = (await store.get(job.id)).to_dict()
    assert d["status"] == "error"
    assert d["error"] == "boom"
    assert d["results"] == []  # results suppressed unless status == done


async def test_purge_removes_stale_jobs(monkeypatch):
    store = jobs.JobStore()
    # Shrink TTL so we don't have to wait.
    monkeypatch.setattr(jobs, "JOB_TTL_SECONDS", 0)
    job = await store.create(total=1)
    await store.mark_done(job.id, [])
    # Force finished_at into the past so the purge sees it as stale.
    (await store.get(job.id)).finished_at = time.time() - 10
    # Creating a new job triggers purge.
    await store.create(total=1)
    assert await store.get(job.id) is None


async def test_get_missing_returns_none():
    store = jobs.JobStore()
    assert await store.get("does-not-exist") is None
