import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app, rooms } from '../server.js';

let white, black, code;

async function createRoom(name = 'Alice') {
  const res = await request(app).post('/api/rooms').send({ name });
  expect(res.status).toBe(200);
  return res.body;
}

async function joinRoom(c, name = 'Bob') {
  const res = await request(app).post(`/api/rooms/${c}/join`).send({ name });
  expect(res.status).toBe(200);
  return res.body;
}

async function move(token, from, to, promotion = undefined, c = code) {
  return request(app).post(`/api/rooms/${c}/move`).send({ token, from, to, promotion });
}

beforeEach(async () => {
  rooms.clear();
  white = await createRoom();
  code = white.code;
  black = await joinRoom(code);
});

describe('rooms', () => {
  it('creates a room and joins as black', async () => {
    const fresh = await createRoom('Solo');
    expect(fresh.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(fresh.color).toBe('white');
    expect(fresh.token).toBeTruthy();
    const waiting = (await request(app).get(`/api/rooms/${fresh.code}?token=${fresh.token}`)).body;
    expect(waiting.status).toBe('waiting');
    expect(waiting.players.black).toBeNull();
    const joined = await joinRoom(fresh.code, 'Rival');
    expect(joined.color).toBe('black');
    const state = (await request(app).get(`/api/rooms/${fresh.code}?token=${joined.token}`)).body;
    expect(state.status).toBe('active');
    expect(state.players.white.name).toBe('Solo');
    expect(state.players.black.name).toBe('Rival');
  });

  it('rejects joining a full room', async () => {
    const res = await request(app).post(`/api/rooms/${code}/join`).send({ name: 'Eve' });
    expect(res.status).toBe(409);
  });

  it('lists live rooms for spectators', async () => {
    const res = await request(app).get('/api/rooms');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const mine = res.body.find((r) => r.code === code);
    expect(mine).toBeTruthy();
    expect(mine.players.white.name).toBe('Alice');
    expect(mine.players.black.name).toBe('Bob');
    expect(mine.status).toBe('active');
    expect(mine.moves).toBe(0);
  });

  it('lets a spectator view state without a token', async () => {
    const res = await request(app).get(`/api/rooms/${code}`);
    expect(res.status).toBe(200);
    expect(res.body.you).toBeNull();
    expect(res.body.legalMoves).toHaveLength(0);
    expect(res.body.fen).toContain('rnbqkbnr');
  });

  it('returns 404 for unknown room', async () => {
    const res = await request(app).get('/api/rooms/ZZZZZZ');
    expect(res.status).toBe(404);
  });
});

describe('moves', () => {
  it('accepts a legal move and flips the turn', async () => {
    const res = await move(white.token, 'e2', 'e4');
    expect(res.status).toBe(200);
    expect(res.body.turn).toBe('b');
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].san).toBe('e4');
  });

  it('rejects moving out of turn', async () => {
    const res = await move(black.token, 'e7', 'e5');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/turn/i);
  });

  it('rejects illegal moves (through piece, bad target)', async () => {
    expect((await move(white.token, 'e2', 'e5')).status).toBe(400);
    expect((await move(white.token, 'e2', 'd3')).status).toBe(400); // pawn can't move diagonally
    expect((await move(white.token, 'd2', 'd4')).status).toBe(200);
    // now black to move; verify illegal knight jump
    expect((await move(black.token, 'g8', 'e7')).status).toBe(400);
  });

  it('rejects invalid tokens', async () => {
    const res = await move('bad-token', 'e2', 'e4');
    expect(res.status).toBe(403);
  });

  it('does not expose legal moves to the side not to move', async () => {
    const state = (await request(app).get(`/api/rooms/${code}?token=${white.token}`)).body;
    expect(state.you.color).toBe('white');
    expect(state.legalMoves.length).toBeGreaterThan(0);
    const blackState = (await request(app).get(`/api/rooms/${code}?token=${black.token}`)).body;
    expect(blackState.legalMoves).toHaveLength(0); // white to move, not black's
  });

  it('handles captures and piece removal in FEN', async () => {
    await move(white.token, 'e2', 'e4');
    await move(black.token, 'd7', 'd5');
    const res = await move(white.token, 'e4', 'd5');
    expect(res.status).toBe(200);
    expect(res.body.history[2].captured).toBe('p');
  });

  it('requires promotion piece and records it', async () => {
    // queenless-ish path to promotion: use custom room via direct chess manipulation
    const room = rooms.get(code);
    room.chess.load('8/P7/8/8/8/8/k6K/8 w - - 0 1');
    // It's white to move, a7-a8=Q
    const res = await move(white.token, 'a7', 'a8');
    // server defaults promotion? chess.js requires promotion for pawn to last rank
    expect(res.status).toBe(400);
    const res2 = await move(white.token, 'a7', 'a8', 'q');
    expect(res2.status).toBe(200);
    expect(res2.body.history[0].promotion).toBe('q');
  });

  it('detects checkmate and ends the game', async () => {
    const room = rooms.get(code);
    // fool's mate: 1.f3 e5 2.g4 Qh4#
    await move(white.token, 'f2', 'f3');
    await move(black.token, 'e7', 'e5');
    await move(white.token, 'g2', 'g4');
    const res = await move(black.token, 'd8', 'h4');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('finished');
    expect(res.body.result.winner).toBe('black');
    expect(res.body.result.reason).toBe('checkmate');
  });
});

describe('game flow extras', () => {
  it('resign ends game with opponent as winner', async () => {
    const res = await request(app).post(`/api/rooms/${code}/resign`).send({ token: white.token });
    expect(res.status).toBe(200);
    expect(res.body.result.winner).toBe('black');
    expect(res.body.result.reason).toBe('resignation');
  });

  it('draw offer must be accepted by opponent', async () => {
    await request(app).post(`/api/rooms/${code}/draw-offer`).send({ token: white.token });
    let state = (await request(app).get(`/api/rooms/${code}?token=${black.token}`)).body;
    expect(state.drawOffer.color).toBe('white');
    // white cannot accept own offer
    expect((await request(app).post(`/api/rooms/${code}/draw-accept`).send({ token: white.token })).status).toBe(400);
    const res = await request(app).post(`/api/rooms/${code}/draw-accept`).send({ token: black.token });
    expect(res.body.status).toBe('finished');
    expect(res.body.result.reason).toBe('draw-agreement');
  });

  it('rematch resets the board', async () => {
    await request(app).post(`/api/rooms/${code}/resign`).send({ token: white.token });
    const res = await request(app).post(`/api/rooms/${code}/rematch`).send({ token: black.token });
    expect(res.body.status).toBe('active');
    expect(res.body.history).toHaveLength(0);
    expect(res.body.turn).toBe('w');
  });

  it('blocks moves after game over', async () => {
    await request(app).post(`/api/rooms/${code}/resign`).send({ token: white.token });
    const res = await move(black.token, 'e7', 'e5');
    expect(res.status).toBe(400);
  });
});
