import { useEffect, useState } from 'react';

const TIME_RANGE_LABEL = {
  short_term: 'last 4 weeks',
  medium_term: 'last 6 months',
  long_term: 'last year',
};

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function parseDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  return { year: y, month: MONTHS[m - 1], day: d };
}


/* ---- inline brand marks ----------------------------------- */

function SpotifyMark(props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.59 14.41c-.2.31-.59.41-.91.2-2.49-1.52-5.62-1.86-9.31-1.02-.36.08-.71-.15-.78-.51-.08-.36.15-.71.51-.78 4.03-.92 7.49-.53 10.29 1.18.31.2.41.59.2.93zm1.23-2.74c-.25.39-.77.51-1.16.26-2.85-1.75-7.2-2.26-10.57-1.23-.44.13-.91-.11-1.04-.55-.13-.44.11-.91.55-1.04 3.85-1.17 8.65-.6 11.92 1.41.39.24.51.77.3 1.15zm.1-2.86C14.46 8.61 8.99 8.42 5.7 9.42c-.53.16-1.09-.14-1.25-.67-.16-.53.14-1.09.67-1.25 3.79-1.15 9.78-.93 13.65 1.36.48.28.64.91.36 1.39-.28.48-.91.64-1.39.36z"/>
    </svg>
  );
}


export default function App() {
  const [authed, setAuthed] = useState(false);
  const [topArtists, setTopArtists] = useState([]);
  const [concerts, setConcerts] = useState([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [latlong, setLatlong] = useState('');
  const [radius, setRadius] = useState(50);
  const [artistCount, setArtistCount] = useState(10);
  const [timeRange, setTimeRange] = useState('long_term');
  const [locating, setLocating] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  /* ---- auth bootstrap ---- */
  useEffect(() => {
    fetch('/api/auth/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setAuthed(d.authenticated))
      .catch(() => setAuthed(false));
  }, []);

  /* ---- on auth: pull location once ---- */
  useEffect(() => {
    if (!authed) return;
    populateLocation();
  }, [authed]);

  /* ---- fetch top artists whenever count or window changes ---- */
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/top-artists?limit=${artistCount}&time_range=${timeRange}`,
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
  }, [authed, artistCount, timeRange]);

  const login = () => {
    window.location.href = '/api/auth/login';
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setAuthed(false);
    setTopArtists([]);
    setConcerts([]);
    setSearched(false);
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
    setStatusMsg('');
    const params = new URLSearchParams();
    params.set('limit', String(artistCount));
    params.set('time_range', timeRange);
    const coords = latlong.trim();
    if (coords) {
      params.set('latlong', coords);
      params.set('radius', String(radius));
    }
    try {
      const r = await fetch(`/api/concerts?${params}`, { credentials: 'include' });
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
      const data = await r.json();
      setConcerts(Array.isArray(data) ? data : []);
      setSearched(true);
    } catch (e) {
      setStatusMsg(`Network error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  if (!authed) {
    return <Landing onLogin={login} />;
  }

  const groupedByArtist = topArtists.map((a, i) => ({
    artist: a.name,
    image: a.image,
    index: i + 1,
    shows: concerts.filter((c) => c.artist === a.name),
  }));

  const anyShows = groupedByArtist.some((g) => g.shows.length > 0);

  return (
    <div className="page">
      <Masthead authed onLogout={logout} />

      <main>
        <section className="rise">
          <div className="section-head">
            <h2 className="display">Now tracking</h2>
            <span className="kicker">{TIME_RANGE_LABEL[timeRange]} · {topArtists.length} artists</span>
          </div>
          <p className="muted" style={{ marginTop: 0, maxWidth: '52ch' }}>
            We'll match each of these against upcoming shows on Ticketmaster. Adjust the
            controls below to widen or narrow the scope.
          </p>
        </section>

        <div className="artists-wall rise-stagger" style={{ marginTop: '1.5rem' }}>
          {topArtists.map((a, i) => (
            <article
              key={a.name}
              className={`artist-tile ${a.image ? '' : 'no-image'}`}
            >
              {a.image && (
                <div
                  className="image"
                  style={{ backgroundImage: `url(${a.image})` }}
                  role="presentation"
                />
              )}
              <span className="num">{String(i + 1).padStart(2, '0')}</span>
              <div className="name">{a.name}</div>
            </article>
          ))}
        </div>

        <section className="rise">
          <div className="section-head">
            <h2 className="display">Search</h2>
            <span className="kicker">Set your zone of interest</span>
          </div>

          <div className="controls-strip">
            <div className="ctrl ctrl-location">
              <span className="label-mono">Location · lat, lng</span>
              <div className="ctrl-row">
                <input
                  placeholder="40.7128, -74.0060"
                  value={latlong}
                  onChange={(e) => setLatlong(e.target.value)}
                />
                <button
                  className="btn-ghost"
                  onClick={populateLocation}
                  disabled={locating}
                  title="Use browser location"
                >
                  {locating ? '…' : 'Use mine'}
                </button>
              </div>
            </div>

            <div className="ctrl">
              <span className="label-mono">Radius · mi</span>
              <input
                type="number"
                min="1"
                max="500"
                value={radius}
                onChange={(e) => setRadius(e.target.value)}
              />
            </div>

            <div className="ctrl">
              <span className="label-mono">Top artists</span>
              <input
                type="number"
                min="5"
                max="25"
                value={artistCount}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) {
                    setArtistCount(Math.max(5, Math.min(25, n)));
                  }
                }}
              />
            </div>

            <div className="ctrl">
              <span className="label-mono">Listening window</span>
              <select
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value)}
              >
                <option value="short_term">Last 4 weeks</option>
                <option value="medium_term">Last 6 months</option>
                <option value="long_term">Last year</option>
              </select>
            </div>

            <button
              className="btn-primary ctrl-submit"
              onClick={loadConcerts}
              disabled={loading}
            >
              {loading ? 'Searching…' : 'Find concerts'}
              {!loading && <span className="arrow">→</span>}
            </button>
          </div>

          <p className="controls-hint">
            Short · 4 weeks &nbsp;&middot;&nbsp; Medium · 6 months &nbsp;&middot;&nbsp; Long · 1 year of listening history
          </p>

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
              No upcoming shows found for your top artists within {radius} miles.
              Widen the radius or broaden the listening window.
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
    </div>
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
        <span className="label-mono">Volume 01 · No. 01</span>
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


function Landing({ onLogin }) {
  return (
    <div className="page">
      <Masthead authed={false} />

      <section className="landing">
        <div className="landing-eyebrow">
          <span className="kicker">An offering</span>
        </div>

        <h1 className="landing-headline">
          <span>Your next</span>
          <span>show is</span>
          <span className="accent">out there.</span>
        </h1>

        <p className="landing-sub">
          Sign in with Spotify. We&rsquo;ll pull your most-listened artists and
          match them against upcoming shows on Ticketmaster — anywhere you set
          the radius.
        </p>

        <div className="landing-cta">
          <button className="btn-spotify" onClick={onLogin}>
            <SpotifyMark />
            <span>Log in with Spotify</span>
          </button>
          <span className="landing-credit">
            Concert data via{' '}
            <span className="brand-wordmark ticketmaster">TICKETMASTER</span>
            &nbsp;&middot;&nbsp;Listening data via{' '}
            <span className="brand-wordmark spotify">Spotify</span>
          </span>
        </div>
      </section>

      <Colophon />
    </div>
  );
}


function ArtistBlock({ group }) {
  return (
    <section className="artist-block">
      <header className="artist-header">
        <span className="num">No. {String(group.index).padStart(2, '0')}</span>
        <h3 className="name">{group.artist}</h3>
        <span className="count">
          {group.shows.length} show{group.shows.length > 1 ? 's' : ''}
        </span>
      </header>
      <div className="show-list">
        {group.shows.map((c, i) => (
          <ShowStub key={i} show={c} />
        ))}
      </div>
    </section>
  );
}


function ShowStub({ show }) {
  const d = parseDate(show.date);
  return (
    <article className="show-stub">
      <div className="stub-date">
        {d ? (
          <>
            <span className="month">{d.month}</span>
            <span className="day">{d.day}</span>
            <span className="year">{d.year}</span>
          </>
        ) : (
          <span className="month">TBA</span>
        )}
      </div>
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
            Get tickets <span className="tm-credit">via Ticketmaster ↗</span>
          </a>
        )}
      </div>
    </article>
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
