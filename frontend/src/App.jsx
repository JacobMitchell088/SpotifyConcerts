import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';

const TIME_RANGE_LABEL = {
  short_term: 'last 4 weeks',
  medium_term: 'last 6 months',
  long_term: 'last year',
};

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

const ARTIST_MIN = 5;
const ARTIST_MAX = 25;
const RADIUS_MIN = 1;
const RADIUS_MAX = 500;

/* Strong shared easing curve (matches the CSS --ease-out token). */
const EASE = [0.23, 1, 0.32, 1];

/* Classify the "Where" field so we send the right param to the backend.
   The backend geocodes city/ZIP into lat/lng so radius search works.
   Returns one of:
     { kind: 'latlong', latlong: '38.6270,-90.1994' }
     { kind: 'postal',  postal_code: '63101' }
     { kind: 'cityst',  city: 'St. Louis', state_code: 'MO' }
     { kind: 'city',    city: 'Brooklyn' }
     { kind: 'empty' } */
function parseLocation(raw) {
  const v = (raw || '').trim();
  if (!v) return { kind: 'empty' };
  // lat,lng with optional space — guard against requiring decimals so users
  // can also enter integer coords like "38,-90".
  const ll = v.match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (ll) {
    const lat = parseFloat(ll[1]);
    const lng = parseFloat(ll[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { kind: 'latlong', latlong: `${lat},${lng}` };
    }
  }
  // US ZIP: 5 digits, optional -4.
  const zip = v.match(/^(\d{5})(?:[- ]?\d{4})?$/);
  if (zip) return { kind: 'postal', postal_code: zip[1] };
  // "City, ST" — last token is a 2-letter alpha code.
  const cs = v.match(/^(.+?),\s*([A-Za-z]{2})\.?$/);
  if (cs) {
    return {
      kind: 'cityst',
      city: cs[1].trim(),
      state_code: cs[2].toUpperCase(),
    };
  }
  return { kind: 'city', city: v };
}

function describeParsedLocation(parsed) {
  switch (parsed.kind) {
    case 'latlong': return `→ ${parsed.latlong}`;
    case 'postal':  return `→ ZIP ${parsed.postal_code}`;
    case 'cityst':  return `→ ${parsed.city}, ${parsed.state_code}`;
    case 'city':    return `→ city: ${parsed.city}`;
    default:        return '';
  }
}

function parseDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  return { year: y, month: MONTHS[m - 1], day: d };
}

/* The "Now tracking" box is a fixed-size area. We fit N *square* tiles inside
   it without scrolling: try every column count and keep the one that yields the
   largest square tile that fits both the measured width and the fixed height.
   So the grid reflows on its own — bigger tiles when there are few artists,
   smaller as more populate — and the box (and the controls below) never move.
   Tiles stay square, so portraits keep their proportions instead of cropping. */
const WALL_COLS = 5; // fallback before the width is measured
const WALL_BOX_H = 348; // px — the fixed tracking-area height
const WALL_GAP = 12; // px — must match the CSS grid gap (0.75rem)
const WALL_TILE_MAX = 196; // px — cap so a couple of artists don't blow up huge
function computeWallLayout(width, n) {
  if (!width || n <= 0) return { cols: WALL_COLS, pad: 0, tile: 0 };
  let best = { cols: 1, tile: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tileW = (width - (cols - 1) * WALL_GAP) / cols;
    const tileH = (WALL_BOX_H - (rows - 1) * WALL_GAP) / rows;
    const tile = Math.min(tileW, tileH);
    if (tile > best.tile) best = { cols, tile };
  }
  const pad = (best.cols - (n % best.cols)) % best.cols;
  return { cols: best.cols, pad, tile: Math.min(best.tile, WALL_TILE_MAX) };
}


/* ---- inline brand marks ----------------------------------- */

function SpotifyMark(props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.59 14.41c-.2.31-.59.41-.91.2-2.49-1.52-5.62-1.86-9.31-1.02-.36.08-.71-.15-.78-.51-.08-.36.15-.71.51-.78 4.03-.92 7.49-.53 10.29 1.18.31.2.41.59.2.93zm1.23-2.74c-.25.39-.77.51-1.16.26-2.85-1.75-7.2-2.26-10.57-1.23-.44.13-.91-.11-1.04-.55-.13-.44.11-.91.55-1.04 3.85-1.17 8.65-.6 11.92 1.41.39.24.51.77.3 1.15zm.1-2.86C14.46 8.61 8.99 8.42 5.7 9.42c-.53.16-1.09-.14-1.25-.67-.16-.53.14-1.09.67-1.25 3.79-1.15 9.78-.93 13.65 1.36.48.28.64.91.36 1.39-.28.48-.91.64-1.39.36z"/>
    </svg>
  );
}


/* Kinetic masked-line headline. `lines` is an array of strings or JSX. */
function MaskHeadline({ lines, className, delay = 0.1 }) {
  const reduce = useReducedMotion();
  return (
    <h1 className={className}>
      {lines.map((ln, i) => (
        <span className="mask-line" key={i}>
          <motion.span
            className="mask-inner"
            initial={reduce ? false : { y: '108%' }}
            animate={{ y: 0 }}
            transition={{ duration: 0.85, ease: EASE, delay: delay + i * 0.085 }}
          >
            {ln}
          </motion.span>
        </span>
      ))}
    </h1>
  );
}


export default function App() {
  // boot: 'connecting' until the first /api/auth/status resolves. On a cold
  // Render free-tier instance that request hangs while the service wakes —
  // we surface the press-warmup screen during the wait.
  const [boot, setBoot] = useState('connecting');
  const [coldVisible, setColdVisible] = useState(false);
  const [authed, setAuthed] = useState(false);

  const [topArtists, setTopArtists] = useState([]);
  const [customArtists, setCustomArtists] = useState([]); // [{name, image}]
  const [customInput, setCustomInput] = useState('');
  const [addingArtist, setAddingArtist] = useState(false);
  const [concerts, setConcerts] = useState([]);
  const [searched, setSearched] = useState(false);
  const [lastSearchUsedLocation, setLastSearchUsedLocation] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null); // {completed, total, etaSeconds}
  const [latlong, setLatlong] = useState('');
  const [whereInput, setWhereInput] = useState(''); // city or ZIP
  const [radius, setRadius] = useState(50);
  const [artistCount, setArtistCount] = useState(10);
  const [debouncedArtistCount, setDebouncedArtistCount] = useState(10);
  const [timeRange, setTimeRange] = useState('long_term');
  const [locating, setLocating] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  /* Measured width of the artist wall, so the grid can size square tiles to
     fit the fixed-height area. A callback ref wires up a ResizeObserver when the
     wall mounts (it only exists in the 'main' phase) and tears it down on
     unmount, keeping the width correct across resizes. */
  const wallRO = useRef(null);
  const [wallW, setWallW] = useState(0);
  const wallRef = useCallback((el) => {
    if (wallRO.current) {
      wallRO.current.disconnect();
      wallRO.current = null;
    }
    if (el) {
      setWallW(el.clientWidth);
      wallRO.current = new ResizeObserver(([e]) => setWallW(e.contentRect.width));
      wallRO.current.observe(el);
    }
  }, []);

  /* ---- boot probe + auth bootstrap ---- */
  useEffect(() => {
    let cancelled = false;
    // Only reveal the warmup screen if the probe is genuinely slow; a warm
    // backend resolves in well under this and skips the screen entirely.
    const slowTimer = setTimeout(() => {
      if (!cancelled) setColdVisible(true);
    }, 550);

    const probe = async () => {
      try {
        const r = await fetch('/api/auth/status', { credentials: 'include' });
        const d = await r.json();
        if (cancelled) return;
        setAuthed(!!d.authenticated);
        setBoot('ready');
      } catch {
        if (cancelled) return;
        // Transport error (service unreachable) — keep the press running and retry.
        setColdVisible(true);
        setTimeout(probe, 2500);
      }
    };
    probe();
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
    };
  }, []);

  /* ---- debounce artistCount changes to avoid refetch-per-keystroke ---- */
  useEffect(() => {
    const t = setTimeout(() => setDebouncedArtistCount(artistCount), 500);
    return () => clearTimeout(t);
  }, [artistCount]);

  /* ---- fetch top artists whenever debounced count or window changes ---- */
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/top-artists?limit=${debouncedArtistCount}&time_range=${timeRange}`,
          { credentials: 'include' }
        );
        if (r.status === 401) {
          setAuthed(false);
          setStatusMsg('Spotify session expired — please log in again.');
          return;
        }
        if (!r.ok) {
          setStatusMsg(`Could not load top artists (${r.status}).`);
          return;
        }
        const d = await r.json();
        if (!cancelled) setTopArtists(Array.isArray(d) ? d : []);
      } catch (e) {
        if (!cancelled) setStatusMsg(`Network error: ${e.message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authed, debouncedArtistCount, timeRange]);

  const login = () => {
    window.location.href = '/api/auth/login';
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setAuthed(false);
    setTopArtists([]);
    setCustomArtists([]);
    setConcerts([]);
    setSearched(false);
  };

  const addCustomArtist = async () => {
    const v = customInput.trim();
    if (!v || addingArtist) return;
    setAddingArtist(true);
    setStatusMsg('');
    try {
      // ask Spotify for the canonical name + image. fall back to typed text.
      let resolved = { name: v, image: null };
      try {
        const r = await fetch(
          `/api/search-artist?q=${encodeURIComponent(v)}`,
          { credentials: 'include' }
        );
        if (r.ok) {
          const data = await r.json();
          if (data && data.name) resolved = data;
        }
      } catch {
        /* fall through to typed-text fallback */
      }
      const key = resolved.name.toLowerCase();
      const dup =
        topArtists.some((a) => a.name.toLowerCase() === key) ||
        customArtists.some((c) => c.name.toLowerCase() === key);
      if (dup) {
        setStatusMsg(`"${resolved.name}" is already in the list.`);
        setCustomInput('');
        return;
      }
      setCustomArtists((prev) => [...prev, resolved]);
      setCustomInput('');
    } finally {
      setAddingArtist(false);
    }
  };

  const removeCustomArtist = (name) => {
    setCustomArtists((prev) => prev.filter((c) => c.name !== name));
  };

  const stepArtistCount = (delta) => {
    const cur = Number(artistCount);
    const base = Number.isFinite(cur) ? cur : ARTIST_MIN;
    setArtistCount(Math.max(ARTIST_MIN, Math.min(ARTIST_MAX, base + delta)));
  };

  const populateLocation = () => {
    if (!navigator.geolocation) {
      setStatusMsg('Geolocation is not supported in this browser.');
      return;
    }
    setLocating(true);
    setStatusMsg('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(4);
        const lng = pos.coords.longitude.toFixed(4);
        setLatlong(`${lat},${lng}`);
        setLocating(false);
      },
      (err) => {
        const reasons = {
          1: 'permission denied — check the location icon in the URL bar',
          2: 'position unavailable — Firefox on Linux often needs GeoClue installed',
          3: 'request timed out',
        };
        const reason = reasons[err.code] || err.message;
        setStatusMsg(`Could not get location: ${reason}. Enter lat,lng manually below.`);
        setLocating(false);
      },
      { timeout: 8000 }
    );
  };

  const loadConcerts = async () => {
    setLoading(true);
    setProgress(null);
    setStatusMsg('');
    const params = new URLSearchParams();
    params.set('limit', String(artistCount));
    params.set('time_range', timeRange);

    const coords = latlong.trim();
    let usedLocation = false;
    const parsed = parseLocation(whereInput);
    // latlong (from "Use mine") wins over the typed field.
    if (coords) {
      params.set('latlong', coords);
      params.set('radius', String(radius));
      usedLocation = true;
    } else if (parsed.kind === 'latlong') {
      params.set('latlong', parsed.latlong);
      params.set('radius', String(radius));
      usedLocation = true;
    } else if (parsed.kind === 'postal') {
      params.set('postal_code', parsed.postal_code);
      params.set('radius', String(radius));
      usedLocation = true;
    } else if (parsed.kind === 'cityst') {
      params.set('city', parsed.city);
      params.set('state_code', parsed.state_code);
      params.set('radius', String(radius));
      usedLocation = true;
    } else if (parsed.kind === 'city') {
      params.set('city', parsed.city);
      params.set('radius', String(radius));
      usedLocation = true;
    }
    for (const c of customArtists) {
      params.append('extra_artists', c.name);
    }
    try {
      const r = await fetch(`/api/concerts?${params}`, {
        method: 'POST',
        credentials: 'include',
      });
      if (r.status === 401) {
        setAuthed(false);
        setStatusMsg('Spotify session expired — please log in again.');
        return;
      }
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        setStatusMsg(`Search failed (${r.status}). ${body.slice(0, 140)}`);
        return;
      }
      const startBody = await r.json();
      const { job_id, total, warning } = startBody;
      setProgress({ completed: 0, total, etaSeconds: null });
      if (warning) {
        setStatusMsg(
          `Couldn't pin a precise location — searching without one. (${warning})`
        );
        usedLocation = false;
      }
      const final = await pollJob(job_id);
      if (!final) return; // status already set by poller
      setConcerts(Array.isArray(final.results) ? final.results : []);
      setLastSearchUsedLocation(usedLocation);
      setSearched(true);
    } catch (e) {
      setStatusMsg(`Network error: ${e.message}`);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  const pollJob = async (jobId) => {
    // Poll every 600ms until the job ends. Returns the final job dict, or null on error.
    const POLL_MS = 600;
    const MAX_WAIT_MS = 120_000;
    const started = Date.now();
    while (true) {
      if (Date.now() - started > MAX_WAIT_MS) {
        setStatusMsg('Search timed out after 2 minutes.');
        return null;
      }
      let r;
      try {
        r = await fetch(`/api/concerts/${jobId}`, { credentials: 'include' });
      } catch (e) {
        setStatusMsg(`Network error while polling: ${e.message}`);
        return null;
      }
      if (!r.ok) {
        setStatusMsg(`Lost the search job (${r.status}). Try again.`);
        return null;
      }
      const job = await r.json();
      setProgress({
        completed: job.completed,
        total: job.total,
        etaSeconds: job.eta_seconds,
      });
      if (job.status === 'done') return job;
      if (job.status === 'error') {
        setStatusMsg(`Search failed: ${job.error || 'unknown error'}`);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  };

  /* ---- which screen is showing ---- */
  let phase = 'blank';
  if (boot === 'connecting') phase = coldVisible ? 'cold' : 'blank';
  else if (!authed) phase = 'landing';
  else phase = 'main';

  const allArtists = [
    ...topArtists.map((a, i) => ({
      name: a.name,
      image: a.image,
      label: String(i + 1).padStart(2, '0'),
      custom: false,
    })),
    ...customArtists.map((c) => ({
      name: c.name,
      image: c.image,
      label: '+ ADDED',
      custom: true,
    })),
  ];

  const { cols, pad, tile } = computeWallLayout(wallW, allArtists.length);

  const groupedByArtist = allArtists.map((a, i) => ({
    artist: a.name,
    image: a.image,
    custom: a.custom,
    label: a.custom ? '+ ADDED' : `No. ${String(i + 1).padStart(2, '0')}`,
    shows: concerts.filter((c) => c.artist === a.name),
  }));

  const anyShows = groupedByArtist.some((g) => g.shows.length > 0);

  const screenFade = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.5, ease: EASE } },
    exit: { opacity: 0, transition: { duration: 0.3, ease: EASE } },
  };

  return (
    <AnimatePresence mode="wait">
      {phase === 'blank' && <div key="blank" style={{ minHeight: '100dvh' }} />}

      {phase === 'cold' && <ColdStart key="cold" />}

      {phase === 'landing' && (
        <motion.div key="landing" {...screenFade}>
          <Landing onLogin={login} />
        </motion.div>
      )}

      {phase === 'main' && (
        <motion.div key="main" {...screenFade} className="page">
          <Masthead authed onLogout={logout} />

          <main>
            <section>
              <div className="section-head">
                <h2 className="display">Now tracking</h2>
                <span className="kicker">
                  {TIME_RANGE_LABEL[timeRange]} · {topArtists.length} top
                  {customArtists.length > 0 && ` · ${customArtists.length} added`}
                </span>
              </div>
              <p className="muted" style={{ marginTop: 0, maxWidth: '52ch' }}>
                We'll match each of these against upcoming shows on Ticketmaster. Add
                your own artists below if they're not in your top listened, or adjust
                the controls to widen or narrow the scope.
              </p>
            </section>

            <motion.div
              ref={wallRef}
              className="artists-wall"
              style={{
                marginTop: '1.5rem',
                '--cols': cols,
                '--wall-box-h': `${WALL_BOX_H}px`,
                '--tile': `${tile}px`,
              }}
              initial="hidden"
              animate="show"
              variants={{
                hidden: {},
                show: { transition: { staggerChildren: 0.04, delayChildren: 0.05 } },
              }}
            >
              {allArtists.map((a) => (
                <ArtistTile
                  key={(a.custom ? 'c:' : 't:') + a.name}
                  a={a}
                  onRemove={removeCustomArtist}
                />
              ))}
              {Array.from({ length: pad }, (_, i) => (
                <div
                  key={`pad-${i}`}
                  className="artist-tile placeholder"
                  aria-hidden="true"
                />
              ))}
            </motion.div>

            <div className="add-artist-bar">
              <span className="label-mono">Add an artist</span>
              <input
                value={customInput}
                placeholder="Type a band or performer, then Enter"
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCustomArtist();
                  }
                }}
              />
              <button
                className="btn-ghost"
                onClick={addCustomArtist}
                disabled={!customInput.trim() || addingArtist}
              >
                {addingArtist ? '…' : 'Add'}
              </button>
            </div>

            <section>
              <div className="section-head">
                <h2 className="display">Search</h2>
                <span className="kicker">Set your zone of interest</span>
              </div>

              <div className="controls-strip">
                <div className="ctrl ctrl-location">
                  <span className="label-mono">
                    Where
                    <span className="ctrl-hint">city, ZIP, "City, ST", or lat,lng</span>
                  </span>
                  <div className="ctrl-row">
                    <input
                      placeholder={
                        latlong
                          ? 'Using your location'
                          : 'St. Louis, MO  ·  11201  ·  38.6,-90.1'
                      }
                      value={whereInput}
                      disabled={!!latlong}
                      onChange={(e) => setWhereInput(e.target.value)}
                    />
                    <button
                      className="btn-ghost"
                      onClick={latlong ? () => setLatlong('') : populateLocation}
                      disabled={locating}
                      title={latlong ? 'Clear current location' : 'Use browser location'}
                    >
                      {locating ? '…' : latlong ? 'Clear' : 'Use mine'}
                    </button>
                  </div>
                  <span className="ctrl-readout">
                    {latlong
                      ? `→ using ${latlong}`
                      : describeParsedLocation(parseLocation(whereInput))}
                  </span>
                </div>

                <div className="ctrl">
                  <span className="label-mono">
                    Radius
                    <span className="ctrl-hint">{RADIUS_MIN}–{RADIUS_MAX} mi</span>
                  </span>
                  <input
                    type="number"
                    min={RADIUS_MIN}
                    max={RADIUS_MAX}
                    value={radius}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (e.target.value === '') {
                        setRadius('');
                      } else if (Number.isFinite(n)) {
                        setRadius(Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, n)));
                      }
                    }}
                    onBlur={() => {
                      const n = Number(radius);
                      if (!Number.isFinite(n) || n < RADIUS_MIN) setRadius(RADIUS_MIN);
                    }}
                  />
                  <span className="ctrl-readout" aria-hidden="true" />
                </div>

                <div className="ctrl">
                  <span className="label-mono">
                    Top artists
                    <span className="ctrl-hint">{ARTIST_MIN}–{ARTIST_MAX}</span>
                  </span>
                  <div className="ctrl-row stepper">
                    <button
                      type="button"
                      className="stepper-btn"
                      onClick={() => stepArtistCount(-1)}
                      disabled={Number(artistCount) <= ARTIST_MIN}
                      aria-label="Decrease top artists"
                      title="Fewer artists"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={ARTIST_MIN}
                      max={ARTIST_MAX}
                      value={artistCount}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (e.target.value === '') {
                          setArtistCount('');
                        } else if (Number.isFinite(n)) {
                          setArtistCount(Math.max(ARTIST_MIN, Math.min(ARTIST_MAX, n)));
                        }
                      }}
                      onBlur={() => {
                        const n = Number(artistCount);
                        if (!Number.isFinite(n) || n < ARTIST_MIN) setArtistCount(ARTIST_MIN);
                      }}
                    />
                    <button
                      type="button"
                      className="stepper-btn"
                      onClick={() => stepArtistCount(1)}
                      disabled={Number(artistCount) >= ARTIST_MAX}
                      aria-label="Increase top artists"
                      title="More artists"
                    >
                      +
                    </button>
                  </div>
                  <span className="ctrl-readout" aria-hidden="true" />
                </div>

                <div className="ctrl">
                  <span className="label-mono">
                    Listening window
                    <span className="ctrl-hint">how far back</span>
                  </span>
                  <select
                    value={timeRange}
                    onChange={(e) => setTimeRange(e.target.value)}
                  >
                    <option value="short_term">Last 4 weeks</option>
                    <option value="medium_term">Last 6 months</option>
                    <option value="long_term">Last year</option>
                  </select>
                  <span className="ctrl-readout" aria-hidden="true" />
                </div>

                <div className="ctrl ctrl-submit-cell">
                  {/* Spacer occupying the label row so the button aligns with inputs. */}
                  <span className="label-mono" aria-hidden="true">&nbsp;</span>
                  <button
                    className="btn-primary ctrl-submit"
                    onClick={loadConcerts}
                    disabled={loading}
                  >
                    {loading ? 'Searching…' : 'Find concerts'}
                    {!loading && <span className="arrow">→</span>}
                  </button>
                  <span className="ctrl-readout" aria-hidden="true" />
                </div>
              </div>

              <p className="controls-hint">
                Leave location blank to search all upcoming shows for these artists.
                &nbsp;&middot;&nbsp; Short · 4 weeks &nbsp;&middot;&nbsp; Medium · 6 months
                &nbsp;&middot;&nbsp; Long · 1 year
              </p>

              {loading && progress && progress.total > 0 && (
                <ProgressBar progress={progress} />
              )}

              {statusMsg && <p className="controls-status">{statusMsg}</p>}
            </section>

            <section className="results">
              <div className="section-head">
                <h2 className="display">Upcoming shows</h2>
                <span className="kicker">
                  {!searched && 'Awaiting search'}
                  {searched && loading && 'Working…'}
                  {searched && !loading && anyShows && 'Compiled'}
                  {searched && !loading && !anyShows && 'No matches in range'}
                </span>
              </div>

              {!searched && !loading && (
                <p className="results-empty">
                  Hit <strong>Find concerts</strong> above to compile listings.
                </p>
              )}

              {searched && !loading && !anyShows && (
                <p className="results-empty">
                  {lastSearchUsedLocation
                    ? `No upcoming shows found within ${radius} miles. Widen the radius or clear the location to see all shows.`
                    : 'No upcoming shows found for these artists. Try the longer listening window, add artists manually, or check back later.'}
                </p>
              )}

              {groupedByArtist.map((g) =>
                g.shows.length === 0 ? null : (
                  <ArtistBlock key={g.artist} group={g} />
                )
              )}
            </section>
          </main>

          <Colophon />
        </motion.div>
      )}
    </AnimatePresence>
  );
}


/* ---- subcomponents --------------------------------------- */

function Masthead({ authed, onLogout }) {
  return (
    <header className="masthead">
      <div className="masthead-mark">
        <span className="line-1">Spotify</span>
        <span className="line-2">Concerts</span>
      </div>
      <div className="masthead-side">
        <span className="label-mono">Vol. 01 · No. 01</span>
        <span className="issue">A live music compendium</span>
        {authed && (
          <button
            className="link-mono"
            onClick={onLogout}
            style={{ marginTop: '0.4rem' }}
          >
            Log out
          </button>
        )}
      </div>
    </header>
  );
}


/* Cold-start "warming up the press" — themed wait while the backend wakes.
   The ticket prints up out of the slot; status lines cycle; elapsed counter
   makes the wait feel honest. Pure framer-motion, transform/opacity only. */
function ColdStart() {
  const reduce = useReducedMotion();
  const LINES = [
    'Warming up the press…',
    'Inking the rollers…',
    'Aligning the perforation…',
    'Cutting your ticket…',
    'Almost there…',
  ];
  const [line, setLine] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const a = setInterval(() => setLine((i) => Math.min(i + 1, LINES.length - 1)), 2600);
    const b = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, []);

  // pseudo-random but stable barcode bars
  const bars = [3, 1, 2, 1, 4, 1, 2, 3, 1, 2, 1, 3, 2, 1, 4, 1, 2, 1];

  return (
    <motion.div
      className="cold"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.4, ease: EASE } }}
      exit={{ opacity: 0, transition: { duration: 0.3 } }}
    >
      <div className="cold-inner">
        <div className="cold-brand">
          Spotify <span className="em">Concerts</span>
        </div>

        <div className="press">
          <motion.div
            className="press-ticket"
            initial={reduce ? false : { y: 130, rotate: -1 }}
            animate={{
              y: reduce ? 0 : [130, 4, 8, 4],
              rotate: reduce ? 0 : [-1, 0.4, -0.3, 0.4],
            }}
            transition={
              reduce
                ? { duration: 0 }
                : { duration: 4.2, ease: EASE, repeat: Infinity, repeatType: 'reverse' }
            }
          >
            <div className="pt-top">
              <span>Admit One</span>
              <span>Sec · Row · Seat</span>
            </div>
            <div className="pt-title">Live<br />Music</div>
            <div className="pt-bars">
              {bars.map((w, i) => (
                <i key={i} style={{ width: `${w * 2}px` }} />
              ))}
            </div>
          </motion.div>
          <div className="press-slot" />
        </div>

        <div className="cold-status" aria-live="polite">
          <AnimatePresence mode="wait">
            <motion.span
              key={line}
              initial={reduce ? false : { y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={reduce ? {} : { y: -10, opacity: 0 }}
              transition={{ duration: 0.35, ease: EASE }}
            >
              {LINES[line]}
            </motion.span>
          </AnimatePresence>
        </div>

        <div className="cold-feed" aria-hidden="true">
          <motion.i
            initial={{ x: '-100%' }}
            animate={{ x: '350%' }}
            transition={{ duration: 1.4, ease: 'linear', repeat: Infinity }}
          />
        </div>

        <div className="cold-elapsed">
          Free-tier server waking — this usually takes about 60s · {elapsed}s
        </div>
      </div>
    </motion.div>
  );
}


function Landing({ onLogin }) {
  const reduce = useReducedMotion();
  const fadeUp = {
    initial: reduce ? false : { y: 20, opacity: 0 },
    animate: { y: 0, opacity: 1 },
  };
  return (
    <div className="page landing-wrap">
      <Masthead authed={false} />

      <section className="landing">
        <div>
          <motion.span
            className="landing-eyebrow"
            {...fadeUp}
            transition={{ duration: 0.6, ease: EASE, delay: 0.05 }}
          >
            <span className="dot" /> An offering
          </motion.span>

          <MaskHeadline
            className="landing-headline"
            delay={0.15}
            lines={[
              'Your next',
              'show is',
              <span className="accent" key="a">out there.</span>,
            ]}
          />

          <motion.p
            className="landing-sub"
            {...fadeUp}
            transition={{ duration: 0.6, ease: EASE, delay: 0.55 }}
          >
            Sign in with Spotify. We'll pull your most-listened artists and match
            them against upcoming shows on Ticketmaster — anywhere you set the radius.
          </motion.p>

          <motion.div
            className="landing-cta"
            {...fadeUp}
            transition={{ duration: 0.6, ease: EASE, delay: 0.7 }}
          >
            <button className="btn-spotify" onClick={onLogin}>
              <span className="ico"><SpotifyMark /></span>
              <span>Log in with Spotify</span>
            </button>
            <span className="landing-credit">
              Concert data via{' '}
              <span className="brand-wordmark ticketmaster">TICKETMASTER</span>
              &nbsp;&middot;&nbsp;Listening data via{' '}
              <span className="brand-wordmark spotify">Spotify</span>
            </span>
          </motion.div>
        </div>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 30, rotate: 6 }}
          animate={{ opacity: 1, y: 0, rotate: 2 }}
          transition={{ duration: 0.85, ease: EASE, delay: 0.35 }}
        >
          <HeroTicket />
        </motion.div>
      </section>

      <Colophon />
    </div>
  );
}


function HeroTicket() {
  const bars = [3, 1, 2, 1, 4, 2, 1, 3, 1, 2, 1, 3];
  return (
    <div className="hero-ticket">
      <div className="ht-body">
        <div className="ht-row">
          <span>Box Office</span>
          <span>General Admission</span>
        </div>
        <div className="ht-big">
          One night<br />
          <em>only.</em>
        </div>
        <div className="ht-meta">
          <span>DOORS · WHEN YOU'RE READY</span>
          <span>VENUE · ANYWHERE IN RANGE</span>
          <span>PRICE · A FREE LOGIN</span>
        </div>
      </div>

      <div className="ht-foil">
        <span className="admit">Admit One</span>
        <span className="yr">'26</span>
        <span className="bars" aria-hidden="true">
          {bars.map((w, i) => (
            <i key={i} style={{ width: `${w * 2}px` }} />
          ))}
        </span>
      </div>

      <span className="perf-v" />
      <span className="notch" style={{ top: -11, right: 'calc(124px - 11px)' }} />
      <span className="notch" style={{ bottom: -11, right: 'calc(124px - 11px)' }} />
    </div>
  );
}


function ArtistTile({ a, onRemove }) {
  const reduce = useReducedMotion();
  return (
    <motion.article
      className={
        'artist-tile' +
        (a.image ? '' : ' no-image') +
        (a.custom ? ' custom' : '')
      }
      variants={{
        hidden: reduce ? { opacity: 0 } : { opacity: 0, y: 14 },
        show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
      }}
    >
      {a.image && (
        <>
          <div
            className="image"
            style={{ backgroundImage: `url(${a.image})` }}
            role="presentation"
          />
          <div className="shade" aria-hidden="true" />
        </>
      )}
      <span className="num">{a.label}</span>
      {a.custom && (
        <button
          className="remove-custom"
          onClick={() => onRemove(a.name)}
          aria-label={`Remove ${a.name}`}
          title={`Remove ${a.name}`}
        >
          ×
        </button>
      )}
      <div className="name">{a.name}</div>
    </motion.article>
  );
}


function ProgressBar({ progress }) {
  const { completed, total, etaSeconds } = progress;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  let etaLabel = 'estimating…';
  if (etaSeconds != null) {
    if (etaSeconds < 1) etaLabel = 'almost done';
    else if (etaSeconds < 60) etaLabel = `~${Math.ceil(etaSeconds)}s left`;
    else etaLabel = `~${Math.ceil(etaSeconds / 60)} min left`;
  }
  return (
    <div className="progress-strip" role="status" aria-live="polite">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-meta label-mono">
        <span>
          {completed} / {total} artists scanned
        </span>
        <span>{etaLabel}</span>
      </div>
    </div>
  );
}


function ArtistBlock({ group }) {
  return (
    <section className="artist-block">
      <header className="artist-header">
        <span className="num">{group.label}</span>
        <h3 className="name">{group.artist}</h3>
        <span className="count">
          {group.shows.length} show{group.shows.length > 1 ? 's' : ''}
        </span>
      </header>
      <motion.div
        className="show-list"
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.05 } },
        }}
      >
        {group.shows.map((c, i) => (
          <ShowStub key={i} show={c} />
        ))}
      </motion.div>
    </section>
  );
}


function ShowStub({ show }) {
  const reduce = useReducedMotion();
  const d = parseDate(show.date);
  return (
    <motion.article
      className="show-stub"
      variants={{
        hidden: reduce ? { opacity: 0 } : { opacity: 0, y: 16 },
        show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
      }}
    >
      <div className="stub-foil">
        {d ? (
          <>
            <span className="month">{d.month}</span>
            <span className="day-mask">
              <motion.span
                className="day"
                initial={reduce ? false : { y: '108%' }}
                animate={{ y: 0 }}
                transition={{ duration: 0.6, ease: EASE, delay: 0.15 }}
              >
                {d.day}
              </motion.span>
            </span>
            <span className="year">{d.year}</span>
          </>
        ) : (
          <span className="tba">TBA</span>
        )}
      </div>

      <span className="stub-perf" aria-hidden="true" />
      <span className="notch top" aria-hidden="true" />
      <span className="notch bot" aria-hidden="true" />

      <div className="stub-body">
        <div className="stub-event">{show.name}</div>
        <div className="stub-venue">
          {show.venue}
          {show.city && (
            <>
              {' '}
              <span className="city">· {show.city}</span>
            </>
          )}
        </div>
        {show.url && (
          <a
            className="stub-ticket"
            href={show.url}
            target="_blank"
            rel="noreferrer"
          >
            Get Tickets <span className="arrow" aria-hidden="true">↗</span>
          </a>
        )}
      </div>
    </motion.article>
  );
}


function Colophon() {
  return (
    <footer className="colophon">
      <div className="mark">Spotify Concerts</div>
      <div className="colophon-credits">
        <span>
          Listening data ·{' '}
          <span className="brand-wordmark spotify">Spotify</span> Web API
        </span>
        <span>
          Concert data ·{' '}
          <span className="brand-wordmark ticketmaster">TICKETMASTER</span> Discovery API
        </span>
        <span>Printed on the open web · {new Date().getFullYear()}</span>
      </div>
    </footer>
  );
}
