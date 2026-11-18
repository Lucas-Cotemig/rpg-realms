// Testes das etapas de personagens, mapa e combate (servidor + banco + vários jogadores)
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { io: connect } = require('socket.io-client');

const BASE = process.env.TEST_BASE || 'http://localhost:3999';
const mk = (name) => ({ id: crypto.randomUUID(), name });
const tok = (u) => `dev:${u.id}:${u.name}`;
async function api(u, method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok(u)}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const sock = (u) => new Promise((res, rej) => { const s = connect(BASE, { auth: { token: tok(u) }, transports: ['websocket'] }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const once = (s, ev, f = () => true, ms = 4000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms); const h = (d) => { if (f(d)) { clearTimeout(t); s.off(ev, h); res(d); } }; s.on(ev, h); });
const seed = () => crypto.randomBytes(12).toString('hex');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const mestre = mk('Mestre'); const ana = mk('Ana');
let camp, sM, sA, charId, board;

test('ficha é validada e calculada no servidor', async () => {
  const r = await api(ana, 'POST', '/api/characters', { data: { nome: 'Arthur', classe: 'combatente', nex: 10, atributos: { agi: 2, for: 3, int: 1, pre: 1, vig: 9 }, pericias: { luta: 2, pontaria: 7, inexistente: 1 },
    inventario: [{ nome: 'Machadinha', tipo: 'arma', dano: '1d6', critico: 20, multiplicador: 3, pericia: 'luta' }, { nome: 'Colete', tipo: 'protecao', defesa: 2, equipado: true }], pv: 999 }, avatar: PNG });
  assert.strictEqual(r.status, 201);
  const d = r.data.data;
  charId = r.data.id;
  assert.strictEqual(d.atributos.vig, 5); // limitado a 5
  assert.strictEqual(d.pericias.pontaria, 3); // limitado a expert
  assert.ok(!('inexistente' in d.pericias));
  assert.strictEqual(d.pvMax, 20 + 5 + (4 + 5)); // NEX 10% = nível 2
  assert.strictEqual(d.pv, d.pvMax);
  assert.strictEqual(d.defesa, 10 + 2 + 2);
  assert.ok(r.data.avatarUrl);
  assert.strictEqual((await api(mestre, 'GET', `/api/characters/${charId}`)).status, 403);
  assert.strictEqual((await api(ana, 'POST', '/api/characters', { avatar: 'data:text/html;base64,AAAA' })).status, 400);
});

test('campanha, mapa e personagem na mesa', async () => {
  camp = (await api(mestre, 'POST', '/api/campaigns', { name: 'Sessão Paranormal', universe: 'terror', maxPlayers: 4 })).data;
  await api(ana, 'POST', '/api/campaigns/join', { code: camp.inviteCode });
  assert.strictEqual((await api(ana, 'POST', `/api/campaigns/${camp.id}/maps`, { name: 'x', image: PNG })).status, 403);
  assert.strictEqual((await api(mestre, 'POST', `/api/campaigns/${camp.id}/maps`, { name: 'Mansão', image: PNG, width: 1400, height: 900, grid: 70 })).status, 201);
  assert.strictEqual((await api(ana, 'POST', `/api/campaigns/${camp.id}/characters`, { characterId: charId })).status, 200);
  assert.strictEqual((await api(ana, 'POST', `/api/campaigns/${camp.id}/characters`, { characterId: charId })).status, 409);
  // mestre agora vê a ficha da Ana
  assert.strictEqual((await api(mestre, 'GET', `/api/characters/${charId}`)).status, 200);
  assert.strictEqual((await api(mestre, 'POST', `/api/campaigns/${camp.id}/tokens`, { kind: 'inimigo', name: 'Zumbi de Sangue', stats: { pvMax: 30, defesa: 12, atributos: { agi: 1, for: 3, int: 0, pre: 1, vig: 3 }, ataques: [{ nome: 'Garras', dano: '1d8', bonus: 5, critico: 19, multiplicador: 2 }] } })).status, 201);
  assert.strictEqual((await api(mestre, 'POST', `/api/campaigns/${camp.id}/tokens`, { kind: 'inimigo', name: 'Criatura Oculta', hidden: true })).status, 201);
  const bA = (await api(ana, 'GET', `/api/campaigns/${camp.id}/board`)).data;
  const bM = (await api(mestre, 'GET', `/api/campaigns/${camp.id}/board`)).data;
  assert.strictEqual(bM.tokens.length, 3);
  assert.strictEqual(bA.tokens.length, 2, 'jogador não vê token oculto');
  assert.ok(!bA.maps, 'jogador não vê a lista de mapas secretos');
  assert.strictEqual(bA.tokens.find((t) => t.kind === 'inimigo').defesa, undefined, 'jogador não vê a defesa do inimigo');
  board = bM;
});

test('movimento sincronizado e com permissão', async () => {
  sM = await sock(mestre); sA = await sock(ana);
  await emit(sM, 'room:join', { campaignId: camp.id });
  await emit(sA, 'room:join', { campaignId: camp.id });
  const pc = board.tokens.find((t) => t.kind === 'pc');
  const zumbi = board.tokens.find((t) => t.name === 'Zumbi de Sangue');
  const oculto = board.tokens.find((t) => t.hidden);
  const seen = once(sM, 'token:moved', (d) => d.tokenId === pc.id);
  assert.ok((await emit(sA, 'token:move', { campaignId: camp.id, tokenId: pc.id, x: 210, y: 140 })).ok);
  assert.strictEqual((await seen).x, 210);
  assert.ok((await emit(sA, 'token:move', { campaignId: camp.id, tokenId: zumbi.id, x: 1, y: 1 })).error, 'jogador não move inimigo');
  let anaViuOculto = false;
  const spy = (d) => { if (d.tokenId === oculto.id) anaViuOculto = true; };
  sA.on('token:moved', spy);
  assert.ok((await emit(sM, 'token:move', { campaignId: camp.id, tokenId: oculto.id, x: 500, y: 500 })).ok);
  await new Promise((r) => setTimeout(r, 300));
  sA.off('token:moved', spy);
  assert.strictEqual(anaViuOculto, false);
  const fora = await emit(sM, 'token:move', { campaignId: camp.id, tokenId: zumbi.id, x: 99999, y: -5 });
  assert.ok(fora.ok);
  const b = (await api(mestre, 'GET', `/api/campaigns/${camp.id}/board`)).data;
  const z = b.tokens.find((t) => t.id === zumbi.id);
  assert.strictEqual(z.x, 1400); assert.strictEqual(z.y, 0);
});

test('teste de perícia com dados do servidor', async () => {
  const pc = board.tokens.find((t) => t.kind === 'pc');
  const roll = once(sM, 'dice:result');
  assert.ok((await emit(sA, 'check:roll', { campaignId: camp.id, tokenId: pc.id, pericia: 'luta', clientSeed: seed() })).ok);
  const r = (await roll).roll;
  assert.strictEqual(r.expression, '3d20kh+10');
  assert.strictEqual(r.total, Math.max(...r.terms[0].results) + 10);
});

test('combate: iniciativa, turno, ataque e dano aplicado', async () => {
  const pc = board.tokens.find((t) => t.kind === 'pc');
  const zumbi = board.tokens.find((t) => t.name === 'Zumbi de Sangue');
  assert.ok((await emit(sA, 'combat:start', { campaignId: camp.id, clientSeed: seed() })).error);
  assert.ok((await emit(sA, 'combat:attack', { campaignId: camp.id, attackerId: pc.id, targetId: zumbi.id, weapon: 0, clientSeed: seed() })).error, 'sem combate não ataca');
  const st = once(sA, 'board:state', (d) => d.board.combat);
  assert.ok((await emit(sM, 'combat:start', { campaignId: camp.id, clientSeed: seed() })).ok);
  let combat = (await st).board.combat;
  assert.strictEqual(combat.order.length, 3);
  assert.ok(combat.order.some((o) => o.name === '???'), 'oculto aparece como ??? para jogadores');
  // passa turnos até chegar na vez da Ana
  for (let i = 0; i < 3 && combat.order[combat.turn].tokenId !== pc.id; i++) {
    const next = once(sA, 'board:state');
    assert.ok((await emit(sM, 'combat:next', { campaignId: camp.id })).ok);
    combat = (await next).board.combat;
  }
  assert.strictEqual(combat.order[combat.turn].tokenId, pc.id);
  // ataques repetidos até acertar, conferindo o dano aplicado
  let acertou = false;
  for (let i = 0; i < 8 && !acertou; i++) {
    const msg = once(sA, 'chat:message', (d) => d.message.body.startsWith('⚔ Arthur atacou'));
    const r = await emit(sA, 'combat:attack', { campaignId: camp.id, attackerId: pc.id, targetId: zumbi.id, weapon: 0, clientSeed: seed() });
    assert.ok(r.ok, r.error);
    const body = (await msg).message.body;
    acertou = /acertou|CRÍTICO/.test(body);
    await new Promise((res) => setTimeout(res, 800));
  }
  assert.ok(acertou, 'com +10 contra defesa 12 deveria acertar');
  const b = (await api(mestre, 'GET', `/api/campaigns/${camp.id}/board`)).data;
  assert.ok(b.tokens.find((t) => t.id === zumbi.id).pv < 30);
  const evs = (await api(mestre, 'GET', `/api/campaigns/${camp.id}/events`)).data.map((e) => e.type);
  for (const t of ['combate_iniciado', 'turno_passado', 'ataque', 'vida_alterada', 'personagem_entrou', 'mapa_criado']) assert.ok(evs.includes(t), t);
});

test('regra "só na vez": fora do turno não move', async () => {
  assert.strictEqual((await api(mestre, 'PUT', `/api/campaigns/${camp.id}/settings`, { moveMode: 'turno' })).status, 200);
  const pc = board.tokens.find((t) => t.kind === 'pc');
  const next = once(sA, 'board:state');
  await emit(sM, 'combat:next', { campaignId: camp.id });
  await next;
  const r = await emit(sA, 'token:move', { campaignId: camp.id, tokenId: pc.id, x: 300, y: 300 });
  assert.match(r.error || '', /vez/);
  assert.ok((await emit(sM, 'combat:end', { campaignId: camp.id })).ok);
  assert.ok((await emit(sA, 'token:move', { campaignId: camp.id, tokenId: pc.id, x: 300, y: 300 })).ok);
  [sM, sA].forEach((s) => s.close());
});
