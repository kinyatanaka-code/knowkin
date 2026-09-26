import crypto from 'node:crypto';
import { pool } from './db.js';

const SESSION_DAYS = 60;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 64).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const a = crypto.scryptSync(password, salt, 64);
  const b = Buffer.from(hash, 'base64url');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function userCount() {
  return (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
}

/** アカウント作成の受付状態。最初の1人は自由に作成でき、2人目以降は招待コード（SIGNUP_CODE）が必要 */
export async function signupState() {
  const n = await userCount();
  if (n === 0) return { open: true, needCode: false };
  return { open: Boolean(process.env.SIGNUP_CODE), needCode: true };
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name });

export async function createUser({ email, name, password, code }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim();
  password = String(password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('メールアドレスの形式を確認してください');
  if (password.length < 8) throw new Error('パスワードは8文字以上にしてください');
  const state = await signupState();
  if (!state.open) throw new Error('いまは新しいアカウントを作れません');
  if (state.needCode) {
    const a = Buffer.from(String(code || '')); const b = Buffer.from(process.env.SIGNUP_CODE || '');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('招待コードが違います');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const first = (await client.query('SELECT count(*)::int AS n FROM users')).rows[0].n === 0;
    const { rows } = await client.query(
      'INSERT INTO users(email, name, password_hash, link_token) VALUES($1, $2, $3, $4) RETURNING *',
      [email, name || email.split('@')[0], hashPassword(password), randomToken(24)],
    );
    const user = rows[0];
    if (first) {
      // アカウント機能を入れる前に貯めた記憶は、最初のアカウントに引き継ぐ
      await client.query('UPDATE memos SET user_id = $1 WHERE user_id IS NULL', [user.id]);
      await client.query('UPDATE units SET user_id = $1 WHERE user_id IS NULL', [user.id]);
      await client.query(
        `INSERT INTO cores(user_id, data, updated_at) SELECT $1, data, updated_at FROM core WHERE id = 1
         ON CONFLICT (user_id) DO NOTHING`, [user.id]);
    }
    await client.query('COMMIT');
    return publicUser(user);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw new Error('このメールアドレスはすでに登録されています');
    throw e;
  } finally {
    client.release();
  }
}

export async function login(email, password) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email || '').trim().toLowerCase()]);
  if (!rows[0] || !verifyPassword(String(password || ''), rows[0].password_hash)) return null;
  return publicUser(rows[0]);
}

export async function createSession(uid) {
  const token = randomToken();
  await pool.query(`INSERT INTO sessions(token_hash, user_id, expires_at) VALUES($1, $2, now() + interval '${SESSION_DAYS} days')`, [sha256(token), uid]);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  return { token, maxAge: SESSION_DAYS * 86400 };
}
export async function destroySession(token) {
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}
export async function userFromSession(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
  return rows[0] ? publicUser(rows[0]) : null;
}
export async function userFromLinkToken(token) {
  if (!token) return null;
  const { rows } = await pool.query('SELECT * FROM users WHERE link_token = $1', [token]);
  return rows[0] ? publicUser(rows[0]) : null;
}
export async function firstUser() {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY id ASC LIMIT 1');
  return rows[0] ? publicUser(rows[0]) : null;
}
export async function getLinkToken(uid) {
  return (await pool.query('SELECT link_token FROM users WHERE id = $1', [uid])).rows[0]?.link_token;
}
export async function rotateLinkToken(uid) {
  const token = randomToken(24);
  await pool.query('UPDATE users SET link_token = $1 WHERE id = $2', [token, uid]);
  return token;
}
export async function changePassword(uid, current, next) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [uid]);
  if (!rows[0] || !verifyPassword(String(current || ''), rows[0].password_hash)) throw new Error('今のパスワードが違います');
  if (String(next || '').length < 8) throw new Error('新しいパスワードは8文字以上にしてください');
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(next), uid]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [uid]);
}

// ログインの総当たり対策（IPごとに15分で10回まで）
const attempts = new Map();
export function tooManyAttempts(ip) {
  const now = Date.now(); const a = attempts.get(ip);
  if (a && a.until > now && a.count >= 10) return true;
  return false;
}
export function noteFailure(ip) {
  const now = Date.now(); const a = attempts.get(ip);
  if (!a || a.until < now) attempts.set(ip, { count: 1, until: now + 15 * 60 * 1000 });
  else a.count++;
}
export function clearFailures(ip) { attempts.delete(ip); }
