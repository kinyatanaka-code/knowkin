// 連携先（kinbot・kincall・kinXs）の道具を、knowkin のコネクタからそのまま使えるようにする。
// knowkin につないだAI（Claude・Gemini・ChatGPTなど）は、knowkin だけつなげば、kinbot・kincall・kinXs の記録もその場で調べられる。
// 連携先には KINBOT_URL・KINBOT_TOKEN（kinbot-sync.js と同じ鍵）で、JSON-RPC（MCP）で話しかける。
// 読み取りの道具だけを渡す（Salesforce の更新・kinXs の書き換えなどは、AIから勝手に使われないよう出さない）
import { z } from 'zod';
import { kinbotConfig } from './kinbot-sync.js';

export const UPSTREAMS = [
  { key: 'kinbot', label: 'kinbot', path: '/mcp', about: '商談・案件・録音した商談の要約・Salesforce' },
  { key: 'kincall', label: 'kincall', path: '/kincall/mcp', about: '架電の記録・実績・アポ・架電リスト・稼働時間' },
  { key: 'kinxs', label: 'kinXs', path: '/kinxs/mcp', about: 'DOCの導入企業・更新・タスク・候補者がAIにした質問' },
];
// 書き込み・取り込みの道具は出さない
const DENY = /^(sf_update|sf_create|create_|set_|add_|update_|bulk_|delete_|mochica_miitel_import$|mochica_sf_form$)/;

async function rpc(up, method, params, timeout = 30000) {
  const cfg = kinbotConfig();
  if (!cfg.ready) throw new Error('連携先が設定されていません（KINBOT_URL・KINBOT_TOKEN）');
  const r = await fetch(cfg.url + up.path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params || {} }),
    signal: AbortSignal.timeout(timeout),
  });
  const raw = await r.text();
  // SSE で返ってくる連携先にも合わせる
  const body = raw.trim().startsWith('{') ? raw : (raw.split('\n').find((l) => l.startsWith('data:')) || '').slice(5);
  let j; try { j = JSON.parse(body); } catch { throw new Error(`${up.label} から読めませんでした（${r.status}）`); }
  if (j.error) throw new Error(`${up.label}：${j.error.message || JSON.stringify(j.error)}`);
  if (!r.ok) throw new Error(`${up.label}：${r.status}`);
  return j.result;
}

let cache = { at: 0, list: [] };
/** 連携先ごとの道具の一覧（10分覚えておく）。つながらない連携先は error を入れて返す */
export async function upstreamTools(force = false) {
  if (!kinbotConfig().ready) return [];
  if (!force && Date.now() - cache.at < 10 * 60000) return cache.list;
  const list = await Promise.all(UPSTREAMS.map(async (up) => {
    try {
      const res = await rpc(up, 'tools/list', {}, 15000);
      const tools = (res.tools || []).filter((t) => t && t.name && !DENY.test(t.name) && !(t.annotations && t.annotations.readOnlyHint === false));
      return { ...up, ok: true, tools };
    } catch (e) { return { ...up, ok: false, error: e.message.slice(0, 200), tools: [] }; }
  }));
  cache = { at: Date.now(), list };
  return list;
}

// 連携先の JSON Schema を、knowkin のコネクタの入力（zod）に写す。よく分からない形は「なんでも可」にする
function toZod(prop) {
  if (!prop || typeof prop !== 'object') return z.any();
  const t = Array.isArray(prop.type) ? prop.type.find((x) => x !== 'null') : prop.type;
  let s;
  if (prop.enum && prop.enum.every((v) => typeof v === 'string') && prop.enum.length) s = z.enum(prop.enum);
  else if (t === 'string') s = z.string();
  else if (t === 'number' || t === 'integer') s = z.number();
  else if (t === 'boolean') s = z.boolean();
  else if (t === 'array') s = z.array(prop.items ? toZod(prop.items) : z.any());
  else if (t === 'object') s = z.record(z.any());
  else s = z.any();
  return prop.description ? s.describe(String(prop.description).slice(0, 500)) : s;
}
export function zodShape(schema) {
  const props = (schema && schema.properties) || {};
  const req = new Set((schema && schema.required) || []);
  const shape = {};
  for (const [k, v] of Object.entries(props)) shape[k] = req.has(k) ? toZod(v) : toZod(v).optional();
  return shape;
}

/** 連携先の道具を呼ぶ。結果が長すぎると止まるAIがあるので、max 文字で切る */
export async function callUpstream(key, name, args, max = 60000) {
  const up = UPSTREAMS.find((u) => u.key === key);
  const res = await rpc(up, 'tools/call', { name, arguments: args || {} }, 120000);
  const content = (res.content || []).map((c) => {
    if (c.type !== 'text') return c;
    const t = String(c.text || '');
    return t.length > max ? { type: 'text', text: t.slice(0, max) + `\n\n（長いので ${max.toLocaleString()} 字で切りました。期間や件数をしぼって、もう一度呼んでください）` } : c;
  });
  return { content, ...(res.isError ? { isError: true } : {}) };
}
