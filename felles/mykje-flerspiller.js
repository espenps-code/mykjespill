/* =========================================================================
   MYKJE SPILL – felles motor for turbaserte spill for to
   -------------------------------------------------------------------------
   Brukes av Fire på rad, Prikk og strek og Fyrstikkspillet.
   Motoren lager startskjerm, lobby med kode/QR, turvisning, poengtavle,
   sluttkort og omkamp. Hvert spill gir bare reglene sine:

     MykjeSpill.start({
       id, brand, sides:[{name},{name}], options:[…],
       init(opts, starter) -> tilstand
       turn(s)             -> 0 | 1     (hvem sin tur)
       valid(s, trekk)     -> true/false
       apply(s, trekk)     -> NY tilstand (ikke endre den gamle)
       result(s)           -> null | {winner: 0 | 1 | null}
       bot(s, nivå, side)  -> trekk
       mount(api), render(s, api), animate?(før, etter, trekk, side, api)
     })

   «Mot en venn» bruker Firebase Realtime Database. Hvert spill lagrer
   rommene sine under sin egen sti (spill-id), f.eks. firepaarad/ABCD.
   Databasereglene må tillate den stien – se README i samme mappe.
   ========================================================================= */
(function () {
'use strict';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCGa-sqmEBetgY4qJIpzJDf92rMSFn3cwc",
  authDomain: "mykje-spill.firebaseapp.com",
  databaseURL: "https://mykje-spill-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "mykje-spill",
  appId: "1:248771795084:web:9839ce54c5bb4d5cfc03a9"
};
const FB_VER = '10.12.2';
const QR_LIB = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const CODE_CHARS = 'ABDEFGHJKLMNPRSTUVXYZ';

const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const rand = n => Math.floor(Math.random() * n);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let def = null;          // spillets regler
let S = {mode: 'bot', sound: true, name: '', opts: {}};   // lagrede innstillinger
let friendRole = null;   // 'host' | 'join' | null
let C = null;            // pågående spill
let MP = null;           // nettilkobling

/* ---------- Lagring ---------- */
const KEY = () => 'mykje-' + def.id;
function load() { try { Object.assign(S, JSON.parse(localStorage.getItem(KEY()) || '{}')); } catch (e) {} }
function save() { try { localStorage.setItem(KEY(), JSON.stringify(S)); } catch (e) {} }
const MPKEY = () => KEY() + '-mp' + (window.MYKJE_TEST_TAB || '');
const store = {
  get() { try { return JSON.parse(localStorage.getItem(MPKEY()) || 'null'); } catch (e) { return null; } },
  set(v) { try { localStorage.setItem(MPKEY(), JSON.stringify(v)); } catch (e) {} },
  clear() { try { localStorage.removeItem(MPKEY()); } catch (e) {} }
};

/* ---------- Lyd ---------- */
let actx = null;
function ac() {
  if (!S.sound) return null;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch (e) { return null; }
  return actx;
}
function tone(f0, f1, dur, type = 'sine', vol = .18, delay = 0) {
  const ctx = ac(); if (!ctx) return;
  const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + .012);
  g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + dur + .05);
}
const SFX = {
  click: () => tone(660, 880, .07, 'triangle', .1),
  pop:   () => tone(420, 820, .11, 'sine', .18),
  drop:  () => tone(320, 90, .2, 'triangle', .24),
  score: () => { tone(523, 0, .12, 'triangle', .16); tone(784, 0, .18, 'triangle', .16, .08); },
  win:   () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0, .24, 'triangle', .16, i * .11)),
  lose:  () => [392, 330, 262].forEach((f, i) => tone(f, 0, .3, 'sine', .16, i * .16)),
  draw:  () => [440, 440].forEach((f, i) => tone(f, 0, .18, 'sine', .14, i * .18)),
  turn:  () => tone(880, 0, .1, 'sine', .08),
  bad:   () => tone(200, 150, .14, 'square', .06)
};
function sfx(n) { if (SFX[n]) SFX[n](); }

/* ---------- Nett (Firebase) ---------- */
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src;
    s.onload = res; s.onerror = () => rej(new Error('Kunne ikke laste ' + src));
    document.head.append(s);
  });
}
let NET = null;
async function getNet() {
  if (NET) return NET;
  if (window.MYKJE_TEST_NET) return (NET = window.MYKJE_TEST_NET(def.id));
  await loadScript(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-app-compat.js`);
  await loadScript(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-database-compat.js`);
  const fb = window.firebase;
  const app = fb.apps.length ? fb.app() : fb.initializeApp(FIREBASE_CONFIG);
  const db = fb.database(app);
  const R = code => db.ref(def.id + '/' + code);
  NET = {
    async create(code, data) { const r = await R(code).transaction(cur => cur === null ? data : undefined); return r.committed; },
    async get(code) { return (await R(code).get()).val(); },
    update(code, patch) { return R(code).update(patch); },
    remove(code) { return R(code).remove(); },
    async push(code, key, val) { const r = await R(code).child(key).transaction(cur => cur === null ? val : undefined); return r.committed; },
    watch(code, cb) { const ref = R(code), h = s => cb(s.val()); ref.on('value', h, e => console.error(e)); return () => ref.off('value', h); },
    presence(code, role) {
      const p = R(code).child('online/' + role), c = db.ref('.info/connected');
      const h = s => { if (s.val()) { p.onDisconnect().remove(); p.set(true).catch(() => {}); } };
      c.on('value', h);
      return () => { c.off('value', h); p.onDisconnect().cancel(); p.remove().catch(() => {}); };
    },
    now() { return fb.database.ServerValue.TIMESTAMP; }
  };
  return NET;
}
function netErr(e) {
  const m = String((e && (e.code || e.message)) || e);
  if (/permission/i.test(m)) return '«Mot en venn» er ikke slått på for dette spillet ennå. Spill mot boten eller på én skjerm så lenge.';
  if (/laste/i.test(m)) return 'Fikk ikke kontakt med nettet. Sjekk at du er på nett og prøv igjen.';
  return 'Noe gikk galt med nettet. Prøv igjen.';
}
const newCode = () => Array.from({length: 4}, () => CODE_CHARS[rand(CODE_CHARS.length)]).join('');
const joinUrl = code => location.href.split(/[?#]/)[0] + '?rom=' + code;
const parseMoves = raw => !raw ? [] : Array.isArray(raw) ? raw.filter(v => v != null)
  : Object.keys(raw).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b).map(k => raw[k]);

/* ---------- Oppbygging av sida ---------- */
function build() {
  document.body.dataset.game = def.id;
  const wrap = $('.wrap'), main = $('main');

  const top = el('header', 'top');
  top.innerHTML = `<a class="brand" href="index.html" title="Tilbake til Mykje spill">${esc(def.brand)}</a>
    <div class="top-actions"><button class="tbtn" id="soundBtn" type="button"></button><button class="tbtn" id="homeBtn" type="button" hidden>Meny</button></div>`;
  wrap.insertBefore(top, main);
  const ban = el('p', 'banner'); ban.id = 'mpBanner'; ban.hidden = true; ban.setAttribute('aria-live', 'polite');
  wrap.insertBefore(ban, main);

  const start = $('#scr-start');
  start.insertAdjacentHTML('beforeend', `
    <button class="btn btn-resume" id="resumeBtn" type="button" hidden></button>
    <div class="field">
      <span class="eyebrow">Motstander</span>
      <div class="modes">
        <button class="mode" data-mode="bot" type="button"><b>Mot boten</b><small>Spill alene mot datamaskinen.</small></button>
        <button class="mode" data-mode="local" type="button"><b>To på én skjerm</b><small>Bytt på å trykke på det samme brettet.</small></button>
        <button class="mode" data-mode="friend" type="button"><b>Mot en venn</b><small>To skjermer. Den ene lager spillet og deler en kode.</small></button>
      </div>
    </div>
    <div class="field" id="roleField" hidden>
      <span class="eyebrow">Lage eller bli med?</span>
      <div class="modes two">
        <button class="mode" data-role="host" type="button"><b>Lag nytt spill</b><small>Du får en kode som vennen din skriver inn.</small></button>
        <button class="mode" data-role="join" type="button"><b>Bli med</b><small>Vennen din har laget spillet og har en kode til deg.</small></button>
      </div>
      <p class="note" id="friendNote" aria-live="polite"></p>
    </div>
    <div class="field" data-modes="host join">
      <span class="eyebrow">Navnet ditt (valgfritt)</span>
      <input class="name-input" id="myName" maxlength="12" placeholder="F.eks. Ola" autocomplete="off" spellcheck="false" aria-label="Navnet ditt">
    </div>
    <div class="field" data-modes="join">
      <span class="eyebrow">Skriv inn koden fra vennen din</span>
      <form class="join" id="joinForm" autocomplete="off">
        <input id="joinCode" class="join-input" inputmode="text" maxlength="4" placeholder="KODE" aria-label="Kode fra vennen din" autocapitalize="characters" spellcheck="false">
        <button class="btn btn-join" type="submit">Bli med</button>
      </form>
    </div>
    <div id="optFields" class="stack"></div>
    <button class="btn btn-primary" id="startBtn" type="button">${esc(def.startText || 'Start spillet')}</button>
    <button class="btn btn-primary" id="hostBtn" type="button" hidden>Lag nytt spill</button>`);

  const opt = $('#optFields');
  (def.options || []).forEach(o => {
    const f = el('div', 'field'); f.dataset.modes = (o.modes || ['bot', 'local', 'host']).join(' ');
    f.append(el('span', 'eyebrow', o.label));
    const seg = el('div', 'seg'); seg.style.setProperty('--cols', Math.min(o.items.length, 4));
    if (S.opts[o.key] === undefined || !o.items.some(i => i.v === S.opts[o.key])) S.opts[o.key] = o.value !== undefined ? o.value : o.items[0].v;
    o.items.forEach(it => {
      const b = el('button', 'opt'); b.type = 'button';
      b.append(el('b', null, it.t)); if (it.s) b.append(el('small', null, it.s));
      b.setAttribute('aria-pressed', S.opts[o.key] === it.v);
      b.onclick = () => { S.opts[o.key] = it.v; save(); sfx('click'); [...seg.children].forEach((x, i) => x.setAttribute('aria-pressed', o.items[i].v === it.v)); };
      seg.append(b);
    });
    f.append(seg); opt.append(f);
  });

  main.insertAdjacentHTML('beforeend', `
    <section id="scr-lobby" class="stack" hidden>
      <div class="sec-head"><h2>Inviter en venn</h2>
        <p>Vennen skanner QR-koden, eller velger «Mot en venn» → «Bli med» og skriver inn koden.</p></div>
      <div class="lobby">
        <div class="qr" id="qr" aria-label="QR-kode som åpner spillet"></div>
        <div class="lobby-code">
          <span class="eyebrow">Kode</span>
          <div class="code" id="lobbyCode">····</div>
          <button class="tbtn" id="copyBtn" type="button">Kopier lenke</button>
        </div>
      </div>
      <p class="waiting"><i></i><span>Venter på at en venn blir med …</span></p>
      <button class="btn" id="cancelLobby" type="button">Avbryt</button>
    </section>`);

  const g = $('#scr-game');
  g.insertAdjacentHTML('afterbegin', `<div class="gbar">
      <span class="pill" id="turnPill"><i></i><span id="turnTxt"></span></span>
      <div class="score" id="score"></div></div>`);
  g.insertAdjacentHTML('beforeend', `<p class="msg" id="msg" aria-live="polite"></p>
      <div class="again-row" id="againRow" hidden><button class="btn btn-primary" id="againInline" type="button">Ny runde</button></div>`);

  document.body.insertAdjacentHTML('beforeend', `
    <div class="overlay" id="endOverlay" hidden>
      <div class="card" role="dialog" aria-labelledby="endTitle">
        <h2 id="endTitle"></h2>
        <p id="endSub"></p>
        <div class="endscore" id="endScore"></div>
        <div id="endExtra"></div>
        <button class="btn btn-primary" id="againBtn" type="button">Spill igjen</button>
        <div class="row"><button class="btn" id="viewBtn" type="button">Se på brettet</button><button class="btn" id="menuBtn" type="button">Til menyen</button></div>
      </div>
    </div>
    <div class="turnflash" id="turnFlash" aria-hidden="true"><span></span></div>`);

  // Hendelser
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { sfx('click'); setMode(b.dataset.mode); });
  document.querySelectorAll('[data-role]').forEach(b => b.onclick = () => { sfx('click'); setRole(b.dataset.role); });
  $('#myName').value = S.name || '';
  $('#myName').addEventListener('input', e => { S.name = e.target.value.trim().slice(0, 12); save(); });
  $('#joinCode').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-ZÆØÅ]/g, ''); });
  $('#joinForm').addEventListener('submit', e => { e.preventDefault(); mpJoin($('#joinCode').value); });
  $('#startBtn').onclick = () => { ac(); sfx('click'); startLocal(); };
  $('#hostBtn').onclick = () => mpHost();
  $('#cancelLobby').onclick = () => { mpLeave(true); show('start'); };
  $('#copyBtn').onclick = copyLink;
  $('#homeBtn').onclick = toMenu;
  $('#menuBtn').onclick = toMenu;
  $('#againBtn').onclick = again;
  $('#againInline').onclick = again;
  $('#viewBtn').onclick = () => { $('#endOverlay').hidden = true; $('#againRow').hidden = false; };
  $('#soundBtn').onclick = () => { S.sound = !S.sound; save(); soundLabel(); if (S.sound) sfx('click'); };
  $('#resumeBtn').onclick = () => { const s = store.get(); if (s) mpResume(s); };
  soundLabel();
}
function soundLabel() { $('#soundBtn').textContent = S.sound ? 'Lyd: på' : 'Lyd: av'; }

function show(id) {
  ['start', 'lobby', 'game'].forEach(s => { const e = $('#scr-' + s); if (e) e.hidden = s !== id; });
  $('#homeBtn').hidden = id === 'start';
  document.body.dataset.screen = id;
  window.scrollTo(0, 0);
}

function setMode(m) {
  S.mode = m; save();
  if (m !== 'friend') friendRole = null;
  refreshStart();
}
function setRole(r) {
  friendRole = r; refreshStart();
  if (r === 'join') setTimeout(() => $('#joinCode').focus(), 0);
}
function refreshStart() {
  const mode = S.mode, tok = mode === 'friend' ? (friendRole || 'none') : mode;
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === mode));
  document.querySelectorAll('[data-role]').forEach(b => b.setAttribute('aria-pressed', b.dataset.role === friendRole));
  $('#roleField').hidden = mode !== 'friend';
  document.querySelectorAll('#scr-start [data-modes]').forEach(f => f.hidden = !f.dataset.modes.split(' ').includes(tok));
  $('#startBtn').hidden = mode === 'friend';
  $('#hostBtn').hidden = tok !== 'host';
  if (mode !== 'friend') friendNote('');
}
function friendNote(t, warn) { const n = $('#friendNote'); n.textContent = t || ''; n.className = 'note' + (warn ? ' warn' : ''); }
function banner(t) { const b = $('#mpBanner'); b.textContent = t || ''; b.hidden = !t; }
function setMsg(t, hot) { const m = $('#msg'); m.textContent = t || ''; m.className = 'msg' + (hot ? ' hot' : ''); if (t && !reduced) { void m.offsetWidth; m.classList.add('pop'); } }
function flash(t) {
  if (reduced) return;
  const f = $('#turnFlash'); f.firstElementChild.textContent = t;
  f.className = 'turnflash'; void f.offsetWidth; f.classList.add('go');
}

/* ---------- Spillkontroll ---------- */
const api = {
  get mode() { return C && C.mode; },
  get me() { return C ? C.me : 0; },
  get last() { return C && C.last; },
  get instant() { return !!(C && C.instant); },
  get opts() { return C && C.opts; },
  get state() { return C && C.state; },
  get ended() { return !!(C && C.ended); },
  canAct,
  play,
  msg: setMsg,
  sfx, tone, wait, el, rand, reduced,
  sideName,
  isMine(side) { return C && (C.mode === 'local' || side === C.me); }
};

function sideName(side) {
  if (!C) return def.sides[side].name;
  if (C.mode === 'bot') return side === 0 ? 'Du' : 'Boten';
  if (C.mode === 'local') return def.sides[side].name;
  return side === C.me ? 'Du' : (C.names[side] || 'Motstanderen');
}

function setupGame(mode, opts, extra = {}) {
  C = {mode, opts: Object.assign({}, opts), round: extra.round || 1, starter: extra.starter || 0, me: extra.me || 0,
       names: extra.names || ['', ''], score: [0, 0], draws: 0, state: null, moves: [], synced: 0,
       q: Promise.resolve(), busy: false, ended: false, token: {}, code: extra.code || null, last: null};
}

function newRound() {
  C.token = {};
  C.state = def.init(C.opts, C.starter);
  C.moves = []; C.synced = 0; C.ended = false; C.busy = false; C.last = null; C.prevTurn = null; C.instant = false;
  $('#endOverlay').hidden = true; $('#againRow').hidden = true;
  setMsg('');
  show('game');
  def.mount(api);
  renderAll();
  if (C.round > 1) {
    const s = C.starter;
    setMsg(C.mode === 'local' ? `${def.sides[s].name} starter denne runden.` : s === C.me ? 'Du starter denne runden.' : `${sideName(s)} starter denne runden.`);
  }
  maybeBot();
}

function enqueue(fn) {
  const c = C, tok = c.token;
  c.q = c.q.then(() => (C === c && c.token === tok) ? fn() : null).catch(e => console.error(e));
}

function canAct() {
  if (!C || C.ended || C.busy || !C.state) return false;
  return C.mode === 'local' || def.turn(C.state) === C.me;
}

function play(move) {
  if (!C || C.ended) return false;
  if (!canAct()) {
    if (!C.busy && C.mode !== 'local') { sfx('bad'); setMsg(C.mode === 'bot' ? 'Vent – det er botens tur.' : 'Vent – det er ikke din tur ennå.'); }
    return false;
  }
  if (!def.valid(C.state, move)) { sfx('bad'); return false; }
  ac();
  C.busy = true; renderAll();
  if (C.mode === 'friend') {
    const c = C, n = c.moves.length;
    NET.push(MP.code, `m${c.round}/${n}`, move).then(ok => {
      if (!ok && C === c && c.moves.length === n) { c.busy = false; renderAll(); }
    }).catch(e => { if (C === c) { c.busy = false; renderAll(); setMsg(netErr(e), true); } });
  } else enqueue(() => commit(move));
  return true;
}

async function commit(move, instant) {
  const c = C, tok = c.token;
  if (!def.valid(c.state, move)) { console.warn('Ugyldig trekk hoppet over', move); c.busy = false; return; }
  const by = def.turn(c.state), prev = c.state;
  c.state = def.apply(prev, move);
  c.moves.push(move); c.last = {move, by};
  c.busy = true; c.instant = !!instant;
  if (def.animate && !instant) { try { await def.animate(prev, c.state, move, by, api); } catch (e) { console.error(e); } }
  if (C !== c || c.token !== tok) return;
  c.instant = false;
  const res = def.result(c.state);
  c.busy = false;
  if (res) { c.ended = true; renderAll(); return finish(res, instant); }
  renderAll();
  maybeBot();
}

function maybeBot() {
  if (!C || C.mode !== 'bot' || C.ended) return;
  if (def.turn(C.state) !== 1) return;
  const c = C;
  c.busy = true; renderAll();
  enqueue(async () => {
    await wait(reduced ? 250 : (def.botDelay || 600) + rand(400));
    if (C !== c) return;
    const mv = await def.bot(c.state, c.opts.level, 1, api);
    if (C !== c) return;
    await commit(mv);
  });
}

function renderAll() {
  if (!C || !C.state) return;
  def.render(C.state, api);
  updateTurn();
  renderScore();
}

function updateTurn() {
  const pill = $('#turnPill'), t = $('#turnTxt');
  if (C.ended) { pill.dataset.side = ''; pill.classList.remove('wait'); t.textContent = 'Runden er ferdig'; return; }
  const s = def.turn(C.state);
  pill.dataset.side = s;
  let txt;
  if (C.mode === 'local') txt = `${def.sides[s].name} sin tur`;
  else if (s === C.me) txt = 'Din tur';
  else txt = C.mode === 'bot' ? 'Boten tenker …' : `${sideName(s)} sin tur`;
  pill.classList.toggle('wait', C.mode !== 'local' && s !== C.me);
  t.textContent = txt;
  if (C.prevTurn !== null && C.prevTurn !== s) {
    if (C.mode === 'friend' && s === C.me) { flash('Din tur!'); sfx('turn'); }
    if (C.mode === 'local') flash(`${def.sides[s].name} sin tur`);
  }
  C.prevTurn = s;
}

function renderScore() {
  const sc = $('#score');
  sc.innerHTML = `<span class="sc-lbl">Vunnet</span><span class="sc" data-side="0"><i></i>${esc(sideName(0))} <b>${C.score[0]}</b></span>` +
    `<span class="sc" data-side="1"><b>${C.score[1]}</b> ${esc(sideName(1))}<i></i></span>`;
}

function finish(res, instant) {
  const w = res.winner;
  if (C.scored !== C.round) { C.scored = C.round; if (w === 0 || w === 1) C.score[w]++; else C.draws++; }
  renderScore();
  let title, mood;
  if (w == null) { title = 'Uavgjort!'; mood = 'draw'; }
  else if (C.mode === 'local') { title = `${def.sides[w].name} vant!`; mood = 'win'; }
  else if (w === C.me) { title = 'Du vant!'; mood = 'win'; }
  else { title = C.mode === 'bot' ? 'Boten vant' : `${sideName(w)} vant`; mood = 'lose'; }
  const sub = def.endText ? def.endText(res, api) : '';
  const c = C;
  if (!instant) sfx(mood === 'win' ? 'win' : mood === 'lose' ? 'lose' : 'draw');
  setTimeout(() => {
    if (C !== c || !c.ended) return;
    $('#endTitle').textContent = title;
    $('#endSub').textContent = sub || '';
    $('#endScore').innerHTML = `${esc(sideName(0))} <b>${c.score[0]}</b> – <b>${c.score[1]}</b> ${esc(sideName(1))}` + (c.draws ? `<small>${c.draws} uavgjort</small>` : '');
    const ex = $('#endExtra'); ex.innerHTML = '';
    if (def.endExtra) { const x = def.endExtra(res, api); if (x) ex.append(x); }
    $('#endOverlay').dataset.mood = mood;
    $('#endOverlay').hidden = false;
    refreshAgain();
  }, instant ? 0 : (def.endDelay != null ? def.endDelay : 900));
}

function again() {
  if (!C || !C.ended) return;
  ac(); sfx('click');
  if (C.mode === 'friend') {
    if (!MP || !MP.room) return;
    NET.update(MP.code, {[`${MP.role}/again`]: C.round}).catch(e => setMsg(netErr(e), true));
    C.wantAgain = C.round; refreshAgain();
    return;
  }
  C.round++; C.starter = 1 - C.starter;
  newRound();
}
function refreshAgain() {
  const b1 = $('#againBtn'), b2 = $('#againInline');
  let txt = C && C.mode === 'friend' ? 'Ny runde' : 'Spill igjen', dis = false, note = '';
  if (C && C.mode === 'friend' && MP && MP.room) {
    const r = MP.room, mine = r[MP.role] || {}, opp = r[MP.role === 'host' ? 'guest' : 'host'] || {};
    if (opp.left) { dis = true; note = 'Motstanderen har gått ut av spillet.'; }
    else if (mine.again === C.round || C.wantAgain === C.round) { txt = 'Venter på motstanderen …'; dis = true; }
    else if (opp.again === C.round) { txt = 'Ja, ny runde!'; note = `${sideName(1 - C.me)} vil spille en runde til.`; }
  }
  [b1, b2].forEach(b => { b.textContent = txt; b.disabled = dis; });
  if (note && C && C.ended) setMsg(note);
}

function toMenu() {
  sfx('click');
  if (MP) mpLeave(true);
  if (C) C.token = {};
  C = null;
  $('#endOverlay').hidden = true;
  show('start'); refreshStart(); checkResume();
}

function startLocal() {
  const mode = S.mode === 'local' ? 'local' : 'bot';
  setupGame(mode, S.opts, {starter: 0});
  newRound();
}

/* ---------- Mot en venn ---------- */
async function mpHost() {
  ac();
  let net; try { net = await getNet(); } catch (e) { friendNote(netErr(e), true); return; }
  $('#hostBtn').disabled = true; friendNote('Lager spill …');
  try {
    for (let i = 0; i < 8; i++) {
      const code = newCode();
      const room = {v: 1, game: def.id, created: net.now(), state: 'lobby', opts: Object.assign({}, S.opts), round: 1, starter: 0,
        host: {name: S.name || '', again: 0}, guest: {joined: false, name: '', again: 0}};
      if (await net.create(code, room)) { friendNote(''); mpConnect(code, 'host'); showLobby(code); return; }
    }
    friendNote('Fant ingen ledig kode. Prøv igjen.', true);
  } catch (e) { friendNote(netErr(e), true); }
  finally { $('#hostBtn').disabled = false; }
}

async function mpJoin(raw) {
  ac();
  const code = String(raw || '').toUpperCase().replace(/[^A-ZÆØÅ]/g, '');
  if (code.length !== 4) { friendNote('Koden har fire bokstaver. Sjekk at du har skrevet alle.', true); return; }
  let net; try { net = await getNet(); } catch (e) { friendNote(netErr(e), true); return; }
  friendNote('Kobler til …');
  let room; try { room = await net.get(code); } catch (e) { friendNote(netErr(e), true); return; }
  if (!room) { friendNote(`Fant ikke noe spill med koden ${code}. Sjekk at du har skrevet riktig.`, true); return; }
  const saved = store.get();
  if (saved && saved.code === code) { friendNote(''); return mpResume(saved); }
  if (room.state !== 'lobby' || (room.guest && room.guest.joined)) { friendNote('Det spillet har allerede to spillere. Be om en ny kode.', true); return; }
  try { await net.update(code, {'guest/joined': true, 'guest/name': S.name || '', state: 'play'}); }
  catch (e) { friendNote(netErr(e), true); return; }
  friendNote('');
  mpConnect(code, 'guest');
}

async function mpResume(saved) {
  let net; try { net = await getNet(); } catch (e) { friendNote(netErr(e), true); return; }
  let room; try { room = await net.get(saved.code); } catch (e) { friendNote(netErr(e), true); return; }
  if (!room || (room[saved.role] && room[saved.role].left)) { store.clear(); checkResume(); setMode('friend'); friendNote('Det spillet er ferdig. Lag et nytt.', true); return; }
  mpConnect(saved.code, saved.role, true);
  if (room.state === 'lobby' && saved.role === 'host') showLobby(saved.code);
}

function mpConnect(code, role, keep) {
  mpLeave(false);
  MP = {code, role, opp: role === 'host' ? 'guest' : 'host', room: null, phase: 'connecting', offTimer: 0};
  if (!keep) store.set({code, role});
  MP.unpresence = NET.presence(code, role);
  MP.unwatch = NET.watch(code, room => onRoom(room));
  $('#resumeBtn').hidden = true;
}

function mpLeave(tell) {
  if (!MP) return;
  const m = MP; MP = null;
  clearTimeout(m.offTimer);
  if (tell && m.room && m.room.state !== 'lobby') NET.update(m.code, {[`${m.role}/left`]: true}).catch(() => {});
  try { m.unwatch && m.unwatch(); } catch (e) {}
  try { m.unpresence && m.unpresence(); } catch (e) {}
  if (m.role === 'host' && m.room && m.room.state === 'lobby') NET.remove(m.code).catch(() => {});
  if (tell !== false) store.clear();
  banner('');
}

function mpGone(text) {
  mpLeave(true);
  if (C) C.token = {};
  C = null; $('#endOverlay').hidden = true;
  show('start'); setMode('friend'); friendNote(text, true);
}

async function showLobby(code) {
  MP.phase = 'lobby';
  show('lobby');
  $('#lobbyCode').textContent = code;
  const qr = $('#qr'); qr.textContent = 'Laster QR-kode …';
  try {
    if (!window.qrcode) await loadScript(QR_LIB);
    const q = window.qrcode(0, 'M'); q.addData(joinUrl(code)); q.make();
    qr.innerHTML = q.createSvgTag({cellSize: 4, margin: 0, scalable: true});
  } catch (e) { qr.textContent = 'QR-koden kunne ikke lastes. Bruk koden i stedet.'; }
}
async function copyLink() {
  if (!MP) return;
  const b = $('#copyBtn'), url = joinUrl(MP.code);
  try { await navigator.clipboard.writeText(url); b.textContent = 'Lenken er kopiert'; }
  catch (e) { b.textContent = url; }
  setTimeout(() => b.textContent = 'Kopier lenke', 3000);
}

function onRoom(room) {
  if (!MP) return;
  if (!room) { if (MP.phase !== 'connecting') mpGone('Spillet finnes ikke lenger.'); else { store.clear(); mpGone('Fant ikke spillet. Lag et nytt.'); } return; }
  MP.room = room;
  const opp = room[MP.opp] || {};
  const oppOnline = room.online && room.online[MP.opp];
  if (opp.left) banner('Motstanderen har forlatt spillet.');
  else if (room.state !== 'lobby' && !oppOnline) {
    if (!MP.offTimer) MP.offTimer = setTimeout(() => {
      if (MP && MP.room && !(MP.room.online && MP.room.online[MP.opp]) && MP.room.state !== 'lobby') banner('Motstanderen har mistet nettet. Venter på at hen kobler seg på igjen …');
    }, 3000);
  } else { clearTimeout(MP.offTimer); MP.offTimer = 0; banner(''); }

  if (room.state === 'lobby') { if (MP.role === 'host' && MP.phase !== 'lobby') showLobby(MP.code); return; }

  const me = MP.role === 'host' ? 0 : 1;
  const names = [(room.host && room.host.name) || '', (room.guest && room.guest.name) || ''];
  let fresh = false;
  if (!C || C.mode !== 'friend' || C.code !== MP.code) {
    setupGame('friend', room.opts || {}, {round: room.round, starter: room.starter || 0, me, names, code: MP.code});
    C.state = null; fresh = true;
  }
  C.names = names;
  if (!C.state || C.round !== room.round) {
    C.round = room.round; C.starter = room.starter || 0; C.wantAgain = 0;
    MP.phase = 'play';
    newRound(); fresh = true;
  }
  const list = parseMoves(room['m' + room.round]);
  const catchUp = fresh && list.length > 0;
  for (let i = C.synced; i < list.length; i++) {
    const mv = list[i]; C.synced++;
    enqueue(() => commit(mv, catchUp));
  }
  if (catchUp) enqueue(() => { renderAll(); });
  if (C.ended) refreshAgain();
  renderScore();

  const a = room.host && room.host.again === room.round, b = room.guest && room.guest.again === room.round;
  if (MP.role === 'host' && a && b && !MP.advancing) {
    MP.advancing = room.round;
    NET.update(MP.code, {round: room.round + 1, starter: 1 - (room.starter || 0), ['m' + room.round]: null})
      .catch(() => {}).finally(() => { if (MP) MP.advancing = 0; });
  }
}

async function checkResume() {
  const saved = store.get(), b = $('#resumeBtn');
  b.hidden = true;
  if (!saved || !saved.code) return;
  b.textContent = `Fortsett spillet med koden ${saved.code}`;
  b.hidden = false;
}

/* ---------- Oppstart ---------- */
function start(d) {
  def = d;
  load();
  build();
  refreshStart();
  show('start');
  checkResume();
  const m = location.search.match(/[?&]rom=([A-Za-zÆØÅæøå]{4})/);
  if (m) {
    history.replaceState(null, '', location.pathname);
    setMode('friend'); setRole('join');
    $('#joinCode').value = m[1].toUpperCase();
    friendNote('Skriv navnet ditt hvis du vil, og trykk «Bli med».');
  }
}

window.MykjeSpill = {start, sfx, tone, wait, el, rand, reduced, api};
})();
