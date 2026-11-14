import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDirectory, problem } from './settings.mjs';

export function watchIdentity(input) {
  const integer = (value, min) => {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(number) || number < min) throw problem(400, 'Invalid movie or episode.');
    return number;
  };
  if (!['movie', 'tv'].includes(input.type)) throw problem(400, 'Progress is available for movies and episodes.');
  const id = integer(input.id, 1), season = input.type === 'tv' ? integer(input.season, 0) : null;
  const episode = input.type === 'tv' ? integer(input.episode, 1) : null;
  return { key: [input.type, id, ...(input.type === 'tv' ? [season, episode] : [])].join(':'), type: input.type, id, season, episode };
}

const artwork = value => typeof value === 'string' && /^\/[\w./-]{1,240}$/.test(value) ? value : null;
const publicProgress = ({ playbackId, sequence, ...record }) => structuredClone(record);

export function createWatchProgressStore(directory) {
  const file = join(directory, 'watch-progress.json');
  let state, initialization, queue = Promise.resolve();
  const persist = async next => {
    await writeFile(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
    await rename(file + '.tmp', file);
    state = next;
  };
  const initialize = () => initialization ||= (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let original;
    try { original = await readFile(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { version: 2, users: {} };
      return;
    }
    state = JSON.parse(original);
    if (![1, 2].includes(state.version) || !state.users || typeof state.users !== 'object' || Array.isArray(state.users)) throw Error('Invalid watch progress file.');
    if (state.version === 1) {
      const next = { version: 2, users: {} };
      for (const [userId, records] of Object.entries(state.users)) {
        const bucket = next.users[userId] = { profiles: {}, progress: {} };
        if (!Object.keys(records).length) continue;
        const id = randomUUID();
        bucket.profiles[id] = { id, name: 'Main', color: '#527de0', createdAt: Date.now(), migrated: true };
        bucket.progress[id] = records;
      }
      try { await writeFile(join(directory, 'watch-progress.pre-profiles.json'), original, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await persist(next);
    }
  })();
  function requireProfile(userId, profileId) {
    if (typeof profileId !== 'string' || !/^[0-9a-f-]{36}$/.test(profileId)) throw problem(400, 'Choose who’s watching first.');
    const profile = state.users[userId]?.profiles[profileId];
    if (!profile) throw problem(404, 'Profile not found.');
    return profile;
  }
  return {
    async profiles(userId) {
      await initialize(); await queue;
      return structuredClone(Object.values(state.users[userId]?.profiles || {}));
    },
    async profile(userId, profileId) {
      await initialize(); await queue;
      return structuredClone(requireProfile(userId, profileId));
    },
    async createProfile(userId, input) {
      const name = typeof input.name === 'string' ? input.name.normalize('NFC').trim() : '';
      if (!name || [...name].length > 40 || /[\u0000-\u001f\u007f]/.test(name)) throw problem(400, 'Enter a name between 1 and 40 characters.');
      if (typeof input.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.color)) throw problem(400, 'Choose a valid profile colour.');
      const task = queue.then(async () => {
        await initialize();
        const next = structuredClone(state), bucket = next.users[userId] ||= { profiles: {}, progress: {} };
        const profiles = Object.values(bucket.profiles);
        if (profiles.length >= 20) throw problem(400, 'This account already has 20 profiles.');
        if (profiles.some(profile => profile.name.toLowerCase() === name.toLowerCase())) throw problem(409, 'A profile with that name already exists.');
        const profile = { id: randomUUID(), name, color: input.color.toLowerCase(), createdAt: Date.now() };
        bucket.profiles[profile.id] = profile;
        bucket.progress[profile.id] = {};
        await persist(next);
        return structuredClone(profile);
      });
      queue = task.catch(() => {});
      return task;
    },
    async get(userId, profileId, input) {
      const { key } = watchIdentity(input);
      await initialize(); await queue;
      requireProfile(userId, profileId);
      const entry = state.users[userId].progress[profileId]?.[key];
      return entry ? publicProgress(entry) : null;
    },
    async list(userId, profileId, { includeCompletedSeries = false, includeCompleted = false } = {}) {
      await initialize(); await queue;
      requireProfile(userId, profileId);
      const latest = new Map();
      const entries = Object.values(state.users[userId].progress[profileId] || {}).sort((a, b) => b.updatedAt - a.updatedAt);
      // One card per show, using its most recently watched episode. A finished
      // episode must not bring an older, partially watched episode back.
      for (const entry of entries) {
        const titleKey = `${entry.type}:${entry.id}`;
        if (!latest.has(titleKey)) latest.set(titleKey, entry);
      }
      return [...latest.values()].filter(entry => entry.position >= 1 && (!entry.completed || includeCompleted || includeCompletedSeries && entry.type === 'tv')).slice(0, includeCompletedSeries ? 500 : 50).map(publicProgress);
    },
    save(userId, profileId, input) {
      const identity = watchIdentity(input);
      const { position, duration, playbackId, sequence } = input;
      if (!Number.isFinite(duration) || duration <= 0 || duration > 604800 || !Number.isFinite(position) || position < 0 || position > duration + 5)
        throw problem(400, 'Invalid playback position or duration.');
      if (input.ended !== undefined && typeof input.ended !== 'boolean') throw problem(400, 'Invalid playback status.');
      if (typeof playbackId !== 'string' || !/^[\w-]{8,100}$/.test(playbackId) || !Number.isSafeInteger(sequence) || sequence < 1)
        throw problem(400, 'Invalid playback update.');
      const task = queue.then(async () => {
        await initialize();
        requireProfile(userId, profileId);
        const previous = state.users[userId].progress[profileId]?.[identity.key];
        // A final keepalive update may arrive before an earlier heartbeat.
        if (previous?.playbackId === playbackId && previous.sequence >= sequence) return publicProgress(previous);
        const next = structuredClone(state), records = next.users[userId].progress[profileId] ||= {};
        const entry = {
          ...identity,
          title: (typeof input.title === 'string' && input.title.trim().slice(0, 300)) || previous?.title || `${identity.type === 'tv' ? 'Series' : 'Movie'} ${identity.id}`,
          backdrop_path: artwork(input.backdrop_path) || previous?.backdrop_path || null,
          poster_path: artwork(input.poster_path) || previous?.poster_path || null,
          position: Math.min(position, duration), duration,
          completed: input.ended === true || position / duration >= .95,
          updatedAt: Math.max(Date.now(), ...Object.values(records).map(record => record.updatedAt + 1)),
          playbackId, sequence,
        };
        records[identity.key] = entry;
        for (const old of Object.values(records).sort((a, b) => b.updatedAt - a.updatedAt).slice(500)) delete records[old.key];
        await persist(next);
        return publicProgress(entry);
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}

export const watchProgressStore = createWatchProgressStore(dataDirectory);
