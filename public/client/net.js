// ============================================================================
//  WebSocket connection to the Chefdoms server, with automatic reconnect.
// ============================================================================
/**
 * Turn what a player typed into a WebSocket URL.
 *   ''                              -> the server this page was loaded from
 *   203.0.113.5:3000 / mypc:3000    -> ws://203.0.113.5:3000/ws
 *   192.168.1.23 / localhost        -> ws://192.168.1.23:3000/ws   (default port)
 *   https://abc.trycloudflare.com   -> wss://abc.trycloudflare.com/ws
 *   abc.trycloudflare.com           -> wss://abc.trycloudflare.com/ws
 */
export function wsUrl(addr, loc = globalThis.location) {
  addr = String(addr || '').trim();
  if (!addr) return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/ws';
  const m = /^(https?|wss?):\/\/([^/\s]+)/i.exec(addr);
  if (m) return (/^(https|wss)$/i.test(m[1]) ? 'wss://' : 'ws://') + m[2] + '/ws';
  const host = addr.replace(/[/\s].*$/, '');
  if (/:\d+$/.test(host)) return 'ws://' + host + '/ws';
  const plain = /^(localhost|\d+\.\d+\.\d+\.\d+|\[[0-9a-f:]+\]|[^.]+)$/i.test(host);   // an IP or a bare machine name
  return plain ? 'ws://' + host + ':3000/ws' : 'wss://' + host + '/ws';
}

export class Net {
  /**
   * @param {() => object} hello    builds the first message (name + token) for every (re)connect
   * @param {(msg: object) => void} onMsg
   * @param {(status: 'open'|'closed', code?: number) => void} onStatus
   * @param {() => string} address   what the player typed as the server address ('' = this page's server)
   */
  constructor(hello, onMsg, onStatus, address = () => '') {
    this.hello = hello; this.onMsg = onMsg; this.onStatus = onStatus; this.address = address;
    this.ws = null; this.wantOpen = false; this.tries = 0; this.ping = 0;
    setInterval(() => this.send({ t: 'ping', n: performance.now() }), 2000);
  }

  /** (Re)connect, dropping any connection or attempt in progress. */
  connect() {
    this.wantOpen = true;
    if (this.ws) { const old = this.ws; this.ws = null; old.onclose = null; old.onmessage = null; try { old.close(); } catch { /* ignore */ } }
    this.tries = 0;
    this._open();
  }

  stop() {
    this.wantOpen = false;
    if (this.ws) { const old = this.ws; this.ws = null; old.onclose = null; old.onmessage = null; try { old.close(); } catch { /* ignore */ } }
  }

  _open() {
    let ws;
    try { ws = new WebSocket(wsUrl(this.address())); } catch { this.onStatus('closed', 0); return; }
    this.ws = ws;
    ws.onopen = () => { this.tries = 0; ws.send(JSON.stringify(this.hello())); this.onStatus('open'); };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'pong') { this.ping = performance.now() - m.n; return; }
      this.onMsg(m);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onStatus('closed', ev.code);
      if (this.wantOpen && ev.code !== 4000) {
        const delay = Math.min(4000, 400 * 2 ** this.tries++);
        setTimeout(() => { if (this.wantOpen && !this.ws) this._open(); }, delay);
      }
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
}
