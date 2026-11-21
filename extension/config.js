/*
 * 共通設定: ジェスチャー・操作の一覧、初期設定、検証と正規化。
 * Service Worker / ポップアップ / コンテンツスクリプト / Node.js のテストで共用する。
 */
(function (root) {
  'use strict';

  const GESTURES = Object.freeze(['L', 'R', 'U', 'D', 'DR', 'DL', 'UR', 'UL', 'RU', 'RD', 'LU', 'LD']);
  const LEGACY_GESTURES = Object.freeze(['L', 'R', 'U', 'D', 'DR', 'DL', 'UR', 'UL']);

  const ACTIONS = Object.freeze([
    'none',
    'previous-tab',
    'next-tab',
    'close-tab',
    'close-window',
    'new-tab',
    'restore-closed',
    'reload',
    'hard-reload',
    'go-back',
    'go-forward',
    'duplicate-tab',
    'toggle-pin'
  ]);

  // 説明用の表示だけに使う。 OS へキーを送ることはしない。
  const SHORTCUTS = Object.freeze({
    'none': '',
    'previous-tab': 'Ctrl+Shift+Tab',
    'next-tab': 'Ctrl+Tab',
    'close-tab': 'Ctrl+W',
    'close-window': 'Ctrl+Shift+W',
    'new-tab': 'Ctrl+T',
    'restore-closed': 'Ctrl+Shift+T',
    'reload': 'Ctrl+R',
    'hard-reload': 'Ctrl+Shift+R',
    'go-back': 'Alt+←',
    'go-forward': 'Alt+→',
    'duplicate-tab': '',
    'toggle-pin': ''
  });

  const LANGUAGES = Object.freeze(['auto', 'ja', 'en']);
  const TEXT_SIZES = Object.freeze(['small', 'medium', 'large']);
  const BOOLEAN_KEYS = Object.freeze(['enabled', 'wrapTabs', 'showFeedback', 'showTrail']);
  const THRESHOLD = Object.freeze({ min: 30, max: 200, fallback: 70 });

  const DEFAULT_GESTURES = Object.freeze({
    L: 'previous-tab',
    R: 'next-tab',
    U: 'none',
    D: 'none',
    DR: 'none',
    DL: 'none',
    UR: 'none',
    UL: 'none',
    RU: 'none',
    RD: 'none',
    LU: 'none',
    LD: 'none'
  });

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    threshold: THRESHOLD.fallback,
    wrapTabs: true,
    showFeedback: true,
    showTrail: true,
    language: 'auto',
    textSize: 'medium',
    gestures: DEFAULT_GESTURES
  });

  const SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));

  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  // 対象外として扱うストア画面。 Google のロゴの有無などでは判定しない。
  const RESTRICTED_SITES = Object.freeze([
    { host: 'chromewebstore.google.com', path: '' },
    { host: 'chrome.google.com', path: '/webstore' },
    { host: 'microsoftedge.microsoft.com', path: '/addons' }
  ]);

  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  function isObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
  }

  function isGesture(id) {
    return typeof id === 'string' && GESTURES.includes(id);
  }

  function isAction(id) {
    return typeof id === 'string' && ACTIONS.includes(id);
  }

  function defaultSettings() {
    return { ...DEFAULT_SETTINGS, gestures: { ...DEFAULT_GESTURES } };
  }

  function normalizeThreshold(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return THRESHOLD.fallback;
    return Math.min(THRESHOLD.max, Math.max(THRESHOLD.min, Math.round(value)));
  }

  function normalizeGestures(raw) {
    const out = { ...DEFAULT_GESTURES };
    if (!isObject(raw)) return out;
    for (const id of GESTURES) {
      if (hasOwn(raw, id)) out[id] = isAction(raw[id]) ? raw[id] : 'none';
    }
    return out;
  }

  /** 不足項目は初期値で補い、不正な値は安全な既定値へ直した完全な設定を返す。 */
  function normalizeSettings(raw) {
    const src = isObject(raw) ? raw : {};
    const out = defaultSettings();
    for (const key of BOOLEAN_KEYS) {
      if (typeof src[key] === 'boolean') out[key] = src[key];
    }
    if (hasOwn(src, 'threshold')) out.threshold = normalizeThreshold(src.threshold);
    if (LANGUAGES.includes(src.language)) out.language = src.language;
    if (TEXT_SIZES.includes(src.textSize)) out.textSize = src.textSize;
    out.gestures = normalizeGestures(src.gestures);
    return out;
  }

  /**
   * 保存要求を検証する。 既知の項目だけを取り出し、型や値が不正なら拒否する。
   * 未知のキーは捨てるので、 任意の操作名やキーで操作を増やすことはできない。
   */
  function validateSettingsPatch(raw) {
    if (!isObject(raw)) return { ok: false, error: 'settings' };
    const patch = {};
    for (const key of BOOLEAN_KEYS) {
      if (!hasOwn(raw, key)) continue;
      if (typeof raw[key] !== 'boolean') return { ok: false, error: key };
      patch[key] = raw[key];
    }
    if (hasOwn(raw, 'threshold')) {
      const t = raw.threshold;
      if (!Number.isInteger(t) || t < THRESHOLD.min || t > THRESHOLD.max) return { ok: false, error: 'threshold' };
      patch.threshold = t;
    }
    if (hasOwn(raw, 'language')) {
      if (!LANGUAGES.includes(raw.language)) return { ok: false, error: 'language' };
      patch.language = raw.language;
    }
    if (hasOwn(raw, 'textSize')) {
      if (!TEXT_SIZES.includes(raw.textSize)) return { ok: false, error: 'textSize' };
      patch.textSize = raw.textSize;
    }
    if (hasOwn(raw, 'gestures')) {
      const g = raw.gestures;
      if (!isObject(g)) return { ok: false, error: 'gestures' };
      const gestures = {};
      for (const id of GESTURES) {
        if (!hasOwn(g, id)) continue;
        if (!isAction(g[id])) return { ok: false, error: 'gestures.' + id };
        gestures[id] = g[id];
      }
      patch.gestures = gestures;
    }
    return { ok: true, patch };
  }

  /** 省略された項目・ジェスチャーは base (その時点の保存値) で補う。 */
  function applySettingsPatch(base, patch) {
    const current = normalizeSettings(base);
    const merged = { ...current, ...patch };
    merged.gestures = { ...current.gestures, ...(patch && patch.gestures ? patch.gestures : {}) };
    return normalizeSettings(merged);
  }

  function cloneSettings(settings) {
    const s = normalizeSettings(settings);
    return { ...s, gestures: { ...s.gestures } };
  }

  function settingsEqual(a, b) {
    const x = normalizeSettings(a);
    const y = normalizeSettings(b);
    for (const key of SETTING_KEYS) {
      if (key === 'gestures') continue;
      if (x[key] !== y[key]) return false;
    }
    return GESTURES.every((id) => x.gestures[id] === y.gestures[id]);
  }

  /** HTTP ページでも使えるよう crypto.getRandomValues() から UUID v4 を作る。 */
  function createUuidV4(cryptoObj) {
    const c = cryptoObj || root.crypto;
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function isUuidV4(value) {
    return typeof value === 'string' && UUID_V4.test(value);
  }

  /** ページの URL を分類する。 kind: web / file / restricted / unknown */
  function classifyUrl(url) {
    if (typeof url !== 'string' || url === '') return { kind: 'unknown' };
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return { kind: 'unknown' };
    }
    if (u.protocol === 'file:') return { kind: 'file', pattern: 'file:///*' };
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'restricted', reason: 'scheme' };
    const host = u.hostname.toLowerCase();
    if (!host) return { kind: 'unknown' };
    for (const rule of RESTRICTED_SITES) {
      if (host !== rule.host) continue;
      if (!rule.path || u.pathname === rule.path || u.pathname.startsWith(rule.path + '/')) {
        return { kind: 'restricted', reason: 'store' };
      }
    }
    return { kind: 'web', pattern: `${u.protocol}//${host}/*`, host };
  }

  const api = Object.freeze({
    GESTURES,
    LEGACY_GESTURES,
    ACTIONS,
    SHORTCUTS,
    LANGUAGES,
    TEXT_SIZES,
    THRESHOLD,
    DEFAULT_GESTURES,
    DEFAULT_SETTINGS,
    SETTING_KEYS,
    isObject,
    isGesture,
    isAction,
    defaultSettings,
    normalizeSettings,
    validateSettingsPatch,
    applySettingsPatch,
    cloneSettings,
    settingsEqual,
    createUuidV4,
    isUuidV4,
    classifyUrl
  });

  root.MGConfig = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
