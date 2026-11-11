export const homeCategories = [
  { type: 'movie', board: 'now_playing', label: 'New Release Movies', subtitle: 'The latest films in cinemas.' },
  { type: 'tv', board: 'trending', label: 'Trending Shows', subtitle: 'Shows trending on TMDB today.' },
  { type: 'movie', board: 'trending', label: 'Trending Movies', subtitle: 'Movies trending on TMDB today.' },
  { type: 'tv', board: 'on_the_air', label: 'On TV This Week', subtitle: 'Shows airing episodes over the next seven days.' },
  { type: 'movie', board: 'top_rated', label: 'Top-Rated Movies', subtitle: 'Acclaimed live-action films.', poster: true },
  { type: 'tv', board: 'top_rated', label: 'Top-Rated Shows', subtitle: 'Acclaimed live-action series.', poster: true },
];

export function featuredItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.type}:${item.id}`;
    if (!['movie','tv'].includes(item.type) || !item.id || item.adult || !item.backdrop_path || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 10);
}

export function mountHeroCarousel(root) {
  const track = root.querySelector('.featured-track');
  const slides = [...root.querySelectorAll('[data-slide]')];
  const dots = [...root.querySelectorAll('[data-carousel-index]')];
  const toggle = root.querySelector('[data-carousel-toggle]');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const events = new AbortController();
  let index = 0, timer, jumpFrame, stopped = false, inView = true, hovered = false, touch = null;
  let paused = reducedMotion.matches;
  const on = (target, event, callback, options = {}) => target.addEventListener(event, callback, { ...options, signal: events.signal });
  const loadArt = slide => {
    const image = slide?.querySelector('img[data-src]');
    if (image) { image.src = image.dataset.src; delete image.dataset.src; }
  };
  function schedule() {
    clearTimeout(timer);
    if (stopped || slides.length < 2 || paused || !inView || hovered || touch || document.hidden || root.matches(':focus-within') || document.querySelector('dialog[open]')) return;
    timer = setTimeout(() => show(index + 1), 5000);
  }
  function updateToggle() {
    if (!toggle) return;
    toggle.setAttribute('aria-label', paused ? 'Play slideshow' : 'Pause slideshow');
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.querySelector('path').setAttribute('d', paused ? 'm8 5 11 7-11 7Z' : 'M8 5v14M16 5v14');
  }
  function show(next) {
    if (stopped) return;
    const wrapping = next < 0 || next >= slides.length;
    index = (next + slides.length) % slides.length;
    cancelAnimationFrame(jumpFrame);
    // Do not sweep back across nine titles at the end of the loop.
    track.classList.toggle('is-jumping', wrapping);
    track.style.transform = `translate3d(${-index * 100}%,0,0)`;
    if (wrapping) jumpFrame = requestAnimationFrame(() => { jumpFrame = requestAnimationFrame(() => track.classList.remove('is-jumping')); });
    root.dataset.index = String(index);
    slides.forEach((slide, n) => {
      slide.inert = n !== index;
      slide.setAttribute('aria-hidden', String(n !== index));
      if (n === index) dots[n]?.setAttribute('aria-current', 'true');
      else dots[n]?.removeAttribute('aria-current');
    });
    loadArt(slides[index]);
    loadArt(slides[(index + 1) % slides.length]);
    schedule();
  }
  on(root, 'click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-carousel-index')) show(Number(button.dataset.carouselIndex));
    if (button.hasAttribute('data-carousel-step')) show(index + Number(button.dataset.carouselStep));
    if (button === toggle) { paused = !paused; updateToggle(); schedule(); }
  });
  on(root, 'pointerenter', event => { if (event.pointerType === 'mouse' && matchMedia('(hover:hover)').matches) { hovered = true; schedule(); } });
  on(root, 'pointerleave', () => { hovered = false; schedule(); });
  on(root, 'focusin', schedule);
  on(root, 'focusout', () => queueMicrotask(schedule));
  on(root, 'pointerdown', event => {
    if (event.pointerType === 'mouse' || event.target.closest('button,a,input,select')) return;
    touch = { id: event.pointerId, x: event.clientX, y: event.clientY };
    schedule();
  }, { passive: true });
  on(root, 'pointerup', event => {
    if (!touch || touch.id !== event.pointerId) return;
    const dx = event.clientX - touch.x, dy = event.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) show(index + (dx < 0 ? 1 : -1));
    else schedule();
  }, { passive: true });
  on(root, 'pointercancel', () => { touch = null; schedule(); }, { passive: true });
  on(document, 'visibilitychange', schedule);
  on(window, 'pageshow', schedule);
  on(window, 'pagehide', () => clearTimeout(timer));
  on(reducedMotion, 'change', () => { if (reducedMotion.matches) paused = true; updateToggle(); schedule(); });
  const visibility = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting && entry.intersectionRatio >= .2; schedule(); }, { threshold: [0,.2] });
  visibility.observe(root);
  const dialogs = new MutationObserver(schedule);
  document.querySelectorAll('dialog').forEach(dialog => dialogs.observe(dialog, { attributes: true, attributeFilter: ['open'] }));
  updateToggle(); show(0);
  return { destroy() { stopped = true; clearTimeout(timer); cancelAnimationFrame(jumpFrame); events.abort(); visibility.disconnect(); dialogs.disconnect(); } };
}
