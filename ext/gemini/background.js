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
  if (m && m.type === 'sweep-list') { if (sweeping) sweeping.ids = m.ids || []; return; }
  if (m && m.type === 'sweep-now') { sweep(); return; }
  if (m && m.type === 'organize-now') { organize(); return; }
  if (m && m.type === 'organize-ready') { if (organizing) organizing.ready = true; return; }
  if (m && m.type === 'organize-answer') { if (organizing) organizing.answer = m; return; }
  if (!m || m.type !== 'turn') return;
  (async () => {
    if (await send(m)) { const { count = 0 } = await chrome.storage.local.get('count'); await chrome.storage.local.set({ count: count + 1 }); return; }
    const { queue = [] } = await chrome.storage.local.get('queue'); queue.push(m); await chrome.storage.local.set({ queue: queue.slice(-200) });
  })();
});
chrome.alarms?.create('retry', { periodInMinutes: 5 });
chrome.alarms?.create('sweep', { periodInMinutes: 30, delayInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((a) => { if (a.name === 'retry') retry(); if (a.name === 'sweep') sweep(); });

// ---- スマホの会話も拾う：30分ごとに、裏のタブで Gemini の一覧を開き、最近の会話を1つずつ開いて読む ----
//   パソコンの Chrome が開いている間だけ動く。読んだやりとりは knowkin が ref で二度入れない
let sweeping = null;
// 待っている間に裏の係が眠らないよう、1秒ごとに軽い呼び出しをはさむ（Chrome は30秒なにもしないと係を止めるため）
const wait = async (ms) => { for (let t = 0; t < ms; t += 1000) { await new Promise((r) => setTimeout(r, Math.min(1000, ms - t))); await chrome.runtime.getPlatformInfo(); } };
async function sweep() {
  const { key, enabled = true, mobile = true } = await chrome.storage.local.get(['key', 'enabled', 'mobile']);
  if (!key || !enabled || !mobile || sweeping || organizing) return;
  sweeping = { tab: null, ids: null };
  try {
    const tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app?knowkin_sweep=1', active: false, pinned: true });
    sweeping.tab = tab.id;
    for (let i = 0; i < 30 && !sweeping.ids; i++) await wait(1000);   // 一覧のIDが返ってくるのを待つ
    const ids = sweeping.ids || [];
    for (const id of ids) {
      await chrome.tabs.update(tab.id, { url: `https://gemini.google.com/app/${id}` });
      await wait(15000);   // 開いて、答えが読みこまれ、5秒変わらないのを確かめて送るまで
    }
    await chrome.storage.local.set({ lastSweep: { at: new Date().toLocaleString('ja-JP'), n: ids.length } });
  } catch (e) {
    await chrome.storage.local.set({ lastSweep: { at: new Date().toLocaleString('ja-JP'), n: 0, err: String(e.message || e) } });
  } finally {
    if (sweeping && sweeping.tab) chrome.tabs.remove(sweeping.tab).catch(() => {});
    sweeping = null;
  }
}

// ---- 自分で新しい版に入れ替わる（2026-11-22 田中さん「入れ直すのめんどくさいから GitHub で連携できるように」）----
//   パソコンの更新係（knowkin-gemini-autoupdate.cmd で入れる。15分ごと）が、GitHub の最新をこのフォルダに上書きする。
//   ここでは10分ごとにフォルダの manifest.json の版を見て、いま動いている版と違えば読み込み直す（スマホの会話を拾っている最中はやめる）
async function selfUpdate() {
  try {
    if (sweeping) return;
    const m = await (await fetch(chrome.runtime.getURL('manifest.json') + '?t=' + Date.now(), { cache: 'no-store' })).json();
    const run = chrome.runtime.getManifest().version;
    if (m && m.version && m.version !== run) { await chrome.storage.local.set({ selfUpdated: { from: run, to: m.version, at: new Date().toLocaleString('ja-JP') } }); chrome.runtime.reload(); }
  } catch {}
}
chrome.alarms?.create('self-update', { periodInMinutes: 10, delayInMinutes: 3 });
chrome.alarms?.onAlarm.addListener((a) => { if (a.name === 'self-update') selfUpdate(); });

// ---- Gemini に knowkin の整理をさせる：1時間ごと（2026-11-22 田中さん「1時間に1回、Gemini に整理させたい」）----
//   ① knowkin から頼みごと（整理の決まり＋未整理メモ）をもらう ② 裏のタブで Gemini を開いて貼って送る
//   ③ Gemini の答え（JSON）を knowkin に返して保存してもらう。Gemini の API は使わない。パソコンの Chrome が開いている間だけ動く
let organizing = null;
async function organize() {
  const { key, organizeOn = true } = await chrome.storage.local.get(['key', 'organizeOn']);
  if (!key || !organizeOn || organizing || sweeping) return;
  organizing = { tab: null, ready: false, answer: null };
  const done = async (r) => { await chrome.storage.local.set({ lastOrganize: { at: new Date().toLocaleString('ja-JP'), ...r } }); };
  try {
    const b = await (await fetch(`${KNOWKIN}/api/organize/batch`, { headers: { authorization: `Bearer ${key}` } })).json();
    if (!b || !Array.isArray(b.batch) || !b.batch.length) { await done({ ok: true, note: '未整理のメモはありませんでした' }); return; }
    const tab = await chrome.tabs.create({ url: 'https://gemini.google.com/app?knowkin_organize=1', active: false, pinned: true });
    organizing.tab = tab.id;
    for (let i = 0; i < 40 && !organizing.ready && !organizing.answer; i++) await wait(1000);
    if (!organizing.ready) { await done({ ok: false, note: (organizing.answer && organizing.answer.error) || 'Gemini の画面が開けませんでした' }); return; }
    await chrome.tabs.sendMessage(tab.id, { type: 'organize-prompt', prompt: b.prompt });
    for (let i = 0; i < 400 && !organizing.answer; i++) await wait(1000);
    const a = organizing.answer;
    if (!a || !a.answer) { await done({ ok: false, note: (a && a.error) || '答えが返ってきませんでした' }); return; }
    const r = await fetch(`${KNOWKIN}/api/organize/apply`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ answer: a.answer, batch: b.batch }) });
    const j = await r.json().catch(() => ({}));
    await done(r.ok ? { ok: true, note: `${j.saved}件のメモを整理（記憶 ${j.added}件）` } : { ok: false, note: j.error || `保存できませんでした（${r.status}）` });
  } catch (e) {
    await done({ ok: false, note: String(e.message || e) });
  } finally {
    if (organizing && organizing.tab) chrome.tabs.remove(organizing.tab).catch(() => {});
    organizing = null;
  }
}
chrome.alarms?.create('organize', { periodInMinutes: 60, delayInMinutes: 5 });
chrome.alarms?.onAlarm.addListener((a) => { if (a.name === 'organize') organize(); });
