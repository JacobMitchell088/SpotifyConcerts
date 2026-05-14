"""Lightweight geocoding via OpenStreetMap Nominatim.

Why this exists: Ticketmaster's `city` query parameter is an exact-substring
match on the event's `city` field (with `radius` largely ignored), so a value
like "St. Louis, MO" matches zero events. By geocoding user input to lat/lng
we can always use the latlong+radius path, which is what actually does a
spatial search.

Nominatim usage policy:
  - 1 req/sec ceiling, no heavy bulk usage
  - A descriptive User-Agent identifying the app is required

This module respects both with a coarse in-process rate limiter and an LRU
cache so the same city/ZIP is only hit once.
"""
import asyncio
import logging
import time
from collections import OrderedDict

import httpx

log = logging.getLogger("spotify-concerts.geocode")

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "spotify-concerts/1.0 (https://github.com/JacobMitchell088/SpotifyConcerts)"
CACHE_SIZE = 256
RATE_LIMIT_DELAY = 1.05  # seconds between calls, per Nominatim TOS


class GeocodeError(Exception):
    pass


class _Cache:
    def __init__(self, max_size: int):
        self._data: OrderedDict[str, tuple[float, float] | None] = OrderedDict()
        self._max = max_size

    def get(self, key: str):
        if key in self._data:
            self._data.move_to_end(key)
            return self._data[key]
        return ...  # sentinel for "miss"

    def put(self, key: str, value: tuple[float, float] | None) -> None:
        self._data[key] = value
        self._data.move_to_end(key)
        while len(self._data) > self._max:
            self._data.popitem(last=False)


_cache = _Cache(CACHE_SIZE)
_last_call_ts = 0.0
_call_lock = asyncio.Lock()


def _normalize(s: str) -> str:
    return " ".join(s.lower().split())


async def geocode(query: str) -> tuple[float, float] | None:
    """Return (lat, lng) for `query`, or None if Nominatim has no match.

    Cached. Rate-limited to ~1 req/sec across the whole process.
    """
    q = query.strip()
    if not q:
        return None
    key = _normalize(q)
    cached = _cache.get(key)
    if cached is not ...:
        return cached

    global _last_call_ts
    async with _call_lock:
        # Sleep just enough to honor 1 req/sec since the last call.
        delta = time.monotonic() - _last_call_ts
        if delta < RATE_LIMIT_DELAY:
            await asyncio.sleep(RATE_LIMIT_DELAY - delta)
        try:
            async with httpx.AsyncClient(
                timeout=8.0, headers={"User-Agent": USER_AGENT}
            ) as client:
                r = await client.get(
                    NOMINATIM_URL,
                    params={"q": q, "format": "json", "limit": 1},
                )
                _last_call_ts = time.monotonic()
                r.raise_for_status()
                hits = r.json()
        except httpx.HTTPError as e:
            log.warning("geocode: '%s' → transport error: %s", q, e)
            # Don't poison the cache on transient errors.
            raise GeocodeError(str(e)) from e

    if not hits:
        log.info("geocode: '%s' → no match", q)
        _cache.put(key, None)
        return None
    try:
        lat = float(hits[0]["lat"])
        lng = float(hits[0]["lon"])
    except (KeyError, TypeError, ValueError):
        log.warning("geocode: '%s' → unexpected response %s", q, hits[0])
        _cache.put(key, None)
        return None
    coords = (lat, lng)
    log.info("geocode: '%s' → %.4f,%.4f", q, lat, lng)
    _cache.put(key, coords)
    return coords


def reset_cache_for_tests() -> None:
    """Hook for tests — clears cache and rate-limit state."""
    global _last_call_ts
    _cache._data.clear()
    _last_call_ts = 0.0
