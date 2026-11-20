// kinbot・kincall・kinXs の記録を、kinbot の読み取り専用の入口（/api/knowkin/feed）から続きの分だけ取り込む。
// 設定（Railwayの環境変数）：KINBOT_URL（例 https://kinbot-production-225f.up.railway.app）、KINBOT_TOKEN（kinbot の API_TOKENS に入れた管理者のトークン）
// 取り込んだものは biz_records に入り、企業情報に会社ごとに並ぶ。Claude を通さないのでトークンはかからない。
import { pool } from './db.js';

export const FEED_KINDS = ['meetings', 'deal_events', 'calls', 'kinxs_accounts', 'kinxs_history', 'kinxs_voices', 'docai', 'doc_views'];
const SOURCE = { calls: 'kincall', kinxs_accounts: 'kinxs', kinxs_history: 'kinxs', kinxs_voices: 'kinxs', docai: 'kinxs' };
const KIND_LABEL = { meetings: '商談', deal_events: '商談の動き', calls: '架電', kinxs_accounts: 'DOCの契約企業', kinxs_history: '契約企業の変更', kinxs_voices: 'お客様の声', docai: '候補者の質問', doc_views: '資料の閲覧' };
export const kindLabel = (k) => KIND_LABEL[k] || k;

export function kinbotConfig() {
  const url = (process.env.KINBOT_URL || '').trim().replace(/\/+$/, '');
  const token = (process.env.KINBOT_TOKEN || '').trim();
  return { url, token, ready: /^https?:\/\//.test(url) && Boolean(token) };
}

// 会社名をまとめる用の名前に（株式会社・(株)・空白などを外す）
export function companyKey(name) {
  return String(name || '').normalize('NFKC')
    .replace(/(株式会社|有限会社|合同会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|社会福祉法人|医療法人社団|医療法人|学校法人|\(株\)|（株）|\(有\)|（有）|様|御中)/g, '')
    .replace(/[\s・\-ー_]/g, '').toLowerCase().slice(0, 80);
}
const displayName = (name) => String(name || '').normalize('NFKC').replace(/^(株式会社|有限会社|合同会社)\s*|\s*(株式会社|有限会社|合同会社)$/g, '').trim().slice(0, 80);

const yesterdayJST = () => new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);

async function fetchFeed(cfg, kind, after) {
  const u = `${cfg.url}/api/knowkin/feed?kind=${encodeURIComponent(kind)}&limit=500&after=${encodeURIComponent(after || '')}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `kinbot ${r.status}`);
  if (!Array.isArray(j.items)) throw new Error('kinbot がまだ新しい版になっていないか、入口が見つかりません');
  return j;
}

async function upsert(uid, kind, items) {
  let n = 0;
  for (const it of items) {
    if (!it || !it.ref) continue;
    const company = displayName(it.company);
    await pool.query(
      `INSERT INTO biz_records(user_id, ref, source, kind, company, company_key, title, body, people, at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, ref) DO UPDATE SET kind = EXCLUDED.kind, company = EXCLUDED.company, company_key = EXCLUDED.company_key,
         title = EXCLUDED.title, body = EXCLUDED.body, people = EXCLUDED.people, at = EXCLUDED.at, updated_at = now()`,
      [uid, String(it.ref).slice(0, 300), SOURCE[kind] || 'kinbot', String(it.kind || kindLabel(kind)).slice(0, 40), company, companyKey(company),
        String(it.title || '').slice(0, 300), String(it.body || '').slice(0, 6000), (Array.isArray(it.people) ? it.people : []).map(String).slice(0, 10),
        it.at && !Number.isNaN(Date.parse(it.at)) ? it.at : new Date().toISOString()]);
    n++;
  }
  return n;
}

let running = false;
/** 続きの分を取り込む。1回で取りすぎないよう、種類ごとに maxPages ページ（1ページ最大500件）まで */
export async function syncKinbot(uid, { maxPages = 10 } = {}) {
  const cfg = kinbotConfig();
  if (!cfg.ready) return { skipped: 'KINBOT_URL と KINBOT_TOKEN が設定されていません' };
  if (running) return { skipped: '取り込み中です' };
  running = true;
  const result = {};
  try {
    for (const kind of FEED_KINDS) {
      const st = (await pool.query('SELECT cursor, total FROM biz_sync WHERE user_id = $1 AND kind = $2', [uid, kind])).rows[0] || { cursor: '', total: 0 };
      let cursor = st.cursor; let added = 0; let done = false; let error = '';
      try {
        for (let p = 0; p < maxPages; p++) {
          const j = await fetchFeed(cfg, kind, cursor);
          added += await upsert(uid, kind, j.items);
          cursor = j.next ?? cursor;
          if (j.done) { done = true; break; }
        }
        // 架電は日ごとにまとめているので、前日と当日はあとから増える。次の回にもう一度取りに行く
        if (kind === 'calls' && cursor && cursor > yesterdayJST()) cursor = yesterdayJST();
      } catch (e) { error = e.message.slice(0, 300); }
      await pool.query(
        `INSERT INTO biz_sync(user_id, kind, cursor, total, done, last_at, last_error) VALUES($1,$2,$3,$4,$5,now(),$6)
         ON CONFLICT (user_id, kind) DO UPDATE SET cursor = $3, total = biz_sync.total + $7, done = $5, last_at = now(), last_error = $6`,
        [uid, kind, cursor || '', st.total + added, done, error, added]);
      result[kind] = error ? `エラー：${error}` : added;
    }
  } finally { running = false; }
  return result;
}

export async function kinbotStatus(uid) {
  const cfg = kinbotConfig();
  const rows = (await pool.query('SELECT kind, total, done, last_at, last_error FROM biz_sync WHERE user_id = $1', [uid])).rows;
  const count = (await pool.query('SELECT count(*)::int AS n, count(DISTINCT company_key)::int AS c FROM biz_records WHERE user_id = $1', [uid])).rows[0];
  return { ready: cfg.ready, url: cfg.url, records: count.n, companies: count.c,
    kinds: FEED_KINDS.map((k) => ({ kind: k, label: kindLabel(k), ...(rows.find((r) => r.kind === k) || { total: 0, done: false, last_at: null, last_error: '' }) })) };
}

/** 企業情報の一覧：取り込んだ記録と、記憶ユニット（realm = company）を会社ごとに */
export async function listCompanies(uid, q = '') {
  const like = q ? `%${q}%` : null;
  const { rows } = await pool.query(
    `WITH r AS (
       SELECT company_key AS key, company, kind, at, title FROM biz_records WHERE user_id = $1 AND company_key <> ''
       UNION ALL
       SELECT lower(company) AS key, company, '記憶' AS kind, created_at AS at, content AS title FROM units WHERE user_id = $1 AND realm = 'company'
     )
     SELECT key, (array_agg(company ORDER BY at DESC))[1] AS company, count(*)::int AS n, max(at) AS last_at,
            (array_agg(kind || '：' || left(title, 80) ORDER BY at DESC))[1] AS latest,
            array_agg(DISTINCT kind) AS kinds
     FROM r WHERE ($2::text IS NULL OR company ILIKE $2 OR title ILIKE $2) GROUP BY key ORDER BY max(at) DESC LIMIT 400`, [uid, like]);
  return rows;
}

export async function companyDetail(uid, key, limit = 300) {
  const recs = (await pool.query(
    `SELECT id, source, kind, company, title, body, people, to_char(at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS at_jst
     FROM biz_records WHERE user_id = $1 AND company_key = $2 ORDER BY at DESC LIMIT $3`, [uid, key, limit])).rows;
  return recs;
}

/** 会社名・キーワードで探す（Claude・Geminiなどのコネクタ用） */
export async function searchBiz(uid, query, limit = 30) {
  const like = `%${query}%`;
  return (await pool.query(
    `SELECT kind, company, title, body, to_char(at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS day FROM biz_records
     WHERE user_id = $1 AND (company ILIKE $2 OR company_key = $3 OR title ILIKE $2 OR body ILIKE $2)
     ORDER BY at DESC LIMIT $4`, [uid, like, companyKey(query), limit])).rows;
}
