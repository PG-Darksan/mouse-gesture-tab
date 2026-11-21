/*
 * 日本語・英語の文言。 ポップアップ、 ページ上の操作ガイド、 Service Worker の応答で共用する。
 */
(function (root) {
  'use strict';

  const ja = {
    'extName': 'マウスジェスチャー・タブ操作',
    'popup.subtitle': '右ボタンを押したまま上下左右に動かし、離した時に1回実行します。',

    'action.none': '何もしない',
    'action.previous-tab': '前のタブへ',
    'action.next-tab': '次のタブへ',
    'action.close-tab': 'タブを閉じる',
    'action.close-window': 'ウィンドウを閉じる',
    'action.new-tab': '新しいタブ',
    'action.restore-closed': '閉じたタブ／ウィンドウを復元',
    'action.reload': '再読み込み',
    'action.hard-reload': 'スーパーリロード',
    'action.go-back': '戻る',
    'action.go-forward': '進む',
    'action.duplicate-tab': 'タブを複製',
    'action.toggle-pin': 'タブの固定を切り替え',
    'action.scroll-up': '上へスクロール',
    'action.scroll-down': '下へスクロール',
    'action.scroll-left': '左へスクロール',
    'action.scroll-right': '右へスクロール',

    'dir.L': '左',
    'dir.R': '右',
    'dir.U': '上',
    'dir.D': '下',
    'shape.join': '→',
    'move.L': '左へ',
    'move.R': '右へ',
    'move.U': '上へ',
    'move.D': '下へ',
    'steps.one': '{a}動かす',
    'steps.two': '{a}動かしてから{b}',

    'guide.hint': '右ボタンを離すと実行 · Escで中止',
    'guide.hint.scroll': '右ボタンを離すと停止 · Escで中止',
    'guide.unassigned': '未割り当て（離しても何もしません）',

    'reason.unassigned': 'このジェスチャーには操作が割り当てられていません',
    'reason.single-tab': 'このウィンドウのタブは1つだけです',
    'reason.tab-edge': '端のタブです（タブの循環はオフ）',
    'reason.no-back-history': 'これ以上戻れるページがありません',
    'reason.no-forward-history': 'これ以上進めるページがありません',
    'reason.no-closed-session': '復元できる閉じたタブ／ウィンドウがありません',
    'reason.api-failed': '操作できませんでした: {detail}',
    'reason.queue-full': '操作が混み合っています。少し待ってからやり直してください',
    'reason.disabled': 'ジェスチャーは無効です',
    'reason.stale-tab': '元のタブが変わったため実行しませんでした',
    'reason.settings-changed': '設定が変わったため実行しませんでした',
    'reason.duplicate': 'この操作は実行済みです',
    'reason.busy': '前の操作を処理中です',
    'reason.invalid': '要求が正しくありません',
    'reason.forbidden': '許可されていない送信元です',
    'reason.settings-unavailable': '設定を読み込めませんでした',
    'reason.storage-failed': '設定を保存できませんでした',
    'reason.context-invalidated': '拡張機能が更新されました。ページを再読み込みしてください',

    'section.basic': '基本設定',
    'switch.enabled': '有効',
    'switch.wrapTabs': 'タブを循環',
    'switch.showTrail': '軌跡',
    'switch.showFeedback': '操作ガイド',
    'switch.enabled.tip': 'ジェスチャーの認識をオン／オフします',
    'switch.wrapTabs.tip': '最後のタブの次は最初のタブ、最初の前は最後のタブへ移動します',
    'switch.showTrail.tip': '右ボタンを押している間、描いた線を表示します',
    'switch.showFeedback.tip': '画面下に認識中の形と割り当てた操作を表示します',

    'textSize': '文字サイズ',
    'textSize.small': '小',
    'textSize.medium': '標準',
    'textSize.large': '大',
    'language': '言語',
    'language.auto': '自動（ブラウザに合わせる）',
    'language.ja': '日本語',
    'language.en': 'English',

    'mapping.title': '形と操作の割り当て',
    'mapping.note': '全12種類',
    'mapping.select': '{shape}に割り当てる操作',
    'mapping.diagram': '{shape}: {steps}',

    'save.auto': '自動保存',
    'save.loading': '読み込み中…',
    'save.saving': '保存中…',
    'save.saved': '保存済み',
    'save.failed': '保存失敗',
    'save.retry': '再試行',
    'hint': '小さな手ぶれは自動で補正し、短い線でも認識します。曲がるのは1回までです。',

    'status.label': '現在のページ',
    'status.checking': '確認中…',
    'status.no-tab': 'タブがありません',
    'status.disabled': 'ジェスチャーは無効です',
    'status.unavailable': 'ページの読み込み後に再確認してください',
    'status.restricted': 'この画面は対象外です',
    'status.restricted-store': 'ウェブストアの画面は対象外です',
    'status.pdf': 'PDF ビューアーでは使用できません',
    'status.permission-required': 'このサイトの許可が必要です',
    'status.permission-file': 'ファイルの URL へのアクセスが許可されていません。「許可設定」で「ファイルの URL へのアクセスを許可する」をオンにしてください',
    'status.ready': 'このページで使用できます',
    'status.reload-required': 'ページを再読み込みしてください',
    'status.requesting': 'サイトの許可を確認中…',
    'status.permission-denied': 'サイトの許可が得られませんでした。もう一度お試しください',
    'status.permission-error': '許可を要求できませんでした。もう一度お試しください',

    'button.allowSite': 'このサイトを許可',
    'button.siteSettings': '許可設定',
    'button.recheck': '再確認',
    'button.allowSite.tip': '{host} へのアクセスだけを許可します',
    'button.siteSettings.tip': 'この拡張機能の詳細画面を開きます',
    'button.recheck.tip': '現在のページの状態をもう一度確認します',

    'load.failed': '設定を読み込めませんでした',
    'load.retry': '再読み込み',

    'footer.linkLabel': 'Hisator Notebook を新しいタブで開く'
  };

  const en = {
    'extName': 'Mouse Gestures – Tab Control',
    'popup.subtitle': 'Hold the right button, move up, down, left or right, and release to run once.',

    'action.none': 'Do nothing',
    'action.previous-tab': 'Previous tab',
    'action.next-tab': 'Next tab',
    'action.close-tab': 'Close tab',
    'action.close-window': 'Close window',
    'action.new-tab': 'New tab',
    'action.restore-closed': 'Reopen closed tab/window',
    'action.reload': 'Reload',
    'action.hard-reload': 'Hard reload',
    'action.go-back': 'Back',
    'action.go-forward': 'Forward',
    'action.duplicate-tab': 'Duplicate tab',
    'action.toggle-pin': 'Pin / unpin tab',
    'action.scroll-up': 'Scroll up',
    'action.scroll-down': 'Scroll down',
    'action.scroll-left': 'Scroll left',
    'action.scroll-right': 'Scroll right',

    'dir.L': 'Left',
    'dir.R': 'Right',
    'dir.U': 'Up',
    'dir.D': 'Down',
    'shape.join': ' → ',
    'move.L': 'left',
    'move.R': 'right',
    'move.U': 'up',
    'move.D': 'down',
    'steps.one': 'Move {a}',
    'steps.two': 'Move {a}, then {b}',

    'guide.hint': 'Release the right button to run · Esc to cancel',
    'guide.hint.scroll': 'Release the right button to stop · Esc to cancel',
    'guide.unassigned': 'Not assigned (nothing happens on release)',

    'reason.unassigned': 'No action is assigned to this gesture',
    'reason.single-tab': 'This window has only one tab',
    'reason.tab-edge': 'Already at the edge (tab wrapping is off)',
    'reason.no-back-history': 'There is no previous page to go back to',
    'reason.no-forward-history': 'There is no next page to go forward to',
    'reason.no-closed-session': 'There are no recently closed tabs or windows',
    'reason.api-failed': 'Could not run the action: {detail}',
    'reason.queue-full': 'Too many gestures at once. Please wait a moment',
    'reason.disabled': 'Gestures are turned off',
    'reason.stale-tab': 'Skipped because the original tab changed',
    'reason.settings-changed': 'Skipped because the settings changed',
    'reason.duplicate': 'This gesture has already been handled',
    'reason.busy': 'The previous gesture is still running',
    'reason.invalid': 'Invalid request',
    'reason.forbidden': 'Sender not allowed',
    'reason.settings-unavailable': 'Could not load the settings',
    'reason.storage-failed': 'Could not save the settings',
    'reason.context-invalidated': 'The extension was updated. Please reload this page',

    'section.basic': 'Basic settings',
    'switch.enabled': 'Enabled',
    'switch.wrapTabs': 'Wrap tabs',
    'switch.showTrail': 'Trail',
    'switch.showFeedback': 'Guide',
    'switch.enabled.tip': 'Turn gesture recognition on or off',
    'switch.wrapTabs.tip': 'After the last tab go to the first, and before the first go to the last',
    'switch.showTrail.tip': 'Show the line you draw while holding the right button',
    'switch.showFeedback.tip': 'Show the recognized shape and its action at the bottom of the page',

    'textSize': 'Text size',
    'textSize.small': 'Small',
    'textSize.medium': 'Medium',
    'textSize.large': 'Large',
    'language': 'Language',
    'language.auto': 'Auto (browser language)',
    'language.ja': '日本語',
    'language.en': 'English',

    'mapping.title': 'Shapes and actions',
    'mapping.note': 'All 12 shapes',
    'mapping.select': 'Action for {shape}',
    'mapping.diagram': '{shape}: {steps}',

    'save.auto': 'Saved automatically',
    'save.loading': 'Loading…',
    'save.saving': 'Saving…',
    'save.saved': 'Saved',
    'save.failed': 'Save failed',
    'save.retry': 'Retry',
    'hint': 'Small jitter is corrected automatically and short lines are recognized. Turn at most once.',

    'status.label': 'Current page',
    'status.checking': 'Checking…',
    'status.no-tab': 'No tab found',
    'status.disabled': 'Gestures are turned off',
    'status.unavailable': 'Check again after the page finishes loading',
    'status.restricted': 'Gestures are not available on this page',
    'status.restricted-store': 'Gestures are not available on web store pages',
    'status.pdf': 'Gestures are not available in the PDF viewer',
    'status.permission-required': 'This site needs your permission',
    'status.permission-file': 'Access to file URLs is not allowed. Open “Site access” and turn on “Allow access to file URLs”',
    'status.ready': 'Ready on this page',
    'status.reload-required': 'Please reload this page',
    'status.requesting': 'Requesting site access…',
    'status.permission-denied': 'Site access was not granted. Please try again',
    'status.permission-error': 'Could not request site access. Please try again',

    'button.allowSite': 'Allow this site',
    'button.siteSettings': 'Site access',
    'button.recheck': 'Check again',
    'button.allowSite.tip': 'Allow access to {host} only',
    'button.siteSettings.tip': 'Open the details page of this extension',
    'button.recheck.tip': 'Check the current page again',

    'load.failed': 'Could not load the settings',
    'load.retry': 'Reload',

    'footer.linkLabel': 'Open Hisator Notebook in a new tab'
  };

  const STRINGS = Object.freeze({ ja: Object.freeze(ja), en: Object.freeze(en) });
  const LANGS = Object.freeze(['ja', 'en']);

  /** 'auto' はブラウザの言語に従う。 日本語系は日本語、 それ以外は英語、 不明なら日本語。 */
  function resolveLanguage(setting, uiLanguage) {
    if (setting === 'ja' || setting === 'en') return setting;
    const lang = String(uiLanguage || '').trim().toLowerCase();
    if (!lang) return 'ja';
    return lang === 'ja' || lang.startsWith('ja-') || lang.startsWith('ja_') ? 'ja' : 'en';
  }

  function has(key) {
    return Object.prototype.hasOwnProperty.call(ja, key);
  }

  function t(lang, key, params) {
    const table = STRINGS[lang] || STRINGS.ja;
    let text = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : (has(key) ? ja[key] : key);
    if (params) {
      text = text.replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m));
    }
    return text;
  }

  function shapeLabel(lang, id) {
    return String(id).split('').map((d) => t(lang, 'dir.' + d)).join(t(lang, 'shape.join'));
  }

  function shapeSteps(lang, id) {
    const dirs = String(id).split('');
    if (dirs.length === 1) return t(lang, 'steps.one', { a: t(lang, 'move.' + dirs[0]) });
    return t(lang, 'steps.two', { a: t(lang, 'move.' + dirs[0]), b: t(lang, 'move.' + dirs[1]) });
  }

  function actionLabel(lang, id) {
    return t(lang, 'action.' + id);
  }

  const api = Object.freeze({ STRINGS, LANGS, resolveLanguage, has, t, shapeLabel, shapeSteps, actionLabel });

  root.MGI18n = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
