from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from starlette.middleware.sessions import SessionMiddleware

from . import spotify, ticketmaster
from .config import settings

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


@app.get("/api/auth/login")
async def login(request: Request):
    url, state = spotify.build_authorize_url()
    request.session["oauth_state"] = state
    return RedirectResponse(url)


@app.get("/api/auth/callback")
async def callback(request: Request, code: str, state: str):
    if state != request.session.get("oauth_state"):
        raise HTTPException(400, "invalid state")
    tokens = await spotify.exchange_code(code)
    request.session["access_token"] = tokens["access_token"]
    return RedirectResponse(settings.frontend_url)


@app.get("/api/auth/status")
async def status(request: Request):
    return {"authenticated": "access_token" in request.session}


@app.post("/api/auth/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/top-artists")
async def top_artists(
    request: Request, time_range: str = "long_term", limit: int = 20
):
    token = request.session.get("access_token")
    if not token:
        raise HTTPException(401, "not authenticated")
    artists = await spotify.get_top_artists(token, time_range, limit)
    return [
        {
            "name": a["name"],
            "image": (a["images"][0]["url"] if a.get("images") else None),
            "genres": a.get("genres", []),
        }
        for a in artists
    ]


@app.get("/api/concerts")
async def concerts(
    request: Request,
    latlong: str | None = None,
    radius: int = 50,
    limit: int = 10,
    time_range: str = "long_term",
):
    token = request.session.get("access_token")
    if not token:
        raise HTTPException(401, "not authenticated")
    artists = await spotify.get_top_artists(token, time_range=time_range, limit=limit)
    names = [a["name"] for a in artists]
    return await ticketmaster.find_concerts_for_artists(names, latlong, radius)
