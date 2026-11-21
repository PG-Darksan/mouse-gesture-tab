/*
 * Service Worker: 設定の保存、 ジェスチャーの実行 (ウィンドウ単位のキュー)、 ページ診断、 スクリプトの準備。
 */
(function (root) {
  'use strict';

  if (typeof importScripts === 'function' && !root.MGConfig) importScripts('config.js', 'i18n.js');
  const C = root.MGConfig || require('./config.js');
  const I18N = root.MGI18n || require('./i18n.js');

  const CONTENT_FILES = Object.freeze(['config.js', 'i18n.js', 'gesture-path.js', 'gesture-shape.js', 'content.js']);
  const QUEUE_LIMIT_TOTAL = 512;
  const QUEUE_LIMIT_WINDOW = 64;
  const HISTORY_LIMIT = 512;
  const PING_TIMEOUT_MS = 1500;
  const PREPARE_CONCURRENCY = 4;
  const GUARD_MAX_MS = 5000;
  const DISPLAY_REASONS = new Set([
    'unassigned',
    'single-tab',
    'tab-edge',
    'no-back-history',
    'no-forward-history',
    'no-closed-session',
    'api-failed',
    'queue-full'
  ]);

  function errorText(err) {
    const text = String((err && err.message) || err || '').trim();
    return (text || 'unknown error').slice(0, 120);
  }

  /** chrome の match pattern (origins) が URL を含むか。 パスは /* だけを想定する。 */
  function originsCover(origins, url) {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return false;
    }
    return origins.some((pattern) => {
      if (pattern === '<all_urls>') return true;
      const m = /^(\*|https?|file):\/\/([^/]*)\//.exec(pattern);
      if (!m) return false;
      const scheme = m[1];
      const authority = m[2].toLowerCase();
      if (scheme === 'file') return u.protocol === 'file:';
      if (scheme === '*' ? !(u.protocol === 'http:' || u.protocol === 'https:') : u.protocol !== scheme + ':') return false;
      const pm = authority.startsWith('[')
        ? /^(\[[^\]]+\])(?::(\*|\d+))?$/.exec(authority)
        : /^([^:]+)(?::(\*|\d+))?$/.exec(authority);
      if (!pm) return false;
      const host = pm[1];
      const port = pm[2] || '';
      if (port && port !== '*') {
        const effectivePort = u.port || (u.protocol === 'https:' ? '443' : '80');
        if (effectivePort !== port) return false;
      }
      const h = u.hostname.toLowerCase();
      if (host === '*') return true;
      if (host.startsWith('*.')) return h === host.slice(2) || h.endsWith(host.slice(1));
      return h === host;
    });
  }

  function createBackground(env) {
    const chromeApi = env.chrome;
    const nav = env.navigator || {};
    const wait = env.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const runtimeId = chromeApi.runtime.id;
    const POPUP_URL = chromeApi.runtime.getURL('popup.html');
    const EXT_ORIGIN = chromeApi.runtime.getURL('');
    const VERSION = chromeApi.runtime.getManifest().version;

    let settings = C.defaultSettings();
    let loaded = false;
    let loadPromise = null;
    let pendingDelta = {};
    let revision = 0;
    let saveTail = Promise.resolve();
    let savesInFlight = 0;

    const windowQueues = new Map();
    let queuedTotal = 0;
    const pendingKeys = new Set();
    const history = new Map();
    const legacyBusy = new Set();
    const injections = new Map();
    const statusChecks = new Map();

    function uiLanguage() {
      try {
        return chromeApi.i18n.getUILanguage();
      } catch (_) {
        return nav.language || '';
      }
    }

    function lang() {
      return I18N.resolveLanguage(settings.language, uiLanguage());
    }

    function fail(reason, extra) {
      const detail = extra && extra.detail ? extra.detail : '';
      const messageKey = 'reason.' + reason;
      const params = { detail };
      return {
        ...(extra || {}),
        ok: false,
        reason,
        messageKey,
        params,
        message: I18N.t(lang(), messageKey, params),
        display: DISPLAY_REASONS.has(reason)
      };
    }

    /* ---------------------------------------------------------- 設定 */

    function ensureLoaded() {
      if (loaded) return Promise.resolve(settings);
      if (!loadPromise) {
        loadPromise = (async () => {
          let lastError = null;
          for (let i = 0; i < 3; i += 1) {
            try {
              const raw = await chromeApi.storage.local.get(C.SETTING_KEYS);
              if (!loaded) {
                // 読み込み中に届いた変更を古い読み込み結果で取り消さない
                settings = C.normalizeSettings({ ...(raw || {}), ...pendingDelta });
                pendingDelta = {};
                loaded = true;
              }
              return settings;
            } catch (err) {
              lastError = err;
              await wait(100 * (i + 1));
            }
          }
          throw lastError || new Error('load failed');
        })().finally(() => {
          loadPromise = null;
        });
      }
      return loadPromise;
    }

    function pickDelta(changes) {
      const delta = {};
      let any = false;
      for (const key of C.SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) {
          delta[key] = changes[key] ? changes[key].newValue : undefined;
          any = true;
        }
      }
      return any ? delta : null;
    }

    function onStorageChanged(changes, area) {
      if (area !== 'local' || !changes) return;
      const delta = pickDelta(changes);
      if (!delta) return;
      if (!loaded) {
        Object.assign(pendingDelta, delta);
        revision += 1;
        return;
      }
      // 自分の保存は保存処理の中でキャッシュを更新する
      if (savesInFlight > 0) return;
      const next = C.normalizeSettings({ ...settings, ...delta });
      if (!C.settingsEqual(next, settings)) {
        settings = next;
        revision += 1;
      }
    }

    async function performSave(patch) {
      try {
        await ensureLoaded();
      } catch (_) {
        // 読み込みに失敗していても、 下で保存値を読み直す
      }
      // 省略された項目は、 この保存の順番が来た時点の保存値で補う
      const raw = await chromeApi.storage.local.get(C.SETTING_KEYS);
      const stored = C.normalizeSettings(raw);
      const next = C.applySettingsPatch(stored, patch);
      settings = next;
      loaded = true;
      try {
        await chromeApi.storage.local.set(C.cloneSettings(next));
      } catch (err) {
        settings = stored;
        revision += 1;
        throw err;
      }
      return next;
    }

    function acceptSave(message) {
      const seq = Number.isSafeInteger(message.seq) ? message.seq : null;
      const checked = C.validateSettingsPatch(message.settings);
      if (!checked.ok) return Promise.resolve(fail('invalid', { seq, field: checked.error }));
      // 受理した時点で改訂を進める。 これより前に受け付けた実行要求は中止される。
      revision += 1;
      savesInFlight += 1;
      const run = saveTail.then(() => performSave(checked.patch));
      saveTail = run.then(
        () => undefined,
        () => undefined
      );
      return run
        .then(
          (saved) => ({ ok: true, seq, settings: C.cloneSettings(saved) }),
          (err) => fail('storage-failed', { seq, detail: errorText(err) })
        )
        .finally(() => {
          savesInFlight -= 1;
        });
    }

    /* ---------------------------------------------------------- 実行 */

    function isContentSender(sender) {
      const tab = sender && sender.tab;
      if (!tab || !Number.isInteger(tab.id) || tab.id < 0) return false;
      if (!Number.isInteger(tab.windowId) || tab.windowId < 0) return false;
      if (typeof sender.url === 'string' && sender.url.startsWith(EXT_ORIGIN)) return false;
      return true;
    }

    function isPopupSender(sender) {
      return !!sender && sender.id === runtimeId && sender.url === POPUP_URL;
    }

    function remember(key, outcome) {
      history.delete(key);
      history.set(key, outcome);
      while (history.size > HISTORY_LIMIT) history.delete(history.keys().next().value);
    }

    function enqueue(windowId, job) {
      let queue = windowQueues.get(windowId);
      if (queuedTotal >= QUEUE_LIMIT_TOTAL || (queue && queue.size >= QUEUE_LIMIT_WINDOW)) return null;
      if (!queue) {
        queue = { tail: Promise.resolve(), size: 0 };
        windowQueues.set(windowId, queue);
      }
      queue.size += 1;
      queuedTotal += 1;
      const run = queue.tail.then(job);
      // 失敗してもキューは止めない
      queue.tail = run.then(
        () => undefined,
        () => undefined
      );
      const q = queue;
      return run.finally(() => {
        q.size -= 1;
        queuedTotal -= 1;
        if (q.size === 0 && windowQueues.get(windowId) === q) windowQueues.delete(windowId);
      });
    }

    function sameTicket(ticket) {
      return ticket.revision === revision && ticket.saveTail === saveTail;
    }

    function handleExecute(message, sender, legacyGesture) {
      if (!isContentSender(sender)) return Promise.resolve(fail('forbidden'));
      const gesture = legacyGesture || message.gesture;
      if (!C.isGesture(gesture)) return Promise.resolve(fail('invalid'));
      const hasId = message.gestureId !== undefined && message.gestureId !== null;
      if (hasId && !C.isUuidV4(message.gestureId)) return Promise.resolve(fail('invalid'));
      if (message.action !== undefined && !C.isAction(message.action)) return Promise.resolve(fail('invalid'));

      const tabId = sender.tab.id;
      const windowId = sender.tab.windowId;
      // 受付時の設定改訂と保存キューを同期的に捕捉する
      const ticket = { revision, saveTail };
      let key = null;
      if (hasId) {
        key = windowId + ':' + message.gestureId.toLowerCase();
        if (pendingKeys.has(key) || history.has(key)) return Promise.resolve(fail('duplicate'));
      } else if (legacyBusy.has(windowId)) {
        return Promise.resolve(fail('busy'));
      }

      const request = { gesture, expected: message.action, tabId, windowId, ticket };
      const queued = enqueue(windowId, () => runGesture(request));
      if (!queued) return Promise.resolve(fail('queue-full'));
      if (key) pendingKeys.add(key);
      else legacyBusy.add(windowId);

      return queued
        .then(
          (result) => result,
          (err) => fail('api-failed', { detail: errorText(err) })
        )
        .then((result) => {
          if (key) {
            pendingKeys.delete(key);
            remember(key, result.ok ? 'ok' : result.reason);
          } else {
            legacyBusy.delete(windowId);
          }
          return result;
        });
    }

    async function runGesture(req) {
      try {
        await ensureLoaded();
      } catch (_) {
        return fail('settings-unavailable');
      }
      // 受付前に受理済みの保存は反映を待つ
      await req.ticket.saveTail;
      if (!sameTicket(req.ticket)) return fail('settings-changed');
      if (!settings.enabled) return fail('disabled');
      const action = settings.gestures[req.gesture];
      if (req.expected !== undefined && req.expected !== action) return fail('settings-changed');
      if (action === 'none') return fail('unassigned');

      let tab = null;
      try {
        tab = await chromeApi.tabs.get(req.tabId);
      } catch (_) {
        tab = null;
      }
      if (!tab || tab.windowId !== req.windowId || !tab.active) return fail('stale-tab');
      if (!sameTicket(req.ticket)) return fail('settings-changed');
      try {
        return await runAction(action, tab, req);
      } catch (err) {
        return fail('api-failed', { detail: errorText(err) });
      }
    }

    async function switchTab(tab, step, req) {
      const tabs = await chromeApi.tabs.query({ windowId: tab.windowId });
      tabs.sort((a, b) => a.index - b.index);
      const index = tabs.findIndex((t) => t.id === tab.id);
      if (index < 0 || !tabs[index].active) return fail('stale-tab');
      if (tabs.length < 2) return fail('single-tab');
      let target = index + step;
      if (target < 0 || target >= tabs.length) {
        if (!settings.wrapTabs) return fail('tab-edge');
        target = (target + tabs.length) % tabs.length;
      }
      if (!sameTicket(req.ticket)) return fail('settings-changed');
      await chromeApi.tabs.update(tabs[target].id, { active: true });
      return { ok: true, action: step > 0 ? 'next-tab' : 'previous-tab' };
    }

    async function runAction(action, tab, req) {
      switch (action) {
        case 'previous-tab':
          return switchTab(tab, -1, req);
        case 'next-tab':
          return switchTab(tab, 1, req);
        case 'close-tab':
          await chromeApi.tabs.remove(tab.id);
          break;
        case 'close-window':
          await chromeApi.windows.remove(tab.windowId);
          break;
        case 'new-tab':
          // URL を指定しないので標準の新規タブが開く
          await chromeApi.tabs.create({ windowId: tab.windowId, index: tab.index + 1, active: true });
          break;
        case 'restore-closed':
          try {
            await chromeApi.sessions.restore();
          } catch (err) {
            if (/no recently closed sessions/i.test(errorText(err))) return fail('no-closed-session');
            throw err;
          }
          break;
        case 'reload':
          await chromeApi.tabs.reload(tab.id, { bypassCache: false });
          break;
        case 'hard-reload':
          await chromeApi.tabs.reload(tab.id, { bypassCache: true });
          break;
        case 'go-back':
          try {
            await chromeApi.tabs.goBack(tab.id);
          } catch (err) {
            if (/Cannot find a next page in history|Cannot go back/i.test(errorText(err))) return fail('no-back-history');
            throw err;
          }
          break;
        case 'go-forward':
          try {
            await chromeApi.tabs.goForward(tab.id);
          } catch (err) {
            if (/Cannot find a next page in history|Cannot go forward/i.test(errorText(err))) return fail('no-forward-history');
            throw err;
          }
          break;
        case 'duplicate-tab':
          await chromeApi.tabs.duplicate(tab.id);
          break;
        case 'toggle-pin':
          await chromeApi.tabs.update(tab.id, { pinned: !tab.pinned });
          break;
        case 'scroll-up':
        case 'scroll-down':
        case 'scroll-left':
        case 'scroll-right':
          // スクロール操作はコンテンツスクリプト側で押下中に連続実行する
          break;
        default:
          return fail('invalid');
      }
      return { ok: true, action };
    }

    function relayGuard(tabId, message) {
      const ms = Math.min(Math.max(Number(message.ms) || 0, 0), GUARD_MAX_MS);
      const token = String(message.token || '').slice(0, 64);
      Promise.resolve()
        .then(() => chromeApi.tabs.sendMessage(tabId, { type: 'gesture-menu-guard', token, ms }))
        .catch(() => {});
    }

    // 別オリジンの iframe などへ入ったドラッグの移動量を、 同じタブの全フレームへ中継する
    function relayMove(tabId, message) {
      if (message.kind !== 'move' && message.kind !== 'up') return;
      if (!Array.isArray(message.points) || message.points.length > 64) return;
      const points = [];
      for (const p of message.points) {
        if (!Array.isArray(p) || p.length !== 2) return;
        if (!p.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6)) return;
        points.push([p[0], p[1]]);
      }
      if (typeof message.at !== 'number' || !Number.isFinite(message.at)) return;
      const token = String(message.token || '').slice(0, 64);
      Promise.resolve()
        .then(() => chromeApi.tabs.sendMessage(tabId, { type: 'gesture-relay', token, kind: message.kind, points, at: message.at }))
        .catch(() => {});
    }

    // スクロール不可な子フレームからの連続スクロール開始・停止要求を、 同じタブのメインフレームへ中継する
    function relayScroll(tabId, message) {
      const mode = message.mode;
      if (mode !== 'start' && mode !== 'stop') return;
      if (mode === 'start' && !C.isScrollAction(message.action)) return;
      const token = String(message.token || '').slice(0, 64);
      const payload =
        mode === 'start'
          ? { type: 'gesture-scroll', mode: 'start', action: message.action, token }
          : { type: 'gesture-scroll', mode: 'stop', token };
      Promise.resolve()
        .then(() => chromeApi.tabs.sendMessage(tabId, payload, { frameId: 0 }))
        .catch(() => {});
    }

    /* ---------------------------------------------------------- 診断・注入 */

    function status(state, tab, extra) {
      const messageKey = (extra && extra.messageKey) || 'status.' + state;
      return {
        canRequest: false,
        ...(extra || {}),
        ok: true,
        state,
        messageKey,
        message: I18N.t(lang(), messageKey),
        tabId: tab ? tab.id : null,
        version: VERSION
      };
    }

    function ping(tabId) {
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), PING_TIMEOUT_MS);
      });
      const request = Promise.resolve()
        .then(() => chromeApi.tabs.sendMessage(tabId, { type: 'gesture-ping' }, { frameId: 0 }))
        .catch(() => null);
      return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
    }

    function goodPong(pong) {
      return !!pong && pong.ok === true && pong.version === VERSION && pong.ready === true;
    }

    function staleOrUnready(pong) {
      return !!pong && pong.ok === true && pong.version === VERSION && pong.ready !== true;
    }

    function injectTab(tabId) {
      const existing = injections.get(tabId);
      if (existing) return existing;
      // 読み込み中の iframe (広告など) の完了を待たずにすぐ注入する。 スクリプトは document_start でも動く作り。
      const job = (async () => {
        try {
          await chromeApi.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_FILES, injectImmediately: true });
        } catch (_) {
          // 一部の子フレームの失敗だけでメインフレームまで使えなくしない
          await chromeApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: CONTENT_FILES, injectImmediately: true });
        }
      })().finally(() => {
        injections.delete(tabId);
      });
      injections.set(tabId, job);
      return job;
    }

    async function settlePong(tabId) {
      let pong = await ping(tabId);
      if (staleOrUnready(pong)) {
        await wait(300);
        pong = await ping(tabId);
      }
      return pong;
    }

    function looksLikePdf(url) {
      try {
        return /\.pdf$/i.test(new URL(url).pathname);
      } catch (_) {
        return false;
      }
    }

    function checkContent(tab, cls) {
      const existing = statusChecks.get(tab.id);
      if (existing) return existing;
      const job = (async () => {
        let pong = await settlePong(tab.id);
        if (!goodPong(pong)) {
          try {
            await injectTab(tab.id);
          } catch (_) {
            // 下の再確認で判定する
          }
          pong = await settlePong(tab.id);
        }
        const url = tab.url || tab.pendingUrl || '';
        if (goodPong(pong)) {
          if (String(pong.contentType || '').toLowerCase() === 'application/pdf') {
            return status('restricted', tab, { messageKey: 'status.pdf' });
          }
          return status('ready', tab, { host: cls.host || '' });
        }
        if (looksLikePdf(url)) return status('restricted', tab, { messageKey: 'status.pdf' });
        if (tab.status === 'loading') return status('unavailable', tab);
        return status('reload-required', tab);
      })().finally(() => {
        statusChecks.delete(tab.id);
      });
      statusChecks.set(tab.id, job);
      return job;
    }

    async function getPageStatus() {
      let tab = null;
      try {
        [tab] = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
      } catch (_) {
        tab = null;
      }
      if (!tab || !Number.isInteger(tab.id)) return status('no-tab', null);
      try {
        await ensureLoaded();
      } catch (_) {
        // 既定値で判定を続ける
      }
      if (!settings.enabled) return status('disabled', tab);
      const cls = C.classifyUrl(tab.url || tab.pendingUrl || '');
      // URL が分からない時は権限不足と決め付けない
      if (cls.kind === 'unknown') return status('unavailable', tab);
      if (cls.kind === 'restricted') {
        return status('restricted', tab, { messageKey: cls.reason === 'store' ? 'status.restricted-store' : 'status.restricted' });
      }
      if (cls.kind === 'file') {
        let allowed = false;
        try {
          allowed = await chromeApi.extension.isAllowedFileSchemeAccess();
        } catch (_) {
          allowed = false;
        }
        if (!allowed) return status('permission-required', tab, { messageKey: 'status.permission-file', canRequest: false, isFile: true });
      } else {
        // activeTab の一時許可ではなく、 永続的なサイト権限を確認する
        if (!(await hasWebPermission(tab.url || tab.pendingUrl || '', cls))) {
          return status('permission-required', tab, { canRequest: true, origin: cls.pattern, host: cls.host });
        }
      }
      return checkContent(tab, cls);
    }

    async function hasWebPermission(url, cls) {
      try {
        if (await chromeApi.permissions.contains({ origins: [cls.pattern] })) return true;
        const u = new URL(url);
        if (u.port) {
          const portPattern = `${u.origin}/*`;
          if (portPattern !== cls.pattern) return !!(await chromeApi.permissions.contains({ origins: [portPattern] }));
        }
      } catch (_) {
        return false;
      }
      return false;
    }

    async function prepareTab(tab) {
      const cls = C.classifyUrl(tab.url || '');
      if (cls.kind === 'web') {
        if (!(await hasWebPermission(tab.url || '', cls))) return;
      } else if (cls.kind === 'file') {
        if (!(await chromeApi.extension.isAllowedFileSchemeAccess())) return;
      } else {
        return;
      }
      if (goodPong(await ping(tab.id))) return;
      await injectTab(tab.id);
    }

    /** 導入・起動・サイト許可の追加時に、 開いているページを準備する。 */
    async function prepareOpenTabs(origins) {
      let tabs = [];
      try {
        tabs = await chromeApi.tabs.query({});
      } catch (_) {
        return;
      }
      const work = tabs.filter((tab) => {
        if (!Number.isInteger(tab.id) || tab.discarded) return false;
        const cls = C.classifyUrl(tab.url || '');
        if (cls.kind !== 'web' && cls.kind !== 'file') return false;
        return !origins || originsCover(origins, tab.url);
      });
      let next = 0;
      const worker = async () => {
        while (next < work.length) {
          const tab = work[next];
          next += 1;
          try {
            await prepareTab(tab);
          } catch (_) {
            // 次のタブへ進む
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(PREPARE_CONCURRENCY, work.length) }, worker));
    }

    function isEdge() {
      const brands = nav.userAgentData && nav.userAgentData.brands;
      if (Array.isArray(brands) && brands.some((b) => /Microsoft Edge/i.test(String(b && b.brand)))) return true;
      return /\bEdg\//.test(String(nav.userAgent || ''));
    }

    async function openSiteSettings() {
      const url = (isEdge() ? 'edge' : 'chrome') + '://extensions/?id=' + runtimeId;
      try {
        await chromeApi.tabs.create({ url });
        return { ok: true, url };
      } catch (err) {
        return fail('api-failed', { detail: errorText(err) });
      }
    }

    /* ---------------------------------------------------------- メッセージ */

    function onMessage(message, sender, sendResponse) {
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return false;
      if (!sender || sender.id !== runtimeId) return false;
      const reply = (promise) => {
        Promise.resolve(promise).then(sendResponse, (err) => sendResponse(fail('api-failed', { detail: errorText(err) })));
        return true;
      };
      switch (message.type) {
        case 'prepare-gesture':
          if (!isContentSender(sender)) return reply(fail('forbidden'));
          return reply(ensureLoaded().then(() => ({ ok: true }), () => fail('settings-unavailable')));
        case 'execute-gesture':
          return reply(handleExecute(message, sender, null));
        case 'switch-tab': {
          const legacy = message.direction === -1 ? 'L' : message.direction === 1 ? 'R' : null;
          if (!legacy) return reply(fail('invalid'));
          return reply(handleExecute({}, sender, legacy));
        }
        case 'menu-guard':
          if (!isContentSender(sender)) return false;
          relayGuard(sender.tab.id, message);
          sendResponse({ ok: true });
          return false;
        case 'gesture-relay':
          if (!isContentSender(sender)) return false;
          relayMove(sender.tab.id, message);
          sendResponse({ ok: true });
          return false;
        case 'scroll-top-frame':
          if (!isContentSender(sender)) return false;
          relayScroll(sender.tab.id, message);
          sendResponse({ ok: true });
          return false;
        case 'save-settings':
          if (!isPopupSender(sender)) return reply(fail('forbidden'));
          return reply(acceptSave(message));
        case 'get-page-status':
          if (!isPopupSender(sender)) return reply(fail('forbidden'));
          return reply(getPageStatus());
        case 'open-site-settings':
          if (!isPopupSender(sender)) return reply(fail('forbidden'));
          return reply(openSiteSettings());
        default:
          return false;
      }
    }

    function register() {
      chromeApi.runtime.onMessage.addListener(onMessage);
      chromeApi.storage.onChanged.addListener(onStorageChanged);
      chromeApi.runtime.onInstalled.addListener((details) => {
        if (details && (details.reason === 'install' || details.reason === 'update')) prepareOpenTabs(null);
      });
      chromeApi.runtime.onStartup.addListener(() => {
        prepareOpenTabs(null);
      });
      if (chromeApi.permissions && chromeApi.permissions.onAdded) {
        chromeApi.permissions.onAdded.addListener((perms) => {
          const origins = perms && Array.isArray(perms.origins) ? perms.origins : [];
          if (origins.length) prepareOpenTabs(origins);
        });
      }
      ensureLoaded().catch(() => {});
    }

    return {
      register,
      onMessage,
      onStorageChanged,
      ensureLoaded,
      acceptSave,
      handleExecute,
      getPageStatus,
      prepareOpenTabs,
      injectTab,
      openSiteSettings,
      get settings() {
        return settings;
      },
      get revision() {
        return revision;
      },
      get queuedTotal() {
        return queuedTotal;
      },
      get historySize() {
        return history.size;
      }
    };
  }

  const api = { createBackground, originsCover, CONTENT_FILES, QUEUE_LIMIT_TOTAL, QUEUE_LIMIT_WINDOW, HISTORY_LIMIT };

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else if (root.chrome && root.chrome.runtime && root.chrome.runtime.id) {
    root.MGBackground = createBackground({ chrome: root.chrome, navigator: root.navigator });
    root.MGBackground.register();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
