'use strict';
// Service Worker のテスト用の chrome API の偽物。 必要な部分だけを実装する。

function createEvent() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    emit: (...args) => {
      for (const fn of [...listeners]) fn(...args);
    },
    get size() {
      return listeners.size;
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await tick();
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function createFakeChrome(options = {}) {
  const id = options.id || 'abcdefghijklmnopabcdefghijklmnop';
  const base = `chrome-extension://${id}/`;
  const version = options.version || '3.5.0';
  const store = clone(options.storage || {});
  const calls = [];
  const overrides = {};
  const tabs = new Map();
  let nextTabId = 1;
  let lastFocusedWindow = 1;
  const granted = new Set(options.origins || ['http://*/*', 'https://*/*']);
  const state = { fileAccess: options.fileAccess !== undefined ? options.fileAccess : true, uiLanguage: options.uiLanguage || 'ja' };
  const contentFrames = new Map(); // tabId → { version, ready, contentType } (メインフレームの応答)
  const messageLog = [];

  function record(name, args) {
    calls.push({ name, args: clone(args) });
  }

  async function call(name, args, impl) {
    record(name, args);
    if (overrides[name]) return overrides[name](args, impl);
    return impl(...args);
  }

  function addTab(props) {
    const tab = {
      id: props.id || nextTabId++,
      windowId: props.windowId || 1,
      index: windowTabs(props.windowId || 1).length,
      active: false,
      pinned: false,
      discarded: false,
      status: 'complete',
      url: 'https://example.com/',
      ...props
    };
    if (tab.id >= nextTabId) nextTabId = tab.id + 1;
    tabs.set(tab.id, tab);
    reindex(tab.windowId);
    if (tab.active) activate(tab.id);
    return tab;
  }

  function windowTabs(windowId) {
    return [...tabs.values()].filter((t) => t.windowId === windowId).sort((a, b) => a.index - b.index);
  }

  function reindex(windowId) {
    windowTabs(windowId).forEach((t, i) => {
      t.index = i;
    });
  }

  function activate(tabId) {
    const tab = tabs.get(tabId);
    for (const t of tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === tabId;
  }

  function activeTab(windowId) {
    return windowTabs(windowId).find((t) => t.active) || null;
  }

  function emitStorage(changes) {
    setImmediate(() => chrome.storage.onChanged.emit(changes, 'local'));
  }

  const chrome = {
    runtime: {
      id,
      getURL: (p) => base + p,
      getManifest: () => ({ version }),
      onMessage: createEvent(),
      onInstalled: createEvent(),
      onStartup: createEvent()
    },
    i18n: { getUILanguage: () => state.uiLanguage },
    storage: {
      local: {
        get: (keys) =>
          call('storage.get', [keys], async (k) => {
            const out = {};
            const list = Array.isArray(k) ? k : k == null ? Object.keys(store) : [k];
            for (const key of list) if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = clone(store[key]);
            return out;
          }),
        set: (items) =>
          call('storage.set', [items], async (it) => {
            const changes = {};
            for (const [key, value] of Object.entries(it)) {
              changes[key] = { oldValue: clone(store[key]), newValue: clone(value) };
              store[key] = clone(value);
            }
            emitStorage(changes);
          })
      },
      onChanged: createEvent()
    },
    tabs: {
      get: (tabId) =>
        call('tabs.get', [tabId], async (tid) => {
          const tab = tabs.get(tid);
          if (!tab) throw new Error(`No tab with id: ${tid}.`);
          return { ...tab };
        }),
      query: (q) =>
        call('tabs.query', [q], async (query) => {
          let list = [...tabs.values()];
          if (query.windowId !== undefined) list = list.filter((t) => t.windowId === query.windowId);
          if (query.lastFocusedWindow) list = list.filter((t) => t.windowId === lastFocusedWindow);
          if (query.active !== undefined) list = list.filter((t) => t.active === query.active);
          return list.sort((a, b) => a.windowId - b.windowId || a.index - b.index).map((t) => ({ ...t }));
        }),
      update: (tabId, props) =>
        call('tabs.update', [tabId, props], async (tid, p) => {
          const tab = tabs.get(tid);
          if (!tab) throw new Error(`No tab with id: ${tid}.`);
          if (p.active) activate(tid);
          if (p.pinned !== undefined) tab.pinned = p.pinned;
          return { ...tab };
        }),
      remove: (tabId) =>
        call('tabs.remove', [tabId], async (tid) => {
          const tab = tabs.get(tid);
          if (!tab) throw new Error(`No tab with id: ${tid}.`);
          tabs.delete(tid);
          reindex(tab.windowId);
        }),
      create: (props) =>
        call('tabs.create', [props], async (p) => {
          const tab = addTab({ windowId: p.windowId || lastFocusedWindow, url: p.url || 'chrome://newtab/' });
          if (p.index !== undefined) {
            const list = windowTabs(tab.windowId).filter((t) => t.id !== tab.id);
            list.splice(Math.min(p.index, list.length), 0, tab);
            list.forEach((t, i) => {
              t.index = i;
            });
          }
          if (p.active !== false) activate(tab.id);
          return { ...tab };
        }),
      reload: (tabId, props) => call('tabs.reload', [tabId, props], async () => undefined),
      goBack: (tabId) => call('tabs.goBack', [tabId], async () => undefined),
      goForward: (tabId) => call('tabs.goForward', [tabId], async () => undefined),
      duplicate: (tabId) =>
        call('tabs.duplicate', [tabId], async (tid) => {
          const src = tabs.get(tid);
          return addTab({ windowId: src.windowId, url: src.url });
        }),
      sendMessage: (tabId, message, opts) =>
        call('tabs.sendMessage', [tabId, message, opts], async (tid, msg) => {
          messageLog.push({ tabId: tid, message: clone(msg), options: clone(opts) });
          if (msg.type === 'gesture-ping') {
            const frame = contentFrames.get(tid);
            if (!frame) throw new Error('Could not establish connection. Receiving end does not exist.');
            if (frame.hang) return new Promise(() => {});
            return { ok: true, version: frame.version, ready: frame.ready, readyState: 'complete', contentType: frame.contentType || 'text/html' };
          }
          return undefined;
        })
    },
    windows: {
      remove: (windowId) =>
        call('windows.remove', [windowId], async (wid) => {
          for (const t of [...tabs.values()]) if (t.windowId === wid) tabs.delete(t.id);
        })
    },
    sessions: { restore: () => call('sessions.restore', [], async () => ({})) },
    scripting: {
      executeScript: (injection) =>
        call('scripting.executeScript', [injection], async (inj) => {
          const tab = tabs.get(inj.target.tabId);
          if (!tab) throw new Error('No tab');
          if (options.injectable && !options.injectable(tab)) throw new Error('Cannot access contents of the page.');
          contentFrames.set(tab.id, { version, ready: true });
          return [{ frameId: 0, result: undefined }];
        })
    },
    permissions: {
      contains: (q) => call('permissions.contains', [q], async (query) => (query.origins || []).every((o) => granted.has(o) || coveredByWildcard(o))),
      onAdded: createEvent(),
      onRemoved: createEvent()
    },
    extension: { isAllowedFileSchemeAccess: () => call('extension.isAllowedFileSchemeAccess', [], async () => state.fileAccess) }
  };

  function coveredByWildcard(origin) {
    if (origin.startsWith('http://') && granted.has('http://*/*')) return true;
    if (origin.startsWith('https://') && granted.has('https://*/*')) return true;
    return false;
  }

  /** onMessage へ送り、 sendResponse の値を返す。 応答しない場合は undefined。 */
  function sendRuntime(message, sender) {
    return new Promise((resolve) => {
      let responded = false;
      let async = false;
      for (const fn of [...chrome.runtime.onMessage._listeners()]) {
        const ret = fn(message, sender, (value) => {
          responded = true;
          resolve(value);
        });
        if (ret === true) async = true;
      }
      if (!async && !responded) resolve(undefined);
    });
  }

  // onMessage のリスナー一覧を取り出せるようにする
  const listeners = new Set();
  chrome.runtime.onMessage = {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    _listeners: () => listeners
  };

  return {
    chrome,
    calls,
    overrides,
    store,
    tabs,
    state,
    granted,
    contentFrames,
    messageLog,
    addTab,
    activeTab,
    windowTabs,
    activate,
    setLastFocusedWindow: (w) => {
      lastFocusedWindow = w;
    },
    sendRuntime,
    callsOf: (name) => calls.filter((c) => c.name === name),
    contentSender: (tabId, extra) => {
      const tab = tabs.get(tabId);
      return { id, tab: { ...tab }, frameId: 0, url: tab.url, ...extra };
    },
    popupSender: () => ({ id, url: base + 'popup.html', origin: base.slice(0, -1) })
  };
}

module.exports = { createFakeChrome, createEvent, deferred, tick, settle };
