// Gemini に、Claude と同じ「手入れ」（整理・仕分け・置き場所・引き出し・目的のタスク・再現度テスト・核）をさせる。
// 2026-11-22 田中さん「Claude でやっている 整理・核・成長・タスク・目的 を Gemini でもできるようにしたい」。
//
// しくみ：Claude がコネクタで呼んでいる knowkin の道具（MCP）を、そのまま中で呼ぶ。
//   ① 読む道具（get_unclassified_memos など）の結果を、Gemini への頼みごとにする
//   ② Gemini は道具を呼べないので、呼びたい書く道具と中身を JSON（knowkin_calls）で答える
//   ③ knowkin が、決めた書く道具だけを、その JSON の中身で呼ぶ（中身は道具の決まりで確かめてから）
// 頼みごとの受け渡しは、パソコンの Chrome の拡張機能「knowkin for Gemini」がする（Gemini の API は使わない）。
import { pool } from './db.js';
import { countUnclassified, requestCore, upkeepNeeds } from './brain.js';
import { quizNeeded } from './growth.js';
import { pendingTaskRequests } from './goals.js';
import { buildMcpServer } from './mcp.js';

export const JOB_MARK = '【knowkin整理】';

// 手入れの種類：読む道具 → 使ってよい書く道具
const JOBS = {
  整理: { read: [['get_unclassified_memos', {}]], write: ['save_units'] },
  仕分け: { read: [['get_units_for_relevance', {}]], write: ['set_relevance'] },
  置き場所: { read: [['get_units_for_realm', {}]], write: ['set_realm'] },
  引き出し: { read: [['get_units_without_drawer', {}]], write: ['set_drawers'] },
  目的のタスク: { read: [], write: ['add_goal_tasks'] },   // 読むのは goal ごと（下で組み立てる）
  再現度テスト: { read: [['get_quiz_material', {}]], write: ['add_quiz'] },
  核: { read: [['get_core_material', {}]], write: ['save_core'] },
};
// チャットで本人に頼まれたときに、Gemini の答えから動かしてよい道具（消す道具は入れない）
export const CHAT_TOOLS = ['update_task', 'propose_goal', 'update_goal_position', 'add_goal_tasks', 'request_job', 'save_work'];

function tools(uid) {
  // ai に claude 以外を入れて、Claude 以外の AI 向けの小さい結果にする（Gemini の入力欄に入る大きさ）
  return buildMcpServer(uid, { ai: 'gemini' })._registeredTools;
}
async function callTool(reg, name, args) {
  const t = reg[name];
  if (!t) throw new Error(`道具「${name}」がありません`);
  const parsed = t.inputSchema ? t.inputSchema.safeParse(args || {}) : { success: true, data: args || {} };
  if (!parsed.success) throw new Error(`「${name}」の中身が決まりに合いません：${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join(' / ')}`);
  const r = await t.handler(parsed.data, {});
  return (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

/** いまやるべき手入れ（skip に入っているものは飛ばす）。なければ null */
export async function nextJob(uid, skip = []) {
  const s = new Set(skip);
  const up = await upkeepNeeds(uid);
  const order = [
    ['整理', async () => (await countUnclassified(uid)) > 0],
    ['仕分け', async () => up.relevance > 0],
    ['置き場所', async () => up.realm > 0],
    ['引き出し', async () => up.drawers > 0],
    ['目的のタスク', async () => (await pendingTaskRequests(uid)).length > 0],
    ['再現度テスト', async () => quizNeeded(uid)],
    ['核', async () => up.core],
  ];
  for (const [job, need] of order) if (!s.has(job) && (await need())) return job;
  return null;
}

/** Gemini に貼る頼みごと */
export async function jobPrompt(uid, job) {
  const def = JOBS[job];
  if (!def) throw new Error(`知らない手入れです：${job}`);
  const reg = tools(uid);
  let material = '';
  if (job === '目的のタスク') {
    const g = (await pendingTaskRequests(uid))[0];
    if (!g) return null;
    material = `目的 id ${g.id}「${g.title}」のタスクを作ってください。\n\n` + await callTool(reg, 'get_goal_context', { goal_id: g.id });
  } else {
    for (const [name, args] of def.read) material += (material ? '\n\n' : '') + await callTool(reg, name, args);
  }
  if (!material.trim() || /ありません。?$/.test(material.trim())) return null;
  // 道具の説明（書く道具の入れ方）を付ける
  const schemaOf = (name) => { const t = reg[name]; try { return JSON.stringify(t.inputSchema ? zodToHint(t.inputSchema) : {}); } catch { return '{}'; } };
  return `${JOB_MARK} knowkin の「${job}」をしてください（自動の手入れです）。

## 答え方（必ず守る）
- あなたは道具を直接呼べません。下の材料の中で「〇〇を呼んでください」と書いてある書く道具は、呼ぶ代わりに、次の形の JSON にして答えてください。
- 答えは \`\`\`json のかたまりを1つだけ。前後に説明を書かない。
- 使ってよい道具は ${def.write.join('・')} だけ。それ以外（kinbot・kincall・kinXs の道具、add_memo、create_category など）は使わず、その作業は飛ばす。
- 1つの道具を何回でも呼べます（例：メモごとに save_units を1回ずつ）。

\`\`\`json
{"knowkin_calls": [{"tool": "${def.write[0]}", "args": ${schemaOf(def.write[0])}}]}
\`\`\`

## 材料（knowkin の道具の結果）
${material}`;
}
// zod の形から、args の見本（項目名と型）を作る
function zodToHint(schema) {
  const shape = schema.shape || (schema._def && schema._def.shape && schema._def.shape()) || {};
  const out = {};
  for (const [k, v] of Object.entries(shape)) {
    const t = (v._def && (v._def.typeName || '')) || '';
    out[k] = /Array/.test(t) ? ['…'] : /Number/.test(t) ? 0 : /Boolean/.test(t) ? true : /Object/.test(t) ? {} : '…';
  }
  return out;
}

/** Gemini の答えの knowkin_calls を、許した道具だけ呼ぶ */
export async function applyCalls(uid, answer, allowed) {
  const raw = String(answer || '');
  const m = raw.match(/\{[\s\S]*"knowkin_calls"[\s\S]*\}/);
  if (!m) throw new Error('答えに knowkin_calls の JSON が見つかりませんでした');
  let data = null, t = m[0];
  for (let i = 0; i < 30 && !data; i++) { try { data = JSON.parse(t); } catch { const k = t.lastIndexOf('}', t.length - 2); if (k < 0) break; t = t.slice(0, k + 1); } }
  if (!data || !Array.isArray(data.knowkin_calls)) throw new Error('knowkin_calls の JSON を読めませんでした');
  const reg = tools(uid);
  const ok = new Set(allowed);
  const results = [];
  for (const c of data.knowkin_calls.slice(0, 60)) {
    const name = String((c && c.tool) || '');
    if (!ok.has(name)) { results.push({ tool: name, ok: false, text: '許していない道具なので動かしませんでした' }); continue; }
    try {
      if (name === 'request_job') { const r = await requestJob(uid, c.args && c.args.job); results.push({ tool: name, ok: true, text: r }); continue; }
      // 作ったものの全文を JSON に書き写すと長く・崩れやすいので、"@answer" なら答えそのもの（JSON のかたまりを除く）を全文にする
      if (name === 'save_work' && c.args && c.args.content === '@answer') c.args.content = answerBody(raw);
      results.push({ tool: name, ok: true, text: (await callTool(reg, name, c.args || {})).slice(0, 300) });
    } catch (e) { results.push({ tool: name, ok: false, text: e.message.slice(0, 300) }); }
  }
  return results;
}
// 「私：…\n\nGemini：…\n\nURL」から、Gemini の答えだけ（knowkin_calls の JSON のかたまりを除く）を取り出す
function answerBody(raw) {
  let a = raw.includes('Gemini：') ? raw.slice(raw.indexOf('Gemini：') + 'Gemini：'.length) : raw;
  a = a.replace(/\n\nhttps:\/\/gemini\.google\.com\S*\s*$/, '');
  a = a.replace(/(```json\s*)?\{[\s\S]*"knowkin_calls"[\s\S]*\}(\s*```)?/, '');
  return a.replace(/\n?JSON\s*$/i, '').trim();
}
export async function applyJob(uid, job, answer) {
  const def = JOBS[job];
  if (!def) throw new Error(`知らない手入れです：${job}`);
  return applyCalls(uid, answer, def.write);
}

// チャットで「整理して」「核を育てて」と頼まれたとき：印を付けておき、拡張機能が2分以内に拾って手入れを始める
export async function requestJob(uid, job) {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS gemini_job_request_at TIMESTAMPTZ').catch(() => {});
  if (String(job || '').includes('核')) await requestCore(uid);
  await pool.query('UPDATE users SET gemini_job_request_at = now() WHERE id = $1', [uid]);
  return '手入れを頼みました（パソコンの Chrome の拡張機能が、2分以内に Gemini で始めます）';
}
export async function takeJobRequest(uid) {
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS gemini_job_request_at TIMESTAMPTZ').catch(() => {});
  const { rows } = await pool.query('UPDATE users SET gemini_job_request_at = NULL WHERE id = $1 AND gemini_job_request_at IS NOT NULL RETURNING id', [uid]);
  return rows.length > 0;
}

/** 「今日・目的・タスク・成長」のドキュメント（Gemini で「タスク」「目的」「成長」と聞かれたときに読む）。Claude と同じ道具の結果を並べる */
export async function nowDoc(uid) {
  const reg = tools(uid);
  const part = async (h, name) => { try { return `# ${h}\n\n${await callTool(reg, name, {})}`; } catch (e) { return `# ${h}\n\n読めませんでした：${e.message}`; } };
  return [await part('今日の状況（ブリーフィング）', 'get_briefing'), await part('目的と現在地（id 付き）', 'get_goals'),
    await part('未完了のタスク（id 付き）', 'get_current_tasks'), await part('脳の成長（量・深さ・広さ・再現度と次に伸ばすヒント）', 'get_growth')].join('\n\n');
}
