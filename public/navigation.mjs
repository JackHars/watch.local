// The layered backdrop/rim treatment is adapted from rdev/liquid-glass-react
// (MIT). See THIRD_PARTY_NOTICES.md. Content stays outside the filtered layer.
const svgNS = 'http://www.w3.org/2000/svg';
const mapCache = new Map();

function lensMap(width, height) {
  const key = `${width}x${height}`;
  if (mapCache.has(key)) return mapCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const pixels = context.createImageData(width, height);
  const radius = height / 2;
  // The nearest point on a capsule's center line gives the curved rim normal.
  // Only the outer 8px bends; the center stays undistorted and readable.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const cx = Math.max(radius, Math.min(width - radius, x + .5));
    const dx = x + .5 - cx, dy = y + .5 - radius;
    const distance = Math.hypot(dx, dy), inset = radius - distance;
    const edge = Math.max(0, Math.min(1, 1 - inset / 8));
    const bend = inset < 0 ? 0 : edge * edge * (3 - 2 * edge) * .42;
    const offset = (y * width + x) * 4;
    pixels.data[offset] = 128 + (distance ? dx / distance : 0) * bend * 255;
    pixels.data[offset + 1] = 128 + (distance ? dy / distance : 0) * bend * 255;
    pixels.data[offset + 2] = 128;
    pixels.data[offset + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const result = canvas.toDataURL();
  if (mapCache.size >= 12) mapCache.delete(mapCache.keys().next().value);
  mapCache.set(key, result);
  return result;
}

export function createNavigation() {
  const mobile = matchMedia('(max-width:700px)');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const reduceTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
  // SVG backdrop refraction is a Chromium enhancement. Safari/Firefox retain
  // the live CSS blur, tint and rim rather than losing the entire backdrop.
  const refraction = /Chrome|Chromium|Edg\//.test(navigator.userAgent)
    && !/CriOS|EdgiOS/.test(navigator.userAgent)
    && CSS.supports('backdrop-filter', 'url(#glass)');
  let header, dock, observer, lastY = 0, travel = 0, frame = 0;
  let selected = -1, lastWidth = 0;

  const scrollY = () => Math.max(0, Math.min(window.scrollY,
    Math.max(0, document.documentElement.scrollHeight - window.innerHeight)));
  function showHeader() {
    header?.classList.remove('is-hidden');
    lastY = scrollY(); travel = 0;
  }
  function onScroll() {
    frame = 0;
    const y = scrollY(), delta = y - lastY;
    lastY = y;
    if (!header?.isConnected || document.querySelector('dialog[open]')) return;
    if (y < 80 || (document.documentElement.dataset.input !== 'touch' && header.querySelector(':focus-visible'))) return showHeader();
    if (Math.sign(delta) !== Math.sign(travel)) travel = 0;
    travel += delta;
    if (travel > 18) { header.classList.add('is-hidden'); travel = 0; }
    if (travel < -10) showHeader();
  }
  window.addEventListener('scroll', () => {
    if (!frame) frame = requestAnimationFrame(onScroll);
  }, { passive: true });
  document.addEventListener('focusin', event => {
    if (header?.contains(event.target)) showHeader();
  });

  function updateGlass() {
    if (!dock?.isConnected) return;
    const enabled = mobile.matches && refraction && !reduceTransparency.matches;
    dock.classList.toggle('has-refraction', enabled);
    if (!enabled) return;
    dock.querySelectorAll('[data-glass]').forEach(surface => {
      const width = Math.round(surface.clientWidth), height = Math.round(surface.clientHeight);
      if (!width || !height) return;
      const filter = dock.querySelector(`#${surface.dataset.glass}`);
      const map = lensMap(width, height);
      if (!filter || !map) return;
      filter.setAttribute('width', width + 24);
      filter.setAttribute('height', height + 24);
      const image = filter.querySelector('feImage');
      image.setAttribute('width', width);
      image.setAttribute('height', height);
      image.setAttribute('href', map);
    });
  }
  function positionSelection(animate = false) {
    const tabs = dock?.querySelector('.dock-tabs');
    if (!tabs || !mobile.matches) return;
    const links = [...tabs.querySelectorAll('a')];
    const next = links.findIndex(link => link.hasAttribute('aria-current'));
    const marker = tabs.querySelector('.dock-selection');
    const width = (tabs.clientWidth - 8) / 4;
    marker.style.width = `${width}px`;
    marker.style.opacity = next < 0 ? '0' : '1';
    marker.style.transform = `translateX(${Math.max(0, next) * width}px)`;
    if (animate && selected >= 0 && next >= 0 && next !== selected && width === lastWidth && !reduceMotion.matches) {
      marker.animate([
        { transform: `translateX(${selected * width}px) scaleX(1)` },
        { transform: `translateX(${(selected + next) * width / 2}px) scaleX(1.12)`, offset: .5 },
        { transform: `translateX(${next * width}px) scaleX(1)` },
      ], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    selected = next; lastWidth = width;
  }
  function layout() { positionSelection(); updateGlass(); }
  mobile.addEventListener('change', () => { layout(); showHeader(); });
  reduceTransparency.addEventListener('change', updateGlass);
  window.addEventListener('resize', layout, { passive: true });

  return {
    mount() {
      observer?.disconnect();
      header = document.querySelector('.topbar');
      dock = document.querySelector('.mobile-dock');
      showHeader();
      if (!dock) return;
      if (refraction) {
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('class', 'glass-filters');
        svg.setAttribute('aria-hidden', 'true');
        svg.innerHTML = `<defs>${['dock-lens', 'search-lens'].map(id => `<filter id="${id}" x="-12" y="-12" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feImage x="0" y="0" preserveAspectRatio="none" result="lens"/><feDisplacementMap in="SourceGraphic" in2="lens" scale="18" xChannelSelector="R" yChannelSelector="G"/></filter>`).join('')}</defs>`;
        dock.append(svg);
      }
      positionSelection(true); updateGlass();
      observer = new ResizeObserver(() => { positionSelection(); updateGlass(); });
      dock.querySelectorAll('[data-glass]').forEach(surface => observer.observe(surface));
    },
  };
}
