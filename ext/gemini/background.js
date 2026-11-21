// 画面（content.js）から受け取ったやりとりを、knowkin の AI履歴に送る。
//   Gemini の画面から直接送ると、ブラウザの決まり（別のサイトへの送信）で止められるので、ここから送る。
//   同じやりとりは knowkin 側が ref で二度入れない。送れなかったものは、あとでもう一度送る
const KNOWKIN = 'https://knowkin-production.up.railway.app';

async function send(m) {
  const { key, enabled = true } = await chrome.storage.local.get(['key', 'enabled']);
  if (!enabled || !key) return false;
  const text = `私：${m.q}\n\nGemini：${m.a.length > 6000 ? m.a.slice(0, 6000) + '…（長いので切りました）' : m.a}\n\n${m.url}`;
  try {
    const r = await fetch(`${KNOWKIN}/api/memos`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ text, source: 'gemini', title: m.title || 'Gemini', ref: m.ref }),
    });
    const ok = r.ok;
    await chrome.storage.local.set({ last: { at: new Date().toLocaleString('ja-JP'), ok, status: r.status, title: m.title } });
    return ok;
  } catch (e) {
    await chrome.storage.local.set({ last: { at: new Date().toLocaleString('ja-JP'), ok: false, status: String(e.message || e) } });
    return false;
  }
}
async function retry() {
  const { queue = [] } = await chrome.storage.local.get('queue');
  if (!queue.length) return;
  const left = [];
  for (const m of queue) if (!(await send(m))) left.push(m);
  await chrome.storage.local.set({ queue: left.slice(-200) });
}
chrome.runtime.onMessage.addListener((m) => {
  if (!m || m.type !== 'turn') return;
  (async () => {
    if (await send(m)) { const { count = 0 } = await chrome.storage.local.get('count'); await chrome.storage.local.set({ count: count + 1 }); return; }
    const { queue = [] } = await chrome.storage.local.get('queue'); queue.push(m); await chrome.storage.local.set({ queue: queue.slice(-200) });
  })();
});
chrome.alarms?.create('retry', { periodInMinutes: 5 });
chrome.alarms?.onAlarm.addListener((a) => { if (a.name === 'retry') retry(); });
