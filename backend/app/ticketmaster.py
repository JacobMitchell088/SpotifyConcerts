import asyncio
import logging
import random
from typing import Awaitable, Callable

import httpx

from .config import settings

log = logging.getLogger("spotify-concerts.ticketmaster")

API_BASE = "https://app.ticketmaster.com/discovery/v2"

# Free tier is 5 req/s. We fan out with a semaphore and keep enough headroom
# that retries on 429 don't push us over.
CONCURRENCY = 4
RETRY_ATTEMPTS = 3
RETRY_BASE_DELAY = 0.5  # seconds, exponential backoff with jitter


ProgressCallback = Callable[[int, int], None] | None


async def _request_with_retry(
    client: httpx.AsyncClient, url: str, params: dict
) -> httpx.Response:
    """GET with exponential-backoff retry on 429 and 5xx."""
    last_exc: Exception | None = None
    for attempt in range(RETRY_ATTEMPTS):
        try:
            r = await client.get(url, params=params)
            if r.status_code == 429 or 500 <= r.status_code < 600:
                # Respect Retry-After when present; otherwise backoff with jitter.
                retry_after = r.headers.get("Retry-After")
                if retry_after and retry_after.isdigit():
                    delay = float(retry_after)
                else:
                    delay = RETRY_BASE_DELAY * (2**attempt) + random.uniform(0, 0.25)
                if attempt < RETRY_ATTEMPTS - 1:
                    log.info(
                        "ticketmaster: %d on %s, retrying in %.2fs",
                        r.status_code,
                        url.split("/")[-1],
                        delay,
                    )
                    await asyncio.sleep(delay)
                    continue
            r.raise_for_status()
            return r
        except httpx.HTTPError as e:
            last_exc = e
            if attempt < RETRY_ATTEMPTS - 1:
                delay = RETRY_BASE_DELAY * (2**attempt) + random.uniform(0, 0.25)
                log.info(
                    "ticketmaster: transport error on attempt %d, retry in %.2fs: %s",
                    attempt + 1,
                    delay,
                    e,
                )
                await asyncio.sleep(delay)
                continue
            raise
    # Shouldn't reach here, but keep type checker happy.
    if last_exc:
        raise last_exc
    raise RuntimeError("retry loop exited without response")


async def find_attraction_id(
    client: httpx.AsyncClient, artist_name: str
) -> str | None:
    r = await _request_with_retry(
        client,
        f"{API_BASE}/attractions.json",
        {
            "keyword": artist_name,
            "apikey": settings.ticketmaster_api_key,
            "size": 1,
        },
    )
    attractions = r.json().get("_embedded", {}).get("attractions", [])
    return attractions[0]["id"] if attractions else None


async def find_events(
    client: httpx.AsyncClient,
    attraction_id: str,
    *,
    latlong: str | None = None,
    radius: int = 50,
) -> list[dict]:
    params: dict = {
        "attractionId": attraction_id,
        "apikey": settings.ticketmaster_api_key,
        "size": 10,
        "sort": "date,asc",
    }
    if latlong:
        params["latlong"] = latlong
        params["radius"] = radius
        params["unit"] = "miles"
    r = await _request_with_retry(client, f"{API_BASE}/events.json", params)
    return r.json().get("_embedded", {}).get("events", [])


async def find_concerts_for_artists(
    artist_names: list[str],
    *,
    latlong: str | None = None,
    radius: int = 50,
    progress_cb: ProgressCallback = None,
) -> list[dict]:
    results: list[dict] = []
    total = len(artist_names)
    completed = 0
    matched = 0
    attractions_found = 0
    lock = asyncio.Lock()
    semaphore = asyncio.Semaphore(CONCURRENCY)

    location_note = (
        f"latlong={latlong} radius={radius}" if latlong else "no location"
    )
    log.info("ticketmaster: searching %d artists (%s)", total, location_note)

    async def process(name: str, client: httpx.AsyncClient) -> None:
        nonlocal completed, matched, attractions_found
        try:
            async with semaphore:
                attraction_id = await find_attraction_id(client, name)
                if not attraction_id:
                    log.info("ticketmaster: '%s' → no attraction match", name)
                else:
                    events = await find_events(
                        client, attraction_id, latlong=latlong, radius=radius
                    )
                    async with lock:
                        attractions_found += 1
                        if events:
                            matched += 1
                            log.info(
                                "ticketmaster: '%s' → %d events", name, len(events)
                            )
                        else:
                            log.info(
                                "ticketmaster: '%s' → attraction found, 0 events",
                                name,
                            )
                        for ev in events:
                            venue = (ev.get("_embedded", {}).get("venues") or [{}])[0]
                            results.append(
                                {
                                    "artist": name,
                                    "name": ev.get("name"),
                                    "date": ev.get("dates", {})
                                    .get("start", {})
                                    .get("localDate"),
                                    "venue": venue.get("name"),
                                    "city": (venue.get("city") or {}).get("name"),
                                    "url": ev.get("url"),
                                }
                            )
        except httpx.HTTPStatusError as e:
            log.warning(
                "ticketmaster: '%s' → HTTP %d (giving up): %s",
                name,
                e.response.status_code,
                e.response.text[:200],
            )
        except httpx.HTTPError as e:
            log.warning("ticketmaster: '%s' → transport error: %s", name, e)
        finally:
            async with lock:
                completed += 1
                if progress_cb:
                    try:
                        progress_cb(completed, total)
                    except Exception:
                        log.exception("ticketmaster: progress callback failed")

    async with httpx.AsyncClient(timeout=15.0) as client:
        await asyncio.gather(*(process(n, client) for n in artist_names))

    log.info(
        "ticketmaster: done — %d/%d attractions matched, %d artists with shows, %d total events",
        attractions_found,
        total,
        matched,
        len(results),
    )
    return results
