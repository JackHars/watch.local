// Schedules contain estimated end times. Use the league scoreboard to distinguish
// a finished game from an unavailable feed, and keep overtime games available.
const leagues = {
  nba: 'basketball/nba', nhl: 'hockey/nhl', nfl: 'football/nfl',
  mlb: 'baseball/mlb', cfb: 'football/college-football',
};
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\blos angeles\b/g, 'la').replace(/[^a-z0-9]/g, '');

export function scoreboardStatus(event, games) {
  const teams = String(event.title || '').split(/\s+(?:vs\.?|v\.?|at|@)\s+/i).map(normalize);
  if (teams.length !== 2 || teams.some(team => !team)) return null;
  const candidates = [];
  for (const game of games) for (const competition of game.competitions || []) {
    const contestants = competition.competitors || [];
    const difference = Math.abs(Date.parse(competition.date || game.date) / 1000 - event.starts_at);
    if (contestants.length !== 2 || !Number.isFinite(difference) || difference > 5400) continue;
    const names = contestants.map(({ team }) => [team?.displayName, team?.shortDisplayName].filter(Boolean).map(normalize));
    if (!(names[0].includes(teams[0]) && names[1].includes(teams[1]) || names[0].includes(teams[1]) && names[1].includes(teams[0]))) continue;
    const status = competition.status?.type || game.status?.type;
    const state = status?.completed === true && status.state === 'post' ? 'ENDED'
      : status?.state === 'in' ? 'LIVE' : status?.state === 'pre' ? 'UPCOMING' : null;
    if (state) candidates.push({ state, difference });
  }
  candidates.sort((a, b) => a.difference - b.difference);
  if (!candidates.length || candidates[1]?.difference === candidates[0].difference) return null;
  return candidates[0].state;
}

export function createSportsStatus({ request, now = Date.now }) {
  const cache = new Map();
  async function scoreboard(key) {
    let entry = cache.get(key);
    if (!entry) {
      entry = { games: [], updated: 0, retryAt: 0, pending: null }; cache.set(key, entry);
      while (cache.size > 48) cache.delete(cache.keys().next().value);
    }
    if (entry.retryAt <= now() && !entry.pending) entry.pending = (async () => {
      try {
        const data = JSON.parse((await request(`https://site.api.espn.com/apis/site/v2/sports/${key}`, undefined, { timeout: 5000 })).text);
        if (!Array.isArray(data.events)) throw Error('Invalid sports scoreboard.');
        entry.games = data.events; entry.updated = now(); entry.retryAt = now() + 60000;
      } catch { entry.retryAt = now() + 30000; }
    })().finally(() => { entry.pending = null; });
    await entry.pending;
    return now() - entry.updated < 180000 ? entry : { games: [], updated: 0 };
  }
  return async events => {
    const result = new Map();
    await Promise.all(events.map(async event => {
      if (!leagues[event.sport] || !Number.isFinite(event.starts_at) || !(event.starts_at > 0)) return;
      const date = day.format(new Date(event.starts_at * 1000)).replaceAll('-', '');
      const data = await scoreboard(`${leagues[event.sport]}/scoreboard?dates=${date}`);
      const state = scoreboardStatus(event, data.games);
      if (state) result.set(event.slug, { state, checkedAt: data.updated });
    }));
    return result;
  };
}
