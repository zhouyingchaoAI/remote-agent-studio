const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const path = require('node:path');

// Mock only SSH transport and the clock; exercise the real connection lifecycle.
function fixture() {
  const clients = [], timers = new Map();
  let id = 0;
  class Client extends EventEmitter {
    constructor() { super(); clients.push(this); this.forwards = []; }
    connect(cfg) { this.cfg = cfg; return this; }
    forwardIn(host, port, cb) { this.forwards.push({ host, port, cb }); }
    end() { this.emit('close'); }
    destroy() { this.emit('close'); }
  }
  const file = path.resolve(__dirname, '../electron/ssh/SSHManager.js');
  const realRequire = createRequire(file), mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module: mod, exports: mod.exports, Buffer, console, process,
    require: (name) => name === 'ssh2' ? { Client } : realRequire(name),
    setTimeout: (fn, ms) => { const key = ++id; timers.set(key, { fn, ms }); return key; },
    clearTimeout: (key) => timers.delete(key)
  }, { filename: file });
  const ssh = new mod.exports.SSHManager({ host: 'test', username: 'test', password: 'fixture', autoReconnect: true });
  ssh.detectMaxSessions = async () => {};
  const tick = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
  return { ssh, clients, timers, tick, async start() {
    const p = ssh.connect(); clients.at(-1).emit('ready'); await p;
  }, async retry() {
    assert.equal(timers.size, 1, 'one recovery timer, no duplicate attempts');
    const [key, timer] = timers.entries().next().value; timers.delete(key);
    assert.ok(timer.ms <= 30000, 'backoff is bounded');
    const p = timer.fn(); await tick(); return { completion: p };
  } };
}

test('network error then close recovers and restores tunnel before reporting connected', async () => {
  const f = fixture(); await f.start();
  const tunnel = f.ssh.startReverseTunnel(18080, '127.0.0.1', 7890);
  f.clients[0].forwards[0].cb(null); await tunnel;
  f.clients[0].emit('error', new Error('read ECONNRESET'));
  f.clients[0].emit('close');
  const { completion } = await f.retry();
  const next = f.clients[1]; next.emit('ready'); await f.tick();
  assert.notEqual(f.ssh.status, 'connected', 'do not show ready while proxy is missing');
  assert.equal(next.forwards[0].host, '127.0.0.1');
  assert.equal(next.forwards[0].port, 18080);
  next.forwards[0].cb(null); await completion;
  assert.equal(f.ssh.status, 'connected');
  f.clients[0].emit('close');
  assert.equal(f.ssh.status, 'connected', 'late old close must not tear down new connection');
  f.ssh.disconnect(); assert.equal(f.timers.size, 0);
});

test('network can stay offline beyond five attempts and recover without manual action', async () => {
  const f = fixture(); await f.start(); f.clients[0].emit('close');
  for (let i = 0; i < 7; i++) {
    const { completion } = await f.retry();
    f.clients.at(-1).emit('error', new Error('connect ENETUNREACH'));
    f.clients.at(-1).emit('close'); await completion;
  }
  const { completion } = await f.retry(); f.clients.at(-1).emit('ready'); await completion;
  assert.equal(f.ssh.status, 'connected'); f.ssh.disconnect();
});

for (const message of ['All configured authentication methods failed', 'Host denied (verification failed)']) {
  test(`recovery stops on security failure: ${message}`, async () => {
    const f = fixture(); await f.start(); f.clients[0].emit('close');
    const { completion } = await f.retry();
    f.clients.at(-1).emit('error', new Error(message));
    f.clients.at(-1).emit('close'); await completion;
    assert.equal(f.timers.size, 0); assert.equal(f.ssh.status, 'error');
  });
}

test('manual disconnect during reconnect handshake cannot later revive the connection', async () => {
  const f = fixture(); await f.start(); f.clients[0].emit('close');
  const { completion } = await f.retry(); const next = f.clients.at(-1);
  f.ssh.disconnect(); next.emit('ready'); await completion;
  assert.equal(f.ssh.status, 'disconnected'); assert.equal(f.timers.size, 0);
});

test('failed tunnel restoration retries instead of falsely reporting connected', async () => {
  const f = fixture(); await f.start();
  const p = f.ssh.startReverseTunnel(18080, '127.0.0.1', 7890);
  f.clients[0].forwards[0].cb(null); await p; f.clients[0].emit('close');
  const { completion } = await f.retry(); f.clients[1].emit('ready'); await f.tick();
  f.clients[1].forwards[0].cb(new Error('forwarding failed')); await completion;
  assert.notEqual(f.ssh.status, 'connected'); assert.equal(f.timers.size, 1);
  f.ssh.disconnect();
});
