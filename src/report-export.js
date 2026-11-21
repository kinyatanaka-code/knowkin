// kinbot・kincall の中身を、先に計算しておいた「分析レポート」の文章にする。
// 会社のGeminiはスプレッドシートの全部の行を読みきれず、件数や率を数え間違える（2026-11-22 田中さんが試した結果）。
// Claude がコードで数えるのと同じ数字を、ここで先に出しておき、Gemini にはドキュメントとして読ませる。
import { kinbotConfig } from './kinbot-sync.js';
import { pool } from './db.js';
import { firstUser } from './auth.js';
import { rows, short, stageKind, NOT_DEAL, jst, ymd, monthsBack } from './sheet-export.js';

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%（${a}/${b}）` : '-');
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const day = (t) => String(t || '').slice(0, 10);
const weekOf = (d) => { const n = Number(String(d).slice(8, 10)); return n <= 7 ? '1週（1〜7日）' : n <= 14 ? '2週（8〜14日）' : n <= 21 ? '3週（15〜21日）' : '4週（22日〜）'; };
const table = (head, body) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');

// 1か月分の数字を、人ごとにまとめる
function perPerson(deals, events) {
  const by = new Map();
  const get = (p) => { if (!by.has(p)) by.set(p, { 初回: 0, 受注: 0, 進行中: 0, 失注: 0, SF未連携: 0, 判定初回: 0, 次回あり: 0, 明確: 0, 未定: 0, 不明: 0, 再商談: 0, 再受注: 0, 再未確定: 0, 再失注: 0, 再延期: 0 }); return by.get(p); };
  for (const d of deals) { const o = get(short(d.owner)); o.初回++; o[stageKind(d)]++; }
  for (const e of events) {
    const o = get(short(e.owner));
    if (e.meeting_kind === '初回商談') {
      o.判定初回++; if (e.next_meeting_scheduled) o.次回あり++;
      const sc = String(e.schedule_choice || ''); if (sc === '未定') o.未定++; else if (!sc || sc === '不明') o.不明++; else o.明確++;
    } else if (e.meeting_kind === '再商談') {
      o.再商談++; const r = String(e.result || ''); if (r === '受注') o.再受注++; else if (r === '失注') o.再失注++; else if (r === '延期') o.再延期++; else o.再未確定++;
    }
  }
  return [...by.entries()].sort((a, b) => b[1].初回 - a[1].初回);
}
function summaryTable(list) {
  return table(['人', '初回商談', 'SF 受注', 'SF 進行中', 'SF 失注', 'SF未連携', '初回で次回が決まった率', '開始時期 明確／未定／聞けていない', '再商談', '再商談の結果 受注／未確定／失注／延期'],
    list.map(([p, o]) => [p, o.初回, o.受注, o.進行中, o.失注, o.SF未連携, pct(o.次回あり, o.判定初回), `${o.明確}／${o.未定}／${o.不明}`, o.再商談, `${o.再受注}／${o.再未確定}／${o.再失注}／${o.再延期}`]));
}

export async function buildReport(uid) {
  const owner = await firstUser();
  if (!kinbotConfig().ready || !owner || owner.id !== uid) throw new Error('連携先（kinbot）が設定されていません');
  const thisFrom = monthsBack(0), lastFrom = monthsBack(1), to = ymd(jst());
  const lastTo = ymd(new Date(new Date(thisFrom + 'T00:00:00Z').getTime() - 86400000));
  // アポ・架電・稼働は、今月と先月の両方（先月と比べる分析ができるように。2026-11-22 Gemini が「先月の架電が無い」と答えたため）
  const [dealsAll, eventsAll, apo, calls, apoL, callsL, hours, hoursL] = await Promise.all([
    rows('kinbot', 'list_deals', { from: lastFrom, to }),
    rows('kinbot', 'get_deal_events', { from: lastFrom, to }),
    rows('kincall', 'list_apo_appointments', { from: thisFrom, to }).catch(() => []),
    rows('kincall', 'list_call_stats', { from: thisFrom, to }).catch(() => []),
    rows('kincall', 'list_apo_appointments', { from: lastFrom, to: lastTo }).catch(() => []),
    rows('kincall', 'list_call_stats', { from: lastFrom, to: lastTo }).catch(() => []),
    rows('kincall', 'list_work_hours', { from: thisFrom, to }).catch(() => []),
    rows('kincall', 'list_work_hours', { from: lastFrom, to: lastTo }).catch(() => []),
  ]);
  const deals = dealsAll.filter((d) => !NOT_DEAL.test(d.company_name || ''));
  const events = eventsAll.filter((e) => !NOT_DEAL.test(e.company_name || ''));
  const inM = (t, f, tt) => day(t) >= f && day(t) <= tt;
  const dThis = deals.filter((d) => inM(d.first_meeting_date, thisFrom, to)), dLast = deals.filter((d) => inM(d.first_meeting_date, lastFrom, lastTo));
  const eThis = events.filter((e) => inM(e.event_date, thisFrom, to)), eLast = events.filter((e) => inM(e.event_date, lastFrom, lastTo));
  const out = [];
  const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  out.push(`# kinbot 分析レポート（自動・編集しない）`, '', `最終更新：${now}　今月：${thisFrom}〜${to}　先月：${lastFrom}〜${lastTo}`, '',
    'この数字は knowkin がすべての行を数えて出したもの。件数・率はここの数字をそのまま使う（自分で数え直さない）。',
    '- 初回商談＝その月に初回商談をした案件（採用の面接の録音・【ユ/フォ】・【キックオフ】は外してある）',
    '- SF 受注／進行中／失注＝その案件の、いまの Salesforce の商談の段階（08＝受注、99＝失注、それ以外＝進行中、SF の商談に結びついていない＝SF未連携）',
    '- 初回で次回が決まった率＝初回商談の判定で「次回の商談が決まった」の割合',
    '- 開始時期＝初回商談で、お客様の利用開始の時期が「明確／未定／聞けていない（話に出なかった）」',
    '- 再商談の結果＝その月にした再商談の判定（受注・未確定・失注・延期）', '');
  out.push('## 1. 人ごとのまとめ（今月）', '', summaryTable(perPerson(dThis, eThis)), '');
  out.push('## 2. 人ごとのまとめ（先月）', '', summaryTable(perPerson(dLast, eLast)), '');
  // 週ごとの初回商談の数
  const weeks = ['1週（1〜7日）', '2週（8〜14日）', '3週（15〜21日）', '4週（22日〜）'];
  const wk = new Map(); for (const d of dThis) { const p = short(d.owner); if (!wk.has(p)) wk.set(p, Object.fromEntries(weeks.map((w) => [w, 0]))); wk.get(p)[weekOf(day(d.first_meeting_date))]++; }
  out.push('## 3. 週ごとの初回商談の数（今月）', '', table(['人', ...weeks], [...wk.entries()].map(([p, o]) => [p, ...weeks.map((w) => o[w])])), '');
  // 人ごとの案件の一覧（今月）：案件ごとに、初回・再商談の判定を1行にまとめる
  const evBy = new Map(); for (const e of events) { if (!evBy.has(e.deal_id)) evBy.set(e.deal_id, []); evBy.get(e.deal_id).push(e); }
  out.push('## 4. 人ごとの案件（今月の初回商談）', '', '形：初回商談日 会社｜SF の段階｜判定（次回の有無・開始時期・再商談の結果）｜判定の理由', '');
  const people = [...new Set(dThis.map((d) => short(d.owner)))];
  for (const p of people) {
    const ds = dThis.filter((d) => short(d.owner) === p).sort((a, b) => day(a.first_meeting_date).localeCompare(day(b.first_meeting_date)));
    out.push(`### ${p}（${ds.length}件）`, '');
    for (const d of ds) {
      const es = (evBy.get(d.deal_id) || []).sort((a, b) => day(a.event_date).localeCompare(day(b.event_date)));
      const js = es.map((e) => e.meeting_kind === '初回商談' ? `初回：次回${e.next_meeting_scheduled ? `あり${e.next_meeting_date ? `（${day(e.next_meeting_date)}）` : ''}` : 'なし'}・開始時期 ${e.schedule_choice_detail || e.schedule_choice || '聞けていない'}`
        : e.meeting_kind === '再商談' ? `再商談 ${day(e.event_date)}：${e.result || '未確定'}` : '').filter(Boolean).join('／');
      const why = es.length ? cut(es[es.length - 1].judgment_basis, 70) : '';
      out.push(`- ${day(d.first_meeting_date)} ${cut(d.company_name, 30)}｜${d.sf_stage || 'SF未連携'}｜${js || '判定なし'}｜${why}`);
    }
    out.push('');
  }
  // 過去12か月の移り変わり（人×月）。スプレッドシートは Gemini が読みきれないので、ここに数だけ載せる
  try {
    const hFrom = monthsBack(11);
    const [hd, he] = await Promise.all([rows('kinbot', 'list_deals', { from: hFrom, to }), rows('kinbot', 'get_deal_events', { from: hFrom, to })]);
    const mo = (t) => String(t || '').slice(0, 7);
    const by = new Map(); const g = (m, p) => { const k = `${m}|${p}`; if (!by.has(k)) by.set(k, { m, p, n: 0, win: 0, lost: 0, j: 0, nx: 0 }); return by.get(k); };
    for (const d of hd) { if (NOT_DEAL.test(d.company_name || '')) continue; const o = g(mo(d.first_meeting_date), short(d.owner)); o.n++; const k = stageKind(d); if (k === '受注') o.win++; if (k === '失注') o.lost++; }
    for (const e of he) { if (NOT_DEAL.test(e.company_name || '') || e.meeting_kind !== '初回商談') continue; const o = g(mo(e.event_date), short(e.owner)); o.j++; if (e.next_meeting_scheduled) o.nx++; }
    const rowsH = [...by.values()].filter((o) => o.n || o.j).sort((a, b) => a.p.localeCompare(b.p) || a.m.localeCompare(b.m));
    out.push('## 5. 過去12か月の移り変わり（人×月）', '', '受注・失注は、その月に初回商談をした案件の、いまの SF の段階。', '',
      table(['人', '月', '初回商談', 'SF 受注', 'SF 失注', '初回で次回が決まった率'], rowsH.map((o) => [o.p, o.m, o.n, o.win, o.lost, pct(o.nx, o.j)])), '');
  } catch (e) { out.push('## 5. 過去12か月の移り変わり', '', `読めませんでした：${e.message}`, ''); }
  // アポ（今月・先月）
  const cnt = (list, k) => { const m = new Map(); for (const r of list) { const v = r[k] || '不明'; m.set(v, (m.get(v) || 0) + 1); } return m; };
  const aThis = cnt(apo, '獲得者'), aLast = cnt(apoL, '獲得者'), cThis = cnt(apo, '現担当'), cLast = cnt(apoL, '現担当');
  const both = (a, b) => [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => (a.get(y) || 0) - (a.get(x) || 0) || (b.get(y) || 0) - (b.get(x) || 0));
  out.push('## 6. アポ（取った日で数える）', '', `今月 ${apo.length} 件・先月 ${apoL.length} 件`, '',
    table(['取った人', '今月', '先月'], both(aThis, aLast).map((w) => [w, aThis.get(w) || 0, aLast.get(w) || 0])), '',
    table(['商談する人（現担当）', '今月', '先月'], both(cThis, cLast).map((w) => [w, cThis.get(w) || 0, cLast.get(w) || 0])), '');
  // 架電と稼働（人×月）：コール・接触・アポを、稼働時間（出勤管理の実績）とあわせて
  const nm = (x) => String(x || '').normalize('NFKC').replace(/[\s　]/g, '');
  const callBy = (list) => { const m = new Map(); for (const r of list) {
    const w = r['かけた人'] || r.caller || '不明', res = String(r['結果'] || r.result || ''), n = Number(r['件数'] || r.count || 0);
    const o = m.get(nm(w)) || { w, c: 0, t: 0, a: 0, d: 0, days: new Set() }; o.c += n; if (res.startsWith('担当者接触')) o.t += n; if (res.includes('アポ獲得')) o.a += n; if (res.includes('資料送付')) o.d += n; o.days.add(r['日'] || r.day); m.set(nm(w), o); } return m; };
  const hourBy = (list) => new Map(list.map((h) => [nm(h['人']), { plan: Number(h['予定時間の合計'] || 0), real: Number(h['実績時間の合計'] || 0) }]));
  const per = (a, h) => (h ? (Math.round((a / h) * 10) / 10).toString() : '-');
  const callRows = (cm, hm) => [...cm.values()].sort((a, b) => b.a - a.a || b.c - a.c).map((o) => { const h = hm.get(nm(o.w)) || { plan: 0, real: 0 };
    return [o.w, o.days.size, h.real || '-', o.c, pct(o.t, o.c), o.a, pct(o.a, o.c), per(o.c, h.real), per(o.a, h.real), o.d]; });
  const head = ['かけた人', '架電した日', '稼働時間（実績）', 'コール', '担当者接触率', 'アポ', 'アポ率（コール比）', '1時間あたりコール', '1時間あたりアポ', '資料送付'];
  out.push('## 7. 架電と稼働（人ごと）', '', '稼働時間＝出勤管理の計算と同じ実働時間（その日の最初〜最後の架電。架電以外の作業は入らない）。', '',
    '### 今月', '', table(head, callRows(callBy(calls), hourBy(hours))), '', '### 先月', '', table(head, callRows(callBy(callsL), hourBy(hoursL))), '');
  return out.join('\n');
}

// 議事録を1件ずつの文章にして返す（Apps Script が1件1ドキュメントにしてドライブに置き、Gemini が会社名で探して読む）。
// Gemini は大きなスプレッドシートから1件を探し出せず、お礼メールが議事録なしの一般的な文になっていたため（2026-11-22）
const lines = (v) => (Array.isArray(v) ? v.map((x) => `・${typeof x === 'object' ? JSON.stringify(x) : x}`).join('\n') : v ? String(v) : '');
export async function buildMeetingDocs(uid, days = 60) {
  const owner = await firstUser();
  if (!kinbotConfig().ready || !owner || owner.id !== uid) throw new Error('連携先（kinbot）が設定されていません');
  const from = ymd(jst(-days));
  const list = await rows('kinbot', 'list_meetings', { from });
  // 文字起こし全文（knowkin に取り込み済みのもの）も、議事録のあとに付ける（お客様の実際の言葉を Gemini も読めるように）
  const ids = list.map((m) => m.bot_id).filter(Boolean);
  const tr = new Map((await pool.query('SELECT bot_id, text FROM biz_transcripts WHERE user_id = $1 AND bot_id = ANY($2)', [uid, ids]).catch(() => ({ rows: [] }))).rows.map((r) => [r.bot_id, r.text]));
  return list.filter((m) => m.bot_id && m.summary).map((m) => {
    const s = m.summary || {}, a = m.analysis || {}, b = a.bant || {};
    const date = ymd(new Date(new Date(m.created_at).getTime() + 9 * 3600000));
    const sec = (h, v) => { const t = lines(v); return t ? `■ ${h}\n${t}` : ''; };
    const text = [`kinbot 議事録：${m.title}`, `商談日：${date}　担当：${m.rep_name || m.owner_name || short(m.owner)}（${short(m.owner)}）`, m.sf_url ? `Salesforce：${m.sf_url}` : '', m.drive_link ? `録画：${m.drive_link}` : '',
      sec('概要', s.overview), sec('決まったこと', s.agreements), sec('ポイント（担当者・採用・予算・決裁・懸念など）', s.key_points), sec('それぞれがやること', s.action_items), sec('お客様の懸念', s.customer_concerns),
      sec('ニーズ', a.needs), sec('予算', b.budget), sec('時期', b.timeline), sec('決める人', b.authority), sec('競合', a.competitors), sec('反論と切り返し', a.objections), sec('前向きなサイン', a.buying_signals),
      sec('お客様の反応', a.customer_reactions), sec('AI の見立て', a.deal_status ? `${a.deal_status}：${a.deal_status_reason || ''}` : ''), sec('次の一手', a.next_step)].filter(Boolean).join('\n\n');
    // 文字起こしは別のドキュメントにする（Gemini は必要なときだけ開くので、議事録を小さく保つほうが読み落としが少ない）
    const t = tr.get(m.bot_id) || '';
    const tx = t ? `kinbot 文字起こし：${m.title}\n商談日：${date}\n（話者：発言。自動の文字起こしなので、社名・人名は誤変換に注意）\n\n${t.slice(0, 150000)}${t.length > 150000 ? '\n\n（長いので15万字まで）' : ''}` : '';
    // 文字起こしがあとから取り込まれたときもドキュメントを書き直すよう、印に長さを混ぜる
    return { id: m.bot_id, title: m.title, date, rep: m.rep_name || short(m.owner), updated: `${m.updated_at || m.created_at}#${t.length}`,
      text: t ? `${text}\n\n（文字起こしの全文は、ドキュメント「文字起こし ${m.title} ${date}」にある）` : text, transcript: tx };
  });
}

// ---- 提案資料ライブラリ（2026-11-22 田中さん「作った資料を徐々に蓄積して、ベースを作るようにしてほしい」）----
//   kinbot の get_proposal_library（送った PDF の提案資料のページごとの本文と見られた秒数、登録した Google スライド）から、
//   「よく使われるページの流れ（ベース）」「変えないページ／会社ごとに変えるページ」「よく読まれるページ」を数えて出す。
//   資料が増えるほど、ベースが自動で育つ。AI は使わない
// ページの見出し：本文の書き出し14字。会社名は〇〇に、数字は#にそろえて、別の会社の資料でも同じページだと分かるようにする
const normTitle = (t, names = []) => {
  let x = String(t || '').normalize('NFKC');
  for (const n of names) if (n && n.length >= 2) x = x.split(n).join('〇〇');
  x = x.replace(/(株式会社|有限会社|合同会社|社会福祉法人|医療法人社団|医療法人|学校法人)\s*[^\s様御の、。]{1,15}/g, '〇〇')
    .replace(/^\d+\s*/, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return x.slice(0, 14);
};
export async function buildProposalLibrary(uid) {
  const owner = await firstUser();
  if (!kinbotConfig().ready || !owner || owner.id !== uid) throw new Error('連携先（kinbot）が設定されていません');
  let lib = { slides: [], sent: [] };
  const r = await callUpstreamJson('get_proposal_library', { limit: 60 });
  if (r) lib = r;
  const sent = (lib.sent || []).filter((d) => (d.pages || []).length);
  const out = [];
  const now = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  out.push('# kinbot 提案資料ライブラリ（自動・編集しない）', '', `最終更新：${now}　送った提案資料（PDF）${sent.length}件・登録した Google スライド ${(lib.slides || []).length}件`, '',
    'kinbot にたまった提案資料から、knowkin が数えて作ったもの。資料が増えるほどベースが育つ。新しい提案資料は「1. ベース」の流れに沿って作り、会社ごとに変えるページだけを議事録から作る。', '');
  // 1. ベース：ページの見出し（本文の書き出し）が何件の資料に出てくるか、何ページ目あたりか、中身が毎回同じか
  const by = new Map();
  for (const d of sent) {
    const seen = new Set();
    const names = [...String(d.companies || '').split('・'), String(d.name || '').replace(/【[^】]*】/g, '').replace(/(御中|様|ご?提案資料|御提案資料|\.pdf|\.pptx)/g, '').trim()].map((x) => x.normalize('NFKC').trim()).filter(Boolean);
    d.pages.forEach((p) => {
      const k = normTitle(p.text, names); if (!k || k.length < 3 || seen.has(k)) return; seen.add(k);
      const o = by.get(k) || { k, n: 0, pos: [], texts: new Set(), sec: 0, sample: p.text };
      o.n++; o.pos.push(p.page / d.pages.length); o.texts.add(String(p.text).normalize('NFKC').replace(/\s+/g, '')); o.sec += p.seconds || 0; by.set(k, o);
    });
  }
  const minN = Math.max(2, Math.ceil(sent.length * 0.3));
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };
  const base = [...by.values()].filter((o) => o.n >= minN).sort((a, b) => med(a.pos) - med(b.pos));
  out.push('## 1. ベース（よく使われるページの流れ）', '', sent.length < 2 ? '送った提案資料がまだ少ないので、ベースはまだ作れない（2件以上で作り始める）。' :
    `送った提案資料の3割以上（${minN}件以上）に出てくるページを、資料の中の位置の順に並べたもの。「変えない」＝どの資料でもほぼ同じ中身、「会社ごと」＝資料ごとに中身が変わる。`, '');
  if (base.length) out.push(table(['順', 'ページ（書き出し）', '使われた資料', '中身', '見られた秒数（合計）', '例'],
    base.map((o, i) => [i + 1, o.k, `${o.n}/${sent.length}`, o.texts.size / o.n <= 0.35 ? '変えない' : '会社ごと', o.sec, cut(o.sample, 60)])), '');
  // 2. よく読まれるページ（1つの資料あたりの秒数が長い順）
  const read = [...by.values()].filter((o) => o.n >= 2 && o.sec > 0).map((o) => ({ ...o, avg: Math.round(o.sec / o.n) })).sort((a, b) => b.avg - a.avg).slice(0, 12);
  out.push('## 2. よく読まれるページ（お客様が長く見たページ）', '', read.length ? table(['ページ（書き出し）', '資料1件あたりの秒数', '使われた資料'], read.map((o) => [o.k, o.avg, o.n])) : 'まだ数えられるほど閲覧がない。', '');
  // 3. 送った提案資料（新しい順）
  out.push('## 3. 送った提案資料（新しい順）', '');
  for (const d of sent.slice(0, 15)) {
    out.push(`### ${d.name}（${d.day}・${d.companies || '送り先なし'}・閲覧${d.views}回）`);
    for (const p of d.pages.slice(0, 25)) out.push(`- p${p.page}${p.seconds ? `（${p.seconds}秒）` : ''}：${cut(p.text, 90)}`);
    out.push('');
  }
  // 4. 登録した Google スライド（結果つき）
  out.push('## 4. 商談に登録した Google スライド（新しい順）', '');
  for (const s of (lib.slides || []).slice(0, 15)) {
    out.push(`### ${s.filename || '提案資料'}（${s.day}・${s.company_name || '会社名なし'}${s.industry ? `・${s.industry}` : ''}${s.employee_size ? `・${s.employee_size}` : ''}${s.result ? `・結果：${s.result}` : ''}）`,
      s.slide_url ? `URL：${s.slide_url}` : '', s.summary ? `要約：${cut(s.summary, 200)}` : '', cut(s.extracted_text, 700), '');
  }
  if (!(lib.slides || []).length) out.push('まだ登録がない（kinbot の案件の画面で、提案に使った Google スライドを登録するとここに増える）。', '');
  return out.join('\n');
}
async function callUpstreamJson(tool, args) {
  const { callUpstream } = await import('./upstream.js');
  const r = await callUpstream('kinbot', tool, args, 50_000_000);
  const t = (r.content || []).map((c) => c.text || '').join('\n');
  try { return JSON.parse(t); } catch { return null; }
}
