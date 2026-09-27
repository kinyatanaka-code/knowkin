// 目的（叶えたいこと）と現在地
import { pool } from './db.js';

const s = (v, n = 300) => String(v ?? '').trim().slice(0, n);
const area = (v) => (v === 'life' ? 'life' : 'work');
const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** 目的ごとの進み具合：済んだ道のりの数を主に、今いる道のりの分をつながったタスクの完了率で足す */
function progressOf(g, ms, tasks) {
  if (g.status === 'done') return 100;
  const total = tasks.length; const done = tasks.filter((t) => t.done).length;
  const taskFrac = total ? done / total : 0;
  if (!ms.length) return Math.round(taskFrac * 95);
  const d = ms.filter((m) => m.done).length;
  const cur = d < ms.length ? taskFrac : 0;
  return Math.min(99, Math.round(((d + cur) / ms.length) * 100));
}

export async function getGoals(uid, { includeClosed = false } = {}) {
  const { rows: goals } = await pool.query(
    `SELECT g.id, g.user_id, g.title, g.area, g.future, g.why, g.criteria, to_char(g.due, 'YYYY-MM-DD') AS due, g.status, g.pinned,
       g.note, g.note_at, g.source_memo_id, g.last_activity_at, g.created_at
     FROM goals g WHERE g.user_id = $1 ${includeClosed ? '' : "AND g.status IN ('candidate','active','paused')"}
     ORDER BY (g.status = 'candidate') DESC, g.pinned DESC, g.due ASC NULLS LAST, g.created_at`, [uid]);
  if (!goals.length) return [];
  const ids = goals.map((g) => g.id);
  const [{ rows: ms }, { rows: us }] = await Promise.all([
    pool.query('SELECT * FROM milestones WHERE goal_id = ANY($1) ORDER BY position, id', [ids]),
    pool.query(`SELECT id, goal_id, type, content, done, due, created_at, done_at FROM units WHERE goal_id = ANY($1) ORDER BY created_at`, [ids]),
  ]);
  return goals.map((g) => {
    const m = ms.filter((x) => x.goal_id === g.id);
    const linked = us.filter((u) => u.goal_id === g.id);
    const tasks = linked.filter((u) => u.type === 'task' || u.type === 'goal');
    const acts = [g.last_activity_at, ...m.map((x) => x.done_at), ...linked.flatMap((u) => [u.created_at, u.done_at])].filter(Boolean).map((d) => new Date(d).getTime());
    const last = Math.max(...acts, new Date(g.created_at).getTime());
    const idle = Math.floor((Date.now() - last) / 86400000);
    const nowIdx = m.findIndex((x) => !x.done);
    return {
      ...g, milestones: m.map((x, i) => ({ id: x.id, title: x.title, done: x.done, now: i === nowIdx })),
      linked: linked.map((u) => u.id), tasks_total: tasks.length, tasks_done: tasks.filter((t) => t.done).length,
      progress: progressOf(g, m, tasks), idle_days: idle, stalled: g.status === 'active' && idle >= 14,
    };
  });
}

export async function proposeGoal(uid, a) {
  const title = s(a.title, 60);
  if (!title) throw new Error('title（目的の名前）が必要です');
  const dup = await pool.query(`SELECT id, status FROM goals WHERE user_id = $1 AND title = $2 AND status <> 'dropped'`, [uid, title]);
  if (dup.rows[0]) throw new Error(`同じ名前の目的（id ${dup.rows[0].id}）がすでにあります`);
  const { rows } = await pool.query(
    `INSERT INTO goals(user_id, title, area, future, why, criteria, due, source_memo_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [uid, title, area(a.area), s(a.future), s(a.why), s(a.criteria, 200), date(a.due), a.memo_id || null]);
  const id = rows[0].id;
  const list = Array.isArray(a.milestones) ? a.milestones.map((x) => s(x, 80)).filter(Boolean).slice(0, 7) : [];
  for (let i = 0; i < list.length; i++) await pool.query('INSERT INTO milestones(goal_id, title, position) VALUES($1,$2,$3)', [id, list[i], i]);
  return id;
}

async function own(uid, id) {
  const { rows } = await pool.query('SELECT * FROM goals WHERE id = $1 AND user_id = $2', [id, uid]);
  if (!rows[0]) throw new Error('目的が見つかりません');
  return rows[0];
}
const touch = (id) => pool.query('UPDATE goals SET last_activity_at = now() WHERE id = $1', [id]);

export async function updateGoal(uid, id, f) {
  await own(uid, id);
  const sets = []; const p = [id];
  const add = (col, v) => { p.push(v); sets.push(`${col} = $${p.length}`); };
  if (typeof f.title === 'string' && f.title.trim()) add('title', s(f.title, 60));
  if (f.area) add('area', area(f.area));
  for (const k of ['future', 'why', 'criteria']) if (typeof f[k] === 'string') add(k, s(f[k]));
  if (f.due !== undefined) add('due', date(f.due));
  if (['candidate', 'active', 'paused', 'done', 'dropped'].includes(f.status)) add('status', f.status);
  if (typeof f.pinned === 'boolean') add('pinned', f.pinned);
  if (!sets.length) return;
  await pool.query(`UPDATE goals SET ${sets.join(', ')}, last_activity_at = now() WHERE id = $1`, p);
}

export async function setMilestone(uid, goalId, msId, done) {
  await own(uid, goalId);
  await pool.query('UPDATE milestones SET done = $1, done_at = CASE WHEN $1 THEN now() ELSE NULL END WHERE id = $2 AND goal_id = $3', [done, msId, goalId]);
  await touch(goalId);
}
export async function addMilestone(uid, goalId, title) {
  await own(uid, goalId);
  const t = s(title, 80); if (!t) throw new Error('道のりの名前が必要です');
  const { rows } = await pool.query('SELECT coalesce(max(position), -1) + 1 AS p FROM milestones WHERE goal_id = $1', [goalId]);
  await pool.query('INSERT INTO milestones(goal_id, title, position) VALUES($1,$2,$3)', [goalId, t, rows[0].p]);
}

export async function linkUnits(uid, goalId, unitIds) {
  if (goalId !== null) { const g = await own(uid, goalId); if (!['active', 'paused', 'candidate'].includes(g.status)) throw new Error('その目的は終わっています'); }
  const r = await pool.query('UPDATE units SET goal_id = $1 WHERE user_id = $2 AND id = ANY($3)', [goalId, uid, unitIds]);
  if (goalId) await touch(goalId);
  return r.rowCount;
}

export async function setGoalNote(uid, goalId, note, milestoneUpdates = []) {
  await own(uid, goalId);
  await pool.query('UPDATE goals SET note = $1, note_at = now() WHERE id = $2', [s(note, 400), goalId]);
  for (const m of milestoneUpdates) {
    await pool.query('UPDATE milestones SET done = $1, done_at = CASE WHEN $1 THEN coalesce(done_at, now()) ELSE NULL END WHERE id = $2 AND goal_id = $3', [Boolean(m.done), m.id, goalId]);
  }
}

/** 週ごとの足あと（毎日1回、各目的の進み具合を残す） */
export async function snapshotGoals() {
  const { rows } = await pool.query(`SELECT DISTINCT user_id FROM goals WHERE status = 'active'`);
  for (const r of rows) {
    for (const g of (await getGoals(r.user_id)).filter((x) => x.status === 'active')) {
      await pool.query(`INSERT INTO goal_snapshots(goal_id, day, progress) VALUES($1, (now() AT TIME ZONE 'Asia/Tokyo')::date, $2)
        ON CONFLICT (goal_id, day) DO UPDATE SET progress = EXCLUDED.progress`, [g.id, g.progress]);
    }
  }
}

/** Claudeに渡す文章 */
export function goalsText(goals) {
  const act = goals.filter((g) => g.status === 'active' || g.status === 'paused');
  const cand = goals.filter((g) => g.status === 'candidate');
  const L = [];
  if (act.length) {
    L.push('## 目的と現在地');
    for (const g of act) {
      L.push(`- [目的 id ${g.id}] ${g.title}（${g.area === 'life' ? 'プライベート' : '仕事'}${g.due ? `・${g.due}まで` : ''}${g.status === 'paused' ? '・保留中' : ''}）進み具合 ${g.progress}%${g.stalled ? `・${g.idle_days}日動きなし` : ''}`);
      if (g.future) L.push(`  叶えたい未来：${g.future}`);
      if (g.criteria) L.push(`  達成の基準：${g.criteria}`);
      if (g.milestones.length) L.push(`  道のり：${g.milestones.map((m) => `${m.done ? '✓' : m.now ? '▶' : '・'}${m.title}（id ${m.id}）`).join(' → ')}`);
      if (g.note) L.push(`  現在地：${g.note}`);
    }
  }
  if (cand.length) L.push('', '## 承認待ちの目的の候補', ...cand.map((g) => `- [id ${g.id}] ${g.title}`));
  return L.join('\n');
}
