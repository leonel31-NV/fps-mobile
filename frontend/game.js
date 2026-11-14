'use strict';
const $ = id => document.getElementById(id);
const BACKEND = (window.BACKEND_URL || '').replace(/\/$/, '') || location.origin;
const TFJS = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const COCO = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';
const COLORS = [
  { n: 'Vermelho', hue: 0, css: '#e53935' }, { n: 'Laranja', hue: 28, css: '#fb8c00' },
  { n: 'Amarelo', hue: 55, css: '#fdd835' }, { n: 'Verde', hue: 125, css: '#43a047' },
  { n: 'Azul', hue: 215, css: '#1e88e5' }, { n: 'Roxo', hue: 280, css: '#8e24aa' }];
const FIRE_MS = 260;

let socket, myId, roomCode = '', myName = '', pickedColor = 0, camReady = null;
let players = new Map();              // id -> estado do servidor { id, n, c, hp, ammo, rl, d, k, de }
let camStream = null, model = null;
let persons = [];                     // pessoas detectadas, caixas [x, y, w, h] em pixels do vídeo
let lock = null;                      // pessoa sob a mira: { p, s } (s = caixa em pixels de tela)
let firing = false, lastFire = 0, recoil = 0, flash = 0, hurt = 0, hitmark = 0, reloadAnim = 0;
let looping = false, detectRunning = false;
const cv = $('view'), ctx = cv.getContext('2d'), cam = $('cam');
const hueCv = document.createElement('canvas'); hueCv.width = hueCv.height = 24;
const hueCtx = hueCv.getContext('2d', { willReadFrequently: true });

const msg = t => { $('msg').textContent = t || ''; };
const setStatus = t => { $('status').textContent = t || ''; };
function resize() { const d = Math.min(2, devicePixelRatio || 1); cv.width = innerWidth * d; cv.height = innerHeight * d; ctx.setTransform(d, 0, 0, d, 0, 0); }
addEventListener('resize', resize); resize();

// ---------- Cores (identificam cada jogador pela roupa) ----------
COLORS.forEach((c, i) => {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'sw'; b.style.background = c.css;
  b.title = c.n; b.setAttribute('aria-label', c.n); b.setAttribute('aria-pressed', String(i === pickedColor));
  b.onclick = () => { pickedColor = i; [...$('colors').children].forEach((x, j) => x.setAttribute('aria-pressed', String(j === i))); };
  $('colors').appendChild(b);
});

// ---------- Som (sintetizado, sem arquivos) ----------
let ac = null, noise = null;
function audio() { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); return ac; } catch { return null; } }
function tone(type, f0, f1, dur, vol, delay = 0) {
  const a = audio(); if (!a) return; const t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
function sfxShot() {
  const a = audio(); if (!a) return; const t = a.currentTime;
  if (!noise) { noise = a.createBuffer(1, a.sampleRate * 0.5, a.sampleRate); const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const n = a.createBufferSource(), lp = a.createBiquadFilter(), g = a.createGain(); n.buffer = noise;
  lp.type = 'lowpass'; lp.frequency.setValueAtTime(7000, t); lp.frequency.exponentialRampToValueAtTime(500, t + 0.25);
  g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  n.connect(lp); lp.connect(g); g.connect(a.destination); n.start(t); n.stop(t + 0.35);
  tone('sine', 180, 40, 0.2, 0.9); // estampido grave
}
const sfxEmpty = () => tone('square', 1800, 1500, 0.04, 0.15);
const sfxReload = () => { tone('square', 700, 500, 0.05, 0.2); tone('square', 1000, 800, 0.05, 0.2, 0.9); };
const sfxHit = () => tone('sine', 1300, 900, 0.09, 0.35);
const sfxHurt = () => tone('sawtooth', 140, 60, 0.25, 0.4);

// ---------- Câmera e detector de pessoas (roda no aparelho) ----------
async function startCamera() {
  if (camStream) return '';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return window.isSecureContext ? 'Navegador sem suporte à câmera.' : 'A câmera exige HTTPS.';
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    cam.srcObject = camStream; cam.play().catch(() => {}); return '';
  } catch (e) {
    return { NotAllowedError: 'Permissão da câmera negada.', NotFoundError: 'Nenhuma câmera encontrada.', NotReadableError: 'Câmera em uso por outro app.' }[e.name] || 'Câmera indisponível.';
  }
}
function stopCamera() { if (camStream) camStream.getTracks().forEach(t => t.stop()); camStream = null; cam.srcObject = null; persons = []; }
const loadScript = src => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error(src)); document.head.appendChild(s); });
async function loadDetector() {
  if (model) return setStatus('Detector pronto. Aponte para um jogador.');
  setStatus('Carregando detector de pessoas… (só na 1ª vez)');
  try {
    if (!window.tf) await loadScript(TFJS);
    if (!window.cocoSsd) await loadScript(COCO);
    model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
    setStatus('Detector pronto. Aponte para um jogador.');
  } catch { setStatus('Não foi possível carregar o detector de pessoas. Verifique a internet e recarregue.'); }
}
async function detectLoop() {
  if ($('hud').hidden) { detectRunning = false; return; }
  if (model && camStream && cam.readyState >= 2 && cam.videoWidth && !document.hidden) {
    try {
      const preds = await model.detect(cam, 6, 0.4);
      persons = preds.filter(p => p.class === 'person').map(p => ({ box: p.bbox, score: p.score }));
    } catch { persons = []; }
  }
  setTimeout(detectLoop, 60);
}
function toScreen(b) { // vídeo usa object-fit: cover
  const vw = cam.videoWidth, vh = cam.videoHeight, W = innerWidth, H = innerHeight, s = Math.max(W / vw, H / vh);
  return { x: (W - vw * s) / 2 + b[0] * s, y: (H - vh * s) / 2 + b[1] * s, w: b[2] * s, h: b[3] * s };
}
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
function sampleHue(b) { // cor dominante do tronco da pessoa
  const vw = cam.videoWidth, vh = cam.videoHeight;
  const sx = Math.max(0, b[0] + b[2] * 0.25), sy = Math.max(0, b[1] + b[3] * 0.15);
  const sw = Math.min(vw - sx, b[2] * 0.5), sh = Math.min(vh - sy, b[3] * 0.4); if (sw < 4 || sh < 4) return null;
  hueCtx.drawImage(cam, sx, sy, sw, sh, 0, 0, 24, 24);
  const d = hueCtx.getImageData(0, 0, 24, 24).data; let vx = 0, vy = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, bl = d[i + 2] / 255, max = Math.max(r, g, bl), df = max - Math.min(r, g, bl);
    if (max < 0.25 || df / max < 0.35) continue; // ignora pixels escuros ou sem cor
    let h = max === r ? ((g - bl) / df) % 6 : max === g ? (bl - r) / df + 2 : (r - g) / df + 4; h *= Math.PI / 3;
    vx += Math.cos(h) * df; vy += Math.sin(h) * df; n++;
  }
  return n < 24 * 24 * 0.1 ? null : (Math.atan2(vy, vx) * 180 / Math.PI + 360) % 360;
}
function identify(box) { // qual jogador é a pessoa sob a mira?
  const foes = [...players.values()].filter(p => p.id !== myId && !p.d);
  if (!foes.length) return null;
  if (foes.length === 1) return foes[0].id;
  const hue = sampleHue(box); if (hue === null) return null;
  let best = null, bd = 999;
  for (const f of foes) { const d = hueDist(hue, COLORS[f.c].hue); if (d < bd) { bd = d; best = f; } }
  return bd <= 40 ? best.id : null;
}

// ---------- Rede ----------
function loadSocketLib() {
  return new Promise((ok, fail) => {
    if (window.io) return ok();
    const s = document.createElement('script'); s.src = BACKEND + '/socket.io/socket.io.js';
    s.onload = ok; s.onerror = () => fail(new Error('Não foi possível alcançar o servidor.')); document.head.appendChild(s);
  });
}
async function connect() {
  if (socket) return socket;
  await loadSocketLib();
  socket = io(BACKEND, { transports: ['websocket', 'polling'] });
  socket.on('connect', () => { myId = socket.id; if (roomCode && !$('hud').hidden) rejoin(); });
  socket.on('state', list => {
    const seen = new Set();
    for (const s of list) { seen.add(s.id); players.set(s.id, s); }
    for (const id of players.keys()) if (!seen.has(id)) players.delete(id);
    updateHud();
  });
  socket.on('shot', e => {
    if (e.id === myId && e.hit) { hitmark = 1; sfxHit(); }
    if (e.hit === myId) { hurt = 1; sfxHurt(); navigator.vibrate && navigator.vibrate(90); }
  });
  socket.on('kill', e => feed(e.byName + ' eliminou ' + e.victimName));
  return socket;
}
async function wake() { try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch {} }
function enter(code) {
  roomCode = code; $('lobby').hidden = true; $('hud').hidden = false; $('roomcode').textContent = 'Sala ' + code;
  setStatus('Iniciando câmera…');
  camReady.then(err => err ? setStatus(err + ' Sem câmera não dá para detectar pessoas.') : loadDetector());
  wake();
  if (!looping) { looping = true; requestAnimationFrame(loop); }
  if (!detectRunning) { detectRunning = true; detectLoop(); }
}
function rejoin() { // reconexão: entra de novo na mesma sala, se ainda existir
  socket.emit('join', { code: roomCode, name: myName, color: pickedColor }, r => { if (!r.ok) { feed(r.error); leaveRoom(); } });
}
async function lobbyAction(kind) {
  myName = $('name').value.trim() || 'Jogador'; msg('Conectando…');
  audio(); camReady = startCamera(); // dentro do toque do usuário, para o navegador permitir câmera e som
  try { await connect(); } catch (e) { stopCamera(); return msg(e.message); }
  const done = r => { if (!r.ok) { stopCamera(); return msg(r.error); } msg(''); pickedColor = r.color; enter(r.code); };
  if (kind === 'create') socket.emit('create', { name: myName, color: pickedColor }, done);
  else socket.emit('join', { code: $('code').value, name: myName, color: pickedColor }, done);
}
function leaveRoom() {
  socket && socket.emit('leave'); roomCode = ''; players.clear(); stopCamera(); setStatus('');
  $('hud').hidden = true; $('lobby').hidden = false;
}
$('create').onclick = () => lobbyAction('create');
$('join').onclick = () => lobbyAction('join');
$('quit').onclick = leaveRoom;

// ---------- HUD ----------
function feed(t) { const d = document.createElement('div'); d.textContent = t; $('feed').appendChild(d); setTimeout(() => d.remove(), 4000); }
function updateHud() {
  const me = players.get(myId); if (!me) return;
  $('hpfill').style.width = me.hp + '%'; $('ammo').textContent = me.rl ? 'Recarregando…' : me.ammo + ' / 12';
  $('dead').hidden = !me.d;
  const mc = $('mycolor'); mc.style.background = COLORS[me.c].css; mc.textContent = 'Sua cor: ' + COLORS[me.c].n;
  const ul = $('board'); ul.textContent = '';
  [...players.values()].sort((a, b) => b.k - a.k).forEach(p => {
    const li = document.createElement('li'); if (p.id === myId) li.className = 'me';
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = COLORS[p.c].css;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.n;
    const sc = document.createElement('b'); sc.textContent = p.k + '/' + p.de;
    li.append(dot, nm, sc); ul.appendChild(li);
  });
}

// ---------- Controles ----------
function fire() {
  const now = performance.now(), me = players.get(myId);
  if (!socket || !me || me.d || me.rl || now - lastFire < FIRE_MS) return;
  lastFire = now;
  if (me.ammo <= 0) { sfxEmpty(); socket.emit('reload'); return; }
  const target = lock ? identify(lock.p.box) : null;
  socket.emit('shoot', { target });
  recoil = 1; flash = 1; sfxShot(); navigator.vibrate && navigator.vibrate(20);
  if (lock && !target) feed('Pessoa detectada, mas não identificada (confira a cor).');
}
function reload() { const me = players.get(myId); if (socket && me && !me.rl && me.ammo < 12) { socket.emit('reload'); sfxReload(); } }
const fb = $('fire');
fb.addEventListener('pointerdown', e => { firing = true; audio(); fb.setPointerCapture(e.pointerId); });
['pointerup', 'pointercancel'].forEach(t => fb.addEventListener(t, () => firing = false));
$('rld').addEventListener('pointerdown', reload);
addEventListener('keydown', e => { if (e.target.tagName === 'INPUT') return; if (e.code === 'Space') { firing = true; e.preventDefault(); } if (e.code === 'KeyR') reload(); });
addEventListener('keyup', e => { if (e.code === 'Space') firing = false; });

// ---------- Desenho ----------
function drawBrackets(s, locked) {
  const k = Math.max(10, Math.min(36, Math.min(s.w, s.h) * 0.18)), r = s.x + s.w, b = s.y + s.h;
  ctx.strokeStyle = locked ? '#ff5a4d' : 'rgba(255,176,32,.85)'; ctx.lineWidth = 3; ctx.beginPath();
  ctx.moveTo(s.x, s.y + k); ctx.lineTo(s.x, s.y); ctx.lineTo(s.x + k, s.y);
  ctx.moveTo(r - k, s.y); ctx.lineTo(r, s.y); ctx.lineTo(r, s.y + k);
  ctx.moveTo(s.x, b - k); ctx.lineTo(s.x, b); ctx.lineTo(s.x + k, b);
  ctx.moveTo(r - k, b); ctx.lineTo(r, b); ctx.lineTo(r, b - k); ctx.stroke();
  if (locked) { ctx.fillStyle = '#ff5a4d'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center'; ctx.fillText('ALVO', s.x + s.w / 2, Math.max(14, s.y - 6)); }
}
function drawCrosshair(W, H) {
  const cx = W / 2, cy = H / 2, c = lock ? '#ff5a4d' : '#ffb020';
  ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, 16, 0, 7);
  ctx.moveTo(cx - 24, cy); ctx.lineTo(cx - 8, cy); ctx.moveTo(cx + 8, cy); ctx.lineTo(cx + 24, cy);
  ctx.moveTo(cx, cy - 24); ctx.lineTo(cx, cy - 8); ctx.moveTo(cx, cy + 8); ctx.lineTo(cx, cy + 24); ctx.stroke();
  if (hitmark > 0) { // marcador de acerto
    ctx.strokeStyle = `rgba(255,255,255,${hitmark})`; ctx.lineWidth = 3; ctx.beginPath();
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { ctx.moveTo(cx + dx * 10, cy + dy * 10); ctx.lineTo(cx + dx * 22, cy + dy * 22); }
    ctx.stroke(); hitmark -= 0.06;
  }
}
function drawWeapon(W, H) {
  const s = Math.min(W, H) / 420 * 1.15;
  ctx.save(); ctx.translate(W * 0.55, H + (10 + recoil * 26 + reloadAnim * 150) * s); ctx.rotate(-recoil * 0.05); ctx.scale(s, s);
  ctx.fillStyle = '#15181b'; ctx.beginPath(); ctx.moveTo(-30, 20); ctx.lineTo(-22, -72); ctx.lineTo(28, -72); ctx.lineTo(38, 20); ctx.closePath(); ctx.fill(); // empunhadura
  ctx.strokeStyle = '#242a30'; ctx.lineWidth = 2;
  for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(-26 + i * 1.5, -58 + i * 14); ctx.lineTo(30 + i * 1.5, -58 + i * 14); ctx.stroke(); }
  const g = ctx.createLinearGradient(-30, 0, 30, 0); g.addColorStop(0, '#2b3238'); g.addColorStop(.5, '#4f5a63'); g.addColorStop(1, '#2b3238');
  ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(-28, -64); ctx.lineTo(-17, -170); ctx.lineTo(17, -170); ctx.lineTo(28, -64); ctx.closePath(); ctx.fill(); // ferrolho
  ctx.strokeStyle = '#78848e'; ctx.beginPath(); ctx.moveTo(-17, -170); ctx.lineTo(17, -170); ctx.stroke();
  ctx.fillStyle = '#0d0f11'; ctx.fillRect(-18, -84, 10, 9); ctx.fillRect(8, -84, 10, 9); ctx.fillRect(-3, -182, 6, 13); // miras
  if (flash > 0.05) { // clarão do disparo
    const r = 50 + 30 * flash, gr = ctx.createRadialGradient(0, -185, 2, 0, -185, r);
    gr.addColorStop(0, `rgba(255,250,200,${flash})`); gr.addColorStop(.4, `rgba(255,170,40,${flash * .8})`); gr.addColorStop(1, 'rgba(255,80,0,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, -185, r, 0, 7); ctx.fill();
  }
  ctx.restore();
}
function loop() {
  if ($('hud').hidden) { looping = false; return; }
  if (firing) fire();
  const W = innerWidth, H = innerHeight, cx = W / 2, cy = H / 2, me = players.get(myId); ctx.clearRect(0, 0, W, H);
  lock = null; const boxes = []; let best = 1e9;
  if (camStream && cam.videoWidth) for (const p of persons) {
    const s = toScreen(p.box); boxes.push(s);
    if (cx >= s.x - 0.05 * s.w && cx <= s.x + 1.05 * s.w && cy >= s.y - 0.03 * s.h && cy <= s.y + 1.03 * s.h) {
      const d = Math.hypot(s.x + s.w / 2 - cx, s.y + s.h / 2 - cy); if (d < best) { best = d; lock = { p, s }; }
    }
  }
  for (const s of boxes) drawBrackets(s, lock && lock.s === s);
  drawCrosshair(W, H);
  reloadAnim += ((me && me.rl ? 1 : 0) - reloadAnim) * 0.15;
  drawWeapon(W, H); recoil *= 0.82; flash *= 0.6;
  if (hurt > 0) { ctx.fillStyle = `rgba(255,50,40,${hurt * 0.4})`; ctx.fillRect(0, 0, W, H); hurt -= 0.04; }
  requestAnimationFrame(loop);
}
