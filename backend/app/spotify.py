import base64
import secrets
from urllib.parse import urlencode

import httpx

from .config import settings

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"
SCOPES = "user-top-read"


class SpotifyAuthError(Exception):
    pass


def _basic_auth_header() -> str:
    creds = f"{settings.spotify_client_id}:{settings.spotify_client_secret}"
    return "Basic " + base64.b64encode(creds.encode()).decode()


def build_authorize_url() -> tuple[str, str]:
    state = secrets.token_urlsafe(16)
    params = {
        "response_type": "code",
        "client_id": settings.spotify_client_id,
        "scope": SCOPES,
        "redirect_uri": settings.spotify_redirect_uri,
        "state": state,
    }
    return f"{AUTH_URL}?{urlencode(params)}", state


async def exchange_code(code: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(
            TOKEN_URL,
            headers={"Authorization": _basic_auth_header()},
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": settings.spotify_redirect_uri,
            },
        )
        r.raise_for_status()
        return r.json()


async def refresh_access_token(refresh_token: str) -> dict:
    async with httpx.AsyncClient() as client:
        r = await client.post(
            TOKEN_URL,
            headers={"Authorization": _basic_auth_header()},
            data={"grant_type": "refresh_token", "refresh_token": refresh_token},
        )
        if r.status_code != 200:
            raise SpotifyAuthError(f"refresh failed: {r.status_code} {r.text}")
        return r.json()


async def get_top_artists(
    access_token: str, time_range: str = "long_term", limit: int = 20
) -> list[dict]:
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{API_BASE}/me/top/artists",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"time_range": time_range, "limit": limit},
        )
        if r.status_code == 401:
            raise SpotifyAuthError("access token rejected")
        r.raise_for_status()
        return r.json()["items"]


async def search_artist(access_token: str, query: str) -> dict | None:
    """Return the top-matching artist for `query`, or None if Spotify has no match."""
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{API_BASE}/search",
            headers={"Authorization": f"Bearer {access_token}"},
            params={"q": query, "type": "artist", "limit": 1},
        )
        if r.status_code == 401:
            raise SpotifyAuthError("access token rejected")
        r.raise_for_status()
        items = r.json().get("artists", {}).get("items", [])
        if not items:
            return None
        a = items[0]
        return {
            "name": a["name"],
            "image": a["images"][0]["url"] if a.get("images") else None,
        }
