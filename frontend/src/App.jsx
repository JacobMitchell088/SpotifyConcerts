import { useEffect, useState } from 'react';

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

  useEffect(() => {
    fetch('/api/auth/status', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setAuthed(d.authenticated));
  }, []);

  useEffect(() => {
    if (!authed) return;
    populateLocation();
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    fetch(
      `/api/top-artists?limit=${artistCount}&time_range=${timeRange}`,
      { credentials: 'include' }
    )
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setTopArtists(Array.isArray(d) ? d : []));
  }, [authed, artistCount, timeRange]);

  const login = () => {
    window.location.href = '/api/auth/login';
  };

  const populateLocation = () => {
    if (!navigator.geolocation) {
      setStatusMsg('Geolocation not supported by this browser.');
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
          2: 'position unavailable — Firefox on Linux often fails here without GeoClue installed (try Chrome, or install geoclue)',
          3: 'request timed out',
        };
        const reason = reasons[err.code] || err.message;
        setStatusMsg(`Could not get location: ${reason}. Enter lat,lng manually as a fallback.`);
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
    const r = await fetch(`/api/concerts?${params}`, { credentials: 'include' });
    setConcerts(await r.json());
    setSearched(true);
    setLoading(false);
  };

  if (!authed) {
    return (
      <div className="container">
        <h1>Spotify Concerts</h1>
        <p>See upcoming shows for the artists you listen to most.</p>
        <button onClick={login}>Log in with Spotify</button>
      </div>
    );
  }

  const groupedByArtist = topArtists.map((a) => ({
    artist: a.name,
    image: a.image,
    shows: concerts.filter((c) => c.artist === a.name),
  }));

  return (
    <div className="container">
      <h1>Spotify Concerts</h1>

      {topArtists.length > 0 && (
        <section>
          <h2>Searching concerts for your top artists</h2>
          <p className="subtitle">
            These are your top {topArtists.length} on Spotify — we'll look up upcoming shows for each.
          </p>
          <ol className="artists">
            {topArtists.map((a) => (
              <li key={a.name}>
                {a.image && <img src={a.image} alt="" />}
                <span>{a.name}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section>
        <h2>Upcoming shows near you</h2>
        <div className="controls">
          <div className="field location">
            <label>Location (lat,lng)</label>
            <div className="row">
              <input
                placeholder="e.g. 40.7128,-74.0060"
                value={latlong}
                onChange={(e) => setLatlong(e.target.value)}
              />
              <button
                className="secondary"
                onClick={populateLocation}
                disabled={locating}
                title="Use my browser location"
              >
                {locating ? '…' : 'Use my location'}
              </button>
            </div>
          </div>
          <div className="field">
            <label>Radius (mi)</label>
            <input
              type="number"
              min="1"
              max="500"
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Top artists</label>
            <input
              type="number"
              min="5"
              max="25"
              value={artistCount}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setArtistCount(Math.max(5, Math.min(25, n)));
              }}
            />
          </div>
          <div className="field window">
            <label>Listening window</label>
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
            >
              <option value="short_term">Last 4 weeks (short term)</option>
              <option value="medium_term">Last 6 months (medium term)</option>
              <option value="long_term">Last year (long term)</option>
            </select>
          </div>
          <button className="submit" onClick={loadConcerts} disabled={loading}>
            {loading ? 'Loading…' : 'Find concerts'}
          </button>
        </div>
        <p className="hint">
          Listening window: short ≈ 4 weeks · medium ≈ 6 months · long ≈ 1 year of history.
        </p>
        {statusMsg && <p className="status">{statusMsg}</p>}

        {!searched && !loading && (
          <p className="empty">No results yet — hit "Find concerts" above.</p>
        )}

        {searched && groupedByArtist.every((g) => g.shows.length === 0) && !loading && (
          <p className="empty">No upcoming shows found for your top artists in this area.</p>
        )}

        {groupedByArtist.map((g) =>
          g.shows.length === 0 ? null : (
            <div key={g.artist} className="artist-block">
              <div className="artist-header">
                {g.image && <img src={g.image} alt="" />}
                <h3>{g.artist}</h3>
                <span className="count">{g.shows.length} show{g.shows.length > 1 ? 's' : ''}</span>
              </div>
              <ul className="concerts">
                {g.shows.map((c, i) => (
                  <li key={i}>
                    <div className="event">{c.name}</div>
                    <div className="meta">
                      {[c.date, c.venue, c.city].filter(Boolean).join(' · ')}
                    </div>
                    {c.url && (
                      <a href={c.url} target="_blank" rel="noreferrer">
                        Tickets
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )
        )}
      </section>
    </div>
  );
}
