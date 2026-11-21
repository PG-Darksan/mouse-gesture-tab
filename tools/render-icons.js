'use strict';
// extension/icon.svg から PNG アイコン (16/32/48/128) を作る。 開発時だけ使う (拡張機能の実行には不要)。
//   node tools/render-icons.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findBrowser } = require('./chrome-path.js');

const root = path.resolve(__dirname, '..');
const svgSource = fs.readFileSync(path.join(root, 'extension', 'icon.svg'), 'utf8');
const outDir = path.join(root, 'extension', 'icons');
const browser = findBrowser(false);
if (!browser) throw new Error('Chrome / Edge が見つかりません (CHROME_PATH で指定できます)');

// 128px はストアの指定どおり 16px の余白付き。 小さいサイズは余白を詰めて見やすくする。
const SIZES = [
  { size: 16, viewBox: '14 14 100 100' },
  { size: 32, viewBox: '14 14 100 100' },
  { size: 48, viewBox: '12 12 104 104' },
  { size: 128, viewBox: '0 0 128 128' }
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-icons-'));
fs.mkdirSync(outDir, { recursive: true });
try {
  for (const { size, viewBox } of SIZES) {
    const svg = svgSource
      .replace(/viewBox="[^"]*"/, `viewBox="${viewBox}"`)
      .replace(/width="\d+"/, `width="${size}"`)
      .replace(/height="\d+"/, `height="${size}"`);
    const html = path.join(work, `icon${size}.html`);
    // svg は行内要素のままだと文字の基準線に合わせて下へずれる (16px では日本語フォントの行の高さで 1〜2px 沈む) ので block にする
    fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden"><div style="width:${size}px;height:${size}px">${svg.replace('<svg ', '<svg style="display:block" ')}</div></body></html>`);
    const out = path.join(outDir, `icon${size}.png`);
    execFileSync(browser, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--user-data-dir=${path.join(work, 'profile')}`,
      `--window-size=${size},${size}`,
      `--screenshot=${out}`,
      'file:///' + html.replace(/\\/g, '/')
    ], { stdio: 'ignore', timeout: 60000 });
    console.log('wrote', path.relative(root, out));
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
