'use strict';
/*
 * Chrome ウェブストア用の画像を作る (開発時だけ使う)。 実際の拡張機能を一時プロファイルの Chrome に読み込み、
 * 動作中の画面とポップアップを撮影して、 1280x800 のスクリーンショットと 440x280 のタイルにまとめる。
 *   node tools/store-assets.js   → store/images/<ja|en>/*.png
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { launch } = require('../tests/e2e/cdp.js');
const { findBrowser } = require('./chrome-path.js');
const C = require('../extension/config.js');
const I = require('../extension/i18n.js');
const GS = require('../extension/gesture-shape.js');

const root = path.resolve(__dirname, '..');
const EXT = path.join(root, 'extension');
const OUT = path.join(root, 'store', 'images');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COPY = {
  ja: {
    caption: '右ボタンを押したまま描いて、離すと実行',
    s2Title: '形ごとに操作を選んで、<br>その場で自動保存',
    s2Points: ['全12種類の形に、13の選択肢から操作を割り当て', '軌跡と操作ガイドで、離す前に結果が分かる', '日本語・英語、文字サイズは3段階'],
    s3Title: '上下左右と、1回だけ曲がる8種類',
    s3Sub: '描いている途中では何もせず、右ボタンを離した時に1回だけ実行します',
    tile: '右ドラッグでタブを操作'
  },
  en: {
    caption: 'Hold the right button, draw, release to run',
    s2Title: 'One action per shape,<br>saved instantly',
    s2Points: ['Assign any of 13 choices to each of the 12 shapes', 'The trail and guide show the result before you release', 'Japanese or English, three text sizes'],
    s3Title: 'Four directions and eight one-turn shapes',
    s3Sub: 'Nothing happens while drawing. The action runs once when you release.',
    tile: 'Control tabs with right-drag'
  }
};

function startServer() {
  const dir = path.join(root, 'store', 'src');
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '') || 'demo.html';
    const file = path.join(dir, name);
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function diagramSvg(id, size) {
  const d = GS.diagram(id, 40, 7);
  const pts = (list) => list.map((p) => p.join(',')).join(' ');
  return `<svg viewBox="0 0 40 40" width="${size}" height="${size}"><polyline points="${pts(d.line)}" fill="none" stroke="#159cab" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><polygon points="${pts(d.arrow)}" fill="#159cab"/><circle cx="${d.start[0]}" cy="${d.start[1]}" r="3.8" fill="#fff" stroke="#159cab" stroke-width="2.4"/></svg>`;
}

const FONT = `"Yu Gothic UI", "Segoe UI", Meiryo, sans-serif`;
const SYMBOL_FONT = `"Segoe UI Symbol", "Segoe UI", ${FONT}`;

function page(body, width, height, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; font-family: ${FONT}; color: #15333a; }
    .arrows { font-family: ${SYMBOL_FONT}; font-variant-emoji: text; }
    ${extraCss}</style></head><body>${body}</body></html>`;
}

(async () => {
  const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(EXT, 'icons', 'icon128.png')).toString('base64');
  const srv = await startServer();
  const browser = launch(findBrowser(false));
  const cdp = browser.cdp;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-store-'));
  try {
    const extId = (await cdp.send('Extensions.loadUnpacked', { path: EXT })).id;
    let swTarget = null;
    for (let i = 0; i < 50 && !swTarget; i += 1) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      swTarget = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`));
      if (!swTarget) await sleep(100);
    }
    const swSession = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
    const sw = async (body, arg) => {
      const r = await cdp.send('Runtime.evaluate', { expression: `(async (arg) => { ${body} })(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true }, swSession);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };
    const openWindow = async (url, focused = true) => {
      const w = await sw('const w = await chrome.windows.create({ url: arg.url, focused: arg.focused, width: 1280, height: 800 }); return { id: w.id, tab: w.tabs[0].id };', { url, focused });
      for (let i = 0; i < 100; i += 1) {
        if (await sw('const t = await chrome.tabs.get(arg); return t.status === "complete";', w.tab)) break;
        await sleep(100);
      }
      const { targetInfos } = await cdp.send('Target.getTargets');
      const target = targetInfos.find((t) => t.type === 'page' && t.url === url);
      const sessionId = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
      return { ...w, s: sessionId };
    };
    const metrics = (s, width, height) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, s);
    const capture = async (s, clip) => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, s)).data, 'base64');
    const render = async (html, width, height, file) => {
      const f = path.join(tmp, path.basename(file) + '.html');
      fs.writeFileSync(f, html);
      const w = await openWindow('file:///' + f.replace(/\\/g, '/'));
      await metrics(w.s, width, height);
      await sleep(300);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, await capture(w.s));
      await sw('await chrome.windows.remove(arg); return true;', w.id);
      console.log('wrote', path.relative(root, file));
    };
    const mouse = (s, type, x, y, button, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 }, s);

    for (const lang of ['ja', 'en']) {
      const copy = COPY[lang];
      const dir = path.join(OUT, lang);
      await sw('await chrome.storage.local.clear(); await chrome.storage.local.set(arg); return true;', { language: lang, textSize: 'large', gestures: { ...C.DEFAULT_GESTURES, DR: 'close-tab', U: 'reload', RU: 'new-tab' } });
      await sleep(200);

      // 1. 動作中の画面 (軌跡と操作ガイド)
      const demoUrl = `http://127.0.0.1:${srv.port}/demo.html?lang=${lang}`;
      const demo = await openWindow(demoUrl);
      await metrics(demo.s, 1280, 800);
      for (let i = 0; i < 50; i += 1) {
        const p = await sw('try { return await chrome.tabs.sendMessage(arg, { type: "gesture-ping" }, { frameId: 0 }); } catch (e) { return null; }', demo.tab);
        if (p && p.ready) break;
        await sleep(100);
      }
      await mouse(demo.s, 'mouseMoved', 520, 250, 'none', 0);
      await mouse(demo.s, 'mousePressed', 520, 250, 'right', 2);
      for (let y = 254; y <= 470; y += 6) await mouse(demo.s, 'mouseMoved', 520, y, 'right', 2);
      for (let x = 526; x <= 800; x += 6) await mouse(demo.s, 'mouseMoved', x, 470, 'right', 2);
      await sleep(200);
      const live = await capture(demo.s);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, demo.s);
      await mouse(demo.s, 'mouseReleased', 800, 470, 'right', 0);
      const liveUrl = 'data:image/png;base64,' + live.toString('base64');
      await render(
        page(
          `<img src="${liveUrl}" style="position:absolute;inset:0"><div class="cap"><img src="${icon}" width="44" height="44">${copy.caption}</div>`,
          1280,
          800,
          `.cap { position: absolute; right: 36px; top: 8px; display: flex; align-items: center; gap: 10px; padding: 4px 18px 4px 6px;
             background: rgba(14,116,128,.95); color: #fff; font-size: 21px; font-weight: 700; border-radius: 14px; box-shadow: 0 8px 24px rgba(0,0,0,.16); }
           .cap img { width: 40px; height: 40px; }`
        ),
        1280,
        800,
        path.join(dir, 'screenshot-1.png')
      );

      // 2. 設定画面 (デモページのウィンドウを最後にフォーカスされたウィンドウにしておく)
      const popup = await openWindow(`chrome-extension://${extId}/popup.html`, false);
      await metrics(popup.s, 800, 700);
      await sleep(1200);
      const size = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify([document.body.offsetWidth, Math.ceil(document.querySelector(".app").getBoundingClientRect().height)])', returnByValue: true }, popup.s);
      const [pw, ph] = JSON.parse(size.result.value);
      const popupPng = 'data:image/png;base64,' + (await capture(popup.s, { x: 0, y: 0, width: pw, height: ph })).toString('base64');
      // 2 列のポップアップは幅 800px あるので、 説明文の場所を残すよう縮小して載せる
      const shown = Math.min(1, 660 / pw);
      await sw('await chrome.windows.remove(arg); return true;', popup.id);
      await sw('await chrome.windows.remove(arg); return true;', demo.id);
      await render(
        page(
          `<div class="left"><img src="${icon}" width="72" height="72"><h1>${copy.s2Title}</h1><ul>${copy.s2Points.map((p) => `<li>${p}</li>`).join('')}</ul></div>
           <div class="right"><img src="${popupPng}" width="${Math.round(pw * shown)}" height="${Math.round(ph * shown)}"></div>`,
          1280,
          800,
          `body { background: linear-gradient(135deg, #e6f6f8, #f7fbfb 55%, #eaf4ef); display: flex; align-items: center; gap: 56px; padding: 0 64px; box-sizing: border-box; }
           .left { flex: 1; } h1 { font-size: 40px; line-height: 1.3; margin: 18px 0 26px; color: #0e5f69; }
           ul { margin: 0; padding: 0; list-style: none; } li { font-size: 22px; line-height: 1.5; margin: 0 0 16px; padding-left: 34px; position: relative; color: #23444b; }
           li::before { content: ''; position: absolute; left: 4px; top: 10px; width: 14px; height: 14px; border-radius: 50%; background: #159cab; }
           .right img { display: block; border-radius: 14px; box-shadow: 0 18px 50px rgba(14,80,90,.25); border: 1px solid #cfe3e7; }`
        ),
        1280,
        800,
        path.join(dir, 'screenshot-2.png')
      );

      // 3. 12 種類の形
      const tiles = C.GESTURES.map((id) => `<div class="tile">${diagramSvg(id, 92)}<div class="name">${I.shapeLabel(lang, id)}</div><div class="arrows">${GS.arrows(id)}</div></div>`).join('');
      await render(
        page(
          `<h1>${copy.s3Title}</h1><p>${copy.s3Sub}</p><div class="grid">${tiles}</div>`,
          1280,
          800,
          `body { background: #f5fafb; padding: 48px 72px; box-sizing: border-box; }
           h1 { margin: 0; font-size: 40px; color: #0e5f69; } p { margin: 10px 0 30px; font-size: 21px; color: #44606a; }
           .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 18px; }
           .tile { background: #fff; border: 1px solid #d3e5e9; border-radius: 16px; height: 238px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
           .name { font-size: 22px; font-weight: 700; } .arrows { font-size: 20px; color: #159cab; font-weight: 700; }`
        ),
        1280,
        800,
        path.join(dir, 'screenshot-3.png')
      );

      // 小型プロモーションタイル 440x280
      await render(
        page(
          `<img src="${icon}" width="112" height="112"><div><div class="n">${I.t(lang, 'extName').replace(/(・|– )/, '$1<br>')}</div><div class="t">${copy.tile}</div></div>`,
          440,
          280,
          `body { background: linear-gradient(135deg, #e3f5f7, #ffffff); display: flex; align-items: center; gap: 14px; padding: 0 26px; box-sizing: border-box; }
           .n { font-size: ${lang === 'ja' ? 25 : 24}px; font-weight: 700; color: #0e5f69; line-height: 1.25; } .t { margin-top: 10px; font-size: 17px; color: #3b5a62; }`
        ),
        440,
        280,
        path.join(dir, 'promo-small-440x280.png')
      );
    }
  } finally {
    await browser.close();
    srv.server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
