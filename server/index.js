// RPG Realms — servidor principal (API REST + tempo real com Socket.IO)
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { q, tx, migrate } = require('./db');
const { verifyToken, httpAuth, invalidateUser, DEV } = require('./auth');
const dice = require('./dice');
const UNIVERSES = require('./universes');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, maxHttpBufferSize: 64 * 1024 });

// ---------- utilidades ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const clean = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max) : '');

function inviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

async function logEvent(db, ev) {
  const r = await db.query(
    `insert into rpg.events(campaign_id, user_id, type, state_before, state_after, result, consequences)
     values ($1,$2,$3,$4,$5,$6,$7) returning id, created_at`,
    [ev.campaignId, ev.userId || null, ev.type, ev.before || null, ev.after || null, ev.result || null, ev.consequences || null]
  );
  return r.rows[0];
}

async function membership(campaignId, userId) {
  if (!isUuid(campaignId)) return null;
  const r = await q('select role from rpg.members where campaign_id=$1 and user_id=$2', [campaignId, userId]);
  return r.rows[0] ? r.rows[0].role : null;
}

async function requireMember(campaignId, userId, admin = false) {
  const role = await membership(campaignId, userId);
  if (!role) throw new HttpError(403, 'Você não participa desta campanha');
  if (admin && role !== 'admin') throw new HttpError(403, 'Somente o administrador da sala pode fazer isso');
  return role;
}

async function ensureSeed(db, campaignId) {
  const r = await db.query(
    'select * from rpg.seeds where campaign_id=$1 and revealed=false order by created_at desc limit 1 for update',
    [campaignId]
  );
  if (r.rows[0]) return r.rows[0];
  const s = dice.newSeed();
  const ins = await db.query(
    'insert into rpg.seeds(campaign_id, seed_hash, server_seed) values ($1,$2,$3) returning *',
    [campaignId, s.hash, s.seed]
  );
  return ins.rows[0];
}

async function campaignMembers(campaignId) {
  const r = await q(
    `select m.user_id, m.role, m.joined_at, p.display_name
       from rpg.members m join rpg.profiles p on p.user_id=m.user_id
      where m.campaign_id=$1 order by m.joined_at`,
    [campaignId]
  );
  return r.rows.map((x) => ({ userId: x.user_id, role: x.role, joinedAt: x.joined_at, displayName: x.display_name, online: isOnline(campaignId, x.user_id) }));
}

function rollDto(r) {
  return {
    id: Number(r.id), userId: r.user_id, displayName: r.display_name, requestId: r.request_id,
    expression: r.expression, label: r.label, terms: r.terms, modifier: r.modifier, total: r.total,
    seedId: r.seed_id, seedHash: r.seed_hash, nonce: r.nonce, clientSeed: r.client_seed, createdAt: r.created_at,
  };
}
function msgDto(m) {
  return { id: Number(m.id), userId: m.user_id, recipientId: m.recipient_id, kind: m.kind, body: m.body, createdAt: m.created_at, displayName: m.display_name, recipientName: m.recipient_name };
}

// ---------- presença em memória ----------
const presence = new Map(); // campaignId -> Map(userId -> nº de conexões)
function isOnline(cid, uid) { return !!(presence.get(cid) && presence.get(cid).get(uid)); }
function presenceAdd(cid, uid) {
  if (!presence.has(cid)) presence.set(cid, new Map());
  const m = presence.get(cid);
  m.set(uid, (m.get(uid) || 0) + 1);
  return m.get(uid) === 1;
}
function presenceRemove(cid, uid) {
  const m = presence.get(cid);
  if (!m) return false;
  const n = (m.get(uid) || 1) - 1;
  if (n <= 0) { m.delete(uid); return true; }
  m.set(uid, n);
  return false;
}
function onlineList(cid) { return [...(presence.get(cid) || new Map()).keys()]; }

// ---------- limite de frequência ----------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 60000) buckets.delete(k); }, 60000).unref();

// ---------- API ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({ supabaseUrl: process.env.SUPABASE_URL || '', supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '', devAuth: DEV });
});

app.get('/api/universes', (req, res) => res.json(UNIVERSES));

app.get('/api/me', httpAuth, (req, res) => res.json(req.user));

app.put('/api/me', httpAuth, wrap(async (req, res) => {
  const name = clean(req.body.displayName, 40);
  if (name.length < 2) throw new HttpError(400, 'O nome precisa ter pelo menos 2 letras');
  await q('update rpg.profiles set display_name=$1 where user_id=$2', [name, req.user.id]);
  invalidateUser(req.user.id);
  res.json({ ...req.user, displayName: name });
}));

app.get('/api/campaigns', httpAuth, wrap(async (req, res) => {
  const r = await q(
    `select c.id, c.name, c.universe, c.description, c.max_players, c.created_at, c.updated_at, m.role,
            (select count(*) from rpg.members x where x.campaign_id=c.id)::int as players,
            p.display_name as owner_name
       from rpg.members m join rpg.campaigns c on c.id=m.campaign_id
       join rpg.profiles p on p.user_id=c.owner_id
      where m.user_id=$1 order by c.updated_at desc`,
    [req.user.id]
  );
  res.json(r.rows.map((c) => ({ ...c, online: onlineList(c.id).length })));
}));

app.post('/api/campaigns', httpAuth, wrap(async (req, res) => {
  const name = clean(req.body.name, 60);
  const description = clean(req.body.description, 500);
  const universe = UNIVERSES.find((u) => u.id === req.body.universe);
  const maxPlayers = Number(req.body.maxPlayers);
  if (name.length < 3) throw new HttpError(400, 'Dê um nome com pelo menos 3 letras para a campanha');
  if (!universe) throw new HttpError(400, 'Escolha um universo');
  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 20) throw new HttpError(400, 'O limite de participantes deve ser entre 2 e 20');

  const campaign = await tx(async (db) => {
    let c;
    for (let i = 0; i < 5 && !c; i++) {
      try {
        await db.query('savepoint code');
        const r = await db.query(
          `insert into rpg.campaigns(name, universe, description, invite_code, max_players, owner_id)
           values ($1,$2,$3,$4,$5,$6) returning *`,
          [name, universe.id, description, inviteCode(), maxPlayers, req.user.id]
        );
        c = r.rows[0];
      } catch (e) {
        if (e.code !== '23505') throw e;
        await db.query('rollback to savepoint code');
      }
    }
    if (!c) throw new HttpError(500, 'Não foi possível gerar um código. Tente de novo.');
    await db.query(`insert into rpg.members(campaign_id, user_id, role) values ($1,$2,'admin')`, [c.id, req.user.id]);
    await ensureSeed(db, c.id);
    await logEvent(db, { campaignId: c.id, userId: req.user.id, type: 'campanha_criada', after: { name, universe: universe.id, maxPlayers } });
    return c;
  });
  res.status(201).json({ id: campaign.id, inviteCode: campaign.invite_code });
}));

app.post('/api/campaigns/join', httpAuth, wrap(async (req, res) => {
  const code = clean(req.body.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) throw new HttpError(400, 'O código de convite tem 6 caracteres');
  const out = await tx(async (db) => {
    const r = await db.query('select * from rpg.campaigns where invite_code=$1 for update', [code]);
    const c = r.rows[0];
    if (!c) throw new HttpError(404, 'Nenhuma campanha encontrada com esse código');
    const already = await db.query('select 1 from rpg.members where campaign_id=$1 and user_id=$2', [c.id, req.user.id]);
    if (already.rowCount) return { id: c.id, already: true };
    const count = await db.query('select count(*)::int n from rpg.members where campaign_id=$1', [c.id]);
    if (count.rows[0].n >= c.max_players) throw new HttpError(409, 'Esta campanha já está cheia');
    await db.query(`insert into rpg.members(campaign_id, user_id, role) values ($1,$2,'player')`, [c.id, req.user.id]);
    await db.query('update rpg.campaigns set updated_at=now() where id=$1', [c.id]);
    await logEvent(db, { campaignId: c.id, userId: req.user.id, type: 'jogador_entrou', before: { players: count.rows[0].n }, after: { players: count.rows[0].n + 1 } });
    const m = await db.query(`insert into rpg.messages(campaign_id, kind, body) values ($1,'system',$2) returning *`, [c.id, `${req.user.displayName} entrou na campanha.`]);
    return { id: c.id, already: false, message: m.rows[0] };
  });
  if (!out.already) {
    io.to(`c:${out.id}`).emit('chat:message', { campaignId: out.id, message: msgDto(out.message) });
    io.to(`c:${out.id}`).emit('members:update', { campaignId: out.id, members: await campaignMembers(out.id) });
  }
  res.json({ id: out.id });
}));

app.get('/api/campaigns/:id', httpAuth, wrap(async (req, res) => {
  const role = await requireMember(req.params.id, req.user.id);
  const r = await q('select * from rpg.campaigns where id=$1', [req.params.id]);
  const c = r.rows[0];
  const seed = await q('select id, seed_hash, next_nonce, created_at from rpg.seeds where campaign_id=$1 and revealed=false order by created_at desc limit 1', [c.id]);
  res.json({
    id: c.id, name: c.name, universe: c.universe, description: c.description, maxPlayers: c.max_players,
    ownerId: c.owner_id, createdAt: c.created_at, myRole: role,
    inviteCode: role === 'admin' ? c.invite_code : null,
    members: await campaignMembers(c.id),
    activeSeed: seed.rows[0] ? { id: seed.rows[0].id, seedHash: seed.rows[0].seed_hash, rolls: seed.rows[0].next_nonce, createdAt: seed.rows[0].created_at } : null,
  });
}));

app.post('/api/campaigns/:id/code', httpAuth, wrap(async (req, res) => {
  await requireMember(req.params.id, req.user.id, true);
  const code = await tx(async (db) => {
    for (let i = 0; i < 5; i++) {
      const c = inviteCode();
      await db.query('savepoint code');
      try {
        const old = await db.query('select invite_code from rpg.campaigns where id=$1', [req.params.id]);
        await db.query('update rpg.campaigns set invite_code=$1, updated_at=now() where id=$2', [c, req.params.id]);
        await logEvent(db, { campaignId: req.params.id, userId: req.user.id, type: 'codigo_renovado', consequences: { codigoAnteriorInvalidado: true }, before: { code: old.rows[0].invite_code.slice(0, 2) + '••••' } });
        return c;
      } catch (e) {
        if (e.code !== '23505') throw e;
        await db.query('rollback to savepoint code');
      }
    }
    throw new HttpError(500, 'Tente novamente');
  });
  res.json({ inviteCode: code });
}));

app.put('/api/campaigns/:id', httpAuth, wrap(async (req, res) => {
  await requireMember(req.params.id, req.user.id, true);
  const maxPlayers = Number(req.body.maxPlayers);
  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 20) throw new HttpError(400, 'O limite deve ser entre 2 e 20');
  const n = (await q('select count(*)::int n from rpg.members where campaign_id=$1', [req.params.id])).rows[0].n;
  if (maxPlayers < n) throw new HttpError(400, `A sala já tem ${n} participantes`);
  await tx(async (db) => {
    const old = await db.query('select max_players from rpg.campaigns where id=$1 for update', [req.params.id]);
    await db.query('update rpg.campaigns set max_players=$1, updated_at=now() where id=$2', [maxPlayers, req.params.id]);
    await logEvent(db, { campaignId: req.params.id, userId: req.user.id, type: 'limite_alterado', before: { maxPlayers: old.rows[0].max_players }, after: { maxPlayers } });
  });
  io.to(`c:${req.params.id}`).emit('campaign:update', { campaignId: req.params.id, maxPlayers });
  res.json({ ok: true });
}));

async function removeMember(campaignId, userId, byUserId, type) {
  const msg = await tx(async (db) => {
    const p = await db.query('select display_name from rpg.profiles where user_id=$1', [userId]);
    const del = await db.query(`delete from rpg.members where campaign_id=$1 and user_id=$2 and role<>'admin'`, [campaignId, userId]);
    if (!del.rowCount) throw new HttpError(400, 'Este participante não pode ser removido');
    await logEvent(db, { campaignId, userId: byUserId, type, result: { userId } });
    const text = type === 'jogador_saiu' ? `${p.rows[0].display_name} saiu da campanha.` : `${p.rows[0].display_name} foi removido da campanha.`;
    return (await db.query(`insert into rpg.messages(campaign_id, kind, body) values ($1,'system',$2) returning *`, [campaignId, text])).rows[0];
  });
  // desconecta o jogador removido da sala
  const sockets = await io.in(`u:${userId}`).fetchSockets();
  for (const s of sockets) {
    if (s.rooms.has(`c:${campaignId}`)) {
      s.leave(`c:${campaignId}`);
      s.emit('campaign:removed', { campaignId });
      if (s.data.campaigns) s.data.campaigns.delete(campaignId);
    }
  }
  presence.get(campaignId) && presence.get(campaignId).delete(userId);
  io.to(`c:${campaignId}`).emit('chat:message', { campaignId, message: msgDto(msg) });
  io.to(`c:${campaignId}`).emit('members:update', { campaignId, members: await campaignMembers(campaignId) });
}

app.delete('/api/campaigns/:id/members/:uid', httpAuth, wrap(async (req, res) => {
  await requireMember(req.params.id, req.user.id, true);
  if (!isUuid(req.params.uid)) throw new HttpError(400, 'Participante inválido');
  await removeMember(req.params.id, req.params.uid, req.user.id, 'jogador_removido');
  res.json({ ok: true });
}));

app.post('/api/campaigns/:id/leave', httpAuth, wrap(async (req, res) => {
  const role = await requireMember(req.params.id, req.user.id);
  if (role === 'admin') throw new HttpError(400, 'O administrador não pode sair da própria campanha');
  await removeMember(req.params.id, req.user.id, req.user.id, 'jogador_saiu');
  res.json({ ok: true });
}));

app.get('/api/campaigns/:id/rolls', httpAuth, wrap(async (req, res) => {
  await requireMember(req.params.id, req.user.id);
  const before = Number(req.query.before) || null;
  const seed = isUuid(req.query.seed) ? req.query.seed : null;
  const r = await q(
    `select r.*, p.display_name from rpg.rolls r join rpg.profiles p on p.user_id=r.user_id
      where r.campaign_id=$1 and ($2::bigint is null or r.id < $2) and ($3::uuid is null or r.seed_id = $3)
      order by r.id desc limit ${seed ? 1000 : 50}`,
    [req.params.id, before, seed]
  );
  res.json(r.rows.map(rollDto));
}));

app.get('/api/campaigns/:id/messages', httpAuth, wrap(async (req, res) => {
  await requireMember(req.params.id, req.user.id);
  const before = Number(req.query.before) || null;
  const r = await q(
    `select m.*, p.display_name, rp.display_name as recipient_name
       from rpg.messages m left join rpg.profiles p on p.user_id=m.user_id
       left join rpg.profiles rp on rp.user_id=m.recipient_id
      where m.campaign_id=$1 and ($3::bigint is null or m.id < $3)
        and (m.kind <> 'private' or m.user_id=$2 or m.recipient_id=$2)
      order by m.id desc limit 80`,
    [req.params.id, req.user.id, before]
  );
  res.json(r.rows.map(msgDto).reverse());
}));

app.get('/api/campaigns/:id/seeds', httpAuth, wrap(async (req, res) => {
  await requireMember(req.params.id, req.user.id);
  const r = await q(
    `select id, seed_hash, case when revealed then server_seed else null end as server_seed,
            next_nonce, revealed, created_at, revealed_at
       from rpg.seeds where campaign_id=$1 order by created_at desc`,
    [req.params.id]
  );
  res.json(r.rows.map((s) => ({ id: s.id, seedHash: s.seed_hash, serverSeed: s.server_seed, rolls: s.next_nonce, revealed: s.revealed, createdAt: s.created_at, revealedAt: s.revealed_at })));
}));

app.post('/api/campaigns/:id/seeds/reveal', httpAuth, wrap(async (req, res) => {
  await requireMember(req.params.id, req.user.id, true);
  const out = await tx(async (db) => {
    const cur = await ensureSeed(db, req.params.id);
    await db.query('update rpg.seeds set revealed=true, revealed_at=now() where id=$1', [cur.id]);
    const s = dice.newSeed();
    const next = (await db.query('insert into rpg.seeds(campaign_id, seed_hash, server_seed) values ($1,$2,$3) returning *', [req.params.id, s.hash, s.seed])).rows[0];
    await logEvent(db, { campaignId: req.params.id, userId: req.user.id, type: 'semente_revelada', result: { seedId: cur.id, seedHash: cur.seed_hash, rolls: cur.next_nonce }, after: { novaSemente: next.seed_hash } });
    const msg = (await db.query(`insert into rpg.messages(campaign_id, kind, body) values ($1,'system',$2) returning *`, [req.params.id, `Semente dos dados revelada (${cur.next_nonce} rolagens). Qualquer um pode conferir as rolagens agora.`])).rows[0];
    return { revealed: { id: cur.id, seedHash: cur.seed_hash, serverSeed: cur.server_seed, rolls: cur.next_nonce }, next: { id: next.id, seedHash: next.seed_hash, rolls: 0, createdAt: next.created_at }, msg };
  });
  io.to(`c:${req.params.id}`).emit('seed:revealed', { campaignId: req.params.id, revealed: out.revealed, activeSeed: out.next });
  io.to(`c:${req.params.id}`).emit('chat:message', { campaignId: req.params.id, message: msgDto(out.msg) });
  res.json(out);
}));

app.get('/api/campaigns/:id/events', httpAuth, wrap(async (req, res) => {
  await requireMember(req.params.id, req.user.id);
  const r = await q(
    `select e.*, p.display_name from rpg.events e left join rpg.profiles p on p.user_id=e.user_id
      where e.campaign_id=$1 order by e.id desc limit 200`,
    [req.params.id]
  );
  res.json(r.rows.map((e) => ({ id: Number(e.id), type: e.type, userId: e.user_id, displayName: e.display_name, before: e.state_before, after: e.state_after, result: e.result, consequences: e.consequences, createdAt: e.created_at })));
}));

// ---------- arquivos do site ----------
app.use('/vendor/supabase.js', express.static(require.resolve('@supabase/supabase-js/dist/umd/supabase.js')));
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false, maxAge: '1h' }));
app.get(/^\/(?!api\/|socket\.io\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Erro no servidor. Tente de novo.' : err.message });
});

// ---------- tempo real ----------
io.use(async (socket, next) => {
  try {
    const user = await verifyToken(socket.handshake.auth && socket.handshake.auth.token);
    if (!user) return next(new Error('nao_autenticado'));
    socket.data.user = user;
    socket.data.campaigns = new Set();
    next();
  } catch (e) {
    next(new Error('erro_servidor'));
  }
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  socket.join(`u:${user.id}`);

  const guard = (handler) => async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      await handler(payload || {}, reply);
    } catch (e) {
      if (!(e instanceof HttpError) && !(e instanceof dice.DiceError)) console.error(e);
      reply({ error: e instanceof HttpError || e instanceof dice.DiceError ? e.message : 'Erro no servidor' });
    }
  };

  const inRoom = (cid) => {
    if (!socket.data.campaigns.has(cid)) throw new HttpError(403, 'Entre na sala primeiro');
  };

  socket.on('room:join', guard(async ({ campaignId }, reply) => {
    await requireMember(campaignId, user.id);
    if (!socket.data.campaigns.has(campaignId)) {
      socket.join(`c:${campaignId}`);
      socket.data.campaigns.add(campaignId);
      if (presenceAdd(campaignId, user.id)) socket.to(`c:${campaignId}`).emit('presence', { campaignId, userId: user.id, online: true });
    }
    reply({ ok: true, online: onlineList(campaignId) });
  }));

  socket.on('room:leave', guard(async ({ campaignId }, reply) => {
    if (socket.data.campaigns.delete(campaignId)) {
      socket.leave(`c:${campaignId}`);
      if (presenceRemove(campaignId, user.id)) io.to(`c:${campaignId}`).emit('presence', { campaignId, userId: user.id, online: false });
    }
    reply({ ok: true });
  }));

  socket.on('chat:typing', guard(async ({ campaignId, typing }) => {
    if (!socket.data.campaigns.has(campaignId)) return;
    if (!rateLimit(`t:${user.id}`, 20, 5000)) return;
    socket.to(`c:${campaignId}`).emit('chat:typing', { campaignId, userId: user.id, displayName: user.displayName, typing: !!typing });
  }));

  socket.on('chat:send', guard(async ({ campaignId, body, to, asMaster }, reply) => {
    inRoom(campaignId);
    const role = await requireMember(campaignId, user.id);
    const text = clean(body, 1000);
    if (!text) throw new HttpError(400, 'Mensagem vazia');
    if (!rateLimit(`m:${user.id}`, 10, 5000)) throw new HttpError(429, 'Calma! Muitas mensagens seguidas.');
    let kind = 'chat';
    let recipient = null;
    if (to) {
      if (!isUuid(to) || to === user.id) throw new HttpError(400, 'Destinatário inválido');
      if (!(await membership(campaignId, to))) throw new HttpError(400, 'Esse jogador não está na campanha');
      kind = 'private';
      recipient = to;
    } else if (asMaster) {
      if (role !== 'admin') throw new HttpError(403, 'Só o mestre pode narrar');
      kind = 'mestre';
    }
    const r = await q(
      `with m as (insert into rpg.messages(campaign_id, user_id, recipient_id, kind, body) values ($1,$2,$3,$4,$5) returning *)
       select m.*, p.display_name, rp.display_name as recipient_name from m
         join rpg.profiles p on p.user_id=m.user_id left join rpg.profiles rp on rp.user_id=m.recipient_id`,
      [campaignId, user.id, recipient, kind, text]
    );
    const message = msgDto(r.rows[0]);
    if (kind === 'private') {
      io.to(`u:${user.id}`).to(`u:${recipient}`).emit('chat:message', { campaignId, message });
    } else {
      io.to(`c:${campaignId}`).emit('chat:message', { campaignId, message });
    }
    q('update rpg.campaigns set updated_at=now() where id=$1', [campaignId]).catch(() => {});
    reply({ ok: true, message });
  }));

  socket.on('dice:roll', guard(async ({ campaignId, expression, clientSeed, requestId, label }, reply) => {
    inRoom(campaignId);
    await requireMember(campaignId, user.id);
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(requestId)) throw new HttpError(400, 'Pedido inválido');
    if (!dice.validClientSeed(clientSeed)) throw new HttpError(400, 'Semente do jogador inválida');
    const parsed = dice.parseExpression(expression);
    const text = clean(label, 60);

    // proteção contra duplicação (reenvio do mesmo pedido)
    const dup = await q(`select r.*, p.display_name from rpg.rolls r join rpg.profiles p on p.user_id=r.user_id where campaign_id=$1 and r.user_id=$2 and request_id=$3`, [campaignId, user.id, requestId]);
    if (dup.rows[0]) return reply({ ok: true, roll: rollDto(dup.rows[0]), duplicate: true });

    if (!rateLimit(`d:${user.id}`, 6, 4000)) throw new HttpError(429, 'Espere um pouco antes de rolar de novo');

    const roll = await tx(async (db) => {
      const seed = await ensureSeed(db, campaignId);
      const nonce = seed.next_nonce;
      await db.query('update rpg.seeds set next_nonce=next_nonce+1 where id=$1', [seed.id]);
      const out = dice.computeRoll(parsed, seed.server_seed, clientSeed, nonce);
      const ins = await db.query(
        `insert into rpg.rolls(campaign_id, user_id, request_id, seed_id, seed_hash, nonce, client_seed, expression, label, terms, modifier, total)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [campaignId, user.id, requestId, seed.id, seed.seed_hash, nonce, clientSeed, parsed.normalized, text, JSON.stringify(out.terms), parsed.modifier, out.total]
      );
      await logEvent(db, { campaignId, userId: user.id, type: 'rolagem', result: { rollId: Number(ins.rows[0].id), expression: parsed.normalized, total: out.total } });
      await db.query('update rpg.campaigns set updated_at=now() where id=$1', [campaignId]);
      return { ...ins.rows[0], display_name: user.displayName };
    });
    const dto = rollDto(roll);
    io.to(`c:${campaignId}`).emit('dice:result', { campaignId, roll: dto });
    reply({ ok: true, roll: dto });
  }));

  socket.on('disconnect', () => {
    for (const cid of socket.data.campaigns) {
      if (presenceRemove(cid, user.id)) {
        io.to(`c:${cid}`).emit('presence', { campaignId: cid, userId: user.id, online: false });
        io.to(`c:${cid}`).emit('chat:typing', { campaignId: cid, userId: user.id, typing: false });
      }
    }
  });
});

// ---------- inicialização ----------
const PORT = Number(process.env.PORT || 3000);
async function start() {
  await migrate();
  await new Promise((r) => server.listen(PORT, r));
  console.log(`RPG Realms rodando na porta ${PORT}${DEV ? ' (modo de teste)' : ''}`);
}
if (require.main === module) {
  start().catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });
}
module.exports = { app, server, io, start };
