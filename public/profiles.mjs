import { migratedPreference } from './preferences.mjs';
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);
const plus = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const person = '<svg class="profile-person" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle cx="32" cy="21" r="11"/><path d="M12 54c0-10.8 8.3-17.5 20-17.5S52 43.2 52 54c0 2.4-1.6 4-4 4H16c-2.4 0-4-1.6-4-4Z"/></svg>';
const colors = [['Blue','#527de0'],['Purple','#8952c7'],['Rose','#c9487c'],['Red','#d54e46'],['Orange','#ca752b'],['Green','#27865f'],['Teal','#25869a'],['Silver','#8190a4']];

// Remember a choice on this browser, separately for each signed-in account.
// The caller still checks the ID against the server's current profile list.
export function rememberedProfileId(userId) {
  return migratedPreference('watchlocal.profile.' + userId, ['freeiptv.profile.' + userId]);
}

export function rememberProfile(userId, profileId) {
  try {
    const key = 'watchlocal.profile.' + userId;
    if (profileId) localStorage.setItem(key, profileId);
    else localStorage.removeItem(key);
    localStorage.removeItem('freeiptv.profile.' + userId);
  } catch { /* Browsing still works when storage is blocked or full. */ }
}

export function profileStyle(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color || '')) color = colors[0][1];
  const [red, green, blue] = color.slice(1).match(/../g).map(value => parseInt(value, 16));
  const ink = (red * 299 + green * 587 + blue * 114) / 1000 > 160 ? '#15161a' : '#ffffff';
  return `--profile-color:${color};--profile-ink:${ink}`;
}

export function profileAvatar(profile) {
  return `<span class="profile-picture" style="${profileStyle(profile.color)}">${person}</span>`;
}

export function profilePicker(profiles, { loading = false, error = '' } = {}) {
  return `<main class="profiles-page" id="main" tabindex="-1">
    <header class="profiles-header"><img class="brand-mark" src="/brand.svg" alt="watch.local" width="422" height="72"><button class="icon-btn profile-add" data-action="add-profile" aria-label="Add profile" title="Add profile" ${loading?'disabled':''}>${plus}</button></header>
    <section class="profiles-content" aria-labelledby="profiles-title"><h1 id="profiles-title">Who’s watching?</h1><p class="profiles-intro">${profiles.length?'Choose your profile to pick up where you left off.':'Create a profile for your watch history and progress.'}</p>
      ${loading?'<div class="profiles-loading"><div class="spinner"></div><span class="sr-only">Loading profiles</span></div>':error?`<div class="profiles-empty"><p role="alert">${escape(error)}</p><button class="btn" data-action="reload">Try again</button></div>`:profiles.length?`<div class="profiles-grid">${profiles.map(profile=>`<button class="profile-card" data-action="select-profile" data-profile-id="${profile.id}" aria-label="Watch as ${escape(profile.name)}">${profileAvatar(profile)}<span class="profile-name">${escape(profile.name)}</span></button>`).join('')}</div>`:`<div class="profiles-empty"><p>Add your first profile to get started.</p><button class="btn primary" data-action="add-profile">${plus}Add profile</button></div>`}
    </section><button class="text-link profiles-account" data-action="logout">Switch account</button>
  </main>`;
}

export function openProfileDialog(dialog, { save, created }) {
  dialog.innerHTML = `<header><h2>Create profile</h2><button class="icon-btn" data-action="close-dialog" aria-label="Close"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header>
    <form id="profile-form"><div class="profile-preview">${profileAvatar({color:colors[0][1]})}</div>
      <label class="field"><span>Name</span><input name="name" id="profile-name" required maxlength="40" autocomplete="given-name" placeholder="Your name"></label>
      <fieldset class="profile-colors"><legend>Colour</legend><div class="profile-palette">${colors.map(([name,color],index)=>`<button type="button" class="profile-swatch" style="--profile-color:${color}" data-profile-color="${color}" aria-label="${name}" aria-pressed="${index===0}"></button>`).join('')}</div>
        <label class="profile-custom-color"><input type="color" name="color" value="${colors[0][1]}" aria-label="Custom colour"><span>Custom colour</span></label>
      </fieldset><p class="error" id="profile-error" role="alert"></p><div class="actions"><button class="btn ghost" type="button" data-action="close-dialog">Cancel</button><button class="btn primary" type="submit">Create profile</button></div>
    </form>`;
  const form = dialog.querySelector('form'), color = form.elements.color;
  const update = () => {
    dialog.querySelector('.profile-preview .profile-picture').setAttribute('style', profileStyle(color.value));
    form.querySelectorAll('[data-profile-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.profileColor === color.value)));
  };
  color.addEventListener('input', update);
  form.querySelectorAll('[data-profile-color]').forEach(button => button.addEventListener('click', () => { color.value = button.dataset.profileColor; update(); }));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    if (button.disabled) return;
    button.disabled = true; button.textContent = 'Creating…';
    form.querySelector('#profile-error').textContent = '';
    try {
      const profile = await save({ name: form.elements.name.value, color: color.value });
      if (form.isConnected) dialog.close();
      await created(profile);
    } catch (error) {
      if (form.isConnected) form.querySelector('#profile-error').textContent = error.message;
    } finally { button.disabled = false; button.textContent = 'Create profile'; }
  });
  dialog.showModal();
  form.elements.name.focus();
}
