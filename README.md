# マウスジェスチャー・タブ操作 (Mouse Gestures – Tab Control)

Windows の Google Chrome / Microsoft Edge 向けの Manifest V3 拡張機能です。
Web ページで右ボタンを押したまま上下左右に動かし、 右ボタンを離した時に、 形に割り当てたブラウザ操作を 1 回だけ実行します（スクロール操作を割り当てた形では、 右ボタンを押したままにしている間だけスクロールし続け、 離すと止まります）。

- 版: 3.6.0 (最小 Chrome 119)
- ビルド・`npm install` は不要。 `extension` フォルダーがそのまま拡張機能です。

## フォルダー構成

```text
extension/            拡張機能本体 (ストアへ提出する ZIP の中身)
  manifest.json
  _locales/ja, en/    名前と説明 (ストア・拡張機能の管理画面に表示)
  config.js           操作一覧、 初期設定、 検証・正規化
  i18n.js             日本語・英語の文言
  gesture-path.js     入力経路、 手ぶれ補正、 水平・垂直への固定
  gesture-shape.js    形の判定と図
  content.js          入力、 軌跡、 操作ガイド、 実行要求
  background.js       Service Worker: 設定保存、 ブラウザ操作、 診断
  popup.html / popup.css / popup.js / popup-logic.js
  icon.svg, icons/    アイコン
tests/                Node.js の自動テスト、 tests/e2e は実ブラウザ試験
tools/                ZIP 作成、 アイコン・ストア画像の作成 (開発時だけ使う)
store/                ストア申請用の文面、 プライバシー ポリシー、 画像
dist/                 ストアへアップロードする ZIP
```

独自の新規タブ画面や `chrome_url_overrides` はありません。

## 導入方法 (パッケージ化されていない拡張機能として)

1. Chrome で `chrome://extensions/` (Edge は `edge://extensions/`) を開く。
2. 右上の「デベロッパー モード」をオンにする。
3. 「パッケージ化されていない拡張機能を読み込む」で `extension` フォルダーを選ぶ。
4. 開いていたページは自動で準備されるので、 再読み込みしなくても使えます。
5. パソコン内の HTML ファイルでも使う場合は、 拡張機能の「詳細」で「ファイルの URL へのアクセスを許可する」をオンにします。

## 更新方法

- フォルダーの中身を新しい版に置き換え、 `chrome://extensions/` でこの拡張機能の「再読み込み」(↻) を押します。
- 設定 (割り当て・表示・言語など) はそのまま残ります。 旧版の 8 種類だけの設定や `threshold` も引き継ぎ、 新しい 4 種類は「何もしない」で補います。
- 開いているページは自動で準備し直します。 準備できないページがあれば、 ポップアップに「ページを再読み込みしてください」と表示されます。

## 操作方法

1. ページの上で右ボタンを押したまま、 上下左右に動かす (1 回だけ直角に曲げてもよい)。
2. 画面下の操作ガイドに、 認識中の形と割り当てた操作が出ます。
3. 右ボタンを離すと 1 回だけ実行します。 スクロール操作は認識中・右ボタンを押している間だけ連続してスクロールし、 離すと止まります。 途中で Esc を押すと中止します。

| 形 | 描く順番 | 初期の操作 |
| --- | --- | --- |
| 左 / 右 | ← / → | 前のタブへ / 次のタブへ |
| 上 / 下 | ↑ / ↓ | 何もしない |
| 下→右、 下→左、 上→右、 上→左 | ↓の後に→ など | 何もしない |
| 右→上、 右→下、 左→上、 左→下 | →の後に↑ など | 何もしない |

- 動かさずに右クリックした時は、 いつものメニューが開きます。
- 4px 以内の動きは手ぶれとして無視します。 それより大きな短い線は認識します。
- 線の終わりの小さな曲がり・離す前の小さな戻り・斜めへのずれは無視します (許容幅は線の長さの 15%、 4〜20px)。
- 2 回目の曲がり、 折り返し、 最初から斜めに動かした場合は実行しません。

## 設定方法

ツールバーの拡張機能アイコンからポップアップを開きます。 変更はその場で自動保存されます。

- 現在のページの状態 (このページで使用できます / 対象外 / サイトの許可が必要 など)。 「このサイトを許可」は必要な時だけ表示し、 そのホストだけを許可します。
- 「有効」「タブを循環」「軌跡」「操作ガイド」の切り替え
- 文字サイズ (小・標準・大)、 言語 (自動・日本語・English)
- 12 種類の形それぞれに、 17 の選択肢から操作を割り当て（上下左右の連続スクロールを含む）

## 制限

- 新しいタブ、 `chrome://` `edge://` の画面、 他の拡張機能の画面、 Chrome ウェブストア・Edge アドオンの画面では動作しません (ブラウザーの仕様)。
- ブラウザー内蔵の PDF ビューアーでは使えない場合があります。
- シークレット / InPrivate ウィンドウでは、 拡張機能の詳細で利用を許可した場合だけ動作します。
- 新しいタブを開く位置は元のタブの直後を指定しますが、 固定タブなどブラウザー側の配置の決まりに従います。
- タッチ操作、 macOS / Linux / Firefox は対象外です。
- 重複実行の防止はブラウザーを起動している間のメモリー上で行います。

## テストの実行方法

Node.js 20 以降が必要です (追加のパッケージは不要)。

```powershell
npm test                                   # 自動テスト (node --test)
node tests/e2e/run-e2e.js                  # 実ブラウザ試験 (Chrome、 空の一時プロファイル、 画面は出さない)
node tests/e2e/run-e2e.js --edge           # Edge で実行
node tests/e2e/run-e2e.js --headful        # ブラウザーの画面を出して実行
node tests/e2e/run-e2e.js --google         # Google の検索トップでの試験 (A28) も行う
node tests/e2e/run-e2e.js --ext=<フォルダー> # ZIP を展開した配布物そのものを試験
```

実ブラウザ試験は一時プロファイルを作って終了後に削除するため、 普段のタブ・アカウント・設定には触れません。
入力は Chrome DevTools Protocol の `Input.dispatchMouseEvent` (ページからは `isTrusted` の入力) で行います。
結果は `tests/e2e/last-run.json`、 画面の記録は `tests/e2e/screens/` に保存します。

## ストアへの申請

```powershell
node tools/pack.js             # Chrome / Edge 提出用: dist/mouse-gesture-tab-<版>.zip を作成
node tools/pack-firefox.cjs    # Firefox 提出用: dist/mouse-gesture-tab-<版>-firefox.zip と dist/firefox/ を作成
node tools/store-assets.js     # store/images/ のスクリーンショットとタイルを作り直す (任意)
node tools/render-icons.js     # icon.svg から PNG アイコンを作り直す (任意)
```

ダッシュボードの各欄へ貼る文面、 権限の理由、 データの扱いの回答は [store/STORE_LISTING.md](store/STORE_LISTING.md)、
プライバシー ポリシーは [store/privacy-policy.html](store/privacy-policy.html) (公開して URL を入力) にあります。
