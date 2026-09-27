// 年・月・週・日の期間キー（日本時間・週は月曜はじまりのISO週）
const pad = (n) => String(n).padStart(2, '0');
export const SCOPES = ['year', 'month', 'week', 'day'];

function parts(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const [y, m, dd] = f.split('-').map(Number);
  return { y, m, d: dd };
}
function isoWeek(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { wy: t.getUTCFullYear(), w: Math.ceil(((t - y0) / 86400000 + 1) / 7) };
}
export function periodOf(scope, dateStr) {
  const [y, m, d] = (dateStr || '').split('-').map(Number);
  const p = y ? { y, m, d } : parts(new Date());
  if (scope === 'year') return String(p.y);
  if (scope === 'month') return `${p.y}-${pad(p.m)}`;
  if (scope === 'week') { const { wy, w } = isoWeek(p.y, p.m, p.d); return `${wy}-W${pad(w)}`; }
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
export function validPeriod(scope, period) {
  const re = { year: /^\d{4}$/, month: /^\d{4}-\d{2}$/, week: /^\d{4}-W\d{2}$/, day: /^\d{4}-\d{2}-\d{2}$/ }[scope];
  return Boolean(re && re.test(period));
}
/** タスクの時期を決める：指定があればそれ、なければ期限から「日」にする */
export function resolveTiming(r) {
  const scope = SCOPES.includes(r.scope) ? r.scope : '';
  if (scope) return { scope, period: validPeriod(scope, r.period) ? r.period : periodOf(scope, r.due || undefined) };
  if (r.due) return { scope: 'day', period: periodOf('day', r.due) };
  return { scope: '', period: '' };
}
export const scopeLabel = (s, p) => (!s ? 'いつか' : s === 'year' ? `${p}年` : s === 'month' ? `${p.replace('-', '年')}月` : s === 'week' ? `${p.replace('-W', '年第')}週` : p);
