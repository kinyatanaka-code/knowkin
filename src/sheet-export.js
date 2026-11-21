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
const jstDate = (t) => (t ? ymd(new Date(new Date(t).getTime() + 9 * 3600000)) : '');

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

export async function buildExportTables(uid) {
  const owner = await firstUser();
  if (!kinbotConfig().ready || !owner || owner.id !== uid) throw new Error('連携先（kinbot）が設定されていません');
  const from = prevMonthStart(), to = ymd(jst());
  const tabs = {};
  const safe = async (name, fn) => { try { tabs[name] = await fn(); } catch (e) { tabs[name] = [{ エラー: `読めませんでした：${e.message}` }]; } };

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
      次のアクション: (m) => m.summary && (m.summary.next_actions || m.summary.todos), bot_id: 'bot_id',
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
