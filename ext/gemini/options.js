// 連携キーと「残す／残さない」を決める画面
(async () => {
  const $ = (id) => document.getElementById(id);
  const s = await chrome.storage.local.get(['key', 'enabled', 'mobile', 'last', 'count', 'queue', 'lastSweep']);
  $('key').value = s.key || '';
  $('enabled').checked = s.enabled !== false;
  $('mobile').checked = s.mobile !== false;
  const show = (t, ok) => { $('st').textContent = t; $('st').className = `st ${ok ? 'ok' : 'ng'}`; };
  if (s.last) show(`前に送ったとき：${s.last.at}　${s.last.ok ? '送れました' : `送れませんでした（${s.last.status}）`}\nこれまでに送った数：${s.count || 0}${(s.queue || []).length ? `\nまだ送れていない数：${s.queue.length}（5分ごとに送り直します）` : ''}${s.lastSweep ? `\nスマホの会話を前に拾ったとき：${s.lastSweep.at}（${s.lastSweep.err ? `うまくいきませんでした：${s.lastSweep.err}` : `最近の会話 ${s.lastSweep.n} 件を見ました`}）` : ''}`, s.last.ok);
  else if (!s.key) show('連携キーを貼って「保存する」を押してください。', false);
  $('save').addEventListener('click', async () => {
    await chrome.storage.local.set({ key: $('key').value.trim(), enabled: $('enabled').checked, mobile: $('mobile').checked });
    show($('enabled').checked ? '保存しました。Gemini の画面を開き直すと残り始めます。' : '保存しました。いまは残しません。', true);
  });
  $('now').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'sweep-now' }); show('裏のタブで最近の会話を読んでいます（2分ほど）。終わったらタブは自動で閉じます。', true); });
})();
