// 連携先（kinbot・kincall・kinXs）の中身を、表（タブごとの行の配列）にして返す。
// 会社アカウントのGeminiはコネクタもスキルの中の通信も使えないので、
// Apps Script でこの表をGoogleスプレッドシートに1時間ごとに書き、スキルに付けて読ませる（2026-11-22 田中さん「geminiでもスキルでコネクタしているのと同じように」）
import { callUpstream } from './upstream.js';
import { kinbotConfig } from './kinbot-sync.js';
import { firstUser } from './auth.js';

const jst = (offsetDays = 0) => new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000);
const ymd = (d) => d.toISOString().slice(0, 10);
// 先月の1日（先月と今月を比べられるように、2か月分を入れる）
const prevMonthStart = () => { const d = jst(); return `${new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10)}`; };
const jstDate = (t) => { const d = new Date(t); return t && !isNaN(d) ? ymd(new Date(d.getTime() + 9 * 3600000)) : ''; };

async function rows(key, tool, args) {
  const r = await callUpstream(key, tool, args, 50_000_000);
  const t = (r.content || []).map((c) => c.text || '').join('\n');
  if (r.isError) throw new Error(t.slice(0, 200));
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j;
    for (const v of Object.values(j || {})) if (Array.isArray(v)) return v;
    return [j];
  } catch { throw new Error(t.slice(0, 200)); }
}
// スプレッドシートの1つのセルは5万字まで。入れ子はJSONにして短く切る
const cellOf = (v, max = 2000) => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) v = v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('\n');
  else if (typeof v === 'object') v = JSON.stringify(v);
  const s = String(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
};
function flat(list, pick) {
  return list.map((r) => { const o = {}; for (const [k, f] of Object.entries(pick)) o[k] = cellOf(typeof f === 'function' ? f(r) : r[f]); return o; });
}

// 項目はそのまま、値だけセルに入る形にする
const plain = (list, max) => list.map((r) => Object.fromEntries(Object.entries(r || {}).map(([k, v]) => [k, cellOf(v, max)])));
const short = (e) => String(e || '').split('@')[0];

export async function buildExportTables(uid, part = 'recent') {
  const owner = await firstUser();
  if (!kinbotConfig().ready || !owner || owner.id !== uid) throw new Error('連携先（kinbot）が設定されていません');
  const from = prevMonthStart(), to = ymd(jst());
  const tabs = {};
  const safe = async (name, fn) => { try { tabs[name] = await fn(); } catch (e) { tabs[name] = [{ エラー: `読めませんでした：${e.message}` }]; } };
  if (part === 'history') return buildHistory(tabs, safe, to);

  await Promise.all([
    safe('商談', async () => flat(await rows('kinbot', 'list_deals', { from, to }), {
      初回商談日: (r) => String(r.first_meeting_date || '').slice(0, 10), 会社: 'company_name', 担当: (r) => short(r.owner), 状態: 'status', 種類: 'deal_kind', チーム: 'team',
      業界: (r) => r.company_profile && r.company_profile.industry, 従業員数: (r) => r.company_profile && r.company_profile.employees, 案件ID: 'deal_id',
    })),
    safe('商談の判定', async () => flat(await rows('kinbot', 'get_deal_events', { from, to }), {
      日: (r) => String(r.event_date || '').slice(0, 10), 会社: 'company_name', 案件の担当: (r) => short(r.owner), 商談した人: (r) => short(r.meeting_owner), 種別: 'event_type', 判定: 'meeting_kind',
      開始時期: (r) => [r.schedule_choice, r.schedule_choice_detail].filter(Boolean).join('：'), 申込の時期: 'apply_timing', 次回あり: 'next_meeting_scheduled', 次回の日: (r) => String(r.next_meeting_date || '').slice(0, 10),
      結果: 'result', 利用開始: (r) => String(r.usage_start_date || '').slice(0, 10), 判定の理由: 'judgment_basis', いまの状態: 'deal_status', 種類: 'deal_kind', 案件ID: 'deal_id',
    })),
    safe('議事録', async () => flat((await rows('kinbot', 'list_meetings', { from, to })).filter((m) => jstDate(m.created_at) >= from), {
      日: (m) => jstDate(m.created_at), 題名: 'title', 担当: 'rep_name', メール: (m) => short(m.owner),
      概要: (m) => m.summary && m.summary.overview, 決まったこと: (m) => m.summary && m.summary.agreements, ポイント: (m) => cellOf(m.summary && m.summary.key_points, 4000),
      やること: (m) => m.summary && m.summary.action_items, お客様の懸念: (m) => m.summary && m.summary.customer_concerns,
      AIの見立て: (m) => m.analysis && m.analysis.deal_status, 見立ての理由: (m) => m.analysis && m.analysis.deal_status_reason, 次の一手: (m) => m.analysis && m.analysis.next_step,
      予算: (m) => m.analysis && m.analysis.bant && m.analysis.bant.budget, 時期: (m) => m.analysis && m.analysis.bant && m.analysis.bant.timeline, 決める人: (m) => m.analysis && m.analysis.bant && m.analysis.bant.authority,
      競合: (m) => m.analysis && m.analysis.competitors, 反論と切り返し: (m) => m.analysis && m.analysis.objections,
      スコア: (m) => m.analysis && m.analysis.scores, 営業の話す割合: (m) => m.metrics && m.metrics.repTalkPct, アポを取った人: 'apo_setter', SF: 'sf_url', bot_id: 'bot_id',
    })),
    safe('アポ', async () => plain(await rows('kincall', 'list_apo_appointments', { from, to }))),
    safe('架電（日×人×結果）', async () => plain(await rows('kincall', 'list_call_stats', { from, to }))),
    safe('稼働時間', async () => plain(await rows('kincall', 'list_work_hours', { from, to: ymd(jst(30)) }))),
    safe('架電リスト', async () => plain(await rows('kincall', 'list_call_lists_overview', {}))),
    safe('導入企業（kinXs）', async () => {
      const all = [];
      for (let off = 0; off < 3000; off += 300) {
        const part = await rows('kinxs', 'export_users', { offset: off, limit: 300 });
        all.push(...part); if (part.length < 300) break;
      }
      return plain(all, 1000);
    }),
    safe('更新予定（kinXs）', async () => plain(await rows('kinxs', 'list_renewals', {}))),
  ]);
  return { updatedAt: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short' }).format(new Date()), from, to, tabs };
}

// ---- 過去1年（1日1回）：明細は軽いものだけ、重いもの（架電・議事録）は月×人にまとめる ----
const monthsBack = (n) => { const d = jst(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1)).toISOString().slice(0, 10); };
const monthOf = (t) => String(t || '').slice(0, 7);
const NOT_DEAL = /カジュアル面談|一次面接|\.mp4|【ユ\/フォ】|【キックオフ】/;

async function buildHistory(tabs, safe, to) {
  const from = monthsBack(11);
  let deals = [], events = [], apo = [];
  await Promise.all([
    safe('商談（過去1年）', async () => { deals = await rows('kinbot', 'list_deals', { from, to }); return flat(deals, {
      初回商談日: (r) => String(r.first_meeting_date || '').slice(0, 10), 会社: 'company_name', 担当: (r) => short(r.owner), 状態: 'status', 種類: 'deal_kind',
      業界: (r) => r.company_profile && r.company_profile.industry, 従業員数: (r) => r.company_profile && r.company_profile.employees, 案件ID: 'deal_id' }); }),
    safe('商談の判定（過去1年）', async () => { events = await rows('kinbot', 'get_deal_events', { from, to }); return flat(events, {
      日: (r) => String(r.event_date || '').slice(0, 10), 会社: 'company_name', 案件の担当: (r) => short(r.owner), 商談した人: (r) => short(r.meeting_owner), 種別: 'event_type', 判定: 'meeting_kind',
      次回あり: 'next_meeting_scheduled', 結果: 'result', 判定の理由: (r) => cellOf(r.judgment_basis, 300), いまの状態: 'deal_status', 案件ID: 'deal_id' }); }),
    safe('アポ（過去1年）', async () => { apo = await rows('kincall', 'list_apo_appointments', { from, to }); return plain(apo); }),
  ]);
  // 架電は日×人×結果だと1年で数万行になるので、月ごとに読んで月×人にまとめる
  await safe('架電（月×人）', async () => {
    const by = new Map();
    for (let i = 11; i >= 0; i--) {
      const f = monthsBack(i), t = i === 0 ? to : ymd(new Date(new Date(monthsBack(i - 1) + 'T00:00:00Z').getTime() - 86400000));
      for (const r of await rows('kincall', 'list_call_stats', { from: f, to: t })) {
        const who = r['かけた人'] || r.caller || '不明', res = String(r['結果'] || r.result || ''), n = Number(r['件数'] || r.count || 0), k = `${f.slice(0, 7)}|${who}`;
        const o = by.get(k) || { 月: f.slice(0, 7), かけた人: who, コール: 0, 接触: 0, アポ: 0, 資料送付: 0, days: new Set() };
        o.コール += n; if (res.startsWith('担当者接触')) o.接触 += n; if (res.includes('アポ獲得')) o.アポ += n; if (res.includes('資料送付')) o.資料送付 += n;
        o.days.add(r['日'] || r.day); by.set(k, o);
      }
    }
    return [...by.values()].map(({ days, ...o }) => ({ ...o, 稼働日: days.size, 接触率: o.コール ? (o.接触 / o.コール * 100).toFixed(1) + '%' : '', アポ率: o.コール ? (o.アポ / o.コール * 100).toFixed(1) + '%' : '' }));
  });
  // 商談・判定・アポを、月×人の数にまとめる（傾向を見るための表）
  await safe('商談（月×人）', async () => {
    const by = new Map();
    const get = (m, who) => { const k = `${m}|${who}`; if (!by.has(k)) by.set(k, { 月: m, 人: who, 初回商談: 0, 受注: 0, 進行中: 0, 再商談実施済み: 0, '失注(未定)': 0, 失注その他: 0, 判定した初回: 0, 次回が決まった初回: 0, 取ったアポ: 0 }); return by.get(k); };
    for (const d of deals) {
      if (NOT_DEAL.test(d.company_name || '')) continue;
      const o = get(monthOf(d.first_meeting_date), short(d.owner)); o.初回商談++;
      const st = String(d.status || '');
      if (st === '受注') o.受注++; else if (st === '進行中') o.進行中++; else if (st.startsWith('再商談')) o.再商談実施済み++; else if (st === '失注(未定)') o['失注(未定)']++; else if (st.startsWith('失注')) o.失注その他++;
    }
    for (const e of events) {
      if (NOT_DEAL.test(e.company_name || '') || e.meeting_kind !== '初回商談') continue;
      const o = get(monthOf(e.event_date), short(e.meeting_owner || e.owner)); o.判定した初回++; if (e.next_meeting_scheduled) o.次回が決まった初回++;
    }
    for (const a of apo) { const t = jstDate(a['取得日']); if (t) get(monthOf(t), a['獲得者'] || '不明').取ったアポ++; }
    return [...by.values()].sort((a, b) => a.月.localeCompare(b.月) || b.初回商談 - a.初回商談).map((o) => ({
      ...o, 受注率: o.初回商談 ? (o.受注 / o.初回商談 * 100).toFixed(1) + '%' : '', 次回設定率: o.判定した初回 ? (o.次回が決まった初回 / o.判定した初回 * 100).toFixed(1) + '%' : '' }));
  });
  return { updatedAt: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short' }).format(new Date()), from, to, tabs };
}
