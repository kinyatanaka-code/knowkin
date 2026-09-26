// Claude.ai のカスタムコネクタが使う OAuth 2.1（動的クライアント登録＋PKCE）
import crypto from 'node:crypto';
import express from 'express';
import { pool } from './db.js';
import { clearFailures, login, noteFailure, tooManyAttempts, userFromSession } from './auth.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rnd = (n = 32) => crypto.randomBytes(n).toString('base64url');
const ACCESS_SEC = 7 * 86400;
const REFRESH_SEC = 180 * 86400;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

function okRedirect(uri) {
  try { const u = new URL(uri); return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1'; } catch { return false; }
}

/** アクセストークンからユーザーIDを返す */
export async function userIdFromAccessToken(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT user_id FROM oauth_tokens WHERE token_hash = $1 AND kind = 'access' AND expires_at > now()`, [sha256(token)]);
  return rows[0]?.user_id || null;
}

export function mcpUnauthorized(req, res) {
  res.set('WWW-Authenticate', `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`);
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
}

async function issueTokens(clientId, uid) {
  const access = rnd(); const refresh = rnd();
  await pool.query(
    `INSERT INTO oauth_tokens(token_hash, kind, client_id, user_id, expires_at) VALUES
     ($1, 'access', $3, $4, now() + make_interval(secs => $5)), ($2, 'refresh', $3, $4, now() + make_interval(secs => $6))`,
    [sha256(access), sha256(refresh), clientId, uid, ACCESS_SEC, REFRESH_SEC]);
  await pool.query('DELETE FROM oauth_tokens WHERE expires_at < now()');
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SEC, refresh_token: refresh, scope: 'knowkin' };
}

function page(title, body) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;
background:radial-gradient(900px 600px at 50% 0%,#12235A 0%,#050A1C 60%) fixed,#050A1C;color:#E7EDFF;font-family:-apple-system,"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;line-height:1.7}
.card{width:100%;max-width:420px;background:#0D1736;border:1px solid #22305C;border-radius:18px;padding:24px}
.brand{display:flex;align-items:center;gap:10px;margin:0 0 14px;font-weight:800;font-size:22px}.brand img{width:34px;height:34px}
h1{font-size:18px;margin:0 0 8px}p{color:#94A3CC;margin:0 0 14px;font-size:14px}strong{color:#E7EDFF}
label{display:block;margin:0 0 12px;font-size:13px;color:#94A3CC}input{display:block;width:100%;margin-top:4px;padding:11px 12px;border:1px solid #22305C;border-radius:10px;background:#0A1330;color:#E7EDFF;font:inherit}
.row{display:flex;gap:10px;margin-top:6px}button{flex:1;padding:12px;border-radius:10px;font:inherit;font-weight:700;cursor:pointer}
.ok{background:#5CD2FF;color:#04101F;border:0}.no{background:none;color:#E7EDFF;border:1px solid #22305C}.err{color:#FF7A9A}
</style></head><body><main class="card"><div class="brand"><img src="/favicon.svg" alt="">knowkin</div>${body}</main></body></html>`;
}

function readCookie(req, name) {
  const m = (req.get('cookie') || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}

export function oauthRouter() {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));

  const resourceMeta = (req, res) => res.json({
    resource: `${baseUrl(req)}/mcp`,
    authorization_servers: [baseUrl(req)],
    bearer_methods_supported: ['header'],
    resource_name: 'knowkin',
  });
  r.get('/.well-known/oauth-protected-resource', resourceMeta);
  r.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);
  const asMeta = (req, res) => {
    const b = baseUrl(req);
    res.json({
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ['knowkin'],
    });
  };
  r.get('/.well-known/oauth-authorization-server', asMeta);
  r.get('/.well-known/oauth-authorization-server/mcp', asMeta);
  r.get('/.well-known/openid-configuration', asMeta);

  // 動的クライアント登録（Claude.ai が自動で行う）
  r.post('/oauth/register', express.json(), async (req, res) => {
    try {
      const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
      if (!uris.length || !uris.every(okRedirect)) return res.status(400).json({ error: 'invalid_redirect_uri' });
      const clientId = `kk_${rnd(16)}`;
      const name = String(req.body?.client_name || '').slice(0, 100);
      await pool.query('INSERT INTO oauth_clients(client_id, client_name, redirect_uris) VALUES($1, $2, $3)', [clientId, name, uris]);
      res.status(201).json({
        client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
      });
    } catch (e) { console.error('oauth register', e); res.status(500).json({ error: 'server_error' }); }
  });

  async function checkAuthRequest(q) {
    if (q.response_type !== 'code') return 'response_type が code ではありません';
    if (!q.code_challenge || (q.code_challenge_method || 'S256') !== 'S256') return 'PKCE（S256）が必要です';
    const { rows } = await pool.query('SELECT * FROM oauth_clients WHERE client_id = $1', [String(q.client_id || '')]);
    if (!rows[0]) return '登録されていないクライアントです。Claude.aiでコネクタを追加し直してください';
    if (!rows[0].redirect_uris.includes(String(q.redirect_uri || ''))) return 'リダイレクト先が登録と一致しません';
    return { client: rows[0] };
  }
  const hidden = (q) => ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'response_type']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] || '')}">`).join('');

  function consentPage(q, client, user, error = '') {
    const host = (() => { try { return new URL(q.redirect_uri).host; } catch { return ''; } })();
    const who = client.client_name || host;
    const loginFields = user ? `<p><strong>${esc(user.name)}</strong>（${esc(user.email)}）としてログインしています。</p>`
      : `<label>メールアドレス<input name="email" type="email" autocomplete="email" required></label>
         <label>パスワード<input name="password" type="password" autocomplete="current-password" required></label>`;
    return page('knowkinへの接続', `<h1>${esc(who)} をknowkinにつなぎますか？</h1>
      <p>許可すると、${esc(who)}（${esc(host)}）があなたの記憶・タスク・核を読み、記憶を追加できるようになります。</p>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <form method="post" action="/oauth/authorize">${hidden(q)}${loginFields}
        <div class="row"><button class="no" name="decision" value="deny">やめる</button><button class="ok" name="decision" value="allow">許可する</button></div></form>`);
  }

  r.get('/oauth/authorize', async (req, res) => {
    const chk = await checkAuthRequest(req.query);
    if (typeof chk === 'string') return res.status(400).send(page('エラー', `<h1>接続できません</h1><p class="err">${esc(chk)}</p>`));
    const user = await userFromSession(readCookie(req, 'kk_session'));
    res.send(consentPage(req.query, chk.client, user));
  });

  r.post('/oauth/authorize', async (req, res) => {
    const q = req.body || {};
    const chk = await checkAuthRequest(q);
    if (typeof chk === 'string') return res.status(400).send(page('エラー', `<h1>接続できません</h1><p class="err">${esc(chk)}</p>`));
    const back = new URL(q.redirect_uri);
    if (q.state) back.searchParams.set('state', q.state);
    if (q.decision !== 'allow') { back.searchParams.set('error', 'access_denied'); return res.redirect(back.toString()); }
    let user = await userFromSession(readCookie(req, 'kk_session'));
    if (!user) {
      if (tooManyAttempts(req.ip)) return res.status(429).send(consentPage(q, chk.client, null, 'ログインの失敗が続いたため、15分ほど待ってからお試しください'));
      user = await login(q.email, q.password);
      if (!user) { noteFailure(req.ip); return res.status(401).send(consentPage(q, chk.client, null, 'メールアドレスかパスワードが違います')); }
      clearFailures(req.ip);
    }
    const code = rnd();
    await pool.query(
      `INSERT INTO oauth_codes(code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
       VALUES($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
      [sha256(code), q.client_id, user.id, q.redirect_uri, q.code_challenge]);
    back.searchParams.set('code', code);
    res.redirect(back.toString());
  });

  r.post('/oauth/token', express.json(), async (req, res) => {
    try {
      const b = req.body || {};
      let clientId = b.client_id;
      const basic = req.get('authorization') || '';
      if (!clientId && basic.startsWith('Basic ')) clientId = Buffer.from(basic.slice(6), 'base64').toString().split(':')[0];
      if (b.grant_type === 'authorization_code') {
        const { rows } = await pool.query('DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING *', [sha256(String(b.code || ''))]);
        const c = rows[0];
        if (!c || new Date(c.expires_at) < new Date()) return res.status(400).json({ error: 'invalid_grant' });
        if (clientId && clientId !== c.client_id) return res.status(400).json({ error: 'invalid_client' });
        if (b.redirect_uri && b.redirect_uri !== c.redirect_uri) return res.status(400).json({ error: 'invalid_grant' });
        const challenge = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
        if (challenge !== c.code_challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE mismatch' });
        return res.json(await issueTokens(c.client_id, c.user_id));
      }
      if (b.grant_type === 'refresh_token') {
        const { rows } = await pool.query(
          `DELETE FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh' RETURNING *`, [sha256(String(b.refresh_token || ''))]);
        const t = rows[0];
        if (!t || new Date(t.expires_at) < new Date()) return res.status(400).json({ error: 'invalid_grant' });
        return res.json(await issueTokens(t.client_id, t.user_id));
      }
      res.status(400).json({ error: 'unsupported_grant_type' });
    } catch (e) { console.error('oauth token', e); res.status(500).json({ error: 'server_error' }); }
  });

  return r;
}

/** Claude.aiとの接続をすべて切る（アカウント画面から） */
export async function revokeAllTokens(uid) {
  await pool.query('DELETE FROM oauth_tokens WHERE user_id = $1', [uid]);
}
