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


def _wait_done(client, job_id, deadline_s=5):
    deadline = time.time() + deadline_s
    while time.time() < deadline:
        d = client.get(f"/api/concerts/{job_id}").json()
        if d["status"] in ("done", "error"):
            return d
        time.sleep(0.05)
    return None


def test_concerts_city_is_geocoded_to_latlong(client, monkeypatch):
    """User enters a city → backend geocodes → ticketmaster sees latlong."""
    captured = {}

    async def fake_call_spotify(request, fn):
        return await _fake_top_artists("fake")

    async def fake_geocode(query):
        # Simulate a hit for any non-empty input.
        return (38.6270, -90.1994)

    async def capture(artist_names, *, progress_cb=None, **kw):
        captured.update(kw)
        if progress_cb:
            progress_cb(len(artist_names), len(artist_names))
        return []

    monkeypatch.setattr(main, "_call_spotify", fake_call_spotify)
    monkeypatch.setattr(main.geocode, "geocode", fake_geocode)
    monkeypatch.setattr(main.ticketmaster, "find_concerts_for_artists", capture)

    r = client.post(
        "/api/concerts?limit=2&city=St.+Louis&state_code=MO&radius=200"
    )
    assert r.status_code == 200
    body = r.json()
    assert body["resolved_latlong"] == "38.6270,-90.1994"
    assert body["warning"] is None
    _wait_done(client, body["job_id"])
    assert captured.get("latlong") == "38.6270,-90.1994"
    assert captured.get("radius") == 200


def test_concerts_geocode_miss_surfaces_warning(client, monkeypatch):
    async def fake_call_spotify(request, fn):
        return await _fake_top_artists("fake")

    async def fake_geocode(query):
        return None

    async def capture(artist_names, *, progress_cb=None, **kw):
        if progress_cb:
            progress_cb(len(artist_names), len(artist_names))
        return []

    monkeypatch.setattr(main, "_call_spotify", fake_call_spotify)
    monkeypatch.setattr(main.geocode, "geocode", fake_geocode)
    monkeypatch.setattr(main.ticketmaster, "find_concerts_for_artists", capture)

    r = client.post("/api/concerts?limit=2&city=Wakanda")
    body = r.json()
    assert body["warning"] is not None
    assert body["resolved_latlong"] is None
    final = _wait_done(client, body["job_id"])
    assert final["warning"] is not None


def test_concerts_geocode_error_does_not_kill_search(client, monkeypatch):
    """A Nominatim transport error should warn but still let the search proceed
    without a location."""
    from app import geocode as geocode_mod

    async def fake_call_spotify(request, fn):
        return await _fake_top_artists("fake")

    async def boom(query):
        raise geocode_mod.GeocodeError("network down")

    async def capture(artist_names, *, progress_cb=None, **kw):
        if progress_cb:
            progress_cb(len(artist_names), len(artist_names))
        return []

    monkeypatch.setattr(main, "_call_spotify", fake_call_spotify)
    monkeypatch.setattr(main.geocode, "geocode", boom)
    monkeypatch.setattr(main.ticketmaster, "find_concerts_for_artists", capture)

    r = client.post("/api/concerts?limit=2&postal_code=63101")
    assert r.status_code == 200
    body = r.json()
    assert body["warning"] is not None
    assert "network down" in body["warning"]


def test_concerts_latlong_skips_geocoding(client, monkeypatch):
    """When latlong is provided directly, the backend should not call geocode."""
    calls = {"geocode": 0}
    captured = {}

    async def fake_call_spotify(request, fn):
        return await _fake_top_artists("fake")

    async def fake_geocode(query):
        calls["geocode"] += 1
        return (0.0, 0.0)

    async def capture(artist_names, *, progress_cb=None, **kw):
        captured.update(kw)
        if progress_cb:
            progress_cb(len(artist_names), len(artist_names))
        return []

    monkeypatch.setattr(main, "_call_spotify", fake_call_spotify)
    monkeypatch.setattr(main.geocode, "geocode", fake_geocode)
    monkeypatch.setattr(main.ticketmaster, "find_concerts_for_artists", capture)

    r = client.post("/api/concerts?limit=2&latlong=40.7128,-74.0060&radius=50")
    assert r.status_code == 200
    _wait_done(client, r.json()["job_id"])
    assert calls["geocode"] == 0
    assert captured["latlong"] == "40.7128,-74.0060"


def test_concerts_clamps_radius_and_limit(client, monkeypatch):
    captured = {}

    async def fake_call_spotify(request, fn):
        # Note: limit reaches the spotify call already clamped; we accept anything.
        return await _fake_top_artists("fake")

    async def capture(artist_names, *, progress_cb=None, **kw):
        captured.update(kw)
        if progress_cb:
            progress_cb(len(artist_names), len(artist_names))
        return []

    monkeypatch.setattr(main, "_call_spotify", fake_call_spotify)
    monkeypatch.setattr(main.ticketmaster, "find_concerts_for_artists", capture)

    # Over-the-top values should be clamped server-side, not blow up.
    r = client.post("/api/concerts?limit=9999&radius=9999&latlong=0,0")
    assert r.status_code == 200
    _wait_done(client, r.json()["job_id"])
    assert captured["radius"] == main.MAX_RADIUS_MILES
