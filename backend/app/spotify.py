import base64
import secrets
from urllib.parse import urlencode

import httpx

from .config import settings

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"
SCOPES = "user-top-read"


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
    creds = f"{settings.spotify_client_id}:{settings.spotify_client_secret}"
    auth = base64.b64encode(creds.encode()).decode()
    async with httpx.AsyncClient() as client:
        r = await client.post(
            TOKEN_URL,
            headers={"Authorization": f"Basic {auth}"},
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": settings.spotify_redirect_uri,
            },
        )
        r.raise_for_status()
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
        r.raise_for_status()
        return r.json()["items"]
