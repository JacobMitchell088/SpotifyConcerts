import asyncio
import logging

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from starlette.middleware.sessions import SessionMiddleware

from . import geocode, jobs, spotify, ticketmaster
from .config import settings

# Hard caps applied before forwarding to upstream APIs. Spotify caps `limit`
# at 50; Ticketmaster's radius is largely useless past ~500 mi.
MAX_RADIUS_MILES = 500
MIN_RADIUS_MILES = 1
MAX_ARTISTS = 50
MIN_ARTISTS = 1
MAX_EXTRA_ARTISTS = 25

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("spotify-concerts")

app = FastAPI(title="Spotify Concerts")

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.session_secret,
    same_site="lax",
    https_only=settings.cookie_secure,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {"service": "spotify-concerts-api", "status": "ok"}


@app.get("/api/auth/login")
async def login(request: Request):
    url, state = spotify.build_authorize_url()
    request.session["oauth_state"] = state
    return RedirectResponse(url)


@app.get("/api/auth/callback")
async def callback(request: Request, code: str, state: str):
    if state != request.session.get("oauth_state"):
        raise HTTPException(400, "invalid state")
    request.session.pop("oauth_state", None)
    tokens = await spotify.exchange_code(code)
    request.session["access_token"] = tokens["access_token"]
    if "refresh_token" in tokens:
        request.session["refresh_token"] = tokens["refresh_token"]
    return RedirectResponse(settings.frontend_url)


@app.get("/api/auth/status")
async def status(request: Request):
    return {"authenticated": "access_token" in request.session}


@app.post("/api/auth/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


async def _call_spotify(request: Request, fn):
    """Run an async Spotify call with the session's token,
    transparently refreshing once on 401."""
    token = request.session.get("access_token")
    if not token:
        raise HTTPException(401, "not authenticated")
    try:
        return await fn(token)
    except spotify.SpotifyAuthError:
        refresh = request.session.get("refresh_token")
        if not refresh:
            request.session.clear()
            raise HTTPException(401, "session expired, please log in again")
        try:
            new_tokens = await spotify.refresh_access_token(refresh)
        except spotify.SpotifyAuthError:
            request.session.clear()
            raise HTTPException(401, "session expired, please log in again")
        request.session["access_token"] = new_tokens["access_token"]
        if "refresh_token" in new_tokens:
            request.session["refresh_token"] = new_tokens["refresh_token"]
        return await fn(new_tokens["access_token"])


async def _fetch_top_artists(request: Request, time_range: str, limit: int):
    return await _call_spotify(
        request, lambda t: spotify.get_top_artists(t, time_range, limit)
    )


@app.get("/api/search-artist")
async def search_artist(request: Request, q: str):
    q = q.strip()
    if not q:
        return None
    return await _call_spotify(request, lambda t: spotify.search_artist(t, q))


@app.get("/api/top-artists")
async def top_artists(
    request: Request, time_range: str = "long_term", limit: int = 20
):
    artists = await _fetch_top_artists(request, time_range, limit)
    return [
        {
            "name": a["name"],
            "image": (a["images"][0]["url"] if a.get("images") else None),
            "genres": a.get("genres", []),
        }
        for a in artists
    ]


def _merge_extra_artists(top: list[dict], extras: list[str]) -> list[str]:
    names = [a["name"] for a in top]
    seen = {n.lower() for n in names}
    # Cap extras to avoid abuse via the public-facing knob.
    for extra in extras[:MAX_EXTRA_ARTISTS]:
        cleaned = extra.strip()
        if cleaned and cleaned.lower() not in seen:
            names.append(cleaned)
            seen.add(cleaned.lower())
    return names


def _clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, value))


async def _resolve_location(
    *,
    latlong: str | None,
    city: str | None,
    state_code: str | None,
    postal_code: str | None,
) -> tuple[str | None, str | None]:
    """Resolve user-supplied location fields to a `latlong` string.

    Returns (latlong, warning). `warning` is non-None when text was provided
    but couldn't be resolved — the caller surfaces it to the client.
    """
    if latlong:
        return latlong.strip(), None
    parts: list[str] = []
    if city:
        parts.append(city.strip())
    if state_code:
        parts.append(state_code.strip())
    if postal_code:
        parts.append(postal_code.strip())
    if not parts:
        return None, None
    query = ", ".join(p for p in parts if p)
    try:
        coords = await geocode.geocode(query)
    except geocode.GeocodeError as e:
        return None, f"could not geocode '{query}': {e}"
    if coords is None:
        return None, f"no geocoding match for '{query}'"
    return f"{coords[0]:.4f},{coords[1]:.4f}", None


@app.post("/api/concerts")
async def start_concerts_job(
    request: Request,
    latlong: str | None = None,
    radius: int = 50,
    city: str | None = None,
    state_code: str | None = None,
    postal_code: str | None = None,
    limit: int = 10,
    time_range: str = "long_term",
    extra_artists: list[str] = Query(default=[]),
):
    """Kick off an async concert search. Returns {job_id} immediately;
    poll /api/concerts/{job_id} for progress and final results.

    Location resolution: `latlong` is used as-is if provided. Otherwise
    `city` / `state_code` / `postal_code` are geocoded to a lat/lng so the
    radius search works (Ticketmaster's `city` filter is exact-match)."""
    limit = _clamp(limit, MIN_ARTISTS, MAX_ARTISTS)
    radius = _clamp(radius, MIN_RADIUS_MILES, MAX_RADIUS_MILES)

    resolved_latlong, geocode_warning = await _resolve_location(
        latlong=latlong, city=city, state_code=state_code, postal_code=postal_code,
    )

    artists = await _fetch_top_artists(request, time_range, limit)
    names = _merge_extra_artists(artists, extra_artists)
    log.info(
        "concerts: starting job for %d artists (time_range=%s, latlong=%s, radius=%d): %s",
        len(names),
        time_range,
        resolved_latlong,
        radius,
        names,
    )

    job = await jobs.store.create(total=len(names))
    if geocode_warning:
        await jobs.store.set_warning(job.id, geocode_warning)

    async def progress_cb_sync(done: int, tot: int) -> None:
        # Called from inside ticketmaster.find_concerts_for_artists.
        await jobs.store.update_progress(job.id, done, tot)

    def progress_cb(done: int, tot: int) -> None:
        # Schedule the async update on the running loop without blocking.
        asyncio.create_task(progress_cb_sync(done, tot))

    async def run() -> None:
        await jobs.store.mark_running(job.id)
        try:
            results = await ticketmaster.find_concerts_for_artists(
                names,
                latlong=resolved_latlong,
                radius=radius,
                progress_cb=progress_cb,
            )
            await jobs.store.mark_done(job.id, results)
        except Exception as e:
            log.exception("concerts: job %s failed", job.id)
            await jobs.store.mark_error(job.id, str(e))

    asyncio.create_task(run())
    return {
        "job_id": job.id,
        "total": len(names),
        "resolved_latlong": resolved_latlong,
        "warning": geocode_warning,
    }


@app.get("/api/concerts/{job_id}")
async def get_concerts_job(job_id: str):
    job = await jobs.store.get(job_id)
    if not job:
        raise HTTPException(404, "job not found or expired")
    return job.to_dict()
