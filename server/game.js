// Etapas 2, 3 e 5: personagens, mapas/tokens e combate.
// Toda alteração passa por aqui, com validação de permissão e das regras no servidor.
const crypto = require('crypto');
const rules = require('./rules/paranormal');

module.exports = function setupGame(ctx) {
  const { app, io, q, tx, httpAuth, wrap, HttpError, requireMember, membership, logEvent, performRoll, rollDto, dice, isUuid, rateLimit } = ctx;

  // ---------- imagens ----------
  const IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
  function checkImage(dataUrl, maxKb) {
    if (dataUrl == null || dataUrl === '') return null;
    const m = IMG_RE.exec(dataUrl);
    if (!m) throw new HttpError(400, 'Imagem inválida. Use PNG, JPG ou WEBP.');
    if ((m[2].length * 3) / 4 > maxKb * 1024) throw new HttpError(400, `Imagem grande demais (máximo ${maxKb} KB).`);
    return dataUrl;
  }
  function sendImage(res, dataUrl) {
    const m = dataUrl && IMG_RE.exec(dataUrl);
    if (!m) return res.status(404).end();
    res.setHeader('Content-Type', `image/${m[1]}`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(Buffer.from(m[2], 'base64'));
  }
  app.get('/img/map/:id', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).end();
    sendImage(res, (await q('select image from rpg.maps where id=$1', [req.params.id])).rows[0]?.image);
  }));
  app.get('/img/char/:id', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).end();
    sendImage(res, (await q('select avatar from rpg.characters where id=$1', [req.params.id])).rows[0]?.avatar);
  }));
  app.get('/img/token/:id', wrap(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).end();
    sendImage(res, (await q('select image from rpg.tokens where id=$1', [req.params.id])).rows[0]?.image);
  }));

  // ---------- regras ----------
  app.get('/api/rules/paranormal', (req, res) => res.json({
    id: rules.id, nome: rules.nome, versao: rules.versao, atributos: rules.ATRIBUTOS, pericias: rules.PERICIAS,
    graus: rules.GRAUS, classes: rules.CLASSES, nex: rules.NEX, armas: rules.ARMAS_PRONTAS,
  }));

  // ---------- estado do tabuleiro ----------
  const avatarUrl = (c) => (c.has_avatar ? `/img/char/${c.id}?v=${new Date(c.updated_at).getTime()}` : null);

  async function loadBoard(campaignId) {
    const camp = (await q('select settings, combat, active_map_id, rules from rpg.campaigns where id=$1', [campaignId])).rows[0];
    const maps = (await q(`select id, name, width, height, grid, show_grid, (image is not null) as has_image, created_at
      from rpg.maps where campaign_id=$1 order by created_at`, [campaignId])).rows;
    const chars = (await q(`select c.id, c.owner_id, c.data, (c.avatar is not null) as has_avatar, c.updated_at, p.display_name
      from rpg.campaign_characters cc join rpg.characters c on c.id=cc.character_id join rpg.profiles p on p.user_id=c.owner_id
      where cc.campaign_id=$1 order by cc.added_at`, [campaignId])).rows;
    const tokens = camp.active_map_id ? (await q(`select t.id, t.kind, t.name, t.color, (t.image is not null) as has_image, t.x, t.y, t.size, t.hidden,
        t.stats, t.conditions, t.character_id, t.owner_id, t.created_at
      from rpg.tokens t where t.map_id=$1 order by t.created_at`, [camp.active_map_id])).rows : [];
    return { camp, maps, chars, tokens };
  }

  function viewBoard(b, role, userId) {
    const admin = role === 'admin';
    const charById = new Map(b.chars.map((c) => [c.id, c]));
    const active = b.maps.find((m) => m.id === b.camp.active_map_id) || null;
    const mapDto = (m) => ({ id: m.id, name: m.name, width: m.width, height: m.height, grid: m.grid, showGrid: m.show_grid, imageUrl: m.has_image ? `/img/map/${m.id}?v=${new Date(m.created_at).getTime()}` : null });
    const tokens = b.tokens.filter((t) => admin || !t.hidden).map((t) => {
      const c = t.character_id ? charById.get(t.character_id) : null;
      const base = { id: t.id, kind: t.kind, name: c ? c.data.nome : t.name, color: t.color, x: t.x, y: t.y, size: t.size, hidden: t.hidden, characterId: t.character_id, ownerId: c ? c.owner_id : t.owner_id };
      base.imageUrl = c ? avatarUrl(c) : t.has_image ? `/img/token/${t.id}?v=${new Date(t.created_at).getTime()}` : null;
      if (c) Object.assign(base, { pv: c.data.pv, pvMax: c.data.pvMax, pe: c.data.pe, peMax: c.data.peMax, san: c.data.san, sanMax: c.data.sanMax, defesa: c.data.defesa, conditions: c.data.condicoes || [] });
      else Object.assign(base, { pv: t.stats?.pv, pvMax: t.stats?.pvMax, defesa: admin ? t.stats?.defesa : undefined, conditions: t.conditions || [], stats: admin ? t.stats : undefined, ataques: (t.stats?.ataques || []).map((a) => ({ nome: a.nome })) });
      return base;
    });
    let combat = b.camp.combat;
    if (combat && !admin) {
      const visible = new Set(tokens.map((t) => t.id));
      combat = { ...combat, order: combat.order.map((o) => (visible.has(o.tokenId) ? o : { ...o, name: '???' })) };
    }
    return {
      rules: b.camp.rules,
      settings: { moveMode: 'livre', ...(b.camp.settings || {}) },
      combat,
      map: active ? mapDto(active) : null,
      maps: admin ? b.maps.map(mapDto) : undefined,
      tokens,
      characters: b.chars.map((c) => ({ id: c.id, ownerId: c.owner_id, ownerName: c.display_name, avatarUrl: avatarUrl(c), data: c.data, mine: c.owner_id === userId })),
    };
  }

  async function broadcastBoard(campaignId) {
    const b = await loadBoard(campaignId);
    const sockets = await io.in(`c:${campaignId}`).fetchSockets();
    const cache = {};
    for (const s of sockets) {
      const role = (s.data.roles && s.data.roles[campaignId]) || 'player';
      const key = role === 'admin' ? 'admin' : 'player:' + s.data.user.id;
      cache[key] = cache[key] || viewBoard(b, role, s.data.user.id);
      s.emit('board:state', { campaignId, board: cache[key] });
    }
  }
  const broadcastSoon = (() => {
    const timers = new Map();
    return (cid) => {
      clearTimeout(timers.get(cid));
      timers.set(cid, setTimeout(() => { timers.delete(cid); broadcastBoard(cid).catch((e) => console.error(e)); }, 60));
    };
  })();

  app.get('/api/campaigns/:id/board', httpAuth, wrap(async (req, res) => {
    const role = await requireMember(req.params.id, req.user.id);
    res.json(viewBoard(await loadBoard(req.params.id), role, req.user.id));
  }));

  // ---------- personagens ----------
  const charDto = (c) => ({ id: c.id, ownerId: c.owner_id, data: c.data, avatarUrl: avatarUrl(c), updatedAt: c.updated_at });

  async function canSeeCharacter(charId, userId) {
    const r = await q(`select c.owner_id,
        exists(select 1 from rpg.campaign_characters cc join rpg.members m on m.campaign_id=cc.campaign_id where cc.character_id=c.id and m.user_id=$2) as shared,
        exists(select 1 from rpg.campaign_characters cc join rpg.members m on m.campaign_id=cc.campaign_id where cc.character_id=c.id and m.user_id=$2 and m.role='admin') as mestre
      from rpg.characters c where c.id=$1`, [charId, userId]);
    const row = r.rows[0];
    if (!row) throw new HttpError(404, 'Personagem não encontrado');
    return { owner: row.owner_id === userId, shared: row.shared, mestre: row.mestre };
  }
  const campaignsOf = async (charId) => (await q('select campaign_id from rpg.campaign_characters where character_id=$1', [charId])).rows.map((r) => r.campaign_id);

  app.get('/api/characters', httpAuth, wrap(async (req, res) => {
    const r = await q(`select id, owner_id, data, (avatar is not null) as has_avatar, updated_at from rpg.characters where owner_id=$1 order by updated_at desc`, [req.user.id]);
    res.json(r.rows.map(charDto));
  }));

  app.post('/api/characters', httpAuth, wrap(async (req, res) => {
    const n = (await q('select count(*)::int n from rpg.characters where owner_id=$1', [req.user.id])).rows[0].n;
    if (n >= 50) throw new HttpError(400, 'Limite de 50 personagens');
    const data = rules.normalizarFicha(req.body.data || {});
    const avatar = checkImage(req.body.avatar, 400);
    const r = await q(`insert into rpg.characters(owner_id, data, avatar) values ($1,$2,$3) returning id, owner_id, data, (avatar is not null) as has_avatar, updated_at`, [req.user.id, data, avatar]);
    res.status(201).json(charDto(r.rows[0]));
  }));

  app.get('/api/characters/:id', httpAuth, wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Personagem não encontrado');
    const p = await canSeeCharacter(req.params.id, req.user.id);
    if (!p.owner && !p.shared) throw new HttpError(403, 'Você não pode ver este personagem');
    const r = await q(`select id, owner_id, data, (avatar is not null) as has_avatar, updated_at from rpg.characters where id=$1`, [req.params.id]);
    res.json({ ...charDto(r.rows[0]), canEdit: p.owner || p.mestre });
  }));

  app.put('/api/characters/:id', httpAuth, wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Personagem não encontrado');
    const p = await canSeeCharacter(req.params.id, req.user.id);
    if (!p.owner && !p.mestre) throw new HttpError(403, 'Só o dono ou o mestre podem editar esta ficha');
    const row = await tx(async (db) => {
      const cur = (await db.query('select data from rpg.characters where id=$1 for update', [req.params.id])).rows[0];
      const data = rules.normalizarFicha(req.body.data || {}, cur.data);
      const fields = [req.params.id, data];
      let sql = 'update rpg.characters set data=$2, updated_at=now()';
      if (req.body.avatar !== undefined && p.owner) { fields.push(checkImage(req.body.avatar, 400)); sql += ', avatar=$3'; }
      const r = await db.query(sql + ' where id=$1 returning id, owner_id, data, (avatar is not null) as has_avatar, updated_at', fields);
      for (const cid of (await db.query('select campaign_id from rpg.campaign_characters where character_id=$1', [req.params.id])).rows.map((x) => x.campaign_id)) {
        await logEvent(db, { campaignId: cid, userId: req.user.id, type: 'ficha_editada', before: { pv: cur.data.pv, pe: cur.data.pe, san: cur.data.san, nex: cur.data.nex }, after: { pv: data.pv, pe: data.pe, san: data.san, nex: data.nex }, result: { characterId: req.params.id, nome: data.nome } });
      }
      return r.rows[0];
    });
    (await campaignsOf(req.params.id)).forEach(broadcastSoon);
    res.json(charDto(row));
  }));

  app.delete('/api/characters/:id', httpAuth, wrap(async (req, res) => {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Personagem não encontrado');
    const p = await canSeeCharacter(req.params.id, req.user.id);
    if (!p.owner) throw new HttpError(403, 'Só o dono pode apagar o personagem');
    const camps = await campaignsOf(req.params.id);
    await q('delete from rpg.characters where id=$1', [req.params.id]);
    camps.forEach(broadcastSoon);
    res.json({ ok: true });
  }));

  async function activeMapCenter(db, campaignId) {
    const r = await db.query('select m.id, m.width, m.height, m.grid from rpg.campaigns c join rpg.maps m on m.id=c.active_map_id where c.id=$1', [campaignId]);
    return r.rows[0] || null;
  }

  app.post('/api/campaigns/:id/characters', httpAuth, wrap(async (req, res) => {
    await requireMember(req.params.id, req.user.id);
    if (!isUuid(req.body.characterId)) throw new HttpError(400, 'Escolha um personagem');
    const c = (await q('select id, owner_id, data from rpg.characters where id=$1', [req.body.characterId])).rows[0];
    if (!c || c.owner_id !== req.user.id) throw new HttpError(403, 'Você só pode levar seus próprios personagens');
    await tx(async (db) => {
      const ins = await db.query('insert into rpg.campaign_characters(campaign_id, character_id) values ($1,$2) on conflict do nothing', [req.params.id, c.id]);
      if (!ins.rowCount) throw new HttpError(409, 'Este personagem já está na campanha');
      const map = await activeMapCenter(db, req.params.id);
      if (map) {
        const n = (await db.query('select count(*)::int n from rpg.tokens where map_id=$1', [map.id])).rows[0].n;
        await db.query(`insert into rpg.tokens(campaign_id, map_id, character_id, owner_id, kind, name, x, y) values ($1,$2,$3,$4,'pc',$5,$6,$7)`,
          [req.params.id, map.id, c.id, req.user.id, c.data.nome, map.grid * (1.5 + (n % 8)), map.grid * 1.5]);
      }
      await logEvent(db, { campaignId: req.params.id, userId: req.user.id, type: 'personagem_entrou', result: { characterId: c.id, nome: c.data.nome } });
    });
    broadcastSoon(req.params.id);
    res.json({ ok: true });
  }));

  app.delete('/api/campaigns/:id/characters/:charId', httpAuth, wrap(async (req, res) => {
    const role = await requireMember(req.params.id, req.user.id);
    if (!isUuid(req.params.charId)) throw new HttpError(400, 'Personagem inválido');
    const c = (await q('select owner_id, data from rpg.characters where id=$1', [req.params.charId])).rows[0];
    if (!c) throw new HttpError(404, 'Personagem não encontrado');
    if (c.owner_id !== req.user.id && role !== 'admin') throw new HttpError(403, 'Sem permissão');
    await tx(async (db) => {
      await db.query('delete from rpg.tokens where campaign_id=$1 and character_id=$2', [req.params.id, req.params.charId]);
      await db.query('delete from rpg.campaign_characters where campaign_id=$1 and character_id=$2', [req.params.id, req.params.charId]);
      await logEvent(db, { campaignId: req.params.id, userId: req.user.id, type: 'personagem_saiu', result: { characterId: req.params.charId, nome: c.data.nome } });
    });
    broadcastSoon(req.params.id);
    res.json({ ok: true });
  }));

  // ---------- mapas ----------
  app.post('/api/campaigns/:id/maps', httpAuth, wrap(async (req, res) => {
    await requireMember(req.params.id, req.user.id, true);
    const name = String(req.body.name || '').trim().slice(0, 60) || 'Mapa';
    const image = checkImage(req.body.image, 3000);
    const width = Math.min(6000, Math.max(300, Math.round(Number(req.body.width) || 1600)));
    const height = Math.min(6000, Math.max(300, Math.round(Number(req.body.height) || 1000)));
    const grid = Math.min(300, Math.max(20, Math.round(Number(req.body.grid) || 70)));
    const count = (await q('select count(*)::int n from rpg.maps where campaign_id=$1', [req.params.id])).rows[0].n;
    if (count >= 30) throw new HttpError(400, 'Limite de 30 mapas por campanha');
    const m = await tx(async (db) => {
      const r = await db.query('insert into rpg.maps(campaign_id, name, image, width, height, grid) values ($1,$2,$3,$4,$5,$6) returning id', [req.params.id, name, image, width, height, grid]);
      const cur = await db.query('select active_map_id from rpg.campaigns where id=$1', [req.params.id]);
      if (!cur.rows[0].active_map_id || req.body.activate) await activate(db, req.params.id, r.rows[0].id, req.user.id);
      await logEvent(db, { campaignId: req.params.id, userId: req.user.id, type: 'mapa_criado', result: { mapId: r.rows[0].id, name } });
      return r.rows[0];
    });
    broadcastSoon(req.params.id);
    res.status(201).json(m);
  }));

  // Ao ativar um mapa, os personagens da campanha que ainda não têm token nele ganham um
  async function activate(db, campaignId, mapId, userId) {
    const map = (await db.query('select id, grid from rpg.maps where id=$1 and campaign_id=$2', [mapId, campaignId])).rows[0];
    if (!map) throw new HttpError(404, 'Mapa não encontrado');
    await db.query('update rpg.campaigns set active_map_id=$2, combat=null where id=$1', [campaignId, mapId]);
    const missing = (await db.query(`select c.id, c.owner_id, c.data from rpg.campaign_characters cc join rpg.characters c on c.id=cc.character_id
      where cc.campaign_id=$1 and not exists (select 1 from rpg.tokens t where t.map_id=$2 and t.character_id=c.id)`, [campaignId, mapId])).rows;
    let i = 0;
    for (const c of missing) {
      await db.query(`insert into rpg.tokens(campaign_id, map_id, character_id, owner_id, kind, name, x, y) values ($1,$2,$3,$4,'pc',$5,$6,$7)`,
        [campaignId, mapId, c.id, c.owner_id, c.data.nome, map.grid * (1.5 + i++), map.grid * 1.5]);
    }
    await logEvent(db, { campaignId, userId, type: 'mapa_ativado', result: { mapId } });
  }

  async function mapOfAdmin(mapId, userId) {
    if (!isUuid(mapId)) throw new HttpError(404, 'Mapa não encontrado');
    const m = (await q('select id, campaign_id from rpg.maps where id=$1', [mapId])).rows[0];
    if (!m) throw new HttpError(404, 'Mapa não encontrado');
    await requireMember(m.campaign_id, userId, true);
    return m;
  }

  app.post('/api/maps/:id/activate', httpAuth, wrap(async (req, res) => {
    const m = await mapOfAdmin(req.params.id, req.user.id);
    await tx((db) => activate(db, m.campaign_id, m.id, req.user.id));
    broadcastSoon(m.campaign_id);
    res.json({ ok: true });
  }));

  app.put('/api/maps/:id', httpAuth, wrap(async (req, res) => {
    const m = await mapOfAdmin(req.params.id, req.user.id);
    const name = String(req.body.name || '').trim().slice(0, 60) || 'Mapa';
    const grid = Math.min(300, Math.max(20, Math.round(Number(req.body.grid) || 70)));
    await q('update rpg.maps set name=$2, grid=$3, show_grid=$4 where id=$1', [m.id, name, grid, req.body.showGrid !== false]);
    broadcastSoon(m.campaign_id);
    res.json({ ok: true });
  }));

  app.delete('/api/maps/:id', httpAuth, wrap(async (req, res) => {
    const m = await mapOfAdmin(req.params.id, req.user.id);
    await tx(async (db) => {
      await db.query('update rpg.campaigns set active_map_id=null, combat=null where id=$1 and active_map_id=$2', [m.campaign_id, m.id]);
      await db.query('delete from rpg.maps where id=$1', [m.id]);
      await logEvent(db, { campaignId: m.campaign_id, userId: req.user.id, type: 'mapa_apagado', result: { mapId: m.id } });
    });
    broadcastSoon(m.campaign_id);
    res.json({ ok: true });
  }));

  app.put('/api/campaigns/:id/settings', httpAuth, wrap(async (req, res) => {
    await requireMember(req.params.id, req.user.id, true);
    const moveMode = req.body.moveMode === 'turno' ? 'turno' : 'livre';
    await tx(async (db) => {
      const old = (await db.query('select settings from rpg.campaigns where id=$1 for update', [req.params.id])).rows[0].settings;
      await db.query(`update rpg.campaigns set settings = settings || $2::jsonb where id=$1`, [req.params.id, JSON.stringify({ moveMode })]);
      await logEvent(db, { campaignId: req.params.id, userId: req.user.id, type: 'regra_movimento', before: old, after: { moveMode } });
    });
    broadcastSoon(req.params.id);
    res.json({ ok: true });
  }));

  // ---------- tokens de NPCs e inimigos (mestre) ----------
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  app.post('/api/campaigns/:id/tokens', httpAuth, wrap(async (req, res) => {
    await requireMember(req.params.id, req.user.id, true);
    const kind = req.body.kind === 'npc' ? 'npc' : 'inimigo';
    const name = String(req.body.name || '').trim().slice(0, 40) || (kind === 'npc' ? 'NPC' : 'Inimigo');
    const color = COLOR_RE.test(req.body.color) ? req.body.color : kind === 'npc' ? '#3aa0c8' : '#c0392b';
    const image = checkImage(req.body.image, 300);
    const stats = rules.normalizarNpc(req.body.stats || {});
    const size = Math.min(4, Math.max(1, Math.round(Number(req.body.size) || 1)));
    const qty = Math.min(10, Math.max(1, Math.round(Number(req.body.qty) || 1)));
    await tx(async (db) => {
      const map = await activeMapCenter(db, req.params.id);
      if (!map) throw new HttpError(400, 'Crie ou ative um mapa primeiro');
      for (let i = 0; i < qty; i++) {
        await db.query(`insert into rpg.tokens(campaign_id, map_id, kind, name, color, image, x, y, size, hidden, stats) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [req.params.id, map.id, kind, qty > 1 ? `${name} ${i + 1}` : name, color, image, map.width / 2 + i * map.grid, map.height / 2, size, !!req.body.hidden, stats]);
      }
      await logEvent(db, { campaignId: req.params.id, userId: req.user.id, type: 'token_criado', result: { name, kind, qty } });
    });
    broadcastSoon(req.params.id);
    res.status(201).json({ ok: true });
  }));

  async function tokenOf(tokenId) {
    if (!isUuid(tokenId)) throw new HttpError(404, 'Token não encontrado');
    const t = (await q('select * from rpg.tokens where id=$1', [tokenId])).rows[0];
    if (!t) throw new HttpError(404, 'Token não encontrado');
    return t;
  }

  app.put('/api/tokens/:id', httpAuth, wrap(async (req, res) => {
    const t = await tokenOf(req.params.id);
    await requireMember(t.campaign_id, req.user.id, true);
    const name = String(req.body.name || t.name).trim().slice(0, 40) || t.name;
    const color = COLOR_RE.test(req.body.color) ? req.body.color : t.color;
    const size = Math.min(4, Math.max(1, Math.round(Number(req.body.size) || t.size)));
    const hidden = req.body.hidden === undefined ? t.hidden : !!req.body.hidden;
    const stats = t.kind === 'pc' ? null : rules.normalizarNpc(req.body.stats || {}, t.stats);
    const conditions = Array.isArray(req.body.conditions) ? req.body.conditions.map((c) => String(c).slice(0, 30)).slice(0, 15) : t.conditions;
    await tx(async (db) => {
      await db.query('update rpg.tokens set name=$2, color=$3, size=$4, hidden=$5, stats=coalesce($6, stats), conditions=$7 where id=$1', [t.id, name, color, size, hidden, stats, JSON.stringify(conditions)]);
      await logEvent(db, { campaignId: t.campaign_id, userId: req.user.id, type: 'token_editado', before: { name: t.name, pv: t.stats?.pv, hidden: t.hidden }, after: { name, pv: stats?.pv, hidden } });
    });
    broadcastSoon(t.campaign_id);
    res.json({ ok: true });
  }));

  app.delete('/api/tokens/:id', httpAuth, wrap(async (req, res) => {
    const t = await tokenOf(req.params.id);
    await requireMember(t.campaign_id, req.user.id, true);
    if (t.kind === 'pc') throw new HttpError(400, 'Para tirar um personagem de jogador, remova-o da campanha');
    await tx(async (db) => {
      await db.query('delete from rpg.tokens where id=$1', [t.id]);
      const camp = (await db.query('select combat from rpg.campaigns where id=$1 for update', [t.campaign_id])).rows[0];
      if (camp.combat) await db.query('update rpg.campaigns set combat=$2 where id=$1', [t.campaign_id, removeFromCombat(camp.combat, t.id)]);
      await logEvent(db, { campaignId: t.campaign_id, userId: req.user.id, type: 'token_removido', result: { name: t.name } });
    });
    broadcastSoon(t.campaign_id);
    res.json({ ok: true });
  }));

  function removeFromCombat(combat, tokenId) {
    const idx = combat.order.findIndex((o) => o.tokenId === tokenId);
    if (idx < 0) return combat;
    const order = combat.order.filter((o) => o.tokenId !== tokenId);
    let turn = combat.turn;
    if (idx < turn) turn--;
    if (turn >= order.length) turn = 0;
    return order.length ? { ...combat, order, turn } : null;
  }

  // ---------- ficha efetiva de um token (personagem ou NPC) ----------
  async function sheetOf(db, token, lock) {
    if (token.character_id) {
      const c = (await db.query(`select id, owner_id, data from rpg.characters where id=$1 ${lock ? 'for update' : ''}`, [token.character_id])).rows[0];
      return { kind: 'pc', ownerId: c.owner_id, nome: c.data.nome, atributos: c.data.atributos, pericias: c.data.pericias, defesa: c.data.defesa, pv: c.data.pv, pvMax: c.data.pvMax, char: c };
    }
    const s = token.stats || rules.normalizarNpc({});
    return { kind: token.kind, ownerId: null, nome: token.name, atributos: s.atributos, pericias: {}, defesa: s.defesa, pv: s.pv, pvMax: s.pvMax, iniciativa: s.iniciativa, ataques: s.ataques, stats: s };
  }

  async function applyHp(db, token, sheet, newPv, userId, motivo) {
    const pv = Math.max(-sheet.pvMax, Math.min(sheet.pvMax, newPv));
    if (sheet.kind === 'pc') {
      const data = { ...sheet.char.data, pv };
      const cond = new Set(data.condicoes || []);
      if (pv <= 0) cond.add('Morrendo'); else cond.delete('Morrendo');
      data.condicoes = [...cond];
      await db.query('update rpg.characters set data=$2, updated_at=now() where id=$1', [sheet.char.id, data]);
    } else {
      const cond = new Set(token.conditions || []);
      if (pv <= 0) cond.add('Derrotado'); else cond.delete('Derrotado');
      await db.query('update rpg.tokens set stats=$2, conditions=$3 where id=$1', [token.id, { ...sheet.stats, pv }, JSON.stringify([...cond])]);
    }
    await logEvent(db, { campaignId: token.campaign_id, userId, type: 'vida_alterada', before: { pv: sheet.pv }, after: { pv }, result: { tokenId: token.id, nome: sheet.nome }, consequences: { motivo, caido: pv <= 0 } });
    return pv;
  }

  // ---------- tempo real: movimento, testes e combate ----------
  async function systemMessage(db, campaignId, body) {
    const m = (await db.query(`insert into rpg.messages(campaign_id, kind, body) values ($1,'system',$2) returning *`, [campaignId, body.slice(0, 1000)])).rows[0];
    return { id: Number(m.id), kind: 'system', body: m.body, createdAt: m.created_at };
  }
  const emitRoll = (cid, row, outcome) => io.to(`c:${cid}`).emit('dice:result', { campaignId: cid, roll: { ...rollDto(row), outcome } });
  const emitMsg = (cid, message) => io.to(`c:${cid}`).emit('chat:message', { campaignId: cid, message });
  const parseRoll = (expr) => dice.parseExpression(expr);
  const rid = () => crypto.randomUUID();
  // gera sementes derivadas da semente do jogador para cada rolagem da mesma ação
  const subSeed = (clientSeed, i) => crypto.createHash('sha256').update(`${clientSeed}:${i}`).digest('hex').slice(0, 32);

  function currentTurnToken(combat) {
    return combat && combat.order.length ? combat.order[combat.turn].tokenId : null;
  }

  async function canControl(token, user, role, campaign) {
    if (role === 'admin') return true;
    const ownerId = token.character_id ? (await q('select owner_id from rpg.characters where id=$1', [token.character_id])).rows[0]?.owner_id : token.owner_id;
    if (ownerId !== user.id) return false;
    if (campaign.combat && (campaign.settings || {}).moveMode === 'turno' && currentTurnToken(campaign.combat) !== token.id) {
      throw new HttpError(403, 'Espere a sua vez no combate');
    }
    return true;
  }

  return function onConnection(socket, guard) {
    const user = socket.data.user;
    socket.data.roles = socket.data.roles || {};
    const roleIn = async (cid) => {
      if (!socket.data.campaigns.has(cid)) throw new HttpError(403, 'Entre na sala primeiro');
      const role = await membership(cid, user.id);
      if (!role) throw new HttpError(403, 'Você não participa desta campanha');
      socket.data.roles[cid] = role;
      return role;
    };

    socket.on('board:join', guard(async ({ campaignId }, reply) => {
      const role = await requireMember(campaignId, user.id);
      socket.data.roles[campaignId] = role;
      reply({ ok: true, board: viewBoard(await loadBoard(campaignId), role, user.id) });
    }));

    socket.on('token:move', guard(async ({ campaignId, tokenId, x, y }, reply) => {
      const role = await roleIn(campaignId);
      if (!rateLimit(`mv:${user.id}`, 40, 2000)) return reply({ error: 'Devagar com os movimentos' });
      const t = await tokenOf(tokenId);
      if (t.campaign_id !== campaignId) throw new HttpError(400, 'Token de outra campanha');
      const camp = (await q('select combat, settings, active_map_id from rpg.campaigns where id=$1', [campaignId])).rows[0];
      if (t.map_id !== camp.active_map_id) throw new HttpError(400, 'Esse token não está no mapa atual');
      if (!(await canControl(t, user, role, camp))) throw new HttpError(403, 'Você só pode mover o seu personagem');
      const map = (await q('select width, height from rpg.maps where id=$1', [t.map_id])).rows[0];
      const nx = Math.max(0, Math.min(map.width, Number(x) || 0));
      const ny = Math.max(0, Math.min(map.height, Number(y) || 0));
      await q('update rpg.tokens set x=$2, y=$3 where id=$1', [t.id, nx, ny]);
      if (t.hidden) {
        const sockets = await io.in(`c:${campaignId}`).fetchSockets();
        sockets.filter((s) => s.data.roles && s.data.roles[campaignId] === 'admin').forEach((s) => s.emit('token:moved', { campaignId, tokenId: t.id, x: nx, y: ny }));
      } else {
        io.to(`c:${campaignId}`).emit('token:moved', { campaignId, tokenId: t.id, x: nx, y: ny, by: user.id });
      }
      reply({ ok: true });
    }));

    socket.on('token:hp', guard(async ({ campaignId, tokenId, delta }, reply) => {
      const role = await roleIn(campaignId);
      const d = Math.round(Number(delta));
      if (!Number.isFinite(d) || d === 0 || Math.abs(d) > 9999) throw new HttpError(400, 'Valor inválido');
      const t = await tokenOf(tokenId);
      if (t.campaign_id !== campaignId) throw new HttpError(400, 'Token de outra campanha');
      if (role !== 'admin') {
        const owner = t.character_id ? (await q('select owner_id from rpg.characters where id=$1', [t.character_id])).rows[0]?.owner_id : null;
        if (owner !== user.id) throw new HttpError(403, 'Só o mestre ou o dono alteram a vida');
      }
      const msg = await tx(async (db) => {
        const sheet = await sheetOf(db, t, true);
        const pv = await applyHp(db, t, sheet, sheet.pv + d, user.id, d > 0 ? 'cura manual' : 'dano manual');
        return systemMessage(db, campaignId, `${user.displayName} ${d > 0 ? 'curou' : 'tirou'} ${Math.abs(d)} PV de ${sheet.nome} (agora ${pv}/${sheet.pvMax}).`);
      });
      emitMsg(campaignId, msg);
      broadcastSoon(campaignId);
      reply({ ok: true });
    }));

    // Teste de perícia ou atributo de um token
    socket.on('check:roll', guard(async ({ campaignId, tokenId, pericia, atributo, clientSeed }, reply) => {
      const role = await roleIn(campaignId);
      if (!dice.validClientSeed(clientSeed)) throw new HttpError(400, 'Semente inválida');
      if (!rateLimit(`d:${user.id}`, 6, 4000)) throw new HttpError(429, 'Espere um pouco antes de rolar de novo');
      const t = await tokenOf(tokenId);
      if (t.campaign_id !== campaignId) throw new HttpError(400, 'Token de outra campanha');
      const camp = (await q('select combat, settings from rpg.campaigns where id=$1', [campaignId])).rows[0];
      if (role !== 'admin') {
        const owner = t.character_id ? (await q('select owner_id from rpg.characters where id=$1', [t.character_id])).rows[0]?.owner_id : null;
        if (owner !== user.id) throw new HttpError(403, 'Você só pode testar com o seu personagem');
      }
      const p = rules.PERICIAS.find((x) => x.id === pericia);
      const atr = p ? p.atributo : rules.ATRIBUTOS.find((a) => a.id === atributo)?.id;
      if (!atr) throw new HttpError(400, 'Escolha uma perícia ou atributo');
      const { row, outcome, msg } = await tx(async (db) => {
        const sheet = await sheetOf(db, t, false);
        const bonus = p ? (sheet.kind === 'pc' ? rules.bonusPericia(sheet, p.id) : (p.id === 'iniciativa' ? sheet.iniciativa || 0 : 0)) : 0;
        const expr = rules.expressaoTeste(sheet.atributos[atr] ?? 1, bonus);
        const label = `${sheet.nome}: teste de ${p ? p.nome : rules.ATRIBUTOS.find((a) => a.id === atr).nome}`;
        const r = await performRoll(db, { campaignId, user, parsed: parseRoll(expr), clientSeed, requestId: rid(), label });
        const out = `${label}: ${r.total}`;
        return { row: r, outcome: out, msg: await systemMessage(db, campaignId, `🎲 ${out} (${expr})`) };
      });
      emitRoll(campaignId, row, outcome);
      emitMsg(campaignId, msg);
      reply({ ok: true });
      void camp;
    }));

    socket.on('combat:start', guard(async ({ campaignId, clientSeed }, reply) => {
      const role = await roleIn(campaignId);
      if (role !== 'admin') throw new HttpError(403, 'Só o mestre inicia o combate');
      if (!dice.validClientSeed(clientSeed)) throw new HttpError(400, 'Semente inválida');
      const rolls = [];
      const msg = await tx(async (db) => {
        const camp = (await db.query('select active_map_id, combat from rpg.campaigns where id=$1 for update', [campaignId])).rows[0];
        if (!camp.active_map_id) throw new HttpError(400, 'Ative um mapa primeiro');
        const tokens = (await db.query('select * from rpg.tokens where map_id=$1 order by created_at', [camp.active_map_id])).rows;
        if (tokens.length < 2) throw new HttpError(400, 'Coloque pelo menos 2 participantes no mapa');
        const order = [];
        let i = 0;
        for (const t of tokens) {
          const sheet = await sheetOf(db, t, false);
          const bonus = sheet.kind === 'pc' ? rules.bonusPericia(sheet, 'iniciativa') : sheet.iniciativa || 0;
          const expr = rules.expressaoTeste(sheet.atributos.agi, bonus);
          const r = await performRoll(db, { campaignId, user, parsed: parseRoll(expr), clientSeed: subSeed(clientSeed, i++), requestId: rid(), label: `Iniciativa: ${t.hidden ? '???' : sheet.nome}` });
          rolls.push(r);
          order.push({ tokenId: t.id, name: sheet.nome, init: r.total, agi: sheet.atributos.agi });
        }
        order.sort((a, b) => b.init - a.init || b.agi - a.agi);
        const combat = { active: true, round: 1, turn: 0, order: order.map(({ agi, ...o }) => o), startedAt: new Date().toISOString() };
        await db.query('update rpg.campaigns set combat=$2 where id=$1', [campaignId, combat]);
        await logEvent(db, { campaignId, userId: user.id, type: 'combate_iniciado', after: { ordem: combat.order.map((o) => `${o.name} (${o.init})`) } });
        return systemMessage(db, campaignId, `⚔ Combate iniciado! Ordem: ${combat.order.map((o) => `${tokens.find((t) => t.id === o.tokenId).hidden ? '???' : o.name} (${o.init})`).join(', ')}.`);
      });
      for (const r of rolls) emitRoll(campaignId, r);
      emitMsg(campaignId, msg);
      broadcastSoon(campaignId);
      reply({ ok: true });
    }));

    socket.on('combat:next', guard(async ({ campaignId }, reply) => {
      const role = await roleIn(campaignId);
      const msg = await tx(async (db) => {
        const camp = (await db.query('select combat from rpg.campaigns where id=$1 for update', [campaignId])).rows[0];
        const c = camp.combat;
        if (!c) throw new HttpError(400, 'Não há combate em andamento');
        const curTok = c.order[c.turn];
        if (role !== 'admin') {
          const t = (await db.query('select character_id from rpg.tokens where id=$1', [curTok.tokenId])).rows[0];
          const owner = t?.character_id ? (await db.query('select owner_id from rpg.characters where id=$1', [t.character_id])).rows[0]?.owner_id : null;
          if (owner !== user.id) throw new HttpError(403, 'Só quem está na vez (ou o mestre) passa o turno');
        }
        let turn = c.turn + 1;
        let round = c.round;
        if (turn >= c.order.length) { turn = 0; round++; }
        const combat = { ...c, turn, round };
        await db.query('update rpg.campaigns set combat=$2 where id=$1', [campaignId, combat]);
        await logEvent(db, { campaignId, userId: user.id, type: 'turno_passado', before: { rodada: c.round, vez: curTok.name }, after: { rodada: round, vez: combat.order[turn].name } });
        const nextTok = (await db.query('select hidden from rpg.tokens where id=$1', [combat.order[turn].tokenId])).rows[0];
        return systemMessage(db, campaignId, `${turn === 0 ? `Rodada ${round}. ` : ''}Vez de ${nextTok?.hidden ? '???' : combat.order[turn].name}.`);
      });
      emitMsg(campaignId, msg);
      broadcastSoon(campaignId);
      reply({ ok: true });
    }));

    socket.on('combat:end', guard(async ({ campaignId }, reply) => {
      const role = await roleIn(campaignId);
      if (role !== 'admin') throw new HttpError(403, 'Só o mestre encerra o combate');
      const msg = await tx(async (db) => {
        const camp = (await db.query('select combat from rpg.campaigns where id=$1 for update', [campaignId])).rows[0];
        if (!camp.combat) throw new HttpError(400, 'Não há combate em andamento');
        await db.query('update rpg.campaigns set combat=null where id=$1', [campaignId]);
        await logEvent(db, { campaignId, userId: user.id, type: 'combate_encerrado', before: { rodada: camp.combat.round } });
        return systemMessage(db, campaignId, `Combate encerrado após ${camp.combat.round} rodada(s).`);
      });
      emitMsg(campaignId, msg);
      broadcastSoon(campaignId);
      reply({ ok: true });
    }));

    // Ataque: teste contra a Defesa do alvo; se acertar, rola o dano e aplica no alvo
    socket.on('combat:attack', guard(async ({ campaignId, attackerId, targetId, weapon, clientSeed }, reply) => {
      const role = await roleIn(campaignId);
      if (!dice.validClientSeed(clientSeed)) throw new HttpError(400, 'Semente inválida');
      if (!rateLimit(`d:${user.id}`, 6, 4000)) throw new HttpError(429, 'Espere um pouco antes de atacar de novo');
      if (attackerId === targetId) throw new HttpError(400, 'Escolha outro alvo');
      const att = await tokenOf(attackerId);
      const tgt = await tokenOf(targetId);
      if (att.campaign_id !== campaignId || tgt.campaign_id !== campaignId || att.map_id !== tgt.map_id) throw new HttpError(400, 'Alvo fora do mapa');
      const camp = (await q('select combat, settings from rpg.campaigns where id=$1', [campaignId])).rows[0];
      if (!camp.combat) throw new HttpError(400, 'Inicie o combate para atacar');
      if (role !== 'admin') {
        const owner = att.character_id ? (await q('select owner_id from rpg.characters where id=$1', [att.character_id])).rows[0]?.owner_id : null;
        if (owner !== user.id) throw new HttpError(403, 'Você só pode atacar com o seu personagem');
      }
      if (currentTurnToken(camp.combat) !== att.id && role !== 'admin') throw new HttpError(403, 'Não é a sua vez');
      if (tgt.hidden && role !== 'admin') throw new HttpError(400, 'Alvo inválido');

      const result = await tx(async (db) => {
        const a = await sheetOf(db, att, false);
        const d = await sheetOf(db, tgt, true);
        if (a.pv <= 0) throw new HttpError(400, `${a.nome} está caído e não pode atacar`);
        let arma;
        if (a.kind === 'pc') {
          const armas = (a.char.data.inventario || []).filter((it) => it.tipo === 'arma');
          const idx = Number(weapon);
          arma = Number.isInteger(idx) && armas[idx] ? armas[idx] : { nome: 'Desarmado', dano: '1d3', critico: 20, multiplicador: 2, pericia: 'luta', bonus: 0 };
        } else {
          arma = a.ataques[Number(weapon)] || a.ataques[0];
        }
        const atr = arma.pericia === 'pontaria' ? 'agi' : 'for';
        const bonus = (a.kind === 'pc' ? rules.bonusPericia(a, arma.pericia) : 0) + (arma.bonus || 0);
        const expr = rules.expressaoTeste(a.atributos[atr] ?? 1, bonus);
        const hitRoll = await performRoll(db, { campaignId, user, parsed: parseRoll(expr), clientSeed: subSeed(clientSeed, 0), requestId: rid(), label: `${a.nome} ataca ${d.nome} (${arma.nome})` });
        const d20 = hitRoll.terms[0].sum;
        const acerto = hitRoll.total >= d.defesa;
        const critico = acerto && d20 >= arma.critico;
        let dmgRoll = null;
        let novoPv = d.pv;
        let texto = `${a.nome} atacou ${d.nome} com ${arma.nome}: ${hitRoll.total} contra Defesa ${d.defesa} — `;
        if (!acerto) {
          texto += 'errou!';
        } else {
          const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(arma.dano);
          const qtd = Math.min(100, Number(m[1]) * (critico ? arma.multiplicador : 1));
          const fixo = Number(m[3] || 0) + (arma.pericia === 'luta' ? a.atributos.for || 0 : 0);
          const dExpr = `${qtd}d${m[2]}${fixo > 0 ? '+' + fixo : fixo < 0 ? fixo : ''}`;
          dmgRoll = await performRoll(db, { campaignId, user, parsed: parseRoll(dExpr), clientSeed: subSeed(clientSeed, 1), requestId: rid(), label: `Dano em ${d.nome}${critico ? ' (CRÍTICO)' : ''}` });
          const dano = Math.max(1, dmgRoll.total);
          novoPv = await applyHp(db, tgt, d, d.pv - dano, user.id, `ataque de ${a.nome}`);
          texto += `${critico ? 'ACERTO CRÍTICO! ' : 'acertou! '}${dano} de dano. ${d.nome}: ${novoPv}/${d.pvMax} PV${novoPv <= 0 ? (d.kind === 'pc' ? ' — está morrendo!' : ' — derrotado!') : ''}.`;
        }
        await logEvent(db, { campaignId, userId: user.id, type: 'ataque', before: { alvoPv: d.pv }, after: { alvoPv: novoPv }, result: { atacante: a.nome, alvo: d.nome, arma: arma.nome, teste: hitRoll.total, defesa: d.defesa, acerto, critico, dano: dmgRoll ? dmgRoll.total : 0 }, consequences: { caido: novoPv <= 0 } });
        const msg = await systemMessage(db, campaignId, `⚔ ${texto}`);
        return { hitRoll, dmgRoll, acerto, critico, msg, hidden: tgt.hidden };
      });
      emitRoll(campaignId, result.hitRoll, result.acerto ? (result.critico ? 'ACERTO CRÍTICO!' : 'Acertou!') : 'Errou!');
      if (result.dmgRoll) setTimeout(() => emitRoll(campaignId, result.dmgRoll, 'Dano'), 1400);
      emitMsg(campaignId, result.msg);
      broadcastSoon(campaignId);
      reply({ ok: true });
    }));
  };
};
