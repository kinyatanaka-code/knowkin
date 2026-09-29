// 脳の成長：量・深さ・広さ・再現度
import { pool } from './db.js';
import { addMemo } from './brain.js';

const LAYER = { event: 'event', input: 'know', lesson: 'know', idea: 'think', decision: 'think', value: 'think', question: 'think', task: 'act', goal: 'act', person: 'rel' };
const SCORE = { great: 1, ok: 0.5, miss: 0 };

export async function getGrowth(uid) {
  const [{ rows: units }, { rows: cats }, { rows: quiz }] = await Promise.all([
    pool.query(`SELECT type, reason, count, people, genre, area, created_at FROM units WHERE user_id = $1`, [uid]),
    pool.query('SELECT key, layer, layer_label FROM categories WHERE user_id = $1', [uid]),
    pool.query(`SELECT id, question, prediction, basis, rating, correction, created_at, answered_at FROM brain_quiz WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [uid]),
  ]);
  const layerOf = (t) => LAYER[t] || (() => { const c = cats.find((x) => x.key === t); return c ? (c.layer === 'new' ? 'n:' + c.layer_label : c.layer) : 'event'; })();

  // 量：層ごとの数と、直近8週の累計の推移
  const layers = {};
  for (const u of units) { const l = layerOf(u.type); layers[l] = (layers[l] || 0) + 1; }
  const now = Date.now(); const WEEK = 7 * 86400000;
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const end = now - i * WEEK;
    weeks.push({ end: new Date(end).toISOString().slice(0, 10), total: units.filter((u) => new Date(u.created_at).getTime() <= end).length });
  }
  const last7 = units.filter((u) => now - new Date(u.created_at).getTime() <= WEEK).length;

  // 深さ：理由つきの判断、2回以上出てきた教訓・価値観・判断（定着した考え）
  const decisions = units.filter((u) => u.type === 'decision');
  const depth = {
    decisions: decisions.length,
    decisions_with_reason: decisions.filter((u) => (u.reason || '').trim()).length,
    rooted: units.filter((u) => ['lesson', 'value', 'decision'].includes(u.type) && u.count >= 2).length,
    values: units.filter((u) => u.type === 'value').length,
  };

  // 広さ：関わる人、引き出し、仕事とプライベート
  const people = new Set(units.flatMap((u) => u.people || []).map((p) => String(p).trim()).filter(Boolean));
  const genres = new Set(units.map((u) => (u.genre || '').trim()).filter(Boolean));
  const tasks = units.filter((u) => u.type === 'task' || u.type === 'goal');
  const breadth = { people: people.size, genres: genres.size, work: tasks.filter((u) => u.area !== 'life').length, life: tasks.filter((u) => u.area === 'life').length };

  // 再現度：今月の採点と、週ごとの推移
  const answered = quiz.filter((q) => q.rating);
  const ym = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()).slice(0, 7);
  const monthRated = answered.filter((q) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(q.answered_at)).startsWith(ym));
  const rate = (list) => (list.length ? Math.round((list.reduce((s, q) => s + SCORE[q.rating], 0) / list.length) * 100) : null);
  const repro = { month: rate(monthRated), month_count: monthRated.length, all: rate(answered), all_count: answered.length, weeks: [] };
  for (let i = 7; i >= 0; i--) {
    const s = now - (i + 1) * WEEK; const e = now - i * WEEK;
    repro.weeks.push(rate(answered.filter((q) => { const t = new Date(q.answered_at).getTime(); return t > s && t <= e; })));
  }

  // 次に伸ばすには
  const total = units.length;
  const hints = [];
  const think = layers.think || 0; const rel = layers.rel || 0;
  if (total < 30) hints.push('まずは量を増やす段階です。録音やメモを毎日1件でも残すと、Claudeが考え方をつかみ始めます。');
  if (total && think / total < 0.15) hints.push('「思考」の層が薄めです。決めたことを「なぜそうしたか」とセットで残すと、判断のしかたが伝わります。');
  if (depth.decisions && depth.decisions_with_reason / depth.decisions < 0.6) hints.push('理由が書かれていない判断が多めです。判断を残すときは理由を一言添えてください。');
  if (total && rel / total < 0.08) hints.push('「関係」の層が薄めです。よく関わる人の特徴や、言われたことを残すと、人に合わせた答え方ができるようになります。');
  if (tasks.length >= 10 && breadth.life / tasks.length < 0.15) hints.push('プライベートの記録が少なめです。仕事以外のやりたいことも残すと、あなた全体に近づきます。');
  if (depth.rooted < 3 && total >= 30) hints.push('同じ考えが繰り返し記録されると「定着した考え」になります。大事な教訓は、思い出したときにもう一度残してください。');
  if (last7 === 0 && total) hints.push('この1週間、新しい記録がありません。');
  if (!answered.length) hints.push('再現度テストに答えると、knowkinがどれだけあなたらしく考えられるかがわかります。');

  return {
    total, last7, layers, weeks, depth, breadth, repro, hints: hints.slice(0, 3),
    quiz_open: quiz.filter((q) => !q.rating).map(({ id, question, prediction, basis }) => ({ id, question, prediction, basis })),
    quiz_recent: answered.slice(0, 6).map(({ id, question, prediction, rating, correction }) => ({ id, question, prediction, rating, correction })),
  };
}

export async function rateQuiz(uid, id, rating, correction = '') {
  if (!SCORE.hasOwnProperty(rating)) throw new Error('採点は great / ok / miss のどれかです');
  const { rows } = await pool.query(
    `UPDATE brain_quiz SET rating = $1, correction = $2, answered_at = now() WHERE id = $3 AND user_id = $4 AND rating IS NULL RETURNING *`,
    [rating, String(correction || '').trim().slice(0, 1000), id, uid]);
  if (!rows[0]) throw new Error('テストが見つからないか、すでに採点済みです');
  const q = rows[0];
  // 違っていた・補足があったときは、本人の答えを新しい記録にする（Claudeが整理して記憶になる）
  if (q.correction) {
    await addMemo(uid, `【再現度テストへの本人の答え】\n問い：${q.question}\nClaudeの予想：${q.prediction}\n本人の答え：${q.correction}`, 'quiz', null, `quiz:${q.id}`);
  }
  return q;
}

export async function requestQuiz(uid) { await pool.query('UPDATE users SET quiz_request_at = now() WHERE id = $1', [uid]); }

/** テストを作るべきか：頼まれている、または今週まだ作っていない（記録が20件以上あるとき） */
export async function quizNeeded(uid) {
  const { rows } = await pool.query(
    `SELECT u.quiz_request_at,
       (SELECT count(*)::int FROM units WHERE user_id = u.id) AS n,
       (SELECT count(*)::int FROM brain_quiz WHERE user_id = u.id AND created_at > now() - interval '7 days') AS recent,
       (SELECT count(*)::int FROM brain_quiz WHERE user_id = u.id AND rating IS NULL) AS open
     FROM users u WHERE u.id = $1`, [uid]);
  const r = rows[0];
  if (!r || r.open >= 3) return false;
  return Boolean(r.quiz_request_at) || (r.n >= 20 && r.recent === 0);
}

export async function quizMaterial(uid) {
  const [{ rows: core }, { rows: know }, { rows: past }] = await Promise.all([
    pool.query('SELECT data FROM cores WHERE user_id = $1', [uid]),
    pool.query(`SELECT id, type, content, quote, reason, people, count FROM units
      WHERE user_id = $1 AND type IN ('lesson','decision','value','person','idea','question')
      ORDER BY random() LIMIT 50`, [uid]),
    pool.query(`SELECT question, rating, correction FROM brain_quiz WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [uid]),
  ]);
  return { core: core[0]?.data || null, knowledge: know, past };
}

export async function addQuiz(uid, items) {
  let n = 0;
  for (const it of items.slice(0, 5)) {
    const q = String(it.question || '').trim(); const p = String(it.prediction || '').trim();
    if (!q || !p) continue;
    await pool.query('INSERT INTO brain_quiz(user_id, question, prediction, basis) VALUES($1, $2, $3, $4)',
      [uid, q.slice(0, 400), p.slice(0, 800), String(it.basis || '').slice(0, 400)]);
    n++;
  }
  await pool.query('UPDATE users SET quiz_request_at = NULL WHERE id = $1', [uid]);
  return n;
}
