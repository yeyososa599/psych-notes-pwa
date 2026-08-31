// Kleine, afhankelijkheidsvrije hulpfuncties. Bewust geen npm-package:
// minder toeleveringsketen-risico voor een app die medische data verwerkt.

export function uuid() {
  // crypto.randomUUID() is beschikbaar in alle moderne browsers binnen een
  // secure context (https / localhost), wat een PWA sowieso vereist.
  return crypto.randomUUID();
}

export function formatDateTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString('nl-NL', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
