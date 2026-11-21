'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const C = require('../extension/config.js');
const { createBackground, originsCover, QUEUE_LIMIT_TOTAL, QUEUE_LIMIT_WINDOW, HISTORY_LIMIT } = require('../extension/background.js');
const { createFakeChrome, deferred, settle } = require('./helpers/fake-chrome.js');

function setup(options = {}) {
  const fake = createFakeChrome(options);
  if (options.beforeRegister) options.beforeRegister(fake);
  const bg = createBackground({
    chrome: fake.chrome,
    navigator: options.navigator || { userAgent: 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36' },
    delay: () => Promise.resolve()
  });
  bg.register();
  return { fake, bg };
}

function threeTabs(fake, windowId = 1) {
  const a = fake.addTab({ windowId, url: 'https://a.example/', active: true });
  const b = fake.addTab({ windowId, url: 'https://b.example/' });
  const c = fake.addTab({ windowId, url: 'https://c.example/' });
  return [a.id, b.id, c.id];
}

function exec(fake, tabId, gesture, extra = {}) {
  return fake.sendRuntime({ type: 'execute-gesture', gesture, gestureId: randomUUID(), ...extra }, fake.contentSender(tabId));
}

function save(fake, settings, seq = 1) {
  return fake.sendRuntime({ type: 'save-settings', settings, seq }, fake.popupSender());
}

test('A02: 初期設定は 左=前、 右=次', async () => {
  const { fake } = setup();
  const [a, b] = threeTabs(fake);
  assert.deepEqual(await exec(fake, a, 'R', { action: 'next-tab' }), { ok: true, action: 'next-tab' });
  assert.equal(fake.activeTab(1).id, b);
  assert.deepEqual(await exec(fake, b, 'L', { action: 'previous-tab' }), { ok: true, action: 'previous-tab' });
  assert.equal(fake.activeTab(1).id, a);
  const r = await exec(fake, a, 'U', { action: 'none' });
  assert.equal(r.reason, 'unassigned');
  assert.equal(r.display, true);
});

test('タブの循環・端・タブ 1 つ', async () => {
  const { fake } = setup();
  const [a, , c] = threeTabs(fake);
  await exec(fake, a, 'L');
  assert.equal(fake.activeTab(1).id, c, '最初の前は最後');
  await exec(fake, c, 'R');
  assert.equal(fake.activeTab(1).id, a, '最後の次は最初');

  await save(fake, { ...C.defaultSettings(), wrapTabs: false });
  const edge = await exec(fake, a, 'L');
  assert.equal(edge.reason, 'tab-edge');
  assert.equal(fake.activeTab(1).id, a);

  const solo = fake.addTab({ windowId: 2, url: 'https://solo.example/', active: true });
  const single = await exec(fake, solo.id, 'R');
  assert.equal(single.reason, 'single-tab');
});

test('固定タブも含めて index 順に移動する', async () => {
  const { fake } = setup();
  const p = fake.addTab({ url: 'https://pinned.example/', pinned: true });
  const a = fake.addTab({ url: 'https://a.example/', active: true });
  await exec(fake, a.id, 'L');
  assert.equal(fake.activeTab(1).id, p.id);
});

test('A13: 左右 40 回の独立した連続操作', async () => {
  const { fake } = setup();
  const [a, b] = threeTabs(fake);
  const ids = new Set();
  for (let i = 0; i < 40; i += 1) {
    const from = fake.activeTab(1).id;
    const gesture = i % 2 === 0 ? 'R' : 'L';
    const gestureId = randomUUID();
    ids.add(gestureId);
    const r = await fake.sendRuntime({ type: 'execute-gesture', gesture, gestureId }, fake.contentSender(from));
    assert.equal(r.ok, true, `${i} 回目`);
    assert.equal(fake.activeTab(1).id, i % 2 === 0 ? b : a);
  }
  assert.equal(ids.size, 40);
  assert.equal(fake.callsOf('tabs.update').length, 40);
});

test('A13: 解放が連続しても busy で捨てずに順番に処理する', async () => {
  const { fake } = setup();
  const [a, b] = threeTabs(fake);
  // 前の要求の処理中に、 新しくアクティブになったタブから次の要求が届く
  const hold = deferred();
  fake.overrides['tabs.update'] = async (args, impl) => {
    const result = await impl(...args);
    await hold.promise;
    return result;
  };
  const results = [];
  results.push(exec(fake, a, 'R'));
  await settle();
  assert.equal(fake.activeTab(1).id, b);
  results.push(exec(fake, b, 'L'));
  await settle();
  hold.resolve();
  const [r1, r2] = await Promise.all(results);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(fake.activeTab(1).id, a);
});

test('A14: tabs.update の応答を保留しても、 逆方向の解放は待機後に実行される', async () => {
  const { fake, bg } = setup();
  const [a, b] = threeTabs(fake);
  const hold = deferred();
  let first = true;
  fake.overrides['tabs.update'] = async (args, impl) => {
    const result = await impl(...args);
    if (first) {
      first = false;
      await hold.promise;
    }
    return result;
  };
  const p1 = exec(fake, a, 'R');
  await settle();
  assert.equal(fake.activeTab(1).id, b, 'タブは切り替わったが応答は保留中');
  const p2 = exec(fake, b, 'L');
  await settle();
  assert.equal(fake.callsOf('tabs.update').length, 1, '2 件目はキューで待機');
  assert.equal(bg.queuedTotal, 2);
  hold.resolve();
  assert.equal((await p1).ok, true);
  assert.equal((await p2).ok, true);
  assert.equal(fake.activeTab(1).id, a);
  assert.equal(fake.callsOf('tabs.update').length, 2);
  assert.equal(bg.queuedTotal, 0);
});

test('A16: 同じ ID の再送は実行しない (処理中・完了後・API 失敗後)', async () => {
  const { fake } = setup();
  const [a] = threeTabs(fake);
  const gestureId = randomUUID();
  const msg = { type: 'execute-gesture', gesture: 'R', gestureId };
  const hold = deferred();
  fake.overrides['tabs.update'] = async (args, impl) => {
    await hold.promise;
    return impl(...args);
  };
  const first = fake.sendRuntime(msg, fake.contentSender(a));
  await settle();
  const dupWhilePending = await fake.sendRuntime({ ...msg, gestureId: gestureId.toUpperCase() }, fake.contentSender(a));
  assert.equal(dupWhilePending.reason, 'duplicate', '大文字の同じ ID も重複');
  hold.resolve();
  assert.equal((await first).ok, true);
  const b = fake.activeTab(1).id;
  const dupAfter = await fake.sendRuntime(msg, fake.contentSender(b));
  assert.equal(dupAfter.reason, 'duplicate');
  assert.equal(fake.callsOf('tabs.update').length, 1);

  // API 失敗で完了した要求も履歴に残す
  delete fake.overrides['tabs.update'];
  fake.overrides['tabs.update'] = async () => {
    throw new Error('Tabs cannot be edited right now');
  };
  const failId = randomUUID();
  const failed = await fake.sendRuntime({ type: 'execute-gesture', gesture: 'R', gestureId: failId }, fake.contentSender(b));
  assert.equal(failed.reason, 'api-failed');
  assert.match(failed.message, /Tabs cannot be edited/);
  const resend = await fake.sendRuntime({ type: 'execute-gesture', gesture: 'R', gestureId: failId }, fake.contentSender(b));
  assert.equal(resend.reason, 'duplicate');

  // 失敗してもキューは止まらず後続を処理する
  delete fake.overrides['tabs.update'];
  assert.equal((await exec(fake, b, 'R')).ok, true);
});

test('A16: 元タブの閉鎖・別ウィンドウへの移動・非アクティブ化では実行しない', async () => {
  const { fake } = setup();
  const [a, b] = threeTabs(fake);
  const senderA = fake.contentSender(a);
  // 非アクティブ
  fake.activate(b);
  let r = await fake.sendRuntime({ type: 'execute-gesture', gesture: 'R', gestureId: randomUUID() }, senderA);
  assert.equal(r.reason, 'stale-tab');
  // 別ウィンドウへ移動
  fake.tabs.get(a).windowId = 9;
  fake.tabs.get(a).active = true;
  r = await fake.sendRuntime({ type: 'execute-gesture', gesture: 'R', gestureId: randomUUID() }, senderA);
  assert.equal(r.reason, 'stale-tab');
  // 閉鎖
  fake.tabs.delete(a);
  r = await fake.sendRuntime({ type: 'execute-gesture', gesture: 'R', gestureId: randomUUID() }, senderA);
  assert.equal(r.reason, 'stale-tab');
  assert.equal(fake.callsOf('tabs.update').length, 0);
});

test('A17: 初回の設定読み込み中に割り当てを変えても、 変更前の解放は閉じる操作に化けない', async () => {
  const loadHold = deferred();
  let firstGet = true;
  const { fake, bg } = setup({
    beforeRegister: (f) => {
      f.overrides['storage.get'] = async (args, impl) => {
        if (firstGet) {
          firstGet = false;
          await loadHold.promise;
        }
        return impl(...args);
      };
    }
  });
  const [a] = threeTabs(fake);
  const pending = exec(fake, a, 'R', { action: 'next-tab' });
  await settle();
  const changed = save(fake, { ...C.defaultSettings(), gestures: { ...C.DEFAULT_GESTURES, R: 'close-window' } });
  loadHold.resolve();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'settings-changed');
  assert.equal((await changed).ok, true);
  assert.equal(fake.callsOf('windows.remove').length, 0);
  assert.equal(fake.callsOf('tabs.update').length, 0);
  assert.equal(bg.settings.gestures.R, 'close-window');

  // 画面側がまだ古い割り当てを表示していた要求も実行しない
  const stale = await exec(fake, a, 'R', { action: 'next-tab' });
  assert.equal(stale.reason, 'settings-changed');
  assert.equal(fake.callsOf('windows.remove').length, 0);
});

test('受付後に変更して元に戻した場合も、 その要求は中止する', async () => {
  const { fake } = setup();
  const [a] = threeTabs(fake);
  await settle();
  const hold = deferred();
  fake.overrides['tabs.get'] = async (args, impl) => {
    await hold.promise;
    return impl(...args);
  };
  const pending = exec(fake, a, 'R', { action: 'next-tab' });
  await settle();
  await save(fake, { gestures: { R: 'close-tab' } }, 1);
  await save(fake, { gestures: { R: 'next-tab' } }, 2);
  hold.resolve();
  assert.equal((await pending).reason, 'settings-changed');
  assert.equal(fake.callsOf('tabs.update').length, 0);
});

test('無効化・未割り当て', async () => {
  const { fake } = setup();
  const [a] = threeTabs(fake);
  await save(fake, { enabled: false });
  assert.equal((await exec(fake, a, 'R')).reason, 'disabled');
  await save(fake, { enabled: true, gestures: { R: 'none' } }, 2);
  const r = await exec(fake, a, 'R', { action: 'none' });
  assert.equal(r.reason, 'unassigned');
  assert.equal(fake.callsOf('tabs.update').length, 0);
});

test('不正な要求・送信元を拒否する', async () => {
  const { fake } = setup();
  const [a] = threeTabs(fake);
  const sender = fake.contentSender(a);
  const bad = async (msg, s = sender) => fake.sendRuntime(msg, s);
  assert.equal((await bad({ type: 'execute-gesture', gesture: 'RR', gestureId: randomUUID() })).reason, 'invalid');
  assert.equal((await bad({ type: 'execute-gesture', gesture: 'R', gestureId: 'not-a-uuid' })).reason, 'invalid');
  assert.equal((await bad({ type: 'execute-gesture', gesture: 'R', gestureId: '6f1c1a3e-1111-1111-8111-111111111111' })).reason, 'invalid', 'v1 は不可');
  assert.equal((await bad({ type: 'execute-gesture', gesture: 'R', gestureId: randomUUID(), action: 'eval' })).reason, 'invalid');
  assert.equal((await bad({ type: 'execute-gesture', gesture: 'R', gestureId: randomUUID() }, { id: fake.chrome.runtime.id, url: 'https://x/' })).reason, 'forbidden');
  assert.equal(await bad({ type: 'execute-gesture', gesture: 'R', gestureId: randomUUID() }, { ...sender, id: 'otherextension' }), undefined);
  const extPage = { ...sender, url: fake.chrome.runtime.getURL('popup.html') };
  assert.equal((await bad({ type: 'execute-gesture', gesture: 'R', gestureId: randomUUID() }, extPage)).reason, 'forbidden');
  assert.equal(await bad({ type: 'open-start-page' }), undefined, '削除した要求は扱わない');
  assert.equal(fake.callsOf('tabs.update').length, 0);
});

test('キューの保護上限 (ウィンドウ 64 件・全体 512 件) と完了履歴 512 件', async () => {
  const { fake, bg } = setup();
  const hold = deferred();
  fake.overrides['tabs.get'] = async (args, impl) => {
    await hold.promise;
    return impl(...args);
  };
  const tabsByWindow = [];
  for (let w = 1; w <= 9; w += 1) tabsByWindow.push(threeTabs(fake, w)[0]);
  const all = [];
  for (let i = 0; i < QUEUE_LIMIT_WINDOW + 6; i += 1) all.push(exec(fake, tabsByWindow[0], 'R'));
  await settle();
  assert.equal(bg.queuedTotal, QUEUE_LIMIT_WINDOW);
  for (let w = 1; w < 9; w += 1) for (let i = 0; i < QUEUE_LIMIT_WINDOW; i += 1) all.push(exec(fake, tabsByWindow[w], 'R'));
  await settle();
  assert.equal(bg.queuedTotal, QUEUE_LIMIT_TOTAL);
  hold.resolve();
  const results = await Promise.all(all);
  assert.equal(results.filter((r) => r.reason === 'queue-full').length, all.length - QUEUE_LIMIT_TOTAL);
  assert.equal(bg.queuedTotal, 0);
  assert.equal(bg.historySize, HISTORY_LIMIT);
});

test('旧版の switch-tab は現在の割り当てに従い、 重なりは抑止する', async () => {
  const { fake } = setup();
  const [a, b] = threeTabs(fake);
  const r = await fake.sendRuntime({ type: 'switch-tab', direction: 1 }, fake.contentSender(a));
  assert.equal(r.ok, true);
  assert.equal(fake.activeTab(1).id, b);
  const hold = deferred();
  fake.overrides['tabs.get'] = async (args, impl) => {
    await hold.promise;
    return impl(...args);
  };
  const first = fake.sendRuntime({ type: 'switch-tab', direction: -1 }, fake.contentSender(b));
  await settle();
  const overlap = await fake.sendRuntime({ type: 'switch-tab', direction: -1 }, fake.contentSender(b));
  assert.equal(overlap.reason, 'busy');
  hold.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await fake.sendRuntime({ type: 'switch-tab', direction: 0 }, fake.contentSender(a))).reason, 'invalid');
});

test('A24 / A27 ほか: 各操作の API 呼び出し', async () => {
  const { fake } = setup();
  const [a, b] = threeTabs(fake);
  const cases = [
    ['close-tab', 'tabs.remove', [b]],
    ['new-tab', 'tabs.create', [{ windowId: 1, index: 2, active: true }]],
    ['restore-closed', 'sessions.restore', []],
    ['reload', 'tabs.reload', [b, { bypassCache: false }]],
    ['hard-reload', 'tabs.reload', [b, { bypassCache: true }]],
    ['go-back', 'tabs.goBack', [b]],
    ['go-forward', 'tabs.goForward', [b]],
    ['duplicate-tab', 'tabs.duplicate', [b]],
    ['toggle-pin', 'tabs.update', [b, { pinned: true }]]
  ];
  let seq = 10;
  for (const [action, api, args] of cases) {
    // 毎回 b をアクティブな元タブにする
    if (!fake.tabs.has(b)) fake.addTab({ id: b, url: 'https://b.example/' });
    fake.activate(b);
    for (const t of [...fake.tabs.values()]) if (t.id > 3) fake.tabs.delete(t.id);
    fake.tabs.get(b).index = 1;
    fake.tabs.get(b).pinned = false;
    await save(fake, { gestures: { D: action } }, seq++);
    const before = fake.callsOf(api).length;
    const r = await exec(fake, b, 'D', { action });
    assert.deepEqual(r, { ok: true, action }, action);
    const call = fake.callsOf(api)[before];
    assert.deepEqual(call.args, args, action);
  }
  // 新しいタブは URL を指定しない (標準の新規タブ)
  assert.equal(fake.callsOf('tabs.create')[0].args[0].url, undefined);

  await save(fake, { gestures: { D: 'close-window' } }, seq++);
  fake.activate(a);
  assert.equal((await exec(fake, a, 'D', { action: 'close-window' })).ok, true);
  assert.deepEqual(fake.callsOf('windows.remove')[0].args, [1]);
});

test('A18: 連続保存は順番どおりで、 最後の設定が残る', async () => {
  const { fake, bg } = setup();
  await settle();
  const holds = [];
  fake.overrides['storage.set'] = async (args, impl) => {
    const h = deferred();
    holds.push(h);
    await h.promise;
    return impl(...args);
  };
  const p1 = save(fake, { ...C.defaultSettings(), textSize: 'small' }, 1);
  const p2 = save(fake, { ...C.defaultSettings(), textSize: 'large' }, 2);
  await settle();
  assert.equal(holds.length, 1, '2 件目は 1 件目の完了を待つ');
  holds[0].resolve();
  await settle();
  assert.equal(holds.length, 2);
  holds[1].resolve();
  assert.deepEqual([(await p1).seq, (await p2).seq], [1, 2]);
  assert.equal(fake.store.textSize, 'large');
  assert.equal(bg.settings.textSize, 'large');
});

test('A19: 旧形式の保存で新しい 4 種類や表示設定を消さない', async () => {
  const { fake } = setup({ storage: { enabled: true, gestures: { L: 'previous-tab', R: 'next-tab', U: 'reload', D: 'none', DR: 'close-tab', DL: 'none', UR: 'none', UL: 'none' } } });
  await settle();
  // 新 4 種類の保存を書き込み待ちにしておき、 その間に旧 8 種類だけの保存を受ける
  const hold = deferred();
  let firstSet = true;
  fake.overrides['storage.set'] = async (args, impl) => {
    if (firstSet) {
      firstSet = false;
      await hold.promise;
    }
    return impl(...args);
  };
  const modern = save(fake, { ...C.defaultSettings(), showTrail: false, language: 'en', textSize: 'large', gestures: { ...C.DEFAULT_GESTURES, U: 'reload', DR: 'close-tab', RU: 'new-tab', LD: 'hard-reload' } }, 1);
  const legacy = fake.sendRuntime(
    {
      type: 'save-settings',
      seq: 2,
      settings: { enabled: true, threshold: 90, wrapTabs: false, showFeedback: true, gestures: { L: 'previous-tab', R: 'next-tab', U: 'none', D: 'none', DR: 'close-tab', DL: 'none', UR: 'none', UL: 'none' } }
    },
    fake.popupSender()
  );
  await settle();
  hold.resolve();
  assert.equal((await modern).ok, true);
  const r = await legacy;
  assert.equal(r.ok, true);
  assert.equal(fake.store.gestures.RU, 'new-tab', '先行保存の新 4 種類を保持');
  assert.equal(fake.store.gestures.LD, 'hard-reload');
  assert.equal(fake.store.gestures.U, 'none', '明示 none は反映');
  assert.equal(fake.store.showTrail, false, '省略した表示設定を保持');
  assert.equal(fake.store.language, 'en');
  assert.equal(fake.store.textSize, 'large');
  assert.equal(fake.store.threshold, 90);
  assert.equal(fake.store.wrapTabs, false);

  // gestures 全体が省略された旧形式
  await fake.sendRuntime({ type: 'save-settings', seq: 3, settings: { enabled: false } }, fake.popupSender());
  assert.equal(fake.store.gestures.RU, 'new-tab');
  assert.equal(fake.store.enabled, false);
});

test('旧 8 種類だけの保存値は新 4 種類を none で補う', async () => {
  const { bg } = setup({ storage: { gestures: { L: 'go-back', R: 'go-forward', U: 'none', D: 'none', DR: 'close-tab', DL: 'none', UR: 'none', UL: 'none' } } });
  await bg.ensureLoaded();
  assert.equal(bg.settings.gestures.L, 'go-back');
  assert.equal(bg.settings.gestures.DR, 'close-tab');
  for (const id of ['RU', 'RD', 'LU', 'LD']) assert.equal(bg.settings.gestures[id], 'none');
});

test('保存要求の検証: 不正な値は拒否、 未知のキーは捨てる', async () => {
  const { fake } = setup();
  await settle();
  for (const settings of [null, [], 'x', { enabled: 'yes' }, { threshold: 10 }, { threshold: 70.5 }, { language: 'fr' }, { textSize: 'huge' }, { gestures: [] }, { gestures: { R: 'run-script' } }]) {
    const r = await save(fake, settings, 1);
    assert.equal(r.reason, 'invalid', JSON.stringify(settings));
  }
  const ok = await save(fake, { enabled: true, evil: 'x', gestures: { R: 'close-tab', ZZ: 'close-window', __proto__: { x: 1 } } }, 2);
  assert.equal(ok.ok, true);
  assert.equal(fake.store.evil, undefined);
  assert.equal(fake.store.gestures.ZZ, undefined);
  assert.equal(fake.store.gestures.R, 'close-tab');
  // ポップアップ以外からの保存は拒否
  const tab = fake.addTab({ url: 'https://x.example/', active: true });
  assert.equal((await fake.sendRuntime({ type: 'save-settings', settings: { enabled: false } }, fake.contentSender(tab.id))).reason, 'forbidden');
  assert.equal((await fake.sendRuntime({ type: 'save-settings', settings: { enabled: false } }, { id: fake.chrome.runtime.id, url: fake.chrome.runtime.getURL('popup.html?x') })).reason, 'forbidden');
  assert.equal(fake.store.enabled, true);
});

test('A21: 保存失敗は失敗として返し、 後続の保存は続けられる', async () => {
  const { fake } = setup();
  await settle();
  fake.overrides['storage.set'] = async () => {
    throw new Error('QUOTA_BYTES quota exceeded');
  };
  const r = await save(fake, { textSize: 'small' }, 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'storage-failed');
  assert.equal(r.seq, 1);
  delete fake.overrides['storage.set'];
  assert.equal((await save(fake, { textSize: 'small' }, 2)).ok, true);
  assert.equal(fake.store.textSize, 'small');
});

test('初期読み込み中に届いた変更を古い読み込み結果で取り消さない', async () => {
  const loadHold = deferred();
  const { fake, bg } = setup({
    storage: { wrapTabs: true },
    beforeRegister: (f) => {
      f.overrides['storage.get'] = async (args, impl) => {
        const old = await impl(...args);
        await loadHold.promise;
        return old;
      };
    }
  });
  await settle();
  fake.chrome.storage.onChanged.emit({ wrapTabs: { oldValue: true, newValue: false } }, 'local');
  loadHold.resolve();
  await bg.ensureLoaded();
  assert.equal(bg.settings.wrapTabs, false);
});

test('外部からの設定変更に追従する', async () => {
  const { fake, bg } = setup();
  await bg.ensureLoaded();
  const rev = bg.revision;
  fake.chrome.storage.onChanged.emit({ enabled: { newValue: false } }, 'local');
  assert.equal(bg.settings.enabled, false);
  assert.ok(bg.revision > rev);
});

test('メニュー抑制の通知を同じタブの全フレームへ中継する', async () => {
  const { fake } = setup();
  const [a] = threeTabs(fake);
  const r = await fake.sendRuntime({ type: 'menu-guard', token: 't1', ms: 99999 }, fake.contentSender(a));
  assert.deepEqual(r, { ok: true });
  await settle();
  const sent = fake.messageLog.find((m) => m.message.type === 'gesture-menu-guard');
  assert.equal(sent.tabId, a);
  assert.equal(sent.message.ms, 5000);
  assert.equal(sent.options, undefined, 'frameId を指定せず全フレームへ');
});

test('フレームをまたぐ移動の中継は検証してから同じタブへ送る', async () => {
  const { fake } = setup();
  const [a] = threeTabs(fake);
  const sender = fake.contentSender(a);
  await fake.sendRuntime({ type: 'gesture-relay', token: 'x', kind: 'move', points: [[1, 2], [3, 4]], at: 5 }, sender);
  for (const bad of [
    { kind: 'eval', points: [], at: 1 },
    { kind: 'move', points: [[NaN, 1]], at: 1 },
    { kind: 'move', points: [[1, 2, 3]], at: 1 },
    { kind: 'move', points: new Array(65).fill([0, 0]), at: 1 },
    { kind: 'up', points: [], at: 'x' }
  ]) {
    await fake.sendRuntime({ type: 'gesture-relay', token: 'x', ...bad }, sender);
  }
  await fake.sendRuntime({ type: 'gesture-relay', token: 'x', kind: 'up', points: [], at: 1 }, fake.popupSender());
  await settle();
  const sent = fake.messageLog.filter((m) => m.message.type === 'gesture-relay');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { tabId: a, message: { type: 'gesture-relay', token: 'x', kind: 'move', points: [[1, 2], [3, 4]], at: 5 }, options: undefined });
});

/* ------------------------------------------------------------ 診断 */

async function status(fake) {
  return fake.sendRuntime({ type: 'get-page-status' }, fake.popupSender());
}

test('A23: 標準新規タブ・管理画面・ストアは対象外。 注入も許可要求もしない', async () => {
  const urls = [
    'chrome://newtab/',
    'chrome://new-tab-page/',
    'edge://newtab/',
    'chrome://extensions/',
    'edge://settings/',
    'about:blank',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html',
    'chrome-extension://otherextensionid/page.html',
    'view-source:https://example.com/',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/detail/x',
    'https://microsoftedge.microsoft.com/addons/detail/x'
  ];
  for (const url of urls) {
    const { fake } = setup();
    fake.addTab({ url, active: true });
    const r = await status(fake);
    assert.equal(r.state, 'restricted', url);
    assert.equal(r.canRequest, false);
    assert.equal(fake.callsOf('scripting.executeScript').length, 0, url);
    assert.equal(fake.callsOf('permissions.contains').length, 0, url);
  }
  const { fake } = setup();
  fake.addTab({ url: 'https://chromewebstore.google.com/', active: true });
  assert.equal((await status(fake)).messageKey, 'status.restricted-store');
});

test('Google の検索トップは通常ページ、 標準新規タブとは別', async () => {
  const { fake } = setup();
  const tab = fake.addTab({ url: 'https://www.google.com/?hl=ja', active: true });
  fake.contentFrames.set(tab.id, { version: '3.5.0', ready: true });
  assert.equal((await status(fake)).state, 'ready');
  const nt = setup();
  nt.fake.addTab({ url: 'chrome://new-tab-page/', active: true });
  assert.equal((await status(nt.fake)).state, 'restricted');
});

test('診断: タブなし・無効・URL 不明・読み込み中', async () => {
  const { fake } = setup();
  assert.equal((await status(fake)).state, 'no-tab');
  const t = fake.addTab({ url: '', active: true });
  assert.equal((await status(fake)).state, 'unavailable', 'URL 不明を権限不足と決め付けない');
  t.url = 'https://loading.example/';
  t.status = 'loading';
  fake.overrides['scripting.executeScript'] = async () => {
    throw new Error('Frame not ready');
  };
  assert.equal((await status(fake)).state, 'unavailable');
  await save(fake, { enabled: false });
  assert.equal((await status(fake)).state, 'disabled');
});

test('A22: サイト権限がなければ該当ホスト 1 件だけを案内する', async () => {
  const { fake } = setup({ origins: [] });
  fake.addTab({ url: 'https://docs.example.co.jp:8443/a/b?c=1', active: true });
  const r = await status(fake);
  assert.equal(r.state, 'permission-required');
  assert.equal(r.canRequest, true);
  assert.equal(r.origin, 'https://docs.example.co.jp/*');
  assert.equal(r.host, 'docs.example.co.jp');
  assert.equal(fake.callsOf('scripting.executeScript').length, 0, '許可前に注入しない');
  // 許可後は準備し直して使用可能になる
  fake.granted.add('https://docs.example.co.jp/*');
  const ready = await status(fake);
  assert.equal(ready.state, 'ready');
  assert.equal(fake.callsOf('scripting.executeScript').length, 1);
});

test('file:// はファイル URL のアクセス設定へ案内する', async () => {
  const { fake } = setup({ fileAccess: false });
  fake.addTab({ url: 'file:///C:/test/index.html', active: true });
  const r = await status(fake);
  assert.equal(r.state, 'permission-required');
  assert.equal(r.canRequest, false);
  assert.equal(r.messageKey, 'status.permission-file');
  fake.state.fileAccess = true;
  assert.equal((await status(fake)).state, 'ready');
});

test('診断: 接続確認・再注入・古い版・PDF・再読み込み案内', async () => {
  const { fake } = setup();
  const tab = fake.addTab({ url: 'https://example.com/', active: true });
  fake.contentFrames.set(tab.id, { version: '3.5.0', ready: true });
  assert.equal((await status(fake)).state, 'ready');
  assert.equal(fake.callsOf('scripting.executeScript').length, 0);

  fake.contentFrames.set(tab.id, { version: '3.4.1', ready: true });
  assert.equal((await status(fake)).state, 'ready', '古い版は再注入して確認');
  assert.equal(fake.callsOf('scripting.executeScript').length, 1);

  fake.contentFrames.set(tab.id, { version: '3.5.0', ready: true, contentType: 'application/pdf' });
  assert.equal((await status(fake)).messageKey, 'status.pdf');

  const t2 = fake.addTab({ url: 'https://broken.example/', active: true });
  fake.overrides['scripting.executeScript'] = async () => {
    throw new Error('Cannot access');
  };
  const r = await status(fake);
  assert.equal(r.tabId, t2.id);
  assert.equal(r.state, 'reload-required');
});

test('子フレームへの注入失敗だけでメインフレームを使用不可にしない', async () => {
  const { fake } = setup();
  fake.addTab({ url: 'https://frames.example/', active: true });
  const original = fake.chrome.scripting.executeScript;
  fake.overrides['scripting.executeScript'] = async (args, impl) => {
    if (args[0].target.allFrames) throw new Error('Cannot access a chrome-extension:// URL of different extension');
    return impl(...args);
  };
  assert.ok(original);
  assert.equal((await status(fake)).state, 'ready');
  assert.deepEqual(fake.callsOf('scripting.executeScript').map((c) => c.args[0].target), [{ tabId: fake.activeTab(1).id, allFrames: true }, { tabId: fake.activeTab(1).id, frameIds: [0] }]);
});

test('同じタブへの同時診断・注入はまとめる', async () => {
  const { fake } = setup();
  fake.addTab({ url: 'https://example.com/', active: true });
  const [r1, r2, r3] = await Promise.all([status(fake), status(fake), status(fake)]);
  assert.deepEqual([r1.state, r2.state, r3.state], ['ready', 'ready', 'ready']);
  assert.equal(fake.callsOf('scripting.executeScript').length, 1);
  // 完了後は次の修復を妨げない
  fake.contentFrames.clear();
  assert.equal((await status(fake)).state, 'ready');
  assert.equal(fake.callsOf('scripting.executeScript').length, 2);
});

test('導入時・サイト許可追加時に開いているページを準備する', async () => {
  const { fake } = setup();
  const ready = fake.addTab({ url: 'https://ready.example/' });
  fake.contentFrames.set(ready.id, { version: '3.5.0', ready: true });
  const plain = fake.addTab({ url: 'https://plain.example/' });
  fake.addTab({ url: 'chrome://newtab/' });
  fake.addTab({ url: 'https://chromewebstore.google.com/' });
  fake.addTab({ url: 'https://sleep.example/', discarded: true });
  const file = fake.addTab({ url: 'file:///C:/a.html' });
  fake.chrome.runtime.onInstalled.emit({ reason: 'update' });
  await settle(30);
  const injected = fake.callsOf('scripting.executeScript').map((c) => c.args[0].target.tabId).sort();
  assert.deepEqual(injected, [plain.id, file.id].sort());

  // ブラウザ更新などでは注入しない
  fake.calls.length = 0;
  fake.chrome.runtime.onInstalled.emit({ reason: 'chrome_update' });
  await settle(30);
  assert.equal(fake.callsOf('scripting.executeScript').length, 0);

  // 許可されたホストだけ
  const { fake: f2 } = setup({ origins: [] });
  const target = f2.addTab({ url: 'https://new.example/x' });
  f2.addTab({ url: 'https://other.example/' });
  f2.granted.add('https://new.example/*');
  f2.chrome.permissions.onAdded.emit({ origins: ['https://new.example/*'] });
  await settle(30);
  assert.deepEqual(f2.callsOf('scripting.executeScript').map((c) => c.args[0].target.tabId), [target.id]);
});

test('通常の操作で Service Worker が起きても全タブへ再注入しない', async () => {
  const { fake } = setup();
  const [a] = threeTabs(fake);
  await fake.sendRuntime({ type: 'prepare-gesture' }, fake.contentSender(a));
  await exec(fake, a, 'R');
  assert.equal(fake.callsOf('scripting.executeScript').length, 0);
});

test('「許可設定」は自分の拡張機能の詳細画面を開く (Chrome / Edge)', async () => {
  const { fake } = setup();
  const r = await fake.sendRuntime({ type: 'open-site-settings' }, fake.popupSender());
  assert.equal(r.url, 'chrome://extensions/?id=' + fake.chrome.runtime.id);
  const edge = setup({ navigator: { userAgent: 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0' } });
  const r2 = await edge.fake.sendRuntime({ type: 'open-site-settings' }, edge.fake.popupSender());
  assert.equal(r2.url, 'edge://extensions/?id=' + edge.fake.chrome.runtime.id);
  const tab = fake.addTab({ url: 'https://x.example/', active: true });
  assert.equal((await fake.sendRuntime({ type: 'open-site-settings' }, fake.contentSender(tab.id))).reason, 'forbidden');
});

test('originsCover', () => {
  assert.equal(originsCover(['https://a.example/*'], 'https://a.example/x'), true);
  assert.equal(originsCover(['https://a.example/*'], 'http://a.example/x'), false);
  assert.equal(originsCover(['*://*.example.com/*'], 'https://www.example.com/'), true);
  assert.equal(originsCover(['*://*.example.com/*'], 'https://example.com/'), true);
  assert.equal(originsCover(['http://localhost:3000/*'], 'http://localhost:3000/app'), true);
  assert.equal(originsCover(['http://localhost:3000/*'], 'http://localhost:8080/app'), false);
  assert.equal(originsCover(['http://localhost:*/*'], 'http://localhost:3000/app'), true);
  assert.equal(originsCover(['http://[::1]:8080/*'], 'http://[::1]:8080/app'), true);
  assert.equal(originsCover(['<all_urls>'], 'file:///C:/x'), true);
  assert.equal(originsCover(['file:///*'], 'file:///C:/x'), true);
  assert.equal(originsCover(['https://a.example/*'], 'nonsense'), false);
});

test('ポート番号付きのサイト許可でも診断と準備が動作する', async () => {
  const { fake } = setup({ origins: [] });
  const tab = fake.addTab({ url: 'http://localhost:3000/app', active: true });
  assert.equal((await status(fake)).state, 'permission-required');
  fake.granted.add('http://localhost:3000/*');
  fake.chrome.permissions.onAdded.emit({ origins: ['http://localhost:3000/*'] });
  await settle(30);
  assert.deepEqual(fake.callsOf('scripting.executeScript').map((c) => c.args[0].target.tabId), [tab.id]);
  assert.equal((await status(fake)).state, 'ready');
});

test('履歴や閉じたタブがない場合は専用の理由を返す', async () => {
  const { fake } = setup({
    storage: { gestures: { L: 'go-back', R: 'go-forward', U: 'restore-closed' } }
  });
  const [a] = threeTabs(fake);
  fake.overrides['tabs.goBack'] = async () => {
    throw new Error('Cannot find a next page in history.');
  };
  fake.overrides['tabs.goForward'] = async () => {
    throw new Error('Cannot find a next page in history.');
  };
  fake.overrides['sessions.restore'] = async () => {
    throw new Error('There are no recently closed sessions.');
  };
  const rBack = await exec(fake, a, 'L');
  assert.equal(rBack.reason, 'no-back-history');
  assert.equal(rBack.display, true);
  assert.equal(rBack.message, 'これ以上戻れるページがありません');

  const rFwd = await exec(fake, a, 'R');
  assert.equal(rFwd.reason, 'no-forward-history');
  assert.equal(rFwd.display, true);
  assert.equal(rFwd.message, 'これ以上進めるページがありません');

  const rRestore = await exec(fake, a, 'U');
  assert.equal(rRestore.reason, 'no-closed-session');
  assert.equal(rRestore.display, true);
  assert.equal(rRestore.message, '復元できる閉じたタブ／ウィンドウがありません');
});
