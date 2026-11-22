// Gemini のスキル「knowkin」の中身を返す（gemini-skill/ のファイルから）。
//   スキルの zip はアップロードし直さないと変わらないので、中身はドライブのドキュメントに置き、
//   Apps Script が10分ごとに書き直す。ここを直して上げれば、Gemini のスキルも自動で新しくなる（2026-11-22）
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gemini-skill');

export async function skillMain() { return readFile(path.join(DIR, 'main.md'), 'utf8'); }
export async function skillRules() {
  const files = (await readdir(path.join(DIR, 'rules'))).filter((f) => f.endsWith('.md')).sort();
  const parts = [];
  for (const f of files) parts.push(await readFile(path.join(DIR, 'rules', f), 'utf8'));
  return ['# 1 書き方の決まり（分析・提案資料・お礼メール）', '', 'スキル「knowkin」の長い決まり。「0 目次」から、必要な見出しのところだけ読む。', '', ...parts].join('\n\n');
}

/** 決まりを1ファイルずつ（見出し＝1行目の「# 〇〇」）。コネクタの get_writing_rules が、話題ごとに選んで返す */
export async function skillRuleParts() {
  const files = (await readdir(path.join(DIR, 'rules'))).filter((f) => f.endsWith('.md')).sort();
  const out = [];
  for (const f of files) { const t = await readFile(path.join(DIR, 'rules', f), 'utf8'); out.push({ title: (t.match(/^# (.+)$/m) || [])[1] || f, text: t }); }
  return out;
}
