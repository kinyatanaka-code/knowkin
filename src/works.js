// 作ったもの（成果物）の置き場（2026-11-22 田中さん「クロードで作った資料とかも全部knowkinに渡したい。geminiでも続きを作れるように」）。
//   Claude・Gemini が作った提案資料・ドキュメント・メール・分析などを、全文のまま残す。
//   同じ ref で保存し直すと「続き」として上書きし、前の版は works_versions に残す（続きを作って前の版を消してしまわないように）。
//   Gemini には Apps Script が1件1ドキュメントにして渡し、Gemini が続きを作ったら knowkin_calls の save_work で戻ってくる。
import { pool } from './db.js';

const MAX = 400000;   // 1件の上限（Claude の大きな資料でも入る大きさ）
let ready = false;
async function ensure() {
  if (ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS works (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL, ref TEXT NOT NULL, title TEXT NOT NULL, kind TEXT, company TEXT, format TEXT,
    content TEXT NOT NULL, url TEXT, notes TEXT, ai TEXT, version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE (user_id, ref))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS works_versions (
    work_id INT NOT NULL, version INT NOT NULL, content TEXT, notes TEXT, ai TEXT, at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (work_id, version))`);
  ready = true;
}

export const WORK_KINDS = ['提案資料', 'スライド', 'ドキュメント', 'メール', '分析', '表', 'ページ', 'そのほか'];
const slug = (t) => String(t || '').normalize('NFKC').replace(/[\s/\\?#%&:"'<>|*]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'work';
const day = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());

/** 作ったものを残す。ref が同じなら続きとして上書き（前の版は残す） */
export async function saveWork(uid, w) {
  await ensure();
  const content = String(w.content || '').replace(/\u0000/g, '');
  if (!content.trim()) throw new Error('content（作ったものの全文）が空です');
  const ref = String(w.ref || '').trim().slice(0, 150) || `${w.ai || 'ai'}:${slug(w.title)}-${day()}`;
  const old = (await pool.query('SELECT id, version, content, notes, ai FROM works WHERE user_id = $1 AND ref = $2', [uid, ref])).rows[0];
  const vals = [String(w.title || '').slice(0, 200) || '作ったもの', w.kind ? String(w.kind).slice(0, 20) : null, w.company ? String(w.company).slice(0, 100) : null,
    w.format ? String(w.format).slice(0, 20) : null, content.slice(0, MAX), w.url ? String(w.url).slice(0, 500) : null, w.notes ? String(w.notes).slice(0, 4000) : null, w.ai || null];
  if (old) {
    if (old.content === vals[4] && (old.notes || null) === vals[6]) return { id: old.id, ref, version: old.version, unchanged: true };
    await pool.query('INSERT INTO works_versions(work_id, version, content, notes, ai) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [old.id, old.version, old.content, old.notes, old.ai]);
    const { rows } = await pool.query(`UPDATE works SET title = $3, kind = COALESCE($4, kind), company = COALESCE($5, company), format = COALESCE($6, format), content = $7,
        url = COALESCE($8, url), notes = $9, ai = $10, version = version + 1, updated_at = now() WHERE user_id = $1 AND ref = $2 RETURNING id, version`, [uid, ref, ...vals]);
    return { id: rows[0].id, ref, version: rows[0].version, updated: true };
  }
  const { rows } = await pool.query(`INSERT INTO works(user_id, ref, title, kind, company, format, content, url, notes, ai) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, version`, [uid, ref, ...vals]);
  return { id: rows[0].id, ref, version: rows[0].version, created: true };
}

const head = `id, ref, title, kind, company, format, url, notes, ai, version, length(content) AS chars,
  to_char(updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS updated, to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS created`;
export async function listWorks(uid, { q = '', limit = 50 } = {}) {
  await ensure();
  const like = `%${String(q || '').trim()}%`;
  const { rows } = await pool.query(`SELECT ${head} FROM works WHERE user_id = $1 AND ($2 = '%%' OR title ILIKE $2 OR company ILIKE $2 OR kind ILIKE $2 OR content ILIKE $2)
    ORDER BY updated_at DESC LIMIT $3`, [uid, like, Math.min(200, Number(limit) || 50)]);
  return rows;
}
export async function getWork(uid, key) {
  await ensure();
  const k = String(key || '').trim();
  const { rows } = await pool.query(`SELECT ${head}, content FROM works WHERE user_id = $1 AND (ref = $2 OR id::text = $2)`, [uid, k]);
  return rows[0] || null;
}
export async function getWorksByIds(uid, ids) {
  await ensure();
  const { rows } = await pool.query(`SELECT ${head}, content FROM works WHERE user_id = $1 AND id = ANY($2::int[])`, [uid, ids.map(Number).filter(Number.isFinite)]);
  return rows;
}
export const AI_NAME = { claude: 'Claude', gemini: 'Gemini', chatgpt: 'ChatGPT' };
/** 1件を、AI が続きを作れる形の文章にする（Gemini のドキュメント・get_work の結果） */
export function workText(w) {
  return [`# 作ったもの：${w.title}`, '',
    `- ref：${w.ref}（続きを保存するときは、この ref のまま save_work する）`,
    `- 種類：${w.kind || '－'}${w.company ? `　会社：${w.company}` : ''}　形式：${w.format || 'テキスト'}`,
    `- 作ったAI：${AI_NAME[w.ai] || w.ai || '－'}　版：${w.version}　更新：${w.updated}${w.url ? `\n- 元の場所：${w.url}` : ''}`,
    w.notes ? `- 残っていること・メモ：${w.notes}` : null, '', '---', '', w.content].filter((x) => x !== null).join('\n');
}
export function worksIndex(rows) {
  if (!rows.length) return 'まだありません。';
  return rows.map((w) => `- ${w.ref}：${w.title}（${w.kind || '－'}${w.company ? `・${w.company}` : ''}・${AI_NAME[w.ai] || w.ai || ''}・版${w.version}・${w.updated}・${w.chars}字）${w.notes ? `\n  残り：${String(w.notes).slice(0, 120)}` : ''}`).join('\n');
}
