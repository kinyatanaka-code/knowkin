import { pool } from './db.js';
import { complete, aiEnabled } from './ai.js';
import { askAudioJSON, canSummarizeAudio } from './audio.js';
import { canTranscribe, transcribe } from './transcribe.js';
import { toJpeg } from './photo.js';

export const TYPES = {
  event: { label: '記憶', layer: '出来事' },
  input: { label: 'インプット', layer: '知識' },
  lesson: { label: 'フィードバック・教訓', layer: '知識' },
  idea: { label: 'アイディア', layer: '思考' },
  decision: { label: '判断と理由', layer: '思考' },
  value: { label: '価値観', layer: '思考' },
  question: { label: '未解決の問い', layer: '思考' },
  task: { label: 'タスク', layer: '行動' },
  goal: { label: '目標', layer: '行動' },
  person: { label: '人物', layer: '関係' },
};

export const UNIT_COLS = `id, memo_id, type, content, quote, reason, people, tags, due, importance, count,
  done, done_at, reviewed, created_at, to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS day`;

export const todayJST = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());

async function askJSON(prompt, maxTokens = 4000) {
  const text = await complete(prompt, maxTokens);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AIからJSONが返りませんでした');
  return JSON.parse(m[0]);
}

const imp = (v) => ([1, 2, 3].includes(Number(v)) ? Number(v) : 2);
const strArr = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
const validDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export const CLASSIFY_RULES = `## 種類（type）
- event: 起きた出来事の記憶
- input: 本や会話から得た知識・情報
- lesson: 他人からのフィードバック、失敗や成功から得た教訓
- idea: 思いついたアイディア・企画・改善案
- decision: 本人が下した判断とその理由
- value: 本人が大事にしている価値観・信条・仕事の軸
- question: まだ答えが出ていない疑問・悩み
- task: やるべきこと（人からの依頼を含む）
- goal: 達成したい目標
- person: ある人物の特徴・判断基準・関係性

## ルール
- 1つのメモに複数の内容があれば、必ず別々のユニットに分ける
- content は本人の視点で、後から読んでも意味がわかる1〜2文にする
- 他人の発言は quote に、なるべく言われた言葉のまま入れる（なければ空文字）
- decision には reason（なぜそう決めたか）を入れる。メモに理由がなければ空文字にし、推測で作らない
- people には関係する人物名、tags には会社名やテーマなどのキーワードを入れる
- task と goal の期限がわかれば due に YYYY-MM-DD で入れる。「来週金曜」などは日付に直す。不明なら null
- importance は 1〜3（3が最も重要）
- 既存の記憶とほぼ同じ内容（同じフィードバックを再び受けた等）なら same_as にその id（数値）を入れる。違えば null
- メモに書かれていないことは付け足さない`;

export const CORE_RULES = `- 繰り返されているもの（count が大きいもの）、重要度が高いものを優先する
- 記憶に書かれていないことは推測で付け足さない
- 人物ごとに、その人が大事にしていること・よく言うことをまとめる
- 各項目は短く具体的な1文にする。各リストは最大7項目`;

function classifyPrompt(text, today, existing) {
  return `あなたは「knowkin」という、ある一人の人のための第二の脳の整理係です。
次のメモ（本人が話した内容の文字起こしや手書きメモ）を、意味のまとまりごとに「記憶ユニット」に分解してください。今日は ${today} です。

${CLASSIFY_RULES}

## 既存の記憶
${JSON.stringify(existing)}

## メモ
${text}

## 出力
次の形のJSONだけを出力してください。前置きや説明は不要です。
{"units":[{"type":"lesson","content":"","quote":"","reason":"","people":[],"tags":[],"due":null,"importance":2,"same_as":null}]}`;
}

export async function addMemo(uid, text, source = 'text', units = null, ref = null) {
  if (ref) {
    const dup = await pool.query('SELECT id FROM memos WHERE user_id = $1 AND ref = $2', [uid, ref]);
    if (dup.rows[0]) return { memo_id: dup.rows[0].id, added: 0, repeated: 0, duplicate: true };
  }
  const { rows } = await pool.query('INSERT INTO memos(user_id, text, source, ref) VALUES($1, $2, $3, $4) RETURNING *', [uid, text, source, ref]);
  const memo = rows[0];
  if (Array.isArray(units) && units.length) return { memo_id: memo.id, ...(await applyUnits(memo, units)) };
  if (!aiEnabled) return { memo_id: memo.id, added: 0, repeated: 0, pending: true };
  try {
    return { memo_id: memo.id, ...(await classifyMemo(memo)) };
  } catch (e) {
    console.error('classify failed', e);
    return { memo_id: memo.id, added: 0, repeated: 0, error: '原本は保存しましたが、分類に失敗しました' };
  }
}

export async function classifyMemoById(uid, id) {
  if (!aiEnabled) throw new Error('AIなしモードです。Claudeとの会話で「knowkinの未整理メモを整理して」と頼んでください');
  const { rows } = await pool.query('SELECT * FROM memos WHERE id = $1 AND user_id = $2', [id, uid]);
  if (!rows[0]) throw new Error('メモが見つかりません');
  return classifyMemo(rows[0]);
}

/** 重複判定用の既存の記憶 */
export async function getDedupList(uid) {
  return (await pool.query(
    `SELECT id, type, left(content, 90) AS content FROM units
     WHERE user_id = $2 AND type = ANY($1) ORDER BY created_at DESC LIMIT 80`,
    [['lesson', 'value', 'decision', 'person', 'idea', 'goal', 'question', 'input'], uid],
  )).rows;
}

async function classifyMemo(memo) {
  const existing = await getDedupList(memo.user_id);
  const res = await askJSON(classifyPrompt(memo.text, todayJST(), existing));
  return applyUnits(memo, Array.isArray(res.units) ? res.units : []);
}

/** 録音・ボイスメモを文字起こし・要約し、記憶ユニットに分けて保存する */
export async function addVoice(uid, buffer, filename, mimetype, onStage = () => {}) {
  if (canSummarizeAudio) {
    const existing = await getDedupList(uid);
    const r = await askAudioJSON(buffer, `あなたは「knowkin」という、ある一人の人のための第二の脳の整理係です。
この録音は、本人の対面での会話、上司からのフィードバック、会議、または本人のひとり言のボイスメモです。今日は ${todayJST()} です。
録音を聞いて、次の4つを作ってください。

1. transcript：文字起こし。話者が区別できれば「本人：」「相手：」のように付ける。言いよどみや相づちは省いてよい
2. title：内容がひと目でわかる20字以内のタイトル
3. summary：要点を3〜5個の短い文で（誰が何を言ったか、何が決まったか、次に何をするか）
4. units：記憶ユニット。次のルールに従う

${CLASSIFY_RULES}

## 既存の記憶
${JSON.stringify(existing)}

## 出力
次の形のJSONだけを出力してください。
{"title":"","summary":[],"transcript":"","units":[{"type":"lesson","content":"","quote":"","reason":"","people":[],"tags":[],"due":null,"importance":2,"same_as":null}]}`, onStage);
    const units = Array.isArray(r.units) ? r.units : [];
    onStage('save');
    const { rows } = await pool.query(
      `INSERT INTO memos(user_id, text, source, title, summary) VALUES($4, $1, 'voice', $2, $3) RETURNING *`,
      [String(r.transcript || '（文字起こしなし）'), String(r.title || '録音'), strArr(r.summary), uid],
    );
    const saved = await applyUnits(rows[0], units);
    return {
      memo_id: rows[0].id, title: rows[0].title, summary: rows[0].summary, transcript: rows[0].text,
      units: units.filter((u) => u && u.content).map((u) => ({ type: TYPES[u.type] ? u.type : 'event', content: String(u.content) })),
      ...saved,
    };
  }
  if (canTranscribe) {
    onStage('ai', { minutes: 0 });
    const text = await transcribe(buffer, filename, mimetype);
    onStage('save');
    if (!text) throw new Error('音声から文字を読み取れませんでした');
    const r = await addMemo(uid, text, 'voice');
    return { ...r, title: '録音', summary: [], transcript: text, units: [] };
  }
  throw new Error('録音を扱うには GEMINI_API_KEY の設定が必要です');
}

export async function getRecentRecordings(uid, limit = 10) {
  const { rows } = await pool.query(
    `SELECT id, title, summary, text, classified, to_char(recorded_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS recorded_at
     FROM memos WHERE user_id = $2 AND source = 'voice' ORDER BY recorded_at DESC LIMIT $1`, [limit, uid]);
  return rows;
}

/** 写真のメモ。分類はClaudeが画像を見て行う */
export async function addPhoto(uid, buffer, mimetype, caption = '') {
  const img = await toJpeg(buffer, mimetype);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO memos(user_id, text, source) VALUES($1, $2, 'photo') RETURNING id`, [uid, String(caption || '').trim() || '（写真）']);
    await client.query('INSERT INTO memo_images(memo_id, mime, data) VALUES($1, $2, $3)', [rows[0].id, img.mime, img.data]);
    await client.query('COMMIT');
    return { memo_id: rows[0].id, pending: true };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

export async function getPhoto(uid, memoId) {
  const { rows } = await pool.query(
    `SELECT i.mime, i.data FROM memo_images i JOIN memos m ON m.id = i.memo_id WHERE m.id = $1 AND m.user_id = $2`, [memoId, uid]);
  return rows[0] || null;
}

export async function getRecentPhotos(uid, limit = 12) {
  const { rows } = await pool.query(
    `SELECT id, title, summary, text, classified, to_char(recorded_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS recorded_at
     FROM memos WHERE user_id = $2 AND source = 'photo' ORDER BY recorded_at DESC LIMIT $1`, [limit, uid]);
  return rows;
}

/** 未整理の写真（画像つき） */
export async function getUnclassifiedPhotos(uid, limit = 4) {
  const { rows } = await pool.query(
    `SELECT m.id, m.text, i.mime, i.data FROM memos m JOIN memo_images i ON i.memo_id = m.id
     WHERE m.user_id = $1 AND NOT m.classified ORDER BY m.recorded_at ASC LIMIT $2`, [uid, limit]);
  return rows;
}

/** すでに取り込み済みの ref を返す */
export async function importedRefs(uid, refs) {
  if (!refs.length) return [];
  const { rows } = await pool.query('SELECT ref FROM memos WHERE user_id = $1 AND ref = ANY($2)', [uid, refs]);
  return rows.map((r) => r.ref);
}

/** 未整理のメモ（Claudeとの会話で整理する用） */
export async function getUnclassified(uid, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, text, source, to_char(recorded_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS recorded_at
     FROM memos WHERE user_id = $2 AND NOT classified AND source <> 'photo' ORDER BY recorded_at ASC LIMIT $1`, [limit, uid]);
  return rows;
}

export async function countUnclassified(uid) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM memos WHERE user_id = $1 AND NOT classified', [uid]);
  return rows[0].n;
}

/** 分類済みのユニットを、指定のメモの記憶として保存する */
export async function saveUnitsForMemo(uid, memoId, units, { title = '', summary = [] } = {}) {
  const { rows } = await pool.query('SELECT * FROM memos WHERE id = $1 AND user_id = $2', [memoId, uid]);
  if (!rows[0]) throw new Error(`メモ ${memoId} が見つかりません`);
  if (rows[0].classified) throw new Error(`メモ ${memoId} はすでに整理済みです`);
  if (title || (summary && summary.length)) {
    await pool.query('UPDATE memos SET title = $1, summary = $2 WHERE id = $3', [String(title || rows[0].title || ''), strArr(summary), memoId]);
  }
  return applyUnits(rows[0], units);
}

async function applyUnits(memo, list) {
  const today = todayJST();
  let added = 0;
  let repeated = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of list) {
      if (!r || !r.content) continue;
      const type = TYPES[r.type] ? r.type : 'event';
      const sameId = Number(r.same_as);
      if (sameId) {
        const hit = await client.query(
          `UPDATE units SET
             count = count + 1,
             dates = array_append(dates, $2::date),
             importance = LEAST(3, GREATEST(importance, $3) + CASE WHEN count + 1 >= 3 THEN 1 ELSE 0 END),
             quote = CASE WHEN quote = '' THEN $4 ELSE quote END
           WHERE id = $1 AND user_id = $5`,
          [sameId, today, imp(r.importance), String(r.quote || ''), memo.user_id],
        );
        if (hit.rowCount) { repeated++; continue; }
      }
      await client.query(
        `INSERT INTO units(user_id, memo_id, type, content, quote, reason, people, tags, due, importance, dates)
         VALUES($11, $1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY[$10::date])`,
        [memo.id, type, String(r.content), String(r.quote || ''), String(r.reason || ''),
          strArr(r.people), strArr(r.tags), validDate(r.due), imp(r.importance), today, memo.user_id],
      );
      added++;
    }
    await client.query('UPDATE memos SET classified = TRUE WHERE id = $1', [memo.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { added, repeated };
}

/** 核を作るための材料 */
export async function getCoreMaterial(uid) {
  const { rows } = await pool.query(
    `SELECT type, content, quote, reason, people, count, importance FROM units
     WHERE user_id = $2 AND type = ANY($1) ORDER BY count DESC, importance DESC, created_at DESC LIMIT 300`,
    [['lesson', 'value', 'decision', 'person', 'goal', 'question', 'idea'], uid],
  );
  return rows;
}

export async function saveCore(uid, r) {
  const data = {
    summary: String(r.summary || ''),
    values: strArr(r.values),
    decision_rules: strArr(r.decision_rules),
    lessons: strArr(r.lessons),
    people: (Array.isArray(r.people) ? r.people : []).filter((p) => p && p.name)
      .map((p) => ({ name: String(p.name), points: strArr(p.points) })),
    open_questions: strArr(r.open_questions),
  };
  await pool.query(
    `INSERT INTO cores(user_id, data, updated_at) VALUES($2, $1, now())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [data, uid],
  );
  return data;
}

export async function growCore(uid) {
  if (!aiEnabled) throw new Error('AIなしモードです。Claudeとの会話で「knowkinの核を育てて」と頼んでください');
  const rows = await getCoreMaterial(uid);
  if (rows.length < 3) return null;
  const r = await askJSON(`あなたは「knowkin」という個人の第二の脳の整理係です。
以下は本人が残した記憶ユニットです（count は同じ内容が繰り返された回数、importance は重要度）。
これを読み直し、この人の「考え方の核」をまとめてください。

## ルール
${CORE_RULES}

## 記憶ユニット
${JSON.stringify(rows)}

## 出力
次の形のJSONだけを出力してください。
{"summary":"この人の考え方を1〜2文で","values":[],"decision_rules":[],"lessons":[],"people":[{"name":"","points":[]}],"open_questions":[]}`);
  return saveCore(uid, r);
}

/** 前回の核の更新以降に新しい記憶があるユーザーの核を育てる（夜間バッチ用） */
export async function growCoresIfChanged() {
  if (!aiEnabled) return 0;
  const { rows } = await pool.query(
    `SELECT u.user_id FROM (SELECT user_id, max(created_at) AS at FROM units WHERE user_id IS NOT NULL GROUP BY user_id) u
     LEFT JOIN cores c ON c.user_id = u.user_id WHERE c.updated_at IS NULL OR c.updated_at < u.at`);
  let n = 0;
  for (const r of rows) { try { if (await growCore(r.user_id)) n++; } catch (e) { console.error('核の更新に失敗', r.user_id, e.message); } }
  return n;
}

export async function getCore(uid) {
  const { rows } = await pool.query('SELECT data, updated_at FROM cores WHERE user_id = $1', [uid]);
  return rows[0] ? { ...rows[0].data, updatedAt: rows[0].updated_at } : null;
}

export async function getOpenTasks(uid) {
  const { rows } = await pool.query(
    `SELECT ${UNIT_COLS} FROM units WHERE user_id = $1 AND type IN ('task', 'goal') AND NOT done
     ORDER BY due ASC NULLS LAST, created_at ASC`, [uid],
  );
  return rows;
}

export async function searchUnits(uid, { query = '', type = null, person = null, limit = 20 } = {}) {
  const where = ['user_id = $1'];
  const params = [uid];
  if (query) {
    params.push(`%${query}%`);
    where.push(`(content ILIKE $${params.length} OR quote ILIKE $${params.length} OR reason ILIKE $${params.length}
      OR array_to_string(people, ' ') ILIKE $${params.length} OR array_to_string(tags, ' ') ILIKE $${params.length})`);
  }
  if (type && TYPES[type]) { params.push(type); where.push(`type = $${params.length}`); }
  if (person) { params.push(`%${person}%`); where.push(`array_to_string(people, ' ') ILIKE $${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 20, 1), 100));
  const { rows } = await pool.query(
    `SELECT ${UNIT_COLS} FROM units ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY importance DESC, count DESC, created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function getPerson(uid, name) {
  const core = await getCore(uid);
  const profile = core?.people?.find((p) => p.name.includes(name) || name.includes(p.name)) || null;
  const units = await searchUnits(uid, { person: name, limit: 30 });
  return { profile, units };
}

export async function updateUnit(uid, id, fields) {
  const sets = [];
  const params = [id, uid];
  if (typeof fields.done === 'boolean') {
    params.push(fields.done); sets.push(`done = $${params.length}`);
    sets.push(`done_at = CASE WHEN $${params.length} THEN now() ELSE NULL END`);
  }
  if (typeof fields.reviewed === 'boolean') { params.push(fields.reviewed); sets.push(`reviewed = $${params.length}`); }
  if (fields.type && TYPES[fields.type]) { params.push(fields.type); sets.push(`type = $${params.length}`); }
  if (typeof fields.content === 'string' && fields.content.trim()) { params.push(fields.content.trim()); sets.push(`content = $${params.length}`); }
  if (fields.due !== undefined) { params.push(validDate(fields.due)); sets.push(`due = $${params.length}`); }
  if (!sets.length) return null;
  const { rows } = await pool.query(`UPDATE units SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING ${UNIT_COLS}`, params);
  return rows[0] || null;
}

export async function deleteUnit(uid, id) {
  await pool.query('DELETE FROM units WHERE id = $1 AND user_id = $2', [id, uid]);
}

export async function getState(uid) {
  const [units, failed, core, recordings, photos] = await Promise.all([
    pool.query(`SELECT ${UNIT_COLS} FROM units WHERE user_id = $1 ORDER BY created_at DESC LIMIT 2000`, [uid]),
    pool.query(`SELECT id, text, recorded_at FROM memos WHERE user_id = $1 AND NOT classified ORDER BY recorded_at DESC LIMIT 50`, [uid]),
    getCore(uid),
    getRecentRecordings(uid, 10),
    getRecentPhotos(uid, 12),
  ]);
  return { units: units.rows, failed: failed.rows, core, recordings, photos, canSummarizeAudio, canTranscribe };
}

// ---- Claudeに渡すテキスト整形 ----
export function unitLine(u) {
  const t = TYPES[u.type]?.label || u.type;
  const bits = [`[${t}] ${u.content}`];
  if (u.quote) bits.push(`「${u.quote}」`);
  if (u.reason) bits.push(`理由：${u.reason}`);
  const meta = [];
  if (u.due) meta.push(`期限 ${u.due}`);
  if (u.people?.length) meta.push(`人物 ${u.people.join('、')}`);
  if (u.tags?.length) meta.push(`タグ ${u.tags.join('、')}`);
  if (u.count > 1) meta.push(`${u.count}回`);
  meta.push(`${u.day}`, `id ${u.id}`);
  return `- ${bits.join(' ')}（${meta.join(' / ')}）`;
}

export function coreText(core, tasks) {
  const L = [];
  if (core) {
    L.push('# 本人の考え方の核', core.summary || '');
    const add = (title, arr) => { if (arr?.length) { L.push('', `## ${title}`); arr.forEach((x) => L.push(`- ${x}`)); } };
    add('大事にしていること', core.values);
    add('判断のしかた', core.decision_rules);
    add('繰り返し学んでいること', core.lessons);
    if (core.people?.length) { L.push('', '## よく関わる人'); core.people.forEach((p) => L.push(`- ${p.name}：${p.points.join('／')}`)); }
    add('まだ答えが出ていないこと', core.open_questions);
  } else {
    L.push('# 本人の考え方の核', 'まだ核は育っていません（記憶が少ないため）。');
  }
  L.push('', '## 今の未完了タスク');
  if (tasks.length) tasks.forEach((t) => L.push(unitLine(t))); else L.push('なし');
  return L.join('\n');
}
