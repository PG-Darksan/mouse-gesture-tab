'use strict';
// テスト・素材作成用に Chrome / Edge の実行ファイルを探す。 CHROME_PATH があれば優先する。
const fs = require('node:fs');
const path = require('node:path');

function findBrowser(preferEdge) {
  const env = process.env;
  const candidates = [];
  if (env.CHROME_PATH) candidates.push(env.CHROME_PATH);
  const chrome = [
    path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ];
  const edge = [
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe')
  ];
  candidates.push(...(preferEdge ? edge.concat(chrome) : chrome.concat(edge)));
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

module.exports = { findBrowser };
