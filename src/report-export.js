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
  const [dealsAll, eventsAll, apo, calls] = await Promise.all([
    rows('kinbot', 'list_deals', { from: lastFrom, to }),
    rows('kinbot', 'get_deal_events', { from: lastFrom, to }),
    rows('kincall', 'list_apo_appointments', { from: thisFrom, to }).catch(() => []),
    rows('kincall', 'list_call_stats', { from: thisFrom, to }).catch(() => []),
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
  // アポ（今月）
  const cnt = (list, k) => { const m = new Map(); for (const r of list) { const v = r[k] || '不明'; m.set(v, (m.get(v) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  out.push('## 6. アポ（今月取ったもの）', '', `全部で ${apo.length} 件`, '', table(['取った人', '件数'], cnt(apo, '獲得者')), '', table(['商談する人（現担当）', '件数'], cnt(apo, '現担当')), '');
  // 架電（今月・人ごと）
  const cb = new Map();
  for (const r of calls) {
    const w = r['かけた人'] || r.caller || '不明', res = String(r['結果'] || r.result || ''), n = Number(r['件数'] || r.count || 0);
    const o = cb.get(w) || { c: 0, t: 0, a: 0, days: new Set() }; o.c += n; if (res.startsWith('担当者接触')) o.t += n; if (res.includes('アポ獲得')) o.a += n; o.days.add(r['日'] || r.day); cb.set(w, o);
  }
  out.push('## 7. 架電（今月・人ごと）', '', table(['かけた人', '稼働日', 'コール', '担当者接触率', 'アポ', 'アポ率（コール比）'],
    [...cb.entries()].sort((a, b) => b[1].a - a[1].a).map(([w, o]) => [w, o.days.size, o.c, pct(o.t, o.c), o.a, pct(o.a, o.c)])), '');
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
