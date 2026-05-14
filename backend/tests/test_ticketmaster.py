import httpx
import pytest

from app import ticketmaster


def _mock_client(handler):
    transport = httpx.MockTransport(handler)
    return httpx.AsyncClient(transport=transport)


async def test_request_with_retry_succeeds_after_429(monkeypatch):
    """A 429 followed by 200 should resolve to the 200 response."""
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={})
        return httpx.Response(200, json={"ok": True})

    # Speed up backoff.
    monkeypatch.setattr(ticketmaster, "RETRY_BASE_DELAY", 0.0)
    async with _mock_client(handler) as client:
        r = await ticketmaster._request_with_retry(
            client, "https://example/x.json", {}
        )
    assert r.status_code == 200
    assert calls["n"] == 2


async def test_request_with_retry_gives_up_after_attempts(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={})

    monkeypatch.setattr(ticketmaster, "RETRY_BASE_DELAY", 0.0)
    async with _mock_client(handler) as client:
        with pytest.raises(httpx.HTTPStatusError):
            await ticketmaster._request_with_retry(
                client, "https://example/x.json", {}
            )


async def test_find_events_passes_city_param():
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        return httpx.Response(200, json={"_embedded": {"events": []}})

    async with _mock_client(handler) as client:
        await ticketmaster.find_events(
            client, "A1", city="Brooklyn", radius=25
        )
    assert "city=Brooklyn" in captured["url"]
    assert "radius=25" in captured["url"]
    assert "classificationName=music" in captured["url"]


async def test_find_events_passes_postal_code_param():
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        return httpx.Response(200, json={"_embedded": {"events": []}})

    async with _mock_client(handler) as client:
        await ticketmaster.find_events(client, "A1", postal_code="11201")
    assert "postalCode=11201" in captured["url"]


async def test_find_events_prefers_latlong_over_city():
    """When both are set the lat/long should win (caller's responsibility,
    but the function itself encodes this priority)."""
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        return httpx.Response(200, json={"_embedded": {"events": []}})

    async with _mock_client(handler) as client:
        await ticketmaster.find_events(
            client, "A1", latlong="40.7,-74.0", city="Brooklyn"
        )
    assert "latlong=" in captured["url"]
    assert "city=" not in captured["url"]


async def test_find_concerts_calls_progress_cb(monkeypatch):
    """Progress callback should fire once per artist with completed counts
    counting up to the total."""

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if "attractions" in path:
            return httpx.Response(
                200, json={"_embedded": {"attractions": [{"id": "X1"}]}}
            )
        return httpx.Response(200, json={"_embedded": {"events": []}})

    # Patch the module-level helper to use our mock transport everywhere.
    import httpx as _httpx

    real_async_client = _httpx.AsyncClient

    def mock_factory(*args, **kwargs):
        return real_async_client(transport=_httpx.MockTransport(handler))

    monkeypatch.setattr(_httpx, "AsyncClient", mock_factory)

    progress_events: list[tuple[int, int]] = []

    def progress_cb(done: int, tot: int) -> None:
        progress_events.append((done, tot))

    artists = ["Alpha", "Beta", "Gamma"]
    results = await ticketmaster.find_concerts_for_artists(
        artists, progress_cb=progress_cb
    )

    assert results == []  # no events in mock
    assert len(progress_events) == len(artists)
    # Final completed value should equal total.
    assert progress_events[-1] == (len(artists), len(artists))
    # Each entry's "total" stays the same.
    assert all(tot == len(artists) for _, tot in progress_events)


async def test_find_concerts_handles_no_attraction(monkeypatch):
    """An artist with no Ticketmaster attraction should still count toward
    progress and not crash the search."""

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"_embedded": {"attractions": []}})

    import httpx as _httpx

    real_async_client = _httpx.AsyncClient
    monkeypatch.setattr(
        _httpx,
        "AsyncClient",
        lambda *a, **k: real_async_client(transport=_httpx.MockTransport(handler)),
    )
    progress_events: list[tuple[int, int]] = []
    results = await ticketmaster.find_concerts_for_artists(
        ["NoMatch"], progress_cb=lambda d, t: progress_events.append((d, t))
    )
    assert results == []
    assert progress_events == [(1, 1)]
