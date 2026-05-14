# Spotify Concerts
> Author: Jacob Mitchell    
> Date: 5/14/26   

View Live Site Here: https://spotifyconcerts.onrender.com/
> Cold start of ~60 seconds

Find upcoming concerts for the artists you actually listen to. Logs in with your Spotify account, pulls your top artists from the Spotify Web API, then looks up nearby shows for each one via the Ticketmaster Discovery API.

- **Backend:** Python 3.13 / FastAPI / httpx
- **Frontend:** React 18 + Vite (JSX)
- **Auth:** Spotify OAuth Authorization Code flow (server-side, session-based)
- **Geocoding:** OpenStreetMap Nominatim (free, no API key)
- **Tests:** pytest + GitHub Actions CI
- **Deployment:** Render

---

## Features

- **Spotify OAuth login** — no password handling, Spotify owns the session. Refresh-token aware: access tokens that expire mid-session are refreshed transparently before the next call.
- **Top 5–25 artists** across three listening windows:
  - Short — last ~4 weeks
  - Medium — last ~6 months
  - Long — last ~1 year
- **Add your own artists** manually — autocompletes against Spotify to use the canonical name + image, deduped case-insensitively against your top list.
- **Flexible "Where" input** — single field accepts:
  - `City, ST` (e.g. `St. Louis, MO`)
  - US ZIP (`11201` or `11201-1234`)
  - `lat,lng` (`38.6,-90.1`)
  - bare city name
  - or click **Use mine** to pull browser geolocation
  - a live readout chip under the input shows what was parsed
- **Geocoded radius search.** Ticketmaster's `city` filter is exact-substring match, so this app geocodes any text location to lat/lng via Nominatim and uses the great-circle `latlong + radius` search instead. Cache + 1 req/sec throttle keep us within OSM's free-use policy.
- **Adjustable radius** 1–500 mi, with min/max badges visible on every input.
- **Custom +/− stepper** for the Top Artists count, alongside free-typing.
- **Async job-based search** — `POST /api/concerts` returns a job ID; the frontend polls progress (`completed / total`, ETA in seconds/minutes) and renders a striped progress bar while Ticketmaster lookups fan out in parallel.
- **Parallelized Ticketmaster client** — `asyncio.Semaphore(4)` with exponential-backoff retries on 429/5xx, honoring `Retry-After`. A 20-artist search drops from ~10s to ~3s.
- **Server-side input clamps** on radius / artist count / extra artists so the public knobs can't amplify upstream usage.
- **Results grouped by artist**, each show rendered as a poster-stub card with date, venue, city, and a "Get Tickets" link to Ticketmaster.
- **Poster-aesthetic UI** — Hatch Show Print / risograph type, restrained CSS-only motion, paper grain via inline SVG. Respects `prefers-reduced-motion`.

---

## Prerequisites

- Python 3.13 recommended (matches Render's pinned runtime and CI).
- Node.js 18+ and npm.
- A free Spotify Developer account.
- A free Ticketmaster Developer account.
- `venv` or Conda for the Python environment.

No account or key needed for Nominatim — it's anonymous, just requires a descriptive User-Agent which the code already sets.

---

## Setup

### 1. Clone

```bash
git clone https://github.com/JacobMitchell088/SpotifyConcerts.git
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

Edit `.env` and fill in the values:

```
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8000/api/auth/callback
TICKETMASTER_API_KEY=...
SESSION_SECRET=<long random string>
FRONTEND_URL=http://127.0.0.1:5173
COOKIE_SECURE=false
```

Generate a session secret:
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
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

You should see `Uvicorn running on http://127.0.0.1:8000`.

### 4. Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

You should see `Local: http://127.0.0.1:5173/`. Open that URL — use `127.0.0.1`, **not** `localhost` — session cookies are scoped per hostname, and the Spotify callback returns to 127.0.0.1.

### 5. Log in

1. Click **Log in with Spotify**.
2. Approve the permission grant (only `user-top-read`).
3. You'll be redirected back to the app with your top artists loaded.
4. Optionally enter a location and adjust the radius / listening window.
5. Click **Find concerts** and watch the progress bar.

---

## Running tests

The backend ships a pytest suite (~33 tests, runs in < 1s):

```bash
cd backend
pip install -r requirements-dev.txt
pytest
```

The same suite runs in CI on every push to `main` and every PR targeting `main` (`.github/workflows/ci.yml`). CI also smoke-builds the frontend with `npm run build`.

Test coverage at a glance:
- `test_auth.py` — auth status, OAuth state validation, logout, 401 paths
- `test_jobs.py` — job-store lifecycle, ETA estimation, stale-purge
- `test_ticketmaster.py` — retry-after-429, give-up after max attempts, param routing, progress callbacks
- `test_geocode.py` — Nominatim happy path, cache de-dup, no-match, transport errors
- `test_concerts_flow.py` — end-to-end POST → poll → done, geocode integration, clamp enforcement

---

## Project structure

```
SpotifyConcerts/
├── .github/workflows/
│   └── ci.yml                  # pytest + frontend build on push/PR to main
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── config.py           # pydantic-settings, loads .env
│   │   ├── main.py             # FastAPI routes, job orchestration, input clamps
│   │   ├── spotify.py          # OAuth + Web API client (refresh-aware)
│   │   ├── ticketmaster.py     # Parallel Discovery API client with retries
│   │   ├── geocode.py          # Nominatim client + LRU cache + throttle
│   │   └── jobs.py             # In-memory async job store w/ progress + ETA
│   ├── tests/                  # pytest suite (auth, jobs, geocode, TM, flow)
│   ├── pytest.ini
│   ├── requirements.txt
│   ├── requirements-dev.txt
│   ├── runtime.txt             # python-3.13.1 (Render pin)
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── App.jsx             # Single-file app, all components inline
│   │   ├── main.jsx
│   │   └── index.css           # Poster design system
│   ├── index.html
│   ├── package.json
│   └── vite.config.js          # Proxies /api → 127.0.0.1:8000
├── environment.yml
├── .gitignore
└── README.md
```

---

## API reference

All endpoints are mounted under `/api`. Auth state lives in a signed Starlette session cookie. The frontend talks to these endpoints through the Vite dev proxy at `/api`.

| Method | Path                       | Description                                                                                                                                                                                                                            |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/auth/login`          | Redirects to Spotify's authorize page; stashes `oauth_state` in the session.                                                                                                                                                           |
| GET    | `/api/auth/callback`       | Validates state, exchanges the code, stores `access_token` and `refresh_token`.                                                                                                                                                        |
| GET    | `/api/auth/status`         | `{ "authenticated": bool }`.                                                                                                                                                                                                           |
| POST   | `/api/auth/logout`         | Clears the session.                                                                                                                                                                                                                    |
| GET    | `/api/top-artists`         | `?limit=10&time_range=long_term` → `[{name, image, genres}]`.                                                                                                                                                                          |
| GET    | `/api/search-artist`       | `?q=...` → top-matching Spotify artist (used by the "Add an artist" flow).                                                                                                                                                             |
| POST   | `/api/concerts`            | Starts an async concert search. Params: `latlong`, `city`, `state_code`, `postal_code`, `radius`, `limit`, `time_range`, `extra_artists` (repeated). Returns `{job_id, total, resolved_latlong, warning}`. Text locations are geocoded. |
| GET    | `/api/concerts/{job_id}`   | Poll the job. Returns `{status, completed, total, elapsed_seconds, eta_seconds, results, error, warning}`. `status` is `pending` / `running` / `done` / `error`.                                                                       |

**Server-side clamps** applied in `main.py`:
- `radius`: 1–500 mi
- `limit`: 1–50 artists
- `extra_artists`: capped at 25

### Job flow at a glance

```
client                            server
  │  POST /api/concerts             │
  │ ─────────────────────────────→  │  geocode text location (if any)
  │                                 │  fetch top artists from Spotify
  │                                 │  create job, spawn background task
  │ ←──────  {job_id, total}        │
  │                                 │  fan out: 4 artists × (find_attraction → find_events)
  │                                 │  each completion bumps job.completed
  │  GET /api/concerts/{job_id}     │
  │ ─────────────────────────────→  │
  │ ←──── {status: running,         │
  │        completed: 7, total: 20, │
  │        eta_seconds: 4.2}        │
  │                                 │  (poll every 600ms, 2-min ceiling)
  │  GET /api/concerts/{job_id}     │
  │ ─────────────────────────────→  │
  │ ←──── {status: done,            │
  │        results: [...]}          │
```

---

## Troubleshooting

### "invalid state" after Spotify login

Your browser is on a different hostname than what Spotify is redirecting to. Session cookies are scoped per *hostname*, and `localhost` ≠ `127.0.0.1`. Make sure:
- You access the frontend at `http://127.0.0.1:5173`.
- Your Spotify redirect URI is exactly `http://127.0.0.1:8000/api/auth/callback`.
- Your `.env` `FRONTEND_URL` is `http://127.0.0.1:5173`.

### Vite proxy error `ECONNREFUSED`

1. Uvicorn isn't running.
2. Node 18+ resolves `localhost` to IPv6 (`::1`) first; if uvicorn only binds to IPv4 `127.0.0.1`, the proxy can't reach it. The `vite.config.js` in this repo already pins the proxy target to `http://127.0.0.1:8000` to avoid this.

### Spotify 401 spilling out as 500

You have a session minted before refresh-token storage was added. Log out and back in once — the new session will store the refresh token, and the wrapper in `_call_spotify` will silently refresh expired access tokens going forward.

### Ticketmaster `429 Too Many Requests`

Free tier is 5 req/sec. The client uses `Semaphore(4)` plus exponential-backoff retries that honor `Retry-After`. If you still hit this, lower "Top artists" or wait a moment between searches. **Never paste a failing URL into a public chat / issue / screenshot — the API key is in the query string. Rotate it immediately at the Ticketmaster portal if leaked.**

### Search returns nothing for a city

The search uses Nominatim (OpenStreetMap) to geocode your text into a lat/lng. If Nominatim can't find a match, you'll see a yellow warning like *"no geocoding match for 'Wakanda'"* and the search runs without a location filter. For ambiguous city names, add a state code (`"Springfield, IL"` vs `"Springfield, MO"`) to disambiguate.

### Browser geolocation isn't populating

Firefox previously used Mozilla Location Service, which Mozilla shut down in mid-2024. On Linux Firefox now falls back to **GeoClue**.

- Install: `sudo pacman -S geoclue` (Arch) / `sudo apt install geoclue-2.0` (Debian/Ubuntu). It's D-Bus activated, no `systemctl enable` needed.
- In Firefox, open `about:config` and ensure `geo.provider.use_geoclue = true` and `geo.enabled = true`.
- Restart Firefox.
- Chrome/Chromium uses Google's geolocation service and works out of the box.
- Failing all that, type lat/lng directly into the Where field (`38.6,-90.1`) — Google Maps right-click → "What's here?" copies coordinates.

### Top artists list is empty

Spotify removed several Web API endpoints in late 2024 (related artists, audio features, recommendations) and changed parts of others. The code uses `.get(...)` defensively for fields like `genres`. If you see backend errors of this shape, check the response against current Spotify docs.

### "invalid grant" or 403 from Spotify login

Your Spotify app is in Development Mode and the user trying to log in isn't on the allowed list. Add them under **User Management** in the Spotify dashboard. Up to 25 users without an Extended Quota Mode request.

---

## Deploying to Render

Currently deployed at <https://spotifyconcerts.onrender.com>.

### Backend — Web Service (Python)

- Build: `pip install -r backend/requirements.txt`
- Start: `cd backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Env: copy `.env` values into the Render dashboard, plus:
  - `COOKIE_SECURE=true` (HTTPS only)
  - `FRONTEND_URL=https://<your-frontend>.onrender.com`
  - `SPOTIFY_REDIRECT_URI=https://<your-backend>.onrender.com/api/auth/callback`
- Add the same redirect URI to your Spotify app dashboard.

### Frontend — Static Site

- Build: `cd frontend && npm ci && npm run build`
- Publish: `frontend/dist`
- **Dashboard rewrites** (use `*`, not `:splat`, when configuring from the dashboard UI):
  - `/api/*` → `https://<your-backend>.onrender.com/api/*` (rewrite)
  - `/*` → `/index.html` (rewrite)

### Pinned Python version

`backend/runtime.txt` is set to `python-3.13.1` — matches Render's supported runtime and the CI matrix.

### Production hardening to consider

- **Session store** — `SessionMiddleware` puts data in the cookie itself. Tokens travel on every request, and the cookie is signed but not encrypted. For higher-stakes deployment, switch to Redis-backed sessions keyed by a cookie ID.
- **Job store** — `jobs.JobStore` is in-process. Fine for a single Render instance; would need Redis for horizontal scale.
- **Cache Ticketmaster attraction IDs** so you don't burn a lookup per artist on every search.
- **Rate limiting** at the API edge (e.g. `slowapi`) to prevent abuse of the search knob.

---

## Known limitations

- **Artist-name matching is fuzzy.** Ticketmaster's attraction search can return false positives (tribute bands, similarly named artists). A higher-accuracy strategy would be to verify the matched attraction against a Spotify or MusicBrainz ID.
- **Single-point radius search.** A location resolves to one centroid (city center, ZIP center, geolocation point); radius is then a great-circle filter around that point. For "anywhere in this state," geocode the state name (e.g. `"Missouri"`) to use the state's centroid.
- **Coverage is Ticketmaster-only.** Indie / international shows are spotty. Songkick and Bandsintown have broader catalogs but harder API access.
- **Top artists reflects Spotify listening only** — doesn't account for other services or library additions you haven't actually played.

---

## License

MIT — do whatever, no warranty.
