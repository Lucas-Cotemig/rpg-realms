// Testes de integração: servidor + banco + vários jogadores conectados ao mesmo tempo.
// Rodar com: npm test  (precisa de DATABASE_URL apontando para um banco de teste e AUTH_MODE=dev)
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { io: connect } = require('socket.io-client');
const dice = require('../server/dice');

const BASE = process.env.TEST_BASE || 'http://localhost:3999';
const mkUser = (name) => ({ id: crypto.randomUUID(), name, token: null });
const tok = (u) => `dev:${u.id}:${u.name}`;

async function api(u, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok(u)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
function sock(u) {
  return new Promise((res, rej) => {
    const s = connect(BASE, { auth: { token: tok(u) }, transports: ['websocket'] });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });
}
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const once = (s, ev, filter = () => true, ms = 3000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
  const h = (d) => { if (filter(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
const rid = () => crypto.randomUUID();
const cseed = () => crypto.randomBytes(12).toString('hex');

const mestre = mkUser('Mestre');
const ana = mkUser('Ana');
const beto = mkUser('Beto');
const intruso = mkUser('Intruso');
let camp, code, sM, sA, sB;

test('sem login não acessa', async () => {
  const r = await fetch(BASE + '/api/campaigns');
  assert.strictEqual(r.status, 401);
  await assert.rejects(new Promise((res, rej) => {
    const s = connect(BASE, { auth: { token: 'falso' }, transports: ['websocket'] });
    s.on('connect', () => { s.close(); res(); });
    s.on('connect_error', (e) => { s.close(); rej(e); });
  }));
});

test('cria campanha e valida dados', async () => {
  let r = await api(mestre, 'POST', '/api/campaigns', { name: 'A', universe: 'fantasia', maxPlayers: 3 });
  assert.strictEqual(r.status, 400);
  r = await api(mestre, 'POST', '/api/campaigns', { name: 'A Cripta', universe: 'nao-existe', maxPlayers: 3 });
  assert.strictEqual(r.status, 400);
  r = await api(mestre, 'POST', '/api/campaigns', { name: 'A Cripta do Rei', universe: 'fantasia', maxPlayers: 3, description: 'teste' });
  assert.strictEqual(r.status, 201);
  camp = r.data.id; code = r.data.inviteCode;
  assert.match(code, /^[A-Z2-9]{6}$/);
});

test('jogadores entram pelo código, limite respeitado', async () => {
  assert.strictEqual((await api(ana, 'POST', '/api/campaigns/join', { code: code.toLowerCase() })).status, 200);
  assert.strictEqual((await api(beto, 'POST', '/api/campaigns/join', { code })).status, 200);
  const cheio = await api(intruso, 'POST', '/api/campaigns/join', { code });
  assert.strictEqual(cheio.status, 409);
  assert.strictEqual((await api(intruso, 'GET', `/api/campaigns/${camp}`)).status, 403);
  const d = await api(ana, 'GET', `/api/campaigns/${camp}`);
  assert.strictEqual(d.data.members.length, 3);
  assert.strictEqual(d.data.myRole, 'player');
  assert.ok(d.data.activeSeed.seedHash);
});

test('presença em tempo real', async () => {
  sM = await sock(mestre); sA = await sock(ana); sB = await sock(beto);
  assert.ok((await emit(sM, 'room:join', { campaignId: camp })).ok);
  const p = once(sM, 'presence', (d) => d.userId === ana.id && d.online);
  await emit(sA, 'room:join', { campaignId: camp });
  await p;
  await emit(sB, 'room:join', { campaignId: camp });
  const sI = await sock(intruso);
  assert.ok((await emit(sI, 'room:join', { campaignId: camp })).error);
  sI.close();
});

test('rolagem: todos recebem o mesmo resultado', async () => {
  const recM = once(sM, 'dice:result');
  const recB = once(sB, 'dice:result');
  const res = await emit(sA, 'dice:roll', { campaignId: camp, expression: '3d8 + 2', clientSeed: cseed(), requestId: rid(), label: 'Ataque' });
  assert.ok(res.ok, res.error);
  const [a, b] = await Promise.all([recM, recB]);
  assert.deepStrictEqual(a.roll, res.roll);
  assert.deepStrictEqual(b.roll, res.roll);
  assert.strictEqual(res.roll.expression, '3d8+2');
  const sum = res.roll.terms[0].results.reduce((x, y) => x + y, 0);
  assert.strictEqual(res.roll.total, sum + 2);
  res.roll.terms[0].results.forEach((v) => assert.ok(v >= 1 && v <= 8));
});

test('expressões inválidas são recusadas', async () => {
  for (const e of ['abc', '1d1', '101d6', '1d20; drop table', '']) {
    const r = await emit(sA, 'dice:roll', { campaignId: camp, expression: e, clientSeed: cseed(), requestId: rid() });
    assert.ok(r.error, 'deveria recusar ' + e);
  }
});

test('pedido repetido não gera rolagem nova', async () => {
  const id = rid(); const cs = cseed();
  const a = await emit(sB, 'dice:roll', { campaignId: camp, expression: '1d20', clientSeed: cs, requestId: id });
  const b = await emit(sB, 'dice:roll', { campaignId: camp, expression: '1d20', clientSeed: cs, requestId: id });
  assert.strictEqual(a.roll.id, b.roll.id);
  assert.ok(b.duplicate);
});

test('rolagens simultâneas recebem nonces únicos', async () => {
  const rs = await Promise.all([sM, sA, sB].map((s) => emit(s, 'dice:roll', { campaignId: camp, expression: '1d100', clientSeed: cseed(), requestId: rid() })));
  const nonces = rs.map((r) => r.roll.nonce);
  assert.strictEqual(new Set(nonces).size, 3);
});

test('banco impede alterar ou apagar rolagens', async () => {
  const { pool } = require('../server/db');
  await assert.rejects(pool.query('update rpg.rolls set total=999 where campaign_id=$1', [camp]), /imutável/);
  await assert.rejects(pool.query('delete from rpg.rolls where campaign_id=$1', [camp]), /imutável/);
  await assert.rejects(pool.query('delete from rpg.events where campaign_id=$1', [camp]), /imutável/);
  await assert.rejects(pool.query(`update rpg.seeds set server_seed='00' where campaign_id=$1`, [camp]), /não pode ser alterada/);
  await pool.end();
});

test('semente escondida até a revelação; depois todas as rolagens conferem', async () => {
  let seeds = (await api(ana, 'GET', `/api/campaigns/${camp}/seeds`)).data;
  assert.strictEqual(seeds[0].serverSeed, null);
  assert.strictEqual((await api(ana, 'POST', `/api/campaigns/${camp}/seeds/reveal`)).status, 403);
  const ev = once(sA, 'seed:revealed');
  const r = await api(mestre, 'POST', `/api/campaigns/${camp}/seeds/reveal`);
  assert.strictEqual(r.status, 200);
  await ev;
  seeds = (await api(ana, 'GET', `/api/campaigns/${camp}/seeds`)).data;
  const old = seeds.find((s) => s.revealed);
  const hash = crypto.createHash('sha256').update(Buffer.from(old.serverSeed, 'hex')).digest('hex');
  assert.strictEqual(hash, old.seedHash);
  const rolls = (await api(beto, 'GET', `/api/campaigns/${camp}/rolls`)).data;
  assert.ok(rolls.length >= 5);
  for (const roll of rolls) {
    let i = 0, total = roll.modifier;
    for (const t of roll.terms) for (const v of t.results) {
      assert.strictEqual(dice.dieValue(old.serverSeed, roll.clientSeed, roll.nonce, i++, t.sides), v);
      total += t.sign * v;
    }
    assert.strictEqual(total, roll.total);
  }
  // nova semente já está ativa
  const d = await api(ana, 'GET', `/api/campaigns/${camp}`);
  assert.notStrictEqual(d.data.activeSeed.seedHash, old.seedHash);
});

test('chat geral, privado, narração do mestre e digitando', async () => {
  const typing = once(sB, 'chat:typing', (d) => d.userId === ana.id && d.typing);
  sA.emit('chat:typing', { campaignId: camp, typing: true });
  await typing;

  const geral = once(sB, 'chat:message', (d) => d.message.kind === 'chat');
  await emit(sA, 'chat:send', { campaignId: camp, body: 'Olá grupo!' });
  assert.strictEqual((await geral).message.body, 'Olá grupo!');

  let mestreViuPrivado = false;
  const spy = (d) => { if (d.message.kind === 'private') mestreViuPrivado = true; };
  sM.on('chat:message', spy);
  const priv = once(sB, 'chat:message', (d) => d.message.kind === 'private');
  await emit(sA, 'chat:send', { campaignId: camp, body: 'segredo', to: beto.id });
  assert.strictEqual((await priv).message.recipientId, beto.id);
  await new Promise((r) => setTimeout(r, 300));
  sM.off('chat:message', spy);
  assert.strictEqual(mestreViuPrivado, false);

  const hist = (await api(mestre, 'GET', `/api/campaigns/${camp}/messages`)).data;
  assert.ok(!hist.some((m) => m.kind === 'private'));
  const histB = (await api(beto, 'GET', `/api/campaigns/${camp}/messages`)).data;
  assert.ok(histB.some((m) => m.kind === 'private' && m.body === 'segredo'));

  assert.ok((await emit(sA, 'chat:send', { campaignId: camp, body: 'narro eu', asMaster: true })).error);
  const narr = once(sA, 'chat:message', (d) => d.message.kind === 'mestre');
  await emit(sM, 'chat:send', { campaignId: camp, body: 'A porta range...', asMaster: true });
  await narr;
});

test('mestre remove jogador e ele perde acesso', async () => {
  const removed = once(sB, 'campaign:removed');
  assert.strictEqual((await api(beto, 'DELETE', `/api/campaigns/${camp}/members/${ana.id}`)).status, 403);
  assert.strictEqual((await api(mestre, 'DELETE', `/api/campaigns/${camp}/members/${beto.id}`)).status, 200);
  await removed;
  const r = await emit(sB, 'dice:roll', { campaignId: camp, expression: '1d20', clientSeed: cseed(), requestId: rid() });
  assert.ok(r.error);
  assert.strictEqual((await api(beto, 'GET', `/api/campaigns/${camp}/rolls`)).status, 403);
  const evs = (await api(mestre, 'GET', `/api/campaigns/${camp}/events`)).data.map((e) => e.type);
  for (const t of ['campanha_criada', 'jogador_entrou', 'rolagem', 'semente_revelada', 'jogador_removido']) assert.ok(evs.includes(t), t);
  [sM, sA, sB].forEach((s) => s.close());
});
