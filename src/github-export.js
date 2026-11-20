// knowkinの中身（核・目的・タスク・最近の記録）を、非公開のGitHubリポジトリに書き出す。
// コネクタが使えないAI（会社アカウントのGeminiなど）に、リポジトリとして読ませるため。
// 設定（Railwayの環境変数）：GITHUB_EXPORT_REPO=owner/repo、GITHUB_EXPORT_TOKEN=そのリポジトリだけ書ける Fine-grained token
import { pool } from './db.js';
import { getGoals } from './goals.js';
import { getCore, getOpenTasks, coreText } from './brain.js';
import { getBriefing } from './briefing.js';

const jstNow = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
const TYPE = { event: '出来事', input: '知識', lesson: '教訓', idea: 'アイデア', decision: '判断', value: '価値観', question: '問い', task: 'タスク', goal: '目標', person: '人物' };

export function exportConfig() {
  const repo = (process.env.GITHUB_EXPORT_REPO || '').trim();
  const token = (process.env.GITHUB_EXPORT_TOKEN || '').trim();
  return { repo, token, ready: /^[\w.-]+\/[\w.-]+$/.test(repo) && Boolean(token) };
}

export async function buildExportFiles(uid) {
  const [core, tasks, goals, briefing, { rows: recent }, { rows: biz }] = await Promise.all([
    getCore(uid), getOpenTasks(uid), getGoals(uid), getBriefing(uid),
    pool.query(`SELECT type, content, reason, people, to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS d
      FROM units WHERE user_id = $1 AND relevance = 'direct' AND realm = 'self' AND type IN ('event','decision','lesson','idea','value','question','person','input')
        AND created_at > now() - interval '30 days'
      ORDER BY created_at DESC LIMIT 300`, [uid]),
    pool.query(`SELECT realm, company, genre, type, content, to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS d
      FROM units WHERE user_id = $1 AND realm IN ('company','nc') ORDER BY created_at DESC LIMIT 1500`, [uid]),
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
  if (!byCo.size) C.push('まだありません。');
  for (const [co, list] of byCo) { C.push(`## ${co}`); for (const r of list.slice(0, 30)) C.push(`- ${r.d} [${TYPE[r.type] || r.type}] ${r.content}`); C.push(''); }
  const K = ['# ネオキャリアナレッジ（全社）', ''];
  const byG = new Map();
  for (const r of biz.filter((x) => x.realm === 'nc')) { const k = r.genre || 'その他'; if (!byG.has(k)) byG.set(k, []); byG.get(k).push(r); }
  if (!byG.size) K.push('まだありません。');
  for (const [g, list] of byG) { K.push(`## ${g}`); for (const r of list.slice(0, 60)) K.push(`- ${r.content}`); K.push(''); }

  return {
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
