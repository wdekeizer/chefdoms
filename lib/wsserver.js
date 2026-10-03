// ============================================================================
//  wsserver.js — a small WebSocket server (RFC 6455) with zero dependencies.
//
//    const wss = attachWebSocket(httpServer, { path, maxPayload, pingInterval,
//                                              onConnection(conn, req) {} });
//    wss.clients                 Set of open connections
//    wss.close()                 stop accepting, stop the heartbeat, close all (1001)
//    conn.send(text)             one text frame; false if not open; never throws
//    conn.close(code, reason)    closing handshake; the socket is destroyed after
//                                ~3s if the peer does not finish it
//    conn.terminate()            destroy the socket right now
//    conn.onmessage = (text)     complete, UTF-8 validated text messages
//    conn.onclose = (code, reason)   exactly once, when the socket is gone
//    conn.isOpen / conn.bufferedAmount / conn.remoteAddress
//
//  Text only (binary is refused with 1003); no extensions, no subprotocols.
//  onclose reports the first close frame sent or received: the peer's code if it
//  closed first (1005 if it gave none), ours if we closed or hit a protocol
//  error, 1006 if the socket dropped without one. A handler of yours that throws
//  or rejects is reported to opts.onError and that connection is closed with
//  1011; it does not take the process down.
// ============================================================================
import { createHash } from 'node:crypto';
import { STATUS_CODES } from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';        // fixed by RFC 6455
const KEY_RE = /^[A-Za-z0-9+/]{22}==$/;                      // base64 of 16 bytes
const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BIN = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

// Connection states. CLOSING: we sent a close frame and still parse input, looking for the echo.
// DONE: nothing more is read or written, we only wait for the socket to close. CLOSED: it has.
const OPEN = 0, CLOSING = 1, DONE = 2, CLOSED = 3;

const HDR_MAX = 14;                     // frame header: 2 bytes + 8 (extended length) + 4 (mask)
const MAX_PONG_BACKLOG = 64 * 1024;     // stop answering pings of a peer that is not reading
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const noop = () => {};

// 1004-1006 and 1015 are reserved and must never appear on the wire.
const validCloseCode = (c) => Number.isInteger(c) &&
  ((c >= 1000 && c <= 1014 && (c < 1004 || c > 1006)) || (c >= 3000 && c <= 4999));

/** Build one unfragmented, unmasked frame with a single allocation. `data`: string or Buffer. */
function buildFrame(opcode, data) {
  const isText = typeof data === 'string';
  const len = isText ? Buffer.byteLength(data) : data.length;
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const buf = Buffer.allocUnsafe(head + len);
  buf[0] = 0x80 | opcode;                                    // FIN + opcode
  if (head === 2) buf[1] = len;
  else if (head === 4) { buf[1] = 126; buf.writeUInt16BE(len, 2); }
  else { buf[1] = 127; buf.writeUInt32BE(Math.floor(len / 0x100000000), 2); buf.writeUInt32BE(len >>> 0, 6); }
  if (isText) buf.write(data, head, len, 'utf8'); else data.copy(buf, head);
  return buf;
}

/** Close frame: 2-byte status code + UTF-8 reason (a control payload holds at most 125 bytes). */
function closeFrame(code, reason) {
  reason = reason.slice(0, 123);
  while (Buffer.byteLength(reason) > 123) reason = reason.slice(0, -1);
  const len = Buffer.byteLength(reason);
  const buf = Buffer.allocUnsafe(4 + len);
  buf[0] = 0x80 | OP_CLOSE; buf[1] = 2 + len;
  buf.writeUInt16BE(code, 2); buf.write(reason, 4, len, 'utf8');
  return buf;
}

const PING = buildFrame(OP_PING, Buffer.alloc(0));

/** Answer a bad upgrade request with a plain HTTP error and close the socket. */
function reject(socket, status, extraHeaders = '') {
  const body = STATUS_CODES[status];
  const kill = setTimeout(() => socket.destroy(), 3000).unref();   // in case the reply can never be flushed
  socket.once('close', () => clearTimeout(kill));
  socket.once('finish', () => socket.destroy());             // do not wait for the peer to hang up
  socket.end(`HTTP/1.1 ${status} ${body}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
    `Content-Length: ${body.length}\r\n${extraHeaders}\r\n${body}`);
}

class Connection {
  constructor(socket, req, ctx) {
    this.onmessage = this.onclose = null;
    const fwd = req.headers['x-forwarded-for'];              // set by tunnels / reverse proxies
    this.remoteAddress = (fwd && fwd.split(',')[0].trim()) || socket.remoteAddress || '';
    this._socket = socket;
    this._ctx = ctx;                    // shared per server: { clients, maxPayload, closeTimeout, report }
    this._state = OPEN;
    this._alive = true;                 // a pong arrived since the last heartbeat ping
    this._code = 1006; this._reason = '';                    // what onclose will report
    this._killTimer = null;
    // Parser state. _hdr: the frame header and, behind it, a control payload (<= 125 bytes) that arrives in pieces.
    this._hdr = Buffer.allocUnsafe(HDR_MAX + 125);
    this._hdrLen = 0;                   // header bytes collected so far
    this._hdrNeed = 2;                  // header bytes required (known after the first two)
    this._inPayload = false;            // header complete, now reading ...
    this._remaining = 0;                // ... this many payload bytes of the current frame
    this._maskPos = 0;                  // position in the 4-byte mask
    this._ctlLen = 0;                   // control payload bytes stored in _hdr
    this._buf = null;                   // message being assembled, if it spans chunks or fragments
    this._len = 0;                      // bytes in _buf
    this._msgLen = 0;                   // declared size of the message so far, over all fragments
    this._fragmented = false;           // a message is open and waits for continuation frames
    socket.on('end', () => this._done());                    // FIN without a close frame
    socket.on('close', () => this._onSocketClose());
  }

  get isOpen() { return this._state === OPEN && this._socket.writable; }
  get bufferedAmount() { return this._socket.writableLength; }

  send(text) {
    if (!this.isOpen) return false;
    try {
      this._socket.write(buildFrame(OP_TEXT, typeof text === 'string' ? text : String(text)));
      return true;
    } catch { return false; }
  }

  close(code = 1000, reason = '') {
    if (this._state !== OPEN) return;
    this._code = validCloseCode(code) ? code : 1000;
    this._reason = typeof reason === 'string' ? reason : '';
    this._write(closeFrame(this._code, this._reason));
    this._leave(CLOSING);               // keep reading until the peer echoes the close frame
  }

  terminate() {
    if (this._state < DONE) this._leave(DONE);
    this._socket.destroy();             // 'close' follows and reports to onclose
  }

  // ---- internals ----------------------------------------------------------

  _write(buf) { if (this._socket.writable) this._socket.write(buf); }

  /** Every exit from OPEN passes here: unlist the connection and bound its remaining lifetime. */
  _leave(state) {
    this._state = state;
    this._ctx.clients.delete(this);
    this._killTimer ??= setTimeout(() => this._socket.destroy(), this._ctx.closeTimeout).unref();
  }

  /** Nothing more to say or hear: send FIN, ignore further input, wait for the peer to hang up. */
  _done() {
    if (this._state >= DONE) return;
    this._leave(DONE);
    this._socket.end();
  }

  /** Protocol violation: tell the peer why, then shut down. Always returns false. */
  _fail(code, reason) {
    this.close(code, reason);           // (does nothing if a close frame was sent before)
    this._done();
    return false;
  }

  _onSocketClose() {
    if (this._state === CLOSED) return;
    this._state = CLOSED;
    this._ctx.clients.delete(this);
    clearTimeout(this._killTimer);
    this._buf = null;
    this._call(this.onclose, this._code, this._reason);
  }

  /** Run a user callback. One that throws or rejects must not crash the server. */
  _call(fn, a, b) {
    if (typeof fn !== 'function') return;
    try {
      const result = fn.call(this, a, b);
      if (result && typeof result.then === 'function') result.then(null, (err) => this._crash(err));
    } catch (err) { this._crash(err); }
  }

  _crash(err) { this._ctx.report(err, this); this.close(1011, 'internal error'); }

  /** Heartbeat tick: no pong since the previous ping means the peer is gone. */
  _beat() {
    if (!this._alive) return this.terminate();
    this._alive = false;
    this._write(PING);
  }

  // Streaming parser. Consumes one TCP chunk of any size (a single byte, or many
  // frames). Header bytes go to a small scratch buffer. A payload is unmasked in
  // place; if it lies entirely in this chunk it is used right there (no copy),
  // otherwise it is copied exactly once into _buf.
  _onData(chunk) {
    const hdr = this._hdr, end = chunk.length;
    let pos = 0;
    while (this._state < DONE) {
      if (!this._inPayload) {
        if (pos === end) return;
        hdr[this._hdrLen++] = chunk[pos++];
        if (this._hdrLen === 2 && !this._checkHeader()) return;
        if (this._hdrLen < this._hdrNeed) continue;
        if (!this._beginPayload()) return;
      }
      const n = Math.min(this._remaining, end - pos);
      let payload = chunk.subarray(pos, pos + n);
      const mask = this._hdrNeed - 4;                        // the mask is the last 4 header bytes
      for (let i = 0, m = this._maskPos; i < n; i++, m++) payload[i] ^= hdr[mask + (m & 3)];
      this._maskPos = (this._maskPos + n) & 3;
      this._remaining -= n; pos += n;
      const whole = this._remaining === 0;
      if (hdr[0] & 0x08) {                                   // control frame in pieces: collect behind the header
        if (!whole || this._ctlLen) {
          payload.copy(hdr, HDR_MAX + this._ctlLen);
          this._ctlLen += n;
          payload = hdr.subarray(HDR_MAX, HDR_MAX + this._ctlLen);
        }
      } else if (n > 0 && (!whole || !(hdr[0] & 0x80) || this._buf)) this._append(payload);
      if (!whole) return;                                    // the frame continues in the next chunk
      this._inPayload = false; this._hdrLen = 0; this._hdrNeed = 2;
      this._endFrame(payload);
    }
  }

  /** Validate the first two header bytes, as early as possible. */
  _checkHeader() {
    const b0 = this._hdr[0], b1 = this._hdr[1], op = b0 & 0x0f, len = b1 & 0x7f;
    if (b0 & 0x70) return this._fail(1002, 'RSV bits must be 0');          // no extension negotiated
    if (!(b1 & 0x80)) return this._fail(1002, 'client frames must be masked');
    if (op & 0x08) {                                         // control frame
      if (op > OP_PONG) return this._fail(1002, 'unknown opcode');
      if (!(b0 & 0x80) || len > 125) return this._fail(1002, 'invalid control frame');
    } else {
      if (op > OP_BIN) return this._fail(1002, 'unknown opcode');
      if (op === OP_BIN) return this._fail(1003, 'binary messages are not supported');
      if ((op === OP_CONT) !== this._fragmented) return this._fail(1002, 'invalid fragmentation');
    }
    this._hdrNeed = 6 + (len === 126 ? 2 : len === 127 ? 8 : 0);
    return true;
  }

  /** Header complete: decode the length and enforce maxPayload before anything is buffered. */
  _beginPayload() {
    const hdr = this._hdr, len7 = hdr[1] & 0x7f;
    let len = len7;
    if (len7 === 126) len = hdr.readUInt16BE(2);
    else if (len7 === 127) len = hdr.readUInt32BE(2) * 0x100000000 + hdr.readUInt32BE(6);
    if (!(hdr[0] & 0x08)) {
      if (this._msgLen + len > this._ctx.maxPayload) return this._fail(1009, 'message too big');
      this._msgLen += len;
    }
    this._remaining = len; this._maskPos = 0; this._inPayload = true;
    return true;
  }

  // Copy a payload slice into the message buffer. The buffer is sized for all that
  // was declared so far (one allocation for a frame split over many chunks) and at
  // least doubles when it grows (so a message made of many tiny fragments is not
  // copied again and again). It never exceeds maxPayload.
  _append(part) {
    let buf = this._buf;
    if (!buf || this._len + part.length > buf.length) {
      const grown = Buffer.allocUnsafe(Math.min(this._ctx.maxPayload, Math.max(this._msgLen, buf ? buf.length * 2 : 0)));
      if (buf) buf.copy(grown, 0, 0, this._len);
      this._buf = buf = grown;
    }
    part.copy(buf, this._len);
    this._len += part.length;
  }

  _endFrame(payload) {
    const b0 = this._hdr[0], op = b0 & 0x0f;
    if (op & 0x08) { this._ctlLen = 0; return this._control(op, payload); }
    if (!(b0 & 0x80)) { this._fragmented = true; return; }   // FIN not set: more fragments follow
    const data = this._buf ? this._buf.subarray(0, this._len) : payload;
    this._buf = null; this._len = 0; this._msgLen = 0; this._fragmented = false;
    let text;
    try { text = utf8.decode(data); } catch { return this._fail(1007, 'invalid UTF-8'); }
    if (this._state === OPEN) this._call(this.onmessage, text);
  }

  _control(op, payload) {
    if (op === OP_PONG) { this._alive = true; return; }
    if (op === OP_PING) {
      if (this._state === OPEN && this._socket.writableLength < MAX_PONG_BACKLOG) this._write(buildFrame(OP_PONG, payload));
      return;
    }
    let code = 1005, reason = '';                            // 1005: the close frame carried no code
    if (payload.length === 1) return this._fail(1002, 'invalid close frame');
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!validCloseCode(code)) return this._fail(1002, 'invalid close code');
      try { reason = utf8.decode(payload.subarray(2)); } catch { return this._fail(1007, 'invalid UTF-8'); }
    }
    if (this._state === OPEN) {                              // the peer closes first: echo its frame
      this._code = code; this._reason = reason;
      this._write(buildFrame(OP_CLOSE, payload));
    }
    this._done();                                            // (in CLOSING this was the echo of ours)
  }
}

/**
 * Attach a WebSocket endpoint to an existing http(s) server.
 * Options: path ('/ws'), maxPayload (256 KiB), pingInterval (15000 ms; 0 = no heartbeat),
 * onConnection(conn, req), and two extras: closeTimeout (3000 ms) and onError(err, conn).
 */
export function attachWebSocket(server, opts = {}) {
  const {
    path = '/ws', maxPayload = 256 * 1024, pingInterval = 15000, closeTimeout = 3000, onConnection = noop,
    onError = (err) => console.error('[wsserver] error in a connection handler:', err),
  } = opts;
  const clients = new Set();
  const report = (err, conn) => { try { onError(err, conn); } catch { /* the reporter itself failed */ } };
  const ctx = { clients, maxPayload, closeTimeout, report };

  const upgrade = (req, socket, head) => {
    const h = req.headers, q = req.url.indexOf('?');
    if ((q < 0 ? req.url : req.url.slice(0, q)) !== path) return reject(socket, 404);
    if (req.method !== 'GET' || (h.upgrade || '').toLowerCase() !== 'websocket' ||
        !/(^|,)\s*upgrade\s*(,|$)/i.test(h.connection || '')) return reject(socket, 400);
    if (h['sec-websocket-version'] !== '13') return reject(socket, 426, 'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n');
    const key = h['sec-websocket-key'];
    if (!key || !KEY_RE.test(key)) return reject(socket, 400);
    if (!socket.readable || !socket.writable) return socket.destroy();     // the client is already gone
    socket.setTimeout(0);
    socket.setNoDelay(true);            // game traffic is small and latency sensitive: no Nagle delay
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
    const conn = new Connection(socket, req, ctx);
    clients.add(conn);
    // Last line of defence: should the parser itself ever throw, only this connection dies.
    const feed = (chunk) => { try { conn._onData(chunk); } catch (err) { report(err, conn); conn.terminate(); } };
    conn._call(onConnection, conn, req);                     // handlers get installed here ...
    if (head && head.length) feed(head);                     // ... before frames sent along with the request
    socket.on('data', feed);
  };
  const onUpgrade = (req, socket, head) => {
    socket.on('error', noop);           // http no longer watches this socket; 'close' always follows an error
    try { upgrade(req, socket, head); } catch (err) { socket.destroy(); report(err); }
  };
  server.on('upgrade', onUpgrade);

  // One timer for everybody; it must not keep the process alive on its own. The check runs in
  // setImmediate so that pongs which arrived while the event loop was busy are read first.
  const beat = () => { for (const c of clients) c._beat(); };
  const heartbeat = pingInterval > 0 ? setInterval(() => setImmediate(beat), pingInterval).unref() : null;

  return {
    clients,
    close() {
      clearInterval(heartbeat);
      server.removeListener('upgrade', onUpgrade);
      for (const c of [...clients]) c.close(1001, 'server shutting down');
    },
  };
}
