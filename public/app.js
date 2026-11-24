const FILES = 'abcdefgh';
const PIECE_NAMES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const els = {
  lobby: document.getElementById('lobby'),
  game: document.getElementById('game'),
  playerName: document.getElementById('playerName'),
  createBtn: document.getElementById('createBtn'),
  joinCode: document.getElementById('joinCode'),
  joinBtn: document.getElementById('joinBtn'),
  lobbyError: document.getElementById('lobbyError'),
  roomCode: document.getElementById('roomCode'),
  copyBtn: document.getElementById('copyBtn'),
  statusPill: document.getElementById('statusPill'),
  board: document.getElementById('board'),
  promoModal: document.getElementById('promoModal'),
  promoChoices: document.getElementById('promoChoices'),
  resultOverlay: document.getElementById('resultOverlay'),
  resultTitle: document.getElementById('resultTitle'),
  resultSub: document.getElementById('resultSub'),
  rematchBtn: document.getElementById('rematchBtn'),
  playerTop: document.getElementById('playerTop'),
  playerBottom: document.getElementById('playerBottom'),
  capturedTop: document.getElementById('capturedTop'),
  capturedBottom: document.getElementById('capturedBottom'),
  moveList: document.getElementById('moveList'),
  drawBtn: document.getElementById('drawBtn'),
  resignBtn: document.getElementById('resignBtn'),
  drawBanner: document.getElementById('drawBanner'),
  liveList: document.getElementById('liveList'),
  liveEmpty: document.getElementById('liveEmpty'),
  refreshLiveBtn: document.getElementById('refreshLiveBtn'),
  leaveBtn: document.getElementById('leaveBtn'),
  spectateBadge: document.getElementById('spectateBadge'),
};

const session = loadSession() || {};
let state = null;          // last server state
let selected = null;       // selected square name e.g. 'e2'
let legalByFrom = new Map();
let pendingPromotion = null; // {from,to}
let pollTimer = null;
let drag = null;

function loadSession() {
  try { return JSON.parse(localStorage.getItem('chessduel')) || null; } catch { return null; }
}
function saveSession(s) {
  if (s) localStorage.setItem('chessduel', JSON.stringify(s));
  else localStorage.removeItem('chessduel');
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- Lobby ---------------- */

els.createBtn.addEventListener('click', async () => {
  els.lobbyError.textContent = '';
  try {
    const name = els.playerName.value.trim() || 'Player';
    const r = await api('/api/rooms', { method: 'POST', body: { name } });
    enterGame({ code: r.code, token: r.token, color: r.color, name });
  } catch (e) {
    els.lobbyError.textContent = e.message;
  }
});

els.joinBtn.addEventListener('click', async () => {
  els.lobbyError.textContent = '';
  const code = els.joinCode.value.trim().toUpperCase();
  if (!code) { els.lobbyError.textContent = 'Enter a room code'; return; }
  try {
    const name = els.playerName.value.trim() || 'Player';
    const r = await api(`/api/rooms/${encodeURIComponent(code)}/join`, { method: 'POST', body: { name } });
    enterGame({ code: r.code, token: r.token, color: r.color, name });
  } catch (e) {
    els.lobbyError.textContent = e.message;
  }
});

els.joinCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.joinBtn.click();
});

function enterGame(s) {
  session.code = s.code;
  session.token = s.token || null;
  session.color = s.color || null;
  session.name = s.name || null;
  session.spectator = !!s.spectator;
  saveSession(session);
  els.lobby.classList.add('hidden');
  els.game.classList.remove('hidden');
  els.roomCode.textContent = s.code;
  els.spectateBadge.classList.toggle('hidden', !session.spectator);
  buildBoard();
  refresh();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 1500);
}

function watchRoom(code) {
  enterGame({ code: code.toUpperCase(), spectator: true });
}

function leaveGame() {
  saveSession(null);
  session.code = null;
  state = null;
  selected = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  els.game.classList.add('hidden');
  els.lobby.classList.remove('hidden');
  loadLive();
}

/* ---------------- Board ---------------- */

const squareEls = new Map(); // name -> element

function buildBoard() {
  els.board.innerHTML = '';
  squareEls.clear();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = FILES[col];
      const rank = 8 - row;
      const name = `${file}${rank}`;
      const light = (col + row) % 2 === 0; // a8 dark? verify: a8 col0 row0 -> dark. (0+0)%2=0 -> we want dark for a8? chess: a8 is dark. yes.
      const sq = document.createElement('div');
      sq.className = `square ${light ? 'light' : 'dark'}`;
      sq.dataset.square = name;
      if (col === 0) {
        const r = document.createElement('span');
        r.className = 'coord rank';
        r.textContent = rank;
        sq.appendChild(r);
      }
      if (row === 7) {
        const f = document.createElement('span');
        f.className = 'coord file';
        f.textContent = file;
        sq.appendChild(f);
      }
      sq.addEventListener('click', () => onSquareClick(name));
      sq.addEventListener('pointerdown', (e) => onPointerDown(e, name));
      els.board.appendChild(sq);
      squareEls.set(name, sq);
    }
  }
}

function parseFen(fen) {
  const placement = fen.split(' ')[0];
  const grid = new Array(64).fill(null);
  const rows = placement.split('/');
  for (let r = 0; r < 8; r++) {
    const rank = 8 - r;
    let col = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) { col += Number(ch); continue; }
      const file = FILES[col];
      grid[(rank - 1) * 8 + col] = { type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? 'w' : 'b' };
      col++;
    }
  }
  return grid;
}

function squareIndex(name) {
  return (Number(name[1]) - 1) * 8 + FILES.indexOf(name[0]);
}
function indexToSquare(i) {
  return `${FILES[i % 8]}${Math.floor(i / 8) + 1}`;
}

function renderBoard() {
  if (!state) return;
  const grid = parseFen(state.fen);

  // last move squares
  const last = state.history[state.history.length - 1];
  const lastSquares = last ? [last.from, last.to] : [];

  // king in check
  let checkSquare = null;
  if (state.check) {
    const kingChar = state.turn === 'w' ? 'K' : 'k';
    const rows = state.fen.split(' ')[0].split('/');
    for (let r = 0; r < 8 && !checkSquare; r++) {
      let col = 0;
      for (const ch of rows[r]) {
        if (/\d/.test(ch)) { col += Number(ch); continue; }
        if (ch === kingChar) checkSquare = `${FILES[col]}${8 - r}`;
        col++;
      }
    }
  }

  for (const [name, el] of squareEls) {
    el.classList.remove('selected', 'last-move', 'check', 'target-dot', 'target-ring');
    el.querySelectorAll('.piece, .drag-src').forEach((n) => n.remove());

    if (lastSquares.includes(name)) el.classList.add('last-move');
    if (checkSquare === name) el.classList.add('check');
    if (selected === name) el.classList.add('selected');

    const targets = selected ? legalByFrom.get(selected) || [] : [];
    if (targets.some((m) => m.to === name)) {
      el.classList.add(squareHasPiece(grid, name) ? 'target-ring' : 'target-dot');
    }

    const piece = grid[squareIndex(name)];
    if (piece) {
      const img = document.createElement('img');
      img.className = 'piece';
      img.src = `/pieces/${piece.color}${piece.type.toUpperCase()}.svg`;
      img.alt = '';
      img.draggable = false;
      el.appendChild(img);
    }
  }
}

function squareHasPiece(grid, name) { return !!grid[squareIndex(name)]; }
function pieceColorAt(grid, name) { return grid[squareIndex(name)]?.color; }

/* ---------------- Interaction ---------------- */

function canMove() {
  return state && state.status === 'active' && state.you &&
    state.legalMoves.length > 0 && !pendingPromotion;
}

function myColorChar() { return state.you.color === 'white' ? 'w' : 'b'; }

function onSquareClick(name) {
  if (!canMove()) { selected = null; renderBoard(); return; }

  const grid = parseFen(state.fen);
  const piece = grid[squareIndex(name)];

  if (selected) {
    const moves = legalByFrom.get(selected) || [];
    const match = moves.find((m) => m.to === name);
    if (match) {
      attemptMove(selected, name);
      return;
    }
  }

  // select own piece
  if (piece && piece.color === myColorChar() && state.turn === myColorChar()) {
    selected = selected === name ? null : name;
  } else {
    selected = null;
  }
  renderBoard();
}

function isPawnPromotion(from, to) {
  const grid = parseFen(state.fen);
  const p = grid[squareIndex(from)];
  if (!p || p.type !== 'p') return false;
  const lastRank = p.color === 'w' ? '8' : '1';
  return to[1] === lastRank;
}

function attemptMove(from, to) {
  if (isPawnPromotion(from, to)) {
    pendingPromotion = { from, to };
    const color = state.you.color;
    els.promoChoices.innerHTML = '';
    for (const t of ['q', 'r', 'b', 'n']) {
      const btn = document.createElement('button');
      btn.innerHTML = `<img src="/pieces/${color[0]}${t.toUpperCase()}.svg" alt="${t}" draggable="false">`;
      btn.addEventListener('click', () => {
        els.promoModal.classList.add('hidden');
        const p = pendingPromotion;
        pendingPromotion = null;
        doMove(p.from, p.to, t);
      });
      els.promoChoices.appendChild(btn);
    }
    els.promoModal.classList.remove('hidden');
    return;
  }
  doMove(from, to, null);
}

async function doMove(from, to, promotion) {
  selected = null;
  try {
    state = await api(`/api/rooms/${session.code}/move`, {
      method: 'POST',
      body: { token: session.token, from, to, promotion },
    });
    afterState();
  } catch (e) {
    alert(e.message);
    refresh();
  }
}

/* ---- drag & drop ---- */

function onPointerDown(e, name) {
  if (e.button !== 0 || !canMove()) return;
  const grid = parseFen(state.fen);
  const piece = grid[squareIndex(name)];
  if (!piece || piece.color !== myColorChar() || state.turn !== myColorChar()) return;
  if (!legalByFrom.has(name)) return;

  drag = { from: name, startX: e.clientX, startY: e.clientY, active: false, ghost: null, el: squareEls.get(name) };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp, { once: true });
}

function onDragMove(e) {
  if (!drag) return;
  const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
  if (!drag.active && dist > 6) {
    drag.active = true;
    const img = drag.el.querySelector('.piece');
    if (img) {
      const ghost = img.cloneNode();
      ghost.classList.add('drag-ghost');
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      img.style.opacity = '0.35';
    }
  }
  if (drag.active && drag.ghost) {
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
  }
}

function onDragUp(e) {
  window.removeEventListener('pointermove', onDragMove);
  const d = drag;
  drag = null;
  if (!d) return;
  if (d.ghost) d.ghost.remove();
  const img = d.el.querySelector('.piece');
  if (img) img.style.opacity = '';

  if (!d.active) { onSquareClick(d.from); return; }

  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.square');
  if (target) {
    const to = target.dataset.square;
    const moves = legalByFrom.get(d.from) || [];
    if (moves.some((m) => m.to === to)) {
      selected = null;
      attemptMove(d.from, to);
      return;
    }
  }
  // dropped outside: just select
  selected = d.from;
  renderBoard();
}

/* ---------------- State / rendering ---------------- */

async function refresh() {
  if (!session.code) return;
  try {
    const qs = session.token ? `?token=${session.token}` : '';
    const fresh = await api(`/api/rooms/${session.code}${qs}`);
    const changed = JSON.stringify(fresh.history) !== JSON.stringify(state?.history);
    state = fresh;
    legalByFrom = new Map();
    for (const m of state.legalMoves) {
      if (!legalByFrom.has(m.from)) legalByFrom.set(m.from, []);
      legalByFrom.get(m.from).push(m);
    }
    renderAll();
    if (changed) renderBoard();
  } catch (e) {
    if (e.message.includes('not found') || e.message.includes('expired')) {
      clearInterval(pollTimer);
      alert('Room no longer exists.');
      location.reload();
    }
  }
}

function afterState() { refresh(); }

function renderAll() {
  renderBoard();
  renderSidebar();
  renderStatus();
  renderDrawBanner();
  renderResult();
}

function renderStatus() {
  const pill = els.statusPill;
  pill.classList.remove('your-turn');
  if (session.spectator) {
    pill.textContent = 'Spectating';
    return;
  }
  if (state.status === 'waiting') {
    pill.textContent = 'Waiting for opponent…';
  } else if (state.status === 'finished') {
    pill.textContent = 'Game over';
  } else {
    const yourTurn = state.you && state.turn === myColorChar();
    pill.textContent = yourTurn ? 'Your turn' : `${capitalize(state.turn === 'w' ? 'white' : 'black')} to move`;
    if (yourTurn) pill.classList.add('your-turn');
  }
}

function renderSidebar() {
  const { white, black } = state.players;
  const youAreWhite = state.you?.color === 'white';
  const top = youAreWhite ? black : white;
  const bottom = youAreWhite ? white : black;

  const topColor = youAreWhite ? 'b' : 'w';
  const bottomColor = youAreWhite ? 'w' : 'b';
  const topActive = state.status !== 'finished' && state.turn === topColor;
  const bottomActive = state.status !== 'finished' && state.turn === bottomColor;
  els.playerTop.className = 'player' + (topActive ? ' active' : '');
  els.playerBottom.className = 'player' + (bottomActive ? ' active' : '');
  els.playerTop.innerHTML = playerHtml(top, topColor, topActive);
  els.playerBottom.innerHTML = playerHtml(bottom, bottomColor, bottomActive);

  // captured pieces: white captures black pieces (shown as bX.svg), black captures white pieces
  const capturedByWhite = []; // black piece types white has taken
  const capturedByBlack = []; // white piece types black has taken
  for (const m of state.history) {
    if (m.captured) (m.color === 'w' ? capturedByWhite : capturedByBlack).push(m.captured);
  }
  const whiteScore = material(capturedByWhite) - material(capturedByBlack);
  const blackScore = -whiteScore;
  renderCaptured(els.capturedBottom, capturedByWhite, 'b', whiteScore); // under white player
  renderCaptured(els.capturedTop, capturedByBlack, 'w', blackScore);    // under black player

  // move list
  els.moveList.innerHTML = '';
  const moves = state.history;
  for (let i = 0; i < moves.length; i += 2) {
    const num = document.createElement('li');
    num.className = 'num';
    num.textContent = `${i / 2 + 1}.`;
    els.moveList.appendChild(num);
    for (let j = i; j < Math.min(i + 2, moves.length); j++) {
      const li = document.createElement('li');
      li.textContent = moves[j].san;
      if (j === moves.length - 1) li.style.fontWeight = '700';
      els.moveList.appendChild(li);
    }
  }
  els.moveList.scrollTop = els.moveList.scrollHeight;

  const spectator = session.spectator || !state.you;
  els.drawBtn.disabled = spectator || state.status !== 'active';
  els.resignBtn.disabled = spectator || state.status !== 'active';
  els.resignBtn.style.display = spectator ? 'none' : '';
  els.drawBtn.textContent = state.drawOffer && state.drawOffer.color !== state.you?.color
    ? 'Accept draw' : state.drawOffer?.color === state.you?.color ? 'Withdraw offer' : 'Offer draw';
  els.rematchBtn.style.display = !spectator && state.status === 'finished' ? '' : 'none';
}

function playerHtml(p, colorChar, active) {
  const dotClass = colorChar === 'w' ? 'white' : 'black';
  const colorName = colorChar === 'w' ? 'white' : 'black';
  if (!p) return `<span class="dot ${dotClass}"></span><span style="color:var(--text-dim)">Waiting…</span>`;
  const isYou = state.you && state.you.color === colorName && state.you.name === p.name;
  return `<span class="dot ${dotClass}"></span><span>${escapeHtml(p.name)}${isYou ? ' (you)' : ''}</span>`;
}

function material(types) {
  return types.reduce((s, t) => s + PIECE_VALUES[t], 0);
}

// capturedTypes: piece types this side has captured; pieceColor: 'w' or 'b' of the captured pieces
function renderCaptured(el, capturedTypes, pieceColor, score) {
  el.innerHTML =
    capturedTypes.map((t) => `<img src="/pieces/${pieceColor}${t.toUpperCase()}.svg" alt="">`).join('') +
    (score > 0 ? `<span class="diff">+${score}</span>` : score < 0 ? `<span class="diff" style="color:#e07070">${score}</span>` : '');
}
function capitalize(s) { return s[0].toUpperCase() + s.slice(1); }
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderDrawBanner() {
  const el = els.drawBanner;
  const offer = state.drawOffer;
  if (session.spectator || !state.you || state.status !== 'active' || !offer) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const mine = offer.color === state.you?.color;
  if (mine) {
    el.innerHTML = `<div>You offered a draw — waiting for response.</div>
      <div class="row"><button class="btn" id="withdrawDrawBtn">Withdraw</button></div>`;
    document.getElementById('withdrawDrawBtn').onclick = () => api(`/api/rooms/${session.code}/draw-offer`, { method: 'POST', body: { token: session.token } }).then(refresh).catch((e) => alert(e.message));
    return;
  }
  el.innerHTML = `<div>${escapeHtml(state.players[offer.color]?.name ?? 'Opponent')} offered a draw.</div>
    <div class="row"><button class="btn btn-primary" id="acceptDrawBtn">Accept</button>
    <button class="btn" id="declineDrawBtn">Decline</button></div>`;
  document.getElementById('acceptDrawBtn').onclick = () => drawAction('draw-accept');
  document.getElementById('declineDrawBtn').onclick = () => drawAction('draw-decline');
}

function renderResult() {
  const overlay = els.resultOverlay;
  if (state.status !== 'finished' || !state.result) { overlay.classList.add('hidden'); return; }
  overlay.classList.remove('hidden');
  const r = state.result;
  if (r.winner) {
    const w = state.players[r.winner];
    els.resultTitle.textContent = `${w?.name ?? capitalize(r.winner)} wins!`;
    els.resultSub.textContent = r.reason === 'checkmate' ? 'by checkmate' : r.reason === 'resignation' ? 'by resignation' : `(${r.reason})`;
  } else {
    els.resultTitle.textContent = 'Draw';
    els.resultSub.textContent = `Game drawn — ${r.reason}`;
  }
}

/* ---------------- Actions ---------------- */

els.copyBtn.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(session.code); els.copyBtn.textContent = 'Copied'; }
  catch { els.copyBtn.textContent = session.code; }
  setTimeout(() => (els.copyBtn.textContent = 'Copy'), 1200);
});

els.drawBtn.addEventListener('click', async () => {
  const offer = state?.drawOffer;
  if (offer && offer.color !== state.you?.color) return drawAction('draw-accept');
  try {
    await api(`/api/rooms/${session.code}/draw-offer`, { method: 'POST', body: { token: session.token } });
    refresh();
  } catch (e) { alert(e.message); }
});

els.resignBtn.addEventListener('click', async () => {
  if (!confirm('Resign this game?')) return;
  try {
    state = await api(`/api/rooms/${session.code}/resign`, { method: 'POST', body: { token: session.token } });
    afterState();
  } catch (e) { alert(e.message); }
});

els.rematchBtn.addEventListener('click', async () => {
  try {
    state = await api(`/api/rooms/${session.code}/rematch`, { method: 'POST', body: { token: session.token } });
    selected = null;
    afterState();
  } catch (e) { alert(e.message); }
});

async function drawAction(kind) {
  try {
    await api(`/api/rooms/${session.code}/${kind}`, { method: 'POST', body: { token: session.token } });
    refresh();
  } catch (e) { alert(e.message); }
}

/* ---------------- Live games ---------------- */

async function loadLive() {
  try {
    const rooms = await api('/api/rooms');
    els.liveEmpty.style.display = rooms.length ? 'none' : '';
    els.liveList.innerHTML = '';
    for (const r of rooms) {
      const li = document.createElement('li');
      li.className = 'live-item';
      const w = r.players.white?.name ?? '…';
      const b = r.players.black?.name ?? '<span class="waiting">waiting…</span>';
      const meta = r.status === 'waiting' ? 'waiting' : `${r.moves} moves · ${r.turn === 'w' ? 'White' : 'Black'} to move`;
      li.innerHTML = `
        <span class="live-dot"></span>
        <span class="names">${escapeHtml(w)}<span class="vs">vs</span>${b}</span>
        <span class="meta">${meta}</span>
        <button class="btn btn-small btn-watch">Watch</button>`;
      li.querySelector('.btn-watch').addEventListener('click', () => watchRoom(r.code));
      els.liveList.appendChild(li);
    }
  } catch {
    // server unreachable — leave list as is
  }
}

els.refreshLiveBtn.addEventListener('click', loadLive);
els.leaveBtn.addEventListener('click', leaveGame);
setInterval(() => { if (els.game.classList.contains('hidden')) loadLive(); }, 3000);
loadLive();

/* ---------------- Boot ---------------- */

buildBoard();
if (session.code) {
  els.lobby.classList.add('hidden');
  els.game.classList.remove('hidden');
  els.playerName.value = session.name || '';
  els.roomCode.textContent = session.code;
  els.spectateBadge.classList.toggle('hidden', !session.spectator);
  refresh();
  pollTimer = setInterval(refresh, 1500);
} else {
  saveSession(null);
}
