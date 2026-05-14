"""End-to-end-ish tests of the concert-search job flow using a TestClient
plus a forged session cookie and stubbed Spotify/Ticketmaster modules."""
import time

import httpx
import pytest

from app import main


async def _fake_top_artists(token, time_range="long_term", limit=20):
    return [
        {"name": "Alpha", "images": [{"url": "http://img/a"}], "genres": []},
        {"name": "Beta", "images": [], "genres": []},
    ][:limit]


async def _fake_find_concerts(artist_names, *, progress_cb=None, **kw):
    total = len(artist_names)
    for i, _name in enumerate(artist_names, start=1):
        if progress_cb:
            progress_cb(i, total)
    return [
        {
            "artist": artist_names[0],
            "name": "Some Show",
            "date": "2026-08-01",
            "venue": "The Venue",
            "city": "Brooklyn",
            "url": "https://tm.example/show",
        }
    ]


def _auth(client):
    """Plant an access_token in the session by directly using a request
    that sets it through the test client's session-middleware-backed cookie."""
    # Easiest path: hit a tiny test-only helper via dependency? Too invasive.
    # Instead, monkeypatch _call_spotify to bypass the token check.
    pass


def test_concerts_job_lifecycle(client, monkeypatch):
    # Skip Spotify and Ticketmaster entirely.
    async def fake_call_spotify(request, fn):
        return await _fake_top_artists("fake")

    monkeypatch.setattr(main, "_call_spotify", fake_call_spotify)
    monkeypatch.setattr(
        main.ticketmaster, "find_concerts_for_artists", _fake_find_concerts
    )

    # Start the job.
    r = client.post("/api/concerts?limit=2")
    assert r.status_code == 200
    body = r.json()
    assert "job_id" in body
    assert body["total"] == 2
    job_id = body["job_id"]

    # Poll until done — should be quick because the fake runs inline.
    deadline = time.time() + 5
    final = None
    while time.time() < deadline:
        r2 = client.get(f"/api/concerts/{job_id}")
        assert r2.status_code == 200
        d = r2.json()
        if d["status"] == "done":
            final = d
            break
        time.sleep(0.05)
    assert final is not None, "job never reached done"
    assert final["completed"] == 2
    assert final["total"] == 2
    assert len(final["results"]) == 1
    assert final["results"][0]["artist"] == "Alpha"


def test_concerts_job_records_error(client, monkeypatch):
    async def fake_call_spotify(request, fn):
        return await _fake_top_artists("fake")

    async def boom(*args, **kwargs):
        raise RuntimeError("ticketmaster exploded")

    monkeypatch.setattr(main, "_call_spotify", fake_call_spotify)
    monkeypatch.setattr(main.ticketmaster, "find_concerts_for_artists", boom)

    r = client.post("/api/concerts?limit=2")
    assert r.status_code == 200
    job_id = r.json()["job_id"]

    deadline = time.time() + 5
    final = None
    while time.time() < deadline:
        d = client.get(f"/api/concerts/{job_id}").json()
        if d["status"] == "error":
            final = d
            break
        time.sleep(0.05)
    assert final is not None
    assert "ticketmaster exploded" in final["error"]


def test_concerts_merges_extra_artists(client, monkeypatch):
    captured = {}

    async def fake_call_spotify(request, fn):
        return await _fake_top_artists("fake")

    async def capture(artist_names, *, progress_cb=None, **kw):
        captured["names"] = list(artist_names)
        if progress_cb:
            progress_cb(len(artist_names), len(artist_names))
        return []

    monkeypatch.setattr(main, "_call_spotify", fake_call_spotify)
    monkeypatch.setattr(main.ticketmaster, "find_concerts_for_artists", capture)

    r = client.post(
        "/api/concerts?limit=2&extra_artists=Gamma&extra_artists=alpha"
    )
    assert r.status_code == 200
    # Wait briefly for the background task to run.
    job_id = r.json()["job_id"]
    deadline = time.time() + 5
    while time.time() < deadline:
        if client.get(f"/api/concerts/{job_id}").json()["status"] == "done":
            break
        time.sleep(0.05)

    # "alpha" is a duplicate of "Alpha" (case-insensitive) and should be dropped.
    assert "names" in captured
    assert captured["names"] == ["Alpha", "Beta", "Gamma"]


def test_concerts_passes_location_params(client, monkeypatch):
    captured = {}

    async def fake_call_spotify(request, fn):
        return await _fake_top_artists("fake")

    async def capture(artist_names, *, progress_cb=None, **kw):
        captured.update(kw)
        if progress_cb:
            progress_cb(len(artist_names), len(artist_names))
        return []

    monkeypatch.setattr(main, "_call_spotify", fake_call_spotify)
    monkeypatch.setattr(main.ticketmaster, "find_concerts_for_artists", capture)

    r = client.post("/api/concerts?limit=2&city=Brooklyn&radius=25")
    assert r.status_code == 200
    job_id = r.json()["job_id"]
    deadline = time.time() + 5
    while time.time() < deadline:
        if client.get(f"/api/concerts/{job_id}").json()["status"] == "done":
            break
        time.sleep(0.05)
    assert captured.get("city") == "Brooklyn"
    assert captured.get("radius") == 25
    assert captured.get("latlong") is None
    assert captured.get("postal_code") is None
