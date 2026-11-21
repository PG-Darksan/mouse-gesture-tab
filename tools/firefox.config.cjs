'use strict';
// pack-firefox.cjs の設定 (マウスジェスチャー・タブ操作)
const FILE_CHECK_FF = "chromeApi.permissions.contains({ origins: ['file:///*'] })";

module.exports = {
  source: 'extension',
  folderName: 'firefox',
  zipName: 'mouse-gesture-tab',
  geckoId: 'mouse-gesture-tab@hisator-notebook.com',
  // service worker の importScripts('config.js', 'i18n.js') と同じ順
  backgroundScripts: ['config.js', 'i18n.js', 'background.js'],
  include: (rel) => rel !== 'icon.svg',
  patches: [
    // Firefox の isAllowedFileSchemeAccess() は常に false を返すので、 実際の file:// 権限で判定する
    { file: 'background.js', find: 'chromeApi.extension.isAllowedFileSchemeAccess()', replace: FILE_CHECK_FF, count: 2 },
    // Firefox で拡張機能が動かないストア・アカウント画面
    {
      file: 'config.js',
      find: "{ host: 'microsoftedge.microsoft.com', path: '/addons' }",
      replace: [
        "{ host: 'microsoftedge.microsoft.com', path: '/addons' },",
        "    { host: 'addons.mozilla.org', path: '' },",
        "    { host: 'discovery.addons.mozilla.org', path: '' },",
        "    { host: 'accounts.firefox.com', path: '' },",
        "    { host: 'support.mozilla.org', path: '' }"
      ].join('\n')
    },
    // Firefox には拡張機能の詳細画面を開く手段が無いので「許可設定」ボタンは出さない
    {
      file: 'popup.html',
      find: '<button type="button" id="siteSettings"',
      replace: '<button type="button" id="siteSettings" hidden style="display:none"'
    },
    { file: 'i18n.js', find: "'ウェブストアの画面は対象外です'", replace: "'アドオンストアの画面は対象外です'" },
    { file: 'i18n.js', find: "'Gestures are not available on web store pages'", replace: "'Gestures are not available on add-on store pages'" },
    {
      file: 'i18n.js',
      find: "'ファイルの URL へのアクセスが許可されていません。「許可設定」で「ファイルの URL へのアクセスを許可する」をオンにしてください'",
      replace: "'ファイルへのアクセスが許可されていません。アドオン管理画面（about:addons）でこの拡張機能の「権限」を確認してください'"
    },
    {
      file: 'i18n.js',
      find: "'Access to file URLs is not allowed. Open “Site access” and turn on “Allow access to file URLs”'",
      replace: "'Access to local files is not allowed. Check this extension’s “Permissions” in the Add-ons Manager (about:addons)'"
    }
  ]
};
