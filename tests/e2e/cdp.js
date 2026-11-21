'use strict';
// 依存パッケージなしの Chrome DevTools Protocol クライアント (--remote-debugging-pipe)。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class CDP {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();
    this.chunks = [];
    this.closed = false;
    proc.stdio[4].on('data', (chunk) => this.receive(chunk));
    proc.on('exit', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('browser exited (' + p.method + ')'));
      this.pending.clear();
    });
  }

  receive(chunk) {
    let start = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] !== 0) continue;
      this.chunks.push(chunk.subarray(start, i));
      const raw = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      start = i + 1;
      this.dispatch(JSON.parse(raw));
    }
    if (start < chunk.length) this.chunks.push(chunk.subarray(start));
  }

  dispatch(msg) {
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${p.method})`));
      else p.resolve(msg.result);
      return;
    }
    for (const h of [...this.handlers]) {
      if (h.method === msg.method && (!h.sessionId || h.sessionId === msg.sessionId)) h.fn(msg.params, msg.sessionId);
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('browser closed'));
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.proc.stdio[3].write(JSON.stringify(message) + '\0');
    });
  }

  on(method, fn, sessionId) {
    const h = { method, fn, sessionId };
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  waitFor(method, predicate, timeoutMs = 10000, sessionId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('timeout waiting for ' + method));
      }, timeoutMs);
      const off = this.on(
        method,
        (params, sid) => {
          if (predicate && !predicate(params, sid)) return;
          clearTimeout(timer);
          off();
          resolve(params);
        },
        sessionId
      );
    });
  }
}

function launch(browserPath, options = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-e2e-profile-'));
  const args = [
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-search-engine-choice-screen',
    '--password-store=basic',
    '--window-size=1280,800',
    ...(options.headless === false ? [] : ['--headless=new']),
    ...(options.args || []),
    'about:blank'
  ];
  const proc = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 200000) stderr = stderr.slice(-100000);
  });
  const cdp = new CDP(proc);
  return {
    cdp,
    proc,
    profile,
    stderr: () => stderr,
    async close() {
      try {
        await Promise.race([cdp.send('Browser.close'), new Promise((r) => setTimeout(r, 3000))]);
      } catch (_) {
        // 終了済み
      }
      if (proc.exitCode === null) proc.kill();
      await new Promise((r) => setTimeout(r, 500));
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch (_) {
        // 一時フォルダーの削除に失敗しても試験結果には影響しない
      }
    }
  };
}

module.exports = { CDP, launch };
