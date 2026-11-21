/*
 * ポップアップの状態管理 (DOM に依存しない部分)。
 *  - 保存要求の番号付けと、 応答順の逆転への対応
 *  - 「有効」切り替え後の再診断を、 保存の成功を確認してから 1 回だけ行う
 *  - 診断要求の番号付け (古い応答で表示を戻さない)
 */
(function (root) {
  'use strict';

  function createSaveTracker() {
    let seq = 0;
    let latest = 0;
    let snapshot = null;
    let diagnoseFrom = 0;
    let state = 'idle';

    return {
      /** 変更時点の全設定のスナップショットを登録し、 保存番号を返す。 */
      begin(settingsSnapshot, options) {
        seq += 1;
        latest = seq;
        snapshot = settingsSnapshot;
        if (options && options.diagnose) diagnoseFrom = seq;
        state = 'saving';
        return seq;
      },
      /**
       * 応答を反映する。 latest でない応答は表示を変えない。
       * 保存は全設定のスナップショットなので、 diagnoseFrom 以降の番号が成功すれば
       * 「有効」の変更も保存済み。 再診断は 1 回だけ要求する。
       */
      complete(n, ok) {
        const isLatest = n === latest;
        let diagnose = false;
        if (ok && diagnoseFrom && n >= diagnoseFrom) {
          diagnose = true;
          diagnoseFrom = 0;
        }
        if (isLatest) state = ok ? 'saved' : 'failed';
        return { isLatest, state: isLatest ? state : null, diagnose };
      },
      /** 失敗時の再試行用に、 最新の編集内容を返す。 */
      latestSnapshot() {
        return snapshot;
      },
      get state() {
        return state;
      },
      get latest() {
        return latest;
      },
      get pendingDiagnose() {
        return diagnoseFrom !== 0;
      }
    };
  }

  function createSequencer() {
    let current = 0;
    return {
      next() {
        current += 1;
        return current;
      },
      isLatest(id) {
        return id === current;
      }
    };
  }

  const api = Object.freeze({ createSaveTracker, createSequencer });

  root.MGPopupLogic = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
