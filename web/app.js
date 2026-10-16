/* Agent Office — cartoon office for OpenCode sessions.
 * Floor: one card per root session.
 * Room: animated virtual office. Each agent/sub-agent session is an actor:
 * walks in through the door, finds a chair, works (types/hammers/thinks),
 * roams to the wall desk / whiteboard / coffee, naps on the couch when idle,
 * and walks out when archived. rAF simulation; polled data only sets goals. */
'use strict';

const $ = (s) => document.querySelector(s);
const LOOP_MS = 2200;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function hashF(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1000) / 1000; }

/* ---------------------------------------------------------------- routes */
function route() {
  const m = location.hash.match(/^#\/room\/(.+)$/);
  if (m) showRoom(m[1]); else showFloor();
}
window.addEventListener('hashchange', route);

/* ---------------------------------------------------------------- utils */
async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function note(t) { $('#viewNote').textContent = t; }

/* ================================================================ FLOOR
   Home page = the building: ONE shared open-plan virtual office. Each root
   session is a desk pod (own table + name sign) on the same floor. Real
   sub-agent sessions walk through the single office door: they enter when
   they start working and walk out the moment their report is filed.
   Click a table to open its meeting room.                              */
let floorTimer = null, liveTimer = null, flRaf = 0, flLast = 0;
const FLD = { el: null, pods: new Map(), ghosts: [], briefKey: '', doorT: 0, seeded: false, door: { x: 50, y: 150 } };
const FL_MAX_PODS = 18;
const FL_SEATS = [2.35, 0.8, -0.8, -2.35, Math.PI, 0];

function showFloor() {
  stopRoom(); stopFloor();
  $('#floorView').hidden = false; $('#roomView').hidden = true;
  floorScenery();
  loadSessions(); loadLive();
  floorTimer = setInterval(loadSessions, LOOP_MS * 2);
  liveTimer = setInterval(loadLive, LOOP_MS);
  flLast = 0;
  flRaf = requestAnimationFrame(flFrame);
}
function stopFloor() {
  clearInterval(floorTimer); clearInterval(liveTimer);
  floorTimer = liveTimer = null;
  cancelAnimationFrame(flRaf); flRaf = 0;
  clearTimeout(FLD.doorT);
  if (FLD.el) { FLD.el.querySelectorAll('.actor').forEach((n) => n.remove()); }
  FLD.pods.forEach((p) => { p.lead = null; p.kids.clear(); });
  FLD.pods.clear(); FLD.ghosts.length = 0; FLD.seeded = false; FLD.el = null;
}

function floorScenery() {
  const st = $('#floorStage');
  if (FLD.el === st && st.childElementCount) return;
  FLD.el = st;
  st.innerHTML = `
    <div class="skirt"></div>
    <div class="door-frame" id="bdoor">
      <div class="sign"><span class="led"></span><span class="sign-t">office</span></div>
      <div class="hole"></div><div class="door-leaf"></div></div>
    <div class="stage-board wallbrief"><h4>THE BOARD</h4><ul id="floorBrief"></ul></div>
    <div class="wall-clock"><i></i></div>
    <div class="window"><span class="sun"></span><span class="cloud"></span></div>
    <div class="plant"><div class="pot"></div><div class="leaf l1"></div><div class="leaf l2"></div><div class="leaf l3"></div></div>
    <div class="fl-pour"><span class="steam">∿</span>☕</div>`;
}

async function loadSessions() {
  try {
    const rooms = await getJSON('/api/sessions');
    flLayout(rooms);
    const busy = rooms.filter((r) => r.busy).length;
    let inside = 0;
    FLD.pods.forEach((p) => { inside += 1 + p.kids.size; });
    $('#viewNote').textContent = `${FLD.pods.size} desk pods · ${inside} bots inside · ${busy} buzzin`;
  } catch (e) { note(`floor: ${e.message}`); }
}

function flLayout(rooms) {
  const st = FLD.el, W = st.clientWidth;
  const cols = clamp(Math.floor((W - 60) / 252), 2, 6);
  const cw = (W - 60) / cols, ch = 216;
  const shown = rooms.slice(0, FL_MAX_PODS);
  const liveIds = new Set(shown.map((r) => r.id));
  // 1) geometry first so spawns can path against it
  shown.forEach((r, i) => { const p = flPod(r.id, i); p.slot = i; });
  const seated = [...FLD.pods.values()].filter((p) => liveIds.has(p.id)).sort((a, b) => a.slot - b.slot);
  const rows = Math.max(1, Math.ceil(seated.length / cols));
  st.style.height = Math.max(560, 150 + rows * ch + 30) + 'px';
  FLD.door = { x: 64, y: 168 };
  seated.forEach((p, i) => {
    const j = hashF(p.id), j2 = hashF(p.id + 'y');       // organic placement, stable per room
    p.rx = Math.min(66, cw * 0.27) * (0.85 + j * 0.3);   // desks a bit bigger/smaller
    p.ry = 24 + Math.round(j2 * 6);
    p.x = clamp(30 + cw * (i % cols) + cw / 2 + (j - 0.5) * 44, 120, W - 95);
    p.y = 150 + Math.floor(i / cols) * ch + 78 + (j2 - 0.5) * 48;
    p.lane = { x: p.x, y: p.y + p.ry + 46 };
    p.rot = (j - 0.5) * 4;                                // sign tape tilt, degrees
  });
  // 2) match people to pods
  shown.forEach((r, i) => {
    const p = FLD.pods.get(r.id);
    p.r = r; p.seen = performance.now();
    flSign(p, r);
    if (!p.lead) p.lead = flSpawn(p, r.agent || 'lead', null, !FLD.seeded);
    for (const k of (r.crew_live || []).slice(0, FL_SEATS.length)) {
      if (!p.kids.has(k.id)) { p.kids.set(k.id, flSpawn(p, k.agent, k.id, false)); flDoor(r.busy ? 'worker arrived' : ''); }
    }
    // finished sub-agents (dropped from crew_live) immediately clock out
    const liveKids = new Set((r.crew_live || []).map((k) => k.id));
    for (const [kid, a] of [...p.kids]) {
      if (!liveKids.has(kid) && a.mode !== 'exit') { p.kids.delete(kid); flLeave(p, a); }
    }
  });
  FLD.seeded = true;
  for (const [id, p] of [...FLD.pods]) {
    const gone = !liveIds.has(id) || performance.now() - p.seen > LOOP_MS * 4.5;
    if (gone) flDropPod(p);
  }
  // 3) props to their pods
  seated.forEach((p) => {
    p.tabEl.style.left = (p.x - p.rx) + 'px'; p.tabEl.style.top = (p.y - p.ry) + 'px';
    p.tabEl.style.width = p.rx * 2 + 'px'; p.tabEl.style.height = p.ry * 2 + 'px';
    p.tabEl.classList.toggle('idle', !(p.r && p.r.busy));
    p.tabEl.classList.toggle('stale', !!(p.r && Date.now() - p.r.time_updated > 6 * 3600e3));
    p.signEl.style.left = p.x + 'px'; p.signEl.style.top = (p.y - p.ry - 34) + 'px';
    p.signEl.style.transform = `translate(-50%,-100%) rotate(${p.rot ? p.rot.toFixed(2) : 0}deg)`;
    p.signEl.classList.toggle('busy', !!(p.r && p.r.busy));
    p.hitEl.style.left = p.x + 'px'; p.hitEl.style.top = p.y + 'px';
  });
  flBoard(shown);
}

function flPod(id, slot) {
  let p = FLD.pods.get(id);
  if (p) return p;
  const tab = document.createElement('div'); tab.className = 'fl-tab';
  const sign = document.createElement('div'); sign.className = 'fl-sign';
  const hit = document.createElement('div'); hit.className = 'fl-hit';
  const go = () => { location.hash = '#/room/' + id; };
  sign.addEventListener('click', go); tab.addEventListener('click', go);
  FLD.el.append(tab, hit, sign);
  p = { id, slot, r: null, x: 0, y: 0, rx: 60, ry: 27, lead: null, kids: new Map(),
        seatN: 1, tabEl: tab, signEl: sign, hitEl: hit, seen: 0 };
  FLD.pods.set(id, p);
  return p;
}
function flSign(p, r) {
  const s = p.signEl;
  const t = r.title.length > 28 ? r.title.slice(0, 27) + '…' : r.title;
  const txt = `${t} · ${r.kids_live || r.crew_live.length || ''}`.replace(/ · $/, '');
  const ttl = `${r.title}\n${r.kids} spawned (${r.kids_active} live) · ${r.status}`;
  if (p._s1 !== txt) { s.textContent = txt; p._s1 = txt; }
  if (p._s2 !== ttl) { s.title = ttl; p._s2 = ttl; }
  s.classList.toggle('busy', !!r.busy);
}
function flDropPod(p) {
  // pod leaves the building: everyone lines up to the door, props fade later.
  // Actors join the ghost list so they KEEP walking after their pod is gone.
  const walkOut = (a) => {
    if (!a) return;
    a.mode = 'exit';
    a.pts = [p.lane || { x: a.x, y: FLD.door.y }, { x: FLD.door.x + 18, y: FLD.door.y + 18 }, { x: FLD.door.x - 30, y: FLD.door.y }];
    a.pi = 0;
    FLD.ghosts.push({ a, born: performance.now() });
  };
  flDoor('heading out');
  walkOut(p.lead); p.lead = null;
  p.kids.forEach(walkOut);
  p.kids.clear();
  FLD.pods.delete(p.id);
  p.tabEl.classList.add('gone'); p.signEl.classList.add('gone');
  setTimeout(() => { p.tabEl.remove(); p.signEl.remove(); p.hitEl.remove(); }, 900);
}

/* ---------------- actors ---------------- */
function flSeat(p, n) {
  const ang = FL_SEATS[Math.min(n, FL_SEATS.length - 1)];
  return { x: p.x + Math.cos(ang) * (p.rx + 26), y: p.y + Math.sin(ang) * (p.ry + 22), ang };
}
function flSpawn(p, role, kid, instant) {
  const node = makeActor(role, false);
  node.classList.add('mini');
  FLD.el.appendChild(node);
  const seat = flSeat(p, kid == null ? 0 : p.seatN++);
  const a = { node, role, sit: seat, seatI: kid == null ? 0 : p.seatN - 1, pod: p,
              x: seat.x, y: seat.y, face: 'D', mode: instant ? 'sit' : 'enter',
              pts: null, pi: 0, moving: false, typing: false, lead: kid == null, dying: false };
  if (!instant) {
    flDoor(null);
    a.x = FLD.door.x - 8; a.y = FLD.door.y; a.face = 'R';
    a.pts = [{ x: FLD.door.x + 26, y: FLD.door.y + 26 }, { x: p.x - p.rx - 40, y: p.lane.y }, p.lane, seat];
    a.pi = 0;
  }
  return a;
}
function flLeave(p, a) {
  a.mode = 'exit';
  flDoor('goodbye');
  a.pts = [p.lane, { x: FLD.door.x + 18, y: FLD.door.y + 18 }, { x: FLD.door.x - 30, y: FLD.door.y }];
  a.pi = 0;
  FLD.ghosts.push({ a, born: performance.now() });   // keep stepping after checkout
}
function flDoor(what) {
  const f = $('#bdoor'); if (!f) return;
  f.classList.add('open');
  const t = f.querySelector('.sign-t'); if (t && what) t.textContent = what;
  clearTimeout(FLD.doorT);
  FLD.doorT = setTimeout(() => { f.classList.remove('open'); if (t) t.textContent = 'office'; }, 1600);
}

/* ---------------- stepping + drawing ---------------- */
const FL_SPEED = 86;
function flStep(a, dt) {
  if (a.mode === 'enter' || a.mode === 'exit') {
    let budget = FL_SPEED * dt * (S ? S.speed : 1);
    a.moving = true;
    while (budget > 0 && a.pi < (a.pts ? a.pts.length : 0)) {
      const w = a.pts[a.pi], dx = w.x - a.x, dy = w.y - a.y, d = Math.hypot(dx, dy);
      if (d < 2.5) { a.pi++; continue; }
      const mv = Math.min(budget, d);
      a.x += dx / d * mv; a.y += dy / d * mv; budget -= mv;
      if (Math.abs(dx) > Math.abs(dy) * 1.2) a.face = dx > 0 ? 'R' : 'L';
      else if (Math.abs(dy) > Math.abs(dx) * 1.5) a.face = dy > 0 ? 'D' : 'U';
    }
    if (a.pi >= (a.pts ? a.pts.length : 0)) {
      a.pts = null; a.moving = false;
      if (a.mode === 'enter') a.mode = 'sit';
      else if (a.mode === 'exit' && a.node.isConnected) a.node.remove();
    }
  } else if (a.mode === 'sit') {
    const seat = flSeat(a.pod, a.seatI);
    a.sit = seat; a.x = seat.x; a.y = seat.y; a.moving = false;
    a.face = Math.abs(seat.ang) > 1.3 ? (seat.ang > 0 ? 'U' : 'D')
           : (seat.x < a.pod.x ? 'R' : 'L');
  }
}
const FL_K = () => clamp((FLD.el ? FLD.el.clientWidth : 1000) / 1540, .46, .68);
function flDraw(a) {
  const n = a.node;
  const k = FL_K();
  n.style.transform = `translate(${a.x.toFixed(1)}px,${a.y.toFixed(1)}px) scale(${k.toFixed(3)}) translate(-38px,-104px)`;
  n.style.zIndex = 400 + Math.round(a.y);
  n.classList.toggle('moving', !!a.moving);
  n.classList.toggle('faceL', a.face === 'L');
  n.classList.toggle('faceUp', a.face === 'U');
  const seated = a.mode === 'sit';
  n.classList.toggle('seated', seated);
  const busy = a.pod.r && a.pod.r.busy;
  n.classList.toggle('typing', seated && busy);
  n.classList.toggle('gazing', seated && !busy && a.lead && hashF(a.role) > 0.5);
  n.classList.toggle('zzz-on', seated && !busy);
  const lap = n.querySelector('.screen');
  if (lap) lap.style.opacity = seated && busy ? 1 : 0;
}
function flFrame(t) {
  if ($('#floorView').hidden) { flRaf = 0; return; }
  const dt = Math.min(0.06, (flLast ? (t - flLast) / 1000 : 0.016)); flLast = t;
  try {
    FLD.pods.forEach((p) => {
      if (p.lead) { flStep(p.lead, dt); flDraw(p.lead); }
      p.kids.forEach((a) => { flStep(a, dt); flDraw(a); });
    });
    // departed actors: walk until through the door, then off the DOM
    for (let i = FLD.ghosts.length - 1; i >= 0; i--) {
      const g = FLD.ghosts[i];
      flStep(g.a, dt);
      if (g.a.node.isConnected) flDraw(g.a);
      if (!g.a.node.isConnected || performance.now() - g.born > 14000) {
        g.a.node.remove();
        FLD.ghosts.splice(i, 1);
      }
    }
  } catch (e) { console.error('[floor]', e); }
  flRaf = requestAnimationFrame(flFrame);
}
function flBoard(rooms) {
  const items = rooms.filter((r) => r.busy || r.kids_active)
    .slice(0, 5).map((r) => `${r.kids_active ? `◎ ${r.kids_active} working: ` : '▶ '}${r.title}`.slice(0, 44));
  const key = items.join('|');
  if (key === FLD.briefKey) return;
  FLD.briefKey = key;
  const ul = $('#floorBrief');
  ul.innerHTML = items.map((i) => `<li>${esc(i)}</li>`).join('') || '<li>quiet day — every report filed</li>';
  const w = ul.closest('.stage-board'); w.classList.remove('pop'); void w.offsetWidth; w.classList.add('pop');
}

async function loadLive() {
  try {
    const { rooms } = await getJSON('/api/live');
    const actives = rooms.filter((r) => r.busy > 0);
    const strip = $('#liveStrip');
    strip.innerHTML = actives.length
      ? actives.map((r) => `
        <div class="live-chip busy" data-id="${esc(r.root)}">
          <b>${r.busy}/${r.people} in use</b> · ${esc(r.title)}
          <span class="who">${esc(r.activity_role || '')}: ${esc(r.activity || 'working…')}</span>
        </div>`).join('')
      : '<span class="none">all meeting rooms look quiet right now ☕</span>';
    strip.querySelectorAll('.live-chip').forEach((c) =>
      c.addEventListener('click', () => { location.hash = `#/room/${c.dataset.id}`; }));
  } catch { /* transient */ }
}

/* ================================================================ ART */
const TINT = {
  build: '#4a8fd6', developer: '#5cb85c', tester: '#e67e22', reviewer: '#9b59b6',
  explore: '#16a085', pm: '#e74c3c', requirements: '#f1c40f', 'doc-writer': '#3498db',
  devops: '#7f8c8d', general: '#b5838d', user: '#2b2b2b', lead: '#4a8fd6', default: '#b0a891',
};
const LAPTOP_ROLES = ['build', 'developer', 'general', 'pm', 'requirements', 'doc-writer'];
const HAIRS = ['#585048', '#2b2b2b', '#8a5a2b', '#6e4b8c', '#37474f', '#7a3030'];
const PROPS = {
  tester: '<circle cx="63" cy="72" r="7" fill="#cfe6f7" stroke="#2b2b2b" stroke-width="2.4"/><line x1="68" y1="77" x2="73" y2="83" stroke="#2b2b2b" stroke-width="3" stroke-linecap="round"/>',
  explore: '<circle cx="63" cy="72" r="7" fill="#cfe6f7" stroke="#2b2b2b" stroke-width="2.4"/><line x1="68" y1="77" x2="73" y2="83" stroke="#2b2b2b" stroke-width="3" stroke-linecap="round"/>',
  reviewer: '<g stroke="#2b2b2b" stroke-width="2" fill="#cfe6f7"><circle cx="59" cy="72" r="4"/><circle cx="68" cy="72" r="4"/></g>',
  pm: '<path d="M55 78 L71 69 V87 Z M50 72 v8 h5 v-8z" fill="#f5a623" stroke="#2b2b2b" stroke-width="2" stroke-linejoin="round"/>',
  requirements: '<rect x="57" y="64" width="12" height="16" rx="2" fill="#f2e5c9" stroke="#2b2b2b" stroke-width="2"/>',
  'doc-writer': '<rect x="57" y="64" width="12" height="16" rx="2" fill="#fff" stroke="#2b2b2b" stroke-width="2"/><line x1="73" y1="82" x2="66" y2="68" stroke="#2b2b2b" stroke-width="2.6" stroke-linecap="round"/>',
  devops: '<path d="M59 82 L69 70 a5 5 0 1 1 4 4 L63 86 Z" fill="#9aa5a8" stroke="#2b2b2b" stroke-width="2"/>',
  general: '<path d="M55 78 q9 -8 18 0 v-14 q-9 -8 -18 0 z" fill="#e8d9c0" stroke="#2b2b2b" stroke-width="2"/>',
  user: '<path d="M57 68 h12 v12 a6 6 0 0 1 -12 0z M69 71 h3 a2.5 2.5 0 0 1 0 5 h-1" fill="#fff" stroke="#2b2b2b" stroke-width="2"/>',
  default: '<rect x="57" y="66" width="12" height="14" rx="3" fill="#d9cfc0" stroke="#2b2b2b" stroke-width="2"/>',
};
// laptop: base always; screen panel folds down while walking, up when seated
const LAP = `<g class="lap">
  <rect x="23" y="84" width="30" height="12" rx="2.5" fill="#585048" stroke="#2b2b2b" stroke-width="2.2"/>
  <g class="screen"><rect x="25" y="62" width="26" height="22" rx="2.5" fill="#3c4a5c" stroke="#2b2b2b" stroke-width="2.2"/>
  <rect x="28" y="65" width="20" height="15" fill="#9fd8a8"/><line x1="30" y1="69" x2="44" y2="69" stroke="#2b2b2b" stroke-width="1.4"/><line x1="30" y1="73" x2="40" y2="73" stroke="#2b2b2b" stroke-width="1.4"/></g></g>`;

const PERSON = `
<svg viewBox="0 0 76 118" width="76" height="118">
  <g class="bob">
    <ellipse class="legleg legL" cx="31" cy="90" rx="6.5" ry="14" fill="#4c4640" stroke="#2b2b2b" stroke-width="2.4"/>
    <ellipse class="legleg legR" cx="45" cy="90" rx="6.5" ry="14" fill="#4c4640" stroke="#2b2b2b" stroke-width="2.4"/>
    <line class="armL" x1="19" y1="55" x2="15" y2="76" stroke="#2b2b2b" stroke-width="7" stroke-linecap="round"/>
    <path d="M15 92 Q15 48 38 48 Q61 48 61 92 Q49 100 38 100 Q27 100 15 92 Z" class="shirt" stroke="#2b2b2b" stroke-width="2.8"/>
    <rect x="33" y="40" width="10" height="9" rx="3" fill="#ffd9b0" stroke="#2b2b2b" stroke-width="2.2"/>
    <g class="headg">
      <circle cx="38" cy="27" r="13.5" fill="#ffd9b0" stroke="#2b2b2b" stroke-width="2.8"/>
      <path class="hair" d="M25.5 23 Q27 12 38 12 Q49 12 50.5 23 Q45 17.5 38 17.5 Q31 17.5 25.5 23 Z" fill="#585048" stroke="#2b2b2b" stroke-width="1.8"/>
      <circle class="hairback" cx="38" cy="27" r="13.5" fill="#585048" stroke="#2b2b2b" stroke-width="2.8"/>
      <g class="eyes"><circle cx="33.5" cy="27" r="1.9" fill="#2b2b2b"/><circle cx="42.5" cy="27" r="1.9" fill="#2b2b2b"/></g>
      <ellipse class="mouth" cx="38" cy="33.5" rx="2" ry="1.5" fill="#2b2b2b" style="display:none"/>
    </g>
    <g class="lapbox"></g>
    <line class="armR" x1="57" y1="55" x2="61" y2="76" stroke="#2b2b2b" stroke-width="7" stroke-linecap="round"/>
    <g class="prop"></g>
  </g>
</svg>`;

const SCENERY = `
  <div class="skirt"></div>
  <div class="door-frame" id="doorFrame">
    <div class="sign"><span class="led"></span><span class="sign-t">door</span></div>
    <div class="hole"></div><div class="door-leaf"></div></div>
  <div class="stage-board" id="wallBoard"><h4>TODAY'S BRIEF</h4><ul id="briefList"></ul></div>
  <div class="wall-clock"><i></i></div>
  <div class="window"><span class="sun"></span><span class="cloud"></span></div>
  <div class="coffee"><span class="steam">∿</span><span class="mach"></span><span class="ctr"></span></div>
  <span class="cor">COFFEE</span>
  <div class="bin"><span></span><span></span><span></span></div>
  <div class="plant"><div class="pot"></div><div class="leaf l1"></div><div class="leaf l2"></div><div class="leaf l3"></div></div>
  <div class="couchBox" id="couchBox"></div>
  <div class="benchNote" id="benchNote">wall desk</div>
  <div class="table" id="tMain"></div>`;

/* ================================================================ SIM */
// states: 'enter' | 'work' | 'rest' | 'exit'
let S = null;

function showRoom(id) {
  stopRoom(); stopFloor();
  const stage = $('#stage');
  stage.innerHTML = SCENERY;
  S = { id, stage, actors: new Map(), slots: [], geo: null, data: null, fresh: true,
        speed: parseFloat(sessionStorage.getItem('ao.speed') || '1'),
        raf: 0, poll: 0, lastBoard: '', focus: null };
  $('#floorView').hidden = true; $('#roomView').hidden = false;

  layout();
  S.ro = new ResizeObserver(() => layout());
  S.ro.observe(stage);
  stage.addEventListener('click', onStageClick);
  wireSpeed();
  loadRoom().then(seedRoom);
  S.poll = setInterval(loadRoom, LOOP_MS);
  S.raf = requestAnimationFrame(frame);
}
function stopRoom() {
  if (!S) return;
  clearInterval(S.poll); cancelAnimationFrame(S.raf);
  if (S.ro) S.ro.disconnect();
  S = null;
}
function wireSpeed() {
  document.querySelectorAll('#speedBtns button').forEach((b) => {
    b.classList.toggle('on', parseFloat(b.dataset.s) === S.speed);
    b.onclick = () => {
      S.speed = parseFloat(b.dataset.s);
      sessionStorage.setItem('ao.speed', String(S.speed));
      document.querySelectorAll('#speedBtns button').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
}

/* ---------------- geometry & slots ---------------- */
function layout() {
  if (!S) return;
  const stage = S.stage, W = stage.clientWidth, H = stage.clientHeight;
  const g = { W, H, cx: W * 0.52, cy: H * 0.55 };
  g.rx = clamp(W * 0.20, 140, 215); g.ry = clamp(H * 0.22, 80, 122);
  g.tableBox = { x: g.cx - g.rx, y: g.cy - g.ry, w: g.rx * 2, h: g.ry * 2 };
  g.wallY = 152;                       // corridor along the back wall
  g.hallY = H - 14;                    // corridor in front of everything
  g.doorMouth = { x: 62, y: 132 };     // spawn just out of view
  g.doorIn = { x: 108, y: 152 };       // first footstep inside
  g.doorOut = { x: 44, y: g.doorMouth.y };
  g.board = { x: 290, y: 156 };        // stand-in point at the wall board
  g.coffee = { x: W - 130, y: 250 };
  g.desk = { x: W - 150, y: 176 };     // wall desk (testers patrol here)
  g.couchBox = { x: 26, y: H - 142, w: 250, h: 100 };
  g.cornerY = H - 96;                  // couch seat line
  S.geo = g;

  const t = $('#tMain');
  t.style.left = g.tableBox.x + 'px'; t.style.top = g.tableBox.y + 'px';
  t.style.width = g.tableBox.w + 'px'; t.style.height = g.tableBox.h + 'px';
  t.style.zIndex = Math.round(g.cy + g.ry * 0.2);
  const cb = $('#couchBox');
  cb.style.left = g.couchBox.x + 'px'; cb.style.top = g.couchBox.y + 'px';
  cb.style.width = g.couchBox.w + 'px'; cb.style.height = g.couchBox.h + 'px';
  cb.style.zIndex = Math.round(g.couchBox.y + 60);
  if (!cb.childElementCount) cb.innerHTML = `<svg viewBox="0 0 250 100" width="250" height="100">
     <rect x="6" y="10" width="238" height="50" rx="15" fill="#98626f" stroke="#2b2b2b" stroke-width="3"/>
     <rect x="18" y="38" width="214" height="44" rx="11" fill="#b5838d" stroke="#2b2b2b" stroke-width="3"/>
     <rect x="26" y="44" width="60" height="30" rx="8" fill="#c99aa3" stroke="#2b2b2b" stroke-width="2"/>
     <rect x="92" y="44" width="60" height="30" rx="8" fill="#c99aa3" stroke="#2b2b2b" stroke-width="2"/>
     <rect x="158" y="44" width="66" height="30" rx="8" fill="#c99aa3" stroke="#2b2b2b" stroke-width="2"/></svg>`;
  const bn = $('#benchNote');
  bn.style.left = (W - 230) + 'px'; bn.style.top = (g.cornerY + 44) + 'px';
  for (const [sel, z] of [['#doorFrame', 160], ['.coffee', 235], ['.plant', 300],
                          ['.stage-board', 6], ['.wall-clock', 6], ['.window', 6], ['.cor', 7]]) {
    const e = stage.querySelector(sel); if (e) e.style.zIndex = z;
  }

  buildSlotsPreserving();
  // settle walk after a relayout: snap if close, re-walk if the room really moved
  S.actors.forEach((a) => {
    if (a.state === 'exit' || a.human) return;
    if (a.slot != null && S.slots[a.slot]) {
      const p = a.state === 'rest' ? seatPt(a.slot) : (a.state === 'work' && !a.trip ? sitPt(a.slot) : seatPt(a.slot));
      const d = Math.hypot(p.x - a.x, p.y - a.y);
      if (d < 4) return;
      if (d < 90 && !a.moving) { a.x = p.x; a.y = p.y; return; }  // scrollbar jitter: just snap
      setWalk(a, shortVia(a, p), () => { a.reseating = true; });
    }
  });
}
function buildSlotsPreserving() {
  const prev = S.slots, prevBy = new Map();
  for (const [id, a] of S.actors) if (a.slot != null && prev[a.slot]) prevBy.set(id, prev[a.slot]);
  buildSlots();
  const taken = new Set();
  // keep each actor on the new slot that best matches their old one
  for (const [, a] of S.actors) {
    const old = prevBy.get(a.id);
    if (!old) continue;
    let best = -1, bd = 1e9;
    S.slots.forEach((s, i) => {
      if (taken.has(i) || slotKind(s) !== slotKind(old)) return;
      const d = Math.hypot(s.x - old.x, s.y - old.y);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) { if (a.slot != null && S.slots[a.slot]) S.slots[a.slot].used = null;
      S.slots[best].used = a.id; a.slot = best; taken.add(best); }
  }
}
function angXY(t, pad, padY) {
  const g = S.geo;
  return { x: g.cx + Math.cos(t) * (g.rx + pad), y: g.cy - Math.sin(t) * (g.ry + (padY ?? pad * 0.8)) };
}
function buildSlots() {
  const L = [];
  const g = S.geo;
  const push = (s) => { L.push(Object.assign({ used: null }, s)); };
  // lead: head of the table, left
  push({ kind: 'lead', x: g.cx - g.rx - 62, y: g.cy + 8 });
  // inner ring: 5 back seats (near wall) + 6 front seats (viewer side)
  for (let i = 0; i < 5; i++) { const t = Math.PI * (0.30 + 0.40 * i / 4); push(Object.assign(angXY(t, 44), { ring: 'inner', t })); }
  for (let i = 0; i < 6; i++) { const t = Math.PI * (1.18 + 0.64 * i / 5); push(Object.assign(angXY(t, 44), { ring: 'inner', t })); }
  // outer ring: wider arcs
  for (let i = 0; i < 5; i++) { const t = Math.PI * (0.22 + 0.56 * i / 4); push(Object.assign(angXY(t, 112), { ring: 'outer', t })); }
  for (let i = 0; i < 7; i++) { const t = Math.PI * (1.10 + 0.80 * i / 6); push(Object.assign(angXY(t, 112), { ring: 'outer', t })); }
  // couch seats (rest corner), facing right
  for (let i = 0; i < 3; i++) push({ kind: 'couch', x: g.couchBox.x + 56 + i * 64, y: g.cornerY + 34 });
  // bench by the wall desk
  push({ kind: 'bench', x: g.desk.x - 26, y: g.cornerY + 58 });
  push({ kind: 'bench', x: g.desk.x + 40, y: g.cornerY + 58 });
  S.slots = L;
}
function seatPt(i) { const s = S.slots[i]; return s ? { x: s.x, y: s.y } : { x: S.geo.cx, y: S.geo.H - 60 }; }
// point where a SEATED actor projects (chair pulled to table, sitting on it)
function sitPt(i) {
  const s = S.slots[i], g = S.geo;
  if (!s) return seatPt(i);
  if (s.kind === 'lead') return { x: s.x + 26, y: s.y };
  if (s.kind === 'couch' || s.kind === 'bench') return { x: s.x, y: s.y - 10 };
  const k = 0.22; // lean toward the table
  return { x: s.x + (g.cx - s.x) * k, y: s.y + (g.cy - s.y) * k };
}
function seatFace(i) {
  const s = S.slots[i];
  if (!s) return 'D';
  if (s.kind === 'lead') return 'R';
  if (s.kind === 'couch') return 'R';
  if (s.kind === 'bench') return 'U';
  const d = S.geo.cy - s.y;
  if (d > S.geo.ry * 0.55) return 'D';        // back row faces the viewer
  if (d < -S.geo.ry * 0.45) return 'U';       // front row shows their back
  return s.x < S.geo.cx ? 'R' : 'L';
}

/* ---------------- routing: around the table, never through ---------------- */
function hitsTable(x0, y0, x1, y1) {
  const b = S.geo.tableBox;
  for (let i = 0; i <= 14; i++) {
    const t = i / 14, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (x > b.x - 12 && x < b.x + b.w + 12 && y > b.y - 8 && y < b.y + b.h + 30) return true;
  }
  return false;
}
function shortVia(a, tgt) {
  const g = S.geo, wps = [g.doorIn];
  // choose from door-mouth corridor; from anywhere else, pick corridor side
  let pts;
  if (!hitsTable(a.x, a.y, tgt.x, tgt.y)) pts = [tgt];
  else {
    const viaWall = !((a.y > g.hallY - 40 && tgt.y > g.hallY - 40 && tgt.x < 340));
    if (viaWall) {
      pts = [{ x: a.x, y: g.wallY }, { x: clamp(tgt.x, g.doorIn.x + 6, g.cx + g.rx + 160), y: g.wallY }, tgt];
      if (hitsTable(pts[1].x, pts[1].y, pts[2].x, pts[2].y)) pts = [{ x: a.x, y: g.wallY }, { x: g.cx + g.rx + 120, y: g.wallY }, { x: g.cx + g.rx + 120, y: tgt.y }, tgt];
    } else {
      pts = [{ x: clamp(a.x, 60, g.W - 40), y: g.hallY }, { x: tgt.x, y: g.hallY }, tgt];
      if (hitsTable(pts[1].x, pts[1].y, pts[2].x, pts[2].y)) pts = [{ x: g.cx + g.rx + 120, y: Math.max(a.y, tgt.y, g.hallY) }, tgt];
    }
  }
  return pts;
}
function setWalk(a, pts, cb) { a.path = pts.slice(); a.pi = 0; a.pathCb = cb || null; }

/* ---------------- actors ---------------- */
function makeActor(role, root) {
  const node = document.createElement('div');
  node.className = 'actor';
  node.innerHTML = PERSON;
  const h = hashF(role + '|' + root);
  const tint = TINT[role] || TINT.default;
  node.querySelector('.shirt').style.fill = tint;
  const hair = HAIRS[Math.floor(h * HAIRS.length)];
  node.querySelector('.hair').setAttribute('fill', hair);
  node.querySelector('.hairback').setAttribute('fill', hair);
  node.style.setProperty('--tint', tint);
  if (LAPTOP_ROLES.includes(role) || root) node.querySelector('.lapbox').innerHTML = LAP;
  else node.querySelector('.prop').innerHTML = PROPS[role] || PROPS.default;
  const tag = document.createElement('div'); tag.className = 'tag'; node.appendChild(tag);
  const sub = document.createElement('div'); sub.className = 'subtag'; node.appendChild(sub);
  const z1 = document.createElement('span'); z1.className = 'zz z1'; z1.textContent = 'z'; node.appendChild(z1);
  const z2 = document.createElement('span'); z2.className = 'zz z2'; z2.textContent = 'z'; node.appendChild(z2);
  return node;
}
function spawn(seat, { instant = false } = {}) {
  const node = makeActor(seat.role, !!seat.root);
  S.stage.appendChild(node);
  const a = { id: seat.id, role: seat.role || (seat.root ? 'lead' : 'agent'), root: !!seat.root,
              seat, node, tag: node.querySelector('.tag'), sub: node.querySelector('.subtag'),
              state: 'enter', slot: null, path: null, pi: 0, moving: false,
              face: 'R', said: '', nextAct: performance.now() + rnd(4000, 14000), bub: null };
  node.dataset.id = a.id;
  S.actors.set(a.id, a);
  const g = S.geo;
  if (instant) {
    const li = reserve(a, preferFor(a));
    if (li >= 0) { a.x = seatPt(li).x; a.y = seatPt(li).y; a.slot = li;
      a.state = isRest(seat) ? 'rest' : 'work'; a.face = seatFace(li); draw(a); }
    else { a.x = g.doorIn.x; a.y = g.hallY; a.state = 'rest'; }
  } else {
    a.x = g.doorMouth.x + rnd(-6, 6); a.y = g.doorMouth.y + rnd(0, 26);
    doorOpen(`${a.role} entered`);
    walkTo(a, seatSlotOrStand(a), () => { a.state = 'work'; });
  }
  return a;
}
function isRest(seat) { return seat.state === 'rest' || (!seat.active && seat.state === 'idle'); }
function isRetired(seat) { return !!seat.archived || seat.state === 'left'; }
function isWorking(seat) { return seat.active; }
function preferFor(a) { // kinds in preference for this actor's current duty
  if (a.root) return ['lead'];
  if (isRest(a.seat)) return ['couch', 'bench', 'outer', 'inner'];
  return ['inner', 'outer'];
}
function reserve(a, kinds) {
  if (a.slot != null && S.slots[a.slot] && S.slots[a.slot].used === a.id && kinds.includes(S.slots[a.slot].kind || S.slots[a.slot].ring || 'inner')) return a.slot;
  releaseSlot(a);
  let i = S.slots.findIndex((s, idx) => !s.used && slotKind(s) && kinds.includes(slotKind(s)));
  if (i < 0) i = S.slots.findIndex((s) => !s.used && ['inner', 'outer'].includes(slotKind(s)) && !kinds.includes('wait'));
  if (i < 0) return -1;
  S.slots[i].used = a.id; a.slot = i; return i;
}
function slotKind(s) { return s.kind || s.ring || 'inner'; }
function releaseSlot(a) {
  if (a.slot != null && S.slots[a.slot] && S.slots[a.slot].used === a.id) S.slots[a.slot].used = null;
  a.slot = null;
}
function seatSlotOrStand(a) {
  const i = reserve(a, preferFor(a));
  return i >= 0 ? seatPt(i) : { x: S.geo.doorIn.x + 8, y: S.geo.doorIn.y + 6 };
}
function walkTo(a, tgt, cb) { setWalk(a, shortVia(a, tgt), cb); }
function afterArrive(a) {
  if (a.reseating) { a.reseating = false; return; }
  if (a.trip) { // came back from micro-trip: settle at chair/couch
    const t = a.trip; a.trip = null;
    if (t === 'back') { a.state = a.homeState || 'work'; }
  }
}

/* ---------------- data → simulation ---------------- */
async function loadRoom() {
  if (!S) return;
  let d;
  try { d = await getJSON(`/api/room/${encodeURIComponent(S.id)}`); }
  catch (e) { note(`room: ${e.message}`); return; }
  if (d.error) { note(d.error); return; }
  S.data = d;
  $('#roomTitle').textContent = d.room.title;
  $('#roomMeta').textContent =
    `${d.room.project || '—'} · lead ${d.room.agent} · ${d.room.updated_label}` +
    (d.room.archived ? ' · archived' : '') + ` · $${(d.room.cost || 0).toFixed(3)}` +
    (d.room.hidden_children ? ` · +${d.room.hidden_children} retired hidden` : '');
  window.__lastUser = d.board.currentUser || [];
  renderPanels(d);
  if (S.fresh) return;      // seedRoom() handles first data
  syncSeats(d);
}
function seedRoom() {
  if (!S || !S.data) return;
  const flat = flattenSeats(S.data.seats);
  const nowMs = Date.now();
  const horizon = 6 * 3600e3;                   // “recent enough to walk in” horizon
  let stagger = 0;
  for (const seat of flat) {
    const recent = nowMs - (seat.born || 0) < horizon && !isRetired(seat);
    if (recent && !seat.root) {                // arrives through the door, one per beat
      const sid = seat.id;
      setTimeout(() => { if (S) { const aa = spawn(seat, {}); applyMeta(aa, seat); } }, 350 + stagger);
      stagger += 420;
      continue;
    }
    const a = spawn(seat, { instant: true }); applyMeta(a, seat);
  }
  buildHuman();
  const retired = flat.filter(isRetired);
  retired.forEach((seat, k) => {
    const a = S.actors.get(seat.id);
    if (a) setTimeout(() => beginExit(a, true), 1200 + k * 450);  // quiet exodus
  });
  S.fresh = false;
}
function syncSeats(d) {
  const flat = flattenSeats(d.seats);
  const ids = new Set(flat.map((s) => s.id));
  for (const seat of flat) {
    let a = S.actors.get(seat.id);
    if (!a) { a = spawn(seat, {}); applyMeta(a, seat); continue; }
    const wasRest = a.state === 'rest';
    let went = applyMeta(a, seat);
    if (isRetired(seat)) { beginExit(a); continue; }
    if (isWorking(seat)) {
      if (a.state === 'rest') wake(a);
    } else if (a.state === 'work' && !a.trip && seat.state === 'idle') {
      goRest(a);
    }
    void wasRest; void went;
  }
  for (const [id, a] of [...S.actors]) if (a.human) continue; else if (!ids.has(id) && a.state !== 'exit') beginExit(a);
}
function applyMeta(a, seat) {
  const prevBubble = a.seat && a.seat.bubble;
  a.seat = seat;
  return prevBubble !== seat.bubble;
}
function flattenSeats(seats) {
  const out = []; let lead = null;
  (function walk(list) { for (const x of list) { if (x.root) lead = x; else out.push(x); walk(x.children || []); } })(seats);
  return lead ? [lead, ...out] : out;
}

/* ---------------- life: wakes, rests, micro-trips ---------------- */
function wake(a) {
  const g = S.geo;
  if (a.state === 'queue') { /* will auto path on recheck */ }
  a.state = 'enter';
  const pt = seatSlotOrStand(a);
  walkTo(a, pt, () => { a.state = isRest(a.seat) ? 'rest' : 'work'; });
  if (Math.random() < 0.4) say(a, pick(['back on it ⚡', 'sorry — coffee run over', 'ok back to work']), 2600);
}
function goRest(a) {
  releaseSlot(a);
  const i = reserve(a, ['couch', 'bench', 'outer']);
  a.state = 'rest';
  if (i >= 0) walkTo(a, seatPt(i), null);
  else walkTo(a, { x: rnd(S.geo.cx - 60, S.geo.cx + 120), y: S.geo.hallY - 6 }, null);
  if (Math.random() < 0.5) say(a, pick(['done for now', 'calling it a day here', 'zzz incoming']), 3000);
}
function beginExit(a, silent) {
  if (a.state === 'exit') return;
  releaseSlot(a);
  a.state = 'exit';
  if (!silent) { doorOpen('bye ' + a.role); say(a, 'done here — bye 👋', 3000); }
  else { say(a, 'one quiet retirement 🍂', 2600); }
  const g = S.geo;
  const wps = shortVia(a, g.doorIn);
  setWalk(a, wps.concat([g.doorOut]), () => {
    a.node.classList.add('gone');
    S.actors.delete(a.id);
    setTimeout(() => a.node.remove(), 450);
  });
}
/* micro-life: while working, agents stroll to coffee / board / wall desk */
function lifeTick(a, nowMs) {
  if (a.human || a.state !== 'work' || a.path || nowMs < a.nextAct) return;
  a.nextAct = nowMs + rnd(9000, 20000);
  const g = S.geo, r = Math.random();
  const role = a.role;
  a.homeState = 'work';
  if (role === 'tester' || role === 'explore') {
    if (r < 0.45) trip(a, { x: g.desk.x + rnd(-50, 40), y: g.desk.y + rnd(0, 10) }, 'investigating…');
    else if (r < 0.6) trip(a, g.coffee, 'found the good coffee');
    else if (r < 0.75) say(a, pick(['grep · grep · grep', 'found it!', 'this file moved again']), 3200);
  } else if (role === 'doc-writer' || role === 'reviewer' || role === 'requirements') {
    if (r < 0.5) trip(a, { x: g.board.x + rnd(-56, 56), y: g.board.y }, pick(['adding a sticky', 'drawing arrows', 'writing “DO NOT ERASE”']));
    else if (r < 0.7) trip(a, g.coffee, 'ink break ☕');
    else if (r < 0.85) trip(a, { x: g.desk.x, y: g.desk.y }, 'fresh eyes needed');
  } else {
    if (r < 0.22) trip(a, g.coffee, 'coffee break ☕');
    else if (r < 0.34) trip(a, { x: g.cx + rnd(-90, 110), y: g.hallY - 10 }, 'stretching legs');
    else if (r < 0.5) trip(a, { x: g.board.x + rnd(-40, 40), y: g.board.y }, 'quick mark on the board');
  }
}
function trip(a, dest, line) {
  if (a.path) return;
  const home = a.slot;
  a.trip = 'back';
  if (line) say(a, line, 3000);
  setWalk(a, shortVia(a, dest), () => {
    a.nextAct = performance.now() + rnd(3500, 7000); // stand a while…
    setTimeout(() => {
      if (!S || !S.actors.has(a.id) || a.state === 'exit') return;
      const stillOurs = home != null && S.slots[home] && S.slots[home].used === a.id;
      setWalk(a, shortVia(a, stillOurs ? sitPt(home) : seatSlotOrStand(a)), () => {
        a.state = a.homeState || 'work';
      });
      if (!stillOurs && home != null) { a.slot = null; }
    }, (1500 + rnd(2000, 5000)) / S.speed);
  });
}

/* ---------------- human ---------------- */
function buildHuman() {
  const node = makeActor('user', false);
  node.classList.add('human');
  S.stage.appendChild(node);
  const g = S.geo;
  const a = { id: '__human', role: 'user', human: true, root: false, seat: { role: 'user', state: 'idle', updated_label: '☕' },
              node, tag: node.querySelector('.tag'), sub: node.querySelector('.subtag'),
              state: 'rest', slot: null, path: null, pi: 0, moving: false, face: 'L', said: '_init_',
              nextAct: 1e15, bub: null, x: g.coffee.x + 6, y: g.coffee.y + 74 };
  S.actors.set(a.id, a);
  draw(a);
}
function humanTick(a) {
  const ask = (window.__lastUser || [])[0] || '';
  if (!ask || ask === a.said) return;
  a.said = ask;
  const g = S.geo;
  const lead = [...S.actors.values()].find((x) => x.root);
  const tgt = lead ? { x: lead.x + 92, y: clamp(lead.y + 10, g.wallY + 30, g.hallY - 30) } : { x: g.cx - g.rx - 120, y: g.cy };
  say(a, '“' + (ask.length > 70 ? ask.slice(0, 69) + '…' : ask) + '”', 8000, true);
  a.state = 'enter';
  setWalk(a, shortVia(a, tgt).concat([]), () => {
    setTimeout(() => {
      if (!S || !S.actors.has(a.id)) return;
      setWalk(a, shortVia(a, { x: g.coffee.x + 6, y: g.coffee.y + 74 }), () => { a.state = 'rest'; });
    }, 2600 / S.speed);
  });
}

/* ---------------- the engine loop ---------------- */
const WALK_PX_S = 66;
function frame(tms) {
  if (!S) return;
  const dt = Math.min(0.08, S.lastTms ? (tms - S.lastTms) / 1000 : 0.016);
  S.lastTms = tms;
  try {
    for (const a of S.actors.values()) {
      if (a.path && a.pi < a.path.length) {
        let budget = WALK_PX_S * S.speed * (a.state === 'exit' ? 1.25 : 1) * dt;
        a.moving = true;
        while (budget > 0 && a.path && a.pi < a.path.length) {
          const w = a.path[a.pi], dx = w.x - a.x, dy = w.y - a.y, dist = Math.hypot(dx, dy);
          if (dist < 2.5) { a.pi++; continue; }
          const mv = Math.min(budget, dist);
          a.x += dx / dist * mv; a.y += dy / dist * mv; budget -= mv;
          if (Math.abs(dx) > Math.abs(dy) * 1.2) a.face = dx > 0 ? 'R' : 'L';
          else if (Math.abs(dy) > Math.abs(dx) * 1.6) a.face = dy > 0 ? 'D' : 'U';
        }
        if (a.path && a.pi >= a.path.length) {
          const cb = a.pathCb; a.path = null; a.moving = false;
          if (cb) cb();
        }
      } else a.moving = false;

      if (!a.moving && a.state === 'work' && a.slot != null && !a.trip && a.path == null && a.pathCb == null) {
        const p = sitPt(a.slot); a.x = p.x; a.y = p.y; a.face = seatFace(a.slot);
      }
      if (!a.moving && a.state === 'rest' && a.slot != null && a.path == null && a.pathCb == null) {
        const p = seatPt(a.slot); a.x = p.x; a.y = p.y - 4; a.face = seatFace(a.slot);
      }
      if (a.human) humanTick(a); else lifeTick(a, tms);
      speechTick(a);
      draw(a);
    }
  } catch (e) { console.error('[stage]', e); note('stage hiccup: ' + e.message); }
  S.raf = requestAnimationFrame(frame);
}
function draw(a) {
  const n = a.node;
  n.style.transform = `translate(${(a.x - 38).toFixed(1)}px,${(a.y - 104).toFixed(1)}px)`;
  n.style.zIndex = Math.round(a.y + 120);
  n.classList.toggle('moving', !!a.moving);
  n.classList.toggle('faceL', a.face === 'L');
  n.classList.toggle('faceUp', a.face === 'U');
  const lap = n.querySelector('.screen');
  if (lap) lap.style.opacity = (!a.moving && (a.state === 'work' || a.state === 'rest')) ? 1 : 0;
  const seated = !a.moving && a.slot != null && (a.state === 'work' || a.state === 'rest') && !a.trip;
  const s = a.seat || {};
  n.classList.toggle('seated', seated);
  n.classList.toggle('typing', seated && s.state === 'typing');
  n.classList.toggle('hammering', seated && s.state === 'working');
  n.classList.toggle('gazing', seated && s.state === 'thinking');
  const mood = n.querySelector('.mouth');
  if (mood) mood.style.display = seated && s.state === 'working' ? '' : 'none';
  n.classList.toggle('zzz-on', !a.moving && a.state === 'rest');
  // tag & sub-line
  let kids = 0;
  (function cnt(list) { for (const c of list || []) { kids++; cnt(c.children); } })(s.children);
  const tagTxt = a.human ? 'you (human)' : a.role + (kids ? ` ×${kids + 1}` : '');
  if (n._tag !== tagTxt) { a.tag.textContent = tagTxt; n._tag = tagTxt; }
  const subTxt = statusLine(a);
  if (n._sub !== subTxt) { a.sub.textContent = subTxt; n._sub = subTxt; }
}
function statusLine(a) {
  if (a.human) return '☕ rewarding good agents';
  const s = a.seat || {};
  if (a.moving) return a.state === 'exit' ? 'walking out' : a.state === 'rest' ? 'off to the couch' : 'walking…';
  if (a.state === 'rest') return s.updated_label || 'resting';
  if (a.state === 'exit') return 'done';
  if (s.bubble) return s.bubble.length > 34 ? s.bubble.slice(0, 33) + '…' : s.bubble;
  return s.state === 'thinking' ? 'thinking…' : s.updated_label || 'idle';
}

/* ---------------- speech ---------------- */
function speechTick(a) {
  if (a.human) return;
  const bubble = a.seat && a.seat.bubble;
  if (!bubble || !isWorking(a.seat) || bubble === a.said) return;
  a.said = bubble;
  say(a, bubble, 5000 / Math.max(1, S.speed * 0.6));
}
function say(a, text, ttl = 4200, big = false) {
  if (!text) return;
  if (a.bub) { a.bub.classList.add('fade'); const old = a.bub; setTimeout(() => old.remove(), 650); }
  const b = document.createElement('div');
  b.className = 'bub' + (big ? ' big' : '');
  b.textContent = text;
  a.node.appendChild(b);
  a.bub = b;
  setTimeout(() => { if (a.bub === b) { b.classList.add('fade'); a.bub = null; setTimeout(() => b.remove(), 650); } }, ttl);
}
let doorTimer = null;
function doorOpen(what) {
  const f = $('#doorFrame'); if (!f) return;
  f.classList.add('open');
  f.querySelector('.sign-t').textContent = what || 'door';
  clearTimeout(doorTimer);
  doorTimer = setTimeout(() => { f.classList.remove('open'); f.querySelector('.sign-t').textContent = 'door'; }, 1900);
}

/* ---------------- panels ---------------- */
function renderPanels(d) {
  const roleBy = {}; for (const s of flattenSeats(d.seats)) roleBy[s.id] = s.role;
  const feed = $('#boardFeed');
  feed.innerHTML = !d.board.recent.length
    ? '<div class="wb-empty">the marker is dry — no tool runs yet</div>'
    : d.board.recent.slice(0, 14).map((r) => `
      <div class="feed-item"><span class="role" style="background:${TINT[r.role] || TINT.default}">${esc((roleBy[r.session] || r.role || 'agent').slice(0, 9))}</span><span class="txt">✎ ${esc(r.tool)}</span></div>`).join('');
  const td = $('#boardTodos');
  td.innerHTML = !d.board.todos.length
    ? '<div class="wb-empty">nothing written yet — no to-dos for this room</div>'
    : d.board.todos.slice(0, 12).map((t) => `
      <div class="feed-item"><span class="role st-${esc(t.status)}">${esc(t.status.replace('_', ' '))}</span><span class="txt">${esc(t.content)}</span><span class="txt">${esc(t.title)}</span></div>`).join('');
  const items = ((d.board.todos.length ? d.board.todos.map((x) => x.content) : d.board.recent.map((x) => x.tool))).slice(0, 4);
  const key = items.join('|');
  if (key !== S.lastBoard) {
    S.lastBoard = key;
    $('#briefList').innerHTML = items.map((i) => `<li>${esc(i.length > 36 ? i.slice(0, 35) + '…' : i)}</li>`).join('') || '<li>fresh room — nothing yet</li>';
    const wb = $('#wallBoard'); wb.classList.remove('pop'); void wb.offsetWidth; wb.classList.add('pop');
  }
  renderLegend(d.roles);
}
function renderLegend(roles) {
  const bar = $('#legendBar');
  bar.innerHTML = (roles || []).map((r) =>
    `<span class="item"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;border:1.5px solid #2b2b2b;background:${TINT[r.role] || TINT.default}"></span>${esc(r.role)}${r.count > 1 ? ' ×' + r.count : ''}</span>`).join('')
    + '<span class="item" style="margin-left:auto">click a person to peek · click empty floor to unpeek</span>';
}

/* ---------------- focus (click a person) ---------------- */
function onStageClick(ev) {
  const n = ev.target.closest('.actor');
  if (!n) { if (S && S.focus) { S.focus = null; S.actors.forEach((a) => { a.node.classList.remove('dim', 'focus'); }); } return; }
  for (const a of S.actors.values()) {
    if (a.node !== n) continue;
    if (S.focus === a.id) { S.focus = null; a.node.classList.remove('dim', 'focus'); speechTickForce(a); return; }
    S.focus = a.id;
    S.actors.forEach((o) => { o.node.classList.toggle('dim', o !== a); o.node.classList.toggle('focus', o === a); });
    const s = a.seat || {};
    say(a, [s.title || a.role, s.model ? `model ${s.model}` : '', `status: ${s.state || 'idle'}`,
            `cost $${(s.cost || 0).toFixed(3)} · ${s.updated_label || ''}`].filter(Boolean).join(' · '), 7000, true);
    if (a.moving && a.state === 'work') { // bring them to their chair instead? just face viewer
      a.face = 'D';
    }
  }
}
function speechTickForce(a) { a.said = ''; }

/* ---------------- clock ---------------- */
function tickClock() { $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
setInterval(tickClock, 1000); tickClock();

route();
