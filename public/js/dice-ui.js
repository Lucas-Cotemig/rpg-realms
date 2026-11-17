// Desenho e animação dos dados (o resultado SEMPRE vem do servidor;
// a animação só mostra números aleatórios de enfeite enquanto gira).
import { esc } from './util.js';

const SHAPES = {
  4: '<polygon class="face" points="50,6 95,90 5,90"/>',
  6: '<rect class="face" x="10" y="10" width="80" height="80" rx="12"/>',
  8: '<polygon class="face" points="50,3 96,50 50,97 4,50"/><path d="M4 50 L96 50" stroke="#d9ad52" stroke-width="1.2" opacity=".45"/>',
  10: '<polygon class="face" points="50,3 94,40 50,97 6,40"/><path d="M6 40 L50 58 L94 40 M50 58 L50 97" stroke="#d9ad52" stroke-width="1.2" opacity=".45" fill="none"/>',
  12: '<polygon class="face" points="50,4 95,37 78,93 22,93 5,37"/><polygon points="50,24 73,41 64,70 36,70 27,41" fill="none" stroke="#d9ad52" stroke-width="1.2" opacity=".45"/>',
  20: '<polygon class="face" points="50,3 93,27 93,73 50,97 7,73 7,27"/><polygon points="50,22 76,66 24,66" fill="none" stroke="#d9ad52" stroke-width="1.2" opacity=".45"/>',
  100: '<circle class="face" cx="50" cy="50" r="45"/><circle cx="50" cy="50" r="33" fill="none" stroke="#d9ad52" stroke-width="1.2" opacity=".4"/>',
};
const CUSTOM = '<polygon class="face" points="30,5 70,5 95,30 95,70 70,95 30,95 5,70 5,30"/>';

export function shapeSvg(sides) {
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${SHAPES[sides] || CUSTOM}</svg>`;
}

export function pickerIcon(sides) {
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${(SHAPES[sides] || CUSTOM).replace(/class="face"/, 'class="pic"')}</svg>`;
}

function dieEl(sides, value, neg) {
  const d = document.createElement('div');
  d.className = 'die' + (neg ? ' neg' : '');
  d.innerHTML = `${shapeSvg(sides)}<span class="num">${value}</span><span class="tag">d${sides}</span>`;
  return d;
}

let animTimer = null;

export function animateRoll(tray, roll, meId) {
  const diceBox = tray.querySelector('.tray-dice');
  const caption = tray.querySelector('.tray-caption');
  clearInterval(animTimer);
  tray.querySelectorAll('.burst').forEach((b) => b.remove());
  diceBox.innerHTML = '';
  caption.innerHTML = `<div class="tray-who">${esc(roll.displayName)} está rolando ${esc(roll.expression)}…</div>`;

  const MAX_SHOW = 16;
  const items = [];
  for (const t of roll.terms) for (const v of t.results) items.push({ sides: t.sides, value: v, neg: t.sign < 0 });
  const shown = items.slice(0, MAX_SHOW);
  const els = shown.map((it) => {
    const e = dieEl(it.sides, '?', it.neg);
    e.classList.add('rolling');
    e.style.animationDuration = (0.22 + Math.random() * 0.14) + 's';
    diceBox.appendChild(e);
    return e;
  });

  animTimer = setInterval(() => {
    els.forEach((e, i) => { e.querySelector('.num').textContent = 1 + Math.floor(Math.random() * shown[i].sides); });
  }, 70);

  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => {
    clearInterval(animTimer);
    const singleD20 = items.length === 1 && items[0].sides === 20;
    els.forEach((e, i) => {
      e.classList.remove('rolling');
      e.classList.add('settle');
      e.querySelector('.num').textContent = shown[i].value;
      if (shown[i].sides === 20 && shown[i].value === 20) e.classList.add('crit');
      if (shown[i].sides === 20 && shown[i].value === 1) e.classList.add('fail');
    });
    let note = '';
    if (singleD20 && items[0].value === 20) { note = ' — <b style="color:#fde68a">ACERTO CRÍTICO!</b>'; tray.appendChild(Object.assign(document.createElement('div'), { className: 'burst' })); }
    else if (singleD20 && items[0].value === 1) { note = ' — <b style="color:#fca5a5">FALHA CRÍTICA!</b>'; tray.appendChild(Object.assign(document.createElement('div'), { className: 'burst red' })); }
    else tray.appendChild(Object.assign(document.createElement('div'), { className: 'burst' }));
    const extra = items.length > MAX_SHOW ? ` <span class="small">(+${items.length - MAX_SHOW} dados não exibidos)</span>` : '';
    caption.innerHTML = `<div class="tray-total">${roll.total}</div>
      <div class="tray-who">${esc(roll.displayName)}${roll.userId === meId ? ' (você)' : ''} · ${esc(roll.expression)}${roll.label ? ' · ' + esc(roll.label) : ''}${note}${extra}</div>`;
  }, reduce ? 150 : 1100);
}

export function breakdown(roll) {
  const parts = roll.terms.map((t, i) => `${t.sign < 0 ? '− ' : i ? '+ ' : ''}[${t.results.join(', ')}]`);
  if (roll.modifier) parts.push(`${roll.modifier < 0 ? '−' : '+'} ${Math.abs(roll.modifier)}`);
  return parts.join(' ');
}

export function critClass(roll) {
  const all = roll.terms.flatMap((t) => t.results.map((v) => ({ v, s: t.sides })));
  if (all.length === 1 && all[0].s === 20) return all[0].v === 20 ? 'crit' : all[0].v === 1 ? 'fail' : '';
  return '';
}
