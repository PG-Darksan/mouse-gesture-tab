# Chrome ウェブストア 申請用メモ

Chrome ウェブストア デベロッパー ダッシュボード (https://chrome.google.com/webstore/devconsole) の各欄へ、 そのまま貼れる文面と手順です。

## 1. アップロードする物

| 欄 | ファイル |
| --- | --- |
| パッケージ | `dist/mouse-gesture-tab-3.6.0.zip` (`node tools/pack.js` で作成) |
| ストアのアイコン (128×128) | `extension/icons/icon128.png` |
| スクリーンショット (1280×800、 1〜5 枚) | 日本語: `store/images/ja/screenshot-1〜3.png` / 英語: `store/images/en/screenshot-1〜3.png` |
| 小型プロモーション タイル (440×280) | `store/images/ja/promo-small-440x280.png` (英語は `en` の同名ファイル) |

- 既に同じアイテムを公開している場合、 `manifest.json` の `version` (現在 3.6.0) は公開中の版より大きくする必要があります。
- 名前と短い説明は `extension/_locales/*/messages.json` から自動で入ります (既定の言語は日本語)。 英語の掲載情報は「ストアの掲載情報」で言語を英語に切り替えて入力します。

## 2. ストアの掲載情報

**カテゴリ**: Chrome をカスタマイズ › 機能性と UI (Functionality & UI)
**言語**: 日本語 (英語の掲載情報も追加)

### 説明 (日本語)

```
右ボタンを押したまま上下左右に動かし、右ボタンを離した時に、形に割り当てたタブ操作を1回だけ実行するマウスジェスチャー拡張機能です。

■ できること
・上下左右の4種類と、直交方向へ1回曲がる8種類（下→右、右→上 など）の全12種類の形
・形ごとに操作を割り当て：前のタブへ／次のタブへ／タブを閉じる／ウィンドウを閉じる／新しいタブ／閉じたタブ・ウィンドウを復元／再読み込み／スーパーリロード／戻る／進む／タブを複製／タブの固定を切り替え／上・下・左・右へスクロール／何もしない
・初期設定は「左＝前のタブへ」「右＝次のタブへ」だけ。ほかの形は自由に割り当てられます

■ 使いやすさ
・描いている途中では何もせず、離した時だけ実行。Esc キーで中止できます
・小さな手ぶれは自動で補正し、短い線でも認識します
・描いた線（軌跡）と、認識中の形と操作（操作ガイド）を表示。それぞれオン／オフできます
・左右を素早く交互に繰り返しても、操作を取りこぼしません
・動画プレイヤーの上、全画面表示、iframe の中でも使えます
・動かさずに右クリックした時は、いつものメニューがそのまま開きます
・設定はその場で自動保存。日本語／英語、文字サイズ3段階

■ プライバシー
・描いた軌跡、ページの内容、閲覧履歴を収集・保存・送信しません
・設定はブラウザーの中（chrome.storage.local）にだけ保存します
・外部との通信、広告、解析の機能はありません

■ 使えないページ
新しいタブ、ブラウザーの設定や拡張機能の画面、ウェブストアの画面では、ブラウザーの仕様により動作しません。パソコン内の HTML ファイルで使う場合は、拡張機能の詳細画面で「ファイルの URL へのアクセスを許可する」をオンにしてください。

対応環境：Windows の Google Chrome / Microsoft Edge（バージョン 119 以降）
```

### 説明 (英語)

```
Hold the right mouse button, move up, down, left or right, and release: the tab action you assigned to that shape runs exactly once.

WHAT YOU CAN DO
• 12 shapes: the four directions plus eight shapes with one right-angle turn (Down → Right, Right → Up, and so on)
• Assign an action to each shape: previous tab, next tab, close tab, close window, new tab, reopen closed tab/window, reload, hard reload, back, forward, duplicate tab, pin/unpin tab, scroll up/down/left/right, or do nothing
• Out of the box only Left = previous tab and Right = next tab are assigned

EASY TO USE
• Nothing happens while you draw — the action runs only when you release. Press Esc to cancel
• Small hand jitter is corrected automatically, and short strokes are recognized
• An on-page trail and a guide show the recognized shape and its action. Each can be turned off
• Fast left/right repetitions are never dropped
• Works over video players, in full screen and inside iframes
• A normal right-click without moving still opens the usual context menu
• Settings are saved instantly. Japanese or English, three text sizes

PRIVACY
• The extension does not collect, store or send your gestures, page content or browsing history
• Settings are stored only in your browser (chrome.storage.local)
• No network requests, ads or analytics

PAGES WHERE IT CANNOT RUN
The New Tab page, browser settings and extension pages, and web store pages are protected by the browser. To use gestures on local HTML files, turn on “Allow access to file URLs” on the extension’s details page.

Requirements: Google Chrome or Microsoft Edge on Windows (version 119 or later)
```

## 3. プライバシーへの取り組み (Privacy practices)

### 単一用途の説明 (Single purpose)

```
Mouse gestures for tab control. While the user holds the right mouse button on a web page and draws one of 12 simple shapes, the extension shows the trail; when the button is released it performs the browser action that the user assigned to that shape (switch, close, open, restore, reload, navigate, duplicate or pin tabs).
```

### 権限の理由 (Permission justification)

| 権限 | 貼り付ける文 |
| --- | --- |
| storage | `Stores the user's settings (on/off, the shape-to-action assignments, trail and guide visibility, language and text size) locally with chrome.storage.local. Nothing is synced or sent anywhere.` |
| scripting | `Injects the extension's own gesture script into tabs that were already open when the extension is installed or updated, or when the user grants access to a site, so gestures work without reloading the page. It also re-prepares the current page when the popup's status check finds the script missing. Only files packaged in the extension are injected.` |
| sessions | `Used only for the "Reopen closed tab/window" action, which calls chrome.sessions.restore() when the user performs the gesture assigned to it.` |
| tabs | `Reads the URL of the active tab to tell the user whether gestures work on the current page (browser pages and web store pages are skipped) and to find open web pages that need the gesture script after install. Tab switching, closing and similar actions run on the tab where the user drew the gesture.` |
| activeTab | `Lets the toolbar popup work with the tab the user is currently viewing when the user opens it. The extension never treats this temporary access as permanent site access; for persistent use it asks the user to allow the specific site.` |
| ホスト権限 (http, https, file) | `Mouse gestures must work on any page the user visits. The content script only listens for the user's right-button drag, draws the trail and guide in a closed Shadow DOM overlay, and sends the recognized shape name (for example "R") to the service worker. It does not read, store or transmit page content, URLs or browsing history. file:// is used only if the user turns on "Allow access to file URLs".` |

### リモートコード

「いいえ、リモートコードを使用していません」を選びます。 すべてのスクリプトはパッケージに含まれています。

### データの使用 (Data usage)

- 収集するデータの種類は **どれにもチェックを入れません**。
  マウスの位置は、 ジェスチャーの判定のためにページ内のメモリーで一時的に扱うだけで、 保存も送信もしません。 タブの URL は対応ページかどうかの判定にだけ使い、 保存も送信もしません。
- 3 つの開示事項 (第三者への販売・転用をしない、 用途と無関係な利用をしない、 信用力の判定に使わない) にチェックを入れます。
- プライバシー ポリシーの URL: `https://hisator-notebook.com/extensions-privacy.html`（公開済み・複数拡張機能共通ページ）を入力します。 `tabs`・`scripting`・ホスト権限を使う拡張機能では Chrome ウェブストア上で入力が必須です。

## 4. 配布

- 公開設定: 公開 (または限定公開で動作確認してから公開)
- 地域: すべての地域
- 価格: 無料

## 5. 審査担当者への説明 (Test instructions)

```
No account or setup is needed.
1. Open any two normal web pages (for example https://example.com and https://example.org) in the same window.
2. On the first page, hold the RIGHT mouse button, move the mouse to the right by about 100 px, and release. The next tab is activated.
3. On that tab, do the same to the left. The previous tab is activated.
4. Click the toolbar icon to open the settings popup. Each of the 12 shapes can be assigned an action; changes are saved automatically.
5. A right-click without moving opens the normal context menu.
The extension cannot run on chrome:// pages, the New Tab page or the Chrome Web Store (browser restriction).
```

## 6. 申請前の確認

- `npm test` (自動テスト) と `node tests/e2e/run-e2e.js --ext=<ZIP を展開したフォルダー>` (実ブラウザ試験) が合格していること。
- ダッシュボードのアカウントで 2 段階認証・連絡先メールの確認・(EU 向けの) 取引者区分の申告が済んでいること。
- Microsoft Edge アドオン (https://partner.microsoft.com/dashboard/microsoftedge) にも同じ ZIP をそのまま申請できます。
