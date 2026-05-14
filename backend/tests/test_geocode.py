import httpx
import pytest

from app import geocode


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch):
    geocode.reset_cache_for_tests()
    # Disable the 1 req/sec sleep so tests don't drag.
    monkeypatch.setattr(geocode, "RATE_LIMIT_DELAY", 0.0)
    yield


def _install_mock(monkeypatch, handler):
    """Make geocode.geocode use a mock transport for its httpx client."""
    import httpx as _httpx

    real_async_client = _httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.setdefault("transport", _httpx.MockTransport(handler))
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(_httpx, "AsyncClient", factory)


async def test_geocode_returns_lat_lng(monkeypatch):
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            200,
            json=[{"lat": "38.6270", "lon": "-90.1994", "display_name": "St. Louis"}],
        )

    _install_mock(monkeypatch, handler)
    coords = await geocode.geocode("St. Louis, MO")
    assert coords == pytest.approx((38.6270, -90.1994))
    assert calls["n"] == 1


async def test_geocode_caches_results(monkeypatch):
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=[{"lat": "1.0", "lon": "2.0"}])

    _install_mock(monkeypatch, handler)
    a = await geocode.geocode("Brooklyn, NY")
    b = await geocode.geocode("brooklyn,  ny")  # different casing/whitespace
    assert a == b == (1.0, 2.0)
    # Cache-key normalization should have collapsed these to one network call.
    assert calls["n"] == 1


async def test_geocode_no_match(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[])

    _install_mock(monkeypatch, handler)
    result = await geocode.geocode("Wakanda Forever City")
    assert result is None


async def test_geocode_transport_error_raises(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    _install_mock(monkeypatch, handler)
    with pytest.raises(geocode.GeocodeError):
        await geocode.geocode("Anywhere")


async def test_geocode_empty_input():
    assert await geocode.geocode("   ") is None
