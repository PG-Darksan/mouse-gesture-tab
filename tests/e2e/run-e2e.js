'use strict';
/*
 * 実ブラウザ試験。 空の一時プロファイルの Chrome (または Edge) に拡張機能を読み込み、
 * CDP の Input.dispatchMouseEvent (isTrusted の入力) で右ボタンのドラッグを行う。
 * 普段のプロファイル・タブ・アカウントには触れない。
 *
 *   node tests/e2e/run-e2e.js                 Chrome、 ヘッドレス
 *   node tests/e2e/run-e2e.js --edge          Edge
 *   node tests/e2e/run-e2e.js --headful       画面を表示して実行
 *   node tests/e2e/run-e2e.js --google        Google の実サイト (A28) も試す
 *   node tests/e2e/run-e2e.js --only=E04,E05  一部だけ
 *   node tests/e2e/run-e2e.js --ext=<フォルダー>  別の場所の拡張機能 (ZIP を展開した物など)
 */
const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('./cdp.js');
const { startServer } = require('./server.js');
const { findBrowser } = require('../../tools/chrome-path.js');

const argv = process.argv.slice(2);
const has = (name) => argv.includes('--' + name);
const value = (name) => {
  const a = argv.find((x) => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : null;
};
// --ext=<フォルダー> で、 ZIP を展開した配布物そのものも試験できる
const EXT = path.resolve(value('ext') || path.join(__dirname, '..', '..', 'extension'));
const SHOTS = path.resolve(value('shots') || path.join(__dirname, 'screens'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_GESTURES = { L: 'previous-tab', R: 'next-tab', U: 'none', D: 'none', DR: 'none', DL: 'none', UR: 'none', UL: 'none', RU: 'none', RD: 'none', LU: 'none', LD: 'none' };

let cdp;
let swSession;
let extId;
let port;
let hits;
let uniq = 0;
const sessions = new Map();

/* ------------------------------------------------------------ 補助 */

async function until(fn, timeout = 4000, interval = 50) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return last;
}

async function sw(body, arg) {
  const expression = `(async (arg) => { ${body} })(${JSON.stringify(arg === undefined ? null : arg)})`;
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, swSession);
  if (r.exceptionDetails) throw new Error('SW: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result.value;
}

async function page(session, expression, options = {}) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...options }, session);
  if (r.exceptionDetails) throw new Error('page: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result.value;
}

function url(name, host) {
  uniq += 1;
  const sep = name.includes('?') ? '&' : '?';
  return `http://${host || '127.0.0.1'}:${port}/${name}${sep}t=${uniq}`;
}

async function newWindow(urls) {
  const w = await sw('const w = await chrome.windows.create({ url: arg, focused: true, width: 1280, height: 800 }); return { id: w.id, tabs: w.tabs.map((t) => t.id) };', urls);
  await until(() => sw('const t = await chrome.tabs.query({ windowId: arg }); return t.every((x) => x.status === "complete" && (x.url || x.pendingUrl));', w.id), 15000);
  return w;
}

async function closeWindow(w) {
  try {
    await sw('await chrome.windows.remove(arg); return true;', w.id);
  } catch (_) {
    // 既に閉じている
  }
}

async function tabInfo(tabId) {
  return sw('const t = await chrome.tabs.get(arg); return { id: t.id, url: t.url || t.pendingUrl, index: t.index, active: t.active, windowId: t.windowId, status: t.status };', tabId);
}

async function activeTab(windowId) {
  return sw('const [t] = await chrome.tabs.query({ windowId: arg, active: true }); return t ? t.id : null;', windowId);
}

async function waitActive(windowId, tabId, timeout = 4000) {
  return until(async () => (await activeTab(windowId)) === tabId, timeout);
}

async function ping(tabId) {
  return sw('try { return await chrome.tabs.sendMessage(arg, { type: "gesture-ping" }, { frameId: 0 }); } catch (e) { return null; }', tabId);
}

async function waitReady(tabIds, timeout = 10000) {
  for (const id of [].concat(tabIds)) {
    const ok = await until(async () => {
      const p = await ping(id);
      return p && p.ready;
    }, timeout);
    if (!ok) throw new Error('content script not ready in tab ' + id);
  }
}

async function sessionFor(tabId) {
  const info = await tabInfo(tabId);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const target = targetInfos.find((t) => t.type === 'page' && t.url === info.url);
  if (!target) throw new Error('target not found for ' + info.url);
  if (sessions.has(target.targetId)) return sessions.get(target.targetId);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  sessions.set(target.targetId, sessionId);
  return sessionId;
}

function mouse(session, type, x, y, button, buttons) {
  return cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse' }, session);
}

/** 右ボタンのドラッグ。 points の最後の点で離す。 releaseAt を指定すると最後の点へは移動せずそこで離す。 */
async function drag(session, points, options = {}) {
  const [x0, y0] = points[0];
  await mouse(session, 'mouseMoved', x0, y0, 'none', 0);
  await mouse(session, 'mousePressed', x0, y0, 'right', 2);
  for (const [x, y] of points.slice(1)) await mouse(session, 'mouseMoved', x, y, 'right', 2);
  if (options.beforeRelease) await options.beforeRelease();
  const [rx, ry] = options.releaseAt || points[points.length - 1];
  await mouse(session, 'mouseReleased', rx, ry, 'right', 0);
}

function line(from, to, step = 4) {
  const out = [];
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1])) / step));
  for (let k = 1; k <= n; k += 1) out.push([Math.round(from[0] + ((to[0] - from[0]) * k) / n), Math.round(from[1] + ((to[1] - from[1]) * k) / n)]);
  return out;
}

function path2(start, ...rel) {
  const pts = [start];
  let cur = start;
  for (const [dx, dy] of rel) {
    const next = [cur[0] + dx, cur[1] + dy];
    pts.push(...line(cur, next));
    cur = next;
  }
  return pts;
}

async function setSettings(values) {
  await sw('await chrome.storage.local.clear(); if (arg) await chrome.storage.local.set(arg); return true;', values);
  await sleep(150);
}

async function calls() {
  return sw('return globalThis.__calls.slice();');
}

async function resetCalls() {
  await sw('globalThis.__calls.length = 0; globalThis.__stub = {}; return true;');
}

async function shot(session, name, clip) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const params = { format: 'png' };
  if (clip) params.clip = { ...clip, scale: 1 };
  const r = await cdp.send('Page.captureScreenshot', params, session);
  const file = path.join(SHOTS, name + '.png');
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

/* ------------------------------------------------------------ 試験 */

const tests = [];
const T = (id, title, fn) => tests.push({ id, title, fn });

function check(cond, message, log) {
  log.push((cond ? '  ✔ ' : '  ✘ ') + message);
  return !!cond;
}

let preloadedUrl = null;

T('E01', '導入時に既存ページを準備 (再読み込み不要)', async (log) => {
  const tabId = await until(() => sw('const t = (await chrome.tabs.query({})).find((x) => x.url === arg); return t ? t.id : null;', preloadedUrl), 5000);
  let ok = check(tabId, '読み込み前から開いていたタブ', log);
  const ready = await until(async () => {
    const p = await ping(tabId);
    return p && p.ready;
  }, 8000);
  ok = check(ready, 'onInstalled でスクリプトを準備した', log) && ok;
  const info = await tabInfo(tabId);
  await sw('await chrome.tabs.update(arg, { active: true }); return true;', tabId);
  const s = await sessionFor(tabId);
  await drag(s, path2([400, 300], [150, 0]));
  const moved = await until(async () => (await activeTab(info.windowId)) !== tabId, 3000);
  ok = check(moved, '再読み込みせずに右ジェスチャーでタブを切り替えた', log) && ok;
  await sw('await chrome.tabs.update(arg, { active: true }); return true;', tabId);
  return ok;
});

T('E02', 'A02 初期設定: 右=次・左=前・他は未割り当て', async (log) => {
  await setSettings(null);
  const w = await newWindow([url('basic.html'), url('basic.html'), url('basic.html')]);
  const [a, b] = w.tabs;
  await waitReady(w.tabs);
  await resetCalls();
  let ok = true;
  await drag(await sessionFor(a), path2([400, 300], [160, 0]));
  ok = check(await waitActive(w.id, b), '右で次のタブ', log) && ok;
  await drag(await sessionFor(b), path2([600, 300], [-160, 0]));
  ok = check(await waitActive(w.id, a), '左で前のタブ', log) && ok;
  for (const rel of [[[0, -150]], [[0, 150]], [[0, 120], [120, 0]], [[-120, 0], [0, 120]]]) {
    await drag(await sessionFor(a), path2([600, 350], ...rel));
  }
  await sleep(500);
  const c = await calls();
  ok = check(c.length === 2, `ブラウザ操作は 2 回だけ (実際 ${c.length})`, log) && ok;
  ok = check((await activeTab(w.id)) === a, '未割り当ての形ではタブが変わらない', log) && ok;
  await closeWindow(w);
  return ok;
});

T('E03', 'A01 12 種類を方向順で区別し、 解放時に 1 回だけ実行', async (log) => {
  const mapping = { L: 'previous-tab', R: 'next-tab', U: 'reload', D: 'hard-reload', DR: 'close-tab', DL: 'close-window', UR: 'new-tab', UL: 'restore-closed', RU: 'go-back', RD: 'go-forward', LU: 'duplicate-tab', LD: 'toggle-pin' };
  await setSettings({ gestures: mapping });
  const w = await newWindow([url('basic.html'), url('basic.html'), url('basic.html')]);
  const [a, b, c] = w.tabs;
  await waitReady(w.tabs);
  await resetCalls();
  // ブラウザ操作は記録だけして実行しない
  await sw(`for (const k of ['tabs.update','tabs.remove','tabs.create','tabs.reload','tabs.goBack','tabs.goForward','tabs.duplicate','windows.remove','sessions.restore']) globalThis.__stub[k] = async () => ({}); return true;`);
  const s = await sessionFor(a);
  const V = { L: [-130, 0], R: [130, 0], U: [0, -130], D: [0, 130] };
  const order = Object.keys(mapping);
  for (const id of order) {
    const before = (await calls()).length;
    await drag(s, path2([600, 360], ...id.split('').map((d) => V[d])), {
      beforeRelease: async () => {
        await sleep(30);
        const during = (await calls()).length;
        if (during !== before) log.push(`  ✘ ${id}: 描いている途中で実行された`);
      }
    });
    await until(async () => (await calls()).length > before, 2000);
  }
  await sleep(400);
  const got = await calls();
  const expected = {
    'previous-tab': (x) => x.api === 'tabs.update' && x.args[0] === c && x.args[1].active,
    'next-tab': (x) => x.api === 'tabs.update' && x.args[0] === b && x.args[1].active,
    'reload': (x) => x.api === 'tabs.reload' && x.args[1].bypassCache === false,
    'hard-reload': (x) => x.api === 'tabs.reload' && x.args[1].bypassCache === true,
    'close-tab': (x) => x.api === 'tabs.remove' && x.args[0] === a,
    'close-window': (x) => x.api === 'windows.remove' && x.args[0] === w.id,
    'new-tab': (x) => x.api === 'tabs.create' && x.args[0].index === 1 && !x.args[0].url,
    'restore-closed': (x) => x.api === 'sessions.restore',
    'go-back': (x) => x.api === 'tabs.goBack' && x.args[0] === a,
    'go-forward': (x) => x.api === 'tabs.goForward' && x.args[0] === a,
    'duplicate-tab': (x) => x.api === 'tabs.duplicate' && x.args[0] === a,
    'toggle-pin': (x) => x.api === 'tabs.update' && x.args[1].pinned === true
  };
  let ok = check(got.length === 12, `操作は 12 回 (実際 ${got.length})`, log);
  order.forEach((id, i) => {
    ok = check(got[i] && expected[mapping[id]](got[i]), `${id} → ${mapping[id]} (${got[i] ? got[i].api : 'なし'})`, log) && ok;
  });
  ok = ok && !log.some((l) => l.includes('途中で実行'));
  await resetCalls();
  await setSettings(null);
  await closeWindow(w);
  return ok;
});

T('E04', 'A13 左右 40 回の独立した連続操作', async (log) => {
  await setSettings(null);
  const w = await newWindow([url('basic.html'), url('basic.html')]);
  const [a, b] = w.tabs;
  await waitReady(w.tabs);
  await resetCalls();
  const histBefore = await sw('return MGBackground.historySize;');
  const t0 = Date.now();
  let ok = true;
  for (let i = 0; i < 40; i += 1) {
    const from = i % 2 === 0 ? a : b;
    const to = i % 2 === 0 ? b : a;
    await drag(await sessionFor(from), path2([640, 400], [i % 2 === 0 ? 120 : -120, 0]));
    if (!(await waitActive(w.id, to, 3000))) {
      ok = check(false, `${i + 1} 回目で切り替わらなかった`, log);
      break;
    }
  }
  const elapsed = Date.now() - t0;
  await sleep(300);
  const updates = (await calls()).filter((c) => c.api === 'tabs.update').length;
  const histAfter = await sw('return MGBackground.historySize;');
  ok = check(updates === 40, `tabs.update は 40 回 (実際 ${updates})`, log) && ok;
  ok = check(histAfter - histBefore === 40, `別々の ID が 40 個 (履歴の増加 ${histAfter - histBefore})`, log) && ok;
  log.push(`  ・40 回の所要時間 ${elapsed}ms`);
  await closeWindow(w);
  return ok;
});

T('E05', 'A14 前の tabs.update の応答を保留しても逆方向の解放を待機後に実行', async (log) => {
  await setSettings(null);
  const w = await newWindow([url('basic.html'), url('basic.html')]);
  const [a, b] = w.tabs;
  await waitReady(w.tabs);
  await resetCalls();
  await sw('let first = true; globalThis.__stub["tabs.update"] = async (orig, ...args) => { const r = await orig(...args); if (first) { first = false; await new Promise((res) => setTimeout(res, 1500)); } return r; }; return true;');
  await drag(await sessionFor(a), path2([640, 400], [140, 0]));
  let ok = check(await waitActive(w.id, b, 1000), 'タブは切り替わり、 応答は保留中', log);
  await drag(await sessionFor(b), path2([640, 400], [-140, 0]));
  await sleep(300);
  const mid = (await calls()).filter((c) => c.api === 'tabs.update').length;
  ok = check(mid === 1 && (await activeTab(w.id)) === b, '逆方向の要求はキューで待機 (捨てない)', log) && ok;
  ok = check(await waitActive(w.id, a, 4000), '保留が解けた後に逆方向を実行', log) && ok;
  const total = (await calls()).filter((c) => c.api === 'tabs.update').length;
  ok = check(total === 2, `tabs.update は 2 回 (実際 ${total})`, log) && ok;
  await resetCalls();
  await closeWindow(w);
  return ok;
});

T('E06', 'A03 5 / 10 / 100 / 300px の線と角', async (log) => {
  await setSettings({ gestures: { ...DEFAULT_GESTURES, DR: 'next-tab', UL: 'previous-tab' } });
  const w = await newWindow([url('basic.html'), url('basic.html')]);
  const [a, b] = w.tabs;
  await waitReady(w.tabs);
  let ok = true;
  for (const size of [5, 10, 100, 300]) {
    const step = Math.min(size, 4);
    await drag(await sessionFor(a), [[500, 400], ...line([500, 400], [500 + size, 400], step)]);
    ok = check(await waitActive(w.id, b), `${size}px の右`, log) && ok;
    await drag(await sessionFor(b), [[700, 400], ...line([700, 400], [700 - size, 400], step)]);
    ok = check(await waitActive(w.id, a), `${size}px の左`, log) && ok;
    await drag(await sessionFor(a), [[500, 300], ...line([500, 300], [500, 300 + size], step), ...line([500, 300 + size], [500 + size, 300 + size], step)]);
    ok = check(await waitActive(w.id, b), `${size}px の下→右`, log) && ok;
    await drag(await sessionFor(b), [[700, 500], ...line([700, 500], [700, 500 - size], step), ...line([700, 500 - size], [700 - size, 500 - size], step)]);
    ok = check(await waitActive(w.id, a), `${size}px の上→左`, log) && ok;
  }
  await setSettings(null);
  await closeWindow(w);
  return ok;
});

T('E07', 'A04 通常の右クリック・手ぶれ・斜めではメニューを抑制しない', async (log) => {
  await setSettings(null);
  const w = await newWindow([url('basic.html'), url('basic.html')]);
  const [a] = w.tabs;
  await waitReady(w.tabs);
  await resetCalls();
  const s = await sessionFor(a);
  await drag(s, [[400, 300]]);
  await drag(s, [[400, 300], [402, 301], [403, 303], [401, 302]]);
  await drag(s, path2([400, 300], [90, 90]));
  await sleep(400);
  const menus = await page(s, 'window.__menus.length');
  let ok = check(menus === 3, `ページにコンテキストメニューが 3 回届いた (実際 ${menus})`, log);
  ok = check((await calls()).length === 0 && (await activeTab(w.id)) === a, 'ブラウザ操作なし', log) && ok;
  // 認識したドラッグはメニューを抑制する
  await drag(s, path2([400, 300], [150, 0]));
  await sleep(300);
  ok = check((await page(s, 'window.__menus.length')) === 3, '認識したドラッグのメニューは抑制', log) && ok;
  await closeWindow(w);
  return ok;
});

T('E08', 'A05 / A08 / A09 / A10 小さな揺れ・不成立の経路・解放位置', async (log) => {
  await setSettings({ gestures: { ...DEFAULT_GESTURES, DR: 'next-tab' } });
  const w = await newWindow([url('basic.html'), url('basic.html')]);
  const [a, b] = w.tabs;
  await waitReady(w.tabs);
  await resetCalls();
  let ok = true;
  // 初動 1px、 末尾 3px、 末尾の小さい戻り → 右
  await drag(await sessionFor(a), [[400, 300], [400, 301], ...line([400, 301], [560, 301]), [560, 304], [557, 304]]);
  ok = check(await waitActive(w.id, b), '揺れを吸収して右 (次のタブ)', log) && ok;
  const sb = await sessionFor(b);
  const menusBefore = await page(sb, 'window.__menus.length');
  const invalid = [
    ['折り返し', path2([600, 300], [-150, 0], [150, 0])],
    ['階段 (3 ストローク)', path2([600, 300], [-100, 0], [0, 100], [-100, 0])],
    ['3 方向目 (下→右→上)', path2([500, 200], [0, 120], [120, 0], [0, -60])],
    ['ループ', path2([600, 300], [-100, 0], [0, 100], [100, 0], [0, -100])]
  ];
  for (const [name, pts] of invalid) {
    await drag(sb, pts);
    await sleep(350);
    ok = check((await activeTab(w.id)) === b, `${name} は実行しない`, log) && ok;
  }
  ok = check((await page(sb, 'window.__menus.length')) === menusBefore, '認識後に不成立になったドラッグのメニューは抑制', log) && ok;
  // 最終方向が解放位置だけで届く (A10)
  await drag(sb, [[500, 200], [500, 320]], { releaseAt: [640, 320] });
  ok = check(await waitActive(w.id, a), '解放位置まで含めて下→右と判定', log) && ok;
  const n = (await calls()).filter((c) => c.api === 'tabs.update').length;
  ok = check(n === 2, `操作は 2 回だけ (実際 ${n})`, log) && ok;
  await setSettings(null);
  await closeWindow(w);
  return ok;
});

/** 人の手に近い横線。 bulge: 弧のふくらみ、 tilt: 傾き、 hook: 終わりの曲がり、 back: 離す前の戻り、 tail: 終わりの斜めのずれ */
function handLine(start, dx, opts = {}) {
  const { bulge = 0, tilt = 0, hook = 0, back = 0, tail = null, wobble = 0 } = opts;
  const pts = [start];
  const n = Math.ceil(Math.abs(dx) / 4);
  for (let k = 1; k <= n; k += 1) {
    const t = k / n;
    const w = wobble ? (k % 2 ? wobble : -wobble) : 0;
    pts.push([Math.round(start[0] + dx * t), Math.round(start[1] + bulge * Math.sin(Math.PI * t) + Math.abs(dx) * tilt * t + w)]);
  }
  const dir = Math.sign(dx);
  const end = () => pts[pts.length - 1];
  if (hook) pts.push([end()[0] + dir * 2, end()[1] + hook / 2], [end()[0] + dir, end()[1] + hook / 2]);
  if (tail) pts.push(...line(end(), [end()[0] + dir * tail, end()[1] + tail]));
  if (back) pts.push([end()[0] - dir * back, end()[1] + 1]);
  return pts;
}

T('E21', '人の手に近い線 (弧・傾き・終わりの曲がり・離す時の戻り・斜めのずれ) でも左右を認識', async (log) => {
  await setSettings(null);
  const w = await newWindow([url('basic.html'), url('basic.html')]);
  const [a, b] = w.tabs;
  await waitReady(w.tabs);
  await resetCalls();
  const cases = [
    ['弧 15px と終わりの 12px の曲がり', handLine([400, 300], 220, { bulge: 15, hook: 12 })],
    ['離す前に 10px 戻る', handLine([700, 300], -180, { back: 10 })],
    ['終わりが斜めに 30px ずれる', handLine([400, 300], 150, { tail: 30 })],
    ['7 度の傾きと終わりの上への曲がり', handLine([700, 400], -200, { tilt: 0.12, bulge: -8, hook: -14 })],
    ['線の両側への 2px の揺れ', handLine([400, 300], 160, { wobble: 2 })],
    ['押した直後に 3px 下へずれてから左', [[700, 300], [700, 303], ...handLine([700, 303], -120)]]
  ];
  let ok = true;
  let from = a;
  for (const [name, pts] of cases) {
    const to = from === a ? b : a;
    await drag(await sessionFor(from), pts);
    ok = check(await waitActive(w.id, to), name, log) && ok;
    from = to;
  }
  const n = (await calls()).filter((c) => c.api === 'tabs.update').length;
  ok = check(n === cases.length, `操作は ${cases.length} 回だけ (実際 ${n})`, log) && ok;
  await closeWindow(w);
  return ok;
});

T('E09', 'A12 Esc・設定変更で中止した操作を解放で復活させない', async (log) => {
  await setSettings(null);
  const w = await newWindow([url('basic.html'), url('basic.html')]);
  const [a] = w.tabs;
  await waitReady(w.tabs);
  await resetCalls();
  const s = await sessionFor(a);
  await drag(s, path2([400, 300], [150, 0]), {
    beforeRelease: async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, s);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, s);
      await mouse(s, 'mouseMoved', 600, 300, 'right', 2);
    }
  });
  await sleep(400);
  let ok = check((await calls()).length === 0 && (await activeTab(w.id)) === a, 'Esc 後の解放で実行しない', log);
  ok = check((await page(s, 'window.__menus.length')) === 0, 'Esc で中止したドラッグのメニューも抑制', log) && ok;
  await drag(s, path2([400, 300], [150, 0]), {
    beforeRelease: async () => {
      await sw('await chrome.storage.local.set({ wrapTabs: false }); return true;');
      await sleep(200);
      await mouse(s, 'mouseMoved', 600, 302, 'right', 2);
    }
  });
  await sleep(400);
  ok = check((await calls()).length === 0 && (await activeTab(w.id)) === a, '設定変更後の解放で実行しない', log) && ok;
  await drag(s, path2([400, 300], [150, 0]));
  ok = check(await until(async () => (await activeTab(w.id)) !== a, 3000), '次のドラッグは通常どおり実行', log) && ok;
  await setSettings(null);
  await closeWindow(w);
  return ok;
});

T('E10', 'A15 HTTP の非セキュア扱いホストでも ID を作って実行', async (log) => {
  await setSettings(null);
  const w = await newWindow([url('basic.html', 'gesture.test'), url('basic.html', 'gesture.test')]);
  const [a, b] = w.tabs;
  await waitReady(w.tabs);
  const s = await sessionFor(a);
  const ctx = await page(s, '({ secure: window.isSecureContext, randomUUID: typeof crypto.randomUUID, host: location.host })');
  let ok = check(ctx.secure === false && ctx.randomUUID === 'undefined', `非セキュアコンテキスト (${ctx.host}, randomUUID: ${ctx.randomUUID})`, log);
  await drag(s, path2([400, 300], [150, 0]));
  ok = check(await waitActive(w.id, b), '右ジェスチャーを実行', log) && ok;
  await closeWindow(w);
  return ok;
});

T('E11', 'A25 動画・互換 MouseEvent を止めるプレイヤー・全画面', async (log) => {
  await setSettings(null);
  const w = await newWindow([url('video.html'), url('basic.html')]);
  const [v, b] = w.tabs;
  await waitReady(w.tabs);
  await resetCalls();
  const s = await sessionFor(v);
  await drag(s, path2([400, 300], [200, 0]));
  let ok = check(await waitActive(w.id, b), '動画の上の右ジェスチャー', log);
  const m = await page(s, 'window.__mouse');
  ok = check(m.down === 0 && m.up === 0, `互換 mousedown / mouseup は届いていない (${m.down}/${m.up})`, log) && ok;
  await drag(await sessionFor(b), path2([600, 300], [-150, 0]));
  ok = check(await waitActive(w.id, v), '戻る', log) && ok;
  await drag(s, [[500, 300]]);
  await sleep(300);
  ok = check((await page(s, 'window.__menus.length')) === 1, '動画の通常の右クリックメニューは維持', log) && ok;

  await page(s, 'document.getElementById("v").requestFullscreen().then(() => true)', { userGesture: true });
  ok = check(await until(() => page(s, '!!document.fullscreenElement'), 3000), '動画を全画面にした', log) && ok;
  await sleep(300);
  let overlay = null;
  await drag(s, path2([500, 300], [0, 150], [150, 0]), {
    beforeRelease: async () => {
      overlay = await page(s, '(() => { const o = document.querySelector("mg-gesture-overlay"); return o ? { popover: o.matches(":popover-open"), parent: o.parentElement && o.parentElement.tagName } : null; })()');
      await shot(s, 'e2e-fullscreen-video');
    }
  });
  ok = check(overlay && overlay.popover, `全画面の VIDEO では top layer (popover) に表示 ${JSON.stringify(overlay)}`, log) && ok;
  await sleep(500);
  ok = check((await calls()).filter((c) => c.api === 'tabs.update').length === 2, '下→右は未割り当てなので実行しない', log) && ok;
  await page(s, 'document.exitFullscreen().catch(() => {}).then(() => true)');
  await sleep(300);

  // 通常要素の全画面ではその要素の中へ表示する
  const sb = await sessionFor(b);
  await sw('await chrome.tabs.update(arg, { active: true }); return true;', b);
  await page(sb, 'document.getElementById("fs").requestFullscreen().then(() => true)', { userGesture: true });
  await until(() => page(sb, '!!document.fullscreenElement'), 3000);
  await sleep(300);
  let parent = null;
  await drag(sb, path2([500, 300], [-150, 0]), {
    beforeRelease: async () => {
      parent = await page(sb, '(() => { const o = document.querySelector("mg-gesture-overlay"); return o && o.parentElement ? o.parentElement.id : null; })()');
      await shot(sb, 'e2e-fullscreen-element');
    }
  });
  ok = check(parent === 'fs', `全画面の通常要素の中に表示 (${parent})`, log) && ok;
  ok = check(await waitActive(w.id, v), '全画面中の左ジェスチャーを実行', log) && ok;
  await closeWindow(w);
  return ok;
});

T('E12', 'A26 iframe 内・境界をまたぐ入力・再注入', async (log) => {
  await setSettings(null);
  const w = await newWindow([url('frames.html'), url('basic.html')]);
  const [f, b] = w.tabs;
  await waitReady(w.tabs);
  const frames = await until(async () => {
    const r = await sw('const res = await chrome.scripting.executeScript({ target: { tabId: arg, allFrames: true }, func: () => ({ url: location.href, ok: !!globalThis.__mgTabGestureInstance && !globalThis.__mgTabGestureInstance.destroyed }) }); return res.map((x) => x.result);', f);
    return r.length >= 4 && r.every((x) => x.ok) ? r : null;
  }, 8000);
  let ok = check(frames, `全フレームで準備済み (${frames ? frames.map((x) => x.url.replace(/^.*\//, '')).join(', ') : 'なし'})`, log);
  await resetCalls();
  const s = await sessionFor(f);
  const sb = await sessionFor(b);
  const back = async () => {
    await drag(sb, path2([600, 300], [150, 0]));
    return waitActive(w.id, f);
  };
  const cases = [
    ['同一オリジンの iframe 内', path2([150, 200], [200, 0])],
    ['別オリジンの iframe 内', path2([600, 200], [200, 0])],
    ['about:blank の iframe 内', path2([100, 520], [250, 0])],
    ['親で押して別オリジンの iframe の上で離す', path2([480, 200], [250, 0])],
    ['別オリジンの iframe で押して親で離す', path2([700, 200], [0, 220], [-200, 0])],
    ['同一オリジンの iframe で押して親で離す', path2([300, 200], [180, 0])],
    ['親で押して同一オリジンの iframe の上で離す', path2([470, 420], [0, -200], [-200, 0])]
  ];
  await setSettings({ gestures: { ...DEFAULT_GESTURES, R: 'next-tab', UL: 'next-tab', DL: 'next-tab' } });
  for (const [name, pts] of cases) {
    const before = (await calls()).filter((c) => c.api === 'tabs.update').length;
    await drag(s, pts);
    const switched = await waitActive(w.id, b, 3000);
    await sleep(200);
    const after = (await calls()).filter((c) => c.api === 'tabs.update').length;
    ok = check(switched && after - before === 1, `${name}: 1 回実行 (${after - before})`, log) && ok;
    ok = check(await back(), `${name}: 戻る`, log) && ok;
  }
  const menus = await page(s, '({ parent: window.__menus.length, child: window.__childMenus.length })');
  ok = check(menus.parent === 0 && menus.child === 0, `境界をまたいでもメニューを抑制 (親 ${menus.parent} / 子 ${menus.child})`, log) && ok;

  // 再注入してもリスナーが重複しない
  for (let i = 0; i < 2; i += 1) await sw('await MGBackground.injectTab(arg); return true;', f);
  await sleep(300);
  await resetCalls();
  await drag(s, path2([150, 200], [200, 0]));
  await waitActive(w.id, b, 3000);
  await sleep(400);
  const n = (await calls()).filter((c) => c.api === 'tabs.update').length;
  ok = check(n === 1, `再注入 2 回の後も 1 回だけ実行 (${n})`, log) && ok;
  await setSettings(null);
  await closeWindow(w);
  return ok;
});

T('E13', 'A24 新しいタブは元タブの直後に標準の新規タブを開く', async (log) => {
  const settings = { gestures: { ...DEFAULT_GESTURES, UR: 'new-tab' }, textSize: 'large' };
  await setSettings(settings);
  const w = await newWindow([url('basic.html'), url('basic.html'), url('basic.html')]);
  const [a] = w.tabs;
  await waitReady(w.tabs);
  await resetCalls();
  await drag(await sessionFor(a), path2([500, 400], [0, -150], [150, 0]));
  const created = await until(() => sw('const t = await chrome.tabs.query({ windowId: arg }); return t.length === 4 ? t.map((x) => ({ id: x.id, index: x.index, active: x.active, url: x.url || x.pendingUrl })) : null;', w.id), 4000);
  let ok = check(created, 'タブが 1 つ増えた', log);
  const fresh = created && created.find((x) => !w.tabs.includes(x.id));
  ok = check(fresh && fresh.index === 1 && fresh.active, `元タブの直後 (index ${fresh && fresh.index}) に開いて有効化`, log) && ok;
  ok = check(fresh && /^(chrome|edge):\/\/(newtab|new-tab-page)/.test(fresh.url), `標準の新規タブ (${fresh && fresh.url})`, log) && ok;
  const call = (await calls()).find((c) => c.api === 'tabs.create');
  ok = check(call && call.args[0].windowId === w.id && call.args[0].index === 1 && call.args[0].url === undefined, 'windowId と index + 1 を指定し URL は指定しない', log) && ok;
  const stored = await sw('return await chrome.storage.local.get(null);');
  ok = check(stored.gestures.UR === 'new-tab' && stored.textSize === 'large' && Object.keys(stored).length === 2, '既存の設定を変更しない', log) && ok;
  await setSettings(null);
  await closeWindow(w);
  return ok;
});

T('E14', 'A27 スーパーリロードは通常リロードと違いキャッシュを使わない', async (log) => {
  await setSettings({ gestures: { ...DEFAULT_GESTURES, U: 'reload', D: 'hard-reload' } });
  const w = await newWindow([url('cache.html'), url('basic.html')]);
  const [c] = w.tabs;
  await waitReady(w.tabs);
  const s = await sessionFor(c);
  const h0 = hits.cached;
  const marker = async () => page(s, 'window.__marker = Math.random(); window.__marker');
  const reloaded = async (m) => until(async () => {
    try {
      return (await page(s, 'window.__marker')) !== m && (await page(s, 'document.readyState')) === 'complete';
    } catch (_) {
      return false;
    }
  }, 5000);
  let m = await marker();
  await drag(s, path2([500, 500], [0, -150]));
  let ok = check(await reloaded(m), '上で再読み込みした', log);
  await waitReady(c);
  ok = check(hits.cached === h0, `通常リロードはキャッシュを使う (取得 ${hits.cached - h0} 回)`, log) && ok;
  m = await marker();
  await drag(s, path2([500, 300], [0, 150]));
  ok = check(await reloaded(m), '下でスーパーリロードした', log) && ok;
  await waitReady(c);
  ok = check(hits.cached === h0 + 1, `スーパーリロードはキャッシュを使わない (取得 ${hits.cached - h0} 回)`, log) && ok;
  await setSettings(null);
  await closeWindow(w);
  return ok;
});

T('E15', 'A23 標準新規タブ・管理画面は対象外 (注入・許可要求・置換なし)', async (log) => {
  await setSettings(null);
  const w = await newWindow(['chrome://newtab/', url('basic.html')]);
  const [nt] = w.tabs;
  await resetCalls();
  const info = await tabInfo(nt);
  let ok = check(/^(chrome|edge):\/\//.test(info.url), `標準の新規タブ (${info.url})`, log);
  const st = await sw('return await MGBackground.getPageStatus();');
  ok = check(st.state === 'restricted' && !st.canRequest, `診断は対象外 (${st.state})`, log) && ok;
  ok = check(!(await ping(nt)), 'コンテンツスクリプトは接続しない', log) && ok;
  try {
    await drag(await sessionFor(nt), path2([500, 400], [200, 0]));
  } catch (e) {
    log.push('  ・新規タブへの入力: ' + e.message);
  }
  await sleep(500);
  ok = check((await calls()).length === 0 && (await activeTab(w.id)) === nt, '新規タブ上のドラッグでは何も起きない', log) && ok;
  await sw('await chrome.tabs.update(arg, { url: "chrome://extensions/" }); return true;', nt);
  await sleep(500);
  const st2 = await sw('return await MGBackground.getPageStatus();');
  ok = check(st2.state === 'restricted', `拡張機能の管理画面も対象外 (${st2.state})`, log) && ok;
  const manifest = await sw('return chrome.runtime.getManifest();');
  ok = check(!manifest.chrome_url_overrides, 'chrome_url_overrides なし', log) && ok;
  await closeWindow(w);
  return ok;
});

async function openPopup(focused = true) {
  const popupUrl = `chrome-extension://${extId}/popup.html`;
  const w = await sw('const w = await chrome.windows.create({ url: arg.url, focused: arg.focused, width: 900, height: 900 }); return { id: w.id, tabs: w.tabs.map((t) => t.id) };', { url: popupUrl, focused });
  await until(() => sw('const [t] = await chrome.tabs.query({ windowId: arg }); return t && t.status === "complete";', w.id), 8000);
  const s = await sessionFor(w.tabs[0]);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 760, deviceScaleFactor: 1, mobile: false }, s);
  await until(() => page(s, '!document.getElementById("enabled").disabled'), 5000);
  return { w, s };
}

const MEASURE = `(() => {
  const app = document.querySelector('.app').getBoundingClientRect();
  const body = document.body.getBoundingClientRect();
  const list = document.getElementById('mappingList');
  const foot = document.querySelector('.foot').getBoundingClientRect();
  const overflow = [...document.querySelectorAll('.app *')].filter((e) => e.getClientRects().length && !e.closest('#mappingList option')).some((e) => {
    const r = e.getBoundingClientRect();
    return r.right > body.right + 0.5 && !list.contains(e);
  });
  const lr = list.getBoundingClientRect();
  const allVisible = [...list.querySelectorAll('.row')].every((r) => { const b = r.getBoundingClientRect(); return b.top >= lr.top - 0.5 && b.bottom <= lr.bottom + 0.5 && b.right <= lr.right + 0.5; });
  // 閉じた選択欄に操作名が欠けずに収まるか (矢印と内側の余白を除いた幅で測る)
  const sel = list.querySelector('select');
  const cs = getComputedStyle(sel);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
  const room = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 20;
  const clipped = [...sel.options].filter((o) => ctx.measureText(o.textContent).width > room).map((o) => o.textContent);
  return { appH: Math.round(app.height), bodyW: Math.round(body.width), listH: list.clientHeight, listScroll: list.scrollHeight, allVisible, clipped, selectW: sel.clientWidth,
    footBottom: Math.round(foot.bottom), selects: list.querySelectorAll('select').length, overflow,
    title: document.querySelector('h1').textContent, lang: document.documentElement.lang,
    option: list.querySelector('select').options[1].textContent, save: document.getElementById('saveStatus').textContent };
})()`;

async function choose(s, id, valueToSet) {
  await page(s, `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(valueToSet)}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
}

T('E16', 'A20 ポップアップ: 日英 × 小中大で欠けず、 全 12 種類を操作できる', async (log) => {
  await setSettings(null);
  const { w, s } = await openPopup();
  let ok = true;
  for (const lang of ['ja', 'en']) {
    for (const size of ['small', 'medium', 'large']) {
      await choose(s, 'language', lang);
      await choose(s, 'textSize', size);
      await sleep(250);
      const m = await page(s, MEASURE);
      const width = 800;
      // 割り当て欄はスクロールせずに全 12 種類が見える
      const good = m.appH <= 580 && m.footBottom <= 580 && m.bodyW === width && !m.overflow && m.listScroll <= m.listH && m.allVisible && m.selects === 12 && m.lang === lang;
      ok = check(good, `${lang}/${size}: 高さ ${m.appH}px・幅 ${m.bodyW}px・割り当て欄 ${m.listH}/${m.listScroll}px・全行表示 ${m.allVisible ? 'はい' : 'いいえ'}・フッター下端 ${m.footBottom}px・はみ出し ${m.overflow ? 'あり' : 'なし'}・「${m.title}」・「${m.option}」`, log) && ok;
      log.push(`    選択欄の幅 ${m.selectW}px・欠ける操作名 ${m.clipped.length ? m.clipped.join(' / ') : 'なし'}`);
      await shot(s, `popup-${lang}-${size}`, { x: 0, y: 0, width, height: Math.min(600, Math.max(m.appH, 300)) });
    }
  }
  // キーボードで 12 個の選択欄すべてへ移動できる
  await choose(s, 'language', 'ja');
  await choose(s, 'textSize', 'medium');
  await page(s, 'document.activeElement && document.activeElement.blur(), window.scrollTo(0, 0), true');
  const focused = new Set();
  for (let i = 0; i < 40; i += 1) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, s);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, s);
    const id = await page(s, 'document.activeElement && document.activeElement.id');
    if (id) focused.add(id);
  }
  const gestureSelects = [...focused].filter((x) => x.startsWith('g-'));
  ok = check(gestureSelects.length === 12, `Tab キーで割り当て欄 ${gestureSelects.length}/12 個へ移動`, log) && ok;
  ok = check(['enabled', 'wrapTabs', 'showTrail', 'showFeedback', 'textSize', 'language', 'recheck', 'siteSettings', 'footerLink'].every((x) => focused.has(x)), '基本設定・ボタン・フッターにも移動できる', log) && ok;
  await closeWindow(w);
  await setSettings(null);
  return ok;
});

T('E17', 'A18 / A19 自動保存: 連続変更・保存中にポップアップを閉じても完了', async (log) => {
  await setSettings({ gestures: { L: 'previous-tab', R: 'next-tab', U: 'none', D: 'none', DR: 'none', DL: 'none', UR: 'none', UL: 'none' }, threshold: 120 });
  const { w, s } = await openPopup();
  const shown = await page(s, '[...document.querySelectorAll("#mappingList select")].map((x) => x.value).join(",")');
  let ok = check(shown.split(',').length === 12 && shown.endsWith('none,none,none,none'), '旧 8 種類の保存値を読み、 新 4 種類は未割り当てで表示', log);
  await choose(s, 'g-R', 'close-tab');
  await choose(s, 'g-L', 'reload');
  await choose(s, 'g-RU', 'new-tab');
  await choose(s, 'g-R', 'duplicate-tab');
  await page(s, '(() => { const el = document.getElementById("showTrail"); el.checked = false; el.dispatchEvent(new Event("change")); return true; })()');
  const saved = await until(() => page(s, 'document.getElementById("saveStatus").dataset.state === "saved"'), 4000);
  ok = check(saved, '表示は「保存済み」', log) && ok;
  let stored = await sw('return await chrome.storage.local.get(null);');
  ok = check(stored.gestures.R === 'duplicate-tab' && stored.gestures.L === 'reload' && stored.gestures.RU === 'new-tab' && stored.showTrail === false && stored.threshold === 120, '最後の設定を保存し、 旧版の threshold も保持', log) && ok;
  // 変更直後にポップアップを閉じる
  await choose(s, 'g-U', 'toggle-pin');
  await closeWindow(w);
  await sleep(800);
  stored = await sw('return await chrome.storage.local.get(null);');
  ok = check(stored.gestures.U === 'toggle-pin', '受理済みの保存は閉じた後も完了', log) && ok;
  await setSettings(null);
  return ok;
});

T('E18', 'A29 「有効」の切り替え後に保存を確認してから再診断', async (log) => {
  await setSettings(null);
  const target = await newWindow([url('basic.html')]);
  await waitReady(target.tabs);
  // ポップアップは最後にフォーカスされたウィンドウのアクティブタブを診断する
  const { w, s } = await openPopup(false);
  const focusedTab = await sw('const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return t && t.id;');
  log.push(`  ・最後にフォーカスされたウィンドウのタブ: ${focusedTab === target.tabs[0] ? '試験ページ' : 'その他 (' + focusedTab + ')'}`);
  await page(s, 'document.getElementById("recheck").click(), true');
  const text = () => page(s, 'document.getElementById("statusText").textContent');
  let ok = check(await until(async () => (await text()).includes('このページで使用できます'), 5000), `再確認: ${await text()}`, log);
  await page(s, '(() => { const el = document.getElementById("enabled"); el.checked = false; el.dispatchEvent(new Event("change")); return true; })()');
  await choose(s, 'textSize', 'large');
  ok = check(await until(async () => (await text()) === 'ジェスチャーは無効です', 5000), `無効化の後: ${await text()}`, log) && ok;
  await page(s, '(() => { const el = document.getElementById("enabled"); el.checked = true; el.dispatchEvent(new Event("change")); return true; })()');
  await choose(s, 'textSize', 'medium');
  ok = check(await until(async () => (await text()).includes('このページで使用できます'), 5000), `有効化の後: ${await text()}`, log) && ok;
  await closeWindow(w);
  await closeWindow(target);
  await setSettings(null);
  return ok;
});

T('E19', 'A22 サイト権限がない場合は該当ホストだけを案内する', async (log) => {
  await setSettings(null);
  const target = await newWindow([url('basic.html', 'gesture.test')]);
  let removed;
  try {
    removed = await sw('return await chrome.permissions.remove({ origins: ["http://gesture.test/*"] });');
  } catch (e) {
    removed = e.message;
  }
  if (removed !== true) {
    log.push('  ・必須のホスト権限を実行時に外せないため省略 (' + removed + ')');
    await closeWindow(target);
    return true;
  }
  const st = await sw('return await MGBackground.getPageStatus();');
  const ok = check(st.state === 'permission-required' && st.canRequest && st.origin === 'http://gesture.test/*', `許可が必要 (${st.state}, ${st.origin})`, log);
  await closeWindow(target);
  return ok;
});

T('E20', 'A28 Google の実サイト (検索トップ) で左右交互 12 回', async (log) => {
  if (!has('google')) {
    log.push('  ・--google を指定した時だけ実行');
    return true;
  }
  await setSettings(null);
  const w = await newWindow(['https://www.google.com/?hl=ja', url('basic.html')]);
  const [g, b] = w.tabs;
  const info = await tabInfo(g);
  log.push(`  ・表示した URL: ${info.url}`);
  const host = new URL(info.url).host;
  if (host !== 'www.google.com') {
    log.push('  ・検索トップ以外 (同意・認証画面など) へ転送されたため合格扱いにしない');
    await closeWindow(w);
    return false;
  }
  await waitReady(w.tabs, 15000);
  const st = await sw('return await MGBackground.getPageStatus();');
  let ok = check(st.state === 'ready', `診断: ${st.state}`, log);
  for (let i = 0; i < 12; i += 1) {
    const from = i % 2 === 0 ? g : b;
    const to = i % 2 === 0 ? b : g;
    await drag(await sessionFor(from), path2([640, 420], [i % 2 === 0 ? 150 : -150, 0]));
    if (!(await waitActive(w.id, to, 4000))) {
      ok = check(false, `${i + 1} 回目で切り替わらなかった`, log);
      break;
    }
  }
  ok = check(ok, '左右交互 12 回成功', log) && ok;
  await closeWindow(w);
  return ok;
});

/* ------------------------------------------------------------ 実行 */

(async () => {
  const browserPath = findBrowser(has('edge'));
  if (!browserPath) throw new Error('Chrome / Edge が見つかりません');
  const srv = await startServer();
  port = srv.port;
  hits = srv.hits;
  const browser = launch(browserPath, { headless: !has('headful'), args: [`--host-resolver-rules=MAP gesture.test 127.0.0.1`] });
  cdp = browser.cdp;
  const results = [];
  const only = value('only') ? value('only').split(',') : null;
  try {
    const version = await cdp.send('Browser.getVersion');
    console.log(`ブラウザ: ${version.product}  (${browserPath})`);
    // 拡張機能を読み込む前から開いているページ (E01)
    preloadedUrl = url('basic.html');
    await cdp.send('Target.createTarget', { url: preloadedUrl });
    await sleep(800);
    extId = (await cdp.send('Extensions.loadUnpacked', { path: EXT })).id;
    console.log('拡張機能 ID:', extId);
    const swTarget = await until(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.find((t) => t.type === 'service_worker' && t.url === `chrome-extension://${extId}/background.js`);
    }, 10000);
    swSession = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, swSession);
    await until(() => sw('return !!globalThis.MGBackground;'), 5000);
    // ブラウザ操作の呼び出しを記録する (必要な試験だけ実行を止める)
    await sw(`
      globalThis.__calls = []; globalThis.__stub = {};
      const wrap = (ns, name) => { const obj = chrome[ns]; const orig = obj[name].bind(obj);
        obj[name] = (...args) => { __calls.push({ api: ns + '.' + name, args: JSON.parse(JSON.stringify(args)) });
          const s = __stub[ns + '.' + name]; return s ? s(orig, ...args) : orig(...args); }; };
      for (const n of ['update', 'remove', 'create', 'reload', 'goBack', 'goForward', 'duplicate']) wrap('tabs', n);
      wrap('windows', 'remove'); wrap('sessions', 'restore'); return true;`);

    for (const t of tests) {
      if (only && !only.includes(t.id)) continue;
      const log = [];
      const t0 = Date.now();
      let pass = false;
      try {
        pass = await t.fn(log);
      } catch (err) {
        log.push('  ✘ 例外: ' + err.message);
        pass = false;
      }
      results.push({ id: t.id, title: t.title, pass, ms: Date.now() - t0, log });
      console.log(`${pass ? 'PASS' : 'FAIL'} ${t.id} ${t.title} (${Date.now() - t0}ms)`);
      for (const l of log) console.log(l);
    }
  } catch (err) {
    console.error('中断:', err);
    console.error(browser.stderr().slice(-3000));
  } finally {
    await browser.close();
    srv.server.close();
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n結果: ${results.length - failed.length}/${results.length} 合格`);
  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify({ date: new Date().toISOString(), browser: browserPath, results }, null, 2));
  process.exitCode = failed.length || !results.length ? 1 : 0;
})();
