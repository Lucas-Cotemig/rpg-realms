// Autenticação: o login é feito pelo Supabase Auth no navegador.
// O servidor valida o token de acesso a cada conexão/requisição.
const { createClient } = require('@supabase/supabase-js');
const { q } = require('./db');

const DEV = process.env.AUTH_MODE === 'dev' && process.env.NODE_ENV !== 'production';
const supabase = !DEV && process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  : null;

const cache = new Map(); // token -> { user, exp }

async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const c = cache.get(token);
  if (c && c.exp > Date.now()) return c.user;

  let user = null;
  if (DEV) {
    // Somente para testes locais automatizados: "dev:<uuid>:<nome>"
    const m = /^dev:([0-9a-f-]{36}):(.{1,40})$/.exec(token);
    if (m) user = { id: m[1], email: `${m[2]}@teste.local`, name: m[2] };
  } else if (supabase) {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data && data.user) {
      const u = data.user;
      user = { id: u.id, email: u.email, name: (u.user_metadata && u.user_metadata.display_name) || (u.email || 'Aventureiro').split('@')[0] };
    }
  }
  if (!user) return null;

  const r = await q(
    `insert into rpg.profiles(user_id, email, display_name) values ($1,$2,$3)
     on conflict (user_id) do update set email = excluded.email
     returning user_id, email, display_name`,
    [user.id, user.email, user.name.slice(0, 40)]
  );
  const profile = { id: r.rows[0].user_id, email: r.rows[0].email, displayName: r.rows[0].display_name };
  if (cache.size > 5000) cache.clear();
  cache.set(token, { user: profile, exp: Date.now() + 60_000 });
  return profile;
}

function invalidateUser(userId) {
  for (const [k, v] of cache) if (v.user.id === userId) cache.delete(k);
}

async function httpAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { verifyToken, httpAuth, invalidateUser, DEV };
