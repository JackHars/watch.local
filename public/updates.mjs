// Only administrators see restart requests, and never over active playback or
// another dialog. A new Git checkout is distinct from a running server update.
export function createUpdatePrompt({ api, ready, busy, restarted = () => location.reload() }) {
  let dialog, dismissed, requested, polling, checking = false, lastCheck = 0;
  function elements() {
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'update-dialog'; dialog.setAttribute('aria-labelledby','update-dialog-title');
      dialog.innerHTML = '<header><h2 id="update-dialog-title" tabindex="-1" autofocus>Update available</h2></header><p class="dialog-copy" role="status"></p><div class="actions"><button class="btn ghost" type="button" data-update-later>Later</button><button class="btn primary" type="button" data-update-restart>Restart now</button></div>';
      document.body.append(dialog);
      const dismiss = () => { dismissed = dialog.dataset.revision; dialog.close(); };
      dialog.querySelector('[data-update-later]').onclick = dismiss;
      dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
      dialog.querySelector('[data-update-restart]').onclick = async () => {
        if (!ready() || requested) return;
        const button = dialog.querySelector('[data-update-restart]'); button.disabled = true;
        try {
          await api('updates/restart', { method:'POST', body:{} });
          requested = dialog.dataset.revision;
          dialog.querySelector('.dialog-copy').textContent = 'Restart requested. The updater will prepare the update within a minute. Playback will stop briefly.';
          dialog.querySelector('[data-update-later]').textContent = 'Keep browsing';
          poll();
        } catch (error) { dialog.querySelector('.dialog-copy').textContent = error.message; button.disabled = false; }
      };
    }
    return dialog;
  }
  async function poll() {
    clearTimeout(polling); if (!requested) return;
    try {
      const health = await fetch('/health', { cache:'no-store' }).then(r => r.json());
      if (health.application === 'watchlocal' && health.ok && health.revision === requested) { requested = null; restarted(); return; }
      const status = await api('updates');
      if (['error','recovery_needed','rolled_back','checks_failed'].includes(status.state)) {
        requested = null;
        dialog.querySelector('.dialog-copy').textContent = status.message;
        dialog.querySelector('[data-update-restart]').disabled = !status.canRestart;
        dialog.querySelector('[data-update-later]').textContent = 'Close';
        return;
      }
      if (status.message && ['preparing','installing','restarting','waiting_checks'].includes(status.state)) dialog.querySelector('.dialog-copy').textContent = status.message;
    } catch { /* The application is expected to disconnect during a restart. */ }
    polling = setTimeout(poll, 3000);
  }
  function consider(status, force = false) {
    if (!ready() || requested || !status.canRestart || (!force && dismissed === status.current) || busy() || dialog?.open) return;
    const box = elements(); box.dataset.revision = status.current;
    box.querySelector('.dialog-copy').textContent = 'Updated code is installed, but this server is still running the previous version. Restart now to finish applying it. Playback will stop briefly.';
    box.querySelector('[data-update-restart]').disabled = false;
    box.querySelector('[data-update-later]').textContent = 'Later';
    box.showModal();
  }
  async function check() {
    if (!ready() || document.hidden || checking || Date.now() - lastCheck < 60_000) return;
    checking = true; lastCheck = Date.now();
    try { consider(await api('updates')); } catch { /* Settings contains diagnostics if the agent is unavailable. */ }
    finally { checking = false; }
  }
  setInterval(check, 60_000);
  document.addEventListener('visibilitychange', check);
  return { check, consider };
}
