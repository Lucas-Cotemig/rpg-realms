export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function html(strings, ...vals) {
  return strings.reduce((out, s, i) => out + s + (i < vals.length ? (vals[i] && vals[i].__raw !== undefined ? vals[i].__raw : esc(vals[i])) : ''), '');
}
export const raw = (s) => ({ __raw: String(s) });

export function el(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

export function toast(text, type = '') {
  const t = el(`<div class="toast ${type}">${esc(text)}</div>`);
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), type === 'err' ? 5000 : 3500);
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

export function timeStr(d) {
  const dt = new Date(d);
  const today = new Date();
  const hm = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (dt.toDateString() === today.toDateString()) return hm;
  return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
}

export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const h = randomHex(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function modal(markup, { narrow = false } = {}) {
  const back = el(`<div class="modal-back"><div class="modal panel ${narrow ? 'narrow' : ''}">${markup}</div></div>`);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  back.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  document.body.appendChild(back);
  const first = back.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
  return { root: back, close };
}

export function confirmBox(title, text, okLabel = 'Confirmar', danger = false) {
  return new Promise((resolve) => {
    const m = modal(html`<div class="panel-head"><h2>${title}</h2></div>
      <div class="panel-body"><p>${text}</p>
      <div class="row" style="justify-content:flex-end"><button data-close>Cancelar</button>
      <button class="${danger ? 'danger' : 'primary'}" data-ok>${okLabel}</button></div></div>`, { narrow: true });
    let done = false;
    m.root.querySelector('[data-ok]').addEventListener('click', () => { done = true; m.close(); resolve(true); });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.root)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.body, { childList: true });
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// Reduz uma imagem escolhida pelo usuário e devolve como data URL (mantém transparência com WEBP)
export function resizeImage(file, maxSide = 512, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { reject(new Error('Escolha uma imagem PNG, JPG ou WEBP')); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      let data = c.toDataURL('image/webp', quality);
      if (!data.startsWith('data:image/webp')) data = c.toDataURL('image/png');
      resolve({ dataUrl: data, width: w, height: h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não foi possível abrir a imagem')); };
    img.src = url;
  });
}
