// Sandal Royale: serves the game (from game.zip) and relays room messages between players (WebSocket) - one service, one link.
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const { WebSocketServer } = require('ws');
const PUB = path.join(__dirname, 'public');
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
if (!fs.existsSync(path.join(PUB, 'index.html')) && fs.existsSync(path.join(__dirname, 'game.zip'))) unzip(path.join(__dirname, 'game.zip'), PUB);
// the character is stored once (.glb) and served as the 4 base64 parts the game loads
let parts = null;
function getParts() {
  if (parts) return parts;
  const f = path.join(PUB, 'assets', 'sandal_character_v2.glb'); if (!fs.existsSync(f)) return (parts = []);
  const s = fs.readFileSync(f).toString('base64'), n = 4; parts = [];
  for (let i = 0; i < n; i++) parts.push(Buffer.from(s.slice(i * 5301500, i === n - 1 ? s.length : (i + 1) * 5301500)));
  return parts;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.txt': 'text/plain', '.js': 'text/javascript' };
const rooms = new Map(); let nextId = 1;
const server = http.createServer((req, res) => {
  const u = decodeURIComponent((req.url || '/').split('?')[0]);
  let buf = null, type = 'text/plain';
  const m = /^\/assets\/sandal_character\.b64\.(\d)\.txt$/.exec(u);
  if (m) { buf = getParts()[+m[1]]; type = TYPES['.txt']; }
  else if (u === '/health') { buf = Buffer.from('ok rooms=' + rooms.size); }
  else {
    const rel = u === '/' ? 'index.html' : u.replace(/^\/+/, ''), f = path.join(PUB, rel);
    if (f.startsWith(PUB) && fs.existsSync(f) && fs.statSync(f).isFile()) { buf = fs.readFileSync(f); type = TYPES[path.extname(f)] || 'application/octet-stream'; }
  }
  if (!buf) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' }); res.end(buf);
});
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const code = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s; do { s = ''; for (let i = 0; i < 4; i++) s += c[Math.random() * c.length | 0]; } while (rooms.has(s)); return s; };
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const names = r => [...r.players.values()].map(p => ({ id: p.id, name: p.name }));
function leave(ws) {
  const r = rooms.get(ws.room); if (!r) return;
  r.players.delete(ws.id);
  if (!r.players.size) { rooms.delete(ws.room); return; }
  if (r.host === ws.id) r.host = r.players.keys().next().value;
  for (const p of r.players.values()) send(p, { t: 'players', host: r.host, list: names(r) });
  ws.room = null;
}
wss.on('connection', ws => {
  ws.id = nextId++; ws.name = 'لاعب'; ws.room = null; ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'hello', id: ws.id });
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    if (m.t === 'create') {
      leave(ws); ws.name = String(m.name || 'لاعب').slice(0, 12); const c = code();
      rooms.set(c, { players: new Map([[ws.id, ws]]), host: ws.id }); ws.room = c;
      send(ws, { t: 'joined', code: c, host: ws.id, list: names(rooms.get(c)) });
    } else if (m.t === 'join') {
      const c = String(m.code || '').toUpperCase().trim(), r = rooms.get(c);
      if (!r) return send(ws, { t: 'error', msg: 'الكود غير موجود' });
      if (r.players.size >= 6) return send(ws, { t: 'error', msg: 'الغرفة ممتلئة' });
      leave(ws); ws.name = String(m.name || 'لاعب').slice(0, 12); r.players.set(ws.id, ws); ws.room = c;
      for (const p of r.players.values()) send(p, { t: p === ws ? 'joined' : 'players', code: c, host: r.host, list: names(r) });
    } else if (m.t === 'relay' && ws.room) {
      const r = rooms.get(ws.room); if (!r) return;
      const out = JSON.stringify({ t: 'relay', from: ws.id, d: m.d });
      for (const p of r.players.values()) if (p !== ws && p.readyState === 1) p.send(out);
    } else if (m.t === 'leave') leave(ws);
  });
  ws.on('close', () => leave(ws));
});
setInterval(() => { wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); }); }, 25000);
server.listen(process.env.PORT || 8080, () => console.log('listening'));
