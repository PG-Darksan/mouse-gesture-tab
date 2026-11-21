/*
 * 入力経路の記録と補正。 水平・垂直に固定した最大2ストロークの経路を作る。
 * 認識 (getShape) と描画 (getVertices) は同じ補正済み経路を使う。
 *
 * 各ストロークは次の 2 つの基準を持つ。
 *   アンカー : 進行方向へ前進した最後の点 (実座標)。 前進した時だけ動く。
 *   基準線   : 直交方向の位置。 補正許容値の幅を超えた分だけアンカーに追従する。
 * 新しい点は次の順に判定する。
 *   - 角     : アンカーからも基準線からも、 直交方向へ許容値を超えて優位に動いた。
 *              アンカーは直交方向の動きでは動かないので、 1px ずつの曲がりも蓄積する。
 *              基準線は手ぶれの幅では動かないので、 線の両側への手ぶれを角と誤認しない。
 *   - 前進   : アンカーから進行方向が優位に進んだ。 線を伸ばす (傾いた線もここで吸収)。
 *   - 折り返し: 進行方向の逆へ許容値を超えて戻った。 経路を無効にする。
 *   - 手ぶれ : 許容値以内。 何もしない。
 *   - 保留   : どれでもない斜めの動き。 線は伸ばさない。 最初の線が決まる前の保留だけは形にしない。
 */
(function (root) {
  'use strict';

  const JITTER_FLOOR = 4;    // 開始点から max(|dx|,|dy|) <= 4 は手ぶれ
  const AXIS_RATIO = 1.8;    // 方向を決める比率
  const TOL_MIN = 4;
  const TOL_MAX = 20;        // 長い線の終わりの小さな曲がり・戻りを角や折り返しにしない
  const TOL_FACTOR = 0.15;
  const MAX_POINTS = 20000;  // 連続重複を除いた開始点・入力点の上限
  const MAX_COORD = 1e6;     // CSS px の絶対値の上限
  const MAX_STROKES = 2;

  const UNIT = Object.freeze({
    R: Object.freeze({ x: 1, y: 0 }),
    L: Object.freeze({ x: -1, y: 0 }),
    D: Object.freeze({ x: 0, y: 1 }),
    U: Object.freeze({ x: 0, y: -1 })
  });

  function isHorizontal(dir) {
    return dir === 'L' || dir === 'R';
  }

  function normalOf(dir) {
    return isHorizontal(dir) ? UNIT.D : UNIT.R;
  }

  /** 補正許容値 = max(4, min(20, これまでの最長辺 × 0.15)) */
  function tolerance(longest) {
    return Math.max(TOL_MIN, Math.min(TOL_MAX, longest * TOL_FACTOR));
  }

  function validCoord(v) {
    return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // 基準線は、 許容値の幅を超えた分だけ追従する
  function follow(perp, base, tol) {
    return perp - clamp(perp - base, -tol, tol);
  }

  /*
   * ストローク: V は判定用の原点 (実座標)、 origin は表示上の始点。
   * along / perp は V から見た進行方向・直交方向の座標。
   * reach はアンカーの進行方向の位置で、 表示上の長さでもある。
   */
  function makeStroke(dir, V, origin) {
    return { dir, u: UNIT[dir], n: normalOf(dir), V, origin, reach: 0, anchorPerp: 0, basePerp: 0 };
  }

  function local(stroke, p) {
    const dx = p.x - stroke.V.x;
    const dy = p.y - stroke.V.y;
    return {
      along: dx * stroke.u.x + dy * stroke.u.y,
      perp: dx * stroke.n.x + dy * stroke.n.y
    };
  }

  function strokeEnd(stroke) {
    return { x: stroke.origin.x + stroke.u.x * stroke.reach, y: stroke.origin.y + stroke.u.y * stroke.reach };
  }

  class GesturePath {
    constructor(x, y) {
      this.start = { x, y };
      this.last = { x, y };
      this.strokes = [];
      this.pending = null;
      this.invalid = null;
      this.points = 1;
      if (!validCoord(x) || !validCoord(y)) {
        this.start = { x: 0, y: 0 };
        this.invalid = 'bad-coordinate';
      }
    }

    longest() {
      let m = 0;
      for (const s of this.strokes) if (s.reach > m) m = s.reach;
      return m;
    }

    tolerance() {
      return tolerance(this.longest());
    }

    /** 点を追加する。 連続重複は数えない。 */
    add(x, y) {
      if (this.invalid) return;
      if (!validCoord(x) || !validCoord(y)) {
        this.invalid = 'bad-coordinate';
        return;
      }
      if (x === this.last.x && y === this.last.y) return;
      if (this.points >= MAX_POINTS) {
        this.invalid = 'too-many-points';
        return;
      }
      this.points += 1;
      this.last = { x, y };
      this.process({ x, y });
    }

    process(p) {
      if (this.strokes.length === 0) {
        this.processFirst(p);
        return;
      }
      const s = this.strokes[this.strokes.length - 1];
      const { along, perp } = local(s, p);
      const tol = this.tolerance();
      const da = along - s.reach;
      const dpAnchor = perp - s.anchorPerp;
      const dpBase = perp - s.basePerp;
      const ada = Math.abs(da);

      const turned =
        Math.abs(dpAnchor) > tol &&
        Math.abs(dpBase) > tol &&
        Math.abs(dpAnchor) > ada * AXIS_RATIO &&
        Math.abs(dpBase) > ada * AXIS_RATIO;
      if (turned) {
        if (this.strokes.length >= MAX_STROKES) {
          // 3 本目は描かずに無効化する
          this.invalid = 'extra-turn';
          return;
        }
        this.addCorner(s, dpAnchor, p);
        this.pending = null;
        this.absorbShortFirstStroke();
        return;
      }
      if (da > 0 && da > Math.abs(dpAnchor) * AXIS_RATIO) {
        s.reach = along;
        s.anchorPerp = perp;
        s.basePerp = follow(perp, s.basePerp, tol);
        this.pending = null;
        this.absorbShortFirstStroke();
        return;
      }
      if (da < -tol && ada > Math.abs(dpBase) * AXIS_RATIO) {
        if (this.strokes.length === 1 && s.reach <= TOL_MAX) {
          // 開始直後の小さな動きの後に逆へ動いた: 最初からやり直す
          this.strokes = [];
          this.pending = null;
          this.processFirst(p);
          return;
        }
        this.invalid = 'reversal';
        return;
      }
      if (Math.max(ada, Math.abs(dpBase)) <= tol) {
        this.pending = null;
        return;
      }
      this.pending = { along: da, perp: dpBase };
    }

    processFirst(p) {
      const dx = p.x - this.start.x;
      const dy = p.y - this.start.y;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (Math.max(ax, ay) <= JITTER_FLOOR) {
        this.pending = null;
        return;
      }
      let dir = null;
      if (ax > ay * AXIS_RATIO) dir = dx > 0 ? 'R' : 'L';
      else if (ay > ax * AXIS_RATIO) dir = dy > 0 ? 'D' : 'U';
      if (!dir) {
        // 曖昧な斜めは保留する。 基準位置は開始点のまま判断を続ける
        this.pending = { along: dx, perp: dy };
        return;
      }
      const s = makeStroke(dir, this.start, this.start);
      const { along, perp } = local(s, p);
      s.reach = along;
      s.anchorPerp = perp;
      s.basePerp = follow(perp, 0, tolerance(along));
      this.strokes.push(s);
      this.pending = null;
    }

    addCorner(s, dp, p) {
      const dir = isHorizontal(s.dir) ? (dp > 0 ? 'D' : 'U') : (dp > 0 ? 'R' : 'L');
      // 判定用の角はアンカーの実座標。 表示は前の辺の終点から続ける。
      const V = {
        x: s.V.x + s.u.x * s.reach + s.n.x * s.anchorPerp,
        y: s.V.y + s.u.y * s.reach + s.n.y * s.anchorPerp
      };
      const next = makeStroke(dir, V, strokeEnd(s));
      const { along, perp } = local(next, p);
      next.reach = along;
      next.anchorPerp = perp;
      next.basePerp = follow(perp, 0, tolerance(Math.max(this.longest(), along)));
      this.strokes.push(next);
    }

    // 開始直後の小さい折れ: 最初の辺が許容値以下なら 2 本目だけの直線として扱う
    absorbShortFirstStroke() {
      if (this.strokes.length !== 2) return;
      const first = this.strokes[0];
      const second = this.strokes[1];
      if (first.reach > this.tolerance()) return;
      const s = makeStroke(second.dir, this.start, this.start);
      const shift = local(s, second.V);
      s.reach = Math.max(0, second.reach + shift.along);
      s.anchorPerp = second.anchorPerp + shift.perp;
      s.basePerp = second.basePerp + shift.perp;
      this.strokes = [s];
    }

    /** 認識した形の ID。 無効・候補なしは null。 線が決まった後の斜めの保留は、 確定した形のまま扱う。 */
    getShape() {
      if (this.invalid || this.strokes.length === 0) return null;
      return this.strokes.map((s) => s.dir).join('');
    }

    /** 描画用の補正済み頂点 (最大3点)。 無効化後は直前の形のまま。 */
    getVertices() {
      const out = [{ x: this.start.x, y: this.start.y }];
      for (const s of this.strokes) out.push(strokeEnd(s));
      return out;
    }

    get state() {
      if (this.invalid) return 'invalid';
      if (this.pending) return 'pending';
      return this.strokes.length ? 'valid' : 'idle';
    }
  }

  const api = Object.freeze({
    GesturePath,
    tolerance,
    JITTER_FLOOR,
    AXIS_RATIO,
    TOL_MIN,
    TOL_MAX,
    MAX_POINTS,
    MAX_COORD
  });

  root.MGGesturePath = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
