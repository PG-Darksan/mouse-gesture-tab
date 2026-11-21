/*
 * 設定ポップアップ。 変更はその場で自動保存する (Service Worker へ全設定のスナップショットを送る)。
 */
(function () {
  'use strict';

  const C = globalThis.MGConfig;
  const I = globalThis.MGI18n;
  const GS = globalThis.MGGestureShape;
  const L = globalThis.MGPopupLogic;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SWITCHES = ['enabled', 'wrapTabs', 'showTrail', 'showFeedback'];
  const TONE = {
    'checking': 'busy',
    'ready': 'ok',
    'permission-required': 'warn',
    'reload-required': 'warn',
    'unavailable': 'warn',
    'restricted': 'off',
    'disabled': 'off',
    'no-tab': 'off'
  };

  const $ = (id) => document.getElementById(id);
  const state = {
    settings: C.defaultSettings(),
    loaded: false,
    loadFailed: false,
    lang: 'ja',
    status: { state: 'checking' },
    statusNote: null,
    permissionPending: false
  };
  const saver = L.createSaveTracker();
  const statusSeq = L.createSequencer();
  const rows = {};
  let diagnoseTimer = null;

  function uiLanguage() {
    try {
      return chrome.i18n.getUILanguage();
    } catch (_) {
      return navigator.language || '';
    }
  }

  function t(key, params) {
    return I.t(state.lang, key, params);
  }

  function call(fn) {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /* ---------------------------------------------------------- 割り当て欄 */

  function svg(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function buildMapping() {
    const list = $('mappingList');
    for (const id of C.GESTURES) {
      const li = document.createElement('li');
      li.className = 'row';
      li.dataset.gesture = id;

      const d = GS.diagram(id, 40, 8);
      const icon = svg('svg', { viewBox: '0 0 40 40', class: 'diagram', role: 'img' }, li);
      const title = svg('title', {}, icon);
      svg('polyline', { class: 'path', points: d.line.map((p) => p.join(',')).join(' ') }, icon);
      svg('polygon', { class: 'head', points: d.arrow.map((p) => p.join(',')).join(' ') }, icon);
      svg('circle', { class: 'start', cx: String(d.start[0]), cy: String(d.start[1]), r: '3.6' }, icon);

      const label = document.createElement('label');
      label.className = 'name';
      label.htmlFor = 'g-' + id;
      const arrows = document.createElement('span');
      arrows.className = 'arrows';
      arrows.setAttribute('aria-hidden', 'true');
      arrows.textContent = GS.arrows(id);
      // 名前は矢印と同じ内容なので、 幅を選択欄に回すため読み上げ用にだけ残す
      const name = document.createElement('span');
      name.className = 'shape-name visually-hidden';
      label.append(arrows, name);

      const select = document.createElement('select');
      select.id = 'g-' + id;
      for (const action of C.ACTIONS) {
        const option = document.createElement('option');
        option.value = action;
        select.appendChild(option);
      }
      select.addEventListener('change', () => {
        update((s) => {
          s.gestures[id] = select.value;
        });
      });

      li.append(label, select);
      list.appendChild(li);
      rows[id] = { icon, title, name, select };
    }
  }

  /* ---------------------------------------------------------- 表示 */

  function applyLayout() {
    document.body.dataset.size = state.settings.textSize;
  }

  function applyLanguage() {
    state.lang = I.resolveLanguage(state.settings.language, uiLanguage());
    document.documentElement.lang = state.lang;
    document.title = t('extName');
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel));
    for (const option of $('textSize').options) option.textContent = t('textSize.' + option.value);
    for (const option of $('language').options) option.textContent = t('language.' + option.value);
    for (const id of C.GESTURES) {
      const row = rows[id];
      const shape = I.shapeLabel(state.lang, id);
      const description = t('mapping.diagram', { shape, steps: I.shapeSteps(state.lang, id) });
      row.name.textContent = shape;
      row.title.textContent = description;
      row.icon.setAttribute('aria-label', description);
      row.select.setAttribute('aria-label', t('mapping.select', { shape }));
      row.select.title = description;
      for (const option of row.select.options) {
        const shortcut = C.SHORTCUTS[option.value];
        option.textContent = I.actionLabel(state.lang, option.value) + (shortcut ? ` (${shortcut})` : '');
      }
    }
    $('footerLink').setAttribute('aria-label', t('footer.linkLabel'));
    $('footerLink').title = t('footer.linkLabel');
    applyLayout();
    renderStatus();
    renderSave();
  }

  function renderSettings() {
    for (const key of SWITCHES) $(key).checked = !!state.settings[key];
    $('textSize').value = state.settings.textSize;
    $('language').value = state.settings.language;
    for (const id of C.GESTURES) rows[id].select.value = state.settings.gestures[id];
  }

  function setInputsEnabled(on) {
    for (const key of SWITCHES) $(key).disabled = !on;
    $('textSize').disabled = !on;
    $('language').disabled = !on;
    for (const id of C.GESTURES) rows[id].select.disabled = !on;
  }

  function renderSave() {
    const el = $('saveStatus');
    let key = 'save.auto';
    let view = saver.state;
    if (!state.loaded) {
      key = state.loadFailed ? 'load.failed' : 'save.loading';
      view = state.loadFailed ? 'failed' : 'loading';
    } else if (saver.state === 'saving') key = 'save.saving';
    else if (saver.state === 'saved') key = 'save.saved';
    else if (saver.state === 'failed') key = 'save.failed';
    el.textContent = t(key);
    el.dataset.state = view;
    $('retrySave').hidden = !(state.loaded && saver.state === 'failed');
    $('loadError').hidden = !state.loadFailed;
  }

  function renderStatus() {
    const st = state.status || { state: 'checking' };
    $('statusBox').dataset.tone = TONE[st.state] || 'warn';
    let text = st.state === 'checking' ? t('status.checking') : t(st.messageKey || 'status.' + st.state);
    if (st.host && (st.state === 'ready' || st.state === 'permission-required')) text += ' — ' + st.host;
    if (state.statusNote) text = t(state.statusNote);
    $('statusText').textContent = text;
    const allow = $('allowSite');
    const canAllow = st.state === 'permission-required' && st.canRequest === true && typeof st.origin === 'string';
    allow.hidden = !canAllow;
    allow.disabled = state.permissionPending;
    allow.title = canAllow ? t('button.allowSite.tip', { host: st.host || st.origin }) : '';
  }

  /* ---------------------------------------------------------- 読み込み・保存 */

  function load() {
    state.loaded = false;
    state.loadFailed = false;
    setInputsEnabled(false);
    renderSave();
    const delta = {};
    let done = false;
    const onChanged = (changes, area) => {
      if (done || area !== 'local' || !changes) return;
      for (const key of C.SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) delta[key] = changes[key] ? changes[key].newValue : undefined;
      }
    };
    const stop = () => {
      done = true;
      try {
        chrome.storage.onChanged.removeListener(onChanged);
      } catch (_) {
        // 何もしない
      }
    };
    try {
      chrome.storage.onChanged.addListener(onChanged);
    } catch (_) {
      // 何もしない
    }
    call(() => chrome.storage.local.get(C.SETTING_KEYS)).then(
      (raw) => {
        stop();
        // 読み込み中に届いた変更を古い読み込み結果で取り消さない
        state.settings = C.normalizeSettings({ ...(raw || {}), ...delta });
        state.loaded = true;
        renderSettings();
        applyLanguage();
        setInputsEnabled(true);
        renderSave();
      },
      () => {
        stop();
        state.loadFailed = true;
        renderSave();
      }
    );
  }

  function update(mutate, options) {
    if (!state.loaded) return;
    mutate(state.settings);
    state.settings = C.normalizeSettings(state.settings);
    const snapshot = C.cloneSettings(state.settings);
    const seq = saver.begin(snapshot, options);
    renderSave();
    sendSave(seq, snapshot);
  }

  function sendSave(seq, snapshot) {
    call(() => chrome.runtime.sendMessage({ type: 'save-settings', settings: snapshot, seq })).then(
      (resp) => onSaved(seq, !!(resp && resp.ok && resp.seq === seq)),
      () => onSaved(seq, false)
    );
  }

  function onSaved(seq, ok) {
    const result = saver.complete(seq, ok);
    if (result.isLatest) renderSave();
    if (result.diagnose) diagnose();
  }

  function retrySave() {
    const snapshot = saver.latestSnapshot();
    if (!snapshot) return;
    const seq = saver.begin(snapshot, null);
    renderSave();
    sendSave(seq, snapshot);
  }

  /* ---------------------------------------------------------- 診断・許可 */

  function diagnose() {
    const id = statusSeq.next();
    state.status = { state: 'checking' };
    state.statusNote = null;
    renderStatus();
    call(() => chrome.runtime.sendMessage({ type: 'get-page-status' })).then(
      (resp) => {
        if (!statusSeq.isLatest(id)) return;
        state.status = resp && resp.ok && typeof resp.state === 'string' ? resp : { state: 'unavailable' };
        renderStatus();
      },
      () => {
        if (!statusSeq.isLatest(id)) return;
        state.status = { state: 'unavailable' };
        renderStatus();
      }
    );
  }

  // 権限イベントや再確認が重なった時は 1 回にまとめる
  function scheduleDiagnose() {
    if (diagnoseTimer) clearTimeout(diagnoseTimer);
    diagnoseTimer = setTimeout(() => {
      diagnoseTimer = null;
      diagnose();
    }, 60);
  }

  function requestSitePermission() {
    const st = state.status;
    if (state.permissionPending || !st || st.state !== 'permission-required' || st.canRequest !== true || typeof st.origin !== 'string') return;
    let request;
    try {
      // ユーザーのクリック内で、 他の非同期処理を待つ前に呼ぶ。 対象はこのホスト 1 件だけ。
      request = chrome.permissions.request({ origins: [st.origin] });
    } catch (_) {
      permissionDone(false, true);
      return;
    }
    state.permissionPending = true;
    state.statusNote = 'status.requesting';
    renderStatus();
    Promise.resolve(request).then(
      (granted) => permissionDone(!!granted, false),
      () => permissionDone(false, true)
    );
  }

  function permissionDone(granted, failed) {
    state.permissionPending = false;
    if (granted) {
      state.statusNote = null;
      scheduleDiagnose();
      return;
    }
    state.statusNote = failed ? 'status.permission-error' : 'status.permission-denied';
    renderStatus();
  }

  /* ---------------------------------------------------------- 初期化 */

  function bind() {
    for (const key of SWITCHES) {
      $(key).addEventListener('change', (e) => {
        update(
          (s) => {
            s[key] = e.target.checked;
          },
          { diagnose: key === 'enabled' }
        );
      });
    }
    $('textSize').addEventListener('change', (e) => {
      update((s) => {
        s.textSize = e.target.value;
      });
      applyLayout();
    });
    $('language').addEventListener('change', (e) => {
      update((s) => {
        s.language = e.target.value;
      });
      applyLanguage();
    });
    $('retrySave').addEventListener('click', retrySave);
    $('reloadSettings').addEventListener('click', load);
    $('recheck').addEventListener('click', scheduleDiagnose);
    $('allowSite').addEventListener('click', requestSitePermission);
    $('siteSettings').addEventListener('click', () => {
      call(() => chrome.runtime.sendMessage({ type: 'open-site-settings' })).catch(() => {});
    });
    try {
      chrome.permissions.onAdded.addListener(scheduleDiagnose);
      chrome.permissions.onRemoved.addListener(scheduleDiagnose);
    } catch (_) {
      // 何もしない
    }
  }

  buildMapping();
  bind();
  applyLanguage();
  setInputsEnabled(false);
  load();
  diagnose();
})();
