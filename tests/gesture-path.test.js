'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/config.js');
const { GesturePath, tolerance, MAX_POINTS } = require('../extension/gesture-path.js');
const GS = require('../extension/gesture-shape.js');

function run(points) {
  const path = new GesturePath(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) path.add(x, y);
  return path;
}

// 2 点の間を step px ごとの点で埋める (実際の移動イベントに近づける)
function densify(points, step) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / step));
    for (let k = 1; k <= n; k += 1) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}

const shape = (points) => GS.recognize(run(points));

test('5.5 の判定例', async (t) => {
  const cases = [
    ['(0,0)→(100,0)', [[0, 0], [100, 0]], 'R'],
    ['(0,0)→(0,100)→(100,100)', [[0, 0], [0, 100], [100, 100]], 'DR'],
    ['(0,0)→(100,0)→(100,100) は DR と別', [[0, 0], [100, 0], [100, 100]], 'RD'],
    ['小さい初動を吸収', [[0, 0], [0, 1], [100, 1]], 'R'],
    ['小さい末尾の揺れを吸収', [[0, 0], [100, 0], [100, 3]], 'R'],
    ['基準線の両側への手ぶれ', [[0, 0], [100, 4], [101, -4], [102, 4]], 'R'],
    ['15px は D のまま', [[0, 0], [0, 100], [15, 100]], 'D'],
    ['16px で DR', [[0, 0], [0, 100], [15, 100], [16, 100]], 'DR'],
    ['小さい 3 方向目は吸収', [[0, 0], [0, 100], [100, 100], [100, 115]], 'DR'],
    ['3 方向目 16px で無効', [[0, 0], [0, 100], [100, 100], [100, 115], [100, 116]], null],
    ['線が決まった後の斜めの末尾は確定した形のまま', [[0, 0], [100, 0], [130, 30]], 'R'],
    ['折り返し', [[0, 0], [100, 0], [0, 0]], null],
    ['3 ストローク', [[0, 0], [0, 100], [100, 100], [100, 0]], null],
    ['斜め', [[0, 0], [100, 100]], null]
  ];
  for (const [name, points, expected] of cases) {
    await t.test(name, () => assert.equal(shape(points), expected));
  }
});

test('12 種類の形を方向順で区別する', () => {
  const S = 100;
  const vec = { L: [-S, 0], R: [S, 0], U: [0, -S], D: [0, S] };
  for (const id of ['L', 'R', 'U', 'D', 'DR', 'DL', 'UR', 'UL', 'RU', 'RD', 'LU', 'LD']) {
    const pts = [[0, 0]];
    for (const d of id) {
      const [x, y] = pts[pts.length - 1];
      pts.push([x + vec[d][0], y + vec[d][1]]);
    }
    assert.equal(shape(pts), id, id + ' (疎な点)');
    assert.equal(shape(densify(pts, 3)), id, id + ' (密な点)');
  }
});

test('A03: 5/10/100/300px の線と角は距離に依存せず同じ形', () => {
  for (const size of [5, 10, 100, 300]) {
    assert.equal(shape(densify([[0, 0], [size, 0]], 1)), 'R', `R ${size}px`);
    assert.equal(shape(densify([[0, 0], [0, size], [size, size]], 1)), 'DR', `DR ${size}px`);
    assert.equal(shape(densify([[0, 0], [-size, 0], [-size, -size]], 1)), 'LU', `LU ${size}px`);
  }
});

test('A04: 4px 以内の動きでは線分・候補を作らない', () => {
  for (const pts of [[[0, 0], [4, 4]], [[0, 0], [-4, 2]], [[0, 0], [3, 0], [0, 4], [4, -4]]]) {
    const p = run(pts);
    assert.equal(GS.recognize(p), null);
    assert.equal(p.getVertices().length, 1, '始点だけ');
    assert.equal(p.state, 'idle');
  }
  assert.equal(shape([[0, 0], [5, 0]]), 'R', '手ぶれを超えた短い線は認識する');
});

test('A05: 初動 1px、 末尾 3px、 末尾の小さい戻りを吸収', () => {
  assert.equal(shape(densify([[0, 0], [0, 1], [150, 1]], 2)), 'R');
  assert.equal(shape(densify([[0, 0], [150, 0], [150, 3]], 1)), 'R');
  assert.equal(shape(densify([[0, 0], [150, 0], [145, 0]], 1)), 'R');
  assert.equal(shape(densify([[0, 0], [0, -150], [3, -150], [3, -146]], 1)), 'U');
});

test('A06: 長い辺の後の 20px は補正、 21px は角', () => {
  assert.equal(tolerance(300), 20);
  assert.equal(shape(densify([[0, 0], [300, 0], [300, 20]], 1)), 'R');
  assert.equal(shape(densify([[0, 0], [300, 0], [300, 21]], 1)), 'RD');
  assert.equal(shape(densify([[0, 0], [0, 300], [-21, 300]], 1)), 'DL');
});

test('許容値 4px の短い辺では 5px の曲がりも成立する', () => {
  assert.equal(tolerance(20), 4);
  assert.equal(shape(densify([[0, 0], [20, 0], [20, 5]], 1)), 'RD');
});

test('A07: 1px ずつのゆっくりした曲がりを累積して角にする', () => {
  const pts = [[0, 0]];
  for (let x = 1; x <= 120; x += 1) pts.push([x, 0]);
  for (let y = 1; y <= 30; y += 1) pts.push([120, y]);
  assert.equal(shape(pts), 'RD');
  // 斜め 1px ずつの丸い角
  const arc = [[0, 0]];
  for (let y = 1; y <= 120; y += 1) arc.push([0, y]);
  for (let k = 1; k <= 20; k += 1) arc.push([k, 120 + Math.round(Math.sqrt(400 - (20 - k) ** 2) / 4)]);
  for (let x = 21; x <= 140; x += 1) arc.push([x, 125]);
  assert.equal(shape(arc), 'DR');
});

test('ゆるく丸めた角・傾いた線・長さの違う 2 辺', () => {
  const round = [[0, 0]];
  for (let a = 0; a <= 90; a += 3) {
    const r = 60;
    round.push([Math.sin((a * Math.PI) / 180) * r, 200 - Math.cos((a * Math.PI) / 180) * r]);
  }
  const rounded = [[0, 0], [0, 140], ...round.slice(1), [200, 200]];
  assert.equal(shape(densify(rounded, 2)), 'DR');
  assert.equal(shape(densify([[0, 0], [200, 30]], 2)), 'R', '約 8.5 度の傾き');
  assert.equal(shape(densify([[0, 0], [0, -300], [-25, -300]], 2)), 'UL', '長さが大きく違う 2 辺');
});

test('角は確定した位置から動かない', () => {
  const p = run([[0, 0], [0, 100], [50, 100]]);
  const corner = p.getVertices()[1];
  p.add(80, 103);
  p.add(120, 97);
  assert.deepEqual(p.getVertices()[1], corner);
  assert.equal(GS.recognize(p), 'DR');
});

test('A08: 2 回目の曲がり・往復・階段・ループは不成立', () => {
  assert.equal(shape(densify([[0, 0], [100, 0], [100, 100], [200, 100]], 2)), null, '階段');
  assert.equal(shape(densify([[0, 0], [100, 0], [0, 0], [100, 0]], 2)), null, '往復');
  assert.equal(shape(densify([[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], 2)), null, 'ループ');
  assert.equal(shape(densify([[0, 0], [0, 100], [100, 100], [100, 0]], 2)), null, '3 ストローク');
});

test('無効化した経路は 3 本目を描かず、 戻っても有効にならない', () => {
  const p = run([[0, 0], [0, 100], [100, 100]]);
  const before = p.getVertices();
  p.add(100, 120);
  assert.equal(p.state, 'invalid');
  assert.deepEqual(p.getVertices(), before, '直前の 2 辺を残す');
  p.add(100, 100);
  p.add(150, 100);
  assert.equal(GS.recognize(p), null, '元へ戻しても無効のまま');
});

test('不正経路から先頭や末尾の一部を取り出さない', () => {
  // 先頭の R だけ、 先頭の DR だけ、 末尾の有効な線だけを実行しない
  assert.equal(shape(densify([[0, 0], [100, 0], [0, 0], [0, 100]], 2)), null);
  assert.equal(shape(densify([[0, 0], [0, 100], [100, 100], [100, 200], [200, 200]], 2)), null);
  assert.equal(shape(densify([[0, 0], [50, 50], [60, -40], [200, -40]], 2)), null);
});

test('A09: 有効な直線の後に曖昧な斜めの末尾', () => {
  const p = run(densify([[0, 0], [100, 0]], 2));
  assert.equal(GS.recognize(p), 'R');
  p.add(130, 30);
  assert.equal(p.state, 'pending');
  assert.equal(GS.recognize(p), 'R', '斜めの末尾では線を伸ばさず、 確定した形のまま');
  // 斜めの後に明確な方向へ動けば判定を続ける
  p.add(130, 120);
  assert.equal(GS.recognize(p), 'RD');
});

test('手で描いた線: 弧・傾き・終わりの曲がり・離す時の戻りでも同じ形', () => {
  // 手首の弧で 15px ふくらみ、 終わりで 12px 下へ曲がる右
  const arc = [[0, 0]];
  for (let x = 4; x <= 220; x += 4) arc.push([x, Math.round(15 * Math.sin((Math.PI * x) / 220))]);
  arc.push([224, 6], [226, 12]);
  assert.equal(shape(arc), 'R', '弧と終わりの曲がり');
  assert.equal(shape(densify([[0, 0], [-180, 0], [-170, 2]], 3)), 'L', '離す時に 10px 戻る');
  assert.equal(shape(densify([[0, 0], [150, 0], [180, 30]], 3)), 'R', '終わりが斜めにずれる');
  assert.equal(shape(densify([[0, 0], [-120, -25], [-200, -30]], 3)), 'L', '途中で傾きが変わる');
  assert.equal(shape(densify([[0, 0], [0, 160], [-14, 166]], 2)), 'D', '縦の線の終わりの小さな曲がり');
  // 意図した 2 本線は今までどおり区別する
  assert.equal(shape(densify([[0, 0], [150, 0], [150, 80]], 3)), 'RD');
  assert.equal(shape(densify([[0, 0], [0, -120], [-60, -120]], 3)), 'UL');
});

test('A10: 最終方向が解放位置だけで届いても判定する', () => {
  const p = run([[0, 0], [0, 80]]);
  assert.equal(GS.recognize(p), 'D');
  p.add(90, 80); // 解放イベントの位置
  assert.equal(GS.recognize(p), 'DR');
});

test('開始直後の小さい折れは吸収する', () => {
  assert.equal(shape(densify([[0, 0], [0, 5], [150, 5]], 1)), 'R');
  assert.equal(shape(densify([[0, 0], [5, 0], [5, 150], [150, 150]], 1)), 'DR');
  assert.equal(shape(densify([[0, 0], [5, 0], [-150, 0]], 1)), 'L', '小さな初動の逆方向');
});

test('非数値・無限大・上限超えの座標は無効', () => {
  for (const bad of [NaN, Infinity, -Infinity, 2e6]) {
    const p = run([[0, 0], [100, 0]]);
    p.add(bad, 0);
    assert.equal(p.state, 'invalid');
    assert.equal(GS.recognize(p), null);
  }
  assert.equal(new GesturePath(NaN, 0).state, 'invalid');
});

test('点の数は 20,000 まで。 超えたら記録を伸ばさず無効', () => {
  const p = new GesturePath(0, 0);
  for (let i = 1; i < MAX_POINTS; i += 1) p.add(i % 2 ? 1 : 2, 0);
  assert.equal(p.points, MAX_POINTS);
  assert.notEqual(p.state, 'invalid');
  p.add(3, 0);
  assert.equal(p.state, 'invalid');
  assert.equal(p.points, MAX_POINTS);
  // 連続重複は数えない
  const q = new GesturePath(0, 0);
  for (let i = 0; i < 30000; i += 1) q.add(50, 0);
  assert.equal(q.points, 2);
  assert.equal(GS.recognize(q), 'R');
});

test('揺れと間隔の異なる入力でも意図した形になり、 別の形に化けない', () => {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const vec = { L: [-1, 0], R: [1, 0], U: [0, -1], D: [0, 1] };
  let recognized = 0;
  let total = 0;
  for (const id of ['L', 'R', 'U', 'D', 'DR', 'DL', 'UR', 'UL', 'RU', 'RD', 'LU', 'LD']) {
    for (let trial = 0; trial < 60; trial += 1) {
      const pts = [[500, 500]];
      for (const d of id) {
        const len = 30 + rand() * 250;
        const step = 1 + rand() * 7;
        const [x0, y0] = pts[pts.length - 1];
        const n = Math.ceil(len / step);
        for (let k = 1; k <= n; k += 1) {
          const along = (len * k) / n;
          // 進行方向と直交する ±3px の揺れ (補正許容値 4px 未満)
          const wobble = (rand() * 2 - 1) * 3;
          const nx = -vec[d][1];
          const ny = vec[d][0];
          const x = Math.round(x0 + vec[d][0] * along + nx * wobble);
          const y = Math.round(y0 + vec[d][1] * along + ny * wobble);
          pts.push([x, y]);
        }
        // 次の辺は揺れのない位置から始める
        pts[pts.length - 1] = [Math.round(x0 + vec[d][0] * len), Math.round(y0 + vec[d][1] * len)];
      }
      total += 1;
      const got = shape(pts);
      assert.ok(got === id || got === null, `${id} が ${got} になった (trial ${trial})`);
      if (got === id) recognized += 1;
    }
  }
  assert.ok(recognized / total > 0.97, `認識率 ${recognized}/${total}`);
});

test('頂点は最大 3 点', () => {
  const p = run(densify([[0, 0], [0, 100], [100, 100], [100, 200]], 3));
  assert.ok(p.getVertices().length <= 3);
});
