import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TYPES, addMemo, coreText, getCore, getOpenTasks, getPerson, searchUnits, unitLine, updateUnit,
} from './brain.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const typeEnum = z.enum(Object.keys(TYPES));

export function buildMcpServer() {
  const server = new McpServer({ name: 'knowkin', version: '1.0.0' });

  server.registerTool('get_core', {
    title: '本人の考え方の核と今のタスク',
    description:
      'knowkinの持ち主（いま会話しているユーザー本人）の価値観・判断のしかた・繰り返し学んでいる教訓・よく関わる人（上司など）の特徴と、今の未完了タスクをまとめて返す。'
      + 'ユーザーから仕事の相談、判断の相談、文章や提案書の作成・レビュー、タスクの整理などを頼まれたら、答える前にまずこれを呼び、本人の前提と上司のフィードバックをふまえて答えること。',
    annotations: { readOnlyHint: true },
  }, async () => text(coreText(await getCore(), await getOpenTasks())));

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
      'ユーザーが「これ覚えておいて」「メモして」「knowkinに残して」と頼んだ内容を記憶に残す。内容は自動で分類される。'
      + 'ユーザーが明示的に頼んだときだけ呼ぶこと。本人の言葉をなるべくそのまま渡す。',
    inputSchema: { text: z.string().min(1).describe('残す内容') },
  }, async ({ text: t }) => {
    const r = await addMemo(t, 'claude');
    if (r.error) return text(r.error);
    return text(`${r.added}件の記憶を残しました${r.repeated ? `（${r.repeated}件は既存の記憶と同じ内容だったので重みを上げました）` : ''}。`);
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
