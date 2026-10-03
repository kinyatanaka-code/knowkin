// Gmail・Googleチャットのやり取りを、読み取り専用の権限で knowkin に取り込む
import crypto from 'node:crypto';
import { pool } from './db.js';
import { addMemo } from './brain.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
export const googleEnabled = Boolean(CLIENT_ID && CLIENT_SECRET);
const MOCK = process.env.GOOGLE_MOCK_BASE || ''; // テスト用
const url = (host, p) => (MOCK ? `${MOCK}/${host}${p}` : `https://${host}${p}`);
const GMAIL_QUERY = process.env.GMAIL_QUERY || '-category:promotions -category:social -category:updates -category:forums -in:spam -in:trash';
const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly',
  'https://www.googleapis.com/auth/directory.readonly',
];
const MAX_MAILS = 40;
const MAX_SPACES = 30;
const BODY_MAX = 2500;

// ---- 保存するトークンの暗号化 ----
const KEY = crypto.createHash('sha256').update(process.env.TOKEN_ENC_KEY || CLIENT_SECRET || 'knowkin').digest();
function enc(s) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const out = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), out].map((b) => b.toString('base64url')).join('.');
}
function dec(s) {
  const [iv, tag, data] = s.split('.').map((x) => Buffer.from(x, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// ---- OAuth ----
const states = new Map();
export function authUrl(uid, redirectUri) {
  const state = crypto.randomBytes(16).toString('base64url');
  states.set(state, { uid, redirectUri, exp: Date.now() + 10 * 60 * 1000 });
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return url('accounts.google.com', `/o/oauth2/v2/auth?${q}`);
}

async function postForm(u, body) {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `Google ${r.status}`);
  return j;
}

export async function handleCallback(code, state) {
  const s = states.get(state); states.delete(state);
  if (!s || s.exp < Date.now()) throw new Error('連携の手続きの期限が切れました。もう一度「Googleと連携する」を押してください');
  const t = await postForm(url('oauth2.googleapis.com', '/token'), {
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: s.redirectUri, grant_type: 'authorization_code',
  });
  if (!t.refresh_token) throw new Error('Googleから更新用のトークンが返りませんでした。Googleのアカウント設定でknowkinのアクセスを削除してから、もう一度お試しください');
  let email = '';
  try { email = JSON.parse(Buffer.from(String(t.id_token || '').split('.')[1] || '', 'base64url').toString()).email || ''; } catch { /* 取れなくても続ける */ }
  const since = new Date(Date.now() - 3 * 86400 * 1000); // 最初は直近3日分
  await pool.query(
    `INSERT INTO google_links(user_id, email, refresh_token, gmail_after, chat_after) VALUES($1, $2, $3, $4, $4)
     ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, refresh_token = EXCLUDED.refresh_token, last_error = ''`,
    [s.uid, email, enc(t.refresh_token), since]);
  return { uid: s.uid, email };
}

export async function googleStatus(uid) {
  const { rows } = await pool.query('SELECT email, last_sync_at, last_result, last_error FROM google_links WHERE user_id = $1', [uid]);
  return rows[0] ? { linked: true, ...rows[0] } : { linked: false };
}

export async function unlink(uid) {
  const { rows } = await pool.query('DELETE FROM google_links WHERE user_id = $1 RETURNING refresh_token', [uid]);
  if (rows[0]) {
    try { await postForm(url('oauth2.googleapis.com', '/revoke'), { token: dec(rows[0].refresh_token) }); } catch { /* 取り消しに失敗しても連携は外す */ }
  }
}

async function accessToken(link) {
  const t = await postForm(url('oauth2.googleapis.com', '/token'), {
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: dec(link.refresh_token), grant_type: 'refresh_token',
  });
  return t.access_token;
}
async function gget(token, host, p) {
  const r = await fetch(url(host, p), { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || `Google ${r.status}`), { status: r.status });
  return j;
}

// ---- Gmail ----
const b64 = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function findPart(part, mime) {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return part.body.data;
  for (const p of part.parts || []) { const f = findPart(p, mime); if (f) return f; }
  return null;
}
function stripHtml(h) {
  return h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
/** 返信の引用部分や署名の下を落として、そのメールで新しく書かれた部分だけにする */
export function cleanBody(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^On .+wrote:\s*$/.test(l) || /^20\d\d[年\/-].+(に|、).+(書き込みました|wrote)/.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^From:\s/.test(l) && out.length > 3) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, BODY_MAX);
}
async function syncGmail(uid, token, link) {
  const after = Math.floor(new Date(link.gmail_after || Date.now() - 3 * 86400 * 1000).getTime() / 1000);
  const list = await gget(token, 'gmail.googleapis.com', `/gmail/v1/users/me/messages?maxResults=${MAX_MAILS}&q=${encodeURIComponent(`after:${after} ${GMAIL_QUERY}`)}`);
  let saved = 0; let newest = after * 1000;
  for (const m of (list.messages || []).reverse()) {
    const msg = await gget(token, 'gmail.googleapis.com', `/gmail/v1/users/me/messages/${m.id}?format=full`);
    const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
    const plain = findPart(msg.payload, 'text/plain');
    const html = plain ? null : findPart(msg.payload, 'text/html');
    const body = cleanBody(plain ? b64(plain) : html ? stripHtml(b64(html)) : (msg.snippet || ''));
    const text = [`【Gmail】${h.subject || '（件名なし）'}`, `差出人：${h.from || ''}`, `宛先：${h.to || ''}${h.cc ? ` / CC：${h.cc}` : ''}`, `日時：${h.date || ''}`, '', body].join('\n');
    const r = await addMemo(uid, text, 'gmail', null, `gmail:${m.id}`);
    if (!r.duplicate) saved++;
    newest = Math.max(newest, Number(msg.internalDate || 0));
  }
  await pool.query('UPDATE google_links SET gmail_after = $2 WHERE user_id = $1', [uid, new Date(newest)]);
  return saved;
}

// ---- Googleチャット ----
const nameCache = new Map();
async function personName(token, userName) {
  if (!userName) return '不明';
  if (nameCache.has(userName)) return nameCache.get(userName);
  let n = userName;
  try {
    const id = userName.replace(/^users\//, '');
    const p = await gget(token, 'people.googleapis.com', `/v1/people/${id}?personFields=names,emailAddresses&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE`);
    n = p.names?.[0]?.displayName || p.emailAddresses?.[0]?.value || userName;
  } catch { /* 名前が引けないときは id のまま */ }
  nameCache.set(userName, n);
  return n;
}
const hm = (iso) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
async function syncChat(uid, token, link) {
  const since = new Date(link.chat_after || Date.now() - 3 * 86400 * 1000);
  const spaces = await gget(token, 'chat.googleapis.com', `/v1/spaces?pageSize=${MAX_SPACES}`);
  let saved = 0; let newest = since.getTime();
  const { rows: prefs } = await pool.query('SELECT name FROM google_spaces WHERE user_id = $1 AND excluded', [uid]);
  const excluded = new Set(prefs.map((r) => r.name));
  for (const sp of spaces.spaces || []) {
    const spTitle = sp.displayName || (sp.spaceType === 'DIRECT_MESSAGE' || sp.type === 'DM' ? 'ダイレクトメッセージ' : 'チャット');
    await pool.query(
      `INSERT INTO google_spaces(user_id, name, title, last_seen_at) VALUES($1, $2, $3, now())
       ON CONFLICT (user_id, name) DO UPDATE SET title = EXCLUDED.title, last_seen_at = now()`, [uid, sp.name, spTitle]);
    if (excluded.has(sp.name)) continue;
    const f = encodeURIComponent(`createTime > "${since.toISOString()}"`);
    let msgs;
    try { msgs = await gget(token, 'chat.googleapis.com', `/v1/${sp.name}/messages?pageSize=100&orderBy=createTime&filter=${f}`); }
    catch (e) { if (e.status === 403 || e.status === 404) continue; throw e; }
    const list = (msgs.messages || []).filter((m) => m.text || m.formattedText);
    if (!list.length) continue;
    const lines = [];
    for (const m of list) {
      lines.push(`${hm(m.createTime)} ${m.sender?.displayName || await personName(token, m.sender?.name)}：${String(m.text || '').replace(/\s+/g, ' ').slice(0, 500)}`);
      newest = Math.max(newest, new Date(m.createTime).getTime());
    }
    const title = sp.displayName || (sp.spaceType === 'DIRECT_MESSAGE' || sp.type === 'DM' ? 'ダイレクトメッセージ' : 'チャット');
    const text = [`【Googleチャット】${title}`, '', ...lines].join('\n').slice(0, 6000);
    const r = await addMemo(uid, text, 'gchat', null, `gchat:${sp.name}:${list[list.length - 1].name}`);
    if (!r.duplicate) { saved++; await pool.query('UPDATE google_spaces SET msg_count = msg_count + $3 WHERE user_id = $1 AND name = $2', [uid, sp.name, list.length]); }
  }
  await pool.query('UPDATE google_links SET chat_after = $2 WHERE user_id = $1', [uid, new Date(newest)]);
  return saved;
}

/** 1人分を取り込む */
export async function syncUser(uid) {
  const { rows } = await pool.query('SELECT * FROM google_links WHERE user_id = $1', [uid]);
  const link = rows[0];
  if (!link) throw new Error('Googleと連携していません');
  const parts = []; const errs = [];
  try {
    const token = await accessToken(link);
    try { parts.push(`Gmail ${await syncGmail(uid, token, link)}件`); } catch (e) { errs.push(`Gmail：${e.message}`); }
    try { parts.push(`チャット ${await syncChat(uid, token, link)}件`); } catch (e) { errs.push(`チャット：${e.message}`); }
  } catch (e) { errs.push(`Googleにつなげませんでした：${e.message}`); }
  await pool.query('UPDATE google_links SET last_sync_at = now(), last_result = $2, last_error = $3 WHERE user_id = $1', [uid, parts.join('・'), errs.join(' / ')]);
  return { result: parts.join('・'), error: errs.join(' / ') };
}

/** 連携している全員分（定期実行用） */
export async function syncAll() {
  if (!googleEnabled) return;
  const { rows } = await pool.query('SELECT user_id FROM google_links');
  for (const r of rows) { try { await syncUser(r.user_id); } catch (e) { console.error('google sync', r.user_id, e.message); } }
}

/** 取り込み対象のスペース一覧（よく取り込まれている順） */
export async function listSpaces(uid) {
  const { rows } = await pool.query(
    `SELECT name, title, excluded, msg_count, last_seen_at FROM google_spaces WHERE user_id = $1 ORDER BY msg_count DESC, title`, [uid]);
  return rows;
}
export async function setSpaceExcluded(uid, name, excluded) {
  await pool.query('UPDATE google_spaces SET excluded = $3 WHERE user_id = $1 AND name = $2', [uid, String(name), Boolean(excluded)]);
  if (excluded) {
    // まだ整理していない、このスペースからのメモは片づける（記憶にはしない）
    await pool.query(`UPDATE memos SET classified = TRUE WHERE user_id = $1 AND NOT classified AND ref LIKE $2`, [uid, `gchat:${name}:%`]);
  }
}
