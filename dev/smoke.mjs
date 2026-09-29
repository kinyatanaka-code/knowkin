// デプロイ前チェック：構文・画面のスクリプト・MCPツールの登録を確認する（DB不要）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let failed = false;
const ok = (m) => console.log(`OK   ${m}`);
const ng = (m) => { console.error(`NG   ${m}`); failed = true; };

// 1. サーバーの全ファイルの構文
for (const f of fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', path.join(root, 'src', f)], { stdio: 'pipe' }); ok(`構文 src/${f}`); }
  catch (e) { ng(`構文 src/${f}\n${e.stderr}`); }
}

// 2. 画面のスクリプトとタグの対応
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
scripts.forEach((s, i) => {
  const tmp = path.join(os.tmpdir(), `knowkin-ui-${i}.js`);
  fs.writeFileSync(tmp, s);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); ok(`画面のスクリプト ${i + 1}`); }
  catch (e) { ng(`画面のスクリプト ${i + 1}\n${e.stderr}`); }
});
for (const tag of ['div', 'section', 'nav', 'ul', 'button', 'script', 'style']) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  // テンプレート文字列内のタグも数えるので、開きと閉じの数だけを比べる
  if (open === close) ok(`タグ <${tag}> ${open}組`); else ng(`タグ <${tag}> 開き${open} 閉じ${close}`);
}

// 2a. <head> の中にタグ以外の文字が漏れていないか（画面の上に謎の文字が出るのを防ぐ）
const head = (html.match(/<head>([\s\S]*?)<\/head>/) || [,''])[1]
  .replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<title>[\s\S]*?<\/title>/g, '').replace(/<[^>]+>/g, '').trim();
if (head) ng(`<head> にタグ以外の文字があります：${head.slice(0, 60)}`); else ok('<head> の中身');

// 2b. スクリプトが参照する id が画面に存在するか（画面が真っ白・null エラーの防止）
const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const refs = new Set(scripts.flatMap((s) => [...s.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1])));
const missingIds = [...refs].filter((r) => !ids.has(r));
if (missingIds.length) ng(`画面に存在しない id を参照しています：${missingIds.join(', ')}`); else ok(`id の参照 ${refs.size}個`);

// 3. MCPツールが全部登録できるか
try {
  process.env.DATABASE_URL ||= 'postgresql://smoke:smoke@localhost:1/smoke';
  const { buildMcpServer } = await import(path.join(root, 'src/mcp.js'));
  const server = buildMcpServer(1);
  const tools = Object.keys(server._registeredTools || {});
  const expected = ['get_core', 'get_current_tasks', 'search_memory', 'get_person', 'add_memo',
    'get_unclassified_memos', 'save_units', 'get_core_material', 'save_core', 'update_task', 'get_recent_recordings', 'check_imported', 'get_categories', 'create_category', 'get_units_without_drawer', 'set_drawers', 'get_goals', 'propose_goal', 'link_to_goal', 'update_goal_position', 'get_goal_context', 'add_goal_tasks', 'get_quiz_material', 'add_quiz'];
  const missing = expected.filter((t) => !tools.includes(t));
  if (missing.length) ng(`MCPツールが足りません：${missing.join(', ')}`); else ok(`MCPツール ${tools.length}個`);
} catch (e) { ng(`MCPサーバーの組み立て\n${e.stack}`); }

if (failed) { console.error('\nチェックに失敗しました。デプロイしません。'); process.exit(1); }
console.log('\nすべてのチェックに通りました。');
process.exit(0);
