// Gemini の画面から、やりとり（自分の質問と Gemini の答え）を読んで、knowkin に送る係（background.js）に渡す。
//   Gemini には会話を外から読む入口がないので、画面に出ている文を読む（2026-11-22 田中さん「いちいち押さなくても会話内容を保存してほしい」）
//   答えを書いている途中で送らないよう、文が 5秒 変わらなくなってから送る。
(() => {
  const seen = new Map(); // 送るかどうかを決めるために、前に見た答えの文と時刻を覚える
  const convId = () => (location.pathname.match(/\/app\/([A-Za-z0-9_-]+)/) || [])[1] || '';
  const txt = (el) => (el ? (el.innerText || '').trim() : '');
  // 1文字ずつ違う hash（同じ質問を何度しても別のやりとりとして残すため、何番目かも混ぜる）
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

  function scan() {
    const id = convId(); if (!id) return;
    // 画面のつくり：自分の質問は <user-query>、Gemini の答えは <model-response>。同じ順に並んでいる
    const qs = [...document.querySelectorAll('user-query')];
    const as = [...document.querySelectorAll('model-response')];
    const title = (document.title || '').replace(/\s*[-|–]\s*Gemini.*$/, '').trim();
    const now = Date.now();
    for (let i = 0; i < Math.min(qs.length, as.length); i++) {
      const q = txt(qs[i].querySelector('.query-text') || qs[i]).replace(/^(あなた|You)\s*/, '');
      const a = txt(as[i].querySelector('message-content') || as[i]);
      if (!q || !a) continue;
      const ref = `gemini:${id}:${i}:${hash(q)}`;
      const prev = seen.get(ref);
      if (!prev || prev.a !== a) { seen.set(ref, { a, at: now, sent: false }); continue; }
      if (prev.sent || now - prev.at < 5000) continue;
      prev.sent = true;
      chrome.runtime.sendMessage({ type: 'turn', ref, title, url: location.href, q, a });
    }
  }
  setInterval(scan, 2000);
})();
