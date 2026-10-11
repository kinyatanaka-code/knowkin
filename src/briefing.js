// 相棒モード：会話の最初に読む「今日の状況」と「問いかけの候補」
import { pool } from './db.js';
import { getGoals } from './goals.js';

import { periodOf } from './period.js';
const weekKey = () => periodOf('week');
const jstToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());

export async function getBriefing(uid) {
  const today = jstToday();
  const [goals, { rows: core }, { rows: tasks }, { rows: recent }, { rows: quiz }, { rows: thoughts }] = await Promise.all([
    getGoals(uid),
    pool.query('SELECT data, updated_at FROM cores WHERE user_id = $1', [uid]),
    pool.query(`SELECT id, content, to_char(due, 'YYYY-MM-DD') AS due, area, scope, period, goal_id FROM units
      WHERE user_id = $1 AND type IN ('task','goal') AND NOT done
        AND ((due IS NOT NULL AND due <= ($2::date + 1)) OR (scope = 'day' AND period <= $3) OR (scope = 'week' AND period = $4))
      ORDER BY due NULLS LAST, created_at LIMIT 15`, [uid, today, today, weekKey()]),
    pool.query(`SELECT type, content FROM units
      WHERE user_id = $1 AND relevance = 'direct' AND type IN ('event','decision','lesson')
      ORDER BY created_at DESC LIMIT 12`, [uid]),
    pool.query(`SELECT count(*)::int AS n FROM brain_quiz WHERE user_id = $1 AND rating IS NULL`, [uid]),
    pool.query(`SELECT count(*)::int AS n FROM units WHERE user_id = $1 AND type IN ('decision','idea','value','question')
      AND created_at > now() - interval '3 days'`, [uid]),
  ]);
  const c = core[0]?.data || {};
  const act = goals.filter((g) => g.status === 'active');
  const L = [`# 今日の相棒ブリーフィング（${today}）`, ''];
  if (c.summary) L.push('## この人の核', c.summary, '');
  if (act.length) {
    L.push('## 目的と現在地');
    for (const g of act) L.push(`- ${g.title}：進み具合 ${g.progress}%${g.stalled ? `、${g.idle_days}日動きなし` : ''}${g.due ? `（${g.due}まで）` : ''}。現在地：${g.note || 'まだ書かれていない'}`);
    L.push('');
  }
  if (tasks.length) {
    L.push('## 期限が今日・明日まで、または今週のタスク');
    for (const t of tasks) L.push(`- ${t.content}${t.due ? `（期限 ${t.due}${t.due < today ? '・過ぎている' : ''}）` : ''}`);
    L.push('');
  }
  if (recent.length) { L.push('## 最近の出来事・判断・教訓'); for (const r of recent) L.push(`- [${r.type}] ${r.content}`); L.push(''); }
  const qs = (c.open_questions || []).slice(0, 4);
  if (qs.length) { L.push('## まだ答えが出ていないこと'); for (const q of qs) L.push(`- ${q}`); L.push(''); }

  L.push('## 問いかけの候補（会話の状況に合う1つを選んで、最初に聞く）');
  const cand = [];
  for (const g of act.filter((x) => x.stalled)) cand.push(`目的「${g.title}」が${g.idle_days}日止まっている。何が引っかかっているか`);
  for (const t of tasks.filter((x) => x.due && x.due < today).slice(0, 2)) cand.push(`期限が過ぎているタスク「${t.content}」はどうなったか`);
  if (qs[0]) cand.push(`未解決の問い「${qs[0]}」について、今どう考えているか`);
  for (const g of act.filter((x) => !x.stalled).slice(0, 2)) cand.push(`目的「${g.title}」の現在地から見て、今日一番効く一歩は何か`);
  if (thoughts[0].n === 0) cand.push('この3日、決めたことや考えたことの記録がない。最近何を決めて、なぜそうしたか');
  if (quiz[0].n) cand.push(`採点待ちの再現度テストが${quiz[0].n}問ある。1問やってみるか`);
  for (const x of cand.slice(0, 6)) L.push(`- ${x}`);
  L.push('', '## 相棒としての動き方',
    '- 最初の一言は、上の候補から選んだ問いかけにする（挨拶だけで終わらない）',
    '- 1回に聞くのは1つだけ。声で話していることを想定して、返事は短く',
    '- 本人の核・判断のしかた・過去の記録を根拠にして一緒に考え、違うと思えば理由を添えて率直に言う',
    '- 本人が決めたこと・その理由・気づき・迷い・やると言ったことが出てきたら、会話の終わり（「ありがとう」「おつかれ」「またね」など）か、10往復ごとに add_memo で要点を残す（source は claude、本人の言葉を中心に）',
    '- 記録にないことを事実のように言わない');
  return L.join('\n');
}
