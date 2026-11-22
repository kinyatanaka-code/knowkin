import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pool } from './db.js';
import { addQuiz, getGrowth, openQuiz, quizMaterial, quizNeeded, rateQuiz } from './growth.js';
import { getBriefing } from './briefing.js';
import { companyDetail, companyKey, findTranscripts, kinbotConfig, listCompanies, searchBiz } from './kinbot-sync.js';
import { buildMeetingDocs, buildProposalLibrary, buildReport, buildSfOpenDeals } from './report-export.js';
import { skillMain, skillRuleParts } from './skill-export.js';
import { callUpstream, zodShape } from './upstream.js';
import { addGoalTasks, getGoals, goalContext, goalsText, linkUnits, pendingTaskRequests, proposeGoal, renameMilestone, setGoalNote, updateGoal, addMilestones } from './goals.js';
import {
  TYPES, CLASSIFY_RULES, CORE_RULES, addMemo, coreText, countUnclassified, getCore, getCoreMaterial, getDedupList,
  getOpenTasks, getPerson, getRecentRecordings, getUnclassifiedPhotos, importedRefs, getCategories, getCompanies, getUnitsForRealm, setRealm, AI_SOURCES, BIZ_SOURCES, createCategory, getGenres, getUnitsForRelevance, setRelevance, upkeepNeeds, markImported, getUnitsWithoutGenre, setGenres, getUnclassified, saveCore, saveUnitsForMemo, searchUnits, todayJST, unitLine, updateUnit,
} from './brain.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const typeField = z.string().min(1).max(31);
export const unitSchema = z.object({
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
  goal_id: z.number().int().nullable().optional().describe('この記憶が近づける目的のid（あれば）'),
  relevance: z.enum(['direct', 'peripheral']).optional().describe('本人との関わり。direct=本人が当事者 / peripheral=周辺の情報（本人が関わっていない他人のやり取りなど）'),
  area: z.enum(['work', 'life']).optional().describe('task・goal のとき：work=仕事 / life=プライベート'),
  scope: z.enum(['year', 'month', 'week', 'day']).optional().describe('task・goal のとき：いつやるか（今年・今月・今週・今日）'),
  period: z.string().optional().describe('scope の期間（2026 / 2026-09 / 2026-W40 / 2026-09-28）。省略すると今の期間'),
  realm: z.enum(['self', 'company', 'nc']).optional().describe('置き場所。self=自分の脳（既定）/ company=企業情報（顧客企業ごとの情報）/ nc=ネオキャリアナレッジ（会社として共有できる知識）'),
  company: z.string().max(60).optional().describe('realm が company のときの企業名。既存の企業名と同じ書き方にする'),
});

const NEW_CATEGORY_RULE = `## 新しいカテゴリ
- 上の種類にも「自動で作ったカテゴリ」にも、どうしても当てはまらない内容があるときだけ、create_category で新しいカテゴリを作り、その key を type に使う
- 無理に event に押し込まない。ただし、既存の種類で表せるものに新しいカテゴリは作らない（似たカテゴリを増やさない）
- 新しいカテゴリは、なるべく既存の5つの層（event=出来事 / know=知識 / think=思考 / act=行動 / rel=関係）のどれかに入れる。どの層にも入らないときだけ layer を new にして新しい層を作る`;

export async function categoriesPart(uid) {
  const cats = await getCategories(uid);
  const list = cats.length
    ? cats.map((c) => `- ${c.key}: ${c.label}（層：${c.layer === 'new' ? c.layer_label + '（新しい層）' : c.layer}）${c.description ? ' … ' + c.description : ''}`).join('\n')
    : '（まだありません）';
  const genres = await getGenres(uid);
  const goals = (await getGoals(uid)).filter((g) => g.status !== 'dropped');
  const companies = await getCompanies(uid);
  return `## 企業情報にある企業名（realm が company のときは、合う企業があれば同じ書き方を使う）
${companies.length ? companies.map((c) => c.company).join('、') : '（まだありません）'}

## 自動で作ったカテゴリ（type にそのまま使える）\n${list}\n\n${NEW_CATEGORY_RULE}

## 引き出し（genre）
- 各ユニットに genre として、その記憶が入る「引き出し」の名前を付ける。引き出しは、層の中でテーマごとに記憶をまとめる箱（例：営業トーク、kinbot開発、インターン管理、マーケ連携）
- 2〜8字程度の短い日本語にする。人物名は genre にせず people に入れる（関係の層は人物ごとに自動でまとまる）
- 下の既存の引き出しに合うものがあれば、必ず同じ名前を使う。似た名前を増やさない
- 既存の引き出し：${genres.length ? genres.map((g) => `${g.genre}（${g.n}）`).join('、') : '（まだありません）'}

## 本人との関わり（relevance）
- 本人（田中欽也）が当事者でない内容は relevance を peripheral にする。例：本人が送り手でも受け手でもなく、依頼も判断もしていない他の人同士のやり取り（ほかの部署の申請・承認、ほかの担当者の顧客対応、チャンネル上の他人の報告など）、一度名前が出ただけで本人と直接やり取りしていない人物
- 本人が頼まれた・頼んだ・判断した・学んだ・関わる予定があるものは direct
- 関わりがまったくなく、覚えておく価値もないものは、そもそも記憶にしない（units を空にしてよい）
- task と goal は常に本人のものなので direct（他人のタスクは task にしない）

## タスクの分け方
- task と goal には area（work=仕事 / life=プライベート）を必ず付ける
- 「今日中に」「今週」「今月中」「今年のうちに」など時期が話されていれば scope（day / week / month / year）を付ける。期限（due）だけわかる場合は scope を省略してよい（期限の日になる）
- 時期がまったくわからないものは scope を付けない（「いつか」に入る）

## 目的（叶えたいこと）
- タスク・判断・教訓などが下の目的のどれかに近づくものなら、goal_id にその目的の id を入れる。関係ないものには入れない
- 本人が「〜したい」「〜になりたい」「いつか〜」など、仕事でもプライベートでも成し遂げたいこと・叶えたい未来を語っていたら、propose_goal で目的の候補を出す（本人が承認するまで目的にはならない）。type が goal の記憶も候補にする
- すでにある目的や候補と同じものは出さない
- 保存したあと、つながった記憶で現在地が変わった目的があれば、update_goal_position で現在地の一言を書き直す
- 今の目的：${goals.length ? goals.map((g) => `id ${g.id}「${g.title}」${g.status === 'candidate' ? '（承認待ちの候補）' : ''}`).join('、') : '（まだありません）'}`;
}

// どのAIにも最初に伝えること（Gemini・ChatGPTなどは、Claudeのプロジェクトの指示がないので、ここで頼む）
const SERVER_INSTRUCTIONS = `knowkin は田中欽也の「第二の脳」です。あなたは本人の相棒として答えてください。
- 会話の最初に get_briefing を呼び、本人の今の状況をつかむ
- 本人が発言するたびに、返事を書いたあとで add_memo を呼び、本人の発言をそのまま text に入れて残す（source は省略。短い相づちは残さなくてよい）。これが本人とあなたの会話の記録（AI履歴）になる
- 本人の考え方は get_core、過去の記録は search_memory、顧客企業のことは get_company で調べてから答える
- 架電・アポ・稼働は kincall_ で始まる道具、商談・案件・Salesforce は kinbot_ で始まる道具、DOCの導入企業・候補者の質問は kinxs_ で始まる道具で、その場の数字を調べられる
- 商談・アポ・架電の数や率・人ごとの比較は get_sales_report（knowkin が全件を数えた結果。自分で数え直さない）
- 特定の会社の打ち合わせ（お礼メール・商談準備）は get_meeting_notes、お客様の実際の言葉は get_transcript
- 提案資料は get_proposal_library（これまでの資料から数えたベース）と get_meeting_notes を材料に作る
- Salesforce の更新漏れ探し・まだ閉じていない商談の一覧は get_sf_open_deals
- 分析・提案資料・お礼メールを作る前に get_writing_rules で決まりと完成例を読み、その形で書く
- 記録にないことを事実のように言わない。1回に聞くのは1つだけ。返事は短く`;

export function buildMcpServer(uid, { ai = '', upstream = [] } = {}) {
  const server = new McpServer({ name: 'knowkin', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS });

  // 連携先（kinbot・kincall・kinXs）の読み取りの道具を、名前の頭に連携先を付けてそのまま出す
  for (const up of upstream) {
    if (!up.ok) continue;
    for (const t of up.tools) {
      const name = `${up.key}_${t.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
      try {
        server.registerTool(name, {
          title: `${up.label}：${t.title || t.name}`,
          description: `【連携先 ${up.label}（${up.about}）】${String(t.description || '').slice(0, 900)}`,
          inputSchema: zodShape(t.inputSchema),
          annotations: { readOnlyHint: true },
        }, async (args) => {
          try { return await callUpstream(up.key, t.name, args, ai && ai !== 'claude' ? 20000 : 400000); }
          catch (e) { return { ...text(`${up.label} の「${t.name}」を呼べませんでした：${e.message}`), isError: true }; }
        });
      } catch (e) { console.error('upstream tool skipped', name, e.message); }
    }
  }

  server.registerTool('get_core', {
    title: '本人の考え方の核と今のタスク',
    description:
      'knowkinの持ち主（いま会話しているユーザー本人）の価値観・判断のしかた・繰り返し学んでいる教訓・よく関わる人（上司など）の特徴と、今の未完了タスクをまとめて返す。'
      + 'ユーザーから仕事の相談、判断の相談、文章や提案書の作成・レビュー、タスクの整理などを頼まれたら、答える前にまずこれを呼び、本人の前提と上司のフィードバックをふまえて答えること。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const n = await countUnclassified(uid);
    const note = n ? `\n\n（未整理のメモが${n}件あります。回答のあとで「knowkinの未整理メモを整理しますか？」と一言たずねてよい）` : '';
    const gt = goalsText(await getGoals(uid));
    return text(coreText(await getCore(uid), await getOpenTasks(uid)) + (gt ? `\n\n${gt}\n（相談に答えるときは、どの目的に効くかも意識すること）` : '') + note);
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
    const biz = args.query && !args.type && !args.person ? await searchBiz(uid, args.query, 10) : [];
    const bizPart = biz.length ? `\n\n## 企業情報（kinbot・kincall・kinXsの記録。詳しくは get_company）\n${biz.map((b) => `- ${b.day} [${b.kind}] ${b.company}：${b.title}${b.body ? ' … ' + b.body.replace(/\n/g, ' ').slice(0, 160) : ''}`).join('\n')}` : '';
    return text((rows.length ? rows.map(unitLine).join('\n') : '該当する記憶はありません。') + bizPart);
  });

  server.registerTool('get_company', {
    title: '企業情報（会社ごとの商談・架電・DOCの状況）',
    description: '顧客企業について、kinbot（商談の要約・商談の動き・資料の閲覧）、kincall（架電の結果とメモ）、kinXs（DOCの契約状況・変更・お客様の声・候補者の質問）から取り込んだ記録と、企業についての記憶を新しい順に返す。'
      + '会社名が話題に出たら、提案・商談準備・フォローの前に使うこと。name を空にすると、最近動きのあった企業の一覧を返す。',
    inputSchema: { name: z.string().optional().describe('会社名（「株式会社」はなくてよい。一部でも可）'), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ name, limit }) => {
    const q = String(name || '').trim();
    const cos = await listCompanies(uid, q);
    if (!q) return text(cos.length ? `# 最近動きのあった企業\n${cos.slice(0, 60).map((c) => `- ${c.company}（${c.n}件・最新 ${String(c.last_at).slice(0, 10)}）：${c.latest}`).join('\n')}` : '企業情報はまだありません。');
    const hit = cos.find((c) => c.key === companyKey(q)) || cos[0];
    if (!hit) return text(`「${q}」の企業情報は見つかりませんでした。`);
    const recs = await companyDetail(uid, hit.key, limit || 60);
    const mem = (await searchUnits(uid, { query: hit.company, limit: 20 })).filter((u) => u.realm === 'company');
    const others = cos.filter((c) => c !== hit).slice(0, 5).map((c) => c.company);
    return text([`# ${hit.company}（記録 ${hit.n}件）`,
      ...recs.map((r) => `## ${r.at_jst} [${r.kind}] ${r.title}${r.people?.length ? `（${r.people.join('、')}）` : ''}\n${r.body}`),
      mem.length ? `\n## 企業についての記憶\n${mem.map(unitLine).join('\n')}` : '',
      others.length ? `\n（ほかに名前が近い企業：${others.join('、')}）` : ''].filter(Boolean).join('\n'));
  });

  // ---- Gemini のスキル（ドライブのドキュメント）と同じものを、コネクタからも読めるようにする（2026-11-22 田中さん「gemini のコネクタでも同じことができるように」）----
  const cap = ai && ai !== 'claude' ? 20000 : 300000;
  const capText = (t, hint) => (t.length > cap ? t.slice(0, cap) + `\n\n（長いので ${cap.toLocaleString()} 字で切りました。${hint}）` : t);
  const pickSection = (t, sec) => {
    if (!sec) return t;
    const parts = t.split(/\n(?=## )/);
    const hit = parts.filter((p) => p.startsWith(`## ${sec}.`));
    return hit.length ? hit.join('\n') : `「${sec}」の見出しが見つかりませんでした。見出し：\n${parts.filter((p) => p.startsWith('## ')).map((p) => p.split('\n')[0]).join('\n')}`;
  };
  server.registerTool('get_sales_report', {
    title: '商談・アポ・架電の分析レポート',
    description: 'knowkin が kinbot・kincall の全件を数えた分析レポート。1 人ごとのまとめ（今月）、2 同（先月）、3 週ごとの初回商談、4 人ごとの今月の案件と判定の理由、5 過去12か月の人×月、6 アポ（今月・先月）、7 架電と稼働（今月・先月・1時間あたり）。件数・率はここの数字をそのまま使う。section に番号を入れるとその節だけ返す（長いときは節ごとに読む）。',
    inputSchema: { section: z.string().optional().describe('節の番号（1〜7）。省略で全部') },
    annotations: { readOnlyHint: true },
  }, async ({ section }) => {
    try { return text(capText(pickSection(await buildReport(uid), section ? String(section).trim() : ''), 'section に節の番号を入れて読んでください')); }
    catch (e) { return { ...text(`レポートを作れませんでした：${e.message}`), isError: true }; }
  });
  server.registerTool('get_meeting_notes', {
    title: '商談の議事録（会社ごと）',
    description: '会社名か題名の一部で、直近90日の商談の議事録（概要・決まったこと・やること・懸念・予算・時期・決める人・次の一手・Salesforce の URL）を新しい順に返す。お礼メール・商談準備・提案資料の材料。お客様の実際の言葉が要るときは get_transcript。',
    inputSchema: { query: z.string().describe('会社名か題名の一部'), limit: z.number().optional().describe('何件まで（既定3）') },
    annotations: { readOnlyHint: true },
  }, async ({ query, limit }) => {
    try {
      const list = (await buildMeetingDocs(uid, 90, String(query || '').trim())).slice(0, Math.max(1, Math.min(10, Number(limit) || 3)));
      if (!list.length) return text(`「${query}」の議事録は見つかりませんでした（直近90日）。`);
      return text(capText(list.map((m) => m.text).join('\n\n---\n\n'), 'limit を小さくしてください'));
    } catch (e) { return { ...text(`議事録を読めませんでした：${e.message}`), isError: true }; }
  });
  server.registerTool('get_proposal_library', {
    title: '提案資料ライブラリ',
    description: 'これまでお客様に送った提案資料（PDF）と登録した Google スライドから数えた、1 ベース（よく使われるページの流れ・変えないページ／会社ごとに変えるページ）、2 よく読まれるページ、3 送った資料のページごとの本文と見られた秒数、4 登録した Google スライド（業界・規模・結果つき）。提案資料を作るときの土台。section に番号を入れるとその節だけ。',
    inputSchema: { section: z.string().optional().describe('節の番号（1〜4）。省略で全部') },
    annotations: { readOnlyHint: true },
  }, async ({ section }) => {
    try { return text(capText(pickSection(await buildProposalLibrary(uid), section ? String(section).trim() : ''), 'section に節の番号を入れて読んでください')); }
    catch (e) { return { ...text(`ライブラリを作れませんでした：${e.message}`), isError: true }; }
  });
  server.registerTool('get_sf_open_deals', {
    title: 'Salesforce の進行中の商談',
    description: 'チームが持っている、まだ閉じていない Salesforce の商談を、人ごと・段階ごとに返す（会社・完了予定日・最終更新日・id）。完了予定日が過ぎたものに「★期限切れ」。SF の更新漏れ探しと、書きかえの依頼（sf_update の id）に使う。who に名前の一部を入れるとその人だけ。',
    inputSchema: { who: z.string().optional().describe('人の名前の一部（例：田中）') },
    annotations: { readOnlyHint: true },
  }, async ({ who }) => {
    try {
      let t = await buildSfOpenDeals(uid);
      if (who) { const parts = t.split(/\n(?=### )/); t = [parts[0], ...parts.slice(1).filter((p) => p.split('\n')[0].includes(String(who).trim()))].join('\n'); }
      return text(capText(t, 'who に人の名前を入れて読んでください'));
    } catch (e) { return { ...text(`SF を読めませんでした：${e.message}`), isError: true }; }
  });
  server.registerTool('get_writing_rules', {
    title: '書き方の決まり（分析・提案資料・お礼メール）',
    description: '分析・提案資料・お礼メールを作る前に読む決まりと完成例。topic：「全体」（どの道具を使うかの案内と、書きかえの依頼の作り方）、「分析」（進め方と完成例）、「提案資料」（作り方）、「お礼メール」（決まり・型・件名や署名・完成例）。',
    inputSchema: { topic: z.enum(['全体', '分析', '提案資料', 'お礼メール']).describe('どの決まりを読むか') },
    annotations: { readOnlyHint: true },
  }, async ({ topic }) => {
    if (topic === '全体') return text(capText('（コネクタで使うときの読みかえ：「kinbot 分析レポート」＝get_sales_report、「議事録 〇〇」＝get_meeting_notes、「文字起こし 〇〇」＝get_transcript、「kinbot 提案資料ライブラリ」＝get_proposal_library、「1 書き方の決まり」＝get_writing_rules、「knowkin 考え方の核」＝get_core、「最近の記録」＝search_memory、「Salesforce 進行中の商談」＝get_sf_open_deals）\n\n' + await skillMain(), ''));
    const parts = await skillRuleParts();
    return text(capText(parts.filter((p) => p.title.startsWith(topic)).map((p) => p.text).join('\n\n') || '見つかりませんでした。', '残りは完成例です'));
  });

  server.registerTool('get_transcript', {
    title: '商談の文字起こし全文',
    description: 'kinbot で録音した商談の文字起こし全文を返す（話者：発言）。会社名か題名の一部で探し、いちばん新しい1件の全文と、ほかの候補の一覧を返す。bot_id を入れるとその商談の全文。'
      + 'お客様が実際に何と言ったか（言い回し・温度感・懸念の言葉）を確かめたいとき、お礼メールや提案で相手の言葉を引きたいとき、要約（get_company）では足りないときに使う。',
    inputSchema: { query: z.string().optional().describe('会社名か題名の一部'), bot_id: z.string().optional().describe('商談の bot_id（候補の一覧に出る）') },
    annotations: { readOnlyHint: true },
  }, async ({ query, bot_id }) => {
    const q = String(query || '').trim(), id = String(bot_id || '').trim();
    if (!q && !id) return text('query（会社名か題名の一部）か bot_id を入れてください。');
    const max = ai && ai !== 'claude' ? 20000 : 300000;
    const list = id ? [] : await findTranscripts(uid, { query: q, limit: 10 });
    const pick = id || (list[0] && list[0].bot_id);
    if (!pick) return text(`「${q}」の文字起こしは見つかりませんでした（取り込みがまだの可能性があります。knowkin の「連携する → kinbot」で取り込み状況を見られます）。`);
    const [t] = await findTranscripts(uid, { botId: pick });
    if (!t) return text(`bot_id「${pick}」の文字起こしは見つかりませんでした。`);
    const body = t.text.length > max ? t.text.slice(0, max) + `\n\n（長いので ${max.toLocaleString()} 字で切りました。全部で ${t.text.length.toLocaleString()} 字）` : t.text;
    return text([`# ${t.title}（${t.at_jst}・${t.company || '会社名なし'}・${(t.people || []).join('、')}）`, `bot_id：${t.bot_id}`,
      list.length > 1 ? `\nほかの候補：\n${list.slice(1).map((x) => `- ${x.at_jst} ${x.title}（bot_id：${x.bot_id}・${Number(x.chars).toLocaleString()}字）`).join('\n')}` : '',
      '\n## 文字起こし', body].filter(Boolean).join('\n'));
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
    title: '記憶に残す（会話の記録）',
    description:
      '本人の発言を記憶（AI履歴）に残す。本人が発言するたびに、返事を書いたあとで本人の言葉をそのまま text に入れて呼ぶ（短い相づちは不要）。「これ覚えておいて」「メモして」「knowkinに残して」と頼まれたときも呼ぶ。'
      + 'text には本人の言葉をなるべくそのまま渡し、units には下のルールで自分で分類した結果を渡す（units を渡すとそのまま分類済みとして保存される）。'
      + '重複を判定したいときは先に get_unclassified_memos の existing か search_memory で既存の記憶を確認する。'
      + `今日は ${todayJST()}。自動で作ったカテゴリの一覧は get_categories で確認できる。\n\n${CLASSIFY_RULES}\n\n${NEW_CATEGORY_RULE}`,
    inputSchema: {
      text: z.string().min(1).describe('残す内容（原本）'),
      units: z.array(unitSchema).optional().describe('自分で分類した記憶ユニット'),
      ref: z.string().max(200).optional().describe('取り込み元の識別子（例 kinbot:meeting:<bot_id>、kincall:daily:2026-09-27）。同じ ref は二重に保存されない'),
      source: z.enum(['claude', 'chatgpt', 'gemini', 'kinbot', 'kincall', 'kinxs', 'sf', 'drive', 'portal']).optional()
        .describe('取り込み元。AIとの会話を残すときは省略（つないでいるAIが自動で入る）。kinbot・kincall・kinxs・sf（Salesforce）・drive（Googleドライブの議事録）は企業情報、portal（社内ポータル）はネオキャリアナレッジに入る'),
    },
  }, async ({ text: t, units, ref, source }) => {
    // 「連携する」のアイコンの差し替え（set_tool_icon が見えないAIのため、add_memo でも受け付ける）。記憶には残さない
    const ti = /^knowkin-tool-icon:(google|claude|gemini|chatgpt|copilot|zoom|kinbot|kincall|kinxs):(data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+)$/.exec(String(t).trim());
    if (ti) {
      await pool.query('INSERT INTO tool_icons(user_id, tool, data) VALUES($1,$2,$3) ON CONFLICT (user_id, tool) DO UPDATE SET data = EXCLUDED.data', [uid, ti[1], ti[2]]);
      return text(`${ti[1]} のアイコンを差し替えました。`);
    }
    // 業務ツールやポータルからの取り込みでなければ、AIとの会話（AI履歴）として、つないでいるAIの名前で残す
    const src = source && (BIZ_SOURCES.includes(source) || source === 'portal') ? source : (ai || source || 'claude');
    const r = await addMemo(uid, t, src, units || null, ref || null);
    if (r.duplicate) return text(`この内容（${ref}）はすでに取り込み済みなので、保存しませんでした。`);
    if (r.error) return text(r.error);
    if (r.pending) return text(`原本をメモ ${r.memo_id} として保存しました（未整理）。units を付けて保存し直すか、get_unclassified_memos → save_units で整理してください。`);
    return text(`${r.added}件の記憶を残しました${r.repeated ? `（${r.repeated}件は既存の記憶と同じ内容だったので重みを上げました）` : ''}。`);
  });

  server.registerTool('get_unclassified_memos', {
    title: '未整理のメモを取得',
    description:
      'Web画面やボイスメモで記録されたまま、まだ分類されていないメモと、重複判定用の既存の記憶、あわせて頼まれている作業（周辺情報の仕分け・引き出し・目的のタスク・再現度テスト・核）を返す。'
      + 'ユーザーが「整理」とだけ言ったとき、または「knowkinを整理して」「knowkinのお手入れをして」「未整理メモを整理して」と頼んだら呼び、各メモを分類して save_units で1メモずつ保存し、返ってきた作業もすべて行うこと。',
    annotations: { readOnlyHint: true },
  }, async () => {
    // 一度に返す量を抑える（Claude以外のAIは大きな結果で止まりやすいので、さらに小さく・写真なし）
    const light = ai && ai !== 'claude';
    const budget = light ? 15000 : 60000;
    const memos = [];
    let used = 0;
    for (const m of await getUnclassified(uid, light ? 8 : 20)) {
      if (memos.length && used + m.text.length > budget) break;
      const room = budget - used;
      memos.push(m.text.length > room ? { ...m, text: m.text.slice(0, room) + '\n（長いので以下省略）' } : m);
      used += Math.min(m.text.length, room);
    }
    const photos = light ? [] : await getUnclassifiedPhotos(uid, 4);
    const reqs = await pendingTaskRequests(uid);
    const up = await upkeepNeeds(uid);
    // kinbot・kincallから前日分を学ぶ（Claudeがkinbot・kincallのコネクタを使える場合）
    const y = new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
    // kinbot から直接取り込んでいるときは、チーム・架電・DOCユーザーの要点はそちらに入るので、本人の商談の振り返りだけ頼む
    const kRefs = kinbotConfig().ready ? [`kinbot:mine:${y}`] : [`kinbot:daily:${y}`, `kinbot:mine:${y}`, `kincall:daily:${y}`, `kinxs:daily:${y}`];
    const kDone = new Set(await importedRefs(uid, kRefs));
    const kTodo = kRefs.filter((r) => !kDone.has(r));
    const kinPart = kTodo.length ? `

## kinbot・kincall・kinXsから学んでください（${y}の分）
それぞれのコネクタが使えるときだけ行う。使えないものは飛ばす。読み取りだけに使い、sf_create・sf_update・update_user・add_task などの書き込み系ツールは絶対に使わない。
顧客企業についての情報は、units の realm を company にし、company に企業名を入れる（企業情報に企業ごとにまとまる）。本人の学び・反省・タスクは realm を self にする。
${kTodo.includes(`kinbot:mine:${y}`) ? `- 自分の商談（ref「kinbot:mine:${y}」）：kinbot の list_meetings や get_deal_events で、${y} に本人（田中欽也）が担当・同席した商談を探し、必要なら get_meeting_detail で中身を読む。相手の懸念・課題・予算・決まったこと・次のアクション（realm は company、company は企業名）と、本人の話し方でうまくいった点・反省点（realm は self）を、add_memo（source は kinbot、ref は上のもの）で記憶にする。本人が当事者の商談だけを対象にし、他の担当者の商談は入れない` : ''}
${kTodo.includes(`kinbot:daily:${y}`) ? `- チームの要点（ref「kinbot:daily:${y}」）：list_deals を from と to に ${y} で呼び、商談の件数・結果ごとの件数・動きのあった案件を1件の event にまとめて add_memo（source は kinbot）。気になる傾向があれば question も作る` : ''}
${kTodo.includes(`kincall:daily:${y}`) ? `- 架電の要点（ref「kincall:daily:${y}」）：kincall の list_call_stats を ${y} で呼び、チームと本人の架電数・接触数・アポ数を1件の event にまとめて add_memo（source は kincall、goal_id は関係する目的）` : ''}
${kTodo.includes(`kinxs:daily:${y}`) ? `- DOCのユーザー（ref「kinxs:daily:${y}」）：kinXs の list_users・list_renewals・list_ai_questions などで、${y} に動きのあった企業（新規・更新・解約の相談・AIへの質問の傾向・納品の状況）を読み、企業ごとの状況を units（realm は company、company は企業名）にして add_memo（source は kinxs）。どの企業にも当てはまる使い方の傾向や、よくある問い合わせは realm を nc にする` : ''}
- その日にデータがない（休日など）ときは、skip_import でその ref を記録する（同じ日を二度調べないため）` : '';
    const upPart = [
      up.relevance ? `\n\n## 周辺情報の仕分けをしてください\n本人との関わりをまだ確かめていない記憶が${up.relevance}件あります。get_units_for_relevance で読み、set_relevance で仕分けてください。` : '',
      up.realm ? `\n\n## 置き場所を決めてください\n自分の脳・企業情報・ネオキャリアナレッジのどこに置くか決まっていない記憶が${up.realm}件あります。get_units_for_realm で読み、set_realm で仕分けてください（一度に150件ずつ。残りは次の整理で）。` : '',
      up.drawers ? `\n\n## 引き出しの整理をしてください\n引き出しが決まっていない記憶が${up.drawers}件あります。get_units_without_drawer で読み、set_drawers で入れてください。` : '',
      up.core ? '\n\n## 核を育ててください\n（メモの整理と上の作業が終わったあと、最後に）get_core_material で材料を読み、本人の考え方の核をまとめ直して save_core で保存してください。' : '',
    ].join('');
    const quizPart = kinPart + upPart + ((await quizNeeded(uid)) ? '\n\n## 再現度テストを作ってください\n採点待ちのテストが3問より少なくなっています。get_quiz_material で材料を読み、「本人ならどう答えるか」を予想するテストを、採点待ちが3問になるように作って add_quiz で入れてください。' : '');
    const reqPart = quizPart + (reqs.length ? `\n\n## タスクづくりを頼まれている目的\n次の目的について、get_goal_context で材料を読み、これまでの知識をもとにタスクを作って add_goal_tasks で入れてください：${reqs.map((r) => `id ${r.id}「${r.title}」`).join('、')}` : '');
    if (!memos.length && !photos.length) return text(reqPart ? `未整理のメモはありません。${reqPart}` : '未整理のメモはありません。');
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
source が claude・chatgpt・gemini などのメモはAIとの会話（AI履歴）です。本人の発言から、決めたこと・理由・気づき・迷い・やると言ったことを拾い、AIの返答の中身は本人が受け入れたものだけ記憶にしてください。
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
${JSON.stringify(existing)}${photoPart}${reqPart}`);
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
  const goals = (await getGoals(uid)).filter((g) => g.status !== 'dropped');
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

  server.registerTool('get_goals', {
    title: '目的と現在地',
    description: 'ユーザー本人の目的（仕事・プライベートで成し遂げたいこと）と、それぞれの道のり・進み具合・現在地を返す。将来やキャリア、何を優先すべきかの相談で使う。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const gt = goalsText(await getGoals(uid));
    return text(gt || '目的はまだありません。');
  });

  server.registerTool('propose_goal', {
    title: '目的の候補を出す',
    description: '本人が話した「成し遂げたいこと・叶えたい未来」を、目的の候補として出す。本人がknowkinで承認するまで目的にはならない。すでにある目的と同じものは出さない。',
    inputSchema: {
      title: z.string().describe('目的の名前（20字以内が目安。例：インターンで月200件のアポ体制を作る）'),
      area: z.enum(['work', 'life']).describe('work=仕事 / life=プライベート'),
      future: z.string().describe('叶えたい未来の姿（本人の言葉に近く、1文）'),
      why: z.string().optional().describe('なぜそうしたいか（話していれば。なければ空）'),
      criteria: z.string().optional().describe('どうなったら叶ったと言えるか（話していれば）'),
      due: z.string().nullable().optional().describe('期限 YYYY-MM-DD（話していれば）'),
      milestones: z.array(z.string()).max(7).optional().describe('目的までの中間地点（道のり）を順番に3〜5個'),
      memo_id: z.number().int().optional().describe('もとになったメモのid'),
    },
  }, async (args) => {
    try { const id = await proposeGoal(uid, args); return text(`目的の候補「${args.title}」（id ${id}）を出しました。本人がknowkinの「見直し」で承認すると目的になります。`); }
    catch (e) { return text(`出せませんでした：${e.message}`); }
  });

  server.registerTool('link_to_goal', {
    title: '記憶を目的につなぐ',
    description: 'すでにある記憶（タスク・判断・教訓など）を、それが近づける目的につなぐ。goal_id に null を入れると外す。',
    inputSchema: { goal_id: z.number().int().nullable(), unit_ids: z.array(z.number().int()).min(1).max(100) },
  }, async ({ goal_id: gid, unit_ids: ids }) => {
    try { return text(`${await linkUnits(uid, gid, ids)}件をつなぎました。`); } catch (e) { return text(`つなげませんでした：${e.message}`); }
  });

  server.registerTool('update_goal', {
    title: '目的を書き換える',
    description: 'ユーザーに頼まれて、目的の名前・叶えたい未来・達成の基準・期限・道のりの名前を変える。頼まれていない変更はしない。',
    inputSchema: {
      goal_id: z.number().int(),
      title: z.string().optional(), future: z.string().optional(), criteria: z.string().optional(),
      status: z.enum(['active', 'paused', 'done']).optional().describe('本人が「達成した」「保留にして」と言ったときだけ変える'),
      due: z.string().nullable().optional().describe('YYYY-MM-DD'),
      milestones: z.array(z.object({ id: z.number().int(), title: z.string() })).optional().describe('名前を変える道のり'),
    },
  }, async ({ goal_id: gid, milestones, ...f }) => {
    try {
      await updateGoal(uid, gid, f);
      for (const m of milestones || []) await renameMilestone(uid, gid, m.id, m.title);
      return text('目的を書き換えました。');
    } catch (e) { return text(`書き換えられませんでした：${e.message}`); }
  });

  server.registerTool('add_milestones', {
    title: '道のりを足す',
    description: 'ユーザーが「道のり」とだけ言ったとき、または「道のりを足して」「道のりを見直して」と頼んだときに使う。先に get_goals と get_goal_context で目的・今の道のり・つながった記憶を読み、これまでの会話や記録で決まったこと・始めたことのうち、道のりに入っていない大事な中間地点を足す。すでに済んでいるものは done を true にする。並びは before_id（その道のりの前に入れる）で指定し、指定しなければ最後の道のり（達成）の前に入る。同じ名前は足さない。足したあとは、何を足したか、なぜそれを足したかを本人に伝える。',
    inputSchema: {
      goal_id: z.number().int(),
      milestones: z.array(z.object({
        title: z.string().describe('道のりの名前（20〜30字くらい。何ができたら済みかがわかる形）'),
        done: z.boolean().optional().describe('記録からすでに済んでいるとわかるとき true'),
        before_id: z.number().int().optional().describe('この道のりの前に入れる'),
      })).min(1).max(6),
    },
  }, async ({ goal_id: gid, milestones }) => {
    try {
      const added = await addMilestones(uid, gid, milestones);
      return text(added.length ? `道のりを${added.length}つ足しました：${added.join('／')}` : '足せる新しい道のりはありませんでした（同じ名前がすでにあります）。');
    } catch (e) { return text(`足せませんでした：${e.message}`); }
  });

  server.registerTool('update_goal_position', {
    title: '目的の現在地を書き直す',
    description: '目的の「現在地」の一言（今どこにいて、次に何が効くか）を書き直す。記録からはっきり済んだとわかる道のりがあれば done にする。',
    inputSchema: {
      goal_id: z.number().int(),
      note: z.string().describe('現在地の一言（2文まで。例：道のりは半分手前。先週の実績は月ペースで150件。次は週ごとのラップを回すことが効きそう）'),
      milestones: z.array(z.object({ id: z.number().int(), done: z.boolean() })).optional().describe('状態を変える道のり'),
    },
  }, async ({ goal_id: gid, note, milestones }) => {
    try { await setGoalNote(uid, gid, note, milestones || []); return text('現在地を書き直しました。'); } catch (e) { return text(`書き直せませんでした：${e.message}`); }
  });

  server.registerTool('get_goal_context', {
    title: '目的からタスクを作る材料',
    description: 'ユーザーが「knowkinの目的からタスクを作って」と頼んだとき、または整理のときにタスクづくりを頼まれている目的があるときに呼ぶ。目的・道のり・つながった記憶・これまでの教訓や判断・今あるタスクを返す。',
    inputSchema: { goal_id: z.number().int() },
    annotations: { readOnlyHint: true },
  }, async ({ goal_id: gid }) => {
    try {
      const c = await goalContext(uid, gid);
      const g = c.goal;
      return text(`# 目的 id ${g.id}「${g.title}」（${g.area === 'life' ? 'プライベート' : '仕事'}${g.due ? `・${g.due}まで` : ''}）進み具合 ${g.progress}%
叶えたい未来：${g.future || '（なし）'}
達成の基準：${g.criteria || '（なし）'}
道のり：${g.milestones.map((m) => `${m.done ? '✓' : m.now ? '▶' : '・'}${m.title}（id ${m.id}）`).join(' → ') || '（なし）'}
現在地：${g.note || '（なし）'}

## 作り方
- これまでの知識（下の教訓・判断・価値観・核）を根拠にして、目的に近づく具体的なタスクを3〜7個作る。一般論ではなく、本人の記録に書かれた事情・人・数字に沿わせる
- なるべく「今ここ」の道のりから順に。1つのタスクは1回で終わる大きさにし、誰と・何を・いつまでにがわかる文にする
- 各タスクに milestone_id（どの道のりのためか）、scope（day / week / month）か due、reason（根拠にした知識を1文で）を付ける
- すでにある未完了のタスクと同じものは作らない
- 記録に書かれていない数字や事実は作らない。必要な数字がわからないときは「〜を決める」「〜を確認する」というタスクにする

## この目的につながっている記憶
${JSON.stringify(c.linked)}

## 本人の核
${JSON.stringify(c.core)}

## これまでの知識（よく出てくる順）
${JSON.stringify(c.knowledge)}

## 今ある未完了のタスク（重複しないように）
${JSON.stringify(c.open)}`);
    } catch (e) { return text(`読めませんでした：${e.message}`); }
  });

  server.registerTool('add_goal_tasks', {
    title: '目的のタスクを入れる',
    description: 'get_goal_context をもとに作ったタスクを、目的につないで「提案」として入れる。本人が「見直し」で確認する。',
    inputSchema: {
      goal_id: z.number().int(),
      tasks: z.array(z.object({
        content: z.string().min(1).describe('タスク（誰と・何を・いつまでにがわかる1文）'),
        milestone_id: z.number().int().optional().describe('どの道のりのためか'),
        milestone_title: z.string().optional(),
        scope: z.enum(['day', 'week', 'month', 'year']).optional(),
        period: z.string().optional(),
        due: z.string().nullable().optional().describe('YYYY-MM-DD'),
        reason: z.string().describe('根拠にした知識（1文）'),
        genre: z.string().max(20).optional(),
      })).min(1).max(10),
    },
  }, async ({ goal_id: gid, tasks }) => {
    try { return text(`${await addGoalTasks(uid, gid, tasks)}件のタスクを「提案」として入れました。本人が見直しで確認します。`); }
    catch (e) { return text(`入れられませんでした：${e.message}`); }
  });

  server.registerTool('get_growth', {
    title: '脳の成長',
    description: 'ユーザーが「成長」とだけ言ったとき、または「knowkinの成長を見せて」「どれくらい脳に近づいた？」と聞いたときに呼ぶ。量・深さ・広さ・再現度と、次に伸ばすためのヒント、採点待ちの再現度テストを返す。結果をわかりやすくまとめて伝えること。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const g = await getGrowth(uid);
    const L = { event: '出来事', know: '知識', think: '思考', act: '行動', rel: '関係' };
    const r = g.repro;
    const lines = [
      `# 脳の成長`,
      `再現度：今月 ${r.month == null ? 'まだ採点なし' : `${r.month}%（${r.month_count}問）`}／これまで ${r.all == null ? '—' : `${r.all}%（${r.all_count}問）`}`,
      `週ごとの再現度（古い順）：${r.weeks.map((w) => (w == null ? '—' : w + '%')).join(' → ')}`,
      `量：${g.total}件（この1週間 +${g.last7}）。8週間の累計の推移：${g.weeks.map((w) => w.total).join(' → ')}`,
      `層のバランス：${Object.entries(g.layers).map(([k, v]) => `${L[k] || k.replace(/^n:/, '')} ${v}`).join('、')}`,
      `深さ：定着した考え（2回以上出てきた教訓・価値観・判断）${g.depth.rooted}個、理由つきの判断 ${g.depth.decisions_with_reason}/${g.depth.decisions}、価値観 ${g.depth.values}件`,
      `広さ：関わる人 ${g.breadth.people}人、引き出し ${g.breadth.genres}個、タスクは仕事 ${g.breadth.work}・プライベート ${g.breadth.life}`,
      '', '## 次に伸ばすには', ...(g.hints.length ? g.hints.map((x) => `- ${x}`) : ['- 特になし']),
      '', '## 採点待ちの再現度テスト', ...(g.quiz_open.length ? g.quiz_open.map((q) => `- Q. ${q.question}（予想：${q.prediction}）`) : ['- なし']),
      '', '## 最近の採点', ...(g.quiz_recent.length ? g.quiz_recent.map((q) => `- ${q.rating === 'great' ? '◎' : q.rating === 'ok' ? '○' : '△'} ${q.question}${q.correction ? `（本人の答え：${q.correction}）` : ''}`) : ['- なし']),
      '', '（周辺の情報は数に含めていない。採点はknowkinの「脳の成長」画面で行う）',
    ];
    return text(lines.join('\n'));
  });

  server.registerTool('get_briefing', {
    title: '相棒ブリーフィング',
    description: '相棒として会話を始めるときに最初に呼ぶ。ユーザーが「相棒」「話そう」「壁打ちしよう」「相談乗って」と言ったときや、相棒用のプロジェクトで会話が始まったときに使う。本人の核・目的と現在地・今日のタスク・最近の出来事・未解決の問いと、最初に投げかける問いの候補を返す。',
    annotations: { readOnlyHint: true },
  }, async () => text(await getBriefing(uid)));

  server.registerTool('get_open_quiz', {
    title: '採点待ちの再現度テスト',
    description: 'ユーザーが「テスト」とだけ言ったとき、または「再現度テストして」「どれくらい自分に近いか試して」と頼んだときに呼ぶ。採点待ちのテストを返すので、1問ずつ質問だけを出し（予想は答えを聞くまで見せない）、本人が答えたら予想と比べて、rate_quiz で本人の答えと採点を保存してから予想を見せること。採点待ちがなければ get_quiz_material と add_quiz で作ってから出題する。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const q = await openQuiz(uid);
    if (!q.length) return text('採点待ちのテストはありません。get_quiz_material で材料を読み、add_quiz で3問作ってから出題してください。');
    return text(`採点待ちのテスト（質問だけを1問ずつ出し、予想は本人が答えるまで見せないこと）\n${JSON.stringify(q)}`);
  });

  server.registerTool('rate_quiz', {
    title: '再現度テストに答える',
    description: 'チャットで出題した再現度テストに本人が答えたら呼ぶ。本人の答えと予想を比べ、rating を great（ほぼ同じ）/ ok（方向は合っているが違いがある）/ miss（違う）で付け、本人の答えを answer に入れる。本人の答えは新しい記録として残り、次の整理で記憶になる。本人が採点を言った場合はそれに従う。',
    inputSchema: {
      id: z.number().int(),
      rating: z.enum(['great', 'ok', 'miss']),
      answer: z.string().describe('本人の答え（なるべく本人の言葉のまま）'),
    },
  }, async ({ id, rating, answer }) => {
    try { await rateQuiz(uid, id, rating, answer); return text('採点を保存しました。本人の答えは次の整理で記憶になります。'); }
    catch (e) { return text(`保存できませんでした：${e.message}`); }
  });

  server.registerTool('get_quiz_material', {
    title: '再現度テストの材料',
    description: 'ユーザーが「knowkinの再現度テストを作って」と頼んだとき、または整理のときにテストづくりを頼まれたときに呼ぶ。本人の核と記憶の一部、過去のテストの結果を返す。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const m = await quizMaterial(uid);
    return text(`本人が実際に出会いそうな場面について「本人ならどう判断・行動するか」を問う質問を3問作り、記録をもとに本人の答えを予想してください。

## 作り方
- 質問は具体的な場面にする（例：「インターンが当日に休みたいと連絡してきた。どう返す？」「決裁者が別にいる商談で、担当者が前向き。次の一手は？」）。仕事とプライベートを混ぜてよい
- 予想は、本人の口調に近い1〜3文で。一般論ではなく、記録に書かれた価値観・判断・教訓に沿わせる
- basis に、予想の根拠にした記憶を短く書く
- 過去のテストと同じ質問は出さない。過去に「違う（miss）」だった分野は、本人の答え（correction）を踏まえてもう一度確かめてよい
- 記録からは予想できないことは質問にしない

## 本人の核
${JSON.stringify(m.core)}

## 記憶（ランダムに50件）
${JSON.stringify(m.knowledge)}

## 過去のテスト
${JSON.stringify(m.past)}`);
  });

  server.registerTool('add_quiz', {
    title: '再現度テストを入れる',
    description: 'get_quiz_material をもとに作った再現度テスト（質問・予想・根拠）を入れる。本人がknowkinの「脳の成長」で採点する。',
    inputSchema: {
      items: z.array(z.object({
        question: z.string().describe('具体的な場面の質問'),
        prediction: z.string().describe('本人ならこう答える、という予想（1〜3文）'),
        basis: z.string().optional().describe('予想の根拠にした記憶'),
      })).min(1).max(5),
    },
  }, async ({ items }) => text(`${await addQuiz(uid, items)}問のテストを入れました。本人が「脳の成長」で採点します。`));

  server.registerTool('get_units_for_relevance', {
    title: '周辺情報の仕分けの材料',
    description: 'ユーザーが「knowkinの周辺情報を仕分けて」「関係ない情報を分けて」と頼んだら呼ぶ。本人との関わりをまだ確かめていない記憶を返すので、本人が当事者か（direct）周辺の情報か（peripheral）を判断して set_relevance で保存すること。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const units = await getUnitsForRelevance(uid);
    if (!units.length) return text('仕分けが必要な記憶はありません。');
    return text(`次の記憶を、本人（田中欽也）との関わりで仕分けて set_relevance で保存してください。
- direct：本人が送り手・受け手・依頼した/された・判断した・学んだ・今後関わる予定がある
- peripheral：本人が関わっていない他の人同士のやり取り、ほかの部署の手続き、名前が一度出ただけで直接やり取りのない人物など
- 迷うものは direct にする（本人に関係ある記憶を隠さないため）

${JSON.stringify(units)}`);
  });

  server.registerTool('set_relevance', {
    title: '周辺情報を仕分ける',
    description: '記憶ごとに、本人が当事者（direct）か周辺の情報（peripheral）かを保存する。peripheral は核・再現度テスト・目的のタスクづくりの材料から外れ、画面では「周辺の情報」にまとまる。',
    inputSchema: { items: z.array(z.object({ id: z.number().int(), relevance: z.enum(['direct', 'peripheral']) })).min(1).max(200) },
  }, async ({ items }) => text(`${await setRelevance(uid, items)}件を仕分けました。`));

  server.registerTool('get_units_for_realm', {
    title: '置き場所が決まっていない記憶',
    description: '自分の脳（self）・企業情報（company）・ネオキャリアナレッジ（nc）のどこに置くか、まだ決まっていない記憶を返す。読んだら set_realm で仕分けること。',
    annotations: { readOnlyHint: true },
  }, async () => {
    const units = await getUnitsForRealm(uid);
    if (!units.length) return text('置き場所が決まっていない記憶はありません。');
    const companies = await getCompanies(uid);
    return text(`次の記憶を、置き場所ごとに仕分けて set_realm で保存してください（全件分を渡す。self のものも渡すと確認済みになる）。
- self：本人の脳。本人の出来事・学び・判断・アイディア・人との関係（迷ったらこれ）
- company：企業情報。顧客企業ごとの情報（商談で聞いた課題・懸念・予算・決まったこと・契約や納品の状況）。company に企業名を入れる
- nc：ネオキャリアナレッジ。会社として共有できる知識（商材の仕様・価格・プラン、社内ルール・手続き、ポータルの案内など）
既存の企業名（同じ書き方を使う）：${companies.length ? companies.map((c) => c.company).join('、') : '（まだありません）'}

${JSON.stringify(units)}`);
  });

  server.registerTool('set_realm', {
    title: '置き場所を決める',
    description: '記憶ごとに、自分の脳（self）・企業情報（company、company に企業名）・ネオキャリアナレッジ（nc）のどこに置くかを保存する。企業情報とナレッジは、核・再現度テスト・脳の成長の材料から外れ、画面ではそれぞれの場所にまとまる。',
    inputSchema: { items: z.array(z.object({ id: z.number().int(), realm: z.enum(['self', 'company', 'nc']), company: z.string().max(60).optional() })).min(1).max(200) },
  }, async ({ items }) => text(`${await setRealm(uid, items)}件の置き場所を決めました。`));

  server.registerTool('set_tool_icon', {
    title: '連携するのアイコンを差し替える',
    description: '本人が用意したアイコン画像（PNG・JPEG・WebP の data URL、128px程度）を、knowkin の「連携する」の各アイコンとして登録する。tool は google / claude / gemini / chatgpt / copilot / zoom / kinbot / kincall / kinxs。本人に頼まれたときだけ使う。',
    inputSchema: { tool: z.enum(['google', 'claude', 'gemini', 'chatgpt', 'copilot', 'zoom', 'kinbot', 'kincall', 'kinxs']), data: z.string().max(300000) },
  }, async ({ tool, data }) => {
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) return { ...text('画像の形式が違います（data:image/png;base64,... の形）'), isError: true };
    await pool.query('INSERT INTO tool_icons(user_id, tool, data) VALUES($1,$2,$3) ON CONFLICT (user_id, tool) DO UPDATE SET data = EXCLUDED.data', [uid, tool, data]);
    return text(`${tool} のアイコンを差し替えました。`);
  });

  server.registerTool('skip_import', {
    title: '取り込むものがなかったことを記録',
    description: 'kinbot・kincallなどから取り込もうとしたが、その日のデータがなかったときに呼ぶ。同じ ref を二度調べないように記録する。',
    inputSchema: { ref: z.string().max(200), note: z.string().max(100).optional() },
  }, async ({ ref, note }) => { await markImported(uid, ref, note || ''); return text(`${ref} を取り込み済みにしました。`); });

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
      'ユーザーが「核」とだけ言ったとき、または「knowkinの核を育てて」「考え方をまとめ直して」と頼んだら呼ぶ。教訓・判断・価値観・人物などの記憶を返すので、'
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
    description: 'タスクを完了・未完了にする、期限・時期（今日・今週・今月・今年・いつか）・仕事/プライベートを変える。ユーザーが「終わった」「今週やる」「期限が変わった」と言ったときに使う。idは get_current_tasks の結果にある。',
    inputSchema: {
      id: z.number().int().describe('タスクのid'),
      done: z.boolean().optional(),
      due: z.string().nullable().optional().describe('新しい期限 YYYY-MM-DD（消すなら null）'),
      area: z.enum(['work', 'life']).optional().describe('仕事 / プライベート'),
      scope: z.enum(['year', 'month', 'week', 'day', 'none']).optional().describe('やる時期を変える（none で「いつか」に戻す）'),
      period: z.string().optional().describe('scope の期間。省略すると今の期間'),
    },
  }, async ({ id, done, due, area, scope, period }) => {
    const f = { done, due, area };
    if (scope) { f.scope = scope === 'none' ? '' : scope; f.period = period; }
    const u = await updateUnit(uid, id, f);
    return text(u ? `更新しました：${unitLine(u)}` : 'そのidのタスクは見つかりませんでした。');
  });

  return server;
}
