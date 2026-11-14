// Startup must have a deadline even when headers arrive but the JSON body
// stalls. Avoid AbortSignal.timeout/any so older mobile browsers can recover.
export async function fetchJSON(url, { timeoutMs = 0, ...options } = {}, fetchResource = fetch) {
  let timer, abort;
  const caller = options.signal;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const read = async () => {
    const response = await fetchResource(url, { ...options, ...(controller ? { signal: controller.signal } : {}) });
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (controller?.signal.aborted || caller?.aborted) throw error;
      throw Error('The server returned an unreadable response. Try again, or restart watch.local if it was just updated.');
    }
    return { response, data };
  };
  if (!controller) return read();
  const cancelled = new Promise((_, reject) => {
    abort = () => {
      const error = caller.reason || Object.assign(Error('Request cancelled.'), { name: 'AbortError' });
      reject(error); controller.abort();
    };
    if (caller?.aborted) { abort(); return; }
    caller?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      reject(Error('The server took too long to respond. Check that watch.local is running, then try again.'));
      controller.abort();
    }, timeoutMs);
  });
  try { return await Promise.race([cancelled, read()]); }
  finally { clearTimeout(timer); caller?.removeEventListener('abort', abort); }
}
