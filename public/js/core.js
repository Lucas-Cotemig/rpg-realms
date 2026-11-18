// Núcleo: configuração, sessão (Supabase Auth), API e conexão em tempo real
import { toast } from './util.js';

export const state = { cfg: null, sb: null, session: null, me: null, socket: null, universes: [] };

const DEV_KEY = 'rr_dev_user';

export async function initCore(onAuthChange) {
  state.cfg = await fetch('/api/config').then((r) => r.json());
  if (state.cfg.devAuth) {
    try { state.session = JSON.parse(localStorage.getItem(DEV_KEY) || 'null'); } catch { state.session = null; }
    return;
  }
  if (!state.cfg.supabaseUrl) throw new Error('Servidor sem configuração do Supabase');
  state.sb = window.supabase.createClient(state.cfg.supabaseUrl, state.cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const { data } = await state.sb.auth.getSession();
  state.session = data.session;
  state.sb.auth.onAuthStateChange((event, session) => {
    const had = !!state.session;
    state.session = session;
    if (event === 'PASSWORD_RECOVERY') onAuthChange('recovery');
    else if (event === 'SIGNED_OUT' || (had && !session)) onAuthChange('out');
    else if (event === 'SIGNED_IN' && !had) onAuthChange('in');
  });
}

export function token() {
  if (!state.session) return null;
  if (state.cfg.devAuth) return `dev:${state.session.id}:${state.session.name}`;
  return state.session.access_token;
}

export function devLogin(name) {
  const id = localStorage.getItem(DEV_KEY + '_id_' + name) || crypto.randomUUID();
  localStorage.setItem(DEV_KEY + '_id_' + name, id);
  state.session = { id, name };
  localStorage.setItem(DEV_KEY, JSON.stringify(state.session));
}

export async function logout() {
  disconnectSocket();
  state.me = null;
  if (state.cfg.devAuth) { localStorage.removeItem(DEV_KEY); state.session = null; return; }
  await state.sb.auth.signOut();
  state.session = null;
}

export async function api(method, path, body, retried = false) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && state.sb && !retried) {
    const { data } = await state.sb.auth.refreshSession();
    if (data.session) { state.session = data.session; return api(method, path, body, true); }
  }
  let data = null;
  try { data = await r.json(); } catch { /* sem corpo */ }
  if (!r.ok) {
    const err = new Error((data && data.error) || 'Falha na comunicação com o servidor');
    err.status = r.status;
    throw err;
  }
  return data;
}

export async function loadMe() {
  state.me = await api('GET', '/api/me');
  return state.me;
}

export async function loadUniverses() {
  if (!state.universes.length) state.universes = await fetch('/api/universes').then((r) => r.json());
  return state.universes;
}
export const universe = (id) => state.universes.find((u) => u.id === id) || { name: id, color: '#d9ad52', glyph: '✦', description: '' };

export function getSocket() {
  if (state.socket) return state.socket;
  const s = window.io({ auth: (cb) => cb({ token: token() }), transports: ['websocket', 'polling'] });
  const bar = document.getElementById('conn');
  let wasConnected = false;
  s.on('connect', () => { bar.classList.add('hidden'); wasConnected = true; });
  s.on('disconnect', () => { if (wasConnected) bar.classList.remove('hidden'); });
  s.on('connect_error', async (e) => {
    if (e.message === 'nao_autenticado' && state.sb) {
      const { data } = await state.sb.auth.refreshSession();
      if (data.session) { state.session = data.session; setTimeout(() => s.connect(), 500); return; }
      toast('Sua sessão expirou. Entre novamente.', 'err');
    }
    bar.classList.remove('hidden');
  });
  state.socket = s;
  return s;
}

export function disconnectSocket() {
  if (state.socket) { state.socket.disconnect(); state.socket = null; }
}

export function emit(event, payload) {
  return new Promise((resolve) => {
    const s = getSocket();
    s.timeout(10000).emit(event, payload, (err, res) => {
      if (err) resolve({ error: 'Sem resposta do servidor. Verifique sua conexão.' });
      else resolve(res || {});
    });
  });
}

export async function loadRules() {
  if (!state.rules) state.rules = await fetch('/api/rules/paranormal').then((r) => r.json());
  return state.rules;
}

// Mesmo cálculo do servidor, só para mostrar a prévia enquanto a ficha é editada
export function previewDerived(d, rules) {
  const c = rules.classes[d.classe] || rules.classes.combatente;
  const n = Math.max(1, rules.nex.indexOf(Number(d.nex)) + 1);
  const a = d.atributos;
  const prot = (d.inventario || []).filter((i) => i.equipado && i.tipo === 'protecao').reduce((s, i) => s + (Number(i.defesa) || 0), 0);
  return {
    pvMax: Math.max(1, c.pv[0] + a.vig + (n - 1) * (c.pv[1] + a.vig)),
    peMax: Math.max(0, c.pe[0] + a.pre + (n - 1) * (c.pe[1] + a.pre)),
    sanMax: c.san[0] + (n - 1) * c.san[1],
    defesa: 10 + a.agi + prot,
  };
}
