const storageKey = 'watchlocal.update-repair';
const finished = state => ['complete', 'error', 'cancelled'].includes(state);

export function createRepairTerminal({ api, reload = () => location.reload() }) {
  let dialog, session, status, polling, opening = false, lastPrompt = 0;
  try { session = JSON.parse(sessionStorage.getItem(storageKey)); } catch {}
  if (session && (!/^[a-f0-9]{32}$/.test(session.id) || !session.token || Date.now() - session.started > 35 * 60_000)) session = null;
  const save = () => { try { session ? sessionStorage.setItem(storageKey, JSON.stringify(session)) : sessionStorage.removeItem(storageKey); } catch {} };
  const el = selector => dialog.querySelector(selector);
  async function request(suffix = '', options = {}) {
    const response = await fetch(`/ui/updates/repair/${session.id}${suffix}`, { ...options, cache: 'no-store', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json', 'X-Watchlocal-Repair': session.token }, body: options.body ? JSON.stringify(options.body) : undefined });
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.error || 'Repair request failed.'), { status: response.status });
    return value;
  }
  function render(value) {
    status = value;
    el('[data-repair-status]').textContent = value.message;
    const log = el('pre'), nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = value.output || 'Repair automatic updates\n';
    if (nearBottom) log.scrollTop = log.scrollHeight;
    const waiting = value.state === 'authenticating' && value.waitingForPassword;
    el('form').hidden = !waiting;
    el('[data-repair-user]').textContent = `Sudo password for ${value.username || 'the server user'}`;
    el('[data-repair-close]').textContent = waiting ? 'Cancel' : finished(value.state) ? 'Close' : 'Keep browsing';
    el('[data-repair-reload]').hidden = value.state !== 'complete';
    if (waiting && value.prompt !== lastPrompt) {
      lastPrompt = value.prompt; el('input').value = ''; el('[type=submit]').disabled = false;
      if (dialog.open) el('input').focus({ preventScroll: true });
    }
    if (finished(value.state)) { clearTimeout(polling); try { sessionStorage.removeItem(storageKey); } catch {} }
  }
  async function poll() {
    clearTimeout(polling); if (!session || finished(status?.state)) return;
    if (Date.now() - session.started > 35 * 60_000) { render({ state: 'error', message: 'Repair has timed out. Check the server’s update service before trying again.', output: status?.output }); return; }
    try { render(await request()); }
    catch (error) {
      if ([403,404].includes(error.status)) { render({ state: 'error', message: error.message, output: status?.output }); return; }
      el('[data-repair-status]').textContent = 'Reconnecting… The repair continues on the server while watch.local restarts.';
    }
    if (!finished(status?.state)) polling = setTimeout(poll, status?.state === 'authenticating' ? 750 : 2000);
  }
  async function close() {
    if (opening) return;
    el('input').value = '';
    if (session && status?.state === 'authenticating' && status.waitingForPassword) {
      try { await request('', { method: 'DELETE' }); } catch {}
      clearTimeout(polling); session = null; status = null; save();
    }
    if (finished(status?.state)) { session = null; status = null; save(); }
    dialog.close();
  }
  function elements() {
    if (dialog) return;
    dialog = document.createElement('dialog'); dialog.id = 'repair-terminal'; dialog.setAttribute('aria-labelledby', 'repair-terminal-title');
    dialog.innerHTML = `<header><div><small>SERVER TERMINAL</small><h2 id="repair-terminal-title" tabindex="-1" autofocus>Repair automatic updates</h2></div></header>
      <p class="dialog-copy">Installs and enables the boot updater, checks for updates and restarts watch.local. Playback will stop briefly. Use the server’s Linux password.</p>
      <p class="repair-http" hidden>This page uses HTTP. Your sudo password is not encrypted in transit. Use HTTPS if you don’t trust this network.</p>
      <pre tabindex="0" aria-label="Repair progress">Opening the repair terminal…</pre>
      <p data-repair-status role="status" aria-live="polite"></p>
      <form hidden autocomplete="off"><label class="field"><span data-repair-user>Sudo password</span><input type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="512" required aria-label="Server sudo password"></label><button class="btn primary" type="submit">Authenticate &amp; repair</button><small>Your password is not saved or shown in the terminal.</small></form>
      <a class="text-link repair-help" hidden href="https://github.com/JackHars/watch.local#automatic-updates" target="_blank" rel="noopener noreferrer">View host setup instructions</a>
      <div class="actions"><button class="btn ghost" type="button" data-repair-close>Close</button><button class="btn primary" type="button" data-repair-reload hidden>Reload watch.local</button></div>`;
    document.body.append(dialog);
    el('.repair-http').hidden = location.protocol === 'https:';
    el('[data-repair-close]').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    el('[data-repair-reload]').onclick = () => { session = null; save(); reload(); };
    el('form').onsubmit = async event => {
      event.preventDefault();
      const password = el('input').value; el('input').value = ''; el('[type=submit]').disabled = true;
      try {
        await request('/password', { method: 'POST', body: { password, prompt: status.prompt } });
        el('form').hidden = true; el('[data-repair-status]').textContent = 'Authenticating with sudo…';
        await poll();
      } catch (error) { el('[data-repair-status]').textContent = error.message; el('[type=submit]').disabled = false; }
    };
  }
  return {
    get active() { return opening || Boolean(session && !finished(status?.state)); },
    async open() {
      elements(); if (dialog.open) return; dialog.showModal();
      if (session) { poll(); return; }
      opening = true; status = null; lastPrompt = 0;
      el('[data-repair-close]').disabled = true; el('.repair-help').hidden = true;
      el('form').hidden = true; el('[data-repair-reload]').hidden = true;
      el('pre').textContent = 'Checking this installation…\n';
      el('[data-repair-status]').textContent = 'Connecting to the server…';
      try {
        const availability = await api('updates/repair');
        if (!availability.supported) { el('.repair-help').hidden = false; throw Error(availability.message); }
        session = { ...await api('updates/repair', { method: 'POST', body: {} }), started: Date.now() }; save();
        await poll();
      } catch (error) { render({ state: 'error', message: error.message, output: 'Repair has not started.\n' }); }
      finally { opening = false; el('[data-repair-close]').disabled = false; }
    },
  };
}
