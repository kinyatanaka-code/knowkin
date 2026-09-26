import Anthropic from '@anthropic-ai/sdk';
import { pool } from './db.js';

const anthropic = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

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
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('ClaudeからJSONが返りませんでした');
  return JSON.parse(m[0]);
}

const imp = (v) => ([1, 2, 3].includes(Number(v)) ? Number(v) : 2);
const strArr = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
const validDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

function classifyPrompt(text, today, existing) {
  return `あなたは「knowkin」という、ある一人の人のための第二の脳の整理係です。
次のメモ（本人が話した内容の文字起こしや手書きメモ）を、意味のまとまりごとに「記憶ユニット」に分解してください。

## 種類（type）
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
- task と goal の期限がわかれば due に YYYY-MM-DD で入れる（今日は ${today}）。「来週金曜」などは日付に直す。不明なら null
- importance は 1〜3（3が最も重要）
- 下の「既存の記憶」とほぼ同じ内容（同じフィードバックを再び受けた等）なら same_as にその id（数値）を入れる。違えば null
- メモに書かれていないことは付け足さない

## 既存の記憶
${JSON.stringify(existing)}

## メモ
${text}

## 出力
次の形のJSONだけを出力してください。前置きや説明は不要です。
{"units":[{"type":"lesson","content":"","quote":"","reason":"","people":[],"tags":[],"due":null,"importance":2,"same_as":null}]}`;
}

export async function addMemo(text, source = 'text') {
  const { rows } = await pool.query('INSERT INTO memos(text, source) VALUES($1, $2) RETURNING *', [text, source]);
  const memo = rows[0];
  try {
    const r = await classifyMemo(memo);
    return { memo_id: memo.id, ...r };
  } catch (e) {
    console.error('classify failed', e);
    return { memo_id: memo.id, added: 0, repeated: 0, error: '原本は保存しましたが、分類に失敗しました' };
  }
}

export async function classifyMemoById(id) {
  const { rows } = await pool.query('SELECT * FROM memos WHERE id = $1', [id]);
  if (!rows[0]) throw new Error('メモが見つかりません');
  return classifyMemo(rows[0]);
}

async function classifyMemo(memo) {
  const existing = (await pool.query(
    `SELECT id, type, left(content, 90) AS content FROM units
     WHERE type = ANY($1) ORDER BY created_at DESC LIMIT 80`,
    [['lesson', 'value', 'decision', 'person', 'idea', 'goal', 'question', 'input']],
  )).rows;
  const today = todayJST();
  const res = await askJSON(classifyPrompt(memo.text, today, existing));
  const list = Array.isArray(res.units) ? res.units : [];
  const existingIds = new Set(existing.map((e) => e.id));
  let added = 0;
  let repeated = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of list) {
      if (!r || !r.content) continue;
      const type = TYPES[r.type] ? r.type : 'event';
      const sameId = Number(r.same_as);
      if (sameId && existingIds.has(sameId)) {
        await client.query(
          `UPDATE units SET
             count = count + 1,
             dates = array_append(dates, $2::date),
             importance = LEAST(3, GREATEST(importance, $3) + CASE WHEN count + 1 >= 3 THEN 1 ELSE 0 END),
             quote = CASE WHEN quote = '' THEN $4 ELSE quote END
           WHERE id = $1`,
          [sameId, today, imp(r.importance), String(r.quote || '')],
        );
        repeated++;
        continue;
      }
      await client.query(
        `INSERT INTO units(memo_id, type, content, quote, reason, people, tags, due, importance, dates)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY[$10::date])`,
        [memo.id, type, String(r.content), String(r.quote || ''), String(r.reason || ''),
          strArr(r.people), strArr(r.tags), validDate(r.due), imp(r.importance), today],
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

export async function growCore() {
  const { rows } = await pool.query(
    `SELECT type, content, quote, reason, people, count, importance FROM units
     WHERE type = ANY($1) ORDER BY count DESC, importance DESC, created_at DESC LIMIT 300`,
    [['lesson', 'value', 'decision', 'person', 'goal', 'question', 'idea']],
  );
  if (rows.length < 3) return null;
  const r = await askJSON(`あなたは「knowkin」という個人の第二の脳の整理係です。
以下は本人が残した記憶ユニットです（count は同じ内容が繰り返された回数、importance は重要度）。
これを読み直し、この人の「考え方の核」をまとめてください。

## ルール
- 繰り返されているもの（count が大きいもの）、重要度が高いものを優先する
- 記憶に書かれていないことは推測で付け足さない
- 人物ごとに、その人が大事にしていること・よく言うことをまとめる
- 各項目は短く具体的な1文にする。各リストは最大7項目

## 記憶ユニット
${JSON.stringify(rows)}

## 出力
次の形のJSONだけを出力してください。
{"summary":"この人の考え方を1〜2文で","values":[],"decision_rules":[],"lessons":[],"people":[{"name":"","points":[]}],"open_questions":[]}`);
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
    `INSERT INTO core(id, data, updated_at) VALUES(1, $1, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [data],
  );
  return data;
}

/** 前回の核の更新以降に新しい記憶があれば育てる（夜間バッチ用） */
export async function growCoreIfChanged() {
  const { rows } = await pool.query(
    `SELECT (SELECT updated_at FROM core WHERE id = 1) AS core_at,
            (SELECT max(created_at) FROM units) AS unit_at`,
  );
  const { core_at: coreAt, unit_at: unitAt } = rows[0];
  if (!unitAt || (coreAt && coreAt >= unitAt)) return null;
  return growCore();
}

export async function getCore() {
  const { rows } = await pool.query('SELECT data, updated_at FROM core WHERE id = 1');
  return rows[0] ? { ...rows[0].data, updatedAt: rows[0].updated_at } : null;
}

export async function getOpenTasks() {
  const { rows } = await pool.query(
    `SELECT ${UNIT_COLS} FROM units WHERE type IN ('task', 'goal') AND NOT done
     ORDER BY due ASC NULLS LAST, created_at ASC`,
  );
  return rows;
}

export async function searchUnits({ query = '', type = null, person = null, limit = 20 } = {}) {
  const where = [];
  const params = [];
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

export async function getPerson(name) {
  const core = await getCore();
  const profile = core?.people?.find((p) => p.name.includes(name) || name.includes(p.name)) || null;
  const units = await searchUnits({ person: name, limit: 30 });
  return { profile, units };
}

export async function updateUnit(id, fields) {
  const sets = [];
  const params = [id];
  if (typeof fields.done === 'boolean') {
    params.push(fields.done); sets.push(`done = $${params.length}`);
    sets.push(`done_at = CASE WHEN $${params.length} THEN now() ELSE NULL END`);
  }
  if (typeof fields.reviewed === 'boolean') { params.push(fields.reviewed); sets.push(`reviewed = $${params.length}`); }
  if (fields.type && TYPES[fields.type]) { params.push(fields.type); sets.push(`type = $${params.length}`); }
  if (typeof fields.content === 'string' && fields.content.trim()) { params.push(fields.content.trim()); sets.push(`content = $${params.length}`); }
  if (fields.due !== undefined) { params.push(validDate(fields.due)); sets.push(`due = $${params.length}`); }
  if (!sets.length) return null;
  const { rows } = await pool.query(`UPDATE units SET ${sets.join(', ')} WHERE id = $1 RETURNING ${UNIT_COLS}`, params);
  return rows[0] || null;
}

export async function deleteUnit(id) {
  await pool.query('DELETE FROM units WHERE id = $1', [id]);
}

export async function getState() {
  const [units, failed, core] = await Promise.all([
    pool.query(`SELECT ${UNIT_COLS} FROM units ORDER BY created_at DESC LIMIT 2000`),
    pool.query(`SELECT id, text, recorded_at FROM memos WHERE NOT classified ORDER BY recorded_at DESC LIMIT 50`),
    getCore(),
  ]);
  return { units: units.rows, failed: failed.rows, core };
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
