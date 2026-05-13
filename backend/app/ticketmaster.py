import asyncio
import logging

import httpx

from .config import settings

log = logging.getLogger("spotify-concerts.ticketmaster")

API_BASE = "https://app.ticketmaster.com/discovery/v2"

RATE_LIMIT_DELAY = 0.25


async def find_attraction_id(client: httpx.AsyncClient, artist_name: str) -> str | None:
    r = await client.get(
        f"{API_BASE}/attractions.json",
        params={
            "keyword": artist_name,
            "apikey": settings.ticketmaster_api_key,
            "size": 1,
        },
    )
    r.raise_for_status()
    attractions = r.json().get("_embedded", {}).get("attractions", [])
    return attractions[0]["id"] if attractions else None


async def find_events(
    client: httpx.AsyncClient,
    attraction_id: str,
    latlong: str | None,
    radius: int,
) -> list[dict]:
    params = {
        "attractionId": attraction_id,
        "apikey": settings.ticketmaster_api_key,
        "size": 10,
        "sort": "date,asc",
    }
    if latlong:
        params["latlong"] = latlong
        params["radius"] = radius
        params["unit"] = "miles"
    r = await client.get(f"{API_BASE}/events.json", params=params)
    r.raise_for_status()
    return r.json().get("_embedded", {}).get("events", [])


async def find_concerts_for_artists(
    artist_names: list[str], latlong: str | None = None, radius: int = 50
) -> list[dict]:
    results = []
    matched = 0
    attractions_found = 0
    location_note = f"latlong={latlong} radius={radius}" if latlong else "no location"
    log.info(
        "ticketmaster: searching %d artists (%s)",
        len(artist_names),
        location_note,
    )
    async with httpx.AsyncClient(timeout=10.0) as client:
        for name in artist_names:
            try:
                attraction_id = await find_attraction_id(client, name)
                await asyncio.sleep(RATE_LIMIT_DELAY)
                if not attraction_id:
                    log.info("ticketmaster: '%s' → no attraction match", name)
                    continue
                attractions_found += 1
                events = await find_events(client, attraction_id, latlong, radius)
                await asyncio.sleep(RATE_LIMIT_DELAY)
            except httpx.HTTPStatusError as e:
                status = e.response.status_code
                body = e.response.text[:200]
                log.warning(
                    "ticketmaster: '%s' → HTTP %d: %s", name, status, body
                )
                if status == 429:
                    await asyncio.sleep(1.0)
                continue
            except httpx.HTTPError as e:
                log.warning("ticketmaster: '%s' → transport error: %s", name, e)
                continue
            if events:
                matched += 1
                log.info("ticketmaster: '%s' → %d events", name, len(events))
            else:
                log.info("ticketmaster: '%s' → attraction found, 0 events", name)
            for ev in events:
                venue = (ev.get("_embedded", {}).get("venues") or [{}])[0]
                results.append(
                    {
                        "artist": name,
                        "name": ev.get("name"),
                        "date": ev.get("dates", {}).get("start", {}).get("localDate"),
                        "venue": venue.get("name"),
                        "city": (venue.get("city") or {}).get("name"),
                        "url": ev.get("url"),
                    }
                )
    log.info(
        "ticketmaster: done — %d/%d attractions matched, %d artists with shows, %d total events",
        attractions_found,
        len(artist_names),
        matched,
        len(results),
    )
    return results
