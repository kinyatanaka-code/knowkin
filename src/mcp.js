import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TYPES, CLASSIFY_RULES, CORE_RULES, addMemo, coreText, countUnclassified, getCore, getCoreMaterial, getDedupList,
  getOpenTasks, getPerson, getUnclassified, saveCore, saveUnitsForMemo, searchUnits, todayJST, unitLine, updateUnit,
} from './brain.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const typeEnum = z.enum(Object.keys(TYPES));
const unitSchema = z.object({
  type: typeEnum,
  content: z.string().min(1),
  quote: z.string().optional(),
  reason: z.string().optional(),
  people: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  due: z.string().nullable().optional().describe('YYYY-MM-DD'),
  importance: z.number().int().min(1).max(3).optional(),
  same_as: z.number().int().nullable().optional().describe('既存の記憶と同じ内容ならそのid'),
});

export function buildMcpServer() {
  const server = new McpServer({ name: 'knowkin', version: '1.0.0' });

  server.registerTool('get_core', {
    title: '本人の考え方の核と今のタスク',
    description:
      'knowkinの持ち主（いま会話しているユーザー本人）の価値観・判断のしかた・繰り返し学んでいる教訓・よく関わる人（上司など）の特徴と、今の未完了タスクをまとめて返す。'
      + 'ユーザーから仕事の相談、判断の相談、文章や提案書の作成・レビュー、タスクの整理などを頼まれたら、答える前にまずこれを呼び、本人の前提と上司のフィードバックをふまえて答えること。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const n = await countUnclassified();
    const note = n ? `\n\n（未整理のメモが${n}件あります。回答のあとで「knowkinの未整理メモを整理しますか？」と一言たずねてよい）` : '';
    return text(coreText(await getCore(), await getOpenTasks()) + note);
  });

  server.registerTool('get_current_tasks', {
    title: '未完了のタスク',
    description: 'ユーザー本人の未完了のタスクと目標を期限順に返す。「今やること」「優先順位」「スケジュール」の相談で使う。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const tasks = await getOpenTasks();
    return text(tasks.length ? tasks.map(unitLine).join('\n') : '未完了のタスクはありません。');
  });

  server.registerTool('search_memory', {
    title: '記憶を検索',
    description:
      'ユーザー本人が残した記憶（上司や同僚からのフィードバック、対面での会話、学んだこと、判断とその理由、アイディア、未解決の問いなど）を検索する。'
      + '会社名・人物名・テーマ（例：提案書、見積もり、プレゼン）が話題に出たら、関連する過去の記憶を探して回答に活かすこと。',
    inputSchema: {
      query: z.string().optional().describe('キーワード（会社名・テーマなど）。空なら新しい順'),
      type: typeEnum.optional().describe('種類で絞り込む。lesson=フィードバック・教訓, decision=判断と理由, idea, value, question, task, goal, person, input, event'),
      person: z.string().optional().describe('人物名で絞り込む'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const rows = await searchUnits(args);
    return text(rows.length ? rows.map(unitLine).join('\n') : '該当する記憶はありません。');
  });

  server.registerTool('get_person', {
    title: '人物の特徴と関連する記憶',
    description: '上司・同僚・取引先などの人物について、その人の判断基準やよく言うことと、関連する記憶を返す。その人に向けた資料・メッセージ・相談のときに使う。',
    inputSchema: { name: z.string().describe('人物名（名字だけでも可）') },
    annotations: { readOnlyHint: true },
  }, async ({ name }) => {
    const { profile, units } = await getPerson(name);
    const L = [];
    if (profile) L.push(`# ${profile.name}`, ...profile.points.map((p) => `- ${p}`), '');
    L.push('## 関連する記憶', units.length ? units.map(unitLine).join('\n') : 'なし');
    return text(L.join('\n'));
  });

  server.registerTool('add_memo', {
    title: '記憶に残す',
    description:
      'ユーザーが「これ覚えておいて」「メモして」「knowkinに残して」と頼んだ内容を記憶に残す。ユーザーが明示的に頼んだときだけ呼ぶこと。'
      + 'text には本人の言葉をなるべくそのまま渡し、units には下のルールで自分で分類した結果を渡す（units を渡すとそのまま分類済みとして保存される）。'
      + '重複を判定したいときは先に get_unclassified_memos の existing か search_memory で既存の記憶を確認する。'
      + `今日は ${todayJST()}。\n\n${CLASSIFY_RULES}`,
    inputSchema: {
      text: z.string().min(1).describe('残す内容（原本）'),
      units: z.array(unitSchema).optional().describe('自分で分類した記憶ユニット'),
    },
  }, async ({ text: t, units }) => {
    const r = await addMemo(t, 'claude', units || null);
    if (r.error) return text(r.error);
    if (r.pending) return text(`原本をメモ ${r.memo_id} として保存しました（未整理）。units を付けて保存し直すか、get_unclassified_memos → save_units で整理してください。`);
    return text(`${r.added}件の記憶を残しました${r.repeated ? `（${r.repeated}件は既存の記憶と同じ内容だったので重みを上げました）` : ''}。`);
  });

  server.registerTool('get_unclassified_memos', {
    title: '未整理のメモを取得',
    description:
      'Web画面やボイスメモで記録されたまま、まだ分類されていないメモと、重複判定用の既存の記憶を返す。'
      + 'ユーザーが「knowkinを整理して」「未整理メモを整理して」と頼んだら呼び、各メモを分類して save_units で1メモずつ保存すること。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const memos = await getUnclassified(20);
    if (!memos.length) return text('未整理のメモはありません。');
    const existing = await getDedupList();
    return text(`今日は ${todayJST()}。次のメモを分類し、メモごとに save_units を呼んでください。

${CLASSIFY_RULES}

## 未整理のメモ
${JSON.stringify(memos)}

## 既存の記憶（重複判定用）
${JSON.stringify(existing)}`);
  });

  server.registerTool('save_units', {
    title: '分類した記憶を保存',
    description: 'get_unclassified_memos で取得したメモ1件を分類した結果を保存し、そのメモを整理済みにする。分類ルールは get_unclassified_memos の結果に従う。',
    inputSchema: {
      memo_id: z.number().int().describe('メモのid'),
      units: z.array(unitSchema).describe('分類した記憶ユニット'),
    },
  }, async ({ memo_id: memoId, units }) => {
    const r = await saveUnitsForMemo(memoId, units);
    return text(`メモ ${memoId}：${r.added}件を追加${r.repeated ? `、${r.repeated}件は既存の記憶の重みを上げました` : ''}。`);
  });

  server.registerTool('get_core_material', {
    title: '核を育てる材料を取得',
    description:
      'ユーザーが「knowkinの核を育てて」「考え方をまとめ直して」と頼んだら呼ぶ。教訓・判断・価値観・人物などの記憶を返すので、'
      + 'それを読んで本人の考え方の核をまとめ、save_core で保存すること。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const rows = await getCoreMaterial();
    if (rows.length < 3) return text('まだ材料が少ないため、核は育てられません（教訓・判断・価値観などが3つ以上必要です）。');
    return text(`次の記憶ユニットを読み直し、この人の考え方の核をまとめて save_core で保存してください（count は繰り返された回数、importance は重要度）。

## ルール
${CORE_RULES}

## 記憶ユニット
${JSON.stringify(rows)}`);
  });

  server.registerTool('save_core', {
    title: '核を保存',
    description: 'get_core_material をもとにまとめた、本人の考え方の核を保存する（前の核は置き換わる）。',
    inputSchema: {
      summary: z.string().describe('この人の考え方を1〜2文で'),
      values: z.array(z.string()).describe('大事にしていること'),
      decision_rules: z.array(z.string()).describe('判断のしかた'),
      lessons: z.array(z.string()).describe('繰り返し学んでいること'),
      people: z.array(z.object({ name: z.string(), points: z.array(z.string()) })).describe('よく関わる人の特徴'),
      open_questions: z.array(z.string()).describe('まだ答えが出ていないこと'),
    },
  }, async (args) => {
    await saveCore(args);
    return text('核を保存しました。');
  });

  server.registerTool('update_task', {
    title: 'タスクを更新',
    description: 'タスクを完了・未完了にする、または期限を変える。ユーザーが「終わった」「期限が変わった」と言ったときに使う。idは get_current_tasks の結果にある。',
    inputSchema: {
      id: z.number().int().describe('タスクのid'),
      done: z.boolean().optional(),
      due: z.string().nullable().optional().describe('新しい期限 YYYY-MM-DD（消すなら null）'),
    },
  }, async ({ id, done, due }) => {
    const u = await updateUnit(id, { done, due });
    return text(u ? `更新しました：${unitLine(u)}` : 'そのidのタスクは見つかりませんでした。');
  });

  return server;
}
