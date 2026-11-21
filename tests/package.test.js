'use strict';
// 配布物 (extension フォルダー) の検査: manifest、 ファイル、 ストアの制限、 対象外機能の不在。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CONTENT_FILES } = require('../extension/background.js');

const ext = path.join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const locales = {
  ja: JSON.parse(fs.readFileSync(path.join(ext, '_locales', 'ja', 'messages.json'), 'utf8')),
  en: JSON.parse(fs.readFileSync(path.join(ext, '_locales', 'en', 'messages.json'), 'utf8'))
};

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? listFiles(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

test('Manifest V3 の基準', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.minimum_chrome_version, '119');
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.deepEqual(manifest.permissions, ['storage', 'scripting', 'sessions', 'activeTab', 'tabs']);
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*', 'file:///*']);
  assert.equal(manifest.chrome_url_overrides, undefined, '新規タブを置き換えない');
  assert.equal(manifest.content_security_policy, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  const cs = manifest.content_scripts;
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0].matches, manifest.host_permissions);
  assert.equal(cs[0].run_at, 'document_start');
  assert.equal(cs[0].all_frames, true);
  assert.deepEqual(cs[0].js, CONTENT_FILES, '再注入と同じファイル');
});

test('参照するファイルがすべて存在する', () => {
  const refs = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts[0].js
  ];
  for (const ref of refs) assert.ok(fs.existsSync(path.join(ext, ref)), ref);
  const html = fs.readFileSync(path.join(ext, 'popup.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^https?:/.test(m[1])) continue;
    assert.ok(fs.existsSync(path.join(ext, m[1])), m[1]);
  }
});

test('アイコンの大きさ', () => {
  for (const [size, file] of Object.entries(manifest.icons)) {
    const s = pngSize(path.join(ext, file));
    assert.equal(s.width, Number(size), file);
    assert.equal(s.height, Number(size), file);
    assert.equal(s.colorType, 6, '透過付き RGBA');
  }
});

test('ストアの文字数制限と翻訳キー', () => {
  for (const [lang, messages] of Object.entries(locales)) {
    for (const key of ['extName', 'extShortName', 'extDescription', 'actionTitle']) assert.ok(messages[key] && messages[key].message, `${lang}.${key}`);
    assert.ok(messages.extName.message.length <= 75, `${lang} 名前は 75 文字以内`);
    assert.ok(messages.extShortName.message.length <= 12, `${lang} 短い名前は 12 文字以内`);
    assert.ok(messages.extDescription.message.length <= 132, `${lang} 説明は 132 文字以内 (${messages.extDescription.message.length})`);
  }
  assert.equal(manifest.default_locale, 'ja');
  assert.equal(locales.ja.extName.message, 'マウスジェスチャー・タブ操作');
});

test('独自の新規タブ画面・開始画面・リモートコードを含めない', () => {
  const files = listFiles(ext).map((f) => path.relative(ext, f).replace(/\\/g, '/'));
  for (const f of files) assert.doesNotMatch(f, /newtab|start-page/i, f);
  const allowedExt = /\.(js|json|html|css|svg|png)$/;
  for (const f of files) assert.match(f, allowedExt, '想定外のファイル: ' + f);
  for (const f of files.filter((x) => /\.(js|html|css)$/.test(x))) {
    const text = fs.readFileSync(path.join(ext, f), 'utf8');
    assert.doesNotMatch(text, /open-start-page/, f);
    assert.doesNotMatch(text, /\beval\s*\(|new Function\s*\(/, f);
    assert.doesNotMatch(text, /<script[^>]+src="https?:/i, f);
    assert.doesNotMatch(text, /@import|fonts\.googleapis|cdn\./i, f);
    assert.doesNotMatch(text, /L字|逆L/, f);
    const urls = [...text.matchAll(/https?:\/\/[^\s"'`)<]+/g)].map((m) => m[0]);
    for (const u of urls) assert.ok(/^https:\/\/hisator-notebook\.com\/$|^http:\/\/www\.w3\.org\//.test(u), `${f}: ${u}`);
  }
});

test('フッターのリンクは 1 つで、 新しいタブで安全に開く', () => {
  const html = fs.readFileSync(path.join(ext, 'popup.html'), 'utf8');
  const links = [...html.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]);
  assert.equal(links.length, 1);
  assert.match(links[0], /href="https:\/\/hisator-notebook\.com\/"/);
  assert.match(links[0], /target="_blank"/);
  assert.match(links[0], /rel="noopener noreferrer"/);
  assert.match(html.replace(/<[^>]+>/g, ''), /Hisator Notebook ↗/);
});
