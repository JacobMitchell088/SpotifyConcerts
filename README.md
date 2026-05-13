# Spotify Concerts
>Author: Jacob Mitchell   
>Date: 5/13/26   

Find upcoming concerts for the artists you actually listen to. Logs in with your Spotify account, pulls your top artists from the Spotify Web API, then looks up nearby shows for each one via the Ticketmaster Discovery API.   

- **Backend:** Python 3.10+ / FastAPI / httpx
- **Frontend:** React 18 + Vite (JSX)
- **Auth:** Spotify OAuth Authorization Code flow (server-side, session-based)
- **Designed for:** local development + Render deployment

---

## Features

- Spotify OAuth login (no password handling — Spotify owns the session).
- Pulls your top **5–25 artists** for a configurable listening window:
  - **Short term** — last ~4 weeks
  - **Medium term** — last ~6 months
  - **Long term** — last ~1 year
- Auto-fetches browser location and pre-fills lat/lng (with a "Use my location" button to refresh).
- Search radius adjustable 1–500 mi.
- Results grouped by artist with the artist name as a section header; each show is a card showing date, venue, city, and a "Tickets" link to Ticketmaster.
- Three-column card grid that collapses gracefully on smaller screens.
- Rate-limit-aware Ticketmaster calls (throttled to stay under the free-tier 5 req/sec cap, skips individual artist failures instead of crashing the request).

---

## Prerequisites

- Python 3.10 or higher (3.13 recommended — matches Render's supported runtimes).
- Node.js 18+ and npm.
- A free Spotify Developer account.
- A free Ticketmaster Developer account.
- Either `venv` or Conda for managing the Python environment.

---

## Setup

### 1. Clone

```bash
git clone https://github.com/<you>/SpotifyConcerts.git
cd SpotifyConcerts
```

### 2. Get API credentials

#### Spotify

1. Go to <https://developer.spotify.com/dashboard> and log in.
2. Click **Create app**.
3. Fill in:
   - **App name / description:** anything.
   - **Redirect URI:** `http://127.0.0.1:8000/api/auth/callback`
     *(Spotify no longer accepts `localhost` — must be `127.0.0.1` or HTTPS.)*
   - **Which API/SDKs:** check **Web API**.
4. Save. The app page shows your **Client ID**. Click **View client secret** for the secret.
5. Under **User Management**, add your own Spotify email — apps start in Development Mode and only listed users can log in.

#### Ticketmaster

1. Register at <https://developer-acct.ticketmaster.com/user/register>.
2. Verify your email, sign in.
3. Under **My Account → Apps**, create an app (or use the default).
4. Copy the **Consumer Key** — that's the API key.
5. The free tier allows **5,000 requests/day, 5/sec**.

### 3. Backend

```bash
cd backend
cp .env.example .env
```

Edit `.env` and fill in the five values:

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8000/api/auth/callback
TICKETMASTER_API_KEY=...
SESSION_SECRET=<long random string>
FRONTEND_URL=http://127.0.0.1:5173
```

Generate a session secret with:
```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Create and activate an environment, then install dependencies.

**Using `venv` (lighter, matches Render's build):**
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

**Using Conda (alternative):**
```bash
conda create -n spotify-concerts python=3.13 -y
conda activate spotify-concerts
pip install -r requirements.txt
```

Start the API server:
```bash
uvicorn app.main:app --reload
```

You should see `Uvicorn running on http://127.0.0.1:8000`.

### 4. Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

You should see `Local: http://127.0.0.1:5173/`. Open that URL in your browser (use `127.0.0.1`, **not** `localhost` — session cookies are scoped per hostname, and the Spotify callback returns to 127.0.0.1).

### 5. Log in

1. Click **Log in with Spotify**.
2. Approve the permission grant (only `user-top-read`).
3. You'll be redirected back to the app with your top artists loaded.
4. Set radius and "Top artists" count, click **Find concerts**.

---

## Project structure

```
SpotifyConcerts/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── config.py          # pydantic-settings, loads .env
│   │   ├── main.py            # FastAPI app, routes, middleware
│   │   ├── spotify.py         # OAuth + Web API client
│   │   └── ticketmaster.py    # Discovery API client (throttled)
│   ├── .env.example
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.jsx            # Top-level component, state, fetch calls
│   │   ├── main.jsx
│   │   └── index.css
│   ├── index.html
│   ├── package.json
│   └── vite.config.js         # Proxies /api → 127.0.0.1:8000
├── .gitignore
└── README.md
```

---

## API reference

All endpoints are mounted under `/api`.

| Method | Path                  | Description                                                                                  |
| ------ | --------------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/api/auth/login`     | Redirects the browser to Spotify's authorize page.                                           |
| GET    | `/api/auth/callback`  | Spotify redirects here with `code`; backend exchanges it for a token and stores it in the session. |
| GET    | `/api/auth/status`    | `{ "authenticated": bool }`.                                                                 |
| POST   | `/api/auth/logout`    | Clears the session.                                                                          |
| GET    | `/api/top-artists`    | `?limit=10&time_range=long_term` — returns the user's top artists.                           |
| GET    | `/api/concerts`       | `?latlong=lat,lng&radius=50&limit=10&time_range=long_term` — top artists' upcoming shows.    |

Auth state is stored in a signed session cookie via Starlette's `SessionMiddleware`. The frontend talks to these endpoints through the Vite dev proxy at `/api`.

---

## Troubleshooting

### "invalid state" after Spotify login

Your browser is on a different hostname than what Spotify is redirecting to. Session cookies are scoped per *hostname*, and `localhost` ≠ `127.0.0.1` as far as the browser is concerned. Make sure:
- You access the frontend at `http://127.0.0.1:5173`.
- Your Spotify redirect URI is exactly `http://127.0.0.1:8000/api/auth/callback`.
- Your `.env` `FRONTEND_URL` is `http://127.0.0.1:5173`.

### Vite proxy error `ECONNREFUSED`

Two possible causes:
1. Uvicorn isn't running.
2. Node 18+ resolves `localhost` to IPv6 (`::1`) first; if uvicorn only binds to IPv4 `127.0.0.1`, the proxy can't reach it. The `vite.config.js` in this repo already pins the proxy target to `http://127.0.0.1:8000` to avoid this.

### Ticketmaster `429 Too Many Requests`

Free tier is 5 req/sec. The backend throttles to 4 req/sec and backs off 1s on a 429. If you still hit this, lower "Top artists" or reduce search frequency. **Never paste the failing URL into a public chat / issue / screenshot — the API key is in the query string. Rotate it immediately at the Ticketmaster developer portal if leaked.**

### Top artists list is empty

Spotify removed several Web API endpoints in late 2024 (related artists, audio features, recommendations) and changed parts of others. If you see backend errors like `KeyError: 'genres'`, you're hitting a similar regression — check the response shape against current Spotify docs and use `.get(...)` defensively.

### Browser geolocation isn't populating

Firefox previously used Mozilla Location Service, which Mozilla shut down in mid-2024. On Linux Firefox now falls back to **GeoClue**.

- Install: `sudo pacman -S geoclue` (Arch) / `sudo apt install geoclue-2.0` (Debian/Ubuntu). It's D-Bus activated, no `systemctl enable` needed.
- In Firefox, open `about:config` and ensure `geo.provider.use_geoclue = true` and `geo.enabled = true`.
- Restart Firefox.
- Chrome/Chromium uses Google's geolocation service and works out of the box.
- Failing all that, paste lat/lng manually — Google Maps right-click → "What's here?" copies coordinates.

### "invalid grant" or 403 from Spotify login

Your Spotify app is in Development Mode and the user trying to log in isn't on the allowed list. Add them under **User Management** in the Spotify dashboard. Up to 25 users without an Extended Quota Mode request.

---

## Deploying to Render

This project is structured for an eventual Render deployment but doesn't ship with `render.yaml` yet. A typical setup:

### Option A: Two services (simpler to reason about)

1. **Backend Web Service** (Python):
   - Build: `pip install -r backend/requirements.txt`
   - Start: `cd backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT`
   - Env: copy `.env` values into Render's dashboard.
   - Set `SPOTIFY_REDIRECT_URI` to `https://<backend-service>.onrender.com/api/auth/callback` and add it as an **additional** redirect URI in the Spotify dashboard.

2. **Frontend Static Site**:
   - Build: `cd frontend && npm install && npm run build`
   - Publish directory: `frontend/dist`
   - Set `FRONTEND_URL` (in backend env) to your static site's URL.

CORS middleware in `main.py` already supports cross-origin credentialed requests.

### Option B: Single service (frontend served by FastAPI)

Build the frontend, then have FastAPI serve `frontend/dist` as static files. Drop CORS and `FRONTEND_URL` complexity. Slightly more setup but only one Render service to manage.

### Pin a supported Python version

Render currently supports Python up to 3.13. Add a `runtime.txt` in `backend/` with:
```
python-3.13.1
```

### Production hardening to consider

- **Refresh tokens** — current code only stores the Spotify access token (1hr lifetime). Save the `refresh_token` from the OAuth response and add a helper to refresh on 401.
- **Session store** — `SessionMiddleware` puts data in the cookie itself. Tokens travel on every request, and the cookie is signed but not encrypted. For production, switch to Redis-backed sessions keyed by a cookie ID.
- **Cache Ticketmaster attraction IDs** so you don't burn a lookup request per artist on every search.
- **Set the session cookie's `secure=True` and `same_site="none"`** when frontend and backend are on different domains over HTTPS.

---

## Known limitations

- **Artist-name matching is fuzzy.** Ticketmaster's attraction search can return false positives (tribute bands, similarly named artists). A higher-accuracy strategy would be to verify the matched attraction's Spotify or MusicBrainz ID before trusting it.
- **Coverage is Ticketmaster-only.** Indie / international shows are spotty. Songkick and Bandsintown have broader catalogs but harder API access.
- **Top artists is reflective of Spotify listening only.** Doesn't account for other services or recent additions to your library that haven't been played yet.

---

## License

MIT — do whatever, no warranty.
