// A failed write leaves the original intact, so storage limits cannot lose it.
export function migratedPreference(key, legacyKeys = []) {
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;
    for (const legacy of legacyKeys) {
      const value = localStorage.getItem(legacy);
      if (value === null) continue;
      try { localStorage.setItem(key, value); for (const old of legacyKeys) localStorage.removeItem(old); }
      catch { /* Return the original even when migration cannot be persisted. */ }
      return value;
    }
  } catch { /* Browsing still works with storage disabled. */ }
  return null;
}

export function watchlistPreference(userId, profileId, migrateAccount = false) {
  const legacy = [`freeiptv.list.${userId}.${profileId}`];
  if (migrateAccount) legacy.push(`watchlocal.list.${userId}`, `freeiptv.list.${userId}`);
  try {
    const list = JSON.parse(migratedPreference(`watchlocal.list.${userId}.${profileId}`, legacy) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
