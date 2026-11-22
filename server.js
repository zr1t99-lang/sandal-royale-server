// Sandal Royale online server: serves the game (from game.zip) and runs the multiplayer lobby on the same port (WebSocket).
//  - quick match: per-mode queue, rooms auto-start with 2-6 real players (no fake players, ever)
//  - private rooms with a 4-letter code; the host picks the mode and starts
//  - relay of in-match messages (each client is authoritative for its own fighter; the room host for shared mode state)
//  - resume: a dropped connection can re-attach to its seat within 20 s (mobile network hiccups)
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PUB = path.join(__dirname, 'public');
const VERSION = 2;
// ---- minimal unzip (no dependencies) ----
function unzip(file, out) {
  const b = fs.readFileSync(file); let e = b.length - 22; while (e > 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  const n = b.readUInt16LE(e + 10); let p = b.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), el = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nl); p += 46 + nl + el + cl;
    if (name.endsWith('/')) continue;
    const lh = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28), raw = b.subarray(lh, lh + csize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw), dest = path.join(out, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, data);
  }
}
// always unpack the zip that ships with this deploy (so a new game.zip replaces old files)
if (fs.existsSync(path.join(__dirname, 'game.zip'))) { try { fs.rmSync(PUB, { recursive: true, force: true }); } catch (e) { } unzip(path.join(__dirname, 'game.zip'), PUB); }
// the character is stored once (.glb) and served as the 4 base64 parts the game loads
let parts = null;
function getParts() {
  if (parts) return parts;
  const f = path.join(PUB, 'assets', 'sandal_character_v2.glb'); if (!fs.existsSync(f)) return (parts = []);
  const s = fs.readFileSync(f).toString('base64'), n = 4; let q = Math.ceil(s.length / n); q += (4 - q % 4) % 4; parts = [];
  for (let i = 0; i < n; i++) parts.push(Buffer.from(s.slice(i * q, (i + 1) * q)));
  return parts;
}
const gz = new Map();   // gzip cache for text files
const TYPES = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
const MODES = ['classic', 'hot', 'rain', 'gold'];
const rooms = new Map(), seats = new Map(); let nextId = 1;
const server = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url || '/').split('?')[0]);
  let buf = null, type = 'text/plain', key = u;
  const m = /^\/assets\/sandal_character\.b64\.(\d)\.txt$/.exec(u);
  if (m) { buf = getParts()[+m[1]]; type = TYPES['.txt']; }
  else if (u === '/health') { buf = Buffer.from('ok v' + VERSION + ' rooms=' + rooms.size + ' online=' + wss.clients.size); key = null; }
  else if (u === '/stats') { buf = Buffer.from(JSON.stringify(stats())); type = TYPES['.json']; key = null; }
  else {
    const rel = u === '/' ? 'index.html' : u.replace(/^\/+/, ''), f = path.join(PUB, rel);
    if (f.startsWith(PUB) && fs.existsSync(f) && fs.statSync(f).isFile()) { buf = fs.readFileSync(f); type = TYPES[path.extname(f)] || 'application/octet-stream'; }
  }
  if (!buf) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  const h = { 'content-type': type, 'cache-control': key && u !== '/' && !u.endsWith('.html') ? 'public, max-age=86400' : 'no-cache' };
  if (key && /text|javascript|json/.test(type) && /gzip/.test(req.headers['accept-encoding'] || '')) {
    let z = gz.get(key); if (!z) { z = zlib.gzipSync(buf, { level: 6 }); gz.set(key, z); }
    h['content-encoding'] = 'gzip'; res.writeHead(200, h); return res.end(z);
  }
  res.writeHead(200, h); res.end(buf);
});
const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 });
const newCode = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s; do { s = ''; for (let i = 0; i < 4; i++) s += c[Math.random() * c.length | 0]; } while (rooms.has(s)); return s; };
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const listOf = r => [...r.players.values()].map(p => ({ id: p.id, name: p.name, on: !p.gone }));
function stats() { const q = {}; MODES.forEach(m => q[m] = 0); for (const r of rooms.values()) if (r.quick && !r.started) q[r.mode] += r.players.size; return { online: wss.clients.size, playing: [...rooms.values()].filter(r => r.started).reduce((a, r) => a + r.players.size, 0), queue: q }; }
function roomMsg(r) { return { t: 'room', code: r.quick ? '' : r.code, quick: r.quick, host: r.host, list: listOf(r), mode: r.mode, started: r.started, startsAt: r.startsAt ? r.startsAt - Date.now() : 0, online: wss.clients.size }; }
function broadcast(r, o, except) { const s = JSON.stringify(o); for (const p of r.players.values()) if (p !== except && p.readyState === 1) p.send(s); }
function sync(r) { for (const p of r.players.values()) send(p, roomMsg(r)); }
function pickHost(r) { if (!r.players.has(r.host)) { const live = [...r.players.values()].find(p => !p.gone) || r.players.values().next().value; r.host = live ? live.id : 0; } }
function startRoom(r) {
  if (r.started || r.players.size < 2) return;
  clearTimeout(r.timer); r.timer = null; r.startsAt = 0; r.started = true; r.round = (r.round || 0) + 1;
  pickHost(r); broadcast(r, { t: 'start', list: listOf(r).map(p => ({ id: p.id, name: p.name })), mode: r.mode, host: r.host, round: r.round });
}
// quick rooms: start 8 s after the 2nd player arrives (or at once when full)
function armQuick(r) {
  if (!r.quick || r.started) return;
  if (r.players.size >= 6) return startRoom(r);
  if (r.players.size >= 2 && !r.timer) { r.startsAt = Date.now() + 8000; r.timer = setTimeout(() => { r.timer = null; startRoom(r); }, 8000); }
  if (r.players.size < 2 && r.timer) { clearTimeout(r.timer); r.timer = null; r.startsAt = 0; }
}
function leave(ws, quiet) {
  const r = rooms.get(ws.room); ws.room = null; if (!r) return;
  r.players.delete(ws.id); seats.delete(ws.token);
  if (!r.players.size) { clearTimeout(r.timer); rooms.delete(r.code); return; }
  pickHost(r);
  if (r.started) broadcast(r, { t: 'left', id: ws.id, host: r.host });
  armQuick(r); sync(r);
}
function enter(ws, r) { leave(ws); r.players.set(ws.id, ws); ws.room = r.code; seats.set(ws.token, ws.id); if (!r.host) r.host = ws.id; armQuick(r); sync(r); }
wss.on('connection', ws => {
  ws.id = nextId++; ws.name = 'لاعب'; ws.room = null; ws.alive = true; ws.token = crypto.randomBytes(12).toString('hex');
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'hello', id: ws.id, token: ws.token, v: VERSION, online: wss.clients.size });
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    const name = () => String(m.name || ws.name || 'لاعب').replace(/[<>]/g, '').slice(0, 12) || 'لاعب';
    const mode = MODES.includes(m.mode) ? m.mode : 'classic';
    if (m.t === 'ping') return send(ws, { t: 'pong', c: m.c, online: wss.clients.size });
    if (m.t === 'stats') return send(ws, Object.assign({ t: 'stats' }, stats()));
    if (m.t === 'create') {
      ws.name = name(); const c = newCode(), r = { code: c, quick: false, players: new Map(), host: ws.id, mode, started: false };
      rooms.set(c, r); enter(ws, r);
    } else if (m.t === 'join') {
      const c = String(m.code || '').toUpperCase().trim(), r = rooms.get(c);
      if (!r || r.quick) return send(ws, { t: 'error', msg: 'الكود غير موجود' });
      if (r.players.size >= 6) return send(ws, { t: 'error', msg: 'الغرفة ممتلئة' });
      if (r.started) return send(ws, { t: 'error', msg: 'المباراة بدأت، انتظر تخلص' });
      ws.name = name(); enter(ws, r);
    } else if (m.t === 'quick') {
      ws.name = name();
      let r = [...rooms.values()].find(x => x.quick && !x.started && x.mode === mode && x.players.size < 6);
      if (!r) { const c = newCode(); r = { code: c, quick: true, players: new Map(), host: ws.id, mode, started: false }; rooms.set(c, r); }
      enter(ws, r);
    } else if (m.t === 'mode') {
      const r = rooms.get(ws.room); if (r && !r.quick && r.host === ws.id && !r.started) { r.mode = mode; sync(r); }
    } else if (m.t === 'start') {
      const r = rooms.get(ws.room); if (r && !r.quick && r.host === ws.id) { if (r.players.size < 2) return send(ws, { t: 'error', msg: 'بانتظار لاعب ثاني' }); startRoom(r); }
    } else if (m.t === 'lobby') {           // match finished: private room goes back to its lobby
      const r = rooms.get(ws.room); if (!r) return; if (r.quick) { leave(ws); return; } if (r.started) { r.started = false; } sync(r);
    } else if (m.t === 'relay') {
      const r = rooms.get(ws.room); if (!r) return;
      broadcast(r, { t: 'relay', from: ws.id, d: m.d }, ws);
    } else if (m.t === 'resume') {         // re-attach to a seat after a dropped connection
      const id = seats.get(String(m.token || '')); let old = null;
      for (const r of rooms.values()) { const p = id && r.players.get(id); if (p) { old = { r, p }; break; } }
      if (!old) return send(ws, { t: 'resume', ok: false });
      const { r, p } = old; clearTimeout(p.goneT); r.players.delete(p.id);
      ws.id = p.id; ws.name = p.name; ws.token = p.token; ws.room = r.code; r.players.set(ws.id, ws); seats.set(ws.token, ws.id);
      try { p.terminate(); } catch (e) { }
      send(ws, { t: 'resume', ok: true, id: ws.id }); sync(r);
    } else if (m.t === 'leave') leave(ws);
  });
  ws.on('close', () => {
    const r = rooms.get(ws.room); if (!r || !r.players.has(ws.id) || r.players.get(ws.id) !== ws) return;
    if (r.started) { ws.gone = true; sync(r); ws.goneT = setTimeout(() => { if (r.players.get(ws.id) === ws) leave(ws); }, 20000); }   // keep the seat 20 s
    else leave(ws);
  });
});
setInterval(() => { wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); }); }, 25000);
server.listen(process.env.PORT || 8080, () => console.log('Sandal Royale server v' + VERSION + ' listening'));
