'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// Regras do jogo (o servidor é a autoridade)
const C = { ARENA: 25, SPEED: 6, HP: 100, MAG: 12, DMG: 25, FIRE_MS: 250, RELOAD_MS: 1800,
  RESPAWN_MS: 3000, HIT_R: 0.9, RANGE: 40, MAX_PLAYERS: 8, TICK_MS: 50, MAX_EVT_PER_S: 60 };

const app = express();
app.get('/health', (_q, r) => r.send('ok'));
if (process.env.SERVE_FRONTEND === 'true') app.use(express.static(path.join(__dirname, '..', 'frontend')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: origins.length ? origins : false }, transports: ['websocket', 'polling'] });

const rooms = new Map(); // código -> { code, players: Map }
const rand = (a, b) => a + Math.random() * (b - a);
const num = (v, lo, hi, d = 0) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const cleanName = n => String(n || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 12) || 'Jogador';
const newCode = () => { let c; do { c = Math.random().toString(36).slice(2, 7).toUpperCase(); } while (rooms.has(c)); return c; };

function spawn(p) { p.x = rand(-C.ARENA + 2, C.ARENA - 2); p.y = rand(-C.ARENA + 2, C.ARENA - 2);
  p.hp = C.HP; p.ammo = C.MAG; p.reloadAt = 0; p.deadAt = 0; p.dead = false; }
function addPlayer(room, socket, name) {
  const p = { id: socket.id, name: cleanName(name), x: 0, y: 0, yaw: 0, mx: 0, my: 0, kills: 0, deaths: 0, lastShot: 0 };
  spawn(p); room.players.set(socket.id, p); socket.join(room.code); socket.data.code = room.code; return p;
}
function leave(socket) {
  const code = socket.data.code; const room = rooms.get(code); if (!room) return;
  room.players.delete(socket.id); socket.leave(code); socket.data.code = null;
  if (room.players.size === 0) rooms.delete(code); else io.to(code).emit('left', socket.id);
}
function startReload(p, now) { if (!p.dead && !p.reloadAt && p.ammo < C.MAG) p.reloadAt = now + C.RELOAD_MS; }

io.on('connection', socket => {
  let count = 0, windowStart = Date.now();
  const allowed = () => { const t = Date.now(); if (t - windowStart > 1000) { windowStart = t; count = 0; } return ++count <= C.MAX_EVT_PER_S; };
  const me = () => { const r = rooms.get(socket.data.code); return r && r.players.get(socket.id); };

  socket.on('create', (name, cb) => {
    if (typeof cb !== 'function' || !allowed() || socket.data.code) return;
    const code = newCode(); const room = { code, players: new Map() }; rooms.set(code, room);
    addPlayer(room, socket, name); cb({ ok: true, code });
  });
  socket.on('join', (d, cb) => {
    if (typeof cb !== 'function' || !allowed() || socket.data.code) return;
    const code = String((d && d.code) || '').toUpperCase().trim(); const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Sala não encontrada.' });
    if (room.players.size >= C.MAX_PLAYERS) return cb({ ok: false, error: 'Sala cheia.' });
    addPlayer(room, socket, d.name); cb({ ok: true, code });
  });
  socket.on('input', d => { const p = me(); if (!p || !d || !allowed()) return;
    p.mx = num(d.mx, -1, 1); p.my = num(d.my, -1, 1); p.yaw = num(d.yaw, -1e4, 1e4, p.yaw); });
  socket.on('reload', () => { const p = me(); if (p && allowed()) startReload(p, Date.now()); });
  socket.on('shoot', () => {
    const p = me(); const room = rooms.get(socket.data.code); if (!p || !room || !allowed()) return;
    const now = Date.now();
    if (p.dead || p.reloadAt || p.ammo <= 0 || now - p.lastShot < C.FIRE_MS) return;
    p.lastShot = now; p.ammo--; if (p.ammo === 0) startReload(p, now);
    const fx = Math.sin(p.yaw), fy = Math.cos(p.yaw); let best = null, bestD = Infinity;
    for (const t of room.players.values()) {
      if (t.id === p.id || t.dead) continue; // sem dano em si mesmo
      const dx = t.x - p.x, dy = t.y - p.y, along = dx * fx + dy * fy, side = Math.abs(dx * fy - dy * fx);
      if (along > 0 && along <= C.RANGE && side <= C.HIT_R && along < bestD) { best = t; bestD = along; }
    }
    if (best) { best.hp -= C.DMG;
      if (best.hp <= 0) { best.hp = 0; best.dead = true; best.deadAt = now + C.RESPAWN_MS; best.deaths++; p.kills++;
        io.to(room.code).emit('kill', { by: p.id, victim: best.id, byName: p.name, victimName: best.name }); } }
    io.to(room.code).emit('shot', { id: p.id, hit: best ? best.id : null });
  });
  socket.on('leave', () => leave(socket));
  socket.on('disconnect', () => leave(socket));
});

let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (p.dead && now >= p.deadAt) spawn(p);
      if (p.reloadAt && now >= p.reloadAt) { p.ammo = C.MAG; p.reloadAt = 0; }
      if (!p.dead) { const fx = Math.sin(p.yaw), fy = Math.cos(p.yaw), rx = Math.cos(p.yaw), ry = -Math.sin(p.yaw);
        const len = Math.hypot(p.mx, p.my) || 1, k = Math.min(1, len) / len;
        p.x = Math.max(-C.ARENA, Math.min(C.ARENA, p.x + (fx * p.my + rx * p.mx) * k * C.SPEED * dt));
        p.y = Math.max(-C.ARENA, Math.min(C.ARENA, p.y + (fy * p.my + ry * p.mx) * k * C.SPEED * dt)); }
    }
    io.to(room.code).volatile.emit('state', [...room.players.values()].map(p => ({ id: p.id, n: p.name,
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), yaw: +p.yaw.toFixed(3), hp: p.hp, ammo: p.ammo,
      rl: !!p.reloadAt, d: p.dead, k: p.kills, de: p.deaths })));
  }
}, C.TICK_MS);

server.listen(PORT, '0.0.0.0', () => console.log('Servidor FPS na porta ' + PORT));
