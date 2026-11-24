import express from 'express';
import { Chess } from 'chess.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const newToken = () => crypto.randomBytes(24).toString('hex');

function findPlayer(room, token) {
  if (!token) return null;
  for (const color of ['white', 'black']) {
    const p = room.players[color];
    if (p && p.token === token) return { color, name: p.name };
  }
  return null;
}

function resultFromChess(chess) {
  if (chess.isCheckmate()) {
    return { winner: chess.turn() === 'w' ? 'black' : 'white', reason: 'checkmate' };
  }
  if (chess.isStalemate()) return { winner: null, reason: 'stalemate' };
  if (chess.isThreefoldRepetition()) return { winner: null, reason: 'threefold-repetition' };
  if (chess.isInsufficientMaterial()) return { winner: null, reason: 'insufficient-material' };
  return null;
}

function legalMovesForTurn(chess) {
  return chess.moves({ verbose: true }).map((m) => ({
    from: m.from,
    to: m.to,
    promotion: m.promotion ?? null,
    san: m.san,
  }));
}

function roomState(room, token = null) {
  const me = findPlayer(room, token);
  const chess = room.chess;
  const finished = room.status === 'finished';
  const isMyTurn = !finished && me && chess.turn() === (me.color === 'white' ? 'w' : 'b');
  return {
    code: room.code,
    status: room.status,
    turn: chess.turn(),
    fen: chess.fen(),
    history: chess.history({ verbose: true }).map((m) => ({
      san: m.san,
      from: m.from,
      to: m.to,
      color: m.color,
      captured: m.captured ?? null,
      promotion: m.promotion ?? null,
      flags: m.flags,
    })),
    result: room.result,
    players: {
      white: room.players.white ? { name: room.players.white.name } : null,
      black: room.players.black ? { name: room.players.black.name } : null,
    },
    you: me ? { color: me.color, name: me.name } : null,
    legalMoves: isMyTurn ? legalMovesForTurn(chess) : [],
    check: chess.inCheck(),
    drawOffer: room.drawOffer,
    createdAt: room.createdAt,
  };
}

function getRoom(req, res) {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) {
    res.status(404).json({ error: 'Room not found' });
    return null;
  }
  if (Date.now() - room.createdAt > ROOM_TTL_MS) {
    rooms.delete(req.params.code.toUpperCase());
    res.status(404).json({ error: 'Room expired' });
    return null;
  }
  return room;
}

app.post('/api/rooms', (req, res) => {
  const name = String(req.body?.name ?? 'Player').trim().slice(0, 24) || 'Player';
  const code = makeCode();
  const room = {
    code,
    createdAt: Date.now(),
    status: 'waiting',
    chess: new Chess(),
    result: null,
    drawOffer: null,
    players: {
      white: { name, token: newToken() },
      black: null,
    },
  };
  rooms.set(code, room);
  res.json({ code, color: 'white', token: room.players.white.token });
});

app.get('/api/rooms', (req, res) => {
  const now = Date.now();
  const list = [];
  for (const room of rooms.values()) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(room.code);
      continue;
    }
    list.push({
      code: room.code,
      status: room.status,
      players: {
        white: room.players.white ? { name: room.players.white.name } : null,
        black: room.players.black ? { name: room.players.black.name } : null,
      },
      moves: room.chess.history().length,
      turn: room.chess.turn(),
      createdAt: room.createdAt,
    });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  res.json(list.slice(0, 50));
});

app.post('/api/rooms/:code/join', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  if (room.players.black) {
    return res.status(409).json({ error: 'Room is full' });
  }
  const name = String(req.body?.name ?? 'Player').trim().slice(0, 24) || 'Player';
  room.players.black = { name, token: newToken() };
  room.status = 'active';
  res.json({ code: room.code, color: 'black', token: room.players.black.token });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  res.json(roomState(room, req.query.token));
});

app.post('/api/rooms/:code/move', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const me = findPlayer(room, req.body?.token);
  if (!me) return res.status(403).json({ error: 'Invalid token' });
  if (room.status !== 'active') return res.status(400).json({ error: 'Game is not active' });

  const myTurn = (me.color === 'white' ? 'w' : 'b') === room.chess.turn();
  if (!myTurn) return res.status(400).json({ error: 'Not your turn' });

  const { from, to, promotion } = req.body ?? {};
  try {
    room.chess.move({ from, to, promotion });
  } catch {
    return res.status(400).json({ error: 'Illegal move' });
  }

  room.drawOffer = null;
  const result = resultFromChess(room.chess);
  if (result || room.chess.isDraw()) {
    room.status = 'finished';
    room.result = result ?? { winner: null, reason: 'draw' };
  }
  res.json(roomState(room, req.body.token));
});

app.post('/api/rooms/:code/resign', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const me = findPlayer(room, req.body?.token);
  if (!me) return res.status(403).json({ error: 'Invalid token' });
  if (room.status !== 'active') return res.status(400).json({ error: 'Game is not active' });
  room.status = 'finished';
  room.result = { winner: me.color === 'white' ? 'black' : 'white', reason: 'resignation' };
  res.json(roomState(room, req.body.token));
});

app.post('/api/rooms/:code/draw-offer', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const me = findPlayer(room, req.body?.token);
  if (!me) return res.status(403).json({ error: 'Invalid token' });
  if (room.status !== 'active') return res.status(400).json({ error: 'Game is not active' });
  if (room.drawOffer?.color === me.color) {
    room.drawOffer = null;
    return res.json({ cancelled: true });
  }
  room.drawOffer = { color: me.color, name: me.name };
  res.json({ offered: true });
});

app.post('/api/rooms/:code/draw-accept', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const me = findPlayer(room, req.body?.token);
  if (!me) return res.status(403).json({ error: 'Invalid token' });
  if (!room.drawOffer) return res.status(400).json({ error: 'No draw offer' });
  if (room.drawOffer.color === me.color) return res.status(400).json({ error: 'Cannot accept own offer' });
  room.status = 'finished';
  room.result = { winner: null, reason: 'draw-agreement' };
  res.json(roomState(room, req.body.token));
});

app.post('/api/rooms/:code/draw-decline', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const me = findPlayer(room, req.body?.token);
  if (!me) return res.status(403).json({ error: 'Invalid token' });
  if (room.drawOffer && room.drawOffer.color !== me.color) room.drawOffer = null;
  res.json({ declined: true });
});

app.post('/api/rooms/:code/rematch', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const me = findPlayer(room, req.body?.token);
  if (!me) return res.status(403).json({ error: 'Invalid token' });
  if (room.status !== 'finished') return res.status(400).json({ error: 'Game is not finished' });
  room.chess = new Chess();
  room.status = room.players.black ? 'active' : 'waiting';
  room.result = null;
  room.drawOffer = null;
  res.json(roomState(room, req.body.token));
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  app.listen(PORT, () => console.log(`Chess Duel running on http://localhost:${PORT}`));
}

export { app, rooms };
