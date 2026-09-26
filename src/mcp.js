import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TYPES, CLASSIFY_RULES, CORE_RULES, addMemo, coreText, countUnclassified, getCore, getCoreMaterial, getDedupList,
  getOpenTasks, getPerson, getRecentRecordings, getUnclassifiedPhotos, importedRefs, getCategories, createCategory, getGenres, getUnitsWithoutGenre, setGenres, getUnclassified, saveCore, saveUnitsForMemo, searchUnits, todayJST, unitLine, updateUnit,
} from './brain.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const typeField = z.string().min(1).max(31);
const unitSchema = z.object({
  type: typeField.describe('既存の種類（event など）か、create_category で作ったカテゴリの key'),
  content: z.string().min(1),
  quote: z.string().optional(),
  reason: z.string().optional(),
  people: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  due: z.string().nullable().optional().describe('YYYY-MM-DD'),
  importance: z.number().int().min(1).max(3).optional(),
  same_as: z.number().int().nullable().optional().describe('既存の記憶と同じ内容ならそのid'),
  genre: z.string().max(20).optional().describe('引き出しの名前（テーマ）。既存の引き出し名があればそれを使う'),
});

const NEW_CATEGORY_RULE = `## 新しいカテゴリ
- 上の種類にも「自動で作ったカテゴリ」にも、どうしても当てはまらない内容があるときだけ、create_category で新しいカテゴリを作り、その key を type に使う
- 無理に event に押し込まない。ただし、既存の種類で表せるものに新しいカテゴリは作らない（似たカテゴリを増やさない）
- 新しいカテゴリは、なるべく既存の5つの層（event=出来事 / know=知識 / think=思考 / act=行動 / rel=関係）のどれかに入れる。どの層にも入らないときだけ layer を new にして新しい層を作る`;

async function categoriesPart(uid) {
  const cats = await getCategories(uid);
  const list = cats.length
    ? cats.map((c) => `- ${c.key}: ${c.label}（層：${c.layer === 'new' ? c.layer_label + '（新しい層）' : c.layer}）${c.description ? ' … ' + c.description : ''}`).join('\n')
    : '（まだありません）';
  const genres = await getGenres(uid);
  return `## 自動で作ったカテゴリ（type にそのまま使える）\n${list}\n\n${NEW_CATEGORY_RULE}

## 引き出し（genre）
- 各ユニットに genre として、その記憶が入る「引き出し」の名前を付ける。引き出しは、層の中でテーマごとに記憶をまとめる箱（例：営業トーク、kinbot開発、インターン管理、マーケ連携）
- 2〜8字程度の短い日本語にする。人物名は genre にせず people に入れる（関係の層は人物ごとに自動でまとまる）
- 下の既存の引き出しに合うものがあれば、必ず同じ名前を使う。似た名前を増やさない
- 既存の引き出し：${genres.length ? genres.map((g) => `${g.genre}（${g.n}）`).join('、') : '（まだありません）'}`;
}

export function buildMcpServer(uid) {
  const server = new McpServer({ name: 'knowkin', version: '1.0.0' });

  server.registerTool('get_core', {
    title: '本人の考え方の核と今のタスク',
    description:
      'knowkinの持ち主（いま会話しているユーザー本人）の価値観・判断のしかた・繰り返し学んでいる教訓・よく関わる人（上司など）の特徴と、今の未完了タスクをまとめて返す。'
      + 'ユーザーから仕事の相談、判断の相談、文章や提案書の作成・レビュー、タスクの整理などを頼まれたら、答える前にまずこれを呼び、本人の前提と上司のフィードバックをふまえて答えること。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const n = await countUnclassified(uid);
    const note = n ? `\n\n（未整理のメモが${n}件あります。回答のあとで「knowkinの未整理メモを整理しますか？」と一言たずねてよい）` : '';
    return text(coreText(await getCore(uid), await getOpenTasks(uid)) + note);
  });

  server.registerTool('get_current_tasks', {
    title: '未完了のタスク',
    description: 'ユーザー本人の未完了のタスクと目標を期限順に返す。「今やること」「優先順位」「スケジュール」の相談で使う。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const tasks = await getOpenTasks(uid);
    return text(tasks.length ? tasks.map(unitLine).join('\n') : '未完了のタスクはありません。');
  });

  server.registerTool('search_memory', {
    title: '記憶を検索',
    description:
      'ユーザー本人が残した記憶（上司や同僚からのフィードバック、対面での会話、学んだこと、判断とその理由、アイディア、未解決の問いなど）を検索する。'
      + '会社名・人物名・テーマ（例：提案書、見積もり、プレゼン）が話題に出たら、関連する過去の記憶を探して回答に活かすこと。',
    inputSchema: {
      query: z.string().optional().describe('キーワード（会社名・テーマなど）。空なら新しい順'),
      type: typeField.optional().describe('種類で絞り込む（自動で作ったカテゴリの key も可）。lesson=フィードバック・教訓, decision=判断と理由, idea, value, question, task, goal, person, input, event'),
      person: z.string().optional().describe('人物名で絞り込む'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const rows = await searchUnits(uid, args);
    return text(rows.length ? rows.map(unitLine).join('\n') : '該当する記憶はありません。');
  });

  server.registerTool('get_recent_recordings', {
    title: '最近の録音の要約',
    description: 'ユーザーが録音・アップロードした対面の会話やボイスメモの、タイトルと要約を新しい順に返す。「この前の打ち合わせ」「さっきの面談」などの話題が出たら使う。full=trueで文字起こし全文も返す。',
    inputSchema: { limit: z.number().int().min(1).max(20).optional(), full: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ limit, full }) => {
    const rows = await getRecentRecordings(uid, limit || 5);
    if (!rows.length) return text('録音はまだありません。');
    return text(rows.map((r) => [`# ${r.title}（${r.recorded_at} / メモ ${r.id}）`, ...r.summary.map((s) => `- ${s}`),
      ...(full ? ['', '## 文字起こし', r.text] : [])].join('\n')).join('\n\n'));
  });

  server.registerTool('get_person', {
    title: '人物の特徴と関連する記憶',
    description: '上司・同僚・取引先などの人物について、その人の判断基準やよく言うことと、関連する記憶を返す。その人に向けた資料・メッセージ・相談のときに使う。',
    inputSchema: { name: z.string().describe('人物名（名字だけでも可）') },
    annotations: { readOnlyHint: true },
  }, async ({ name }) => {
    const { profile, units } = await getPerson(uid, name);
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
      + `今日は ${todayJST()}。自動で作ったカテゴリの一覧は get_categories で確認できる。\n\n${CLASSIFY_RULES}\n\n${NEW_CATEGORY_RULE}`,
    inputSchema: {
      text: z.string().min(1).describe('残す内容（原本）'),
      units: z.array(unitSchema).optional().describe('自分で分類した記憶ユニット'),
      ref: z.string().max(200).optional().describe('取り込み元の識別子（例 kinbot:meeting:<bot_id>、kincall:daily:2026-09-27）。同じ ref は二重に保存されない'),
      source: z.enum(['claude', 'kinbot', 'kincall']).optional().describe('取り込み元。ユーザーに頼まれて残すときは省略'),
    },
  }, async ({ text: t, units, ref, source }) => {
    const r = await addMemo(uid, t, source || 'claude', units || null, ref || null);
    if (r.duplicate) return text(`この内容（${ref}）はすでに取り込み済みなので、保存しませんでした。`);
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
    const memos = await getUnclassified(uid, 20);
    const photos = await getUnclassifiedPhotos(uid, 4);
    if (!memos.length && !photos.length) return text('未整理のメモはありません。');
    const existing = await getDedupList(uid);
    const photoPart = photos.length ? `

## 未整理の写真（この下に画像が続きます）
写真はホワイトボード・手書きメモ・資料などです。写っている文字や図を読み取り、テキストのメモと同じルールで分類してください。
あわせて title（20字以内）と summary（読み取った要点3〜5個）も作って、写真のメモ id で save_units を呼んでください。
${JSON.stringify(photos.map((p) => ({ id: p.id, caption: p.text })))}` : '';
    const intro = text(`今日は ${todayJST()}。次のメモを分類し、メモごとに save_units を呼んでください。
source が voice のメモ（録音の文字起こし）は、あわせて title（20字以内）と summary（要点3〜5個の短い文）も作って save_units に渡してください。
${memos.length ? '' : '（テキストのメモはありません。写真だけ整理してください）'}
文字起こしは音声認識のため誤字や句読点抜けがあるので、文脈から意味をくみ取って整理してください。
source が gmail・gchat のメモ（メール・Googleチャットのやり取り）は、次の点を重視してください。
- 相手との関係性を person として残す：誰とどんな用件でやり取りしているか、相手の立場・口調・判断基準、どちらが依頼する側か
- 本人が頼まれたこと・約束したことは task（期限があれば due）、やり取りの中で決まったことは decision
- 同じ相手の person が既存の記憶にあれば、内容が同じなら same_as で重みを上げる
- メルマガ・自動通知・広告など、本人の仕事や関係性に関係ないものは units を空の配列にして save_units を呼ぶ（整理済みにするだけ）

${CLASSIFY_RULES}

${await categoriesPart(uid)}

## 未整理のメモ
${JSON.stringify(memos)}

## 既存の記憶（重複判定用）
${JSON.stringify(existing)}${photoPart}`);
    for (const p of photos) {
      intro.content.push({ type: 'text', text: `写真のメモ id ${p.id}${p.text && p.text !== '（写真）' ? `（ひとこと：${p.text}）` : ''}` });
      intro.content.push({ type: 'image', data: Buffer.from(p.data).toString('base64'), mimeType: p.mime });
    }
    return intro;
  });

  server.registerTool('get_categories', {
    title: '自動で作ったカテゴリの一覧',
    description: '既存の10種類に当てはまらない記憶のために、これまでに自動で作ったカテゴリの一覧を返す。',
    annotations: { readOnlyHint: true },
  }, async () => text(await categoriesPart(uid)));

  server.registerTool('create_category', {
    title: '新しいカテゴリを作る',
    description: '既存の種類にも、自動で作ったカテゴリにも当てはまらない記憶があるときだけ、新しいカテゴリを作る。作ったあとは、その key を save_units や add_memo の type に使う。作ったカテゴリは本人がknowkinの「見直し」で確認する。',
    inputSchema: {
      key: z.string().describe('英小文字で始まる英数字と _ の識別子（例：health_habit, side_project）'),
      label: z.string().describe('日本語の短い表示名（10字以内が目安。例：体調・習慣、副業）'),
      description: z.string().describe('このカテゴリにどんな記憶を入れるか（1文）'),
      layer: z.enum(['event', 'know', 'think', 'act', 'rel', 'new']).describe('入れる層。どの層にも入らないときだけ new'),
      new_layer_label: z.string().optional().describe('layer が new のときの新しい層の名前（4字以内が目安）'),
    },
  }, async (args) => {
    try {
      const c = await createCategory(uid, args);
      return text(`カテゴリ「${c.label}」（key: ${c.key}）を作りました。type に ${c.key} を使ってください。`);
    } catch (e) { return text(`作れませんでした：${e.message}`); }
  });

  server.registerTool('get_units_without_drawer', {
    title: '引き出しが決まっていない記憶',
    description: 'ユーザーが「knowkinの引き出しを整理して」と頼んだら呼ぶ。引き出し（genre）がまだ決まっていない記憶と、既存の引き出しの一覧を返すので、テーマごとに genre を決めて set_drawers で保存すること。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const units = await getUnitsWithoutGenre(uid);
    if (!units.length) return text('引き出しが決まっていない記憶はありません。');
    const genres = await getGenres(uid);
    return text(`次の記憶に、テーマごとの引き出しの名前（genre、2〜8字）を付けて set_drawers で保存してください。
人物名は引き出しにしない（関係の層は人物ごとに自動でまとまる）。既存の引き出しに合うものは同じ名前を使い、似た名前を増やさない。
既存の引き出し：${genres.length ? genres.map((g) => g.genre).join('、') : '（まだありません）'}

${JSON.stringify(units)}`);
  });

  server.registerTool('set_drawers', {
    title: '記憶を引き出しに入れる',
    description: 'get_units_without_drawer で取得した記憶に、引き出しの名前（genre）を付けて保存する。',
    inputSchema: { items: z.array(z.object({ id: z.number().int(), genre: z.string().min(1).max(20) })).max(200) },
  }, async ({ items }) => text(`${await setGenres(uid, items)}件を引き出しに入れました。`));

  server.registerTool('check_imported', {
    title: '取り込み済みか確認',
    description: 'kinbot・kincallなど他のツールから記憶を取り込む前に、その ref がすでにknowkinに取り込み済みかをまとめて確認する。返ってきた ref は取り込まないこと。',
    inputSchema: { refs: z.array(z.string().max(200)).max(200).describe('確認したい ref の一覧') },
    annotations: { readOnlyHint: true },
  }, async ({ refs }) => {
    const done = await importedRefs(uid, refs);
    return text(done.length ? `取り込み済み：${JSON.stringify(done)}` : 'どれもまだ取り込まれていません。');
  });

  server.registerTool('save_units', {
    title: '分類した記憶を保存',
    description: 'get_unclassified_memos で取得したメモ1件を分類した結果を保存し、そのメモを整理済みにする。分類ルールは get_unclassified_memos の結果に従う。',
    inputSchema: {
      memo_id: z.number().int().describe('メモのid'),
      units: z.array(unitSchema).describe('分類した記憶ユニット'),
      title: z.string().optional().describe('録音・写真のときのタイトル'),
      summary: z.array(z.string()).optional().describe('録音・写真のときの要点3〜5個'),
    },
  }, async ({ memo_id: memoId, units, title, summary }) => {
    const r = await saveUnitsForMemo(uid, memoId, units, { title, summary });
    return text(`メモ ${memoId}：${r.added}件を追加${r.repeated ? `、${r.repeated}件は既存の記憶の重みを上げました` : ''}。`);
  });

  server.registerTool('get_core_material', {
    title: '核を育てる材料を取得',
    description:
      'ユーザーが「knowkinの核を育てて」「考え方をまとめ直して」と頼んだら呼ぶ。教訓・判断・価値観・人物などの記憶を返すので、'
      + 'それを読んで本人の考え方の核をまとめ、save_core で保存すること。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const rows = await getCoreMaterial(uid);
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
    await saveCore(uid, args);
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
    const u = await updateUnit(uid, id, { done, due });
    return text(u ? `更新しました：${unitLine(u)}` : 'そのidのタスクは見つかりませんでした。');
  });

  return server;
}
