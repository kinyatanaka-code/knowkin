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
      // knowkin の自動整理のやりとりは、AI履歴に残さない（整理の結果は別の道で knowkin に入る）
      if (q.includes('【knowkin整理】')) continue;
      // 何番目かは使わない（長い会話は古いやりとりが後から読みこまれ、番号がずれて二重に入るため）。質問と答えの書き出しで見分ける
      const ref = `gemini:${id}:${hash(q + '\u0000' + a.slice(0, 300))}`;
      const prev = seen.get(ref);
      if (!prev || prev.a !== a) { seen.set(ref, { a, at: now, sent: false }); continue; }
      if (prev.sent || now - prev.at < 5000) continue;
      prev.sent = true;
      chrome.runtime.sendMessage({ type: 'turn', ref, title, url: location.href, q, a });
    }
  }
  setInterval(scan, 2000);

  // ---- Gemini に knowkin の整理をさせる（2026-11-22 田中さん「1時間に1回、Gemini に整理させたい」）----
  //   係（background.js）が裏のタブで ?knowkin_organize=1 を開き、knowkin からもらった頼みごとを渡してくる。
  //   ここで入力欄に貼って送り、答えが書き終わったら（文が10秒変わらなくなったら）答えの文を係に返す
  if (/[?&]knowkin_organize=1/.test(location.search)) {
    const input = () => document.querySelector('rich-textarea .ql-editor, div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea');
    const sendBtn = () => [...document.querySelectorAll('button')].find((b) => /send-button/.test(b.className) || /送信|Send/i.test(b.getAttribute('aria-label') || '')) || null;
    let ready = 0;
    const tick = setInterval(() => {
      if (input()) { clearInterval(tick); chrome.runtime.sendMessage({ type: 'organize-ready' }); }
      else if (++ready > 30) { clearInterval(tick); chrome.runtime.sendMessage({ type: 'organize-answer', error: '入力欄が見つかりませんでした（Gemini の画面が変わった可能性）' }); }
    }, 1000);
    chrome.runtime.onMessage.addListener((m) => {
      if (!m || m.type !== 'organize-prompt') return;
      (async () => {
        const box = input();
        if (!box) { chrome.runtime.sendMessage({ type: 'organize-answer', error: '入力欄が見つかりませんでした' }); return; }
        const before = document.querySelectorAll('model-response').length;
        box.focus();
        if (box.tagName === 'TEXTAREA') { box.value = m.prompt; box.dispatchEvent(new Event('input', { bubbles: true })); }
        else { document.execCommand('selectAll', false); document.execCommand('insertText', false, m.prompt); box.dispatchEvent(new InputEvent('input', { bubbles: true })); }
        await new Promise((r) => setTimeout(r, 1500));
        const btn = sendBtn();
        if (btn && !btn.disabled) btn.click();
        else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        // 答えを待つ：新しい答えが出て、文が10秒変わらなくなるまで（最長6分）
        let last = '', same = 0;
        for (let i = 0; i < 180; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const as = document.querySelectorAll('model-response');
          if (as.length <= before) continue;
          const t = ((as[as.length - 1].querySelector('message-content') || as[as.length - 1]).innerText || '').trim();
          if (t && t === last) { if (++same >= 5) { chrome.runtime.sendMessage({ type: 'organize-answer', answer: t }); return; } } else { last = t; same = 0; }
        }
        chrome.runtime.sendMessage({ type: 'organize-answer', error: last ? '答えが書き終わりませんでした' : '答えが出ませんでした', answer: last });
      })();
    });
  }

  // ---- スマホの会話も拾う（2026-11-22 田中さん「スマホの Gemini アプリでも保存されるようにしたい」）----
  //   スマホの会話も、同じアカウントなら gemini.google.com の左の一覧に出る。
  //   knowkin の係（background.js）が裏のタブでこの一覧を開いたとき（?knowkin_sweep=1）、最近の会話のIDを集めて返す。
  //   係はその会話を1つずつ開き、上の scan がふだんどおり読んで送る
  if (/[?&]knowkin_sweep=1/.test(location.search)) {
    const pick = () => {
      const ids = [];
      const add = (x) => { if (x && !ids.includes(x)) ids.push(x); };
      // 一覧の項目：リンク（/app/ID）か、jslog などの中の "c_ID"
      for (const a of document.querySelectorAll('a[href*="/app/"]')) add((a.getAttribute('href').match(/\/app\/([0-9a-f]{10,})/) || [])[1]);
      const side = document.querySelector('conversations-list, side-navigation, bard-sidenav, nav') || document.body;
      for (const m of side.innerHTML.matchAll(/(?:["/\[]|&quot;)c_([0-9a-f]{10,})/g)) add(m[1]);
      return ids;
    };
    let tries = 0;
    const t = setInterval(() => {
      const ids = pick();
      if (ids.length || ++tries > 10) { clearInterval(t); chrome.runtime.sendMessage({ type: 'sweep-list', ids: ids.slice(0, 8) }); }
    }, 2000);
  }
})();
