'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const C = require('../extension/config.js');
require('../extension/i18n.js');
require('../extension/gesture-path.js');
require('../extension/gesture-shape.js');
const { createController, TAKEOVER_EVENT } = require('../extension/content.js');
const { createEvent, deferred, settle } = require('./helpers/fake-chrome.js');

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeTarget(extra) {
  const map = new Map();
  const key = (type, opts) => type + '|' + !!(opts === true || (opts && opts.capture));
  return Object.assign(
    {
      addEventListener(type, fn, opts) {
        const k = key(type, opts);
        if (!map.has(k)) map.set(k, new Set());
        map.get(k).add(fn);
      },
      removeEventListener(type, fn, opts) {
        const set = map.get(key(type, opts));
        if (set) set.delete(fn);
      },
      fire(type, event) {
        for (const [k, set] of map) if (k.startsWith(type + '|')) for (const fn of [...set]) fn(event);
        return event;
      },
      listenerCount() {
        let n = 0;
        for (const set of map.values()) n += set.size;
        return n;
      },
      eraseAll() {
        map.clear();
      }
    },
    extra
  );
}

function makeElement() {
  const captured = new Set();
  return {
    captured,
    setPointerCapture(id) {
      captured.add(id);
    },
    releasePointerCapture(id) {
      captured.delete(id);
    },
    hasPointerCapture(id) {
      return captured.has(id);
    }
  };
}

function setup(options = {}) {
  let clock = 1000;
  const timers = [];
  const frames = new Map();
  let nextFrameId = 1;
  const win = makeTarget({ navigator: { language: 'ja' }, ...(options.win || {}) });
  const doc = makeTarget({
    visibilityState: 'visible',
    readyState: 'complete',
    contentType: 'text/html',
    fullscreenElement: null,
    focused: true,
    hasFocus() {
      return this.focused;
    },
    dispatchEvent(ev) {
      this.fire(ev.type, ev);
    },
    ...(options.doc || {})
  });
  const sent = [];
  const storage = { ...(options.storage || {}) };
  const onMessage = createEvent();
  const onChanged = createEvent();
  const runtime = {
    id: EXT_ID,
    getManifest: () => ({ version: '3.6.0' }),
    onMessage,
    sendMessage(msg) {
      sent.push(msg);
      if (options.send) return options.send(msg);
      if (options.respond) return Promise.resolve(options.respond(msg));
      return Promise.resolve(msg.type === 'execute-gesture' ? { ok: true, action: msg.action } : { ok: true });
    }
  };
  const chrome = {
    runtime,
    i18n: { getUILanguage: () => options.uiLanguage || 'ja' },
    storage: {
      local: { get: options.get || (async () => ({ ...storage })) },
      onChanged
    }
  };
  const overlay = { renders: [], notices: [], shields: [], cleared: 0, resets: 0, destroyed: 0 };
  const ctrl = createController({
    win,
    doc,
    chrome,
    now: () => clock,
    setTimeout: (fn) => timers.push(fn),
    requestAnimationFrame: (fn) => {
      const id = nextFrameId++;
      frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id) => {
      frames.delete(id);
    },
    crypto: options.crypto || webcrypto,
    createOverlay: () => ({
      render: (view) => overlay.renders.push(view),
      setShield: (on) => overlay.shields.push(!!on),
      clearGesture: () => {
        overlay.cleared += 1;
      },
      notice: (text, view) => overlay.notices.push({ text, view }),
      reset: () => {
        overlay.resets += 1;
      },
      destroy: () => {
        overlay.destroyed += 1;
      }
    })
  });
  const el = makeElement();

  function ev(props) {
    const e = {
      isTrusted: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: -1,
      buttons: 2,
      clientX: 0,
      clientY: 0,
      target: el,
      relatedTarget: null,
      defaultPrevented: false,
      stopped: false,
      composedPath: () => [el],
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {
        this.stopped = true;
      },
      ...props
    };
    return e;
  }

  const api = {
    win,
    doc,
    chrome,
    ctrl,
    overlay,
    sent,
    el,
    timers,
    frames,
    advance(ms) {
      clock += ms;
    },
    runTimers() {
      for (const fn of timers.splice(0)) fn();
    },
    stepFrame(ms = 16) {
      clock += ms;
      const batch = [...frames.entries()];
      frames.clear();
      for (const [, fn] of batch) fn(clock);
    },
    down(x, y, props) {
      return win.fire('pointerdown', ev({ button: 2, buttons: 2, clientX: x, clientY: y, ...props }));
    },
    move(x, y, props) {
      return win.fire('pointermove', ev({ button: -1, buttons: 2, clientX: x, clientY: y, ...props }));
    },
    up(x, y, props) {
      return win.fire('pointerup', ev({ button: 2, buttons: 0, clientX: x, clientY: y, ...props }));
    },
    mouse(type, x, y, props) {
      return win.fire(type, ev({ button: 2, buttons: type === 'mousedown' ? 2 : 0, clientX: x, clientY: y, ...props }));
    },
    menu(props) {
      return win.fire('contextmenu', ev({ button: 2, buttons: 0, ...props }));
    },
    executes() {
      return sent.filter((m) => m.type === 'execute-gesture');
    },
    async ready() {
      await settle();
      assert.equal(ctrl.loaded, true);
    },
    async drag(points, releaseAt) {
      const [x0, y0] = points[0];
      api.down(x0, y0);
      for (const [x, y] of points.slice(1)) api.move(x, y);
      const [rx, ry] = releaseAt || points[points.length - 1];
      api.up(rx, ry);
      api.mouse('mouseup', rx, ry);
      await settle();
    }
  };
  return api;
}

test('C01: 右ボタンを離した時だけ 1 回実行する', async () => {
  const t = setup();
  await t.ready();
  t.down(100, 100);
  for (let x = 102; x <= 200; x += 2) t.move(x, 100);
  assert.equal(t.executes().length, 0, '描いている途中では実行しない');
  assert.ok(t.sent.some((m) => m.type === 'prepare-gesture'), '押下時に Service Worker を起こす');
  t.up(200, 100);
  t.mouse('mouseup', 200, 100);
  await settle();
  const ex = t.executes();
  assert.equal(ex.length, 1);
  assert.equal(ex[0].gesture, 'R');
  assert.equal(ex[0].action, 'next-tab');
  assert.match(ex[0].gestureId, UUID_V4);
});

test('C02: pointerup → mouseup、 mouseup → 遅延 pointerup のどちらでも 1 回', async () => {
  const t = setup();
  await t.ready();
  t.down(0, 0);
  t.move(-80, 0);
  t.up(-80, 0);
  t.mouse('mouseup', -80, 0);
  await settle();
  assert.equal(t.executes().length, 1);

  // pointerup が届かず mouseup だけ → 完了。 後から遅れて pointerup
  t.down(0, 0);
  t.move(80, 0);
  t.mouse('mouseup', 90, 0);
  t.up(90, 0);
  await settle();
  assert.equal(t.executes().length, 2);
  assert.equal(t.executes()[1].gesture, 'R');
});

test('C03: 互換 mousedown が届いても記録をやり直さない', async () => {
  const t = setup();
  await t.ready();
  t.down(0, 0);
  t.move(0, 60);
  t.mouse('mousedown', 0, 60);
  t.move(60, 60);
  t.up(60, 60);
  await settle();
  assert.equal(t.executes()[0].gesture, 'DR');
});

test('C04: 最終方向が解放位置だけで届いても判定する (A10)', async () => {
  const t = setup();
  await t.ready();
  t.down(0, 0);
  t.move(0, 80);
  t.up(90, 80);
  await settle();
  assert.equal(t.executes()[0].gesture, 'DR');
});

test('C05: 12 種類を方向順で送る (A01)', async () => {
  const gestures = { L: 'go-back', R: 'go-forward', U: 'reload', D: 'new-tab', DR: 'close-tab', DL: 'duplicate-tab', UR: 'toggle-pin', UL: 'hard-reload', RU: 'restore-closed', RD: 'close-window', LU: 'previous-tab', LD: 'next-tab' };
  const t = setup({ storage: { gestures } });
  await t.ready();
  const vec = { L: [-90, 0], R: [90, 0], U: [0, -90], D: [0, 90] };
  for (const id of C.GESTURES) {
    const pts = [[400, 400]];
    for (const d of id) {
      const [x, y] = pts[pts.length - 1];
      pts.push([x + vec[d][0], y + vec[d][1]]);
    }
    await t.drag(pts);
  }
  const ex = t.executes();
  assert.deepEqual(ex.map((m) => m.gesture), [...C.GESTURES]);
  assert.deepEqual(ex.map((m) => m.action), C.GESTURES.map((g) => gestures[g]));
});

test('C06: 中止 (Esc・blur・非表示・pagehide・全画面・設定変更) の後の解放で実行しない', async () => {
  const cases = {
    escape: (t) => t.win.fire('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} }),
    blur: (t) => {
      t.doc.focused = false;
      t.win.fire('blur', { target: t.win });
      t.runTimers();
    },
    hidden: (t) => {
      t.doc.visibilityState = 'hidden';
      t.doc.fire('visibilitychange', {});
    },
    pagehide: (t) => t.win.fire('pagehide', {}),
    fullscreen: (t) => t.doc.fire('fullscreenchange', {}),
    settings: (t) => t.chrome.storage.onChanged.emit({ wrapTabs: { newValue: false } }, 'local'),
    pointercancel: (t) => t.win.fire('pointercancel', { pointerId: 1 }),
    buttons: (t) => t.move(150, 0, { buttons: 3 }),
    extraButton: (t) => t.win.fire('mousedown', { isTrusted: true, button: 0, buttons: 3 })
  };
  for (const [name, abort] of Object.entries(cases)) {
    const t = setup();
    await t.ready();
    t.down(0, 0);
    t.move(100, 0);
    abort(t);
    assert.equal(t.ctrl.session, null, name);
    t.move(120, 0);
    t.up(120, 0);
    t.mouse('mouseup', 120, 0);
    await settle();
    assert.equal(t.executes().length, 0, name);
  }
});

test('C07: 子要素の blur・iframe へのフォーカス移動・lostpointercapture だけでは中止しない', async () => {
  const t = setup();
  await t.ready();
  t.down(0, 0);
  t.move(100, 0);
  t.win.fire('blur', { target: {} });
  t.doc.focused = true;
  t.win.fire('blur', { target: t.win });
  t.runTimers();
  t.win.fire('lostpointercapture', { pointerId: 1 });
  assert.ok(t.ctrl.session);
  t.up(100, 0);
  await settle();
  assert.equal(t.executes().length, 1);
});

test('C08: Pointer Capture がない状態でページ外へ出たら中止。 ある時は中止しない', async () => {
  const t = setup();
  await t.ready();
  t.down(0, 0);
  assert.equal(t.el.hasPointerCapture(1), true, '押下した元の要素へ設定する');
  t.move(100, 0);
  t.win.fire('pointerout', { pointerId: 1, relatedTarget: null });
  assert.ok(t.ctrl.session);
  t.win.fire('lostpointercapture', { pointerId: 1 });
  t.win.fire('pointerout', { pointerId: 1, relatedTarget: null });
  assert.equal(t.ctrl.session, null);
});

test('C09: 中止時と完了時に Pointer Capture を解放する', async () => {
  const t = setup();
  await t.ready();
  t.down(0, 0);
  t.move(60, 0);
  t.win.fire('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(t.el.hasPointerCapture(1), false);
});

test('C10: 通常の右クリック・手ぶれ・斜めだけではメニューを抑制しない', async () => {
  for (const pts of [[[10, 10]], [[10, 10], [13, 12]], [[10, 10], [80, 80]]]) {
    const t = setup();
    await t.ready();
    await t.drag(pts);
    const e = t.menu();
    assert.equal(e.defaultPrevented, false, JSON.stringify(pts));
    assert.equal(t.executes().length, 0);
  }
});

test('C11: 認識したドラッグはメニューを抑制する (未割り当ても含む)', async () => {
  const t = setup();
  await t.ready();
  await t.drag([[0, 0], [0, -90]]); // U は未割り当て
  assert.equal(t.executes()[0].action, 'none');
  assert.equal(t.menu().defaultPrevented, true);
  // 次の右クリックやキーボードのメニューを妨げない
  assert.equal(t.menu().defaultPrevented, false);
  await t.drag([[0, 0], [90, 0]]);
  t.advance(700);
  assert.equal(t.menu().defaultPrevented, false, '600ms を過ぎたら抑制しない');
});

test('C12: 認識後に中止したドラッグの遅延メニューは短時間抑制。 新しい右クリックでリセット', async () => {
  const t = setup();
  await t.ready();
  t.down(0, 0);
  t.move(90, 0);
  t.win.fire('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  t.advance(1500);
  t.up(90, 0);
  t.mouse('mouseup', 90, 0);
  assert.equal(t.menu().defaultPrevented, true);

  t.down(0, 0);
  t.move(90, 0);
  t.win.fire('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  t.down(5, 5, { pointerId: 1 }); // 解放を取りこぼした後の新しい右クリック
  t.up(5, 5);
  assert.equal(t.menu().defaultPrevented, false);
});

test('C13: 不正な経路は実行しないが、 認識済みならメニューは抑制する (A08)', async () => {
  const t = setup();
  await t.ready();
  await t.drag([[0, 0], [0, 90], [90, 90], [90, 0]]);
  assert.equal(t.executes().length, 0);
  assert.equal(t.menu().defaultPrevented, true);
  await t.drag([[0, 0], [90, 0], [0, 0]]);
  assert.equal(t.executes().length, 0);
});

test('C14: isTrusted でない入力・別の pointerId・右以外のボタンは扱わない', async () => {
  const t = setup();
  await t.ready();
  t.down(0, 0, { isTrusted: false });
  assert.equal(t.ctrl.session, null);
  t.down(0, 0, { button: 0, buttons: 1 });
  assert.equal(t.ctrl.session, null);
  t.down(0, 0, { buttons: 3 });
  assert.equal(t.ctrl.session, null, '右ボタン単独のみ');
  t.down(0, 0, { pointerType: 'touch' });
  assert.equal(t.ctrl.session, null);
  t.down(0, 0, { pointerType: 'pen' });
  assert.ok(t.ctrl.session, 'ペンの右ボタンは受け付ける');
  t.move(90, 0, { pointerId: 7 });
  t.up(90, 0, { pointerId: 7 });
  assert.ok(t.ctrl.session);
  t.move(90, 0, { isTrusted: false });
  t.up(90, 0, { isTrusted: false });
  assert.ok(t.ctrl.session);
  t.up(0, 0);
  await settle();
  assert.equal(t.executes().length, 0, '偽の移動は経路に入らない');
});

test('C15: 設定の読み込み前・無効時は認識しない', async () => {
  const hold = deferred();
  const t = setup({ get: () => hold.promise.then(() => ({ enabled: false })) });
  t.down(0, 0);
  assert.equal(t.ctrl.session, null);
  hold.resolve();
  await settle();
  t.down(0, 0);
  assert.equal(t.ctrl.session, null);
});

test('C16: 読み込み中に届いた変更を古い読み込み結果で取り消さない', async () => {
  const hold = deferred();
  const t = setup({ get: () => hold.promise.then(() => ({ enabled: true, gestures: { R: 'next-tab' } })) });
  t.chrome.storage.onChanged.emit({ gestures: { newValue: { R: 'close-tab' } } }, 'local');
  hold.resolve();
  await settle();
  assert.equal(t.ctrl.settings.gestures.R, 'close-tab');
});

test('C17: 40 回の連続操作で別々の ID を送る (A13)', async () => {
  const t = setup();
  await t.ready();
  for (let i = 0; i < 40; i += 1) await t.drag(i % 2 ? [[300, 300], [200, 300]] : [[300, 300], [400, 300]]);
  const ex = t.executes();
  assert.equal(ex.length, 40);
  assert.equal(new Set(ex.map((m) => m.gestureId)).size, 40);
  assert.deepEqual(ex.slice(0, 4).map((m) => m.gesture), ['R', 'L', 'R', 'L']);
});

test('C18: randomUUID のない HTTP ページでも UUID v4 を作る (A15)', async () => {
  const insecureCrypto = { getRandomValues: (a) => webcrypto.getRandomValues(a) };
  const t = setup({ crypto: insecureCrypto });
  await t.ready();
  await t.drag([[0, 0], [90, 0]]);
  assert.match(t.executes()[0].gestureId, UUID_V4);
});

test('C19: 軌跡・ガイドの表示内容と切り替え', async () => {
  const t = setup({ storage: { gestures: { DR: 'close-tab' } } });
  await t.ready();
  t.down(0, 0);
  assert.deepEqual(t.overlay.renders.at(-1).trail, [{ x: 0, y: 0 }], '押下直後から始点の点');
  assert.equal(t.overlay.renders.at(-1).guide, null);
  t.move(0, 80);
  t.move(80, 80);
  const view = t.overlay.renders.at(-1);
  assert.equal(view.guide.shape, '下→右');
  assert.equal(view.guide.action, 'タブを閉じる');
  assert.equal(view.guide.hint, '右ボタンを離すと実行 · Escで中止');
  assert.equal(view.trail.length, 3);
  t.move(80, 0); // 2 回目の曲がり
  const invalid = t.overlay.renders.at(-1);
  assert.equal(invalid.guide, null, '候補ガイドを消す');
  assert.equal(invalid.invalid, true);
  assert.equal(invalid.trail.length, 3, '直前の 2 辺を残す');
  t.up(80, 0);

  const off = setup({ storage: { showTrail: false, showFeedback: true, language: 'en', textSize: 'large' } });
  await off.ready();
  off.down(0, 0);
  off.move(90, 0);
  const v2 = off.overlay.renders.at(-1);
  assert.equal(v2.trail, null);
  assert.equal(v2.guide.shape, 'Right');
  assert.equal(v2.guide.action, 'Next tab');
  assert.equal(v2.textSize, 'large');

  const none = setup({ storage: { showTrail: false, showFeedback: false } });
  await none.ready();
  none.down(0, 0);
  none.move(90, 0);
  assert.equal(none.overlay.renders.length, 0);
  none.up(90, 0);
  await settle();
  assert.equal(none.executes().length, 1, '表示を消しても認識は動く');
});

test('C20: 失敗の通知は操作ガイドがオンの時だけ短く表示する', async () => {
  const respond = (msg) => (msg.type === 'execute-gesture' ? { ok: false, reason: 'single-tab', messageKey: 'reason.single-tab' } : { ok: true });
  const t = setup({ respond });
  await t.ready();
  await t.drag([[0, 0], [90, 0]]);
  assert.equal(t.overlay.notices.length, 1);
  assert.equal(t.overlay.notices[0].text, 'このウィンドウのタブは1つだけです');
  assert.equal(t.overlay.notices[0].view.ms, 3500);

  const quiet = setup({ respond, storage: { showFeedback: false } });
  await quiet.ready();
  await quiet.drag([[0, 0], [90, 0]]);
  assert.equal(quiet.overlay.notices.length, 0);

  const dup = setup({ respond: (m) => (m.type === 'execute-gesture' ? { ok: false, reason: 'duplicate' } : { ok: true }) });
  await dup.ready();
  await dup.drag([[0, 0], [90, 0]]);
  assert.equal(dup.overlay.notices.length, 0, '重複は表示しない');
});

test('C21: 接続確認に版と準備状態を返す', async () => {
  const t = setup();
  await t.ready();
  let reply = null;
  t.chrome.runtime.onMessage.emit({ type: 'gesture-ping' }, { id: EXT_ID }, (r) => {
    reply = r;
  });
  assert.deepEqual(reply, { ok: true, version: '3.6.0', ready: true, readyState: 'complete', contentType: 'text/html' });
  let other = null;
  t.chrome.runtime.onMessage.emit({ type: 'gesture-ping' }, { id: 'other' }, (r) => {
    other = r;
  });
  assert.equal(other, null, '他の拡張機能には応答しない');
});

test('C22: 別フレームからのメニュー抑制通知', async () => {
  const t = setup();
  await t.ready();
  t.chrome.runtime.onMessage.emit({ type: 'gesture-menu-guard', token: 'other-frame', ms: 5000 }, { id: EXT_ID }, () => {});
  assert.equal(t.menu().defaultPrevented, true);
  // 自分の通知は無視
  t.chrome.runtime.onMessage.emit({ type: 'gesture-menu-guard', token: t.ctrl.token, ms: 5000 }, { id: EXT_ID }, () => {});
  assert.equal(t.menu().defaultPrevented, false);
  // 認識したら同じタブの他のフレームへ知らせる
  await t.drag([[0, 0], [90, 0]]);
  const guards = t.sent.filter((m) => m.type === 'menu-guard');
  assert.deepEqual(guards.map((g) => g.ms), [5000, 600]);
});

test('C23: 破棄でイベントリスナーを外し、 再注入で重複しない (A26)', async () => {
  const t = setup();
  await t.ready();
  const winCount = t.win.listenerCount();
  assert.ok(winCount > 0);
  t.ctrl.destroy();
  assert.equal(t.win.listenerCount(), 0);
  assert.equal(t.doc.listenerCount(), 0);
  assert.equal(t.chrome.runtime.onMessage.size, 0);
  assert.equal(t.chrome.storage.onChanged.size, 0);
  t.down(0, 0);
  assert.equal(t.ctrl.session, null);
});

test('C24: 拡張機能の更新で無効になった古い処理は停止する', async () => {
  const t = setup();
  await t.ready();
  t.doc.fire(TAKEOVER_EVENT, {});
  assert.equal(t.ctrl.destroyed, false, '有効な実行環境は残る');
  delete t.chrome.runtime.id;
  t.doc.fire(TAKEOVER_EVENT, {});
  assert.equal(t.ctrl.destroyed, true);
});

function relayTo(from, to) {
  for (const m of from.sent.splice(0)) {
    if (m.type === 'gesture-relay') to.chrome.runtime.onMessage.emit({ ...m }, { id: EXT_ID }, () => {});
  }
}

test('C26: 別オリジンの iframe へ入ったドラッグは移動量と解放を中継して完了する', async () => {
  const parent = setup();
  const child = setup();
  await parent.ready();
  await child.ready();
  parent.down(400, 200);
  parent.move(500, 200);
  // ここから先のイベントは子フレームにだけ届く
  child.move(10, 50);
  child.move(10, 90);
  child.move(10, 150);
  child.up(10, 150);
  child.mouse('mouseup', 10, 150);
  const relays = child.sent.filter((m) => m.type === 'gesture-relay');
  assert.ok(relays.length >= 2);
  assert.equal(relays.at(-1).kind, 'up');
  assert.deepEqual(relays.at(-1).points.at(-1), [0, 100], '入った位置からの移動量');
  relayTo(child, parent);
  await settle();
  const ex = parent.executes();
  assert.equal(ex.length, 1, '解放を取りこぼさず 1 回だけ');
  assert.equal(ex[0].gesture, 'RD');
  assert.equal(parent.ctrl.session, null);
  assert.equal(child.executes().length, 0);
  assert.equal(parent.el.hasPointerCapture(1), false, 'Pointer Capture を解放');
});

test('C27: 中継の古い移動・自分の中継・中止後の移動は使わない', async () => {
  const parent = setup();
  const child = setup();
  await parent.ready();
  await child.ready();
  parent.down(400, 200);
  parent.move(500, 200);
  child.move(10, 50);
  child.move(10, 150);
  const stale = child.sent.filter((m) => m.type === 'gesture-relay').map((m) => ({ ...m }));
  child.sent.length = 0;
  parent.advance(50);
  parent.move(600, 200); // 親へ戻った後の自分の移動が新しい
  for (const m of stale) parent.chrome.runtime.onMessage.emit(m, { id: EXT_ID }, () => {});
  parent.chrome.runtime.onMessage.emit({ type: 'gesture-relay', token: parent.ctrl.token, kind: 'up', points: [[0, 300]], at: 99999 }, { id: EXT_ID }, () => {});
  assert.ok(parent.ctrl.session, '古い中継と自分の中継は無視');
  parent.up(600, 200);
  await settle();
  assert.equal(parent.executes()[0].gesture, 'R');

  // 中止したドラッグの続きは中継しない
  child.down(0, 0);
  child.move(90, 0);
  child.win.fire('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  child.sent.length = 0;
  child.move(150, 0);
  child.up(150, 0);
  assert.equal(child.sent.filter((m) => m.type === 'gesture-relay').length, 0);
  // 無効の時も中継しない
  const off = setup({ storage: { enabled: false } });
  await off.ready();
  off.move(10, 10);
  off.up(10, 10);
  assert.equal(off.sent.filter((m) => m.type === 'gesture-relay').length, 0);
});

test('C28: document.open() でリスナーが消えても付け直す', async () => {
  let observerCallback = null;
  class FakeObserver {
    constructor(cb) {
      observerCallback = cb;
    }
    observe() {}
    disconnect() {
      observerCallback = null;
    }
  }
  const t = setup({ win: { MutationObserver: FakeObserver } });
  await t.ready();
  const count = t.win.listenerCount();
  t.win.eraseAll();
  t.doc.eraseAll();
  assert.equal(t.win.listenerCount(), 0);
  observerCallback([]);
  assert.equal(t.win.listenerCount(), count);
  await t.drag([[0, 0], [90, 0]]);
  assert.equal(t.executes().length, 1);
  observerCallback([]);
  assert.equal(t.win.listenerCount(), count, '重複して登録しない');
  t.ctrl.destroy();
  assert.equal(observerCallback, null, '破棄で監視をやめる');
});

test('C25: 押している間に別のポインターが押されたら中止', async () => {
  const t = setup();
  await t.ready();
  t.down(0, 0);
  t.move(90, 0);
  t.win.fire('pointerdown', { isTrusted: true, pointerId: 2, button: 0, buttons: 1, pointerType: 'pen' });
  assert.equal(t.ctrl.session, null);
});

test('C29: 認識したドラッグでは右ボタンの auxclick も抑制し、 通常右クリックや中クリックは妨げない', async () => {
  const t = setup();
  await t.ready();
  const aux = (button = 2) => {
    const e = {
      isTrusted: true,
      button,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {
        this.stopped = true;
      }
    };
    return t.win.fire('auxclick', e);
  };
  // 通常の右クリックでは抑制しない
  await t.drag([[10, 10]]);
  assert.equal(aux(2).defaultPrevented, false);
  assert.equal(t.menu().defaultPrevented, false);

  // 認識したドラッグ: auxclick → contextmenu の順でも両方抑制する
  await t.drag([[0, 0], [90, 0]]);
  assert.equal(aux(1).defaultPrevented, false, '中クリックは抑制しない');
  assert.equal(aux(2).defaultPrevented, true, '右ボタンの auxclick を抑制');
  assert.equal(t.menu().defaultPrevented, true, 'contextmenu も抑制');

  // contextmenu → auxclick の順でも両方抑制する
  await t.drag([[0, 0], [90, 0]]);
  assert.equal(t.menu().defaultPrevented, true);
  assert.equal(aux(2).defaultPrevented, true);
});

test('C30: pointerup の直前に buttons=0 の pointermove が来ても解放で実行し、 解放が来ない場合だけ中止する', async () => {
  const t = setup();
  await t.ready();
  t.down(0, 0);
  t.move(90, 0);
  t.move(95, 0, { buttons: 0 });
  assert.ok(t.ctrl.session, '即中止せず短時間待つ');
  t.up(95, 0);
  await settle();
  assert.equal(t.executes().length, 1);
  assert.equal(t.executes()[0].gesture, 'R');
  // 完了後に猶予タイマーが走っても影響しない
  t.runTimers();
  assert.equal(t.executes().length, 1);

  // 画面外で離して pointerup が来ないまま戻ってきた場合は猶予満了で中止する
  t.down(0, 0);
  t.move(90, 0);
  t.move(95, 0, { buttons: 0 });
  t.runTimers();
  assert.equal(t.ctrl.session, null);
  t.up(95, 0);
  await settle();
  assert.equal(t.executes().length, 1);
});

test('C31: pointerup / mouseup が欠落しても auxclick や解放時 contextmenu で代替完了する', async () => {
  const t = setup();
  await t.ready();
  // auxclick (button=2, buttons=0) による代替完了
  t.down(0, 0);
  t.move(90, 0);
  const auxEv = { isTrusted: true, button: 2, buttons: 0, clientX: 90, clientY: 0, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  t.win.fire('auxclick', auxEv);
  await settle();
  assert.equal(t.executes().length, 1);
  assert.equal(t.executes()[0].gesture, 'R');
  assert.equal(auxEv.defaultPrevented, true);

  // 押下時の contextmenu (buttons=2: Linux/macOS 型) では完了させない
  t.down(0, 0);
  t.move(-90, 0);
  const pressMenu = t.menu({ buttons: 2, clientX: -90, clientY: 0 });
  assert.equal(pressMenu.defaultPrevented, true);
  assert.ok(t.ctrl.session, '押下中の contextmenu では完了しない');
  // 解放時の contextmenu (buttons=0: Windows 型) だけ届いた場合は完了させる
  const releaseMenu = t.menu({ buttons: 0, clientX: -90, clientY: 0 });
  await settle();
  assert.equal(releaseMenu.defaultPrevented, true);
  assert.equal(t.ctrl.session, null);
  assert.equal(t.executes().length, 2);
  assert.equal(t.executes()[1].gesture, 'L');
});

test('C32: 移動なしで別フレーム上に直接離された解放と微小な時刻ずれを正しく中継・完了する', async () => {
  const parent = setup();
  const child = setup();
  await parent.ready();
  await child.ready();
  parent.down(400, 200);
  parent.move(520, 200);
  // 子フレーム側で pointermove を経ずに pointerup だけ発生 (さらに 5ms だけ古い時刻)
  parent.advance(5);
  child.up(20, 40);
  child.mouse('mouseup', 20, 40);
  const relays = child.sent.filter((m) => m.type === 'gesture-relay');
  assert.equal(relays.length, 1, '互換 mouseup で二重中継しない');
  assert.equal(relays[0].kind, 'up');
  assert.deepEqual(relays[0].points, []);
  relayTo(child, parent);
  await settle();
  assert.equal(parent.executes().length, 1);
  assert.equal(parent.executes()[0].gesture, 'R');
});

test('C33: Pointer Capture 喪失後に iframe 上へ出た pointerout では中止しない', async () => {
  const iframeNode = { tagName: 'IFRAME' };
  const t = setup({ doc: { elementFromPoint: () => iframeNode } });
  await t.ready();
  t.down(100, 100);
  t.move(200, 100);
  t.win.fire('lostpointercapture', { pointerId: 1 });
  t.win.fire('pointerout', { pointerId: 1, relatedTarget: null, clientX: 250, clientY: 100 });
  assert.ok(t.ctrl.session, 'iframe 上なら継続する');
  t.up(250, 100);
  await settle();
  assert.equal(t.executes().length, 1);
});

test('C34: 認識後だけイベントシールドを有効化し、 完了・中止で確実に解除する', async () => {
  const t = setup();
  await t.ready();
  // 通常右クリックではシールドを張らない
  await t.drag([[10, 10]]);
  assert.equal(t.overlay.shields.includes(true), false);

  // 認識したら有効化し、 完了で解除
  t.overlay.shields.length = 0;
  t.down(0, 0);
  t.move(90, 0);
  assert.equal(t.overlay.shields.at(-1), true);
  t.up(90, 0);
  assert.equal(t.overlay.shields.at(-1), false);

  // 中止でも解除
  t.overlay.shields.length = 0;
  t.down(0, 0);
  t.move(90, 0);
  assert.equal(t.overlay.shields.at(-1), true);
  t.win.fire('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(t.overlay.shields.at(-1), false);
});

test('C35: Service Worker 通信の一時失敗時は同じ gestureId で自動再送する', async () => {
  let execAttempts = 0;
  const t = setup({
    send(msg) {
      if (msg.type === 'execute-gesture') {
        execAttempts += 1;
        if (execAttempts === 1) return Promise.reject(new Error('Could not establish connection'));
        return Promise.resolve({ ok: true, action: msg.action });
      }
      return Promise.resolve({ ok: true });
    }
  });
  await t.ready();
  await t.drag([[0, 0], [90, 0]]);
  assert.equal(execAttempts, 1);
  t.runTimers();
  await settle();
  assert.equal(execAttempts, 2);
  const ex = t.executes();
  assert.equal(ex.length, 2);
  assert.equal(ex[0].gestureId, ex[1].gestureId, '同じ gestureId で冪等に再送する');
});

test('C36: 上下左右 4 方向の連続スクロール (押下中のみ連続実行し、 離すと即停止・離した時の追加実行なし)', async () => {
  const scrollCalls = [];
  const rootEl = { scrollHeight: 3000, clientHeight: 800, scrollTop: 500, scrollWidth: 2500, clientWidth: 1000, scrollLeft: 400 };
  const t = setup({
    storage: { gestures: { U: 'scroll-up', D: 'scroll-down', L: 'scroll-left', R: 'scroll-right' } },
    win: {
      innerHeight: 800,
      innerWidth: 1000,
      scrollBy(opts) {
        scrollCalls.push(opts);
        rootEl.scrollLeft += opts.left;
        rootEl.scrollTop += opts.top;
      }
    },
    doc: { scrollingElement: rootEl }
  });
  await t.ready();

  // 下へドラッグして押したままにすると複数フレームで連続スクロールする
  t.down(200, 200);
  t.move(200, 320);
  assert.equal(t.ctrl.scrolling, true);
  assert.equal(t.overlay.renders.at(-1).guide.hint, '右ボタンを離すと停止 · Escで中止');
  t.stepFrame(50);
  t.stepFrame(50);
  t.stepFrame(50);
  assert.equal(scrollCalls.length, 3, '押している間は毎フレーム進み続ける');
  assert.ok(scrollCalls.every((c) => c.left === 0 && c.top > 0 && c.behavior === 'instant'));
  const totalBeforeUp = scrollCalls.reduce((sum, c) => sum + c.top, 0);
  assert.ok(totalBeforeUp > 50);

  // 右ボタンを離すと即停止し、 離した時の追加スクロールも execute-gesture も起きない
  t.up(200, 320);
  t.mouse('mouseup', 200, 320);
  await settle();
  assert.equal(t.ctrl.scrolling, false);
  assert.equal(t.frames.size, 0, '解放時に rAF を解除する');
  assert.equal(scrollCalls.length, 3, '離した時に追加スクロールしない');
  assert.equal(t.executes().length, 0, 'スクロールは execute-gesture を送らない');
  assert.equal(t.menu().defaultPrevented, true, '離した直後のコンテキストメニューは抑制する');
  t.stepFrame(50);
  assert.equal(scrollCalls.length, 3, '解放後のフレーム経過でも動かない');

  // 上・右・左の各方向も押下中だけ連続スクロールする
  for (const [to, axis, sign] of [
    [[200, 80], 'top', -1],
    [[320, 200], 'left', 1],
    [[80, 200], 'left', -1]
  ]) {
    scrollCalls.length = 0;
    t.down(200, 200);
    t.move(to[0], to[1]);
    t.stepFrame(50);
    t.stepFrame(50);
    assert.equal(scrollCalls.length, 2);
    assert.ok(scrollCalls.every((c) => Math.sign(c[axis]) === sign && c[axis === 'top' ? 'left' : 'top'] === 0 && c.behavior === 'instant'));
    t.up(to[0], to[1]);
    await settle();
    assert.equal(scrollCalls.length, 2, '解放で増えない');
  }

  // 英語表示の操作ガイド文言
  const en = setup({
    storage: { language: 'en', gestures: { D: 'scroll-down' } },
    win: { innerHeight: 800, innerWidth: 1000, scrollBy() {} },
    doc: { scrollingElement: { ...rootEl } }
  });
  await en.ready();
  en.down(200, 200);
  en.move(200, 300);
  assert.equal(en.overlay.renders.at(-1).guide.hint, 'Release the right button to stop · Esc to cancel');
  en.up(200, 300);
});

test('C37: 内側コンテナ連続スクロール・形変更時の切替/停止・各種中止・長押し時のメニューガード延長', async () => {
  const rootEl = { scrollHeight: 3000, clientHeight: 800, scrollTop: 500, scrollWidth: 2500, clientWidth: 1000, scrollLeft: 400 };
  const containerCalls = [];
  const box = {
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 0,
    scrollWidth: 1000,
    clientWidth: 300,
    scrollLeft: 0,
    parentElement: rootEl,
    scrollBy(opts) {
      containerCalls.push(opts);
      this.scrollLeft += opts.left;
      this.scrollTop += opts.top;
    }
  };
  const child = { parentElement: box, setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false };
  const winCalls = [];
  const t = setup({
    storage: { gestures: { D: 'scroll-down', DR: 'close-tab', DL: 'scroll-left', R: 'next-tab' } },
    win: {
      innerHeight: 800,
      innerWidth: 1000,
      getComputedStyle: (n) => (n === box ? { overflowY: 'auto', overflowX: 'auto', direction: 'ltr' } : { overflowY: 'visible', overflowX: 'visible', direction: 'ltr' }),
      scrollBy(opts) {
        winCalls.push(opts);
      }
    },
    doc: { scrollingElement: rootEl }
  });
  await t.ready();

  // 内側スクロールコンテナが優先され、 離すまで連続スクロールする
  t.down(50, 50, { target: child, composedPath: () => [child, box, rootEl] });
  t.move(50, 150, { target: child, composedPath: () => [child, box, rootEl] });
  t.stepFrame(50);
  t.stepFrame(50);
  assert.equal(containerCalls.length, 2);
  assert.ok(containerCalls.every((c) => c.top > 0 && c.left === 0 && c.behavior === 'instant'));
  assert.equal(winCalls.length, 0, '内側コンテナが動く時は window を動かさない');
  t.up(50, 150, { target: child, composedPath: () => [child, box, rootEl] });
  await settle();
  assert.equal(containerCalls.length, 2);

  // D (scroll-down) → DR (close-tab) へ曲がると即スクロール停止し、 離すと close-tab を 1 回実行する
  winCalls.length = 0;
  t.down(200, 200);
  t.move(200, 300);
  t.stepFrame(50);
  assert.equal(winCalls.length, 1);
  assert.equal(t.ctrl.scrolling, true);
  t.move(300, 300); // DR -> close-tab
  assert.equal(t.ctrl.scrolling, false, '非スクロール形へ変わったら即停止');
  assert.equal(t.overlay.renders.at(-1).guide.hint, '右ボタンを離すと実行 · Escで中止');
  t.stepFrame(50);
  assert.equal(winCalls.length, 1);
  t.up(300, 300);
  await settle();
  assert.equal(t.executes().length, 1);
  assert.equal(t.executes()[0].gesture, 'DR');
  assert.equal(t.executes()[0].action, 'close-tab');

  // D (scroll-down) → DL (scroll-left) へ曲がると横スクロールへ切り替わる
  winCalls.length = 0;
  t.down(200, 200);
  t.move(200, 300);
  t.stepFrame(50);
  assert.ok(winCalls.at(-1).top > 0);
  t.move(100, 300); // DL -> scroll-left
  t.stepFrame(50);
  assert.ok(winCalls.at(-1).left < 0 && winCalls.at(-1).top === 0, '方向切替で横スクロールへ移る');
  // 折り返しで無効化したら即停止
  t.move(200, 300);
  assert.equal(t.ctrl.scrolling, false);
  const countAfterInvalid = winCalls.length;
  t.stepFrame(50);
  assert.equal(winCalls.length, countAfterInvalid);
  t.up(200, 300);

  // Esc・buttons=0 猶予・長押しメニューガード延長
  winCalls.length = 0;
  t.down(200, 200);
  t.move(200, 300);
  const guardsBefore = t.sent.filter((m) => m.type === 'menu-guard').length;
  t.advance(3100);
  t.stepFrame(50);
  assert.ok(t.sent.filter((m) => m.type === 'menu-guard').length > guardsBefore, '長押し中も menu-guard を延長する');
  // buttons=0 の pointermove が先に来たら猶予中でもスクロール自体は即停止する
  t.move(200, 305, { buttons: 0 });
  assert.equal(t.ctrl.scrolling, false);
  t.win.fire('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(t.ctrl.session, null);
  assert.equal(t.ctrl.scrolling, false);
});

test('C38: サブフレームからの連続スクロールフォールバック開始・延長・停止とトップフレーム側の安全期限停止', async () => {
  const topCalls = [];
  const topRoot = { scrollHeight: 3000, clientHeight: 800, scrollTop: 500, scrollWidth: 2500, clientWidth: 1000, scrollLeft: 400 };
  const top = setup({
    storage: { gestures: { D: 'scroll-down' } },
    win: {
      innerHeight: 800,
      innerWidth: 1000,
      scrollBy(opts) {
        topCalls.push(opts);
        topRoot.scrollLeft += opts.left;
        topRoot.scrollTop += opts.top;
      }
    },
    doc: { scrollingElement: topRoot }
  });
  const sub = setup({
    storage: { gestures: { D: 'scroll-down' } },
    win: { top: {}, innerHeight: 300, innerWidth: 300 },
    doc: { scrollingElement: { scrollHeight: 300, clientHeight: 300, scrollTop: 0, scrollWidth: 300, clientWidth: 300, scrollLeft: 0 } }
  });
  await top.ready();
  await sub.ready();

  let forwarded = 0;
  const relayScroll = () => {
    const msgs = sub.sent.filter((m) => m.type === 'scroll-top-frame');
    while (forwarded < msgs.length) {
      const m = msgs[forwarded++];
      const payload = m.mode === 'start'
        ? { type: 'gesture-scroll', mode: 'start', action: m.action, token: m.token }
        : { type: 'gesture-scroll', mode: 'stop', token: m.token };
      top.chrome.runtime.onMessage.emit(payload, { id: EXT_ID }, () => {});
    }
  };

  // 子フレームで押下・ドラッグすると start が送られ、 トップフレームが連続スクロールする
  sub.down(50, 50);
  sub.move(50, 150);
  relayScroll();
  assert.equal(top.ctrl.scrolling, true);
  top.stepFrame(50);
  top.stepFrame(50);
  assert.equal(topCalls.length, 2);
  assert.ok(topCalls.every((c) => c.top > 0 && c.behavior === 'instant'));

  // 押し続けると子フレームから延長 (keepalive) が送られる
  const startsBefore = sub.sent.filter((m) => m.type === 'scroll-top-frame' && m.mode === 'start').length;
  sub.stepFrame(260);
  assert.equal(sub.sent.filter((m) => m.type === 'scroll-top-frame' && m.mode === 'start').length, startsBefore + 1);
  relayScroll();
  top.stepFrame(50);
  assert.equal(topCalls.length, 3);

  // 子フレームで離すと stop が送られ、 トップフレームの連続スクロールが即停止する
  sub.up(50, 150);
  relayScroll();
  assert.equal(sub.ctrl.scrolling, false);
  assert.equal(top.ctrl.scrolling, false);
  top.stepFrame(50);
  assert.equal(topCalls.length, 3, 'stop 後はスクロールしない');

  // stop が届かなくても安全期限 (lease) 超過でトップフレームが自動停止する
  top.chrome.runtime.onMessage.emit({ type: 'gesture-scroll', mode: 'start', action: 'scroll-down', token: 'vanished-iframe' }, { id: EXT_ID }, () => {});
  assert.equal(top.ctrl.scrolling, true);
  top.stepFrame(50);
  assert.equal(topCalls.length, 4);
  top.advance(700);
  top.stepFrame(16);
  assert.equal(top.ctrl.scrolling, false, '延長が途絶えたら自動で止まる');
  assert.equal(topCalls.length, 4);

  // トップフレーム上で直接右ボタン解放または Esc が来た時もリモートスクロールを即停止する
  top.chrome.runtime.onMessage.emit({ type: 'gesture-scroll', mode: 'start', action: 'scroll-down', token: 'sub-2' }, { id: EXT_ID }, () => {});
  assert.equal(top.ctrl.scrolling, true);
  top.up(100, 100);
  assert.equal(top.ctrl.scrolling, false);
});


