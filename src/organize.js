// Gemini に「整理」をさせるための入口（2026-11-22 田中さん「1時間に1回、Gemini に整理させたい」）。
//   会社の Gemini は knowkin に書き込めないので、パソコンの Chrome の拡張機能「knowkin for Gemini」が1時間ごとに
//   ① ここから整理の頼みごと（決まり＋未整理メモ）をもらい ② Gemini の画面に貼って送り ③ Gemini の答えの JSON をここに返す。
//   knowkin はその JSON を、Claude の save_units と同じ形で保存する。Gemini の API は使わない（お金がかからない）
import { z } from 'zod';
import { CLASSIFY_RULES, TYPES, getCategories, getDedupList, getUnclassified, saveUnitsForMemo } from './brain.js';
import { categoriesPart, unitSchema } from './mcp.js';

export const ORGANIZE_MARK = '【knowkin整理】';
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

/** 1回分の頼みごと。Gemini の入力欄に貼れる大きさ（3万字ほど）に収める */
export async function organizeBatch(uid) {
  const memos = [];
  let used = 0;
  for (const m of await getUnclassified(uid, 8)) {
    if (memos.length && used + m.text.length > 12000) break;
    const text = m.text.length > 6000 ? m.text.slice(0, 6000) + '\n（長いので以下省略）' : m.text;
    memos.push({ id: m.id, source: m.source, at: m.recorded_at, text });
    used += text.length;
  }
  if (!memos.length) return { batch: [], prompt: '' };
  let existing = JSON.stringify(await getDedupList(uid));
  if (existing.length > 8000) existing = existing.slice(0, 8000) + '…';
  const prompt = `${ORGANIZE_MARK} 次の未整理メモを、下の決まりで分類してください（knowkin の自動整理です。今日は ${today()}）。

## 答え方（必ず守る）
- 答えは、次の形の JSON を \`\`\`json のかたまりで1つだけ書く。前後に説明を書かない。
- メモごとに1つ、results に入れる。分類する中身がないメモ（広告・自動通知など）は units を空の配列 [] にする。
- source が voice のメモは title（20字以内）と summary（要点3〜5個）も入れる。
- create_category は使えないので、type は決まりにある種類か、下の「自動で作ったカテゴリ」の key だけを使う。

\`\`\`json
{"knowkin_organize": 1, "results": [{"memo_id": 123, "units": [{"type": "decision", "content": "…", "reason": "…", "people": [], "tags": [], "importance": 2, "realm": "self"}], "title": "", "summary": []}]}
\`\`\`

source が claude・chatgpt・gemini などのメモはAIとの会話（AI履歴）です。本人の発言から、決めたこと・理由・気づき・迷い・やると言ったことを拾い、AIの返答の中身は本人が受け入れたものだけ記憶にしてください。
文字起こし（voice）は音声認識のため誤字があるので、文脈から意味をくみ取ってください。

${CLASSIFY_RULES}

${await categoriesPart(uid)}

## 未整理のメモ
${JSON.stringify(memos)}

## 既存の記憶（重複判定用。同じ内容なら same_as にその id）
${existing}`;
  return { batch: memos.map((m) => m.id), prompt };
}

const resultSchema = z.object({
  memo_id: z.coerce.number().int(),
  units: z.array(z.unknown()).default([]),
  title: z.string().optional(),
  summary: z.array(z.string()).optional(),
});

/** Gemini の答え（JSON の文字列か、JSON を含む答え全体）を保存する。頼んだメモ（batch）以外は受け付けない */
export async function organizeApply(uid, answer, batch = []) {
  const raw = String(answer || '');
  const m = raw.match(/\{[\s\S]*"knowkin_organize"[\s\S]*\}/);
  if (!m) throw new Error('答えに整理の JSON が見つかりませんでした');
  let data;
  try { data = JSON.parse(m[0]); } catch {
    // 前後に余分な文字が付いたとき、最後の } までを少しずつ縮めて読む
    let t = m[0]; data = null;
    for (let i = 0; i < 20 && !data; i++) { t = t.slice(0, t.lastIndexOf('}', t.length - 2) + 1); try { data = JSON.parse(t); } catch {} }
    if (!data) throw new Error('整理の JSON を読めませんでした');
  }
  const allow = new Set((batch || []).map(Number));
  // 種類は、決まりにあるものと自動で作ったカテゴリだけ（Gemini はカテゴリを作れないので、知らない種類は捨てる）
  const kinds = new Set([...Object.keys(TYPES), ...(await getCategories(uid)).map((c) => c.key)]);
  let saved = 0, added = 0, skipped = 0, bad = 0;
  for (const r0 of Array.isArray(data.results) ? data.results : []) {
    const r = resultSchema.safeParse(r0);
    if (!r.success || (allow.size && !allow.has(r.data.memo_id))) { skipped++; continue; }
    const units = [];
    for (const u of r.data.units) { const p = unitSchema.safeParse(u); if (p.success && kinds.has(p.data.type)) units.push(p.data); else bad++; }
    try { const x = await saveUnitsForMemo(uid, r.data.memo_id, units, { title: r.data.title || '', summary: r.data.summary || [] }); saved++; added += x.added || 0; }
    catch { skipped++; }
  }
  return { saved, added, skipped, bad };
}
