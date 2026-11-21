/*
 * 形の判定と表示用の情報。 対応する形は 1 ストローク 4 種と、 直交方向へ 1 回曲がる 8 種だけ。
 */
(function (root) {
  'use strict';

  const C = root.MGConfig || (typeof require === 'function' ? require('./config.js') : null);

  const ARROWS = Object.freeze({ L: '←', R: '→', U: '↑', D: '↓' });
  const UNIT = Object.freeze({ L: [-1, 0], R: [1, 0], U: [0, -1], D: [0, 1] });

  function isShape(id) {
    return C.isGesture(id);
  }

  function strokesOf(id) {
    return isShape(id) ? id.split('') : [];
  }

  /** ストロークの方向列から形の ID を返す。 対応外 (斜め・同方向・3 本以上) は null。 */
  function fromStrokes(dirs) {
    if (!Array.isArray(dirs) || dirs.length < 1 || dirs.length > 2) return null;
    const id = dirs.join('');
    return isShape(id) ? id : null;
  }

  /** 認識: 無効な経路は形にしない。 線が決まった後の斜めの保留は、 確定した形のまま扱う。 */
  function recognize(path) {
    if (!path || path.invalid) return null;
    return fromStrokes(path.strokes.map((s) => s.dir));
  }

  function arrows(id) {
    return strokesOf(id).map((d) => ARROWS[d]).join(' ');
  }

  /**
   * 設定画面の図: 始点の点、 線、 終点の矢印。 表記と同じ順番で描く。
   * size 四方の中央に収める。
   */
  function diagram(id, size, pad) {
    const box = size || 40;
    const margin = pad == null ? 8 : pad;
    const span = box - margin * 2;
    const dirs = strokesOf(id);
    if (!dirs.length) return null;
    const c = box / 2;
    const u1 = UNIT[dirs[0]];
    const points = [];
    if (dirs.length === 1) {
      points.push([c - (u1[0] * span) / 2, c - (u1[1] * span) / 2]);
      points.push([c + (u1[0] * span) / 2, c + (u1[1] * span) / 2]);
    } else {
      const u2 = UNIT[dirs[1]];
      const start = [c - ((u1[0] + u2[0]) * span) / 2, c - ((u1[1] + u2[1]) * span) / 2];
      const corner = [start[0] + u1[0] * span, start[1] + u1[1] * span];
      points.push(start, corner, [corner[0] + u2[0] * span, corner[1] + u2[1] * span]);
    }
    const last = UNIT[dirs[dirs.length - 1]];
    const tip = points[points.length - 1];
    const head = 7;
    const half = 5;
    const base = [tip[0] - last[0] * head, tip[1] - last[1] * head];
    const normal = [-last[1], last[0]];
    const arrow = [
      tip,
      [base[0] + normal[0] * half, base[1] + normal[1] * half],
      [base[0] - normal[0] * half, base[1] - normal[1] * half]
    ];
    // 線は矢印の根元で止め、 先端が太くならないようにする。
    const line = points.slice(0, -1).concat([[tip[0] - last[0] * (head - 1), tip[1] - last[1] * (head - 1)]]);
    return { start: points[0], line, arrow };
  }

  const api = Object.freeze({ ARROWS, isShape, strokesOf, fromStrokes, recognize, arrows, diagram });

  root.MGGestureShape = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
