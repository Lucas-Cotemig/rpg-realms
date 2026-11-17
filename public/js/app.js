import { $, $$, html, raw, el, esc, toast, modal, initials, timeStr } from './util.js';
import { state, initCore, devLogin, logout, api, loadMe, loadUniverses, universe } from './core.js';
import { mountTable } from './table.js';

const app = document.getElementById('app');
let cleanup = null;
const SIGIL = '<img class="sigil" src="/img/sigil.svg" alt="">';

export function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  route();
}
window.addEventListener('popstate', () => route());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.ctrlKey && !e.metaKey) { e.preventDefault(); navigate(a.getAttribute('href')); }
});

async function route() {
  if (cleanup) { try { cleanup(); } catch { /* */ } cleanup = null; }
  const path = location.pathname;
  window.scrollTo(0, 0);

  if (path === '/nova-senha') return viewNewPassword();
  const invite = /^\/entrar\/([A-Za-z0-9]{6})$/.exec(path);
  if (invite) sessionStorage.setItem('rr_invite', invite[1].toUpperCase());

  if (!state.session) return viewAuth();
  try {
    if (!state.me) await loadMe();
    await loadUniverses();
  } catch (e) {
    if (e.status === 401) { await logout(); return viewAuth(); }
    app.innerHTML = `<div class="loading"><div>Não foi possível falar com o servidor.<br><br><button onclick="location.reload()">Tentar de novo</button></div></div>`;
    return;
  }

  const pending = sessionStorage.getItem('rr_invite');
  if (pending) {
    sessionStorage.removeItem('rr_invite');
    try {
      const r = await api('POST', '/api/campaigns/join', { code: pending });
      return navigate(`/campanha/${r.id}`, true);
    } catch (e) { toast(e.message, 'err'); return navigate('/', true); }
  }

  const camp = /^\/campanha\/([0-9a-f-]{36})$/.exec(path);
  if (camp) { app.innerHTML = topbar() + '<div id="view"></div>'; bindTopbar(); cleanup = await mountTable($('#view'), camp[1], navigate); return; }
  if (path === '/universos') return viewUniverses();
  if (path === '/configuracoes') return viewSettings();
  if (path !== '/') return navigate('/', true);
  return viewHome();
}

// ================= LOGIN =================
function viewAuth(tab = 'entrar') {
  const dev = state.cfg.devAuth;
  app.innerHTML = html`<div class="auth-wrap"><div class="panel auth-card">
    <div class="auth-hero">${raw(SIGIL)}<h1>RPG Realms</h1><div class="muted">Sua mesa de RPG online, com os amigos, em tempo real.</div></div>
    ${raw(dev ? `<div class="stack"><div class="badge purple">Modo de teste local</div>
      <form id="devForm" class="stack"><div class="field"><label>Seu nome de teste</label><input name="name" maxlength="30" required></div>
      <button class="primary" style="width:100%">Entrar</button></form></div>` : `
    <div class="tabs"><button data-tab="entrar">Entrar</button><button data-tab="criar">Criar conta</button><button data-tab="esqueci">Esqueci a senha</button></div>
    <form id="authForm" class="stack" novalidate></form>`)}
  </div></div>`;
  if (dev) {
    $('#devForm').addEventListener('submit', (e) => { e.preventDefault(); devLogin(e.target.name.value.trim()); route(); });
    return;
  }
  const form = $('#authForm');
  const setTab = (t) => {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    const fields = {
      entrar: `<div class="field"><label>E-mail</label><input name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label>Senha</label><input name="password" type="password" autocomplete="current-password" required></div>`,
      criar: `<div class="field"><label>Seu nome na mesa</label><input name="name" maxlength="40" autocomplete="nickname" required></div>
        <div class="field"><label>E-mail</label><input name="email" type="email" autocomplete="email" required></div>
        <div class="field"><label>Senha (mínimo 6 caracteres)</label><input name="password" type="password" autocomplete="new-password" minlength="6" required></div>`,
      esqueci: `<p class="muted small">Digite seu e-mail. Vamos enviar um link para você criar uma nova senha.</p>
        <div class="field"><label>E-mail</label><input name="email" type="email" autocomplete="email" required></div>`,
    }[t];
    const label = { entrar: 'Entrar', criar: 'Criar minha conta', esqueci: 'Enviar link' }[t];
    form.dataset.tab = t;
    form.innerHTML = `${fields}<div class="error-text" id="authErr"></div><button class="primary" style="width:100%">${label}</button>`;
    form.querySelector('input').focus();
  };
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  setTab(tab);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = form.dataset.tab;
    const errBox = $('#authErr');
    const btn = form.querySelector('button');
    const f = Object.fromEntries(new FormData(form));
    errBox.textContent = '';
    if (!f.email || !/^\S+@\S+\.\S+$/.test(f.email)) { errBox.textContent = 'Digite um e-mail válido.'; return; }
    if (t !== 'esqueci' && (!f.password || f.password.length < 6)) { errBox.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; return; }
    if (t === 'criar' && (!f.name || f.name.trim().length < 2)) { errBox.textContent = 'Digite seu nome (pelo menos 2 letras).'; return; }
    btn.disabled = true;
    try {
      if (t === 'entrar') {
        const { error } = await state.sb.auth.signInWithPassword({ email: f.email, password: f.password });
        if (error) throw error;
        state.session = (await state.sb.auth.getSession()).data.session;
        route();
      } else if (t === 'criar') {
        const { data, error } = await state.sb.auth.signUp({ email: f.email, password: f.password, options: { data: { display_name: f.name.trim() }, emailRedirectTo: location.origin } });
        if (error) throw error;
        if (data.session) { state.session = data.session; route(); }
        else { form.innerHTML = '<p class="ok-text">Conta criada! Confira seu e-mail para confirmar o cadastro e depois entre.</p>'; }
      } else {
        const { error } = await state.sb.auth.resetPasswordForEmail(f.email, { redirectTo: location.origin + '/nova-senha' });
        if (error) throw error;
        form.innerHTML = '<p class="ok-text">Se esse e-mail tiver uma conta, você vai receber um link para criar uma nova senha. Confira também a caixa de spam.</p>';
      }
    } catch (err) {
      errBox.textContent = traduzErro(err.message);
      btn.disabled = false;
    }
  });
}

function traduzErro(m = '') {
  if (/Invalid login/i.test(m)) return 'E-mail ou senha incorretos.';
  if (/already registered|already exists/i.test(m)) return 'Este e-mail já tem conta. Use a aba Entrar.';
  if (/Email not confirmed/i.test(m)) return 'Confirme seu e-mail antes de entrar (veja sua caixa de entrada).';
  if (/rate limit|too many/i.test(m)) return 'Muitas tentativas. Espere alguns minutos e tente de novo.';
  if (/Password should be/i.test(m)) return 'A senha precisa ter pelo menos 6 caracteres.';
  if (/network|fetch/i.test(m)) return 'Sem conexão com o servidor. Verifique sua internet.';
  return m || 'Algo deu errado. Tente de novo.';
}

function viewNewPassword() {
  app.innerHTML = html`<div class="auth-wrap"><div class="panel auth-card">
    <div class="auth-hero">${raw(SIGIL)}<h1>Nova senha</h1></div>
    <form id="np" class="stack"><div class="field"><label>Nova senha (mínimo 6 caracteres)</label><input name="p" type="password" minlength="6" autocomplete="new-password" required></div>
    <div class="error-text" id="npErr"></div><button class="primary" style="width:100%">Salvar nova senha</button></form></div></div>`;
  $('#np').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = e.target.p.value;
    if (p.length < 6) { $('#npErr').textContent = 'A senha precisa ter pelo menos 6 caracteres.'; return; }
    if (!state.sb || !state.session) { $('#npErr').textContent = 'O link expirou. Peça um novo em "Esqueci a senha".'; return; }
    const { error } = await state.sb.auth.updateUser({ password: p });
    if (error) { $('#npErr').textContent = traduzErro(error.message); return; }
    toast('Senha alterada!');
    navigate('/', true);
  });
}

// ================= CABEÇALHO =================
function topbar() {
  return html`<header class="topbar">
    <a class="logo" href="/" data-link>${raw(SIGIL)}<span class="hide-sm">RPG Realms</span></a>
    <div class="grow"></div>
    <a class="btn ghost small hide-sm" href="/universos" data-link>Universos</a>
    <a class="btn ghost small" href="/configuracoes" data-link title="Configurações">⚙<span class="hide-sm">Configurações</span></a>
    <div class="userchip"><div class="avatar sm">${initials(state.me.displayName)}</div><span class="hide-sm">${state.me.displayName}</span></div>
    <button class="ghost small" id="logoutBtn">Sair</button>
  </header>`;
}
function bindTopbar() {
  $('#logoutBtn').addEventListener('click', async () => { await logout(); navigate('/', true); });
}

// ================= INÍCIO =================
async function viewHome() {
  app.innerHTML = topbar() + html`<main class="page">
    <div class="hero"><div><div class="ornament">✦ ✦ ✦</div><h1>Bem-vindo à taverna, ${state.me.displayName}</h1>
    <div class="muted">Reúna seu grupo, escolha um universo e role os dados.</div></div></div>
    <div class="actions">
      <button class="panel action-card" id="newCamp"><div class="ico">⚔</div><h3>Criar nova campanha</h3><div class="muted small">Você será o administrador da sala e receberá um código para convidar os amigos.</div></button>
      <button class="panel action-card" id="joinCamp"><div class="ico">⚿</div><h3>Entrar em uma campanha</h3><div class="muted small">Recebeu um código de 6 letras? Use aqui para entrar na mesa.</div></button>
      <a class="panel action-card" href="/universos" data-link style="color:inherit;text-decoration:none"><div class="ico">✧</div><h3>Biblioteca de universos</h3><div class="muted small">Conheça os 12 universos disponíveis para suas aventuras.</div></a>
    </div>
    <div class="section-title"><h2>Minhas campanhas</h2></div>
    <div id="camps"><div class="loading" style="min-height:120px"><div class="spinner"></div></div></div>
    <div class="section-title"><h2>Em construção</h2></div>
    <div class="roadmap">
      <div><b>Personagens</b>Editor, biblioteca e skins — próxima etapa</div>
      <div><b>Tabuleiro</b>Mapas, tokens e neblina de guerra</div>
      <div><b>Regras e combate</b>Iniciativa, turnos e inventário</div>
      <div><b>Mestre IA</b>Narração e NPCs controlados por IA</div>
    </div>
  </main>`;
  bindTopbar();
  $('#newCamp').addEventListener('click', openCreate);
  $('#joinCamp').addEventListener('click', openJoin);
  try {
    const list = await api('GET', '/api/campaigns');
    const box = $('#camps');
    if (!box) return;
    if (!list.length) { box.innerHTML = '<div class="empty">Você ainda não participa de nenhuma campanha.<br>Crie uma nova ou entre com um código de convite.</div>'; return; }
    box.innerHTML = '<div class="camp-grid"></div>';
    for (const c of list) {
      const u = universe(c.universe);
      const card = el(html`<a class="panel camp-card" href="/campanha/${c.id}" data-link style="--cc:${u.color}">
        <div class="camp-banner">${u.glyph}</div>
        <div class="camp-info"><h3>${c.name}</h3>
          <div class="muted small" style="margin:4px 0 10px">${u.name} · mestre: ${c.owner_name}</div>
          <div class="row wrap">
            ${raw(c.role === 'admin' ? '<span class="badge gold">♛ Administrador</span>' : '<span class="badge">Jogador</span>')}
            <span class="badge">${c.players}/${c.max_players} jogadores</span>
            ${raw(c.online ? `<span class="badge green">● ${c.online} online</span>` : '')}
          </div>
          <div class="muted small" style="margin-top:8px">Última atividade: ${timeStr(c.updated_at)}</div>
        </div></a>`);
      box.firstChild.appendChild(card);
    }
  } catch (e) { toast(e.message, 'err'); }
}

function universePicker(selected) {
  return `<div class="uni-grid">${state.universes.map((u) => html`<button type="button" class="uni ${u.id === selected ? 'selected' : ''}" data-u="${u.id}" style="--uc:${u.color}" title="${u.description}">
    <span class="g">${u.glyph}</span><b>${u.name}</b></button>`).join('')}</div>`;
}

function openCreate() {
  let uni = 'fantasia';
  const m = modal(html`<div class="panel-head"><h2>Criar nova campanha</h2><div class="grow"></div><button class="ghost" data-close>✕</button></div>
    <form class="panel-body stack" id="cf">
      <div class="field"><label>Nome da campanha</label><input name="name" maxlength="60" placeholder="Ex.: A Cripta do Rei Esquecido" required></div>
      <div class="field"><label>Universo</label>${raw(universePicker(uni))}<div class="muted small" id="uniDesc" style="margin-top:8px"></div></div>
      <div class="field"><label>Descrição (opcional)</label><textarea name="description" maxlength="500" placeholder="Um resumo da aventura para os jogadores"></textarea></div>
      <div class="field"><label>Limite de participantes (incluindo você): <b id="mpv">5</b></label><input name="maxPlayers" type="range" min="2" max="20" value="5"></div>
      <div class="error-text" id="cfErr"></div>
      <div class="row" style="justify-content:flex-end"><button type="button" data-close>Cancelar</button><button class="primary">Criar campanha</button></div>
    </form>`);
  const desc = () => { m.root.querySelector('#uniDesc').textContent = universe(uni).description; };
  desc();
  m.root.querySelectorAll('.uni').forEach((b) => b.addEventListener('click', () => {
    uni = b.dataset.u;
    m.root.querySelectorAll('.uni').forEach((x) => x.classList.toggle('selected', x === b));
    desc();
  }));
  const range = m.root.querySelector('[name=maxPlayers]');
  range.addEventListener('input', () => { m.root.querySelector('#mpv').textContent = range.value; });
  m.root.querySelector('#cf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button.primary');
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/campaigns', { name: f.name, description: f.description, universe: uni, maxPlayers: Number(f.maxPlayers) });
      m.close();
      toast('Campanha criada! Compartilhe o código com seus amigos.');
      navigate(`/campanha/${r.id}`);
    } catch (err) { m.root.querySelector('#cfErr').textContent = err.message; btn.disabled = false; }
  });
}

function openJoin() {
  const m = modal(html`<div class="panel-head"><h2>Entrar em uma campanha</h2><div class="grow"></div><button class="ghost" data-close>✕</button></div>
    <form class="panel-body stack" id="jf">
      <div class="field"><label>Código de convite</label><input name="code" maxlength="6" placeholder="Ex.: K7QX2M" style="text-transform:uppercase;letter-spacing:.3em;font-size:1.3rem;text-align:center" autocomplete="off" required></div>
      <div class="error-text" id="jfErr"></div>
      <div class="row" style="justify-content:flex-end"><button type="button" data-close>Cancelar</button><button class="primary">Entrar</button></div>
    </form>`, { narrow: true });
  m.root.querySelector('#jf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button.primary');
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/campaigns/join', { code: e.target.code.value });
      m.close();
      navigate(`/campanha/${r.id}`);
    } catch (err) { m.root.querySelector('#jfErr').textContent = err.message; btn.disabled = false; }
  });
}

// ================= UNIVERSOS =================
function viewUniverses() {
  app.innerHTML = topbar() + html`<main class="page">
    <div class="hero"><div><a href="/" data-link class="muted small">← Início</a><h1>Biblioteca de universos</h1>
    <div class="muted">Escolha o universo ao criar uma campanha. Cenários, mapas, criaturas e regras de cada um chegam nas próximas etapas.</div></div></div>
    <div class="uni-lib">${raw(state.universes.map((u) => html`<div class="panel" style="--uc:${u.color}"><div class="g">${u.glyph}</div><h3 style="margin:8px 0 6px">${u.name}</h3><div class="muted">${u.description}</div></div>`).join(''))}</div>
  </main>`;
  bindTopbar();
}

// ================= CONFIGURAÇÕES =================
function viewSettings() {
  const dev = state.cfg.devAuth;
  app.innerHTML = topbar() + html`<main class="page" style="max-width:640px">
    <a href="/" data-link class="muted small">← Início</a><h1 style="margin:6px 0 20px">Configurações</h1>
    <div class="panel"><div class="panel-head"><h3>Seu perfil</h3></div>
      <form class="panel-body stack" id="pf">
        <div class="field"><label>Nome exibido na mesa</label><input name="displayName" maxlength="40" value="${state.me.displayName}" required></div>
        <div class="muted small">E-mail: ${state.me.email || '—'}</div>
        <div class="row"><button class="primary">Salvar nome</button><span id="pfMsg"></span></div>
      </form></div>
    ${raw(dev ? '' : `<div class="panel" style="margin-top:16px"><div class="panel-head"><h3>Alterar senha</h3></div>
      <form class="panel-body stack" id="pw">
        <div class="field"><label>Nova senha (mínimo 6 caracteres)</label><input name="p" type="password" minlength="6" autocomplete="new-password" required></div>
        <div class="row"><button class="primary">Alterar senha</button><span id="pwMsg"></span></div>
      </form></div>`)}
  </main>`;
  bindTopbar();
  $('#pf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      state.me = await api('PUT', '/api/me', { displayName: e.target.displayName.value });
      $('#pfMsg').innerHTML = '<span class="ok-text">Salvo!</span>';
      $('.userchip').innerHTML = `<div class="avatar sm">${esc(initials(state.me.displayName))}</div><span class="hide-sm">${esc(state.me.displayName)}</span>`;
    } catch (err) { $('#pfMsg').innerHTML = `<span class="error-text">${esc(err.message)}</span>`; }
  });
  const pw = $('#pw');
  if (pw) pw.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = e.target.p.value;
    if (p.length < 6) { $('#pwMsg').innerHTML = '<span class="error-text">Mínimo de 6 caracteres</span>'; return; }
    const { error } = await state.sb.auth.updateUser({ password: p });
    $('#pwMsg').innerHTML = error ? `<span class="error-text">${esc(traduzErro(error.message))}</span>` : '<span class="ok-text">Senha alterada!</span>';
    if (!error) e.target.reset();
  });
}

// ================= INÍCIO DA APLICAÇÃO =================
(async () => {
  try {
    await initCore((ev) => {
      if (ev === 'recovery') navigate('/nova-senha', true);
      else if (ev === 'out') { state.me = null; route(); }
    });
    route();
  } catch (e) {
    app.innerHTML = `<div class="loading"><div>Não foi possível iniciar: ${esc(e.message)}<br><br><button onclick="location.reload()">Tentar de novo</button></div></div>`;
  }
})();
