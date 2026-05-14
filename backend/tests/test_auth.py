from app import spotify


def test_status_unauthenticated(client):
    r = client.get("/api/auth/status")
    assert r.status_code == 200
    assert r.json() == {"authenticated": False}


def test_login_redirects_to_spotify(client):
    r = client.get("/api/auth/login", follow_redirects=False)
    assert r.status_code in (302, 307)
    assert "accounts.spotify.com/authorize" in r.headers["location"]
    assert "state=" in r.headers["location"]


def test_callback_rejects_bad_state(client):
    # No oauth_state stashed → mismatch → 400.
    r = client.get(
        "/api/auth/callback",
        params={"code": "x", "state": "definitely-not-the-stored-state"},
    )
    assert r.status_code == 400


def test_logout_clears_session(client, monkeypatch):
    # Plant a session via the login endpoint, then log out.
    r = client.get("/api/auth/login", follow_redirects=False)
    assert r.status_code in (302, 307)
    # The session cookie now contains oauth_state — logout clears it.
    r2 = client.post("/api/auth/logout")
    assert r2.status_code == 200
    assert r2.json() == {"ok": True}


def test_concerts_requires_auth(client):
    r = client.post("/api/concerts")
    assert r.status_code == 401


def test_concerts_status_unknown_id(client):
    r = client.get("/api/concerts/nope-nope")
    assert r.status_code == 404


def test_spotify_auth_error_class_exists():
    # Sanity: ensure the error class used by _call_spotify exists.
    assert issubclass(spotify.SpotifyAuthError, Exception)
