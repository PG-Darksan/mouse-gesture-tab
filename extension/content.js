/*
 * コンテンツスクリプト: 右ボタンのドラッグを記録し、 軌跡と操作ガイドを表示し、
 * 右ボタンを離した時だけ Service Worker へ実行を要求する。
 */
(function (root) {
  'use strict';

  const C = root.MGConfig;
  const I18N = root.MGI18n;
  const GP = root.MGGesturePath;
  const GS = root.MGGestureShape;

  const INSTANCE_KEY = '__mgTabGestureInstance';
  const TAKEOVER_EVENT = 'mg-tab-gesture:takeover';
  const MENU_SUPPRESS_MS = 600;
  const NOTICE_MS = 3500;
  const ARMED_MAX_MS = 5000;
  const REMOTE_GUARD_MS = 5000;
  const REMOTE_GUARD_REFRESH_MS = 3000;
  const RELAY_INTERVAL_MS = 16;
  const RELAY_MAX_POINTS = 64;
  const RELAY_CLOCK_SLOP_MS = 15;
  const RELEASE_GRACE_MS = 80;
  const OWN_RELEASE_QUIET_MS = 200;
  const EXECUTE_RETRY_DELAYS = Object.freeze([80, 200]);
  const SCROLL_RATIO = 0.8;
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
  const TEXT_PX = { small: 12, medium: 14, large: 16 };
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // 子要素を描画しない要素。 全画面ではこの中へ表示できないので top layer を使う。
  const NO_CHILD_RENDER = new Set(['VIDEO', 'AUDIO', 'IMG', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT', 'INPUT', 'TEXTAREA', 'SELECT']);

  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  function attempt(fn, fallback) {
    try {
      return fn();
    } catch (_) {
      return fallback;
    }
  }

  function canHostChildren(el) {
    if (!el || el.namespaceURI !== XHTML_NS) return false;
    return !NO_CHILD_RENDER.has(String(el.tagName).toUpperCase());
  }

  /* ---------------------------------------------------------------- 表示 */

  const OVERLAY_CSS = `
    .layer { position: fixed; inset: 0; pointer-events: none; color: #12343a;
      font-family: system-ui, "Segoe UI", "Yu Gothic UI", Meiryo, sans-serif; font-size: 14px; line-height: 1.35; }
    svg.trail { position: fixed; inset: 0; width: 100%; height: 100%; overflow: visible; }
    svg.trail polyline { fill: none; stroke-linecap: round; stroke-linejoin: round; }
    svg.trail .edge { stroke: #ffffff; stroke-width: 7px; }
    svg.trail .line { stroke: #159cab; stroke-width: 4px; }
    svg.trail .dot { fill: #159cab; stroke: #ffffff; stroke-width: 2px; }
    svg.trail.invalid { opacity: .45; }
    .card { position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%); box-sizing: border-box;
      max-width: calc(100vw - 32px); display: flex; align-items: center; gap: .8em; padding: .6em 1.1em;
      border-radius: 14px; background: rgba(255,255,255,.97); border: 1px solid rgba(21,156,171,.4);
      box-shadow: 0 6px 24px rgba(0,0,0,.2); }
    .card[hidden] { display: none; }
    .arrows { font-size: 1.7em; font-weight: 700; color: #159cab; white-space: nowrap;
      font-family: "Segoe UI Symbol", "Segoe UI", "Yu Gothic UI", Meiryo, sans-serif; font-variant-emoji: text; }
    .text { display: flex; flex-direction: column; min-width: 0; }
    .shape { font-weight: 700; }
    .action { font-weight: 600; }
    .unassigned .action { color: #8a5a00; }
    .hint { font-size: .82em; color: #4a6268; white-space: nowrap; }
    .notice { font-weight: 600; }
  `;

  const HOST_STYLE = [
    ['all', 'initial'],
    ['position', 'fixed'],
    ['inset', '0'],
    ['width', '100vw'],
    ['height', '100vh'],
    ['max-width', 'none'],
    ['max-height', 'none'],
    ['margin', '0'],
    ['padding', '0'],
    ['border', '0'],
    ['background', 'transparent'],
    ['overflow', 'visible'],
    ['pointer-events', 'none'],
    ['z-index', '2147483647'],
    ['display', 'block'],
    ['visibility', 'visible'],
    ['opacity', '1'],
    ['transform', 'none'],
    ['color-scheme', 'normal']
  ];

  function createDomOverlay(win, doc) {
    let host = null;
    let svgWrap = null;
    let parts = null;
    let popover = false;
    let gestureShown = false;
    let noticeShown = false;
    let shield = false;
    let noticeTimer = null;
    let lastTrail = '';
    let lastGuide = '';

    function el(tag, cls, parent) {
      const node = doc.createElementNS(XHTML_NS, tag);
      if (cls) node.className = cls;
      if (parent) parent.appendChild(node);
      return node;
    }

    function svgEl(tag, cls, parent) {
      const node = doc.createElementNS(SVG_NS, tag);
      if (cls) node.setAttribute('class', cls);
      parent.appendChild(node);
      return node;
    }

    function hasOtherTopLayer() {
      if (attempt(() => doc.querySelector(':modal'), null)) return true;
      const list = attempt(() => doc.querySelectorAll(':popover-open'), null);
      if (!list) return false;
      for (const node of list) {
        if (node !== host) return true;
      }
      return false;
    }

    function applyPointerEvents() {
      if (!host) return;
      host.style.setProperty('pointer-events', shield ? 'auto' : 'none', 'important');
    }

    function build() {
      host = doc.createElementNS(XHTML_NS, 'mg-gesture-overlay');
      for (const [name, value] of HOST_STYLE) host.style.setProperty(name, value, 'important');
      applyPointerEvents();
      const shadow = host.attachShadow({ mode: 'closed' });
      let styled = false;
      try {
        const sheet = new win.CSSStyleSheet();
        sheet.replaceSync(OVERLAY_CSS);
        shadow.adoptedStyleSheets = [sheet];
        styled = true;
      } catch (_) {
        styled = false;
      }
      if (!styled) el('style', '', shadow).textContent = OVERLAY_CSS;
      const layer = el('div', 'layer', shadow);
      const svg = svgEl('svg', 'trail', layer);
      svg.setAttribute('aria-hidden', 'true');
      const edge = svgEl('polyline', 'edge', svg);
      const line = svgEl('polyline', 'line', svg);
      const dot = svgEl('circle', 'dot', svg);
      dot.setAttribute('r', '4');
      const guide = el('div', 'card guide', layer);
      guide.setAttribute('role', 'status');
      guide.setAttribute('aria-live', 'polite');
      guide.hidden = true;
      const arrows = el('span', 'arrows', guide);
      const text = el('span', 'text', guide);
      const shape = el('span', 'shape', text);
      const action = el('span', 'action', text);
      const hint = el('span', 'hint', guide);
      const notice = el('div', 'card notice', layer);
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      notice.hidden = true;
      parts = { layer, svg, edge, line, dot, guide, arrows, shape, action, hint, notice };
    }

    function attach() {
      const fs = attempt(() => doc.fullscreenElement, null);
      const topLayer = !fs && hasOtherTopLayer();
      popover = (!!fs && !canHostChildren(fs)) || topLayer;
      const parent = fs && !popover ? fs : doc.documentElement;
      if (!parent) return false;
      if (parent.namespaceURI === SVG_NS) {
        popover = false;
        host.removeAttribute('popover');
        svgWrap = doc.createElementNS(SVG_NS, 'foreignObject');
        svgWrap.setAttribute('x', '0');
        svgWrap.setAttribute('y', '0');
        svgWrap.setAttribute('width', '100%');
        svgWrap.setAttribute('height', '100%');
        svgWrap.style.pointerEvents = 'none';
        svgWrap.style.overflow = 'visible';
        svgWrap.appendChild(host);
        parent.appendChild(svgWrap);
        return true;
      }
      if (popover) host.setAttribute('popover', 'manual');
      else host.removeAttribute('popover');
      applyPointerEvents();
      parent.appendChild(host);
      if (popover && typeof host.showPopover === 'function') attempt(() => host.showPopover());
      return true;
    }

    function ensure() {
      try {
        if (!host) build();
        if (host.isConnected && !popover && !attempt(() => doc.fullscreenElement, null) && hasOtherTopLayer()) {
          detach();
        }
        if (!host.isConnected && !attach()) return false;
        applyPointerEvents();
        return true;
      } catch (_) {
        host = null;
        svgWrap = null;
        parts = null;
        return false;
      }
    }

    function detach() {
      if (!host) return;
      if (popover) attempt(() => host.hidePopover());
      attempt(() => host.remove());
      if (svgWrap) {
        attempt(() => svgWrap.remove());
        svgWrap = null;
      }
    }

    function detachIfIdle() {
      if (!gestureShown && !noticeShown && !shield) detach();
    }

    // 移動のたびにスタイルを書き換えないよう、 変わった時だけ設定する
    function setAppearance(view) {
      const px = (TEXT_PX[view.textSize] || TEXT_PX.medium) + 'px';
      if (parts.layer.style.fontSize !== px) parts.layer.style.fontSize = px;
      if (parts.layer.lang !== view.lang) parts.layer.lang = view.lang;
    }

    function hideNotice() {
      if (noticeTimer) win.clearTimeout(noticeTimer);
      noticeTimer = null;
      noticeShown = false;
      if (parts) parts.notice.hidden = true;
    }

    const round = (v) => Math.round(v * 2) / 2;

    return {
      render(view) {
        if (!ensure()) return;
        gestureShown = true;
        if (noticeShown) hideNotice();
        setAppearance(view);
        if (view.trail && view.trail.length) {
          const pts = view.trail.map((p) => round(p.x) + ',' + round(p.y)).join(' ');
          if (pts !== lastTrail) {
            parts.edge.setAttribute('points', pts);
            parts.line.setAttribute('points', pts);
            parts.dot.setAttribute('cx', String(round(view.trail[0].x)));
            parts.dot.setAttribute('cy', String(round(view.trail[0].y)));
            lastTrail = pts;
          }
          parts.svg.style.display = '';
          parts.svg.classList.toggle('invalid', !!view.invalid);
        } else {
          parts.svg.style.display = 'none';
        }
        const g = view.guide;
        const key = g ? [g.arrows, g.shape, g.action, g.hint, g.unassigned].join('|') : '';
        if (key !== lastGuide) {
          if (g) {
            parts.arrows.textContent = g.arrows;
            parts.shape.textContent = g.shape;
            parts.action.textContent = g.action;
            parts.hint.textContent = g.hint;
            parts.guide.classList.toggle('unassigned', !!g.unassigned);
          }
          parts.guide.hidden = !g;
          lastGuide = key;
        }
      },
      setShield(on) {
        shield = !!on;
        if (shield) {
          if (!ensure()) {
            shield = false;
            return;
          }
          applyPointerEvents();
          return;
        }
        applyPointerEvents();
        detachIfIdle();
      },
      clearGesture() {
        gestureShown = false;
        shield = false;
        applyPointerEvents();
        if (parts) {
          parts.svg.style.display = 'none';
          parts.guide.hidden = true;
        }
        lastTrail = '';
        lastGuide = '';
        detachIfIdle();
      },
      notice(text, view) {
        if (!ensure()) return;
        hideNotice();
        setAppearance(view);
        parts.notice.textContent = text;
        parts.notice.hidden = false;
        noticeShown = true;
        noticeTimer = win.setTimeout(() => {
          noticeTimer = null;
          noticeShown = false;
          if (parts) parts.notice.hidden = true;
          detachIfIdle();
        }, view.ms || NOTICE_MS);
      },
      // 全画面の切り替え後は表示先を選び直す
      reset() {
        hideNotice();
        gestureShown = false;
        shield = false;
        applyPointerEvents();
        detach();
        host = null;
        parts = null;
        lastTrail = '';
        lastGuide = '';
      },
      destroy(keepNotice) {
        shield = false;
        applyPointerEvents();
        if (keepNotice && noticeShown) {
          gestureShown = false;
          if (parts) {
            parts.svg.style.display = 'none';
            parts.guide.hidden = true;
          }
          return;
        }
        this.reset();
      }
    };
  }

  /* ---------------------------------------------------------------- 制御 */

  function createController(env) {
    const win = env.win;
    const doc = env.doc;
    const chromeApi = env.chrome;
    const now = env.now || (() => Date.now());
    const setTimer = env.setTimeout || ((fn, ms) => win.setTimeout(fn, ms));
    const cryptoObj = env.crypto || win.crypto;
    const overlay = (env.createOverlay || createDomOverlay)(win, doc);
    const version = attempt(() => chromeApi.runtime.getManifest().version, '');
    const token = C.createUuidV4(cryptoObj);

    let destroyed = false;
    let settings = null;
    let loaded = false;
    let loadingSettings = false;
    const pendingDelta = {};
    let session = null;
    let pendingGuardRelease = false;
    let lastOwnReleaseAt = 0;
    // 他のフレームで始まったドラッグの移動 (別オリジンの iframe へ入った時など)
    let foreign = null;
    let foreignBlocked = false;
    const menu = { until: 0, armedUntil: 0, remoteUntil: 0, auxUntil: 0 };
    const removers = [];
    const domListeners = [];

    function listen(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      domListeners.push({ target, type, fn, options });
      removers.push(() => target.removeEventListener(type, fn, options));
    }

    // document.open() はページのリスナーと一緒にこのスクリプトのリスナーも消すので付け直す。
    // 同じ関数の再登録は無視されるので、 消えていなければ何も変わらない。
    function rebind() {
      if (destroyed) return;
      for (const l of domListeners) attempt(() => l.target.addEventListener(l.type, l.fn, l.options));
    }

    function eventTime(e) {
      const origin = attempt(() => win.performance.timeOrigin, 0);
      return origin && typeof e.timeStamp === 'number' ? origin + e.timeStamp : now();
    }

    function pointsOf(e) {
      const list = typeof e.getCoalescedEvents === 'function' ? attempt(() => e.getCoalescedEvents(), null) : null;
      const out = list && list.length ? list.map((c) => [c.clientX, c.clientY]) : [];
      out.push([e.clientX, e.clientY]);
      return out;
    }

    function isAllowedPointerType(type) {
      return type === 'mouse' || type === 'pen' || type === '';
    }

    function contextValid() {
      return attempt(() => !!(chromeApi.runtime && chromeApi.runtime.id), false);
    }

    function uiLanguage() {
      return attempt(() => chromeApi.i18n.getUILanguage(), '') || attempt(() => win.navigator.language, '');
    }

    function lang() {
      return I18N.resolveLanguage(settings ? settings.language : 'auto', uiLanguage());
    }

    function send(message) {
      if (!contextValid()) return Promise.reject(new Error('context-invalidated'));
      try {
        return Promise.resolve(chromeApi.runtime.sendMessage(message));
      } catch (err) {
        return Promise.reject(err);
      }
    }

    /* ---------- スクロール */

    function scrollBehavior() {
      const reduced = attempt(() => !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches), false);
      return reduced ? 'auto' : 'smooth';
    }

    function parentOf(node) {
      if (!node) return null;
      if (node.parentElement) return node.parentElement;
      const p = node.parentNode;
      return p && p.host ? p.host : null;
    }

    function hasScrollRoom(el, vertical, dir, rtl) {
      if (vertical) {
        const max = el.scrollHeight - el.clientHeight;
        if (max <= 1) return false;
        return dir > 0 ? el.scrollTop < max - 1 : el.scrollTop > 1;
      }
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 1) return false;
      if (rtl) {
        // Chrome / Firefox の RTL は scrollLeft が 0 から -max へ動く
        if (el.scrollLeft <= 0) return dir < 0 ? el.scrollLeft > -max + 1 : el.scrollLeft < -1;
      }
      return dir > 0 ? el.scrollLeft < max - 1 : el.scrollLeft > 1;
    }

    function canScrollContainer(el, vertical, dir) {
      if (!el || el === doc.documentElement || el === doc.body || el === doc.scrollingElement) return false;
      if (typeof el.scrollHeight !== 'number' || typeof el.clientHeight !== 'number') return false;
      if (typeof el.scrollWidth !== 'number' || typeof el.clientWidth !== 'number') return false;
      const style = attempt(() => (typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el) : null), null);
      if (!style) return false;
      const ov = vertical ? style.overflowY : style.overflowX;
      if (ov !== 'auto' && ov !== 'scroll' && ov !== 'overlay') return false;
      return hasScrollRoom(el, vertical, dir, style.direction === 'rtl');
    }

    function scrollTargetBy(target, left, top, behavior) {
      if (target && typeof target.scrollBy === 'function') {
        try {
          target.scrollBy({ left, top, behavior });
          return true;
        } catch (_) {
          try {
            target.scrollBy(left, top);
            return true;
          } catch (_) {
            // 下の代入へフォールバック
          }
        }
      }
      if (target && typeof target.scrollLeft === 'number' && typeof target.scrollTop === 'number') {
        target.scrollLeft += left;
        target.scrollTop += top;
        return true;
      }
      return false;
    }

    function performScroll(action, startTarget, allowFallback) {
      const vertical = action === 'scroll-up' || action === 'scroll-down';
      const dir = action === 'scroll-down' || action === 'scroll-right' ? 1 : -1;
      const behavior = scrollBehavior();

      // まずドラッグ開始位置の要素から親方向へスクロール可能なコンテナを探す
      let node = startTarget;
      while (node) {
        if (canScrollContainer(node, vertical, dir)) {
          const span = vertical ? node.clientHeight : node.clientWidth;
          const amount = Math.max(1, Math.round(span * SCROLL_RATIO)) * dir;
          return scrollTargetBy(node, vertical ? 0 : amount, vertical ? amount : 0, behavior);
        }
        node = parentOf(node);
      }

      // 次にフレーム全体のスクロールを試す
      const rootEl = attempt(() => doc.scrollingElement || doc.documentElement || doc.body, null);
      const hasMetrics =
        rootEl &&
        typeof rootEl.scrollHeight === 'number' &&
        typeof rootEl.clientHeight === 'number' &&
        typeof rootEl.scrollWidth === 'number' &&
        typeof rootEl.clientWidth === 'number';
      if (hasMetrics) {
        const rootStyle = attempt(() => (typeof win.getComputedStyle === 'function' ? win.getComputedStyle(rootEl) : null), null);
        const rtl = !!(rootStyle && rootStyle.direction === 'rtl');
        if (!hasScrollRoom(rootEl, vertical, dir, rtl)) {
          // 子フレーム側でこれ以上スクロールできなければ、 メインフレームへ引き継ぐ
          if (allowFallback && attempt(() => win !== win.top, false)) {
            send({ type: 'scroll-top-frame', action }).catch(() => {});
          }
          return false;
        }
      }

      const viewport = vertical
        ? (typeof win.innerHeight === 'number' && win.innerHeight > 0 ? win.innerHeight : rootEl && rootEl.clientHeight) || 600
        : (typeof win.innerWidth === 'number' && win.innerWidth > 0 ? win.innerWidth : rootEl && rootEl.clientWidth) || 800;
      const amount = Math.max(1, Math.round(viewport * SCROLL_RATIO)) * dir;
      return scrollTargetBy(win, vertical ? 0 : amount, vertical ? amount : 0, behavior) || scrollTargetBy(rootEl, vertical ? 0 : amount, vertical ? amount : 0, behavior);
    }

    /* ---------- 設定 */

    function loadSettings(retry) {
      loadingSettings = true;
      Promise.resolve()
        .then(() => chromeApi.storage.local.get(C.SETTING_KEYS))
        .then(
          (raw) => {
            loadingSettings = false;
            if (destroyed) return;
            // 読み込み中に届いた変更を、 古い読み込み結果で取り消さない
            settings = C.normalizeSettings({ ...(raw || {}), ...pendingDelta });
            loaded = true;
          },
          () => {
            if (destroyed || !contextValid()) {
              loadingSettings = false;
              return;
            }
            const n = retry || 0;
            if (n < 5) {
              setTimer(() => loadSettings(n + 1), 400 * (n + 1));
            } else {
              loadingSettings = false;
            }
          }
        );
    }

    function onStorageChanged(changes, area) {
      if (destroyed || area !== 'local' || !changes) return;
      const delta = {};
      let any = false;
      for (const key of C.SETTING_KEYS) {
        if (hasOwn(changes, key)) {
          delta[key] = changes[key] ? changes[key].newValue : undefined;
          any = true;
        }
      }
      if (!any) return;
      if (loaded) settings = C.normalizeSettings({ ...settings, ...delta });
      else Object.assign(pendingDelta, delta);
      cancel('settings-changed');
    }

    /* ---------- ジェスチャーの記録 */

    function originalTarget(e) {
      const path = attempt(() => e.composedPath(), null);
      const first = path && path.length ? path[0] : null;
      if (first && typeof first.setPointerCapture === 'function') return first;
      return e.target && typeof e.target.setPointerCapture === 'function' ? e.target : null;
    }

    function startTargetOf(e) {
      const path = attempt(() => e.composedPath(), null);
      if (path && path.length && path[0]) return path[0];
      return e.target || null;
    }

    function startSession(e) {
      const path = new GP.GesturePath(e.clientX, e.clientY);
      session = {
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        gestureId: C.createUuidV4(cryptoObj),
        path,
        captureEl: null,
        startTarget: startTargetOf(e),
        hasCapture: false,
        recognized: false,
        guardSentAt: 0,
        releaseGraceToken: 0,
        releaseGraceActive: false,
        cursor: { x: e.clientX, y: e.clientY },
        lastOwnAt: eventTime(e),
        relay: null
      };
      foreign = null;
      foreignBlocked = false;
      const target = originalTarget(e);
      if (target) {
        try {
          target.setPointerCapture(e.pointerId);
          session.captureEl = target;
          session.hasCapture = attempt(() => target.hasPointerCapture(e.pointerId), true);
        } catch (_) {
          session.captureEl = null;
        }
      }
      send({ type: 'prepare-gesture' }).catch(() => {});
      render();
    }

    function releaseCapture(s) {
      const target = s.captureEl;
      if (!target) return;
      attempt(() => {
        if (target.hasPointerCapture(s.pointerId)) target.releasePointerCapture(s.pointerId);
      });
    }

    function sendGuard(ms) {
      send({ type: 'menu-guard', token, ms }).catch(() => {});
    }

    function setOverlayShield(on) {
      if (typeof overlay.setShield === 'function') overlay.setShield(on);
    }

    function afterPathUpdate() {
      const s = session;
      if (!s) return;
      const shape = GS.recognize(s.path);
      if (shape && !s.recognized) s.recognized = true;
      if (s.recognized) {
        // 認識後は全画面シールドで iframe や動的 DOM 更新による pointerup 欠落を防ぐ
        setOverlayShield(true);
        if (!s.guardSentAt || now() - s.guardSentAt > REMOTE_GUARD_REFRESH_MS) {
          s.guardSentAt = now();
          sendGuard(REMOTE_GUARD_MS);
        }
      }
      render();
    }

    function guideFor(shape) {
      const L = lang();
      const action = settings.gestures[shape] || 'none';
      return {
        arrows: GS.arrows(shape),
        shape: I18N.shapeLabel(L, shape),
        action: action === 'none' ? I18N.t(L, 'guide.unassigned') : I18N.actionLabel(L, action),
        unassigned: action === 'none',
        hint: I18N.t(L, 'guide.hint')
      };
    }

    function render() {
      const s = session;
      if (!s || !settings) return;
      if (!settings.showTrail && !settings.showFeedback) return;
      const shape = settings.showFeedback ? GS.recognize(s.path) : null;
      overlay.render({
        trail: settings.showTrail ? s.path.getVertices() : null,
        invalid: !!s.path.invalid,
        guide: shape ? guideFor(shape) : null,
        textSize: settings.textSize,
        lang: lang()
      });
    }

    function cancel(reason) {
      const s = session;
      if (!s) return;
      s.releaseGraceToken += 1;
      s.releaseGraceActive = false;
      session = null;
      lastOwnReleaseAt = now();
      releaseCapture(s);
      setOverlayShield(false);
      overlay.clearGesture();
      // 中止したドラッグの続きを他のフレームへ中継しない
      foreignBlocked = true;
      if (s.recognized) {
        // 一度認識したドラッグは、 離した後の遅延メニューを短時間抑える
        menu.armedUntil = now() + ARMED_MAX_MS;
        if (s.guardSentAt) pendingGuardRelease = true;
      }
      return reason;
    }

    /* ---------- フレームをまたぐドラッグ */

    // このフレームに記録がないのに右ボタンを押したままの移動が届いた: 押したフレームへ移動量を中継する
    function trackForeign(e) {
      if (e.buttons !== 2 || !isAllowedPointerType(e.pointerType)) {
        foreign = null;
        foreignBlocked = false;
        return;
      }
      if (foreignBlocked || !loaded || !settings || !settings.enabled) return;
      if (!foreign) foreign = { x: e.clientX, y: e.clientY, points: [], at: 0, sentAt: 0, timer: false };
      const f = foreign;
      for (const [x, y] of pointsOf(e)) f.points.push([x - f.x, y - f.y]);
      f.at = eventTime(e);
      if (now() - f.sentAt >= RELAY_INTERVAL_MS || f.points.length >= RELAY_MAX_POINTS) {
        flushRelay(f, 'move');
      } else if (!f.timer) {
        f.timer = true;
        setTimer(() => {
          f.timer = false;
          if (foreign === f && f.points.length) flushRelay(f, 'move');
        }, RELAY_INTERVAL_MS);
      }
    }

    function flushRelay(f, kind) {
      while (f.points.length || kind === 'up') {
        const points = f.points.splice(0, RELAY_MAX_POINTS);
        const last = kind === 'up' && f.points.length === 0;
        f.sentAt = now();
        send({ type: 'gesture-relay', token, kind: last ? 'up' : 'move', points, at: f.at || now() }).catch(() => {});
        if (last) break;
      }
    }

    function relayRelease(e) {
      const f = foreign;
      const blocked = foreignBlocked;
      foreign = null;
      foreignBlocked = false;
      if (f) {
        f.points.push([e.clientX - f.x, e.clientY - f.y]);
        f.at = eventTime(e);
        lastOwnReleaseAt = now();
        flushRelay(f, 'up');
        return;
      }
      // 移動イベントなしで別フレーム上に直接離された解放も中継する (直前の解放に続く互換 mouseup は除外)
      if (blocked || !loaded || !settings || !settings.enabled) return;
      if (lastOwnReleaseAt && now() - lastOwnReleaseAt < OWN_RELEASE_QUIET_MS) return;
      lastOwnReleaseAt = now();
      send({ type: 'gesture-relay', token, kind: 'up', points: [], at: eventTime(e) }).catch(() => {});
    }

    // 他のフレームから中継された移動を、 このフレームの記録へ足す
    function onRelay(message) {
      const s = session;
      if (!s || message.token === token || !Array.isArray(message.points)) return;
      if (typeof message.at !== 'number' || message.at + RELAY_CLOCK_SLOP_MS < s.lastOwnAt) return;
      if (!s.relay || s.relay.source !== message.token) s.relay = { source: message.token, base: { ...s.cursor } };
      const base = s.relay.base;
      for (const p of message.points.slice(0, RELAY_MAX_POINTS)) {
        if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        s.cursor = { x: base.x + p[0], y: base.y + p[1] };
        s.path.add(s.cursor.x, s.cursor.y);
      }
      if (message.kind === 'up') {
        finish(s.cursor.x, s.cursor.y);
        return;
      }
      afterPathUpdate();
    }

    function finish(x, y) {
      const s = session;
      if (!s) return;
      s.releaseGraceToken += 1;
      s.releaseGraceActive = false;
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
        s.path.add(x, y);
      }
      session = null;
      lastOwnReleaseAt = now();
      releaseCapture(s);
      setOverlayShield(false);
      overlay.clearGesture();
      const shape = GS.recognize(s.path);
      if (shape || s.recognized) {
        menu.armedUntil = 0;
        menu.until = now() + MENU_SUPPRESS_MS;
        menu.auxUntil = now() + MENU_SUPPRESS_MS;
      }
      if (s.guardSentAt) sendGuard(MENU_SUPPRESS_MS);
      if (!shape) return;
      execute(shape, s.gestureId, settings.gestures[shape] || 'none', s.startTarget, 0);
    }

    function execute(shape, gestureId, expected, startTarget, retry) {
      const attemptNo = retry || 0;
      send({ type: 'execute-gesture', gesture: shape, gestureId, action: expected }).then(
        (resp) => {
          if (destroyed || !resp) return;
          if (resp.ok) {
            if (C.isScrollAction(resp.action)) performScroll(resp.action, startTarget, true);
            return;
          }
          if (!settings || !settings.showFeedback || !DISPLAY_REASONS.has(resp.reason)) return;
          showNotice(messageFor(resp));
        },
        () => {
          if (destroyed) return;
          if (!contextValid()) {
            handleInvalidated();
            return;
          }
          // Service Worker のスリープ復帰直後など一時的な通信切断は同じ gestureId で再送する
          if (attemptNo < EXECUTE_RETRY_DELAYS.length) {
            setTimer(() => {
              if (!destroyed && contextValid()) execute(shape, gestureId, expected, startTarget, attemptNo + 1);
            }, EXECUTE_RETRY_DELAYS[attemptNo]);
          }
        }
      );
    }

    function messageFor(resp) {
      const L = lang();
      if (resp.messageKey && I18N.has(resp.messageKey)) return I18N.t(L, resp.messageKey, resp.params || {});
      return resp.message || I18N.t(L, 'reason.api-failed', { detail: '' });
    }

    function showNotice(text) {
      overlay.notice(text, { textSize: settings ? settings.textSize : 'medium', lang: lang(), ms: NOTICE_MS });
    }

    function handleInvalidated() {
      if (destroyed) return;
      if (settings && settings.showFeedback) showNotice(I18N.t(lang(), 'reason.context-invalidated'));
      destroy(true);
    }

    function noteRightRelease() {
      if (menu.armedUntil > now()) {
        menu.armedUntil = 0;
        menu.until = now() + MENU_SUPPRESS_MS;
        menu.auxUntil = now() + MENU_SUPPRESS_MS;
      }
      if (pendingGuardRelease) {
        pendingGuardRelease = false;
        sendGuard(MENU_SUPPRESS_MS);
      }
    }

    function resetMenuGuard() {
      menu.until = 0;
      menu.armedUntil = 0;
      menu.remoteUntil = 0;
      menu.auxUntil = 0;
      pendingGuardRelease = false;
    }

    function isOverIframe(e) {
      if (e.target && String(e.target.tagName || '').toUpperCase() === 'IFRAME') return true;
      if (typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return false;
      if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return false;
      const under = attempt(() => (typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(e.clientX, e.clientY) : null), null);
      return !!(under && String(under.tagName || '').toUpperCase() === 'IFRAME');
    }

    /* ---------- イベント */

    function onPointerDown(e) {
      if (destroyed || !e.isTrusted) return;
      if (!contextValid()) {
        destroy(false);
        return;
      }
      if (session) {
        const lostRelease = e.pointerId === session.pointerId && e.button === 2 && e.buttons === 2;
        cancel(lostRelease ? 'lost-release' : 'extra-button');
        if (!lostRelease) return;
      }
      if (e.button === 2) resetMenuGuard();
      if (!loaded) {
        if (!loadingSettings) loadSettings(0);
        return;
      }
      if (!settings || !settings.enabled) return;
      if (e.button !== 2 || e.buttons !== 2) return;
      if (!isAllowedPointerType(e.pointerType)) return;
      startSession(e);
    }

    function onPointerMove(e) {
      if (!e.isTrusted) return;
      const s = session;
      if (!s) {
        trackForeign(e);
        return;
      }
      if (e.pointerId !== s.pointerId) return;
      if (e.buttons !== 2) {
        if (e.buttons !== 0) {
          cancel('buttons-changed');
          return;
        }
        // 高負荷時などに pointerup より先に buttons=0 の pointermove が届く場合は短時間だけ解放を待つ
        if (!s.releaseGraceActive) {
          s.releaseGraceActive = true;
          s.releaseGraceToken += 1;
          const grace = s.releaseGraceToken;
          setTimer(() => {
            if (session === s && s.releaseGraceToken === grace) cancel('buttons-changed');
          }, RELEASE_GRACE_MS);
        }
        return;
      }
      if (s.releaseGraceActive) {
        s.releaseGraceActive = false;
        s.releaseGraceToken += 1;
      }
      for (const [x, y] of pointsOf(e)) s.path.add(x, y);
      s.cursor = { x: e.clientX, y: e.clientY };
      s.lastOwnAt = eventTime(e);
      s.relay = null;
      afterPathUpdate();
    }

    function onPointerUp(e) {
      if (!e.isTrusted) return;
      const s = session;
      if (!s || e.pointerId !== s.pointerId) {
        if (e.button === 2) {
          noteRightRelease();
          if (!s && e.buttons === 0) relayRelease(e);
        }
        return;
      }
      if (e.button === 2 && e.buttons === 0) finish(e.clientX, e.clientY);
      else cancel('buttons-changed');
    }

    function onPointerCancel(e) {
      if (session && e.pointerId === session.pointerId) cancel('pointercancel');
    }

    function onMouseDown(e) {
      if (!e.isTrusted || !session) return;
      if (e.button !== 2) cancel('extra-button');
    }

    // pointerup が届かず互換 mouseup だけが届いた場合の代替完了
    function onMouseUp(e) {
      if (!e.isTrusted) return;
      if (!session) {
        if (e.button === 2) {
          noteRightRelease();
          if (e.buttons === 0) relayRelease(e);
        }
        return;
      }
      if (e.button === 2 && e.buttons === 0) finish(e.clientX, e.clientY);
    }

    function onGotCapture(e) {
      if (session && e.pointerId === session.pointerId) session.hasCapture = true;
    }

    // lostpointercapture だけでは中止しない (解放の取りこぼしを避ける)
    function onLostCapture(e) {
      if (session && e.pointerId === session.pointerId) session.hasCapture = false;
    }

    function onPointerOut(e) {
      const s = session;
      if (!s || e.pointerId !== s.pointerId || s.hasCapture) return;
      if (e.relatedTarget == null && !isOverIframe(e)) cancel('left-page');
    }

    function onKeyDown(e) {
      if (!session || e.key !== 'Escape') return;
      cancel('escape');
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onContextMenu(e) {
      if (!e.isTrusted) return;
      // Windows 等で pointerup / mouseup を取りこぼして解放時 contextmenu (buttons=0) だけ届いた場合の代替完了
      if (session && session.recognized && e.buttons === 0) finish(e.clientX, e.clientY);
      const t = now();
      const suppress = (session && session.recognized) || t < menu.until || t < menu.armedUntil || t < menu.remoteUntil;
      if (!suppress) return;
      menu.until = 0;
      menu.armedUntil = 0;
      menu.remoteUntil = 0;
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onAuxClick(e) {
      if (!e.isTrusted || e.button !== 2) return;
      // pointerup / mouseup が届かず auxclick (button=2, buttons=0) だけ届いた場合の代替完了
      if (session && e.buttons === 0) finish(e.clientX, e.clientY);
      const t = now();
      const suppress = (session && session.recognized) || t < menu.auxUntil || t < menu.armedUntil || t < menu.remoteUntil;
      if (!suppress) return;
      menu.auxUntil = 0;
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    // 子要素の blur ではなく、 ウィンドウ自体のフォーカス喪失だけで中止する
    function onWindowBlur(e) {
      if (!session || e.target !== win) return;
      setTimer(() => {
        if (session && !attempt(() => doc.hasFocus(), false)) cancel('blur');
      }, 0);
    }

    function onVisibilityChange() {
      if (doc.visibilityState === 'hidden') cancel('hidden');
    }

    function onPageHide() {
      cancel('pagehide');
    }

    function onFullscreenChange() {
      cancel('fullscreen');
      overlay.reset();
    }

    function onTakeover() {
      if (!contextValid()) destroy(false);
    }

    function onMessage(message, sender, sendResponse) {
      if (destroyed || !message || typeof message !== 'object') return false;
      if (!sender || sender.id !== attempt(() => chromeApi.runtime.id, null)) return false;
      if (message.type === 'gesture-ping') {
        sendResponse({
          ok: true,
          version,
          ready: loaded,
          readyState: attempt(() => doc.readyState, ''),
          contentType: attempt(() => doc.contentType, '') || ''
        });
        return false;
      }
      if (message.type === 'gesture-menu-guard') {
        if (message.token !== token && typeof message.ms === 'number' && Number.isFinite(message.ms)) {
          menu.remoteUntil = now() + Math.min(Math.max(message.ms, 0), REMOTE_GUARD_MS);
        }
        return false;
      }
      if (message.type === 'gesture-relay') {
        onRelay(message);
        return false;
      }
      if (message.type === 'gesture-scroll') {
        if (C.isScrollAction(message.action)) performScroll(message.action, null, false);
        return false;
      }
      return false;
    }

    function destroy(keepNotice) {
      if (destroyed) return;
      destroyed = true;
      foreign = null;
      if (session) {
        releaseCapture(session);
        session = null;
      }
      for (const remove of removers.splice(0)) attempt(remove);
      overlay.destroy(!!keepNotice);
    }

    const capture = { capture: true };
    const passive = { capture: true, passive: true };
    listen(win, 'pointerdown', onPointerDown, passive);
    listen(win, 'pointermove', onPointerMove, passive);
    listen(win, 'pointerup', onPointerUp, passive);
    listen(win, 'pointercancel', onPointerCancel, passive);
    listen(win, 'pointerout', onPointerOut, passive);
    listen(win, 'gotpointercapture', onGotCapture, passive);
    listen(win, 'lostpointercapture', onLostCapture, passive);
    listen(win, 'mousedown', onMouseDown, passive);
    listen(win, 'mouseup', onMouseUp, passive);
    listen(win, 'keydown', onKeyDown, capture);
    listen(win, 'contextmenu', onContextMenu, capture);
    listen(win, 'auxclick', onAuxClick, capture);
    listen(win, 'blur', onWindowBlur, passive);
    listen(win, 'pagehide', onPageHide, passive);
    listen(doc, 'visibilitychange', onVisibilityChange, passive);
    listen(doc, 'fullscreenchange', onFullscreenChange, passive);
    listen(doc, TAKEOVER_EVENT, onTakeover, passive);
    if (typeof win.MutationObserver === 'function') {
      try {
        const observer = new win.MutationObserver(rebind);
        observer.observe(doc, { childList: true });
        removers.push(() => observer.disconnect());
      } catch (_) {
        // 観察できなくても通常の動作は続ける
      }
    }

    try {
      chromeApi.runtime.onMessage.addListener(onMessage);
      removers.push(() => chromeApi.runtime.onMessage.removeListener(onMessage));
      chromeApi.storage.onChanged.addListener(onStorageChanged);
      removers.push(() => chromeApi.storage.onChanged.removeListener(onStorageChanged));
    } catch (_) {
      destroy(false);
    }
    if (!destroyed) loadSettings(0);

    return {
      destroy,
      get destroyed() {
        return destroyed;
      },
      get session() {
        return session;
      },
      get settings() {
        return settings;
      },
      get loaded() {
        return loaded;
      },
      token
    };
  }

  function boot() {
    const previous = root[INSTANCE_KEY];
    if (previous && typeof previous.destroy === 'function') attempt(() => previous.destroy(false));
    // 拡張機能の更新で残った古い実行環境にも停止を知らせる
    attempt(() => document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT)));
    root[INSTANCE_KEY] = createController({ win: window, doc: document, chrome: root.chrome });
  }

  const api = { createController, createDomOverlay, canHostChildren, INSTANCE_KEY, TAKEOVER_EVENT, MENU_SUPPRESS_MS };

  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined' && typeof document !== 'undefined' && root.chrome && root.chrome.runtime && root.chrome.runtime.id) {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
