// ============================================================================
//  Test suite for lib/wsserver.js.        node tools/test-ws.js [name filter]
//
//  Self-contained: only node: built-ins are required. Three extras are used if
//  present and skipped otherwise: Node's global WebSocket client (Node >= 22),
//  the `ws` package (interop client, and reference server for the differential
//  fuzz test) and Playwright's Chromium (a real browser), both looked up under
//  /opt/npm-tools/node_modules.
//  Prints one PASS / FAIL / SKIP line per test and exits non-zero on failure.
//  Any uncaught exception or unhandled rejection during a test fails it.
//
//  Sections: 1 echo with the built-in client, 2 broadcast, 3 raw sockets with
//  hand-built frames, 4 handshake, 5 heartbeat, 6 load, 7 ws interop,
//  8 connection API, 9 robustness and fuzzing, 10 real browser.
//  Environment: WS_TEST_SEED=<n> replays a fuzz run, WS_FUZZ_CASES=<n> sets the
//  number of differential fuzz streams (default 500), WS_TEST_VERBOSE=1 prints
//  fuzz statistics.
// ============================================================================
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { attachWebSocket } from '../lib/wsserver.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0, TEXT: 1, BIN: 2, CLOSE: 8, PING: 9, PONG: 10 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

// ---- tiny test harness -----------------------------------------------------

const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, ...opts });
const stray = [];                         // exceptions nobody caught: always a failure
process.on('uncaughtException', (err) => stray.push(err));
process.on('unhandledRejection', (err) => stray.push(err));

class Skip extends Error {}

async function runAll() {
  const filter = process.argv[2];
  let passed = 0, failed = 0, skipped = 0;
  const t0 = Date.now();
  for (const { name, fn, timeout = 10000 } of tests) {
    if (filter && !name.includes(filter)) continue;
    const cleanups = [];
    const t = { defer: (f) => cleanups.push(f) };
    const started = Date.now();
    let error = null, timer;
    try {
      const body = Promise.resolve().then(() => fn(t));
      body.catch(() => {});               // if it fails after its timeout, do not blame the next test
      await Promise.race([
        body,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeout} ms`)), timeout); }),
      ]);
    } catch (err) { error = err; }
    clearTimeout(timer);
    for (const f of cleanups.reverse()) {
      try {                               // a cleanup that hangs (a socket that never closes) is a failure too
        await Promise.race([f(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('cleanup timed out: something was left open')), 8000); })]);
      } catch (err) { error = error || err; }
      clearTimeout(timer);
    }
    await tick();
    if (!error && stray.length) error = new Error('uncaught exception / unhandled rejection: ' + (stray[0] && stray[0].stack || stray[0]));
    stray.length = 0;
    const ms = `(${Date.now() - started} ms)`;
    if (error instanceof Skip) { skipped++; console.log(`SKIP  ${name} - ${error.message}`); }
    else if (error) { failed++; console.log(`FAIL  ${name} ${ms}\n      ${String(error.stack || error).replace(/\n/g, '\n      ')}`); }
    else { passed++; console.log(`PASS  ${name} ${ms}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  finished = true;
  process.exit(failed ? 1 : 0);
}
let finished = false;
process.on('exit', (code) => {            // e.g. the event loop ran dry in the middle of a test
  if (!finished) { console.log(`FAIL  test run aborted before the end (exit code ${code})`); process.exitCode = code || 1; }
});

/** Poll until cond() is truthy (returns its value) or fail with a readable message. */
async function waitFor(cond, what = 'condition', ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

// ---- server under test -----------------------------------------------------

/**
 * Start an http server with the module attached on an ephemeral port.
 * Default behaviour is an echo server. Every connection is recorded as
 * { conn, req, messages: [], closes: [[code, reason], ...], chunks: [sizes] }.
 */
async function startServer(t, opts = {}) {
  const records = [];
  const errors = [];                      // what opts.onError received
  const server = http.createServer((req, res) => {
    const body = 'plain http ok ' + req.url;
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  const { onConnection, echo = true, ...rest } = opts;
  const wss = attachWebSocket(server, {
    onError: (err, conn) => errors.push({ err, conn }),
    ...rest,
    onConnection(conn, req) {
      const rec = { conn, req, messages: [], closes: [], chunks: [] };
      records.push(rec);
      req.socket.on('data', (c) => rec.chunks.push(c.length));   // how TCP actually chunked the input
      conn.onmessage = (text) => { rec.messages.push(text); if (echo) conn.send(text); };
      conn.onclose = (code, reason) => rec.closes.push([code, reason]);
      if (onConnection) return onConnection(conn, req, rec);
    },
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  t.defer(async () => {
    wss.close();
    for (const r of records) r.conn.terminate();
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((res) => server.close(res));
  });
  return { server, wss, port, records, errors, url: `ws://127.0.0.1:${port}/ws` };
}

// ---- hand-built client frames ------------------------------------------------

/**
 * Build one client frame. Options:
 *   fin (true), rsv (0..7), mask (true: random key | false: unmasked | Buffer: this key),
 *   lenForm (7 | 16 | 64: force that length encoding), declaredLen (lie about the length).
 */
function frame(opcode, payload = '', { fin = true, rsv = 0, mask = true, lenForm, declaredLen } = {}) {
  const data = Buffer.isBuffer(payload) ? Buffer.from(payload) : Buffer.from(payload, 'utf8');
  const len = declaredLen ?? data.length;
  const form = lenForm ?? (len < 126 ? 7 : len < 65536 ? 16 : 64);
  const head = Buffer.alloc(form === 7 ? 2 : form === 16 ? 4 : 10);
  head[0] = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
  if (form === 7) head[1] = len;
  else if (form === 16) { head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  if (mask === false) return Buffer.concat([head, data]);
  head[1] |= 0x80;
  const key = Buffer.isBuffer(mask) ? mask : crypto.randomBytes(4);
  for (let i = 0; i < data.length; i++) data[i] ^= key[i & 3];
  return Buffer.concat([head, key, data]);
}

/** Close frame payload: 2-byte code + reason. */
const closeBody = (code, reason = '') => { const b = Buffer.alloc(2); b.writeUInt16BE(code); return Buffer.concat([b, Buffer.from(reason)]); };

// ---- raw TCP client ----------------------------------------------------------

/** A net.Socket plus a parser for the (unmasked) frames the server sends. */
class Raw {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frames = [];                     // parsed, not yet consumed
    this.waiters = [];
    this.closed = false;
    this.rawBytes = 0;                    // bytes received after the handshake
    this.whenClosed = new Promise((res) => socket.once('close', () => { this.closed = true; this._wake(); res(); }));
    socket.on('error', () => {});
  }
  feed(chunk) {
    this.rawBytes += chunk.length;
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) break; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b[1] & 0x80) off += 4;          // servers must not mask; recorded so tests can assert it
      if (b.length < off + len) break;
      this.frames.push({ fin: !!(b[0] & 0x80), rsv: (b[0] >> 4) & 7, opcode: b[0] & 0x0f, masked: !!(b[1] & 0x80), payload: b.subarray(off, off + len) });
      this.buf = b.subarray(off + len);
    }
    this._wake();
  }
  _wake() { for (const w of this.waiters.splice(0)) w(); }
  /** Next frame from the server; null if the socket closed first; throws on timeout. */
  async next(ms = 4000) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (this.frames.length) {
        const f = this.frames.shift();
        assert.equal(f.masked, false, 'server frames must not be masked');
        assert.equal(f.rsv, 0, 'server frames must not set RSV bits');
        return f;
      }
      if (this.closed) return null;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a frame from the server');
      let timer;
      await new Promise((res) => { this.waiters.push(res); timer = setTimeout(res, left); });
      clearTimeout(timer);
    }
  }
  /** Next frame, which must be a text frame; returns its text. */
  async text(ms) {
    const f = await this.next(ms);
    assert.ok(f, 'socket closed while waiting for a text frame');
    assert.equal(f.opcode, OP.TEXT, `expected a text frame, got opcode ${f.opcode}`);
    return f.payload.toString('utf8');
  }
  /** Next frame, which must be a close frame; returns { code, reason }. */
  async close(ms) {
    const f = await this.next(ms);
    assert.ok(f, 'socket closed without a close frame');
    assert.equal(f.opcode, OP.CLOSE, `expected a close frame, got opcode ${f.opcode}`);
    return { code: f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null, reason: f.payload.subarray(2).toString('utf8'), length: f.payload.length };
  }
  /** Expect close frame `code`, then the server hanging up (FIN) without any further frame. */
  async expectClose(code) {
    const c = await this.close();
    assert.equal(c.code, code, `close code (reason: ${c.reason})`);
    assert.equal(await this.next(), null, 'no frame may follow a close frame');
    return c;
  }
  write(data) { this.socket.write(data); }
}

/** Raw HTTP exchange: send `request` (string/Buffer), return everything received until the server closes. */
function httpRaw(port, request, ms = 4000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('server did not close the socket after its HTTP reply')); }, ms);
    socket.on('connect', () => socket.write(request));
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('latin1');
      const [head, ...rest] = text.split('\r\n\r\n');
      const lines = head.split('\r\n');
      const headers = {};
      for (const l of lines.slice(1)) { const i = l.indexOf(':'); headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
      resolve({ status: Number(lines[0].split(' ')[1]), statusLine: lines[0], headers, body: rest.join('\r\n\r\n'), text });
    });
  });
}

/** Text of an upgrade request. `headers` overrides/adds header lines; a null value removes one. */
function upgradeRequest(port, { path = '/ws', method = 'GET', headers = {}, key = crypto.randomBytes(16).toString('base64') } = {}) {
  const h = { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', ...headers };
  const lines = Object.entries(h).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`);
  return `${method} ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * Open a raw connection and perform the handshake. `extra` (Buffer) is written
 * in the same TCP write as the request, so it reaches the server as `head`.
 * `allowHalfOpen` makes a client that keeps its side open after the server's FIN.
 * Resolves to a Raw with .status / .headers of the 101 response.
 */
function rawConnect(t, port, { extra, allowHalfOpen = false, ...reqOpts } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen });   // half-open: never answers a FIN by itself
    socket.setNoDelay(true);
    t.defer(() => socket.destroy());
    const raw = new Raw(socket);
    let pending = Buffer.alloc(0), upgraded = false;
    const timer = setTimeout(() => reject(new Error('handshake timed out')), 4000);
    socket.on('connect', () => {
      const req = Buffer.from(upgradeRequest(port, { key, ...reqOpts }));
      socket.write(extra ? Buffer.concat([req, extra]) : req);
    });
    socket.on('data', (chunk) => {
      if (upgraded) return raw.feed(chunk);
      pending = Buffer.concat([pending, chunk]);
      const i = pending.indexOf('\r\n\r\n');
      if (i < 0) return;
      clearTimeout(timer);
      const lines = pending.subarray(0, i).toString('latin1').split('\r\n');
      raw.status = Number(lines[0].split(' ')[1]);
      raw.headers = {};
      for (const l of lines.slice(1)) { const j = l.indexOf(':'); raw.headers[l.slice(0, j).toLowerCase()] = l.slice(j + 1).trim(); }
      if (raw.status !== 101) return reject(new Error(`handshake rejected: ${lines[0]}`));
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (raw.headers['sec-websocket-accept'] !== accept) return reject(new Error('wrong Sec-WebSocket-Accept'));
      upgraded = true;
      resolve(raw);
      if (pending.length > i + 4) raw.feed(pending.subarray(i + 4));
    });
    socket.on('close', () => { clearTimeout(timer); reject(new Error('socket closed during the handshake')); });
  });
}

/** Wait until the server has recorded connection number `n` (0-based) and return its record. */
const serverRecord = (srv, n = 0) => waitFor(() => srv.records[n], `server-side connection #${n}`);

/** Assert that onclose fired exactly once with `code` (and stays at one call). */
async function expectOnClose(rec, code, reason) {
  await waitFor(() => rec.closes.length > 0, `onclose(${code})`);
  await sleep(60);                        // a second, wrong call would have arrived by now
  assert.equal(rec.closes.length, 1, `onclose must fire exactly once, calls: ${JSON.stringify(rec.closes)}`);
  assert.equal(rec.closes[0][0], code, 'onclose code');
  if (reason !== undefined) assert.equal(rec.closes[0][1], reason, 'onclose reason');
  assert.equal(rec.conn.isOpen, false);
  assert.equal(rec.conn.send('late'), false, 'send() after close must return false');
}

// ---- built-in WebSocket client (Node >= 22) -----------------------------------

const hasBuiltin = typeof globalThis.WebSocket === 'function';
const needBuiltin = () => { if (!hasBuiltin) throw new Skip('this Node has no global WebSocket client'); };

/** Open a built-in WebSocket; resolves to { ws, messages: [], closed: Promise<{code, reason, wasClean}> }. */
function wsOpen(t, url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const c = { ws, messages: [], closeEvent: null };
    c.closed = new Promise((res) => ws.addEventListener('close', (e) => {
      c.closeEvent = { code: e.code, reason: e.reason, wasClean: e.wasClean };
      res(c.closeEvent);
      reject(new Error(`client closed before opening (${e.code})`));
    }));
    ws.addEventListener('message', (e) => c.messages.push(e.data));
    ws.addEventListener('open', () => resolve(c));
    ws.addEventListener('error', () => {});
    t.defer(() => { try { ws.close(); } catch { /* already closed */ } });
  });
}

/** Deterministic, non-repeating-looking ASCII text of exactly n bytes. */
function makeText(n, seed = 1) {
  const out = Buffer.allocUnsafe(n);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = 32 + (x >>> 24) % 95; }
  return out.toString('latin1');
}

/** Compare two (possibly huge) strings without dumping them on failure. */
function same(actual, expected, label) {
  if (actual === expected) return;
  let i = 0;
  while (i < actual.length && actual[i] === expected[i]) i++;
  assert.fail(`${label}: strings differ at index ${i} (lengths ${actual.length} / ${expected.length})`);
}

/** Send each payload with the built-in client and expect the same payloads back, in order. */
async function echoBuiltin(t, payloads, serverOpts) {
  needBuiltin();
  const srv = await startServer(t, serverOpts);
  const c = await wsOpen(t, srv.url);
  for (const p of payloads) c.ws.send(p);
  await waitFor(() => c.messages.length >= payloads.length, `${payloads.length} echoes`, 8000);
  assert.equal(c.messages.length, payloads.length);
  payloads.forEach((p, i) => same(c.messages[i], p, `echo #${i}`));
  const rec = await serverRecord(srv);
  payloads.forEach((p, i) => same(rec.messages[i], p, `server onmessage #${i}`));
  c.ws.close(1000);
  const ev = await c.closed;
  assert.deepEqual(ev, { code: 1000, reason: '', wasClean: true });
  await expectOnClose(rec, 1000);
}

// ============================================================================
//  1. Echo round trips with Node's built-in WebSocket client
// ============================================================================

test('1.1 echo: tiny message', (t) => echoBuiltin(t, ['hi']));
test('1.2 echo: empty message and 1-byte message', (t) => echoBuiltin(t, ['', 'x', '']));
test('1.3 echo: 7-bit / 16-bit length boundary (125, 126, 127 bytes)', (t) => echoBuiltin(t, [makeText(125), makeText(126), makeText(127)]));
test('1.4 echo: 60 KB message (16-bit length path, both directions)', (t) => echoBuiltin(t, [makeText(60 * 1024)]));
test('1.5 echo: 16-bit / 64-bit length boundary (65535, 65536 bytes)', (t) => echoBuiltin(t, [makeText(65535, 2), makeText(65536, 3)]));
test('1.6 echo: 70 KB message (just past 65535, so 64-bit length path)', (t) => echoBuiltin(t, [makeText(70 * 1024, 4)]));
test('1.7 echo: ~200 KB message (64-bit length path)', (t) => echoBuiltin(t, [makeText(200 * 1024 + 17, 5)]));
test('1.8 echo: non-ASCII and emoji text', (t) => echoBuiltin(t, [
  'héllo wörld — ¡señor! ñandú',
  '日本語のテキスト 中文 한국어 العربية עברית',
  '😀👩‍👩‍👧‍👦🏳️‍🌈 chef 👨‍🍳 \u{1F9C1}\u{10FFFF}',
  'nul\u0000inside', 'line\r\nbreaks\tand "quotes" \\ {json:true}',   // (a leading BOM is covered by raw test 3.4)
  ('ü😀' + makeText(7)).repeat(9000),          // ~117 KB of mixed 1/2/4-byte characters
]));
test('1.9 echo: message of exactly maxPayload bytes is accepted, one byte more closes 1009', async (t) => {
  needBuiltin();
  const srv = await startServer(t, { maxPayload: 256 * 1024 });
  const c = await wsOpen(t, srv.url);
  const exact = makeText(256 * 1024, 6);
  c.ws.send(exact);
  await waitFor(() => c.messages.length === 1, 'echo of maxPayload bytes', 8000);
  same(c.messages[0], exact, 'echo');
  c.ws.send(exact + '!');
  const ev = await c.closed;
  assert.equal(ev.code, 1009);
  const rec = await serverRecord(srv);
  await expectOnClose(rec, 1009);
  assert.equal(rec.messages.length, 1, 'the oversize message must not be delivered');
});
test('1.10 echo: 300 small messages sent back to back keep their order', async (t) => {
  const list = Array.from({ length: 300 }, (_, i) => `m${i}:${makeText(i % 40, i)}`);
  await echoBuiltin(t, list);
});

// ============================================================================
//  2. Server-to-client broadcast
// ============================================================================

test('2.1 broadcast: 500 messages to 4 clients, in order, no loss', async (t) => {
  const srv = await startServer(t, { echo: false });
  const clients = hasBuiltin ? await Promise.all([1, 2, 3].map(() => wsOpen(t, srv.url))) : [];
  const raw = await rawConnect(t, srv.port);                 // also look at the frames on the wire
  await waitFor(() => srv.wss.clients.size === clients.length + 1, 'all connections to be open');
  const sent = [];
  for (let i = 0; i < 500; i++) {
    const msg = JSON.stringify({ seq: i, pad: makeText(i % 300, i) });
    sent.push(msg);
    for (const conn of srv.wss.clients) assert.equal(conn.send(msg), true);
  }
  for (const c of clients) {
    await waitFor(() => c.messages.length >= 500, '500 broadcast messages', 8000);
    assert.equal(c.messages.length, 500);
    sent.forEach((m, i) => same(c.messages[i], m, `client message #${i}`));
  }
  for (let i = 0; i < 500; i++) {
    const f = await raw.next();
    assert.ok(f && f.fin && f.opcode === OP.TEXT, 'every message is one unfragmented text frame');
    same(f.payload.toString(), sent[i], `raw frame #${i}`);
  }
  await sleep(50);
  for (const c of clients) assert.equal(c.messages.length, 500, 'no duplicates');
});

// ============================================================================
//  3. Raw-socket tests with hand-built frames
// ============================================================================

/** Raw client + its server-side record on a fresh echo server. */
async function rawPair(t, serverOpts, connectOpts) {
  const srv = await startServer(t, serverOpts);
  const raw = await rawConnect(t, srv.port, connectOpts);
  const rec = await serverRecord(srv);
  return { srv, raw, rec };
}

test('3.1 raw: a masked text frame delivered one byte at a time', async (t) => {
  const { raw, rec } = await rawPair(t);
  for (const text of ['tiny', 'sixteen-bit length ✓ ' + makeText(300), makeText(66000, 7)]) {
    const bytes = frame(OP.TEXT, text);
    if (bytes.length > 5000) {
      // 64-bit length form: dribble the 14 header bytes and a little payload, then send the rest in one go
      rec.chunks.length = 0;
      for (let i = 0; i < 40; i++) { raw.write(bytes.subarray(i, i + 1)); await tick(); await waitFor(() => rec.chunks.length === i + 1, `byte ${i} to arrive`); }
      raw.write(bytes.subarray(40));
    } else {
      rec.chunks.length = 0;
      for (let i = 0; i < bytes.length; i++) { raw.write(bytes.subarray(i, i + 1)); await tick(); await waitFor(() => rec.chunks.length === i + 1, `byte ${i} to arrive`); }
      assert.ok(rec.chunks.every((n) => n === 1), 'the server must have received single-byte chunks');
      assert.equal(rec.chunks.length, bytes.length);
    }
    same(await raw.text(), text, 'echo');
  }
  assert.equal(rec.messages.length, 3);
  assert.equal(rec.conn.isOpen, true);
});

test('3.2 raw: three frames in a single write', async (t) => {
  const { raw, rec } = await rawPair(t);
  const texts = ['first', 'second ✓', makeText(130)];
  rec.chunks.length = 0;
  raw.write(Buffer.concat(texts.map((x) => frame(OP.TEXT, x))));
  for (const x of texts) same(await raw.text(), x, 'echo');
  assert.deepEqual(rec.messages, texts);
  assert.equal(rec.chunks.length, 1, 'the three frames must have arrived as one TCP chunk');
});

test('3.3 raw: message in 3 fragments with a ping interleaved', async (t) => {
  const { raw, rec } = await rawPair(t);
  const parts = [
    frame(OP.TEXT, 'Hello, ', { fin: false }),
    frame(OP.PING, 'are you there?'),
    frame(OP.CONT, 'frag', { fin: false }),
    frame(OP.CONT, 'mented world!'),
  ];
  // (a) every frame in its own write
  for (const p of parts) { raw.write(p); await tick(); }
  let f = await raw.next();
  assert.equal(f.opcode, OP.PONG, 'the pong must come first: the ping was sent mid-message');
  assert.equal(f.payload.toString(), 'are you there?');
  assert.equal(await raw.text(), 'Hello, fragmented world!');
  // (b) all four frames in one write
  raw.write(Buffer.concat(parts));
  f = await raw.next();
  assert.equal(f.opcode, OP.PONG);
  assert.equal(f.payload.toString(), 'are you there?');
  assert.equal(await raw.text(), 'Hello, fragmented world!');
  // (c) a multi-byte character cut in half by the fragment boundary: '€' = E2 82 AC
  const euro = Buffer.from('price: 5 € only');
  const cut = euro.indexOf(0xe2) + 1;
  raw.write(Buffer.concat([frame(OP.TEXT, euro.subarray(0, cut), { fin: false }), frame(OP.PING, ''), frame(OP.CONT, euro.subarray(cut))]));
  f = await raw.next();
  assert.equal(f.opcode, OP.PONG);
  assert.equal(f.payload.length, 0);
  assert.equal(await raw.text(), 'price: 5 € only');
  // (d) empty fragments, and 300 one-byte fragments
  raw.write(Buffer.concat([frame(OP.TEXT, '', { fin: false }), frame(OP.CONT, '', { fin: false }), frame(OP.CONT, 'x'), frame(OP.TEXT, '', { fin: false }), frame(OP.CONT, '')]));
  assert.equal(await raw.text(), 'x');
  assert.equal(await raw.text(), '');
  const long = makeText(300, 9);
  raw.write(Buffer.concat([...long].map((ch, i) => frame(i === 0 ? OP.TEXT : OP.CONT, ch, { fin: i === 299 }))));
  same(await raw.text(), long, 'reassembled from 300 fragments');
  assert.deepEqual(rec.messages, ['Hello, fragmented world!', 'Hello, fragmented world!', 'price: 5 € only', 'x', '', long]);
});

test('3.4 raw: a frame stream cut at every possible offset; BOM and fixed mask keys survive', async (t) => {
  const { raw, rec } = await rawPair(t);
  const texts = ['﻿bom first', 'ünï©ödé 😀', makeText(140, 11), ''];
  const stream = Buffer.concat([
    frame(OP.TEXT, texts[0], { mask: Buffer.from([0, 0, 0, 0]) }),
    frame(OP.TEXT, texts[1], { mask: Buffer.from([0xff, 0xff, 0xff, 0xff]) }),
    frame(OP.TEXT, texts[2].slice(0, 50), { fin: false }),
    frame(OP.PING, 'k'),
    frame(OP.CONT, texts[2].slice(50), { lenForm: 64 }),          // non-minimal 64-bit length is tolerated
    frame(OP.TEXT, texts[3], { lenForm: 16 }),                    // non-minimal 16-bit length, empty payload
  ]);
  for (let cutAt = 1; cutAt < stream.length; cutAt++) {
    const before = rec.chunks.length;
    raw.write(stream.subarray(0, cutAt));
    await tick();
    await waitFor(() => rec.chunks.length > before, 'first part to arrive');
    raw.write(stream.subarray(cutAt));
    const got = [];
    while (got.length < 5) {
      const f = await raw.next();
      assert.ok(f, `socket closed (cut at ${cutAt})`);
      got.push(f.opcode === OP.PONG ? 'PONG:' + f.payload : f.payload.toString());
    }
    // the pong may overtake nothing: it answers a ping that sits between the fragments of message 3
    assert.deepEqual(got, [texts[0], texts[1], 'PONG:k', texts[2], texts[3]], `cut at ${cutAt}`);
  }
  assert.equal(rec.messages.length, 4 * (stream.length - 1));
  assert.equal(rec.messages[0].charCodeAt(0), 0xfeff, 'a leading BOM must reach onmessage');
});

/** Send `bytes` on a fresh connection and expect the server to close it with `code`, firing onclose once. */
async function expectProtocolClose(t, srv, bytes, code, label, echoesFirst = 0) {
  const raw = await rawConnect(t, srv.port);
  const rec = await waitFor(() => srv.records.find((r) => r.req.socket.remotePort === raw.socket.localPort), 'server-side record');
  raw.write(bytes);
  try {
    for (let i = 0; i < echoesFirst; i++) await raw.text();      // echoes of the valid frames sent before the bad one
    await raw.expectClose(code);
    await raw.whenClosed;                 // the server must hang up by itself (the client never answered)
    await expectOnClose(rec, code);
  } catch (err) { err.message = `[${label}] ${err.message}`; throw err; }
  return rec;
}

test('3.5 raw: unmasked client frame -> close 1002', async (t) => {
  const srv = await startServer(t);
  for (const [label, bytes] of [
    ['unmasked text', frame(OP.TEXT, 'not masked', { mask: false })],
    ['unmasked empty text', frame(OP.TEXT, '', { mask: false })],
    ['unmasked ping', frame(OP.PING, 'x', { mask: false })],
    ['unmasked close', frame(OP.CLOSE, closeBody(1000), { mask: false })],
    ['valid frame, then unmasked one', Buffer.concat([frame(OP.TEXT, 'ok'), frame(OP.TEXT, 'bad', { mask: false })])],
  ]) {
    const valid = label.startsWith('valid') ? ['ok'] : [];
    const rec = await expectProtocolClose(t, srv, bytes, 1002, label, valid.length);
    assert.deepEqual(rec.messages, valid, `[${label}] the bad frame must not be delivered`);
  }
  // After such an error the rest of the input is thrown away unparsed (white-box: count the parser's steps).
  const raw = await rawConnect(t, srv.port, { allowHalfOpen: true });
  const rec = srv.records[srv.records.length - 1];
  let steps = 0;
  for (const method of ['_checkHeader', '_beginPayload', '_endFrame']) {
    const real = rec.conn[method];
    assert.equal(typeof real, 'function', `this check needs updating: the parser has no ${method} any more`);
    rec.conn[method] = function (...args) { steps++; return real.apply(this, args); };
  }
  raw.write(frame(OP.TEXT, 'bad', { mask: false }));
  assert.equal((await raw.close()).code, 1002);
  assert.equal(steps, 1, 'the bad header was looked at once');
  raw.write(Buffer.concat([frame(OP.TEXT, 'ignored'), frame(OP.PING, 'ignored'), frame(OP.TEXT, makeText(3000))]));
  await sleep(50);
  assert.equal(steps, 1, 'input after a protocol error must not be parsed any more');
  assert.deepEqual(rec.messages, []);
});

test('3.6 raw: RSV bit set -> close 1002', async (t) => {
  const srv = await startServer(t);
  for (const rsv of [4, 2, 1, 7]) {       // RSV1 (what permessage-deflate would use), RSV2, RSV3, all
    const rec = await expectProtocolClose(t, srv, frame(OP.TEXT, 'compressed?', { rsv }), 1002, `rsv=${rsv}`);
    assert.deepEqual(rec.messages, []);
  }
  await expectProtocolClose(t, srv, frame(OP.PING, '', { rsv: 4 }), 1002, 'RSV1 on a ping');
});

test('3.7 raw: oversize declared length -> close 1009 before any payload is buffered', async (t) => {
  const srv = await startServer(t);        // default maxPayload: 256 KiB
  // Only the 14 header bytes are ever sent; the verdict must come from the declared length alone.
  for (const [label, declaredLen] of [
    ['maxPayload + 1', 256 * 1024 + 1], ['1 GiB', 2 ** 30], ['2^53', 2 ** 53],
    ['2^63 - 1', 0x7fffffffffffffffn], ['2^64 - 1 (illegal high bit)', 0xffffffffffffffffn],
  ]) {
    const header = frame(OP.TEXT, '', { declaredLen, lenForm: 64 });
    assert.equal(header.length, 14);
    const before = process.memoryUsage().arrayBuffers;
    const rec = await expectProtocolClose(t, srv, header, 1009, label);
    assert.deepEqual(rec.messages, []);
    assert.ok(process.memoryUsage().arrayBuffers - before < 64 * 1024 * 1024, 'no giant allocation');
  }
  // 16-bit length form against a small limit; exactly at the limit is fine
  const small = await startServer(t, { maxPayload: 1000 });
  await expectProtocolClose(t, small, frame(OP.TEXT, '', { declaredLen: 1001, lenForm: 16 }), 1009, '1001 > 1000');
  const ok = await rawConnect(t, small.port);
  ok.write(frame(OP.TEXT, makeText(1000)));
  same(await ok.text(), makeText(1000), 'exactly maxPayload');
  // the limit applies to the reassembled message: 600 + 401 bytes in two fragments
  await expectProtocolClose(t, small, Buffer.concat([
    frame(OP.TEXT, makeText(600), { fin: false }),
    frame(OP.CONT, '', { declaredLen: 401, lenForm: 16 }),         // header only
  ]), 1009, 'fragments adding up to 1001');
  // a client that keeps streaming its oversize payload anyway is cut off without trouble
  const rude = await rawConnect(t, small.port);
  rude.write(frame(OP.TEXT, makeText(300000)));
  await rude.expectClose(1009);
  await rude.whenClosed;
});

test('3.8 raw: invalid UTF-8 in a text message -> close 1007', async (t) => {
  const srv = await startServer(t);
  for (const [label, bytes] of [
    ['stray continuation byte', frame(OP.TEXT, Buffer.from([0x68, 0x80, 0x69]))],
    ['0xff', frame(OP.TEXT, Buffer.from([0xff]))],
    ['overlong encoding', frame(OP.TEXT, Buffer.from([0xc0, 0xaf]))],
    ['UTF-16 surrogate', frame(OP.TEXT, Buffer.from([0xed, 0xa0, 0x80]))],
    ['beyond U+10FFFF', frame(OP.TEXT, Buffer.from([0xf4, 0x90, 0x80, 0x80]))],
    ['truncated sequence at the end', frame(OP.TEXT, Buffer.from([0x61, 0xe2, 0x82]))],
    ['invalid across fragments', Buffer.concat([frame(OP.TEXT, Buffer.from([0x61, 0xe2]), { fin: false }), frame(OP.CONT, Buffer.from([0x28, 0x62]))])],
    ['invalid in a big message', frame(OP.TEXT, Buffer.concat([Buffer.from(makeText(100000)), Buffer.from([0xc3])]))],
  ]) {
    const rec = await expectProtocolClose(t, srv, bytes, 1007, label);
    assert.deepEqual(rec.messages, [], `[${label}] invalid text must not be delivered`);
  }
});

test('3.9 raw: binary frame -> close 1003', async (t) => {
  const srv = await startServer(t);
  await expectProtocolClose(t, srv, frame(OP.BIN, Buffer.from([1, 2, 3])), 1003, 'binary');
  await expectProtocolClose(t, srv, frame(OP.BIN, '', { fin: false }), 1003, 'first fragment of a binary message');
  await expectProtocolClose(t, srv, frame(OP.BIN, '', { declaredLen: 2 ** 40, lenForm: 64 }), 1003, 'huge binary, header only');
});

test('3.10 raw: client ping -> pong with the same payload', async (t) => {
  const { raw, rec } = await rawPair(t);
  for (const payload of [Buffer.alloc(0), Buffer.from('hello'), crypto.randomBytes(125), Buffer.from([0xff, 0xfe, 0x00])]) {
    raw.write(frame(OP.PING, payload));
    const f = await raw.next();
    assert.equal(f.opcode, OP.PONG);
    assert.equal(f.fin, true);
    assert.ok(f.payload.equals(payload), 'pong payload must equal ping payload');
  }
  // an unsolicited pong is legal and ignored
  raw.write(Buffer.concat([frame(OP.PONG, 'nobody asked'), frame(OP.TEXT, 'still here')]));
  assert.equal(await raw.text(), 'still here');
  assert.equal(rec.conn.isOpen, true);
  assert.deepEqual(rec.messages, ['still here'], 'pings and pongs are not messages');
});

test('3.11 raw: client close frame -> echoed close, onclose(code) fired once', async (t) => {
  const srv = await startServer(t);
  for (const [label, body, code, reason] of [
    ['1000 + reason', closeBody(1000, 'bye bye ✓'), 1000, 'bye bye ✓'],
    ['1001 no reason', closeBody(1001), 1001, ''],
    ['application code 4321', closeBody(4321, 'game over'), 4321, 'game over'],
    ['3000', closeBody(3000), 3000, ''],
    ['1012 (registered later)', closeBody(1012), 1012, ''],
    ['empty close frame', Buffer.alloc(0), 1005, ''],
    ['longest reason', closeBody(1000, 'r'.repeat(123)), 1000, 'r'.repeat(123)],
  ]) {
    const raw = await rawConnect(t, srv.port);
    const rec = srv.records[srv.records.length - 1];
    assert.equal(srv.wss.clients.has(rec.conn), true);
    // a text frame after the close frame, in the same write, must be ignored
    raw.write(Buffer.concat([frame(OP.CLOSE, body), frame(OP.TEXT, 'too late')]));
    const f = await raw.next();
    assert.ok(f && f.opcode === OP.CLOSE, `[${label}] expected the close frame to be echoed`);
    assert.ok(f.payload.equals(body), `[${label}] the echo must carry the same code and reason`);
    assert.equal(await raw.next(), null, `[${label}] nothing may follow the close frame; the server must send FIN`);
    assert.equal(raw.closed, true);
    await expectOnClose(rec, code, reason);
    assert.deepEqual(rec.messages, [], `[${label}] data after a close frame must be ignored`);
    assert.equal(srv.wss.clients.has(rec.conn), false);
  }
});

test('3.12 raw: abrupt socket destroy -> onclose(1006) fired once', async (t) => {
  const srv = await startServer(t);
  const cases = {
    'destroy()': (s) => s.destroy(),
    'resetAndDestroy() (TCP RST)': (s) => (s.resetAndDestroy ? s.resetAndDestroy() : s.destroy()),
    'FIN without a close frame (half-close)': (s) => s.end(),
    'destroy in the middle of a frame': (s) => { s.write(frame(OP.TEXT, makeText(500)).subarray(0, 100)); s.destroy(); },
    'destroy in the middle of a fragmented message': (s) => { s.write(frame(OP.TEXT, 'part one', { fin: false })); s.destroy(); },
    'FIN in the middle of a header': (s) => s.end(frame(OP.TEXT, makeText(500)).subarray(0, 3)),
  };
  for (const [label, kill] of Object.entries(cases)) {
    const raw = await rawConnect(t, srv.port);
    const rec = srv.records[srv.records.length - 1];
    raw.write(frame(OP.TEXT, 'alive'));
    assert.equal(await raw.text(), 'alive');
    kill(raw.socket);
    try {
      await expectOnClose(rec, 1006, '');
      await raw.whenClosed;               // also proves the server answered a half-close by closing its side
    } catch (err) { err.message = `[${label}] ${err.message}`; throw err; }
    assert.deepEqual(rec.messages, ['alive'], `[${label}] no partial message may be delivered`);
    assert.equal(srv.wss.clients.size, 0);
  }
});

test('3.13 raw: other protocol violations -> close 1002 / 1007', async (t) => {
  const srv = await startServer(t);
  const cases = [
    ['continuation frame with nothing to continue', frame(OP.CONT, 'x'), 1002],
    ['new text frame while a fragmented message is open', Buffer.concat([frame(OP.TEXT, 'a', { fin: false }), frame(OP.TEXT, 'b')]), 1002],
    ['fragmented ping', frame(OP.PING, 'x', { fin: false }), 1002],
    ['fragmented close', frame(OP.CLOSE, closeBody(1000), { fin: false }), 1002],
    ['ping with a 126-byte payload', frame(OP.PING, makeText(126)), 1002],
    ['pong with a 64-bit length', frame(OP.PONG, '', { declaredLen: 70000, lenForm: 64 }), 1002],
    ['close frame with a 1-byte payload', frame(OP.CLOSE, Buffer.from([0x03])), 1002],
    ['close frame with invalid UTF-8 reason', frame(OP.CLOSE, Buffer.concat([closeBody(1000), Buffer.from([0xff])])), 1007],
    ...[3, 4, 5, 6, 7, 11, 12, 13, 14, 15].map((op) => [`reserved opcode ${op}`, frame(op, 'x'), 1002]),
    ...[0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000, 65535].map((c) => [`close frame with illegal code ${c}`, frame(OP.CLOSE, closeBody(c)), 1002]),
  ];
  for (const [label, bytes, code] of cases) {
    const rec = await expectProtocolClose(t, srv, bytes, code, label);
    assert.deepEqual(rec.messages, [], `[${label}] nothing may be delivered`);
  }
});

test('3.14 raw: frames sent in the same TCP write as the handshake (the `head` buffer)', async (t) => {
  const srv = await startServer(t);
  // (a) two complete frames right behind the request
  const a = await rawConnect(t, srv.port, { extra: Buffer.concat([frame(OP.TEXT, 'early bird'), frame(OP.TEXT, 'second')]) });
  assert.equal(await a.text(), 'early bird');
  assert.equal(await a.text(), 'second');
  assert.deepEqual(srv.records[0].chunks, [], 'both frames must have arrived as `head`, not as later data events');
  // (b) head ends in the middle of a frame; the rest follows later
  const bytes = frame(OP.TEXT, 'split between head and first data chunk');
  const b = await rawConnect(t, srv.port, { extra: bytes.subarray(0, 9) });
  await sleep(20);
  assert.deepEqual(srv.records[1].messages, []);
  b.write(bytes.subarray(9));
  assert.equal(await b.text(), 'split between head and first data chunk');
  // (c) garbage in head is a protocol error like any other
  const c = await rawConnect(t, srv.port, { extra: Buffer.from('GET / HTTP/1.1\r\n\r\n') });
  await c.expectClose(1002);
});

// ============================================================================
//  4. Handshake
// ============================================================================

/** Send an upgrade request that must be refused with `status`; the server must close the socket. */
async function expectRejected(srv, reqOpts, status, label) {
  const res = await httpRaw(srv.port, upgradeRequest(srv.port, reqOpts));
  assert.equal(res.status, status, `[${label}] status line was: ${res.statusLine}`);
  assert.match(res.statusLine, /^HTTP\/1\.1 \d{3} \S/, `[${label}] proper status line`);
  assert.equal(res.headers.connection, 'close', `[${label}] Connection: close`);
  assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.body), `[${label}] Content-Length matches the body`);
  assert.equal(res.headers['sec-websocket-accept'], undefined, `[${label}] no accept key on a refusal`);
  return res;
}

test('4.1 handshake: wrong path -> 404 and the socket is closed', async (t) => {
  const srv = await startServer(t);
  for (const path of ['/', '/other', '/ws/', '/wsx', '/WS', '/ws/extra', '//ws', '/?/ws', '/other?x=/ws']) {
    await expectRejected(srv, { path }, 404, `path ${path}`);
  }
  const custom = await startServer(t, { path: '/game/socket' });
  await expectRejected(custom, { path: '/ws' }, 404, 'default path on a server with a custom path');
  const raw = await rawConnect(t, custom.port, { path: '/game/socket?room=7' });
  raw.write(frame(OP.TEXT, 'custom path'));
  assert.equal(await raw.text(), 'custom path');
  assert.equal(srv.records.length, 0, 'onConnection must not run for refused requests');
});

test('4.2 handshake: missing or malformed Sec-WebSocket-Key -> 400', async (t) => {
  const srv = await startServer(t);
  const cases = { missing: null, empty: '', 'too short': 'abc=', 'not base64': '!!!!!!!!!!!!!!!!!!!!!!==', '24 bytes of key': crypto.randomBytes(24).toString('base64') };
  for (const [label, key] of Object.entries(cases)) {
    await expectRejected(srv, { headers: { 'Sec-WebSocket-Key': key } }, 400, `key ${label}`);
  }
  assert.equal(srv.records.length, 0);
});

test('4.3 handshake: wrong Sec-WebSocket-Version -> 426 with Sec-WebSocket-Version: 13', async (t) => {
  const srv = await startServer(t);
  for (const version of ['8', '12', '14', '0', 'banana', null]) {
    const res = await expectRejected(srv, { headers: { 'Sec-WebSocket-Version': version } }, 426, `version ${version}`);
    assert.equal(res.headers['sec-websocket-version'], '13');
    assert.match(res.headers.upgrade || '', /websocket/i, 'a 426 must name the protocol to upgrade to');
  }
  assert.equal(srv.records.length, 0);
});

test('4.4 handshake: plain GET without upgrade is left to the normal http handler', async (t) => {
  const srv = await startServer(t);
  const get = (path, headers = {}) => httpRaw(srv.port, `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
  for (const path of ['/', '/ws', '/ws?x=1', '/index.html']) {
    const res = await get(path);
    assert.equal(res.status, 200, `GET ${path}`);
    assert.equal(res.body, 'plain http ok ' + path);
  }
  // WebSocket-looking headers without "Connection: Upgrade" are no upgrade request either
  const res = await get('/ws', { Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' });
  assert.equal(res.status, 200);
  assert.equal(res.body, 'plain http ok /ws');
  // a keep-alive socket may serve a normal request first and upgrade afterwards;
  // the http server's own idle timeouts must not apply to it any more
  srv.server.timeout = 150;
  srv.server.keepAliveTimeout = 100;
  const socket = net.connect(srv.port, '127.0.0.1');
  t.defer(() => socket.destroy());
  let buf = Buffer.alloc(0);
  const raw = new Raw(socket);
  let upgraded = false;
  socket.on('data', (c) => { if (upgraded) raw.feed(c); else buf = Buffer.concat([buf, c]); });
  socket.write('GET /first HTTP/1.1\r\nHost: x\r\n\r\n');
  await waitFor(() => buf.includes('plain http ok /first'), 'the plain response');
  buf = Buffer.alloc(0);
  socket.write(upgradeRequest(srv.port));
  await waitFor(() => buf.includes('\r\n\r\n'), 'the 101 response');
  assert.match(buf.toString('latin1'), /^HTTP\/1\.1 101 /);
  upgraded = true;
  raw.write(frame(OP.TEXT, 'upgraded after a normal request'));
  assert.equal(await raw.text(), 'upgraded after a normal request');
  assert.equal(srv.records.length, 1);
  await sleep(500);
  raw.write(frame(OP.TEXT, 'still connected after the http timeouts'));
  assert.equal(await raw.text(), 'still connected after the http timeouts');
  assert.deepEqual(srv.records[0].closes, []);
});

test('4.5 handshake: "Connection: keep-alive, Upgrade" and other valid spellings succeed', async (t) => {
  const srv = await startServer(t);
  const variants = [
    { headers: { Connection: 'keep-alive, Upgrade' } },           // what Firefox sends
    { headers: { Connection: 'Upgrade, keep-alive' } },
    { headers: { Connection: 'keep-alive,upgrade' } },
    { headers: { Connection: 'UPGRADE', Upgrade: 'WebSocket' } },
    { headers: { Upgrade: 'WEBSOCKET' } },
    { path: '/ws?token=abc&next=/other' },                        // the query string is ignored
    { path: '/ws?' },
    { headers: { Origin: 'https://example.com', 'User-Agent': 'test', Cookie: 'a=b' } },
  ];
  for (const [i, v] of variants.entries()) {
    const raw = await rawConnect(t, srv.port, v);
    assert.equal(raw.status, 101);
    assert.match(raw.headers.upgrade, /^websocket$/i);
    assert.match(raw.headers.connection, /^upgrade$/i);
    raw.write(frame(OP.TEXT, `variant ${i}`));
    assert.equal(await raw.text(), `variant ${i}`, JSON.stringify(v));
  }
  assert.equal(srv.records.length, variants.length);
});

test('4.6 handshake: other bad upgrade requests -> 400', async (t) => {
  const srv = await startServer(t);
  await expectRejected(srv, { headers: { Upgrade: 'h2c' } }, 400, 'Upgrade: h2c');
  await expectRejected(srv, { headers: { Upgrade: 'websocket2' } }, 400, 'Upgrade: websocket2');
  await expectRejected(srv, { method: 'POST', headers: { 'Content-Length': '0' } }, 400, 'POST');
  await expectRejected(srv, { method: 'PUT', headers: { 'Content-Length': '0' } }, 400, 'PUT');
  assert.equal(srv.records.length, 0);
  // the server destroys a refused socket by itself, even if the client never closes its side
  const serverSockets = [];
  srv.server.on('connection', (s) => serverSockets.push(s));
  const socket = net.connect({ port: srv.port, host: '127.0.0.1', allowHalfOpen: true });
  t.defer(() => socket.destroy());
  socket.on('error', () => {});
  let got = '';
  socket.on('data', (c) => { got += c; });
  socket.write(upgradeRequest(srv.port, { path: '/nope' }));
  await waitFor(() => serverSockets.length === 1 && serverSockets[0].destroyed, 'the refused socket to be destroyed server-side at once', 1000);
  assert.match(got, /^HTTP\/1\.1 404 Not Found\r\n/);
});

test('4.7 handshake: no extension and no subprotocol is negotiated', async (t) => {
  const srv = await startServer(t);
  const raw = await rawConnect(t, srv.port, { headers: {
    'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
    'Sec-WebSocket-Protocol': 'chat, superchat',
  } });
  assert.equal(raw.headers['sec-websocket-extensions'], undefined);
  assert.equal(raw.headers['sec-websocket-protocol'], undefined);
  assert.deepEqual(Object.keys(raw.headers).sort(), ['connection', 'sec-websocket-accept', 'upgrade']);
  raw.write(frame(OP.TEXT, 'plain frames'));
  assert.equal(await raw.text(), 'plain frames');
});

test('4.8 handshake: remoteAddress, X-Forwarded-For, the req passed to onConnection, TCP_NODELAY', async (t) => {
  const noDelayCalls = [];
  const realSetNoDelay = net.Socket.prototype.setNoDelay;
  net.Socket.prototype.setNoDelay = function (...args) { noDelayCalls.push([this, ...args]); return realSetNoDelay.apply(this, args); };
  t.defer(() => { net.Socket.prototype.setNoDelay = realSetNoDelay; });
  const srv = await startServer(t);
  const cases = [
    [{}, /^(::ffff:)?127\.0\.0\.1$/],
    [{ 'X-Forwarded-For': '203.0.113.7' }, /^203\.0\.113\.7$/],
    [{ 'X-Forwarded-For': '203.0.113.7, 10.0.0.1, 192.168.1.1' }, /^203\.0\.113\.7$/],
    [{ 'X-Forwarded-For': '  2001:db8::1 ,10.0.0.1' }, /^2001:db8::1$/],
    [{ 'X-Forwarded-For': '' }, /^(::ffff:)?127\.0\.0\.1$/],
    [{ 'X-Forwarded-For': ' , ' }, /^(::ffff:)?127\.0\.0\.1$/],
  ];
  for (const [i, [headers, expected]] of cases.entries()) {
    await rawConnect(t, srv.port, { headers, path: `/ws?case=${i}` });
    const rec = srv.records[i];
    assert.equal(typeof rec.conn.remoteAddress, 'string');
    assert.match(rec.conn.remoteAddress, expected, JSON.stringify(headers));
    assert.ok(rec.req instanceof http.IncomingMessage);
    assert.equal(rec.req.url, `/ws?case=${i}`);
    assert.equal(rec.req.headers['sec-websocket-version'], '13');
    assert.ok(noDelayCalls.some(([sock, on]) => sock === rec.req.socket && on === true), 'socket.setNoDelay(true) on the accepted socket');
  }
});

// ============================================================================
//  5. Heartbeat
// ============================================================================

/** Read frames until the server drops the connection; returns the opcodes seen. `onFrame` may react. */
async function drain(raw, onFrame = () => {}, ms = 3000) {
  const seen = [];
  for (;;) {
    const f = await raw.next(ms);
    if (!f) return seen;
    seen.push(f.opcode);
    onFrame(f);
  }
}

test('5.1 heartbeat: a client that never answers pings is terminated', async (t) => {
  const srv = await startServer(t, { pingInterval: 200 });
  const t0 = Date.now();
  // (a) completely silent, (b) keeps chatting and pinging but never pongs, (c) answers the first ping only
  const [silent, chatty, once] = await Promise.all([1, 2, 3].map(() => rawConnect(t, srv.port)));
  const chat = setInterval(() => chatty.write(Buffer.concat([frame(OP.TEXT, 'still talking'), frame(OP.PING, 'hello?')])), 40);
  t.defer(() => clearInterval(chat));
  let answered = false;
  const results = await Promise.all([
    drain(silent).then((seen) => ({ seen, ms: Date.now() - t0 })),
    drain(chatty).then((seen) => ({ seen, ms: Date.now() - t0 })),
    drain(once, (f) => { if (f.opcode === OP.PING && !answered) { answered = true; once.write(frame(OP.PONG, f.payload)); } }).then((seen) => ({ seen, ms: Date.now() - t0 })),
  ]);
  clearInterval(chat);
  // ticks at ~200 and ~400 ms: ping at the first, termination at the second (third for the one pong)
  assert.deepEqual(results[0].seen, [OP.PING], 'silent client: one ping, then dropped without a close frame');
  assert.ok(results[0].ms >= 300 && results[0].ms < 1200, `silent client dropped after ${results[0].ms} ms`);
  assert.equal(results[1].seen.filter((op) => op === OP.PING).length, 1, 'only a pong counts as an answer, not data or pings');
  assert.ok(results[1].seen.includes(OP.TEXT) && results[1].seen.includes(OP.PONG), 'the chatty client was being served until it was dropped');
  assert.ok(results[1].ms >= 300 && results[1].ms < 1200, `chatty client dropped after ${results[1].ms} ms`);
  assert.deepEqual(results[2].seen, [OP.PING, OP.PING], 'one answered ping buys exactly one more interval');
  assert.ok(results[2].ms >= 500 && results[2].ms < 1500, `client dropped after ${results[2].ms} ms`);
  for (const rec of srv.records) await expectOnClose(rec, 1006, '');
  assert.equal(srv.wss.clients.size, 0);
});

test('5.2 heartbeat: well-behaved clients stay connected across several intervals', async (t) => {
  const srv = await startServer(t, { pingInterval: 200 });
  const raw = await rawConnect(t, srv.port);
  const builtin = hasBuiltin ? await wsOpen(t, srv.url) : null;   // answers pings by itself
  let pings = 0;
  const texts = [];
  const reader = drain(raw, (f) => {
    if (f.opcode === OP.PING) { pings++; raw.write(frame(OP.PONG, f.payload)); }
    if (f.opcode === OP.TEXT) texts.push(f.payload.toString());
  }, 10000);
  await sleep(1500);                      // 7 intervals
  assert.ok(pings >= 6, `expected at least 6 pings in 1.5 s, saw ${pings}`);
  assert.equal(raw.closed, false, 'raw client that pongs must still be connected');
  raw.write(frame(OP.TEXT, 'raw still alive'));
  await waitFor(() => texts.includes('raw still alive'), 'echo to the raw client');
  if (builtin) {
    assert.equal(builtin.ws.readyState, WebSocket.OPEN, 'built-in client must still be connected');
    builtin.ws.send('builtin still alive');
    await waitFor(() => builtin.messages.includes('builtin still alive'), 'echo to the built-in client');
  }
  assert.equal(srv.wss.clients.size, builtin ? 2 : 1);
  for (const rec of srv.records) assert.deepEqual(rec.closes, []);
  raw.socket.destroy();
  await reader;
});

test('5.3 heartbeat: pingInterval 0 disables it; attachWebSocket works with no options at all', async (t) => {
  const srv = await startServer(t, { pingInterval: 0 });
  const raw = await rawConnect(t, srv.port);
  await sleep(300);
  assert.equal(raw.frames.length, 0, 'no ping expected');
  assert.equal(raw.closed, false);
  const server = http.createServer();
  const wss = attachWebSocket(server);    // all defaults: path /ws, no handlers
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.defer(() => { wss.close(); for (const c of wss.clients) c.terminate(); server.close(); });
  const plain = await rawConnect(t, server.address().port);
  plain.write(Buffer.concat([frame(OP.TEXT, 'nobody listens'), frame(OP.PING, 'p')]));
  assert.equal((await plain.next()).opcode, OP.PONG);
  assert.equal(wss.clients.size, 1);
  plain.write(frame(OP.CLOSE, closeBody(1000)));
  assert.equal((await plain.close()).code, 1000);
  await waitFor(() => wss.clients.size === 0, 'the connection to be unlisted');
});

// ============================================================================
//  6. Many clients at once
// ============================================================================

test('6.1 load: 100 concurrent built-in clients, 20 messages each', async (t) => {
  needBuiltin();
  const srv = await startServer(t);
  const clients = await Promise.all(Array.from({ length: 100 }, () => wsOpen(t, srv.url)));
  assert.equal(srv.wss.clients.size, 100);
  await Promise.all(clients.map(async (c, id) => {
    for (let i = 0; i < 20; i++) {        // strict request/response, all 100 clients interleaved
      const msg = `client ${id} message ${i} ${makeText((id * 7 + i * 13) % 200, id * 100 + i)}`;
      c.ws.send(msg);
      await waitFor(() => c.messages.length > i, `echo ${i} for client ${id}`, 8000);
      same(c.messages[i], msg, `client ${id} echo ${i}`);
    }
  }));
  for (const c of clients) assert.equal(c.messages.length, 20);
  for (const rec of srv.records) assert.equal(rec.messages.length, 20);
  for (const c of clients) c.ws.close(1000, 'done');
  for (const c of clients) assert.deepEqual(await c.closed, { code: 1000, reason: 'done', wasClean: true });
  await waitFor(() => srv.records.every((r) => r.closes.length === 1), 'all 100 onclose calls');
  await sleep(50);
  for (const rec of srv.records) assert.deepEqual(rec.closes, [[1000, 'done']]);
  assert.equal(srv.wss.clients.size, 0);
}, { timeout: 30000 });

test('6.2 load: 100 concurrent raw clients, 20 messages each, half of them vanish abruptly', async (t) => {
  const srv = await startServer(t);
  const raws = await Promise.all(Array.from({ length: 100 }, (_, id) => rawConnect(t, srv.port, { path: `/ws?id=${id}` })));
  await Promise.all(raws.map(async (raw, id) => {
    const msgs = Array.from({ length: 20 }, (_, i) => `raw ${id}/${i} ${makeText((id * 31 + i * 577) % 3000, id * 100 + i)}`);
    raw.write(Buffer.concat(msgs.slice(0, 10).map((m) => frame(OP.TEXT, m))));   // ten in one burst ...
    for (let i = 0; i < 10; i++) same(await raw.text(8000), msgs[i], `raw ${id} echo ${i}`);
    for (let i = 10; i < 20; i++) {                                                // ... ten one at a time
      raw.write(frame(OP.TEXT, msgs[i]));
      same(await raw.text(8000), msgs[i], `raw ${id} echo ${i}`);
    }
    if (id % 2) raw.socket.destroy();
    else { raw.write(frame(OP.CLOSE, closeBody(1000))); assert.equal((await raw.close()).code, 1000); }
  }));
  await waitFor(() => srv.records.length === 100 && srv.records.every((r) => r.closes.length === 1), 'all 100 onclose calls');
  await sleep(50);
  for (const rec of srv.records) {
    const id = Number(new URL(rec.req.url, 'http://x').searchParams.get('id'));
    assert.deepEqual(rec.closes, [[id % 2 ? 1006 : 1000, '']], `client ${id}`);
    assert.equal(rec.messages.length, 20);
    assert.ok(rec.messages.every((m) => m.startsWith(`raw ${id}/`)), 'no cross-talk between connections');
  }
  assert.equal(srv.wss.clients.size, 0);
}, { timeout: 30000 });

// ============================================================================
//  7. Interop with the `ws` package as a client (skipped if it is not installed)
// ============================================================================

const WS_LIB_PATH = '/opt/npm-tools/node_modules/ws';
let WsLib = null;
try { WsLib = createRequire(import.meta.url)(WS_LIB_PATH); } catch { /* not installed: section 7 is skipped */ }
const needWsLib = () => { if (!WsLib) throw new Skip(`the ws package is not installed at ${WS_LIB_PATH}`); };

/** Open a `ws` client; resolves to { ws, messages: [], pongs: [], pings: n, closed: Promise<{code, reason}> }. */
function wsLibOpen(t, url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WsLib(url, options);
    const c = { ws, messages: [], pongs: [], pings: 0, errors: [] };
    c.closed = new Promise((res) => ws.on('close', (code, reason) => { res({ code, reason: reason.toString() }); reject(new Error(`ws client closed before opening (${code})`)); }));
    ws.on('message', (data, isBinary) => c.messages.push(isBinary ? data : data.toString()));
    ws.on('pong', (data) => c.pongs.push(data.toString()));
    ws.on('ping', () => c.pings++);
    ws.on('error', (err) => c.errors.push(err));
    ws.on('open', () => resolve(c));
    t.defer(() => ws.terminate());
  });
}

test('7.1 ws interop: echo (small, unicode, BOM, 16-bit and 64-bit lengths)', async (t) => {
  needWsLib();
  const srv = await startServer(t);
  const c = await wsLibOpen(t, srv.url);
  assert.equal(c.ws.extensions, '', 'no extension may be negotiated even though ws offers permessage-deflate');
  assert.equal(c.ws.protocol, '');
  const payloads = ['hello from ws', '', 'ünïcödé 😀 日本語', '﻿bom', makeText(126), makeText(60000, 2), makeText(65536, 3), makeText(200 * 1024, 4)];
  for (const p of payloads) c.ws.send(p);
  await waitFor(() => c.messages.length >= payloads.length, 'echoes', 8000);
  payloads.forEach((p, i) => same(c.messages[i], p, `echo #${i}`));
  assert.deepEqual(c.errors, []);
});

test('7.2 ws interop: fragmented send (fin: false ... fin: true)', async (t) => {
  needWsLib();
  const srv = await startServer(t);
  const c = await wsLibOpen(t, srv.url);
  c.ws.send('Hello', { fin: false });
  c.ws.send(', fragmented ', { fin: false });
  c.ws.ping('between fragments');         // control frames may be interleaved
  c.ws.send('wörld', { fin: true });
  const big = makeText(150000, 5);
  for (let i = 0; i < 15; i++) c.ws.send(big.slice(i * 10000, (i + 1) * 10000), { fin: i === 14 });
  await waitFor(() => c.messages.length >= 2, 'reassembled echoes');
  assert.equal(c.messages[0], 'Hello, fragmented wörld');
  same(c.messages[1], big, '15 fragments of 10 KB');
  assert.deepEqual(c.pongs, ['between fragments']);
  assert.deepEqual((await serverRecord(srv)).messages.map((m) => m.length), [23, 150000], 'the server saw two whole messages');
});

test('7.3 ws interop: ws.ping() gets a pong; ws answers the server heartbeat', async (t) => {
  needWsLib();
  const srv = await startServer(t, { pingInterval: 150 });
  const c = await wsLibOpen(t, srv.url);
  c.ws.ping();
  c.ws.ping('payload ✓');
  c.ws.ping(Buffer.alloc(125, 0x41));
  await waitFor(() => c.pongs.length === 3, 'three pongs');
  assert.deepEqual(c.pongs, ['', 'payload ✓', 'A'.repeat(125)]);
  await sleep(800);                       // five heartbeat intervals
  assert.ok(c.pings >= 4, `ws saw ${c.pings} heartbeat pings`);
  assert.equal(c.ws.readyState, WsLib.OPEN, 'still connected after several heartbeats');
  c.ws.send('alive');
  await waitFor(() => c.messages.includes('alive'), 'echo after heartbeats');
});

test('7.4 ws interop: clean ws.close(1000)', async (t) => {
  needWsLib();
  const srv = await startServer(t);
  for (const [args, code, reason] of [[[1000], 1000, ''], [[1000, 'see you'], 1000, 'see you'], [[4004, 'app code'], 4004, 'app code'], [[], 1005, '']]) {
    const c = await wsLibOpen(t, srv.url);
    const rec = srv.records[srv.records.length - 1];
    c.ws.send('before close');
    await waitFor(() => c.messages.length === 1, 'echo');
    c.ws.close(...args);
    assert.deepEqual(await c.closed, { code, reason }, 'close event seen by ws');
    await expectOnClose(rec, code, reason);
    assert.deepEqual(c.errors, [], 'ws must not report any protocol error');
  }
});

test('7.5 ws interop: server-initiated close, wss.close(), and a binary frame from ws', async (t) => {
  needWsLib();
  const srv = await startServer(t);
  const a = await wsLibOpen(t, srv.url);
  srv.records[0].conn.close(4001, 'kicked ✓');
  assert.deepEqual(await a.closed, { code: 4001, reason: 'kicked ✓' });
  await expectOnClose(srv.records[0], 4001, 'kicked ✓');
  const b = await wsLibOpen(t, srv.url);
  b.ws.send(Buffer.from([1, 2, 3]));      // binary: the game protocol is text only
  assert.equal((await b.closed).code, 1003);
  await expectOnClose(srv.records[1], 1003);
  const rest = await Promise.all([1, 2, 3].map(() => wsLibOpen(t, srv.url)));
  srv.wss.close();
  for (const c of rest) assert.equal((await c.closed).code, 1001);
  for (const rec of srv.records.slice(2)) await expectOnClose(rec, 1001);
  for (const c of [a, b, ...rest]) assert.deepEqual(c.errors, []);
});

// ============================================================================
//  8. Connection API
// ============================================================================

test('8.1 api: send() returns true while open, false afterwards, and never throws', async (t) => {
  const { srv, raw, rec } = await rawPair(t, { echo: false });
  const conn = rec.conn;
  assert.equal(conn.isOpen, true);
  assert.equal(srv.wss.clients.has(conn), true);
  assert.equal(conn.send('text'), true);
  assert.equal(await raw.text(), 'text');
  assert.equal(conn.send(''), true);
  assert.equal(await raw.text(), '');
  const odd = [123, true, null, undefined, { a: 1 }, ['x', 'y'], 12n, Symbol('s')];   // stringified, not thrown
  for (const v of odd) assert.equal(conn.send(v), true);
  for (const v of odd) assert.equal(await raw.text(), String(v));
  assert.equal(conn.send(Object.create(null)), false, 'a value that cannot be stringified is refused, not thrown');
  assert.equal(conn.send('a\ud800b'), true);       // lone surrogate: must still be valid UTF-8 on the wire
  assert.deepEqual([...(await raw.next()).payload], [0x61, 0xef, 0xbf, 0xbd, 0x62]);
  conn.close();
  assert.equal(conn.isOpen, false);
  assert.equal(conn.send('after close()'), false);
  assert.equal((await raw.close()).code, 1000);
  raw.socket.destroy();
  await expectOnClose(rec, 1000);
  for (let i = 0; i < 1000; i++) assert.equal(conn.send('x'), false);
  // a socket destroyed underneath us (e.g. by a write error): not open at once, even before onclose has fired
  const dead = await rawConnect(t, srv.port);
  const rec3 = srv.records[1];
  assert.equal(await (rec3.conn.send('hello'), dead.text()), 'hello');
  rec3.req.socket.destroy();
  assert.deepEqual([rec3.conn.isOpen, rec3.conn.send('x'), rec3.closes.length], [false, false, 0]);
  await expectOnClose(rec3, 1006);
  // sending into a connection whose peer just vanished must not throw either (false or true, never an exception)
  const gone = await rawConnect(t, srv.port);
  const rec2 = srv.records[2];
  if (gone.socket.resetAndDestroy) gone.socket.resetAndDestroy(); else gone.socket.destroy();
  const big = makeText(100000);
  while (rec2.closes.length === 0) { for (let i = 0; i < 50; i++) assert.equal(typeof rec2.conn.send(big), 'boolean'); await tick(); }
  await expectOnClose(rec2, 1006);
});

test('8.2 api: conn.close(code, reason) performs the closing handshake', async (t) => {
  const srv = await startServer(t);
  const raw = await rawConnect(t, srv.port);
  const rec = srv.records[0];
  rec.conn.close(4000, 'bye ✓');
  assert.equal(rec.conn.isOpen, false, 'not open any more as soon as close() was called');
  assert.equal(srv.wss.clients.has(rec.conn), false, 'and no longer listed in wss.clients');
  rec.conn.close(4999, 'a second call is ignored');
  const c = await raw.close();
  assert.deepEqual([c.code, c.reason], [4000, 'bye ✓']);
  assert.deepEqual(rec.closes, [], 'onclose waits until the socket is really gone');
  // what the client still sends while the server is closing is not delivered; its close frame ends it
  raw.write(Buffer.concat([frame(OP.TEXT, 'ignored'), frame(OP.PING, 'ignored'), frame(OP.CLOSE, closeBody(4000, 'bye ✓'))]));
  assert.equal(await raw.next(), null, 'no echo, no pong, no second close frame: just FIN');
  await expectOnClose(rec, 4000, 'bye ✓');
  assert.deepEqual(rec.messages, []);

  /** Close a fresh connection with `args`; return the close frame the client received. */
  const closeWith = async (...args) => {
    const r = await rawConnect(t, srv.port);
    const record = srv.records[srv.records.length - 1];
    record.conn.close(...args);
    const f = await r.next();
    assert.equal(f.opcode, OP.CLOSE);
    assert.ok(f.payload.length <= 125, 'a control frame payload is at most 125 bytes');
    r.write(frame(OP.CLOSE, f.payload));
    assert.equal(await r.next(), null);
    await waitFor(() => record.closes.length === 1, 'onclose');
    return { code: f.payload.readUInt16BE(0), reason: new TextDecoder('utf-8', { fatal: true }).decode(f.payload.subarray(2)), record };
  };
  assert.deepEqual((({ code, reason }) => [code, reason])(await closeWith()), [1000, ''], 'defaults');
  for (const bad of [1005, 1006, 1015, 999, 0, 5000, 70000, 1000.5, NaN, '1001', null, {}]) {
    assert.equal((await closeWith(bad)).code, 1000, `illegal close code ${String(bad)} falls back to 1000`);
  }
  for (const good of [1000, 1001, 1008, 1011, 1013, 3000, 4999]) assert.equal((await closeWith(good)).code, good);
  assert.equal((await closeWith(1000, 42)).reason, '', 'a non-string reason is dropped');
  // over-long reasons are cut to fit, without producing invalid UTF-8
  assert.equal((await closeWith(1000, 'x'.repeat(5000))).reason, 'x'.repeat(123));
  assert.equal((await closeWith(1000, 'é'.repeat(200))).reason, 'é'.repeat(61));
  assert.match((await closeWith(1000, '😀'.repeat(100))).reason, /^(😀){30}/u);
});

test('8.3 api: close() destroys the socket after ~3 s if the peer never finishes the handshake', async (t) => {
  const srv = await startServer(t);        // default close timeout
  const raw = await rawConnect(t, srv.port);
  const rec = srv.records[0];
  const t0 = Date.now();
  rec.conn.close(1000, 'nobody answers');
  assert.equal((await raw.close()).code, 1000);
  await sleep(1500);                      // the client ignores the close frame and just sits there
  assert.equal(raw.closed, false, 'still waiting for the peer after 1.5 s');
  assert.deepEqual(rec.closes, []);
  await raw.whenClosed;
  const ms = Date.now() - t0;
  assert.ok(ms >= 2700 && ms <= 4500, `socket destroyed after ${ms} ms, expected about 3000`);
  await expectOnClose(rec, 1000, 'nobody answers');
}, { timeout: 12000 });

test('8.4 api: every way of closing is bounded by the close timeout, even with a peer that never hangs up', async (t) => {
  const srv = await startServer(t, { closeTimeout: 150 });
  const scenarios = {
    'peer echoes our close frame but keeps its socket open': async (raw, rec) => {
      rec.conn.close(4100, 'a');
      const f = await raw.next();
      raw.write(frame(OP.CLOSE, f.payload));
      return 4100;
    },
    'peer sends a close frame, gets the echo, keeps its socket open': async (raw) => {
      raw.write(frame(OP.CLOSE, closeBody(4200)));
      assert.equal((await raw.close()).code, 4200);
      return 4200;
    },
    'protocol error, peer ignores our 1002': async (raw) => {
      raw.write(frame(OP.TEXT, 'unmasked', { mask: false }));
      assert.equal((await raw.close()).code, 1002);
      return 1002;
    },
    'peer ignores our close frame and keeps sending': async (raw, rec) => {
      rec.conn.close(4300);
      const chatter = setInterval(() => raw.write(frame(OP.TEXT, 'la la la')), 10);
      t.defer(() => clearInterval(chatter));
      return 4300;
    },
  };
  for (const [label, run] of Object.entries(scenarios)) {
    const raw = await rawConnect(t, srv.port, { allowHalfOpen: true });
    const rec = srv.records[srv.records.length - 1];
    const t0 = Date.now();
    const code = await run(raw, rec);
    try {
      await waitFor(() => rec.req.socket.destroyed, 'the server-side socket to be destroyed', 2000);
      const ms = Date.now() - t0;
      assert.ok(ms >= 100 && ms < 1500, `destroyed after ${ms} ms, expected about 150`);
      await expectOnClose(rec, code);
      assert.deepEqual(rec.messages, []);
    } catch (err) { err.message = `[${label}] ${err.message}`; throw err; }
  }
});

test('8.5 api: terminate() drops the connection at once', async (t) => {
  const srv = await startServer(t);
  const raw = await rawConnect(t, srv.port);
  const rec = srv.records[0];
  rec.conn.terminate();
  assert.equal(rec.conn.isOpen, false);
  assert.equal(rec.conn.send('x'), false);
  assert.equal(srv.wss.clients.size, 0);
  assert.equal(await raw.next(), null, 'no close frame: the socket just drops');
  await expectOnClose(rec, 1006, '');
  rec.conn.terminate();                   // all of these are harmless on a dead connection
  rec.conn.close();
  rec.conn.close(1000, 'x');
  assert.equal(rec.conn.bufferedAmount, 0);
  // terminate() in the middle of a closing handshake: onclose reports the code that was sent
  const raw2 = await rawConnect(t, srv.port);
  const rec2 = srv.records[1];
  rec2.conn.close(4400, 'then terminated');
  rec2.conn.terminate();
  await raw2.whenClosed;
  await expectOnClose(rec2, 4400, 'then terminated');
  await sleep(250);
  assert.equal(rec.closes.length + rec2.closes.length, 2, 'still exactly one onclose each');
});

test('8.6 api: wss.close() closes everyone with 1001, stops the heartbeat and stops accepting', async (t) => {
  const made = [], cleared = [];
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  globalThis.setInterval = (...a) => { const h = realSet(...a); made.push(h); return h; };
  globalThis.clearInterval = (h) => { cleared.push(h); return realClear(h); };
  const restore = () => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; };
  t.defer(restore);
  const srv = await startServer(t, { pingInterval: 60 });
  assert.equal(made.length, 1, 'one heartbeat timer for the whole server');
  const raws = await Promise.all([1, 2, 3, 4, 5].map(() => rawConnect(t, srv.port)));
  assert.equal(srv.wss.clients.size, 5);
  assert.ok([...srv.wss.clients].every((c) => c.isOpen));
  srv.wss.close();
  restore();
  assert.ok(cleared.includes(made[0]), 'the heartbeat timer must be cleared');
  assert.equal(srv.wss.clients.size, 0);
  for (const raw of raws) {
    let f = await raw.next();
    while (f && f.opcode === OP.PING) f = await raw.next();      // a ping may have been in flight
    assert.equal(f.opcode, OP.CLOSE);
    assert.equal(f.payload.readUInt16BE(0), 1001);
    raw.write(frame(OP.CLOSE, f.payload));
    assert.equal(await raw.next(), null);
  }
  for (const rec of srv.records) await expectOnClose(rec, 1001);
  // upgrade requests are no longer taken: with no upgrade listener left, http treats them as ordinary requests
  const socket = net.connect(srv.port, '127.0.0.1');
  t.defer(() => socket.destroy());
  let got = '';
  socket.on('data', (c) => { got += c; });
  socket.write(upgradeRequest(srv.port));
  await waitFor(() => got.includes('\r\n\r\n'), 'a response');
  assert.match(got, /^HTTP\/1\.1 200 /, 'handled by the normal request handler');
  assert.equal(srv.records.length, 5);
  srv.wss.close();                        // a second close is harmless
  await sleep(150);                       // two former heartbeat periods: nothing happens any more
});

test('8.7 api: bufferedAmount shows a client that is not reading; no pongs are piled onto a backlog', async (t) => {
  const srv = await startServer(t, { echo: false });
  const raw = await rawConnect(t, srv.port);
  const rec = srv.records[0];
  assert.equal(rec.conn.bufferedAmount, 0);
  raw.socket.pause();                     // a stalled client
  const msg = makeText(64 * 1024, 8);
  let sent = 0;
  while (rec.conn.bufferedAmount < 4 * 1024 * 1024 && sent < 2000) { assert.equal(rec.conn.send(msg), true); sent++; }
  assert.ok(rec.conn.bufferedAmount >= 4 * 1024 * 1024, `bufferedAmount is ${rec.conn.bufferedAmount} after ${sent} unread messages`);
  await sleep(100);
  assert.ok(rec.conn.bufferedAmount > 0, 'the backlog stays while the client does not read');
  raw.socket.resume();
  for (let i = 0; i < sent; i++) {
    const f = await raw.next(10000);
    assert.ok(f && f.opcode === OP.TEXT && f.payload.length === msg.length, `message ${i} of ${sent}`);
    if (i === 0 || i === sent - 1) same(f.payload.toString('latin1'), msg, `message ${i}`);
  }
  await waitFor(() => rec.conn.bufferedAmount === 0, 'the write buffer to drain');
  assert.equal(rec.conn.isOpen, true);
  // While such a backlog exists the server does not pile pongs on top of it (a client that
  // floods pings without ever reading must not be able to grow the server's memory) ...
  raw.socket.pause();
  while (rec.conn.bufferedAmount < 1024 * 1024) rec.conn.send(msg);
  for (let i = 0; i < 2000; i++) raw.write(frame(OP.PING, makeText(125)));
  raw.write(frame(OP.TEXT, 'marker'));
  await waitFor(() => rec.messages.includes('marker'), 'the server to have processed all 2000 pings');
  raw.socket.resume();
  await waitFor(() => rec.conn.bufferedAmount === 0, 'the write buffer to drain again');
  // ... and answers again once the client has caught up.
  raw.write(frame(OP.PING, 'caught up'));
  let pongs = 0;
  for (;;) {
    const f = await raw.next(10000);
    assert.ok(f, 'connection must stay open');
    if (f.opcode !== OP.PONG) continue;
    pongs++;
    if (f.payload.toString() === 'caught up') break;
  }
  assert.ok(pongs < 2000, `expected the server to skip pongs while backlogged, got ${pongs} of 2001`);
}, { timeout: 30000 });

// ============================================================================
//  9. Robustness: nothing may ever crash the process
// ============================================================================

test('9.1 robustness: a throwing or rejecting handler is reported and that connection closed with 1011', async (t) => {
  const handlers = (conn, req, rec) => {
    if (req.url.includes('boom-connect')) throw new Error('boom in onConnection');
    conn.onmessage = (text) => {
      rec.messages.push(text);
      if (text === 'throw') throw new Error('boom in onmessage');
      if (text === 'reject') return Promise.reject(new Error('boom in async onmessage'));
      if (text === 'not-a-function') { conn.onmessage = 'oops'; conn.onclose = 42; }
      conn.send(text);
    };
    if (req.url.includes('boom-close')) conn.onclose = () => { rec.closes.push(['called']); throw new Error('boom in onclose'); };
  };
  const srv = await startServer(t, { onConnection: handlers });
  // onmessage throws / rejects: 1011 for that connection; frames behind the bad one are not delivered
  for (const word of ['throw', 'reject']) {
    const raw = await rawConnect(t, srv.port);
    const rec = srv.records[srv.records.length - 1];
    raw.write(Buffer.concat([frame(OP.TEXT, 'fine'), frame(OP.TEXT, word)]));
    assert.equal(await raw.text(), 'fine');
    assert.equal((await raw.close()).code, 1011);
    raw.write(Buffer.concat([frame(OP.TEXT, 'after the crash'), frame(OP.CLOSE, closeBody(1011))]));
    await expectOnClose(rec, 1011);
    assert.deepEqual(rec.messages, ['fine', word]);
    const reported = srv.errors.pop();
    assert.match(reported.err.message, /^boom in (async )?onmessage$/);
    assert.equal(reported.conn, rec.conn, 'onError receives the connection');
  }
  // onConnection throws
  const a = await rawConnect(t, srv.port, { path: '/ws?boom-connect' });
  assert.equal((await a.close()).code, 1011);
  assert.equal(srv.errors.pop().err.message, 'boom in onConnection');
  // onclose throws: reported, nothing else happens
  const b = await rawConnect(t, srv.port, { path: '/ws?boom-close' });
  const recB = srv.records[srv.records.length - 1];
  b.socket.destroy();
  await waitFor(() => srv.errors.length === 1, 'the onclose error to be reported');
  assert.equal(srv.errors.pop().err.message, 'boom in onclose');
  await sleep(50);
  assert.deepEqual(recB.closes, [['called']]);
  // handlers that are not functions are ignored
  const c = await rawConnect(t, srv.port);
  c.write(Buffer.concat([frame(OP.TEXT, 'not-a-function'), frame(OP.TEXT, 'dropped silently'), frame(OP.PING, 'still parsing')]));
  assert.equal(await c.text(), 'not-a-function');
  assert.equal((await c.next()).opcode, OP.PONG);
  c.socket.destroy();
  // a broken error reporter must not make things worse, and the default reporter logs to console.error
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args);
  t.defer(() => { console.error = realError; });
  const broken = await startServer(t, { onConnection: handlers, onError: () => { throw new Error('the reporter is broken too'); } });
  const dflt = await startServer(t, { onConnection: handlers, onError: undefined });
  for (const s of [broken, dflt]) {
    const raw = await rawConnect(t, s.port);
    raw.write(frame(OP.TEXT, 'throw'));
    assert.equal((await raw.close()).code, 1011);
  }
  console.error = realError;
  assert.equal(logged.length, 1);
  assert.ok(logged[0].some((x) => x instanceof Error && x.message === 'boom in onmessage'), 'default onError logs the error');
  // the server as a whole is unimpressed
  const ok = await rawConnect(t, srv.port);
  ok.write(frame(OP.TEXT, 'business as usual'));
  assert.equal(await ok.text(), 'business as usual');
  assert.deepEqual(srv.errors, []);
});

test('9.6 robustness: an upgrade whose socket is already dead creates no connection', async (t) => {
  const srv = await startServer(t);
  // Get a real server-side socket that has been destroyed, the way a client vanishing mid-handshake leaves it.
  const helper = net.createServer();
  await new Promise((res) => helper.listen(0, '127.0.0.1', res));
  t.defer(() => helper.close());
  const accepted = new Promise((res) => helper.once('connection', res));
  const client = net.connect(helper.address().port, '127.0.0.1');
  t.defer(() => client.destroy());
  const socket = await accepted;
  socket.destroy();
  await new Promise((res) => socket.once('close', res));
  const headers = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': crypto.randomBytes(16).toString('base64'), 'sec-websocket-version': '13' };
  for (const head of [Buffer.alloc(0), frame(OP.TEXT, 'ghost'), undefined]) {
    srv.server.emit('upgrade', { url: '/ws', method: 'GET', headers }, socket, head);                                  // would be accepted
    srv.server.emit('upgrade', { url: '/nope', method: 'GET', headers }, socket, head);                                // would be refused
    srv.server.emit('upgrade', { url: '/ws', method: 'GET', headers: { ...headers, 'sec-websocket-version': '7' } }, socket, head);
  }
  await sleep(50);
  assert.equal(srv.records.length, 0, 'onConnection must not be called for a dead socket');
  assert.equal(srv.wss.clients.size, 0, 'nothing may be left in wss.clients (its onclose could never fire)');
  // a request object that makes the handshake code itself throw is contained and reported, not fatal
  const live = net.connect(srv.port, '127.0.0.1');
  t.defer(() => live.destroy());
  await new Promise((res) => live.once('connect', res));
  srv.server.emit('upgrade', { url: null, method: 'GET', headers }, live, Buffer.alloc(0));
  assert.equal(srv.errors.length, 1);
  assert.ok(srv.errors.pop().err instanceof TypeError);
  assert.equal(live.destroyed, true);
});

/** Small seeded PRNG so that a failing fuzz run can be replayed: WS_TEST_SEED=<n> node tools/test-ws.js 9. */
const SEED = Number(process.env.WS_TEST_SEED) || (Date.now() % 1000000000);
function prng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const int = (n) => Math.floor(next() * n);                     // 0 .. n-1
  return { next, int, pick: (list) => list[int(list.length)], bytes: (n) => Buffer.from(Array.from({ length: n }, () => int(256))) };
}

/** Write `bytes` in random pieces, letting the event loop turn in between. */
async function writeInPieces(socket, bytes, r) {
  for (let pos = 0; pos < bytes.length;) {
    const n = r.pick([1, 2, 3, 7, 50, 500, 5000, bytes.length]);
    socket.write(bytes.subarray(pos, pos + n));
    pos += n;
    if (r.int(2)) await tick();
  }
}

/** Invariants that must hold for every connection of a fuzzed server, whatever was thrown at it. */
async function checkFuzzedServer(t, srv, maxPayload) {
  await waitFor(() => srv.records.every((rec) => rec.closes.length >= 1), 'every fuzzed connection to report onclose', 8000);
  await sleep(50);
  for (const rec of srv.records) {
    assert.equal(rec.closes.length, 1, 'onclose exactly once');
    assert.ok(Number.isInteger(rec.closes[0][0]) && typeof rec.closes[0][1] === 'string', 'onclose(code, reason) types');
    for (const m of rec.messages) {
      assert.equal(typeof m, 'string');
      assert.ok(Buffer.byteLength(m) <= maxPayload, 'no message above maxPayload is ever delivered');
    }
  }
  assert.equal(srv.wss.clients.size, 0);
  const ok = await rawConnect(t, srv.port);                      // and the server still works
  ok.write(frame(OP.TEXT, 'survived'));
  assert.equal(await ok.text(), 'survived');
  ok.socket.destroy();
}

test(`9.2 robustness: random garbage after the handshake (seed ${SEED})`, async (t) => {
  const r = prng(SEED);
  const srv = await startServer(t, { maxPayload: 5000, pingInterval: 50 });
  await Promise.all(Array.from({ length: 300 }, async (_, i) => {
    const raw = await rawConnect(t, srv.port);
    const garbage = r.bytes(r.pick([1, 2, 3, 10, 100, 2000, 20000]));
    if (i % 3 === 0) garbage[0] = 0x81;                          // make some of it start like a text frame
    if (i % 6 === 0) garbage[1] |= 0x80;                         // ... a masked one
    await writeInPieces(raw.socket, garbage, r);
    const seen = await Promise.race([drain(raw, () => {}, 8000), sleep(100 + r.int(100)).then(() => null)]);
    if (seen) assert.ok(seen.filter((op) => op === OP.CLOSE).length <= 1, 'at most one close frame');
    raw.socket.destroy();                                        // whatever state the server is in now
  }));
  await checkFuzzedServer(t, srv, 5000);
}, { timeout: 30000 });

test('9.3 robustness: garbage instead of a handshake, and clients that vanish at every stage', async (t) => {
  const r = prng(SEED + 1);
  const srv = await startServer(t);
  const request = Buffer.from(upgradeRequest(srv.port));
  const junk = [
    r.bytes(300), Buffer.from('\r\n\r\n'), Buffer.from('GET /ws HTTP/1.1\r\n'), Buffer.from('GET /ws HTTP/9.9\r\n\r\n'),
    Buffer.from('GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \u0000\r\n\r\n'),
    Buffer.concat([Buffer.from('GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Big: '), Buffer.alloc(70000, 0x61), Buffer.from('\r\n\r\n')]),
    Buffer.concat([frame(OP.TEXT, 'a frame before any handshake'), request]),
    ...Array.from({ length: 40 }, () => request.subarray(0, 1 + r.int(request.length))),       // truncated requests
    ...Array.from({ length: 40 }, () => { const b = Buffer.from(request); b[r.int(b.length)] = r.int(256); return b; }),   // one byte flipped
  ];
  await Promise.all(junk.map((bytes, i) => new Promise((resolve) => {
    const socket = net.connect(srv.port, '127.0.0.1');
    socket.on('error', () => {});
    socket.on('close', resolve);
    socket.on('connect', () => {
      socket.write(bytes);
      if (i % 4 === 0) socket.destroy();                         // gone at once
      else if (i % 4 === 1 && socket.resetAndDestroy) setImmediate(() => socket.resetAndDestroy());
      else setTimeout(() => socket.destroy(), 30 + r.int(60));
    });
  })));
  await sleep(100);
  for (const rec of srv.records) rec.conn.terminate();           // a flipped byte may still have produced a valid handshake
  await checkFuzzedServer(t, srv, 256 * 1024);
});

/** A random stream of mostly legal, sometimes illegal frames that always ends with a close frame. */
function randomFrameStream(r, maxPayload) {
  const alphabet = ['a', 'B', ' ', '{', '"', 'é', 'ß', '€', '日', '😀', '\u0000', '﻿'];
  const text = (n) => Array.from({ length: n }, () => r.pick(alphabet)).join('');
  const textOfBytes = (n) => {            // valid UTF-8 of exactly n bytes
    let out = '', left = n;
    while (left > 0) { const ch = r.pick(alphabet), size = Buffer.byteLength(ch); if (size <= left) { out += ch; left -= size; } else { out += 'x'; left--; } }
    return Buffer.from(out);
  };
  const frames = [];
  let open = false;                       // a fragmented message is in progress
  for (let i = 1 + r.int(8); i > 0; i--) {
    const mask = r.int(25) ? r.bytes(4) : false;                 // sometimes unmasked (illegal)
    const rsv = r.int(40) ? 0 : r.pick([1, 2, 4]);               // sometimes an RSV bit (illegal)
    const kind = r.int(100);
    if (kind < 55) {                                             // data frame, usually the legal opcode
      const opcode = r.int(10) ? (open ? OP.CONT : OP.TEXT) : r.pick([OP.CONT, OP.TEXT]);
      const fin = r.int(3) > 0;
      const size = r.pick([0, 1, 5, 40, 125, 126, 300, maxPayload - 1, maxPayload, maxPayload + 1]);
      // mostly valid text; sometimes cut inside a character (fine if the next fragment completes it) or random bytes
      const payload = r.int(12) ? textOfBytes(size) : r.int(2) ? Buffer.from(text(size)).subarray(0, size) : r.bytes(Math.min(size, 50));
      const min = payload.length < 126 ? 7 : payload.length < 65536 ? 16 : 64;
      frames.push(frame(opcode, payload, { fin, mask, rsv, lenForm: r.int(6) ? min : r.pick([7, 16, 64].filter((f) => f >= min)) }));
      open = !fin;
    } else if (kind < 75) {                                      // ping / pong, sometimes too long or fragmented
      frames.push(frame(r.pick([OP.PING, OP.PONG]), r.bytes(r.pick([0, 1, 20, 125, 125, 126, 200])), { fin: r.int(15) > 0, mask, rsv }));
    } else if (kind < 85) {                                      // close, with all kinds of codes and payloads
      const code = r.pick([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 4000, 4999, 0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000, 65535]);
      const body = r.pick([Buffer.alloc(0), Buffer.from([3]), closeBody(code), closeBody(code, text(r.int(30))), Buffer.concat([closeBody(code), r.bytes(3)])]);
      frames.push(frame(OP.CLOSE, body.subarray(0, 125), { mask, rsv, fin: r.int(15) > 0 }));
    } else if (kind < 90) {                                      // reserved opcode
      frames.push(frame(r.pick([3, 4, 5, 6, 7, 11, 12, 13, 14, 15]), text(r.int(10)), { mask, fin: r.int(2) > 0 }));
    } else {                                                     // a whole small message
      frames.push(frame(open ? OP.CONT : OP.TEXT, text(r.int(60)), { mask: r.bytes(4) }));
      open = false;
    }
  }
  frames.push(frame(OP.CLOSE, closeBody(1000, 'end of fuzz case'), { mask: r.bytes(4) }));
  return Buffer.concat(frames);
}

const FUZZ_CASES = Number(process.env.WS_FUZZ_CASES) || 500;        // WS_FUZZ_CASES=20000 for a long soak
test(`9.4 robustness: ${FUZZ_CASES} random frame streams get the same verdict as from the ws package (seed ${SEED})`, async (t) => {
  needWsLib();
  const r = prng(SEED + 2);
  const maxPayload = 2000;
  const mine = await startServer(t, { maxPayload, pingInterval: 0 });
  const ref = new WsLib.WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload });   // the reference: an echo server too
  ref.on('connection', (ws) => { ws.on('error', () => {}); ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })); });
  await new Promise((res) => ref.on('listening', res));
  t.defer(() => { for (const c of ref.clients) c.terminate(); ref.close(); });

  /** Everything the server sends until it hangs up. Close frames are compared by code only (reason texts differ). */
  const transcript = async (raw) => {
    const out = [];
    for (;;) {
      const f = await raw.next(8000);
      if (!f) return out;
      out.push(f.opcode === OP.CLOSE ? `close ${f.payload.length >= 2 ? f.payload.readUInt16BE(0) : '(no code)'}` : `op${f.opcode} ${f.payload.toString('hex')}`);
    }
  };
  const verdicts = {};
  const runCase = async (n) => {
    const stream = randomFrameStream(r, maxPayload);
    const cuts = [];
    for (let pos = 0; pos < stream.length;) { const len = r.pick([1, 2, 3, 6, 14, 100, 1000, stream.length]); cuts.push(stream.subarray(pos, pos + len)); pos += len; }
    const [a, b] = await Promise.all([rawConnect(t, mine.port), rawConnect(t, ref.address().port, { path: '/' })]);
    const results = Promise.all([transcript(a), transcript(b)]);
    for (const piece of cuts) { a.write(Buffer.from(piece)); b.write(Buffer.from(piece)); if (piece.length < 100) await tick(); }
    const [got, expected] = await results;
    assert.deepEqual(got, expected, `case ${n}: wsserver and ws disagree on stream ${stream.toString('hex').slice(0, 600)}`);
    const last = got[got.length - 1] || 'nothing';
    verdicts[last] = (verdicts[last] || 0) + 1;
  };
  for (let n = 0; n < FUZZ_CASES; n += 25) await Promise.all(Array.from({ length: 25 }, (_, i) => runCase(n + i)));
  // the generator must have exercised every verdict, otherwise this test proves little
  for (const v of ['close 1000', 'close 1002', 'close 1007', 'close 1009']) assert.ok(verdicts[v] >= 10, `only ${verdicts[v] || 0} cases ended with "${v}": ${JSON.stringify(verdicts)}`);
  await checkFuzzedServer(t, mine, maxPayload);
  if (process.env.WS_TEST_VERBOSE) console.log('      verdicts:', JSON.stringify(verdicts));
}, { timeout: 60000 + FUZZ_CASES * 20 });

test('9.5 robustness: after wss.close() and server.close() the process exits by itself', async (t) => {
  const { spawn } = await import('node:child_process');
  const script = `
    import http from 'node:http';
    import net from 'node:net';
    import { attachWebSocket } from ${JSON.stringify(new URL('../lib/wsserver.js', import.meta.url).href)};
    const server = http.createServer();
    const wss = attachWebSocket(server, { pingInterval: 60000, closeTimeout: 300 });
    server.listen(0, '127.0.0.1', () => {
      const socket = net.connect(server.address().port, '127.0.0.1');   // a client that ignores the close frame
      let upgraded = false;
      socket.on('error', () => {});
      socket.on('data', (d) => {
        if (upgraded) { if (d[0] === 0x88) console.log('client ignores close frame ' + d.readUInt16BE(2)); return; }
        if (!String(d).startsWith('HTTP/1.1 101')) { console.log('handshake failed'); process.exit(3); }
        upgraded = true;
        setTimeout(() => { wss.close(); server.close(() => console.log('server closed')); }, 50);
      });
      socket.write('GET /ws HTTP/1.1\\r\\nHost: x\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n');
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.defer(() => child.kill('SIGKILL'));
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const t0 = Date.now();
  const code = await new Promise((res) => child.on('exit', (c, signal) => res(signal || c)));
  assert.equal(code, 0, `child exit status ${code}\nstdout: ${out}\nstderr: ${err}`);
  assert.match(out, /client ignores close frame 1001\n[^]*server closed/);
  assert.doesNotMatch(err, /Uncaught|Unhandled|Error:/);
  const ms = Date.now() - t0;             // 50 ms + the 300 ms close timeout + process start, not the 60 s heartbeat period
  assert.ok(ms >= 300 && ms < 5000, `exited after ${ms} ms: the lingering client is cut off by the close timeout and no timer holds the process`);
}, { timeout: 15000 });

// ============================================================================
//  10. A real browser (Chromium through Playwright; skipped if not installed)
// ============================================================================

const PLAYWRIGHT_PATH = '/opt/npm-tools/node_modules/playwright';

test('10.1 browser: Chromium echo, burst, heartbeat and close codes in both directions', async (t) => {
  let chromium, browser;
  try { ({ chromium } = createRequire(import.meta.url)(PLAYWRIGHT_PATH)); } catch { throw new Skip(`Playwright is not installed at ${PLAYWRIGHT_PATH}`); }
  try { browser = await chromium.launch({ args: ['--no-sandbox'] }); } catch (err) { throw new Skip('Chromium could not be launched: ' + String(err.message).split('\n')[0]); }
  t.defer(() => browser.close());
  const srv = await startServer(t, {
    pingInterval: 200,
    onConnection(conn) {
      const echo = conn.onmessage;
      conn.onmessage = (text) => {
        if (text === 'kick-me') return conn.close(4001, 'kicked ✓');
        if (text === 'drop-me') return conn.terminate();
        if (text === 'burst') { for (let i = 0; i < 500; i++) conn.send('b' + i); return undefined; }
        return echo(text);
      };
    },
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${srv.port}/`);
  const out = await page.evaluate(async (url) => {
    const res = {};
    const open = (protocols) => new Promise((resolve, reject) => {
      const ws = new WebSocket(url, protocols);
      const c = { ws, msgs: [] };
      c.closed = new Promise((done) => { ws.onclose = (e) => { done({ code: e.code, reason: e.reason, wasClean: e.wasClean }); reject(new Error('closed before open')); }; });
      ws.onmessage = (e) => c.msgs.push(e.data);
      ws.onopen = () => resolve(c);
    });
    const until = async (cond) => { for (let i = 0; i < 3000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); if (!cond()) throw new Error('timed out in the page'); };
    const a = await open();
    res.extensions = a.ws.extensions;
    const big = Array.from({ length: 200 * 1024 }, (_, i) => String.fromCharCode(33 + (i * 7) % 90)).join('');
    const payloads = ['hi', '', 'héllo 😀 日本語', '﻿bom', 'x'.repeat(126), 'y'.repeat(70 * 1024), big, ''];
    for (const p of payloads) a.ws.send(p);
    await until(() => a.msgs.length === payloads.length);
    res.echo = payloads.every((p, i) => a.msgs[i] === p);
    a.msgs.length = 0;
    a.ws.send('burst');
    await until(() => a.msgs.length === 500);
    res.burst = a.msgs.every((m, i) => m === 'b' + i);
    await new Promise((r) => setTimeout(r, 1300));               // six heartbeat intervals: the browser pongs by itself
    res.alive = a.ws.readyState === WebSocket.OPEN;
    a.ws.close(1000, 'bye from the browser');
    res.browserClose = await a.closed;
    const b = await open(); b.ws.send('kick-me'); res.serverClose = await b.closed;
    const c = await open(); c.ws.send('drop-me'); res.terminate = await c.closed;
    const d = await open(); d.ws.send('z'.repeat(256 * 1024 + 1)); res.oversize = await d.closed;
    const e = await open(); e.ws.send(new Uint8Array([1, 2, 3])); res.binary = await e.closed;
    res.subprotocol = await open(['chat']).then(() => 'connected', () => 'refused');
    window.last = await open();
    return res;
  }, srv.url);
  assert.deepEqual(out, {
    extensions: '', echo: true, burst: true, alive: true,
    browserClose: { code: 1000, reason: 'bye from the browser', wasClean: true },
    serverClose: { code: 4001, reason: 'kicked ✓', wasClean: true },
    terminate: { code: 1006, reason: '', wasClean: false },
    oversize: { code: 1009, reason: 'message too big', wasClean: true },
    binary: { code: 1003, reason: 'binary messages are not supported', wasClean: true },
    // No subprotocol is ever selected, and a browser fails a connection for which it asked for one:
    // the game client must use `new WebSocket(url)` without a protocols argument.
    subprotocol: 'refused',
  });
  srv.wss.close();
  assert.deepEqual(await page.evaluate(() => window.last.closed), { code: 1001, reason: 'server shutting down', wasClean: true });
  await waitFor(() => srv.records.length === 7 && srv.records.every((r) => r.closes.length === 1), 'all seven onclose calls');
  assert.deepEqual(srv.records.map((r) => r.closes[0][0]), [1000, 4001, 1006, 1009, 1003, 1006, 1001], 'onclose codes seen by the server');
}, { timeout: 90000 });

await runAll();
