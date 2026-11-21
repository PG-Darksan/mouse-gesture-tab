'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const C = require('../extension/config.js');
const I = require('../extension/i18n.js');
const GS = require('../extension/gesture-shape.js');
const L = require('../extension/popup-logic.js');

test('初期設定', () => {
  const d = C.defaultSettings();
  assert.deepEqual(d, {
    enabled: true,
    threshold: 70,
    wrapTabs: true,
    showFeedback: true,
    showTrail: true,
    language: 'auto',
    textSize: 'medium',
    gestures: { L: 'previous-tab', R: 'next-tab', U: 'none', D: 'none', DR: 'none', DL: 'none', UR: 'none', UL: 'none', RU: 'none', RD: 'none', LU: 'none', LD: 'none' }
  });
  assert.equal(C.GESTURES.length, 12);
  assert.equal(C.ACTIONS.length, 17);
  assert.deepEqual([...C.SCROLL_ACTIONS], ['scroll-up', 'scroll-down', 'scroll-left', 'scroll-right']);
  assert.equal(C.isScrollAction('scroll-up'), true);
  assert.equal(C.isScrollAction('next-tab'), false);
  d.gestures.L = 'none';
  assert.equal(C.defaultSettings().gestures.L, 'previous-tab', '初期値は共有しない');
});

test('正規化: 不足は初期値、 不正は安全な既定値', () => {
  assert.deepEqual(C.normalizeSettings(null), C.defaultSettings());
  const n = C.normalizeSettings({ enabled: 'no', threshold: 999, wrapTabs: false, language: 'fr', textSize: 'large', gestures: { L: 'go-back', R: 'format-disk', DR: 5 } });
  assert.equal(n.enabled, true);
  assert.equal(n.threshold, 200);
  assert.equal(n.wrapTabs, false);
  assert.equal(n.language, 'auto');
  assert.equal(n.textSize, 'large');
  assert.equal(n.gestures.L, 'go-back');
  assert.equal(n.gestures.R, 'none');
  assert.equal(n.gestures.DR, 'none');
  assert.equal(n.gestures.RU, 'none');
  assert.equal(C.normalizeSettings({ threshold: 'x' }).threshold, 70);
  assert.equal(C.normalizeSettings({ threshold: 44.6 }).threshold, 45);
  assert.equal(C.normalizeSettings({ gestures: [] }).gestures.R, 'next-tab');
});

test('保存要求の検証と統合', () => {
  assert.equal(C.validateSettingsPatch({ enabled: 1 }).ok, false);
  assert.equal(C.validateSettingsPatch({ threshold: 29 }).ok, false);
  assert.equal(C.validateSettingsPatch({ threshold: 201 }).ok, false);
  assert.equal(C.validateSettingsPatch({ gestures: { L: 'javascript:alert(1)' } }).ok, false);
  const v = C.validateSettingsPatch({ wrapTabs: false, unknown: true, gestures: { R: 'none', X: 'close-tab' } });
  assert.deepEqual(v, { ok: true, patch: { wrapTabs: false, gestures: { R: 'none' } } });
  const merged = C.applySettingsPatch({ ...C.defaultSettings(), showTrail: false, gestures: { ...C.DEFAULT_GESTURES, RU: 'reload' } }, v.patch);
  assert.equal(merged.showTrail, false);
  assert.equal(merged.wrapTabs, false);
  assert.equal(merged.gestures.R, 'none');
  assert.equal(merged.gestures.RU, 'reload');
  assert.equal(merged.gestures.L, 'previous-tab');
  assert.equal(C.settingsEqual(merged, C.cloneSettings(merged)), true);
  assert.equal(C.settingsEqual(merged, C.defaultSettings()), false);
});

test('UUID v4 は getRandomValues だけで作る', () => {
  const insecure = { getRandomValues: (a) => webcrypto.getRandomValues(a) };
  const ids = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const id = C.createUuidV4(insecure);
    assert.equal(C.isUuidV4(id), true, id);
    ids.add(id);
  }
  assert.equal(ids.size, 2000);
  assert.equal(C.isUuidV4('00000000-0000-1000-8000-000000000000'), false);
  assert.equal(C.isUuidV4(42), false);
});

test('URL の分類', () => {
  assert.deepEqual(C.classifyUrl('https://www.google.com/?hl=ja'), { kind: 'web', pattern: 'https://www.google.com/*', host: 'www.google.com' });
  assert.deepEqual(C.classifyUrl('http://localhost:8080/x'), { kind: 'web', pattern: 'http://localhost/*', host: 'localhost' });
  assert.equal(C.classifyUrl('file:///C:/a.html').kind, 'file');
  for (const url of ['chrome://newtab/', 'edge://newtab/', 'about:blank', 'data:text/html,x', 'devtools://devtools/x', 'chrome-extension://x/y']) {
    assert.equal(C.classifyUrl(url).kind, 'restricted', url);
  }
  assert.equal(C.classifyUrl('https://chrome.google.com/webstore').reason, 'store');
  assert.equal(C.classifyUrl('https://chrome.google.com/search').kind, 'web');
  assert.equal(C.classifyUrl('https://microsoftedge.microsoft.com/addons/x').reason, 'store');
  assert.equal(C.classifyUrl('').kind, 'unknown');
  assert.equal(C.classifyUrl('not a url').kind, 'unknown');
});

test('言語: 自動はブラウザに従い、 不明なら日本語。 明示選択が優先', () => {
  assert.equal(I.resolveLanguage('auto', 'ja'), 'ja');
  assert.equal(I.resolveLanguage('auto', 'ja-JP'), 'ja');
  assert.equal(I.resolveLanguage('auto', 'en-US'), 'en');
  assert.equal(I.resolveLanguage('auto', 'fr'), 'en');
  assert.equal(I.resolveLanguage('auto', ''), 'ja');
  assert.equal(I.resolveLanguage('auto', undefined), 'ja');
  assert.equal(I.resolveLanguage('en', 'ja'), 'en');
  assert.equal(I.resolveLanguage('ja', 'en-US'), 'ja');
});

test('日英の文言は同じキーを持ち、 空でない', () => {
  const ja = Object.keys(I.STRINGS.ja).sort();
  const en = Object.keys(I.STRINGS.en).sort();
  assert.deepEqual(en, ja);
  for (const lang of ['ja', 'en']) {
    for (const [k, v] of Object.entries(I.STRINGS[lang])) assert.ok(typeof v === 'string' && v.length > 0, `${lang}.${k}`);
  }
  for (const a of C.ACTIONS) assert.ok(I.has('action.' + a), a);
  for (const lang of ['ja', 'en']) {
    for (const v of Object.values(I.STRINGS[lang])) assert.doesNotMatch(v, /L字|逆L|L-shape/i);
  }
});

test('形の表記は動かす順番', () => {
  assert.equal(I.shapeLabel('ja', 'DR'), '下→右');
  assert.equal(I.shapeLabel('ja', 'RU'), '右→上');
  assert.equal(I.shapeLabel('en', 'DR'), 'Down → Right');
  assert.equal(I.shapeLabel('en', 'L'), 'Left');
  assert.equal(I.shapeSteps('ja', 'DR'), '下へ動かしてから右へ');
  assert.equal(I.shapeSteps('en', 'LU'), 'Move left, then up');
  assert.equal(I.actionLabel('ja', 'restore-closed'), '閉じたタブ／ウィンドウを復元');
  assert.equal(I.t('ja', 'reason.api-failed', { detail: 'x' }), '操作できませんでした: x');
  assert.equal(I.t('en', 'no.such.key'), 'no.such.key');
});

test('形の判定と図', () => {
  assert.equal(GS.fromStrokes(['D', 'R']), 'DR');
  assert.equal(GS.fromStrokes(['R', 'R']), null);
  assert.equal(GS.fromStrokes(['R', 'L']), null);
  assert.equal(GS.fromStrokes(['D', 'R', 'U']), null);
  assert.equal(GS.recognize({ invalid: 'x', strokes: [{ dir: 'R' }] }), null);
  assert.equal(GS.recognize({ pending: {}, strokes: [{ dir: 'R' }] }), 'R', '線が決まった後の保留は確定した形のまま');
  assert.equal(GS.recognize({ pending: {}, strokes: [] }), null, '最初の線が決まる前の保留は形にしない');
  assert.equal(GS.arrows('DR'), '↓ →');
  for (const id of C.GESTURES) {
    const d = GS.diagram(id, 40, 8);
    // 始点 → 終点の向きが形の最後の方向と一致する
    const last = id[id.length - 1];
    const tip = d.arrow[0];
    const prev = d.line[d.line.length - 1];
    const dx = Math.sign(tip[0] - prev[0]);
    const dy = Math.sign(tip[1] - prev[1]);
    assert.deepEqual([dx, dy], { L: [-1, 0], R: [1, 0], U: [0, -1], D: [0, 1] }[last], id);
    for (const p of [...d.line, ...d.arrow]) assert.ok(p[0] >= 0 && p[0] <= 40 && p[1] >= 0 && p[1] <= 40, id);
    if (id.length === 2) {
      const first = id[0];
      const s = d.start;
      const corner = d.line[1];
      const v = [Math.sign(corner[0] - s[0]), Math.sign(corner[1] - s[1])];
      assert.deepEqual(v, { L: [-1, 0], R: [1, 0], U: [0, -1], D: [0, 1] }[first], id + ' の 1 本目');
    }
  }
});

test('A18: 保存応答の順序が逆転しても最新の状態を上書きしない', () => {
  const s = L.createSaveTracker();
  const a = s.begin({ v: 1 });
  const b = s.begin({ v: 2 });
  assert.equal(s.state, 'saving');
  let r = s.complete(b, true);
  assert.equal(r.isLatest, true);
  assert.equal(s.state, 'saved');
  r = s.complete(a, false);
  assert.equal(r.isLatest, false);
  assert.equal(s.state, 'saved', '古い失敗で上書きしない');
  const c = s.begin({ v: 3 });
  s.complete(c, false);
  assert.equal(s.state, 'failed');
  assert.deepEqual(s.latestSnapshot(), { v: 3 }, '最新の編集内容を再保存できる');
});

test('A29: 有効化の保存成功後に 1 回だけ再診断する (応答の逆転にも対応)', () => {
  const s = L.createSaveTracker();
  const enable = s.begin({ enabled: true }, { diagnose: true });
  const other = s.begin({ enabled: true, wrapTabs: false });
  // 後続の保存の応答が先に届く: 全設定のスナップショットなので有効化も保存済み
  let r = s.complete(other, true);
  assert.equal(r.diagnose, true);
  r = s.complete(enable, true);
  assert.equal(r.diagnose, false, '古い応答で繰り返し診断しない');
  assert.equal(s.state, 'saved');

  const t = L.createSaveTracker();
  const e2 = t.begin({}, { diagnose: true });
  r = t.complete(e2, false);
  assert.equal(r.diagnose, false, '失敗では診断しない');
  assert.equal(t.pendingDiagnose, true);
  const retry = t.begin(t.latestSnapshot(), null);
  r = t.complete(retry, true);
  assert.equal(r.diagnose, true, '再試行の成功で必要な再診断を引き継ぐ');

  const u = L.createSaveTracker();
  const before = u.begin({});
  u.begin({}, { diagnose: true });
  assert.equal(u.complete(before, true).diagnose, false, '有効化より前の保存成功では診断しない');
});

test('診断要求は最新の応答だけを表示する', () => {
  const q = L.createSequencer();
  const a = q.next();
  const b = q.next();
  assert.equal(q.isLatest(a), false);
  assert.equal(q.isLatest(b), true);
});
