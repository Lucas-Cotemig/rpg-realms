// Mesa da campanha: participantes, dados, verificação, registro e chat — tudo em tempo real
import { $, $$, html, raw, el, esc, toast, initials, timeStr, randomHex, uuid, confirmBox, copyText } from './util.js';
import { state, api, emit, getSocket, universe } from './core.js';
import { shapeSvg, pickerIcon, animateRoll, breakdown, critClass } from './dice-ui.js';
import { verifyRoll, sha256Hex } from './verify.js';
import { createBoard } from './board.js';

const DICE = [4, 6, 8, 10, 12, 20, 100];

export async function mountTable(root, campaignId, navigate) {
  root.innerHTML = '<div class="loading"><div><div class="spinner"></div>Preparando a mesa…</div></div>';
  const me = state.me;
  const s = {
    camp: null, members: [], online: new Set(), rolls: [], rollIds: new Set(), messages: [], msgIds: new Set(),
    seeds: new Map(), verify: new Map(), typing: new Map(), tab: 'mapa', mobile: 'mesa', unread: 0,
    sel: 20, qty: 1, mod: 0, custom: 30, exprTouched: false, rolling: false, chatTo: '', alive: true,
  };

  try {
    s.camp = await api('GET', `/api/campaigns/${campaignId}`);
  } catch (e) {
    toast(e.message, 'err');
    navigate('/', true);
    return () => {};
  }
  s.members = s.camp.members;
  const isAdmin = s.camp.myRole === 'admin';
  const u = universe(s.camp.universe);
  document.title = `${s.camp.name} · RPG Realms`;

  root.innerHTML = html`
  <div class="table-layout" style="--accent:${u.color}">
    <aside class="panel" id="pGroup">
      <div class="panel-head"><div class="camp-title"><span style="font-size:1.6rem;color:${u.color};text-shadow:0 0 12px ${u.color}">${u.glyph}</span>
        <div style="min-width:0"><h2 title="${s.camp.name}">${s.camp.name}</h2><div class="muted small">${u.name}</div></div></div></div>
      <div class="panel-body scroll" id="groupBody"></div>
    </aside>
    <section class="panel show-m" id="pTable">
      <div class="subtabs"><button data-tab="mapa" class="active">Mapa</button><button data-tab="dados">Dados</button><button data-tab="fichas">Fichas</button><button data-tab="verificacao">Verificação</button><button data-tab="registro">Registro</button></div>
      <div class="scroll" style="flex:1" id="tabBody"></div>
    </section>
    <aside class="panel" id="pChat">
      <div class="panel-head"><h3>Chat da campanha</h3></div>
      <div class="chat-list" id="chatList"></div>
      <div class="typing" id="typing"></div>
      <form class="chat-form" id="chatForm">
        <div class="row" style="margin-bottom:8px">
          <select id="chatTo" style="padding:6px 8px" aria-label="Destinatário"></select>
          ${raw(isAdmin ? '<label class="row small" style="margin:0;white-space:nowrap;cursor:pointer" title="A mensagem aparece como narração do Mestre"><input type="checkbox" id="asMaster" style="width:auto"> Narrar</label>' : '')}
        </div>
        <div class="row"><textarea id="chatInput" class="grow" rows="1" maxlength="1000" placeholder="Escreva… (Enter envia)"></textarea><button class="primary" aria-label="Enviar">➤</button></div>
      </form>
    </aside>
  </div>
  <nav class="mobile-tabs">
    <button data-m="mesa" class="active"><span style="font-size:1.2rem">⬢</span>Mesa</button>
    <button data-m="chat"><span style="font-size:1.2rem">✉</span><span>Chat <span class="badge-n hidden" id="mBadge"></span></span></button>
    <button data-m="grupo"><span style="font-size:1.2rem">♟</span>Grupo</button>
  </nav>`;

  // ---------- painel do grupo ----------
  function renderGroup() {
    const body = $('#groupBody', root);
    const memberRows = s.members.map((m) => {
      const online = s.online.has(m.userId);
      const isMe = m.userId === me.id;
      return html`<div class="member">
        <div class="avatar sm">${initials(m.displayName)}<span class="dot ${online ? 'on' : ''}"></span></div>
        <div class="name" title="${m.displayName}">${m.displayName}${isMe ? ' (você)' : ''}
          <div class="small muted">${m.role === 'admin' ? '♛ Mestre' : 'Jogador'} · ${online ? 'online' : 'offline'}</div></div>
        <div class="acts">${raw(isMe ? '' : html`<button class="ghost small" data-pm="${m.userId}" title="Mensagem privada">✉</button>${raw(isAdmin && m.role !== 'admin' ? html`<button class="ghost small" data-kick="${m.userId}" title="Remover da campanha">✕</button>` : '')}`)}</div>
      </div>`;
    }).join('');
    body.innerHTML = html`
      ${raw(s.camp.description ? html`<p class="muted small" style="margin-top:0">${s.camp.description}</p>` : '')}
      ${raw(isAdmin ? html`<h3>Convite</h3><div class="code-box" style="margin:8px 0">${s.camp.inviteCode}</div>
        <div class="row wrap"><button class="small" id="cpCode">Copiar código</button><button class="small" id="cpLink">Copiar link</button><button class="small ghost" id="newCode" title="O código atual deixa de funcionar">Gerar novo</button></div>`
        : '<div class="muted small">Para convidar alguém, peça o código ao administrador da sala.</div>')}
      <div class="divider"></div>
      <h3>Participantes <span class="muted small">(${s.members.length}/${s.camp.maxPlayers})</span></h3>
      <div style="margin-top:6px">${raw(memberRows)}</div>
      <div class="divider"></div>
      ${raw(isAdmin ? html`<h3>Administração</h3>
        <div class="field" style="margin-top:8px"><label>Limite de participantes</label>
        <div class="row"><input type="number" id="maxP" min="2" max="20" value="${s.camp.maxPlayers}" style="width:90px"><button class="small" id="saveMax">Salvar</button></div></div>`
        : '<button class="danger small" id="leave">Sair da campanha</button>')}
      <div class="divider"></div>
      <a href="/" data-link class="muted small">← Voltar ao início</a>`;

    if (isAdmin) {
      $('#cpCode', body).onclick = async () => toast((await copyText(s.camp.inviteCode)) ? 'Código copiado!' : s.camp.inviteCode);
      $('#cpLink', body).onclick = async () => { const link = `${location.origin}/entrar/${s.camp.inviteCode}`; toast((await copyText(link)) ? 'Link de convite copiado!' : link); };
      $('#newCode', body).onclick = async () => {
        if (!(await confirmBox('Gerar novo código?', 'O código atual vai parar de funcionar. Quem já está na campanha continua nela.', 'Gerar novo'))) return;
        try { s.camp.inviteCode = (await api('POST', `/api/campaigns/${campaignId}/code`)).inviteCode; renderGroup(); toast('Novo código gerado.'); } catch (e) { toast(e.message, 'err'); }
      };
      $('#saveMax', body).onclick = async () => {
        try { await api('PUT', `/api/campaigns/${campaignId}`, { maxPlayers: Number($('#maxP', body).value) }); toast('Limite atualizado.'); } catch (e) { toast(e.message, 'err'); }
      };
    } else {
      $('#leave', body).onclick = async () => {
        if (!(await confirmBox('Sair da campanha?', 'Você vai precisar de um novo código para voltar.', 'Sair', true))) return;
        try { await api('POST', `/api/campaigns/${campaignId}/leave`); navigate('/', true); } catch (e) { toast(e.message, 'err'); }
      };
    }
    $$('[data-pm]', body).forEach((b) => b.onclick = () => { s.chatTo = b.dataset.pm; renderChatTo(); setMobile('chat'); $('#chatInput', root).focus(); });
    $$('[data-kick]', body).forEach((b) => b.onclick = async () => {
      const m = s.members.find((x) => x.userId === b.dataset.kick);
      if (!(await confirmBox('Remover participante?', `${m.displayName} vai sair da campanha.`, 'Remover', true))) return;
      try { await api('DELETE', `/api/campaigns/${campaignId}/members/${m.userId}`); } catch (e) { toast(e.message, 'err'); }
    });
  }

  // ---------- abas centrais ----------
  $$('.subtabs button', root).forEach((b) => b.onclick = () => { s.tab = b.dataset.tab; $$('.subtabs button', root).forEach((x) => x.classList.toggle('active', x === b)); renderTab(); });

  const boardCtl = createBoard({ campaignId, isAdmin });
  function renderTab() {
    const body = $('#tabBody', root);
    body.classList.toggle('no-scroll', s.tab === 'mapa');
    if (s.tab === 'mapa') { boardCtl.mount(body, 'map'); return; }
    if (s.tab === 'fichas') { boardCtl.mount(body, 'sheets'); return; }
    boardCtl.unmount();
    if (s.tab === 'dados') renderDice(body);
    else if (s.tab === 'verificacao') renderVerify(body);
    else renderLog(body);
  }

  function expression() {
    const sides = s.sel === 'custom' ? s.custom : s.sel;
    return `${s.qty}d${sides}${s.mod > 0 ? '+' + s.mod : s.mod < 0 ? s.mod : ''}`;
  }

  function renderDice(body) {
    body.innerHTML = html`
      <div class="tray" id="tray"><div class="tray-dice"></div><div class="tray-caption"><div class="tray-idle">${raw(s.rolls.length ? 'A última rolagem aparece aqui' : 'Escolha os dados abaixo e clique em <b>Rolar</b>.<br><span class="small">Todos na mesa veem o resultado ao mesmo tempo.</span>')}</div></div></div>
      <div class="roller">
        <div class="dice-picker">${raw(DICE.map((d) => `<button type="button" data-d="${d}" class="${s.sel === d ? 'sel' : ''}">${pickerIcon(d)}d${d}</button>`).join(''))}
          <button type="button" data-d="custom" class="${s.sel === 'custom' ? 'sel' : ''}">${raw(pickerIcon(0))}dX</button></div>
        <div class="row wrap" style="margin-top:12px;align-items:flex-end">
          <div><label>Quantidade</label><div class="stepper"><button type="button" data-step="qty:-1">−</button><input id="qty" type="number" min="1" max="100" value="${s.qty}"><button type="button" data-step="qty:1">+</button></div></div>
          <div><label>Modificador</label><div class="stepper"><button type="button" data-step="mod:-1">−</button><input id="mod" type="number" min="-999" max="999" value="${s.mod}"><button type="button" data-step="mod:1">+</button></div></div>
          <div id="customBox" class="${s.sel === 'custom' ? '' : 'hidden'}"><label>Lados do dado</label><input id="customSides" type="number" min="2" max="1000" value="${s.custom}" style="width:100px"></div>
          <div class="grow" style="min-width:160px"><label>Descrição (opcional)</label><input id="rollLabel" maxlength="60" placeholder="Ex.: Ataque com espada"></div>
        </div>
        <div class="row wrap" style="margin-top:12px;align-items:flex-end">
          <div class="grow" style="min-width:180px"><label>Expressão (pode digitar, ex.: 2d6+1d4+3)</label><input id="expr" maxlength="60" value="${expression()}" style="font-family:'Courier New',monospace;font-weight:700"></div>
          <button class="primary roll-btn" id="rollBtn"><img src="/img/sigil.svg" alt="" style="width:24px;height:24px"> Rolar</button>
        </div>
        <div class="error-text" id="rollErr"></div>
      </div>
      <div style="padding:0 14px 14px"><h3 style="margin:6px 0 8px">Histórico de rolagens</h3><div class="panel" style="box-shadow:none" id="feed"></div>
      <div style="text-align:center;margin-top:10px"><button class="small ghost ${s.rolls.length >= 50 ? '' : 'hidden'}" id="moreRolls">Carregar mais antigas</button></div></div>`;

    const syncExpr = () => { if (!s.exprTouched) $('#expr', body).value = expression(); };
    $$('.dice-picker button', body).forEach((b) => b.onclick = () => {
      s.sel = b.dataset.d === 'custom' ? 'custom' : Number(b.dataset.d);
      s.exprTouched = false;
      $$('.dice-picker button', body).forEach((x) => x.classList.toggle('sel', x === b));
      $('#customBox', body).classList.toggle('hidden', s.sel !== 'custom');
      syncExpr();
    });
    $$('[data-step]', body).forEach((b) => b.onclick = () => {
      const [k, d] = b.dataset.step.split(':');
      if (k === 'qty') s.qty = Math.min(100, Math.max(1, s.qty + Number(d)));
      else s.mod = Math.min(999, Math.max(-999, s.mod + Number(d)));
      $('#qty', body).value = s.qty; $('#mod', body).value = s.mod;
      s.exprTouched = false; syncExpr();
    });
    $('#qty', body).oninput = (e) => { s.qty = Math.min(100, Math.max(1, parseInt(e.target.value, 10) || 1)); s.exprTouched = false; syncExpr(); };
    $('#mod', body).oninput = (e) => { s.mod = Math.min(999, Math.max(-999, parseInt(e.target.value, 10) || 0)); s.exprTouched = false; syncExpr(); };
    $('#customSides', body).oninput = (e) => { s.custom = Math.min(1000, Math.max(2, parseInt(e.target.value, 10) || 2)); s.exprTouched = false; syncExpr(); };
    $('#expr', body).oninput = () => { s.exprTouched = true; };
    $('#expr', body).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doRoll(); } };
    $('#rollBtn', body).onclick = doRoll;
    $('#moreRolls', body).onclick = async () => {
      const oldest = s.rolls[s.rolls.length - 1];
      const more = await api('GET', `/api/campaigns/${campaignId}/rolls?before=${oldest.id}`);
      for (const r of more) if (!s.rollIds.has(r.id)) { s.rolls.push(r); s.rollIds.add(r.id); }
      if (more.length < 50) $('#moreRolls', body).classList.add('hidden');
      renderFeed(); verifyLoaded();
    };
    renderFeed();
    if (s.rolls[0]) showStatic(s.rolls[0]);
  }

  function showStatic(roll) {
    const tray = $('#tray', root);
    if (!tray) return;
    const items = roll.terms.flatMap((t) => t.results.map((v) => ({ v, sd: t.sides, neg: t.sign < 0 }))).slice(0, 16);
    tray.querySelector('.tray-dice').innerHTML = items.map((it) => `<div class="die ${it.neg ? 'neg' : ''}">${shapeSvg(it.sd)}<span class="num">${it.v}</span><span class="tag">d${it.sd}</span></div>`).join('');
    tray.querySelector('.tray-caption').innerHTML = html`<div class="tray-total">${roll.total}</div><div class="tray-who">${roll.displayName}${roll.userId === me.id ? ' (você)' : ''} · ${roll.expression}${roll.label ? ' · ' + roll.label : ''}</div>`;
  }

  async function doRoll() {
    if (s.rolling) return;
    const err = $('#rollErr', root);
    err.textContent = '';
    const expr = $('#expr', root).value.trim();
    s.rolling = true;
    $('#rollBtn', root).disabled = true;
    const res = await emit('dice:roll', { campaignId, expression: expr, clientSeed: randomHex(16), requestId: uuid(), label: $('#rollLabel', root).value });
    s.rolling = false;
    const btn = $('#rollBtn', root);
    if (btn) btn.disabled = false;
    if (res.error) { if (err) err.textContent = res.error; return; }
    addRoll(res.roll, true);
  }

  function statusFor(roll) {
    const seed = s.seeds.get(roll.seedId);
    const v = s.verify.get(roll.id);
    if (v === true) return '<span class="verify-ok" title="Resultado conferido com a semente revelada">✔ conferido</span>';
    if (v === false) return '<span class="verify-bad">✖ não confere!</span>';
    if (seed && seed.revealed) return '<span class="verify-wait">conferindo…</span>';
    return '<span class="verify-wait" title="A semente desta rolagem ainda está lacrada; depois de revelada, todos podem conferir">🔒 lacrada</span>';
  }

  function feedItem(r) {
    return html`<div class="feed-item" data-roll="${r.id}">
      <div class="tot ${critClass(r)}">${r.total}</div>
      <div class="grow"><div><b>${r.displayName}</b>${r.userId === me.id ? ' (você)' : ''} rolou <b class="mono" style="font-size:.95rem">${r.expression}</b>${raw(r.label ? html` <span class="badge">${r.label}</span>` : '')}</div>
        <div class="muted small">${breakdown(r)} · ${timeStr(r.createdAt)} · <span data-vs>${raw(statusFor(r))}</span></div></div></div>`;
  }

  function renderFeed() {
    const feed = $('#feed', root);
    if (!feed) return;
    feed.innerHTML = s.rolls.length ? s.rolls.map(feedItem).join('') : '<div class="empty" style="border:0">Nenhuma rolagem ainda.</div>';
  }

  function addRoll(roll, animate) {
    if (s.rollIds.has(roll.id)) return;
    s.rollIds.add(roll.id);
    s.rolls.unshift(roll);
    if (s.camp.activeSeed && roll.seedId === s.camp.activeSeed.id) s.camp.activeSeed.rolls = Math.max(s.camp.activeSeed.rolls, roll.nonce + 1);
    const feed = $('#feed', root);
    if (feed) {
      if (!feed.querySelector('[data-roll]')) feed.innerHTML = '';
      feed.prepend(el(feedItem(roll)));
    }
    const tray = $('#tray', root);
    if (tray && animate) animateRoll(tray, roll, me.id);
    if (s.tab === 'registro') renderTab();
  }

  // ---------- verificação ----------
  async function loadSeeds() {
    const list = await api('GET', `/api/campaigns/${campaignId}/seeds`);
    s.seeds = new Map(list.map((x) => [x.id, x]));
  }

  async function verifyLoaded() {
    for (const r of s.rolls) {
      const seed = s.seeds.get(r.seedId);
      if (!seed || !seed.revealed || s.verify.has(r.id)) continue;
      const ok = (await sha256Hex(seed.serverSeed)) === seed.seedHash && (await verifyRoll(r, seed.serverSeed));
      s.verify.set(r.id, ok);
      const node = root.querySelector(`[data-roll="${r.id}"] [data-vs]`);
      if (node) node.innerHTML = statusFor(r);
    }
  }

  function renderVerify(body) {
    const active = s.camp.activeSeed;
    const revealed = [...s.seeds.values()].filter((x) => x.revealed);
    body.innerHTML = html`<div class="panel-body stack">
      <h2>Dados à prova de trapaça</h2>
      <p class="muted" style="margin:6px 0">Os dados são sorteados no servidor, nunca no navegador. Antes de qualquer rolagem, o servidor publica o
      <b>lacre</b> (um código que identifica a semente secreta usada nos sorteios). Quando a semente é revelada, qualquer jogador pode conferir aqui
      que todas as rolagens saíram exatamente daquela semente — ou seja, ninguém trocou um resultado depois.</p>
      <div class="panel" style="box-shadow:none"><div class="panel-body">
        <h3>Semente atual (lacrada)</h3>
        ${raw(active ? html`<div class="muted small" style="margin:6px 0">Lacre (SHA-256):</div><div class="mono">${active.seedHash}</div>
        <div class="muted small" style="margin-top:6px">${active.rolls} rolagens com esta semente · desde ${timeStr(active.createdAt)}</div>` : '<div class="muted">Nenhuma ainda.</div>')}
        ${raw(isAdmin ? '<div class="row" style="margin-top:12px"><button class="purple small" id="revealBtn">Revelar semente e lacrar uma nova</button></div><div class="muted small" style="margin-top:6px">Faça isso ao fim de cada sessão para que todos possam conferir as rolagens.</div>' : '<div class="muted small" style="margin-top:8px">O administrador revela a semente ao fim da sessão.</div>')}
      </div></div>
      <h3>Sementes já reveladas</h3>
      ${raw(revealed.length ? revealed.map((x) => html`<div class="panel" style="box-shadow:none"><div class="panel-body">
        <div class="muted small">Revelada em ${timeStr(x.revealedAt)} · ${x.rolls} rolagens</div>
        <div class="muted small" style="margin-top:6px">Lacre:</div><div class="mono">${x.seedHash}</div>
        <div class="muted small" style="margin-top:6px">Semente revelada:</div><div class="mono">${x.serverSeed}</div>
        <div class="row" style="margin-top:10px"><button class="small" data-check="${x.id}">Conferir todas as rolagens</button><span data-res="${x.id}"></span></div>
      </div></div>`).join('') : '<div class="muted">Nenhuma semente revelada ainda.</div>')}
    </div>`;
    const rb = $('#revealBtn', body);
    if (rb) rb.onclick = async () => {
      if (!(await confirmBox('Revelar a semente?', 'A semente atual será publicada para conferência e uma nova semente lacrada passará a ser usada nas próximas rolagens.', 'Revelar'))) return;
      try { await api('POST', `/api/campaigns/${campaignId}/seeds/reveal`); } catch (e) { toast(e.message, 'err'); }
    };
    $$('[data-check]', body).forEach((b) => b.onclick = async () => {
      const seed = s.seeds.get(b.dataset.check);
      const out = $(`[data-res="${seed.id}"]`, body);
      b.disabled = true;
      out.innerHTML = '<span class="verify-wait">Conferindo…</span>';
      const hashOk = (await sha256Hex(seed.serverSeed)) === seed.seedHash;
      const rolls = await api('GET', `/api/campaigns/${campaignId}/rolls?seed=${seed.id}`);
      let ok = 0; let bad = 0;
      for (const r of rolls) {
        const good = hashOk && r.seedHash === seed.seedHash && (await verifyRoll(r, seed.serverSeed));
        s.verify.set(r.id, good);
        good ? ok++ : bad++;
      }
      const missing = seed.rolls - rolls.length;
      out.innerHTML = !hashOk ? '<span class="verify-bad">✖ A semente não corresponde ao lacre!</span>'
        : bad ? `<span class="verify-bad">✖ ${bad} rolagem(ns) não conferem</span>`
          : `<span class="verify-ok">✔ Lacre confere e ${ok} rolagens conferidas${missing > 0 ? ` (faltam ${missing})` : ''}</span>`;
      b.disabled = false;
    });
  }

  // ---------- registro ----------
  const EVENT_TEXT = {
    campanha_criada: (e) => `criou a campanha “${e.after?.name ?? ''}”`,
    jogador_entrou: () => 'entrou na campanha',
    jogador_saiu: () => 'saiu da campanha',
    jogador_removido: (e) => `removeu ${nameOf(e.result?.userId)} da campanha`,
    rolagem: (e) => `rolou ${e.result?.expression} = ${e.result?.total}${e.result?.label ? ' (' + e.result.label + ')' : ''}`,
    semente_revelada: (e) => `revelou a semente dos dados (${e.result?.rolls} rolagens)`,
    codigo_renovado: () => 'gerou um novo código de convite',
    personagem_entrou: (e) => `levou ${e.result?.nome} para a mesa`,
    personagem_saiu: (e) => `tirou ${e.result?.nome} da campanha`,
    ficha_editada: (e) => `editou a ficha de ${e.result?.nome}`,
    mapa_criado: (e) => `criou o mapa “${e.result?.name}”`,
    mapa_ativado: () => 'abriu um mapa para todos',
    mapa_apagado: () => 'apagou um mapa',
    regra_movimento: (e) => `mudou o movimento para “${e.after?.moveMode === 'turno' ? 'só na vez' : 'livre'}”`,
    token_criado: (e) => `colocou ${e.result?.qty > 1 ? e.result.qty + '× ' : ''}${e.result?.name} no mapa`,
    token_editado: (e) => `editou ${e.after?.name}`,
    token_removido: (e) => `removeu ${e.result?.name} do mapa`,
    vida_alterada: (e) => `${e.result?.nome}: PV ${e.before?.pv} → ${e.after?.pv} (${e.consequences?.motivo})`,
    combate_iniciado: (e) => `iniciou o combate: ${(e.after?.ordem || []).join(', ')}`,
    turno_passado: (e) => `passou o turno (rodada ${e.after?.rodada}, vez de ${e.after?.vez})`,
    combate_encerrado: () => 'encerrou o combate',
    ataque: (e) => `${e.result?.atacante} atacou ${e.result?.alvo} com ${e.result?.arma}: ${e.result?.teste} vs ${e.result?.defesa} — ${e.result?.acerto ? (e.result?.critico ? 'crítico, ' : '') + e.result?.dano + ' de dano' : 'errou'}`,
    limite_alterado: (e) => `alterou o limite de participantes de ${e.before?.maxPlayers} para ${e.after?.maxPlayers}`,
  };
  const nameOf = (id) => (s.members.find((m) => m.userId === id) || {}).displayName || 'um participante';

  async function renderLog(body) {
    body.innerHTML = '<div class="loading" style="min-height:150px"><div class="spinner"></div></div>';
    try {
      const evs = await api('GET', `/api/campaigns/${campaignId}/events`);
      if (s.tab !== 'registro') return;
      body.innerHTML = html`<div class="panel-body"><h2>Registro da campanha</h2>
        <p class="muted small">Tudo o que acontece na mesa fica registrado em ordem. Este registro não pode ser editado nem apagado.</p>
        <div class="panel" style="box-shadow:none">${raw(evs.map((e) => html`<div class="feed-item"><div class="muted small" style="min-width:92px">${timeStr(e.createdAt)}</div>
          <div class="grow"><b>${e.displayName || 'Sistema'}</b> ${(EVENT_TEXT[e.type] || (() => e.type))(e)}</div><div class="muted small">#${e.id}</div></div>`).join('') || '<div class="empty" style="border:0">Sem registros.</div>')}</div></div>`;
    } catch (e) { body.innerHTML = `<div class="panel-body error-text">${esc(e.message)}</div>`; }
  }

  // ---------- chat ----------
  function renderChatTo() {
    const sel = $('#chatTo', root);
    const others = s.members.filter((m) => m.userId !== me.id);
    if (s.chatTo && !others.some((m) => m.userId === s.chatTo)) s.chatTo = '';
    sel.innerHTML = '<option value="">Para: todos</option>' + others.map((m) => html`<option value="${m.userId}">Privado: ${m.displayName}</option>`).join('');
    sel.value = s.chatTo;
    const am = $('#asMaster', root);
    if (am) { am.disabled = !!s.chatTo; if (s.chatTo) am.checked = false; }
  }
  $('#chatTo', root).onchange = (e) => { s.chatTo = e.target.value; renderChatTo(); };

  function msgNode(m) {
    if (m.kind === 'system') return el(html`<div class="msg system">${m.body} · ${timeStr(m.createdAt)}</div>`);
    const mine = m.userId === me.id;
    const who = m.kind === 'mestre' ? `✦ Mestre (${m.displayName})`
      : m.kind === 'private' ? (mine ? `Você → ${m.recipientName} (privado)` : `${m.displayName} → você (privado)`)
        : (mine ? 'Você' : m.displayName);
    const n = el(html`<div class="msg ${m.kind} ${mine && m.kind !== 'mestre' ? 'mine' : ''}"><div class="who">${who}<span class="when">${timeStr(m.createdAt)}</span></div><div></div></div>`);
    n.lastChild.textContent = m.body;
    n.lastChild.style.whiteSpace = 'pre-wrap';
    return n;
  }

  function renderChat() {
    const list = $('#chatList', root);
    list.innerHTML = '';
    if (!s.messages.length) list.appendChild(el('<div class="msg system">Nenhuma mensagem ainda. Diga olá ao grupo!</div>'));
    for (const m of s.messages) list.appendChild(msgNode(m));
    list.scrollTop = list.scrollHeight;
  }

  function addMessage(m) {
    if (s.msgIds.has(m.id)) return;
    s.msgIds.add(m.id);
    s.messages.push(m);
    const list = $('#chatList', root);
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (s.messages.length === 1) list.innerHTML = '';
    list.appendChild(msgNode(m));
    if (nearBottom || m.userId === me.id) list.scrollTop = list.scrollHeight;
    if (m.userId !== me.id) {
      const chatHidden = window.innerWidth <= 860 && s.mobile !== 'chat';
      if (document.hidden || chatHidden) { s.unread++; updateUnread(); }
      if (m.kind === 'private' && (document.hidden || chatHidden)) toast(`Mensagem privada de ${m.displayName}`);
    }
  }

  function updateUnread() {
    const b = $('#mBadge', root);
    if (b) { b.textContent = s.unread; b.classList.toggle('hidden', !s.unread); }
    document.title = (s.unread ? `(${s.unread}) ` : '') + `${s.camp.name} · RPG Realms`;
  }
  const onVisible = () => { if (!document.hidden && (window.innerWidth > 860 || s.mobile === 'chat')) { s.unread = 0; updateUnread(); } };
  document.addEventListener('visibilitychange', onVisible);

  let typingSent = 0;
  let typingStop = null;
  const input = $('#chatInput', root);
  input.addEventListener('input', () => {
    const now = Date.now();
    if (now - typingSent > 2000) { getSocket().emit('chat:typing', { campaignId, typing: true }); typingSent = now; }
    clearTimeout(typingStop);
    typingStop = setTimeout(() => { getSocket().emit('chat:typing', { campaignId, typing: false }); typingSent = 0; }, 3000);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm', root).requestSubmit(); } });
  $('#chatForm', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    const am = $('#asMaster', root);
    input.value = '';
    clearTimeout(typingStop);
    getSocket().emit('chat:typing', { campaignId, typing: false });
    typingSent = 0;
    const res = await emit('chat:send', { campaignId, body, to: s.chatTo || undefined, asMaster: am ? am.checked : false });
    if (res.error) { toast(res.error, 'err'); input.value = body; return; }
    addMessage(res.message);
  });

  function renderTyping() {
    const names = [...s.typing.values()].map((t) => t.name);
    $('#typing', root).textContent = names.length ? `${names.join(', ')} ${names.length > 1 ? 'estão' : 'está'} digitando…` : '';
  }

  // ---------- celular ----------
  function setMobile(m) {
    s.mobile = m;
    $$('.mobile-tabs button', root).forEach((b) => b.classList.toggle('active', b.dataset.m === m));
    $('#pTable', root).classList.toggle('show-m', m === 'mesa');
    $('#pChat', root).classList.toggle('show-m', m === 'chat');
    $('#pGroup', root).classList.toggle('show-m', m === 'grupo');
    if (m === 'chat') { s.unread = 0; updateUnread(); const l = $('#chatList', root); l.scrollTop = l.scrollHeight; }
  }
  $$('.mobile-tabs button', root).forEach((b) => b.onclick = () => setMobile(b.dataset.m));

  // ---------- tempo real ----------
  const socket = getSocket();
  const mine = (d) => d && d.campaignId === campaignId;
  const handlers = {
    'dice:result': (d) => { if (mine(d)) addRoll(d.roll, true); },
    'chat:message': (d) => { if (mine(d)) addMessage(d.message); },
    'chat:typing': (d) => {
      if (!mine(d) || d.userId === me.id) return;
      const cur = s.typing.get(d.userId);
      if (cur) clearTimeout(cur.t);
      if (d.typing) s.typing.set(d.userId, { name: d.displayName, t: setTimeout(() => { s.typing.delete(d.userId); renderTyping(); }, 5000) });
      else s.typing.delete(d.userId);
      renderTyping();
    },
    presence: (d) => { if (!mine(d)) return; d.online ? s.online.add(d.userId) : s.online.delete(d.userId); renderGroup(); },
    'members:update': (d) => { if (!mine(d)) return; s.members = d.members; d.members.forEach((m) => m.online && s.online.add(m.userId)); renderGroup(); renderChatTo(); },
    'campaign:update': (d) => { if (!mine(d)) return; s.camp.maxPlayers = d.maxPlayers; renderGroup(); },
    'campaign:removed': (d) => { if (!mine(d)) return; toast('Você foi removido desta campanha.', 'err'); navigate('/', true); },
    'seed:revealed': async (d) => {
      if (!mine(d)) return;
      s.camp.activeSeed = d.activeSeed;
      await loadSeeds();
      if (s.tab === 'verificacao') renderTab();
      renderFeed();
      verifyLoaded();
    },
    connect: () => { join(true); },
  };
  for (const [ev, fn] of Object.entries(handlers)) socket.on(ev, fn);

  // Entra na sala e sincroniza tudo com o servidor (também após reconexão)
  async function join(resync) {
    const r = await emit('room:join', { campaignId });
    if (r.error) { toast(r.error, 'err'); navigate('/', true); return; }
    s.online = new Set(r.online);
    s.online.add(me.id);
    if (resync) {
      try {
        const [camp, rolls, msgs] = await Promise.all([
          api('GET', `/api/campaigns/${campaignId}`), api('GET', `/api/campaigns/${campaignId}/rolls`), api('GET', `/api/campaigns/${campaignId}/messages`),
        ]);
        s.camp = camp; s.members = camp.members;
        s.rolls = rolls; s.rollIds = new Set(rolls.map((x) => x.id));
        s.messages = msgs; s.msgIds = new Set(msgs.map((x) => x.id));
        await loadSeeds();
        renderTab(); renderChat(); renderChatTo(); verifyLoaded();
      } catch (e) { /* a próxima reconexão tenta de novo */ }
    }
    renderGroup();
  }

  const [rolls, msgs] = await Promise.all([api('GET', `/api/campaigns/${campaignId}/rolls`), api('GET', `/api/campaigns/${campaignId}/messages`), loadSeeds()]);
  s.rolls = rolls; s.rollIds = new Set(rolls.map((x) => x.id));
  s.messages = msgs; s.msgIds = new Set(msgs.map((x) => x.id));
  renderGroup(); renderTab(); renderChat(); renderChatTo();
  if (socket.connected) await join(false);
  verifyLoaded();

  return () => {
    s.alive = false;
    boardCtl.destroy();
    for (const [ev, fn] of Object.entries(handlers)) socket.off(ev, fn);
    socket.emit('room:leave', { campaignId });
    document.removeEventListener('visibilitychange', onVisible);
    s.typing.forEach((t) => clearTimeout(t.t));
    clearTimeout(typingStop);
    document.title = 'RPG Realms';
  };
}
