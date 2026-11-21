'use strict';
// extension フォルダーを Chrome ウェブストアへアップロードする ZIP にまとめる (依存パッケージなし)。
//   node tools/pack.js   → dist/mouse-gesture-tab-<version>.zip
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const outDir = path.join(root, 'dist');
const out = path.join(outDir, `mouse-gesture-tab-${manifest.version}.zip`);

// OneDrive やエクスプローラーが作る管理用ファイルは含めない
const IGNORE = /(^|\/)(\.[^/]*|desktop\.ini|thumbs\.db)$/i;

function list(dir, base = '') {
  const items = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${d.name}` : d.name;
    if (IGNORE.test(rel)) continue;
    if (d.isDirectory()) items.push(...list(path.join(dir, d.name), rel));
    else items.push(rel);
  }
  return items.sort();
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 再現できる ZIP にするため、 日時は固定する (2026-01-01 00:00)
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function build() {
  const files = list(src);
  if (!files.includes('manifest.json')) throw new Error('manifest.json がありません');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of files) {
    const data = fs.readFileSync(path.join(src, name));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(out, Buffer.concat([...locals, centralBuf, end]));
  return files;
}

const files = build();
console.log(`${path.relative(root, out)}  (${files.length} ファイル, ${fs.statSync(out).size} bytes)`);
for (const f of files) console.log('  ' + f);
