// knowkinの中身（核・目的・タスク・最近の記録）を、非公開のGitHubリポジトリに書き出す。
// コネクタが使えないAI（会社アカウントのGeminiなど）に、リポジトリとして読ませるため。
// 設定（Railwayの環境変数）：GITHUB_EXPORT_REPO=owner/repo、GITHUB_EXPORT_TOKEN=そのリポジトリだけ書ける Fine-grained token
import { pool } from './db.js';
import { getGoals } from './goals.js';
import { getCore, getOpenTasks, coreText } from './brain.js';
import { getBriefing } from './briefing.js';
import { kinbotConfig } from './kinbot-sync.js';
import { callUpstream } from './upstream.js';
import { firstUser } from './auth.js';

// 連携先（kincall・kinbot・kinXs）から、その時点の数字を読んで Markdown にする（コネクタが使えない会社のGeminiに読ませるため）
const monthStart = () => { const d = new Date(Date.now() + 9 * 3600000); return `${d.toISOString().slice(0, 7)}-01`; };
const ymd = (offsetDays = 0) => new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
async function upText(key, tool, args) {
  try { const r = await callUpstream(key, tool, args, 200000); return (r.content || []).map((c) => c.text || '').join('\n'); }
  catch (e) { return `ERROR: ${e.message}`; }
}
function parseRows(t) { try { const j = JSON.parse(t); if (Array.isArray(j)) return j; for (const v of Object.values(j || {})) if (Array.isArray(v)) return v; } catch {} return null; }
const cell = (v) => String(v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v).replace(/\|/g, '／').replace(/\s+/g, ' ').slice(0, 120);
// JSON の配列を表にする。表にできないときは、そのまま（長ければ切る）
function toTable(t, maxRows = 400, maxCols = 9) {
  if (String(t).startsWith('ERROR:')) return `読めませんでした（${t.slice(7)}）`;
  const rows = parseRows(t);
  if (!rows) return String(t).slice(0, 30000);
  if (!rows.length) return 'なし';
  const cols = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r || {})))].slice(0, maxCols);
  return [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows.slice(0, maxRows).map((r) => `| ${cols.map((c) => cell(r && r[c])).join(' | ')} |`),
    rows.length > maxRows ? `\n（ほか ${rows.length - maxRows} 件）` : ''].join('\n');
}
// 架電の実績：日×人×結果 を、人ごとの合計（コール・接触・アポ・資料送付）にまとめる
function callSummary(t) {
  const rows = parseRows(t);
  if (!rows) return toTable(t);
  const by = new Map();
  for (const r of rows) {
    const who = r['かけた人'] || r.caller || '不明'; const res = String(r['結果'] || r.result || ''); const n = Number(r['件数'] || r.count || 0);
    const o = by.get(who) || { calls: 0, contact: 0, apo: 0, doc: 0, days: new Set() };
    o.calls += n; if (res.startsWith('担当者接触')) o.contact += n; if (res.includes('アポ獲得')) o.apo += n; if (res.includes('資料送付')) o.doc += n;
    o.days.add(r['日'] || r.day); by.set(who, o);
  }
  const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '-');
  return ['| かけた人 | 稼働日 | コール | 接触 | 接触率 | アポ | アポ率（コール比） | 資料送付 |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...[...by.entries()].sort((a, b) => b[1].apo - a[1].apo || b[1].calls - a[1].calls)
      .map(([w, o]) => `| ${w} | ${o.days.size} | ${o.calls} | ${o.contact} | ${pct(o.contact, o.calls)} | ${o.apo} | ${pct(o.apo, o.calls)} | ${o.doc} |`)].join('\n');
}
async function upstreamFiles(uid) {
  const owner = await firstUser();
  if (!kinbotConfig().ready || !owner || owner.id !== uid) return {};
  const from = monthStart(), to = ymd(0), wk = ymd(-6);
  const [stats, statsWeek, apo, hours, lists, renewals, aiq] = await Promise.all([
    upText('kincall', 'list_call_stats', { from, to }), upText('kincall', 'list_call_stats', { from: wk, to }),
    upText('kincall', 'list_apo_appointments', { from, to }), upText('kincall', 'list_work_hours', { from, to }),
    upText('kincall', 'list_call_lists_overview', {}), upText('kinxs', 'list_renewals', {}), upText('kinxs', 'ai_question_summary', {}),
  ]);
  return {
    'calls.md': [`# 架電の実績（kincall・${from}〜${to}）`, '', '## 人ごと（今月）', callSummary(stats), '', '## 人ごと（直近7日）', callSummary(statsWeek),
      '', '## 日×人×結果（今月）', toTable(stats, 600, 4), '', '## 稼働時間（今月）', toTable(hours, 300)].join('\n') + '\n',
    'apo.md': [`# 今月のアポ（kincall・${from}〜${to}）`, '', toTable(apo, 500)].join('\n') + '\n',
    'call-lists.md': ['# 架電リストの状況（kincall）', '', toTable(lists, 300)].join('\n') + '\n',
    'doc-users.md': ['# DOCの更新予定（kinXs）', '', toTable(renewals, 300), '', '# 候補者がAIにした質問のまとめ（kinXs）', '', toTable(aiq, 200)].join('\n') + '\n',
  };
}

const jstNow = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
const TYPE = { event: '出来事', input: '知識', lesson: '教訓', idea: 'アイデア', decision: '判断', value: '価値観', question: '問い', task: 'タスク', goal: '目標', person: '人物' };

export function exportConfig() {
  const repo = (process.env.GITHUB_EXPORT_REPO || '').trim();
  const token = (process.env.GITHUB_EXPORT_TOKEN || '').trim();
  return { repo, token, ready: /^[\w.-]+\/[\w.-]+$/.test(repo) && Boolean(token) };
}

export async function buildExportFiles(uid) {
  const [core, tasks, goals, briefing, { rows: recent }, { rows: biz }, { rows: recs }] = await Promise.all([
    getCore(uid), getOpenTasks(uid), getGoals(uid), getBriefing(uid),
    pool.query(`SELECT type, content, reason, people, to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS d
      FROM units WHERE user_id = $1 AND relevance = 'direct' AND realm = 'self' AND type IN ('event','decision','lesson','idea','value','question','person','input')
        AND created_at > now() - interval '30 days'
      ORDER BY created_at DESC LIMIT 300`, [uid]),
    pool.query(`SELECT realm, company, genre, type, content, to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS d
      FROM units WHERE user_id = $1 AND realm IN ('company','nc') ORDER BY created_at DESC LIMIT 1500`, [uid]),
    // kinbot・kincall・kinXsの記録：最近動きのあった80社について、新しい順に6件ずつ
    pool.query(`WITH c AS (SELECT company_key FROM biz_records WHERE user_id = $1 AND company_key <> '' GROUP BY company_key ORDER BY max(at) DESC LIMIT 80),
        r AS (SELECT b.*, row_number() OVER (PARTITION BY b.company_key ORDER BY b.at DESC) AS rn FROM biz_records b JOIN c USING (company_key) WHERE b.user_id = $1)
      SELECT company, company_key, kind, title, left(body, 220) AS body, to_char(at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS d FROM r WHERE rn <= 6 ORDER BY company_key, at DESC`, [uid]).catch(() => ({ rows: [] })),
  ]);
  const stamp = jstNow();
  const act = goals.filter((g) => g.status === 'active');

  const readme = [
    '# 田中欽也の相棒用ノート（knowkinから自動で書き出し）',
    '',
    `最終更新：${stamp}（knowkinから1時間ごとに自動で上書きされます。手で編集しないでください）`,
    '',
    '## このリポジトリを読んだAIへのお願い',
    '- あなたは田中欽也の相棒です。まず `core.md`（考え方の核）と `today.md`（今日の状況）を読み、本人の前提をふまえて答えてください',
    '- 目的と現在地は `goals.md`、未完了のタスクは `tasks.md`、直近30日の出来事・判断・教訓は `recent.md` にあります',
    '- 本人の核・判断のしかた・過去の記録を根拠にして考え、ずれていれば理由を添えて率直に言ってください。同意するだけにならないこと',
    '- 1回に聞くのは1つだけ。返事は短く',
    '- ここに書かれていないことを、事実のように言わないでください',
    '',
    '## ファイル',
    '- `core.md`：考え方の核（大事にしていること・判断のしかた・教訓・よく関わる人・まだ答えが出ていないこと）',
    '- `today.md`：今日の相棒ブリーフィング（目的の現在地・近い期限のタスク・最近の出来事・問いかけの候補）',
    '- `goals.md`：目的・道のり・現在地',
    '- `tasks.md`：未完了のタスク（期限順）',
    '- `recent.md`：直近30日の記録',
    '- `company.md`：企業情報（顧客企業ごとの商談・状況）',
    '- `knowledge.md`：ネオキャリアナレッジ（商材・社内ルールなど会社として共有できる知識）',
    '- `calls.md`：架電の実績（kincall。インターン生・メンバーごとのコール・接触・アポ、今月と直近7日、稼働時間）',
    '- `apo.md`：今月のアポの一覧（kincall）',
    '- `call-lists.md`：架電リストごとの状況（kincall）',
    '- `doc-users.md`：DOCの更新予定と、候補者がAIにした質問のまとめ（kinXs）',
    '',
    '架電・アポ・DOCの数字を聞かれたら、まず calls.md・apo.md・doc-users.md を見て、その数字を根拠に答えてください（最終更新の時点の数字です）。',
  ].join('\n');

  const coreMd = coreText(core, []).replace(/\n## 今の未完了タスク\nなし$/, '').trim();

  const G = ['# 目的と現在地', ''];
  if (!act.length) G.push('進行中の目的はありません。');
  for (const g of act) {
    G.push(`## ${g.title}（${g.area === 'life' ? 'プライベート' : '仕事'}・進み具合 ${g.progress}%${g.due ? `・${g.due}まで` : ''}）`);
    if (g.future) G.push(`叶えたい未来：${g.future}`);
    G.push(`現在地：${g.note || 'まだ書かれていない'}`);
    if (g.milestones?.length) { G.push('', '道のり：'); for (const m of g.milestones) G.push(`- [${m.done ? 'x' : ' '}] ${m.title}`); }
    G.push('');
  }

  const T = ['# 未完了のタスク（期限順）', ''];
  if (!tasks.length) T.push('なし');
  for (const t of tasks) {
    const due = t.due ? (typeof t.due === 'string' ? t.due : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(t.due)) : '';
    T.push(`- ${t.content}${due ? `（期限 ${due}）` : ''}${t.people?.length ? `［${t.people.join('、')}］` : ''}`);
  }

  const R = ['# 直近30日の記録（新しい順）', ''];
  let day = '';
  for (const r of recent) {
    if (r.d !== day) { day = r.d; R.push('', `## ${day}`); }
    R.push(`- [${TYPE[r.type] || r.type}] ${r.content}${r.reason ? `（理由：${r.reason}）` : ''}`);
  }

  const C = ['# 企業情報（顧客企業ごと・新しい順）', ''];
  const byCo = new Map();
  for (const r of biz.filter((x) => x.realm === 'company')) { const k = r.company || '会社名なし'; if (!byCo.has(k)) byCo.set(k, []); byCo.get(k).push(r); }
  for (const r of recs) { const k = r.company || '会社名なし'; if (!byCo.has(k)) byCo.set(k, []); byCo.get(k).push({ d: r.d, type: r.kind, content: `${r.title}${r.body ? '：' + r.body.replace(/\n/g, ' ') : ''}` }); }
  if (!byCo.size) C.push('まだありません。');
  for (const [co, list] of byCo) { C.push(`## ${co}`); for (const r of list.slice(0, 30)) C.push(`- ${r.d} [${TYPE[r.type] || r.type}] ${r.content}`); C.push(''); }
  const K = ['# ネオキャリアナレッジ（全社）', ''];
  const byG = new Map();
  for (const r of biz.filter((x) => x.realm === 'nc')) { const k = r.genre || 'その他'; if (!byG.has(k)) byG.set(k, []); byG.get(k).push(r); }
  if (!byG.size) K.push('まだありません。');
  for (const [g, list] of byG) { K.push(`## ${g}`); for (const r of list.slice(0, 60)) K.push(`- ${r.content}`); K.push(''); }

  const up = await upstreamFiles(uid).catch((e) => ({ 'calls.md': `読めませんでした：${e.message}\n` }));
  return {
    ...up,
    'company.md': C.join('\n') + '\n',
    'knowledge.md': K.join('\n') + '\n',
    'README.md': readme + '\n',
    'core.md': coreMd + '\n',
    'today.md': briefing + '\n',
    'goals.md': G.join('\n') + '\n',
    'tasks.md': T.join('\n') + '\n',
    'recent.md': R.join('\n') + '\n',
  };
}

async function gh(token, method, path, body) {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'knowkin' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404 && method === 'GET') return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${j.message || ''}`);
  return j;
}

// 中身が変わったファイルだけを書き込む。書いたファイル名を返す
export async function exportToGitHub(uid) {
  const { repo, token, ready } = exportConfig();
  if (!ready) throw new Error('GITHUB_EXPORT_REPO と GITHUB_EXPORT_TOKEN が設定されていません');
  const meta = await gh(token, 'GET', `/repos/${repo}`);
  if (!meta) throw new Error(`リポジトリ ${repo} が見つからないか、トークンで読めません`);
  if (!meta.private) throw new Error(`リポジトリ ${repo} が公開（Public）になっています。記憶を書き出すのは非公開（Private）のリポジトリだけにしてください`);
  const files = await buildExportFiles(uid);
  const written = [];
  for (const [name, content] of Object.entries(files)) {
    const cur = await gh(token, 'GET', `/repos/${repo}/contents/${encodeURIComponent(name)}`);
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    const curText = cur?.content ? Buffer.from(cur.content, 'base64').toString('utf8') : null;
    // 先頭の「最終更新」の行だけが違う場合は書かない
    const strip = (s) => (s || '').replace(/^最終更新：.*$/m, '');
    if (curText !== null && strip(curText) === strip(content)) continue;
    await gh(token, 'PUT', `/repos/${repo}/contents/${encodeURIComponent(name)}`, {
      message: `knowkin: ${name} を更新`, content: b64, ...(cur?.sha ? { sha: cur.sha } : {}),
    });
    written.push(name);
  }
  return written;
}

// Googleドキュメントなどに1本で貼るための、まとめたテキスト（Geminiのスキルに読ませる用）
export async function buildExportText(uid) {
  const f = await buildExportFiles(uid);
  const intro = [
    '# 田中欽也の相棒ノート（knowkinから1時間ごとに自動で上書き）',
    '',
    `最終更新：${jstNow()}`,
    '',
    'このノートを読んだAIへ：あなたは田中欽也の相棒です。下の「考え方の核」「今日の状況」「目的」「タスク」「直近の記録」「企業情報」「ネオキャリアナレッジ」を前提に答えてください。',
    '本人の核・判断のしかた・過去の記録を根拠に考え、ずれていれば理由を添えて率直に言ってください。同意するだけにならないこと。1回に聞くのは1つだけ、返事は短く。ここに書かれていないことを事実のように言わないでください。',
  ].join('\n');
  const part = (title, body) => `\n\n==============================\n${title}\n==============================\n${body.trim()}`;
  return intro
    + part('考え方の核', f['core.md'])
    + part('今日の状況', f['today.md'])
    + part('目的と現在地', f['goals.md'])
    + part('未完了のタスク', f['tasks.md'])
    + part('直近30日の記録', f['recent.md'])
    + part('企業情報', f['company.md'])
    + part('ネオキャリアナレッジ', f['knowledge.md']) + '\n';
}
