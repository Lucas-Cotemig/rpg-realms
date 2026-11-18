// Biblioteca e editor de personagens (sistema Investigação Paranormal)
import { $, $$, html, raw, el, esc, toast, initials, confirmBox, resizeImage } from './util.js';
import { state, api, loadRules, previewDerived } from './core.js';

const ATR_CURTO = { agi: 'AGI', for: 'FOR', int: 'INT', pre: 'PRE', vig: 'VIG' };

export function avatarHtml(url, name, cls = '') {
  return url ? `<img class="char-avatar ${cls}" src="${esc(url)}" alt="">` : `<div class="char-avatar ${cls} placeholder">${esc(initials(name))}</div>`;
}

export async function viewCharacterList(root, navigate) {
  const rules = await loadRules();
  root.innerHTML = html`<main class="page">
    <div class="hero"><div><a href="/" data-link class="muted small">← Início</a><h1>Meus personagens</h1>
    <div class="muted">Fichas do sistema <b>${rules.nome}</b>. Um personagem pode ser levado para qualquer campanha sua.</div></div>
    <button class="primary" id="newChar">+ Criar personagem</button></div>
    <div id="charList"><div class="loading" style="min-height:120px"><div class="spinner"></div></div></div></main>`;
  $('#newChar').onclick = () => navigate('/personagens/novo');
  const list = await api('GET', '/api/characters');
  const box = $('#charList');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<div class="empty">Nenhum personagem ainda. Crie o primeiro!</div>'; return; }
  box.innerHTML = `<div class="camp-grid">${list.map((c) => html`<a class="panel char-card" href="/personagens/${c.id}" data-link>
    ${raw(avatarHtml(c.avatarUrl, c.data.nome, 'lg'))}
    <div class="grow"><h3>${c.data.nome}</h3><div class="muted small">${rules.classes[c.data.classe]?.nome} · NEX ${c.data.nex}%${c.data.origem ? ' · ' + c.data.origem : ''}</div>
    <div class="row wrap" style="margin-top:8px"><span class="badge">PV ${c.data.pv}/${c.data.pvMax}</span><span class="badge purple">PE ${c.data.pe}/${c.data.peMax}</span><span class="badge gold">SAN ${c.data.san}/${c.data.sanMax}</span></div></div></a>`).join('')}</div>`;
}

function blankSheet() {
  return { nome: '', apelido: '', origem: '', historia: '', classe: 'combatente', nex: 5, atributos: { agi: 1, for: 1, int: 1, pre: 1, vig: 1 }, pericias: {}, inventario: [], dinheiro: 0, experiencia: 0, condicoes: [], anotacoes: '', evolucao: [] };
}

export async function viewCharacterEditor(root, id, navigate) {
  const rules = await loadRules();
  let charRow = null;
  let d = blankSheet();
  let avatar;
  let canEdit = true;
  if (id !== 'novo') {
    try { charRow = await api('GET', `/api/characters/${id}`); } catch (e) { toast(e.message, 'err'); navigate('/personagens', true); return; }
    d = JSON.parse(JSON.stringify(charRow.data));
    canEdit = charRow.canEdit !== false;
  }
  const isOwner = !charRow || charRow.ownerId === state.me.id;
  let dirty = false;

  root.innerHTML = html`<main class="page sheet-page">
    <div class="hero" style="align-items:center"><div><a href="/personagens" data-link class="muted small">← Meus personagens</a>
      <h1 id="sheetTitle">${d.nome || 'Novo personagem'}</h1><div class="muted small">${rules.nome} · ficha ${canEdit ? 'editável' : 'somente leitura'}</div></div>
      <div class="row">${raw(charRow && isOwner ? '<button class="danger small" id="delChar">Apagar</button>' : '')}${raw(canEdit ? '<button class="primary" id="saveChar">Salvar ficha</button>' : '')}</div></div>
    <div class="sheet-grid">
      <section class="panel"><div class="panel-body stack">
        <div class="avatar-edit"><div id="avatarBox">${raw(avatarHtml(charRow?.avatarUrl, d.nome, 'xl'))}</div>
          ${raw(isOwner ? '<label class="btn small" style="margin:0">Trocar imagem<input type="file" id="avatarFile" accept="image/png,image/jpeg,image/webp" hidden></label><div class="muted small">PNG com fundo transparente funciona como token.</div>' : '')}</div>
        <div class="field"><label>Nome</label><input data-f="nome" maxlength="60" value="${d.nome}" placeholder="Ex.: Arthur Cervero"></div>
        <div class="row"><div class="field grow"><label>Apelido</label><input data-f="apelido" maxlength="40" value="${d.apelido}"></div>
          <div class="field grow"><label>Origem</label><input data-f="origem" maxlength="60" value="${d.origem}" placeholder="Ex.: Universitário"></div></div>
        <div class="row"><div class="field grow"><label>Classe</label><select data-f="classe">${raw(Object.entries(rules.classes).map(([k, c]) => `<option value="${k}" ${k === d.classe ? 'selected' : ''}>${esc(c.nome)}</option>`).join(''))}</select></div>
          <div class="field" style="width:110px"><label>NEX</label><select data-f="nex">${raw(rules.nex.map((n) => `<option value="${n}" ${n === Number(d.nex) ? 'selected' : ''}>${n}%</option>`).join(''))}</select></div></div>
        <div class="muted small" id="classDesc"></div>
        <div class="field"><label>História de origem</label><textarea data-f="historia" maxlength="4000" rows="5">${d.historia}</textarea></div>
      </div></section>

      <section class="panel"><div class="panel-body stack">
        <h3>Atributos</h3>
        <div class="attr-row">${raw(rules.atributos.map((a) => html`<div class="attr"><div class="attr-ring"><button type="button" class="ghost small" data-atr="${a.id}:-1">−</button><b data-atr-v="${a.id}">${d.atributos[a.id]}</b><button type="button" class="ghost small" data-atr="${a.id}:1">+</button></div><span>${ATR_CURTO[a.id]}</span><small class="muted">${a.nome}</small></div>`).join(''))}</div>
        <div class="muted small" id="atrHint"></div>
        <div class="stat-row">
          <div class="stat pv"><span>PV</span><div><input type="number" data-f="pv" value="${d.pv ?? ''}"> / <b data-max="pvMax"></b></div></div>
          <div class="stat pe"><span>PE</span><div><input type="number" data-f="pe" value="${d.pe ?? ''}"> / <b data-max="peMax"></b></div></div>
          <div class="stat san"><span>SAN</span><div><input type="number" data-f="san" value="${d.san ?? ''}"> / <b data-max="sanMax"></b></div></div>
          <div class="stat def"><span>DEFESA</span><div><b data-max="defesa"></b></div></div>
        </div>
        <div class="muted small">Os máximos são calculados pelo servidor a partir de classe, NEX e atributos. Deixe PV/PE/SAN vazios para começar cheio.</div>
        <div class="row"><div class="field grow"><label>Dinheiro</label><input type="number" data-f="dinheiro" min="0" value="${d.dinheiro}"></div><div class="field grow"><label>Experiência</label><input type="number" data-f="experiencia" min="0" value="${d.experiencia}"></div></div>
        <div class="field"><label>Condições e efeitos (separe por vírgula)</label><input data-f="condicoes" value="${(d.condicoes || []).join(', ')}" placeholder="Ex.: Abalado, Sangrando"></div>
        <h3 style="margin-top:14px">Perícias</h3>
        <div class="skills">${raw(rules.pericias.map((p) => html`<div class="skill"><span>${p.nome} <small class="muted">${ATR_CURTO[p.atributo]}</small></span>
          <select data-per="${p.id}">${raw(rules.graus.map((g) => `<option value="${g.id}" ${(d.pericias[p.id] || 0) === g.id ? 'selected' : ''}>${esc(g.nome)}${g.bonus ? ' +' + g.bonus : ''}</option>`).join(''))}</select></div>`).join(''))}</div>
      </div></section>

      <section class="panel"><div class="panel-body stack">
        <h3>Inventário e equipamentos</h3>
        <div class="row wrap"><select id="quickWeapon" style="width:auto"><option value="">+ Arma pronta…</option>${raw(rules.armas.map((a, i) => `<option value="${i}">${esc(a.nome)} (${a.dano})</option>`).join(''))}</select>
          <button type="button" class="small" data-add="arma">+ Arma</button><button type="button" class="small" data-add="protecao">+ Proteção</button><button type="button" class="small" data-add="consumivel">+ Consumível</button><button type="button" class="small" data-add="item">+ Item</button></div>
        <div id="inv"></div>
        <div class="field"><label>Anotações</label><textarea data-f="anotacoes" maxlength="4000" rows="4">${d.anotacoes}</textarea></div>
        <h3>Histórico de evolução</h3>
        <div class="muted small">${raw((d.evolucao || []).length ? d.evolucao.slice().reverse().map((e) => `${esc(new Date(e.em).toLocaleDateString('pt-BR'))}: ${esc(e.texto)}`).join('<br>') : 'Mudanças de NEX e classe aparecem aqui automaticamente.')}</div>
      </div></section>
    </div></main>`;

  const setDirty = () => { dirty = true; };
  const refresh = () => {
    const der = previewDerived(d, rules);
    $$('[data-max]', root).forEach((b) => { b.textContent = der[b.dataset.max]; });
    rules.atributos.forEach((a) => { $(`[data-atr-v="${a.id}"]`, root).textContent = d.atributos[a.id]; });
    const total = Object.values(d.atributos).reduce((s, v) => s + v, 0);
    $('#atrHint', root).textContent = `Total de pontos: ${total}. No início (NEX 5%) o normal é 9: todos começam em 1, você distribui mais 4 e pode baixar um para 0 para ganhar 1 ponto extra. Máximo 3 no início.`;
    $('#classDesc', root).textContent = rules.classes[d.classe]?.descricao || '';
    $('#sheetTitle', root).textContent = d.nome || 'Novo personagem';
  };

  $$('[data-f]', root).forEach((inp) => {
    if (!canEdit) inp.disabled = true;
    inp.addEventListener('input', () => {
      const f = inp.dataset.f;
      if (['pv', 'pe', 'san'].includes(f)) d[f] = inp.value === '' ? undefined : Number(inp.value);
      else if (['dinheiro', 'experiencia', 'nex'].includes(f)) d[f] = Number(inp.value) || 0;
      else if (f === 'condicoes') d.condicoes = inp.value.split(',').map((s) => s.trim()).filter(Boolean);
      else d[f] = inp.value;
      setDirty(); refresh();
    });
  });
  $$('[data-atr]', root).forEach((b) => {
    if (!canEdit) b.disabled = true;
    b.onclick = () => { const [k, v] = b.dataset.atr.split(':'); d.atributos[k] = Math.max(0, Math.min(5, d.atributos[k] + Number(v))); setDirty(); refresh(); };
  });
  $$('[data-per]', root).forEach((s) => {
    if (!canEdit) s.disabled = true;
    s.onchange = () => { const g = Number(s.value); if (g) d.pericias[s.dataset.per] = g; else delete d.pericias[s.dataset.per]; setDirty(); };
  });

  function renderInv() {
    const box = $('#inv', root);
    if (!d.inventario.length) { box.innerHTML = '<div class="muted small">Inventário vazio.</div>'; return; }
    box.innerHTML = d.inventario.map((it, i) => html`<div class="inv-item" data-i="${i}">
      <div class="row"><span class="badge ${it.tipo === 'arma' ? 'gold' : it.tipo === 'protecao' ? 'purple' : ''}">${{ arma: 'Arma', protecao: 'Proteção', consumivel: 'Consumível', item: 'Item' }[it.tipo]}</span>
        <input data-k="nome" value="${it.nome}" maxlength="50" class="grow"><input data-k="qtd" type="number" min="0" value="${it.qtd ?? 1}" style="width:64px" title="Quantidade">
        ${raw(['arma', 'protecao'].includes(it.tipo) ? `<label class="small row" style="margin:0;gap:4px"><input type="checkbox" data-k="equipado" ${it.equipado ? 'checked' : ''} style="width:auto">equipado</label>` : '')}
        <button type="button" class="ghost small" data-del="${i}" title="Remover">✕</button></div>
      ${raw(it.tipo === 'arma' ? html`<div class="row wrap small" style="margin-top:6px">Dano <input data-k="dano" value="${it.dano}" style="width:80px"> Crítico ≥ <input data-k="critico" type="number" min="2" max="20" value="${it.critico}" style="width:60px"> ×<input data-k="multiplicador" type="number" min="2" max="5" value="${it.multiplicador}" style="width:54px">
        <select data-k="pericia" style="width:auto"><option value="luta" ${it.pericia === 'luta' ? 'selected' : ''}>Luta (FOR)</option><option value="pontaria" ${it.pericia === 'pontaria' ? 'selected' : ''}>Pontaria (AGI)</option></select> Bônus <input data-k="bonus" type="number" value="${it.bonus || 0}" style="width:60px"></div>` : '')}
      ${raw(it.tipo === 'protecao' ? html`<div class="row small" style="margin-top:6px">Defesa + <input data-k="defesa" type="number" min="0" max="20" value="${it.defesa ?? 2}" style="width:64px"></div>` : '')}
      ${raw(it.tipo === 'consumivel' ? html`<div class="row small" style="margin-top:6px">Cura (dados) <input data-k="cura" value="${it.cura || ''}" placeholder="ex.: 2d8+2" style="width:110px"></div>` : '')}
    </div>`).join('');
    $$('.inv-item', box).forEach((row) => {
      const it = d.inventario[Number(row.dataset.i)];
      $$('[data-k]', row).forEach((inp) => {
        if (!canEdit) inp.disabled = true;
        inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', () => {
          const k = inp.dataset.k;
          it[k] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
          setDirty(); refresh();
        });
      });
    });
    $$('[data-del]', box).forEach((b) => { if (!canEdit) b.disabled = true; b.onclick = () => { d.inventario.splice(Number(b.dataset.del), 1); setDirty(); renderInv(); refresh(); }; });
  }
  const NEW_ITEM = {
    arma: () => ({ nome: 'Arma', tipo: 'arma', qtd: 1, dano: '1d6', critico: 20, multiplicador: 2, pericia: 'luta', bonus: 0, equipado: true }),
    protecao: () => ({ nome: 'Proteção leve', tipo: 'protecao', qtd: 1, defesa: 5, equipado: true }),
    consumivel: () => ({ nome: 'Kit médico', tipo: 'consumivel', qtd: 1, cura: '2d8+2' }),
    item: () => ({ nome: 'Item', tipo: 'item', qtd: 1 }),
  };
  $$('[data-add]', root).forEach((b) => { if (!canEdit) b.disabled = true; b.onclick = () => { d.inventario.push(NEW_ITEM[b.dataset.add]()); setDirty(); renderInv(); refresh(); }; });
  $('#quickWeapon', root).disabled = !canEdit;
  $('#quickWeapon', root).onchange = (e) => {
    const a = rules.armas[Number(e.target.value)];
    if (a) { d.inventario.push({ ...a, tipo: 'arma', qtd: 1, bonus: 0, equipado: true }); setDirty(); renderInv(); }
    e.target.value = '';
  };

  const fileInp = $('#avatarFile', root);
  if (fileInp) fileInp.onchange = async () => {
    try {
      const img = await resizeImage(fileInp.files[0], 320, 0.88);
      avatar = img.dataUrl;
      $('#avatarBox', root).innerHTML = `<img class="char-avatar xl" src="${img.dataUrl}" alt="">`;
      setDirty();
    } catch (e) { toast(e.message, 'err'); }
  };

  const save = $('#saveChar', root);
  if (save) save.onclick = async () => {
    if (!d.nome.trim()) { toast('Dê um nome ao personagem', 'err'); return; }
    save.disabled = true;
    try {
      const body = { data: d };
      if (avatar) body.avatar = avatar;
      const r = charRow ? await api('PUT', `/api/characters/${charRow.id}`, body) : await api('POST', '/api/characters', body);
      dirty = false;
      toast('Ficha salva!');
      if (!charRow) navigate(`/personagens/${r.id}`, true);
      else { charRow = { ...charRow, ...r }; d = JSON.parse(JSON.stringify(r.data)); $$('[data-f="pv"],[data-f="pe"],[data-f="san"]', root).forEach((i) => { i.value = d[i.dataset.f]; }); refresh(); }
    } catch (e) { toast(e.message, 'err'); }
    save.disabled = false;
  };
  const del = $('#delChar', root);
  if (del) del.onclick = async () => {
    if (!(await confirmBox('Apagar personagem?', `${d.nome} será apagado e sairá de todas as campanhas. Isso não pode ser desfeito.`, 'Apagar', true))) return;
    try { await api('DELETE', `/api/characters/${charRow.id}`); toast('Personagem apagado.'); navigate('/personagens', true); } catch (e) { toast(e.message, 'err'); }
  };

  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  renderInv(); refresh();
  return () => window.removeEventListener('beforeunload', beforeUnload);
}
