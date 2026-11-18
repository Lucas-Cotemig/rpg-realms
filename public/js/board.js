// Tabuleiro multiplayer: mapa, tokens, testes e combate em tempo real.
// O navegador só pede ações; o servidor valida, rola os dados e devolve o estado para todos.
import { $, $$, html, raw, el, esc, toast, modal, initials, confirmBox, randomHex, resizeImage } from './util.js';
import { state, api, emit, getSocket, loadRules } from './core.js';
import { avatarHtml } from './characters.js';

export function createBoard({ campaignId, isAdmin }) {
  const me = state.me;
  let rules = null;
  let board = null;
  let root = null;
  let sheetsRoot = null;
  let view = { s: 1, tx: 20, ty: 20, fitted: false };
  let selected = null;
  let targeting = null; // { attackerId, weapon }
  let bannerTimer = null;
  const socket = getSocket();

  const tokenById = (id) => board && board.tokens.find((t) => t.id === id);
  const charOf = (t) => t && t.characterId && board.characters.find((c) => c.id === t.characterId);
  const canControl = (t) => isAdmin || (t && t.ownerId === me.id);
  const currentTurnId = () => (board && board.combat && board.combat.order.length ? board.combat.order[board.combat.turn].tokenId : null);

  async function fetchBoard() {
    const r = await emit('board:join', { campaignId });
    if (r.error) { toast(r.error, 'err'); return; }
    board = r.board;
    if (root) render(); else if (sheetsRoot) renderSheets(sheetsRoot);
  }

  const handlers = {
    'board:state': (d) => { if (d.campaignId !== campaignId) return; board = d.board; if (selected && !tokenById(selected)) selected = null; if (root) render(); else if (sheetsRoot) renderSheets(sheetsRoot); },
    'token:moved': (d) => {
      if (d.campaignId !== campaignId || !board) return;
      const t = tokenById(d.tokenId);
      if (!t) return;
      t.x = d.x; t.y = d.y;
      const n = root && root.querySelector(`.token[data-id="${t.id}"]`);
      if (n && !n.classList.contains('dragging')) placeToken(n, t);
    },
    'dice:result': (d) => {
      if (d.campaignId !== campaignId || !root) return;
      const b = root.querySelector('.roll-banner');
      if (!b) return;
      const r = d.roll;
      b.innerHTML = html`${raw(r.outcome ? `<b class="${/Errou/.test(r.outcome) ? 'bad' : 'good'}">${esc(r.outcome)}</b> · ` : '')}${r.label || r.expression}: <span class="big">${r.total}</span> <span class="muted small">${r.expression}</span>`;
      b.classList.add('show');
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => b.classList.remove('show'), 5000);
    },
    connect: () => { fetchBoard(); },
  };
  for (const [ev, fn] of Object.entries(handlers)) socket.on(ev, fn);

  // ---------- desenho ----------
  function render() {
    if (!board) { root.innerHTML = '<div class="loading"><div class="spinner"></div></div>'; return; }
    const m = board.map;
    const myChars = board.characters.filter((c) => c.mine);
    root.innerHTML = html`<div class="board-wrap">
      <div class="board-toolbar">
        ${raw(isAdmin ? html`<select id="mapSel" title="Mapas da campanha (só o mestre vê os não ativos)">${raw((board.maps || []).map((x) => `<option value="${x.id}" ${m && x.id === m.id ? 'selected' : ''}>${esc(x.name)}${m && x.id === m.id ? ' (na mesa)' : ''}</option>`).join('') || '<option value="">Nenhum mapa</option>')}</select>
          <button class="small" id="actMap">Mostrar a todos</button><button class="small" id="newMap">+ Mapa</button>${raw(m ? '<button class="small" id="editMap">Editar mapa</button><button class="small" id="addTok">+ Inimigo / NPC</button>' : '')}
          <select id="moveMode" title="Quem pode mover"><option value="livre" ${board.settings.moveMode === 'livre' ? 'selected' : ''}>Movimento livre</option><option value="turno" ${board.settings.moveMode === 'turno' ? 'selected' : ''}>Mover só na vez</option></select>` : '')}
        <div class="grow"></div>
        ${raw(myChars.length ? '' : '<button class="small purple" id="bringChar">+ Levar meu personagem</button>')}
        <button class="small" id="zoomOut" title="Diminuir zoom">−</button><button class="small" id="zoomIn" title="Aumentar zoom">+</button><button class="small" id="fit" title="Mostrar o mapa inteiro">⤢</button>
      </div>
      <div class="board-main">
        <div class="board-view" id="bv">
          ${raw(m ? html`<div class="stage" id="stage" style="width:${m.width}px;height:${m.height}px">
            ${raw(m.imageUrl ? `<img class="map-img" src="${esc(m.imageUrl)}" alt="" draggable="false">` : '<div class="map-blank"></div>')}
            ${raw(m.showGrid ? `<div class="grid-layer" style="background-size:${m.grid}px ${m.grid}px"></div>` : '')}
            <div class="tokens"></div></div>` : html`<div class="empty-board"><div class="ornament">✦</div><h3>${isAdmin ? 'Nenhum mapa na mesa' : 'O mestre ainda não abriu um mapa'}</h3>
            <p class="muted">${isAdmin ? 'Envie a imagem de um mapa (ou crie um quadriculado em branco) para começar.' : 'Assim que ele abrir, o mapa aparece aqui para todos.'}</p>${raw(isAdmin ? '<button class="primary" id="firstMap">Criar primeiro mapa</button>' : '')}</div>`)}
          <div class="roll-banner"></div>
          ${raw(targeting ? '<div class="target-hint">🎯 Clique no alvo do ataque <button class="small" id="cancelTarget">Cancelar</button></div>' : '')}
        </div>
        <aside class="board-side" id="side"></aside>
      </div></div>`;
    if (m) {
      const layer = $('.tokens', root);
      for (const t of board.tokens) layer.appendChild(tokenNode(t));
      if (!view.fitted) { fit(); view.fitted = true; } else applyView();
      bindViewport();
    }
    renderSide();
    bindToolbar();
  }

  function tokenNode(t) {
    const m = board.map;
    const size = m.grid * t.size;
    const ratio = t.pvMax ? Math.max(0, Math.min(1, t.pv / t.pvMax)) : null;
    const down = t.pvMax && t.pv <= 0;
    const n = el(html`<div class="token ${t.kind} ${t.hidden ? 'is-hidden' : ''} ${selected === t.id ? 'sel' : ''} ${currentTurnId() === t.id ? 'turn' : ''} ${down ? 'down' : ''} ${canControl(t) ? 'mine' : ''}" data-id="${t.id}" style="width:${size}px;height:${size}px;--tc:${t.color}">
      <div class="disc">${raw(t.imageUrl ? `<img src="${esc(t.imageUrl)}" alt="" draggable="false">` : `<span>${esc(initials(t.name))}</span>`)}</div>
      ${raw(ratio !== null ? `<div class="hp"><i style="width:${ratio * 100}%;background:${ratio > 0.5 ? '#4ade80' : ratio > 0.25 ? '#facc15' : '#ef4444'}"></i></div>` : '')}
      <div class="tname">${t.name}${t.hidden ? ' 👁' : ''}</div></div>`);
    placeToken(n, t);
    return n;
  }
  function placeToken(n, t) {
    const size = board.map.grid * t.size;
    n.style.left = `${t.x - size / 2}px`;
    n.style.top = `${t.y - size / 2}px`;
  }

  function applyView() {
    const st = $('#stage', root);
    if (st) st.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
  }
  function fit() {
    const bv = $('#bv', root);
    if (!bv || !board.map) return;
    const s = Math.min(bv.clientWidth / board.map.width, bv.clientHeight / board.map.height) * 0.96;
    view.s = Math.max(0.1, Math.min(3, s || 1));
    view.tx = (bv.clientWidth - board.map.width * view.s) / 2;
    view.ty = (bv.clientHeight - board.map.height * view.s) / 2;
    applyView();
  }
  function zoomAt(factor, cx, cy) {
    const ns = Math.max(0.1, Math.min(4, view.s * factor));
    view.tx = cx - ((cx - view.tx) * ns) / view.s;
    view.ty = cy - ((cy - view.ty) * ns) / view.s;
    view.s = ns;
    applyView();
  }

  function bindViewport() {
    const bv = $('#bv', root);
    const toStage = (e) => { const r = bv.getBoundingClientRect(); return { x: (e.clientX - r.left - view.tx) / view.s, y: (e.clientY - r.top - view.ty) / view.s }; };
    bv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = bv.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    let drag = null;
    bv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const tn = e.target.closest('.token');
      if (tn) {
        const t = tokenById(tn.dataset.id);
        drag = { kind: 'token', t, node: tn, start: { x: e.clientX, y: e.clientY }, orig: { x: t.x, y: t.y }, moved: false, can: canControl(t) && !targeting };
      } else if (!e.target.closest('.roll-banner, .target-hint')) {
        drag = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, orig: { tx: view.tx, ty: view.ty }, moved: false };
      }
      if (drag) bv.setPointerCapture(e.pointerId);
    });
    bv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.start.x;
      const dy = e.clientY - drag.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.kind === 'pan') { view.tx = drag.orig.tx + dx; view.ty = drag.orig.ty + dy; applyView(); }
      else if (drag.can && drag.moved) {
        drag.node.classList.add('dragging');
        const p = toStage(e);
        placeToken(drag.node, { ...drag.t, x: p.x, y: p.y });
      }
    });
    const end = async (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.kind === 'pan') { if (!d.moved && !targeting) { selected = null; renderSide(); $$('.token.sel', root).forEach((n) => n.classList.remove('sel')); } return; }
      d.node.classList.remove('dragging');
      if (!d.moved) { clickToken(d.t); return; }
      if (!d.can) return;
      const g = board.map.grid;
      const p = toStage(e);
      const half = (g * d.t.size) / 2;
      let x = p.x; let y = p.y;
      if (board.map.showGrid) {
        x = Math.round((p.x - half) / g) * g + half;
        y = Math.round((p.y - half) / g) * g + half;
      }
      x = Math.max(0, Math.min(board.map.width, x));
      y = Math.max(0, Math.min(board.map.height, y));
      d.t.x = x; d.t.y = y;
      placeToken(d.node, d.t);
      const r = await emit('token:move', { campaignId, tokenId: d.t.id, x, y });
      if (r.error) { toast(r.error, 'err'); d.t.x = d.orig.x; d.t.y = d.orig.y; placeToken(d.node, d.t); }
    };
    bv.addEventListener('pointerup', end);
    bv.addEventListener('pointercancel', end);
  }

  async function clickToken(t) {
    if (targeting) {
      const atk = targeting;
      targeting = null;
      if (t.id === atk.attackerId) { toast('Escolha outro alvo', 'err'); render(); return; }
      render();
      const r = await emit('combat:attack', { campaignId, attackerId: atk.attackerId, targetId: t.id, weapon: atk.weapon, clientSeed: randomHex(16) });
      if (r.error) toast(r.error, 'err');
      return;
    }
    selected = t.id;
    $$('.token', root).forEach((n) => n.classList.toggle('sel', n.dataset.id === t.id));
    renderSide();
  }

  // ---------- painel lateral ----------
  function renderSide() {
    const side = $('#side', root);
    if (!side) return;
    const c = board.combat;
    let combatHtml;
    if (c) {
      const cur = currentTurnId();
      const curTok = tokenById(cur);
      const canPass = isAdmin || (curTok && curTok.ownerId === me.id);
      combatHtml = html`<div class="side-box combat-on"><div class="row"><h3 class="grow">⚔ Combate · Rodada ${c.round}</h3></div>
        <ol class="init-list">${raw(c.order.map((o, i) => html`<li class="${i === c.turn ? 'now' : ''}" data-tok="${o.tokenId}"><span class="grow">${o.name}</span><b>${o.init}</b></li>`).join(''))}</ol>
        <div class="row wrap">${raw(canPass ? '<button class="primary small" id="nextTurn">Próximo turno ▸</button>' : '<span class="muted small">Aguarde a sua vez.</span>')}${raw(isAdmin ? '<button class="small danger" id="endCombat">Encerrar</button>' : '')}</div></div>`;
    } else {
      combatHtml = html`<div class="side-box"><h3>Fora de combate</h3>${raw(isAdmin ? '<p class="muted small">Ao iniciar, o servidor rola a iniciativa de todos que estão no mapa (Agilidade + Iniciativa).</p><button class="primary small" id="startCombat">⚔ Iniciar combate</button>' : '<p class="muted small">O mestre inicia o combate quando for a hora.</p>')}</div>`;
    }
    side.innerHTML = combatHtml + selectedHtml();
    bindSide();
  }

  function selectedHtml() {
    const t = tokenById(selected);
    if (!t) return `<div class="side-box muted small">Clique em um token para ver detalhes e ações.${board.map ? '<br>Arraste o seu token para mover. Role a rodinha do mouse para zoom e arraste o fundo para andar pelo mapa.' : ''}</div>`;
    const ch = charOf(t);
    const ctl = canControl(t);
    const kindName = { pc: 'Personagem', npc: 'NPC', inimigo: 'Inimigo' }[t.kind];
    let tests = '';
    if (ctl) {
      const opts = ch
        ? rules.pericias.map((p) => `<option value="p:${p.id}">${esc(p.nome)}${ch.data.pericias[p.id] ? ' +' + rules.graus[ch.data.pericias[p.id]].bonus : ''}</option>`).join('')
        : rules.atributos.map((a) => `<option value="a:${a.id}">${esc(a.nome)}</option>`).join('') + '<option value="p:iniciativa">Iniciativa</option>';
      tests = `<div class="row" style="margin-top:8px"><select id="testSel">${opts}</select><button class="small" id="testBtn">🎲 Teste</button></div>`;
    }
    let attack = '';
    if (ctl && board.combat) {
      const weapons = ch ? (ch.data.inventario || []).filter((i) => i.tipo === 'arma').map((w, i) => `<option value="${i}">${esc(w.nome)} (${esc(w.dano)})</option>`).join('') || '<option value="-1">Desarmado (1d3)</option>'
        : (t.ataques || []).map((a, i) => `<option value="${i}">${esc(a.nome)}</option>`).join('');
      attack = `<div class="row" style="margin-top:8px"><select id="weaponSel">${weapons}</select><button class="small primary" id="attackBtn">🎯 Atacar</button></div>`;
    }
    return html`<div class="side-box">
      <div class="row">${raw(ch ? avatarHtml(ch.avatarUrl, t.name, 'md') : `<div class="char-avatar md placeholder" style="border-color:${esc(t.color)}">${esc(initials(t.name))}</div>`)}
        <div class="grow"><h3>${t.name}</h3><div class="muted small">${kindName}${ch ? ' · ' + ch.ownerName + ' · ' + rules.classes[ch.data.classe]?.nome + ' NEX ' + ch.data.nex + '%' : ''}${t.hidden ? ' · oculto' : ''}</div></div></div>
      ${raw(t.pvMax ? html`<div class="bar-line"><span>PV</span><div class="bar"><i style="width:${Math.max(0, Math.min(100, (t.pv / t.pvMax) * 100))}%" class="pv"></i></div><b>${t.pv}/${t.pvMax}</b></div>` : '')}
      ${raw(ch ? html`<div class="bar-line"><span>PE</span><div class="bar"><i style="width:${(ch.data.pe / Math.max(1, ch.data.peMax)) * 100}%" class="pe"></i></div><b>${ch.data.pe}/${ch.data.peMax}</b></div>
        <div class="bar-line"><span>SAN</span><div class="bar"><i style="width:${(ch.data.san / Math.max(1, ch.data.sanMax)) * 100}%" class="san"></i></div><b>${ch.data.san}/${ch.data.sanMax}</b></div>` : '')}
      <div class="row wrap small" style="margin-top:6px">${raw(t.defesa !== undefined ? `<span class="badge">Defesa ${t.defesa}</span>` : '')}${raw((t.conditions || []).map((c) => `<span class="badge purple">${esc(c)}</span>`).join(''))}</div>
      ${raw(ctl && t.pvMax ? '<div class="row" style="margin-top:8px"><input type="number" id="hpAmt" value="1" min="1" style="width:70px"><button class="small danger" id="hpDmg">− Dano</button><button class="small" id="hpHeal">+ Cura</button></div>' : '')}
      ${raw(tests)}${raw(attack)}
      <div class="row wrap" style="margin-top:10px">
        ${raw(ch ? `<a class="btn small" href="/personagens/${ch.id}" target="_blank" rel="noopener">Ver ficha</a>` : '')}
        ${raw(isAdmin && !ch ? '<button class="small" id="editTok">Editar</button>' : '')}
        ${raw(isAdmin && !ch ? `<button class="small" id="hideTok">${t.hidden ? 'Mostrar aos jogadores' : 'Ocultar'}</button><button class="small danger" id="delTok">Remover</button>` : '')}
        ${raw(ch && (isAdmin || ch.mine) ? '<button class="small ghost" id="leaveChar">Tirar da campanha</button>' : '')}
      </div></div>`;
  }

  function bindSide() {
    const on = (id, fn) => { const b = $('#' + id, root); if (b) b.onclick = fn; };
    on('startCombat', async () => { const r = await emit('combat:start', { campaignId, clientSeed: randomHex(16) }); if (r.error) toast(r.error, 'err'); });
    on('nextTurn', async () => { const r = await emit('combat:next', { campaignId }); if (r.error) toast(r.error, 'err'); });
    on('endCombat', async () => { if (await confirmBox('Encerrar combate?', 'A ordem de iniciativa será descartada.', 'Encerrar')) { const r = await emit('combat:end', { campaignId }); if (r.error) toast(r.error, 'err'); } });
    $$('.init-list li', root).forEach((li) => { li.onclick = () => { const t = tokenById(li.dataset.tok); if (t) clickToken(t); }; });
    const t = tokenById(selected);
    if (!t) return;
    const hp = async (sign) => {
      const v = Math.abs(Math.round(Number($('#hpAmt', root).value) || 0));
      if (!v) return;
      const r = await emit('token:hp', { campaignId, tokenId: t.id, delta: sign * v });
      if (r.error) toast(r.error, 'err');
    };
    on('hpDmg', () => hp(-1));
    on('hpHeal', () => hp(1));
    on('testBtn', async () => {
      const [k, v] = $('#testSel', root).value.split(':');
      const r = await emit('check:roll', { campaignId, tokenId: t.id, pericia: k === 'p' ? v : undefined, atributo: k === 'a' ? v : undefined, clientSeed: randomHex(16) });
      if (r.error) toast(r.error, 'err');
    });
    on('attackBtn', () => { targeting = { attackerId: t.id, weapon: Number($('#weaponSel', root).value) }; render(); });
    on('editTok', () => tokenForm(t));
    on('hideTok', async () => { try { await api('PUT', `/api/tokens/${t.id}`, { hidden: !t.hidden }); } catch (e) { toast(e.message, 'err'); } });
    on('delTok', async () => { if (await confirmBox('Remover token?', `${t.name} sai do mapa.`, 'Remover', true)) { try { await api('DELETE', `/api/tokens/${t.id}`); selected = null; } catch (e) { toast(e.message, 'err'); } } });
    on('leaveChar', async () => { if (await confirmBox('Tirar da campanha?', `${t.name} sai desta campanha (a ficha continua salva).`, 'Tirar', true)) { try { await api('DELETE', `/api/campaigns/${campaignId}/characters/${t.characterId}`); selected = null; } catch (e) { toast(e.message, 'err'); } } });
  }

  // ---------- barra de ferramentas ----------
  function bindToolbar() {
    const on = (id, fn) => { const b = $('#' + id, root); if (b) b.onclick = fn; };
    on('zoomIn', () => { const bv = $('#bv', root); zoomAt(1.2, bv.clientWidth / 2, bv.clientHeight / 2); });
    on('zoomOut', () => { const bv = $('#bv', root); zoomAt(1 / 1.2, bv.clientWidth / 2, bv.clientHeight / 2); });
    on('fit', fit);
    on('cancelTarget', () => { targeting = null; render(); });
    on('newMap', mapForm);
    on('firstMap', mapForm);
    on('editMap', () => editMapForm(board.map));
    on('addTok', () => tokenForm(null));
    on('bringChar', bringChar);
    on('actMap', async () => {
      const id = $('#mapSel', root).value;
      if (!id) return;
      try { await api('POST', `/api/maps/${id}/activate`); view.fitted = false; toast('Mapa aberto para todos.'); } catch (e) { toast(e.message, 'err'); }
    });
    const mm = $('#moveMode', root);
    if (mm) mm.onchange = async () => { try { await api('PUT', `/api/campaigns/${campaignId}/settings`, { moveMode: mm.value }); } catch (e) { toast(e.message, 'err'); } };
  }

  async function bringChar() {
    const mine = await api('GET', '/api/characters');
    const m = modal(html`<div class="panel-head"><h2>Levar personagem para a mesa</h2><div class="grow"></div><button class="ghost" data-close>✕</button></div>
      <div class="panel-body stack">${raw(mine.length ? mine.map((c) => html`<button class="char-pick" data-c="${c.id}">${raw(avatarHtml(c.avatarUrl, c.data.nome, 'md'))}<div><b>${c.data.nome}</b><div class="muted small">${rules.classes[c.data.classe]?.nome} · NEX ${c.data.nex}%</div></div></button>`).join('')
        : '<p class="muted">Você ainda não tem personagens.</p>')}
        <a class="btn" href="/personagens/novo" target="_blank" rel="noopener">+ Criar personagem (abre em outra aba)</a></div>`, { narrow: true });
    $$('[data-c]', m.root).forEach((b) => b.onclick = async () => {
      try { await api('POST', `/api/campaigns/${campaignId}/characters`, { characterId: b.dataset.c }); m.close(); toast('Personagem na mesa!'); } catch (e) { toast(e.message, 'err'); }
    });
  }

  function mapForm() {
    let img = null;
    const m = modal(html`<div class="panel-head"><h2>Novo mapa</h2><div class="grow"></div><button class="ghost" data-close>✕</button></div>
      <form class="panel-body stack" id="mf">
        <div class="field"><label>Nome</label><input name="name" maxlength="60" placeholder="Ex.: Mansão abandonada" required></div>
        <div class="field"><label>Imagem do mapa (opcional — sem imagem vira um quadriculado em branco)</label><input type="file" id="mapFile" accept="image/png,image/jpeg,image/webp"></div>
        <div id="mapPrev" class="muted small"></div>
        <div class="row"><div class="field grow"><label>Tamanho do quadrado (px)</label><input name="grid" type="number" min="20" max="300" value="70"></div>
          <div class="field grow"><label>Largura (sem imagem)</label><input name="width" type="number" min="300" max="6000" value="1400"></div>
          <div class="field grow"><label>Altura (sem imagem)</label><input name="height" type="number" min="300" max="6000" value="900"></div></div>
        <label class="row small" style="margin:0"><input type="checkbox" name="activate" checked style="width:auto"> Mostrar este mapa para todos agora</label>
        <div class="muted small">Deixe desmarcado para preparar um mapa secreto — só você vê até ativar.</div>
        <div class="row" style="justify-content:flex-end"><button type="button" data-close>Cancelar</button><button class="primary">Criar mapa</button></div></form>`);
    $('#mapFile', m.root).onchange = async (e) => {
      try {
        img = await resizeImage(e.target.files[0], 2200, 0.82);
        $('#mapPrev', m.root).innerHTML = `<img src="${img.dataUrl}" style="max-width:100%;max-height:160px;border-radius:8px"> ${img.width}×${img.height}px`;
      } catch (err) { toast(err.message, 'err'); }
    };
    $('#mf', m.root).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = f.querySelector('button.primary');
      btn.disabled = true;
      try {
        await api('POST', `/api/campaigns/${campaignId}/maps`, { name: f.name.value, grid: Number(f.grid.value), width: img ? img.width : Number(f.width.value), height: img ? img.height : Number(f.height.value), image: img ? img.dataUrl : null, activate: f.activate.checked });
        view.fitted = false;
        m.close();
        toast('Mapa criado!');
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
    };
  }

  function editMapForm(map) {
    const m = modal(html`<div class="panel-head"><h2>Editar mapa</h2><div class="grow"></div><button class="ghost" data-close>✕</button></div>
      <form class="panel-body stack" id="ef">
        <div class="field"><label>Nome</label><input name="name" maxlength="60" value="${map.name}"></div>
        <div class="field"><label>Tamanho do quadrado (px)</label><input name="grid" type="number" min="20" max="300" value="${map.grid}"></div>
        <label class="row small" style="margin:0"><input type="checkbox" name="showGrid" ${map.showGrid ? 'checked' : ''} style="width:auto"> Mostrar grade</label>
        <div class="row" style="justify-content:space-between"><button type="button" class="danger" id="delMap">Apagar mapa</button><div class="row"><button type="button" data-close>Cancelar</button><button class="primary">Salvar</button></div></div></form>`, { narrow: true });
    $('#ef', m.root).onsubmit = async (e) => {
      e.preventDefault();
      try { await api('PUT', `/api/maps/${map.id}`, { name: e.target.name.value, grid: Number(e.target.grid.value), showGrid: e.target.showGrid.checked }); m.close(); } catch (err) { toast(err.message, 'err'); }
    };
    $('#delMap', m.root).onclick = async () => {
      m.close();
      if (await confirmBox('Apagar mapa?', 'O mapa e os tokens de inimigos/NPCs nele serão apagados.', 'Apagar', true)) {
        try { await api('DELETE', `/api/maps/${map.id}`); view.fitted = false; } catch (err) { toast(err.message, 'err'); }
      }
    };
  }

  function tokenForm(t) {
    const s = (t && t.stats) || { atributos: { agi: 1, for: 2, int: 0, pre: 1, vig: 2 }, pvMax: 20, pv: 20, defesa: 12, iniciativa: 0, ataques: [{ nome: 'Garras', dano: '1d6', bonus: 5, critico: 20, multiplicador: 2, pericia: 'luta' }] };
    let img = null;
    const atkRow = (a) => html`<div class="row wrap atk-row small"><input data-a="nome" value="${a.nome}" placeholder="Nome" style="width:120px"><span>Dano</span><input data-a="dano" value="${a.dano}" style="width:70px"><span>Bônus</span><input data-a="bonus" type="number" value="${a.bonus}" style="width:56px"><span>Crít ≥</span><input data-a="critico" type="number" value="${a.critico}" style="width:52px"><span>×</span><input data-a="multiplicador" type="number" value="${a.multiplicador}" style="width:48px"><select data-a="pericia" style="width:auto"><option value="luta" ${a.pericia !== 'pontaria' ? 'selected' : ''}>Luta</option><option value="pontaria" ${a.pericia === 'pontaria' ? 'selected' : ''}>Pontaria</option></select><button type="button" class="ghost small" data-rm>✕</button></div>`;
    const m = modal(html`<div class="panel-head"><h2>${t ? 'Editar ' + t.name : 'Novo inimigo / NPC'}</h2><div class="grow"></div><button class="ghost" data-close>✕</button></div>
      <form class="panel-body stack" id="tf">
        <div class="row wrap">
          <div class="field grow"><label>Nome</label><input name="name" maxlength="40" value="${t ? t.name : ''}" placeholder="Ex.: Zumbi de Sangue" required></div>
          ${raw(t ? '' : '<div class="field"><label>Tipo</label><select name="kind" style="width:auto"><option value="inimigo">Inimigo</option><option value="npc">NPC</option></select></div><div class="field" style="width:90px"><label>Quantos</label><input name="qty" type="number" min="1" max="10" value="1"></div>')}
          <div class="field" style="width:80px"><label>Cor</label><input name="color" type="color" value="${t ? t.color : '#c0392b'}" style="padding:2px;height:44px"></div>
          <div class="field" style="width:90px"><label>Tamanho</label><select name="size">${raw([1, 2, 3, 4].map((n) => `<option value="${n}" ${(t ? t.size : 1) === n ? 'selected' : ''}>${n}×${n}</option>`).join(''))}</select></div>
        </div>
        ${raw(t ? '' : '<div class="field"><label>Imagem do token (opcional)</label><input type="file" id="tokFile" accept="image/png,image/jpeg,image/webp"></div>')}
        <div class="row wrap">
          <div class="field" style="width:100px"><label>PV atual</label><input name="pv" type="number" value="${s.pv}"></div>
          <div class="field" style="width:100px"><label>PV máximo</label><input name="pvMax" type="number" min="1" value="${s.pvMax}"></div>
          <div class="field" style="width:100px"><label>Defesa</label><input name="defesa" type="number" value="${s.defesa}"></div>
          <div class="field" style="width:110px"><label>Bônus inic.</label><input name="iniciativa" type="number" value="${s.iniciativa}"></div>
        </div>
        <div class="row wrap">${raw(rules.atributos.map((a) => html`<div class="field" style="width:80px"><label>${a.id.toUpperCase()}</label><input name="atr_${a.id}" type="number" min="0" max="6" value="${s.atributos[a.id]}"></div>`).join(''))}</div>
        <div><label>Ataques</label><div id="atks">${raw(s.ataques.map(atkRow).join(''))}</div><button type="button" class="small" id="addAtk" style="margin-top:6px">+ Ataque</button></div>
        ${raw(t ? '' : '<label class="row small" style="margin:0"><input type="checkbox" name="hidden" style="width:auto"> Começar oculto (só você vê)</label>')}
        <div class="row" style="justify-content:flex-end"><button type="button" data-close>Cancelar</button><button class="primary">${t ? 'Salvar' : 'Colocar no mapa'}</button></div></form>`);
    const bindRm = () => $$('[data-rm]', m.root).forEach((b) => { b.onclick = () => b.closest('.atk-row').remove(); });
    bindRm();
    $('#addAtk', m.root).onclick = () => { $('#atks', m.root).appendChild(el(atkRow({ nome: 'Ataque', dano: '1d6', bonus: 0, critico: 20, multiplicador: 2, pericia: 'luta' }))); bindRm(); };
    const tf = $('#tokFile', m.root);
    if (tf) tf.onchange = async (e) => { try { img = await resizeImage(e.target.files[0], 256, 0.88); } catch (err) { toast(err.message, 'err'); } };
    $('#tf', m.root).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const stats = {
        pv: Number(f.pv.value), pvMax: Number(f.pvMax.value), defesa: Number(f.defesa.value), iniciativa: Number(f.iniciativa.value),
        atributos: Object.fromEntries(rules.atributos.map((a) => [a.id, Number(f['atr_' + a.id].value)])),
        ataques: $$('.atk-row', m.root).map((r) => Object.fromEntries($$('[data-a]', r).map((i) => [i.dataset.a, i.type === 'number' ? Number(i.value) : i.value]))),
      };
      const body = { name: f.name.value, color: f.color.value, size: Number(f.size.value), stats };
      try {
        if (t) await api('PUT', `/api/tokens/${t.id}`, body);
        else await api('POST', `/api/campaigns/${campaignId}/tokens`, { ...body, kind: f.kind.value, qty: Number(f.qty.value), hidden: f.hidden.checked, image: img ? img.dataUrl : null });
        m.close();
      } catch (err) { toast(err.message, 'err'); }
    };
  }

  // ---------- aba Fichas ----------
  function renderSheets(el2) {
    if (!board) { el2.innerHTML = '<div class="loading"><div class="spinner"></div></div>'; return; }
    el2.innerHTML = html`<div class="panel-body"><div class="row"><h2 class="grow">Personagens na campanha</h2><button class="small purple" id="bring2">+ Levar meu personagem</button></div>
      <div class="sheet-list">${raw(board.characters.length ? board.characters.map((c) => html`<div class="panel sheet-mini">
        <div class="row">${raw(avatarHtml(c.avatarUrl, c.data.nome, 'md'))}<div class="grow"><h3>${c.data.nome}${c.data.apelido ? ` “${c.data.apelido}”` : ''}</h3><div class="muted small">${c.ownerName} · ${rules.classes[c.data.classe]?.nome} · NEX ${c.data.nex}%${c.data.origem ? ' · ' + c.data.origem : ''}</div></div>
        <a class="btn small" href="/personagens/${c.id}" target="_blank" rel="noopener">${c.mine || isAdmin ? 'Editar ficha' : 'Ver ficha'}</a></div>
        <div class="row wrap" style="margin-top:8px"><span class="badge">PV ${c.data.pv}/${c.data.pvMax}</span><span class="badge purple">PE ${c.data.pe}/${c.data.peMax}</span><span class="badge gold">SAN ${c.data.san}/${c.data.sanMax}</span><span class="badge">Defesa ${c.data.defesa}</span>
          ${raw(rules.atributos.map((a) => `<span class="badge">${a.id.toUpperCase()} ${c.data.atributos[a.id]}</span>`).join(''))}${raw((c.data.condicoes || []).map((x) => `<span class="badge purple">${esc(x)}</span>`).join(''))}</div></div>`).join('')
        : '<div class="empty">Nenhum personagem na campanha ainda.</div>')}</div></div>`;
    $('#bring2', el2).onclick = bringChar;
  }

  let mode = 'map';
  return {
    async mount(el2, which = 'map') {
      mode = which;
      root = null; sheetsRoot = null;
      if (mode === 'map') root = el2; else sheetsRoot = el2;
      el2.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      if (!rules) rules = await loadRules();
      if (!board) await fetchBoard();
      if (mode === 'map' && root === el2) render();
      else if (mode !== 'map' && sheetsRoot === el2) renderSheets(el2);
    },
    unmount() { root = null; sheetsRoot = null; targeting = null; },
    refreshSheets(el2) { renderSheets(el2); },
    destroy() { for (const [ev, fn] of Object.entries(handlers)) socket.off(ev, fn); clearTimeout(bannerTimer); root = null; sheetsRoot = null; },
  };
}
