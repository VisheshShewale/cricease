import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { loadRooms, saveRoom } from './storage.js';
import { randomBytes, randomInt } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const app = express();
const allowedOrigins = (process.env.CLIENT_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
const corsOptions = { origin: (origin, callback) => callback(null, !origin || !allowedOrigins.length || allowedOrigins.includes(origin)), credentials: true };
app.use(cors(corsOptions)); app.use(express.json({ limit: '2mb' }));
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: corsOptions });
const rooms = new Map();
const aiCooldowns = new Map();
for (const row of await loadRooms()) rooms.set(row.code, row.state);
const persist = (code) => saveRoom(code, rooms.get(code));
const emitRoom = (code) => io.to(code).emit('room:update', publicRoom(rooms.get(code)));
const publicRoom = (room) => {
  if (!room) return null;
  const { hostSecret, ...safe } = room;
  return safe;
};
const newCode = () => { let c; do { c = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(c)); return c; };
const cleanName = (v) => String(v ?? '').trim().slice(0, 32);
const roles = ['Batter', 'Bowler', 'All-rounder', 'Wicketkeeper'];
let geminiClient;
const safeNum = (n, min, max) => Math.max(min, Math.min(max, Number(n) || min));
const roomError = (socket, message) => socket.emit('action:error', message);
const getRoom = (code) => rooms.get(String(code || '').toUpperCase());
const isHost = (socket, room) => Boolean(room && socket.data.hostSecret === room.hostSecret);

app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/network-info', (_req, res) => {
  const addresses = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      const address = entry.address;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) continue;
      addresses.push({ address, preferred: /wi-?fi|wlan|wireless/i.test(name) });
    }
  }
  addresses.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.address.localeCompare(b.address));
  res.json({ addresses: [...new Set(addresses.map(item => item.address))], clientPort: Number(process.env.VITE_PORT) || 5173 });
});
app.get('/api/room/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(publicRoom(room));
});

const parseAiJson = (s) => {
  const text = String(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
};
async function askAi(system, prompt) {
  const key = process.env.AI_API_KEY;
  const model = process.env.AI_MODEL;
  if (!key) throw new Error('AI_API_KEY is missing. Add your Gemini API key to the server .env file.');
  if (!model) throw new Error('AI_MODEL is missing. Add a Gemini model name to the server .env file.');
  geminiClient ||= new GoogleGenAI({ apiKey: key });
  let response;
  try {
    response = await geminiClient.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: system,
        temperature: 0.55,
        responseMimeType: 'application/json'
      }
    });
  } catch (error) {
    throw new Error(explainGeminiError(error));
  }
  const responseText = response.text;
  if (!responseText?.trim()) throw new Error('Gemini returned an empty response. Try again.');
  try {
    return parseAiJson(responseText);
  } catch {
    throw new Error('Gemini returned malformed JSON. Try again, or choose a model that supports JSON output.');
  }
}

function explainGeminiError(error) {
  const message = String(error?.message || error || '');
  const status = Number(error?.status || error?.code);
  if (/API_KEY_INVALID|api key.{0,30}(invalid|not valid)|invalid.{0,20}api key|unauthenticated/i.test(message) || status === 401) {
    return 'Gemini rejected the API key. Check that AI_API_KEY in .env is correct and enabled for the Gemini API.';
  }
  if (/model.{0,40}(not found|unsupported|invalid)|unsupported.{0,20}model|not supported.{0,20}model/i.test(message) || status === 404) {
    return 'Gemini could not use this model. Check AI_MODEL against the models available to your API key.';
  }
  if (/quota|resource_exhausted|rate.?limit|too many requests|billing|limit exceeded/i.test(message) || status === 429) {
    return 'Gemini quota or rate limit reached. Check your Google AI Studio usage and billing, then try again.';
  }
  if (status === 403 || /permission denied|permission.{0,20}denied/i.test(message)) {
    return 'Gemini denied access. Check that this API key has Gemini API access enabled.';
  }
  return 'Gemini request failed. Check your network and Gemini API status, then try again.';
}

app.post('/api/rooms/:code/players/generate', async (req, res) => {
  const room = getRoom(req.params.code);
  if (!room || req.headers['x-host-secret'] !== room.hostSecret) return res.status(403).json({ error: 'Host access required' });
  if (room.status !== 'setup') return res.status(409).json({ error: 'Player pool can only be generated before the auction starts.' });
  const count = safeNum(req.body.count, 12, 150);
  try {
    const result = await askAi('Create realistic cricket auction player records. Output only valid JSON with an array property named players. Roles must be Batter, Bowler, All-rounder, or Wicketkeeper. Do not include real-world claims as guaranteed facts; create plausible game data.', `Create exactly ${count} fictional cricket players suitable for a ${room.config.format} auction. Mix the four roles evenly, mix batting handedness and bowling styles. Each player needs name, role, country, battingStyle, bowlingStyle (use None when not applicable), rating from 55 to 95, basePrice exactly 0, and a one-line note. Return {"players":[...]}.`);
    const players = (result.players || []).slice(0, count).map((p, i) => normalizePlayer(p, i));
    if (players.length < 1) throw new Error('The AI returned no players. Try again.');
    room.players = players; await persist(room.code); emitRoom(room.code); res.json({ players });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/rooms/:code/players/import', async (req, res) => {
  const room = getRoom(req.params.code);
  if (!room || req.headers['x-host-secret'] !== room.hostSecret) return res.status(403).json({ error: 'Host access required' });
  if (room.status !== 'setup') return res.status(409).json({ error: 'Players can only be imported before the auction starts.' });
  if (!Array.isArray(req.body.players) || req.body.players.length < 1) return res.status(400).json({ error: 'The player list is empty or invalid.' });
  if (req.body.players.length > 150) return res.status(400).json({ error: 'Import up to 150 players at a time.' });
  const players = req.body.players
    .filter(p => cleanName(p?.name))
    .map((p, i) => normalizePlayer({ ...p, role: roles.includes(p.role) ? p.role : roles[i % roles.length], basePrice: 0 }, i));
  if (!players.length) return res.status(400).json({ error: 'No player names were found in the file.' });
  room.players = players; await persist(room.code); emitRoom(room.code); res.json({ players });
});

app.post('/api/rooms/:code/teams/:teamId/best-xi', async (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const team = room.teams.find(t => t.id === req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.players.length < room.config.xiSize) return res.status(409).json({ error: `This team needs ${room.config.xiSize} players before an XI can be selected.` });
  const key = `bestxi:${room.code}:${team.id}`;
  if (aiCooldowns.get(key) > Date.now()) return res.status(429).json({ error: 'Please wait a moment before asking for another XI.' });
  aiCooldowns.set(key, Date.now() + 15000);
  try {
    const result = await askAi('You are a cricket coach. Select the strongest balanced playing XI using only the supplied players. Follow role requirements. Return JSON: {"playerIds":[...],"captainId":"...","viceCaptainId":"...","summary":"..."}.', `Format: ${room.config.format}. Playing XI size: ${room.config.xiSize}. Role minimums: ${JSON.stringify(room.config.roleMinimums)}. Team: ${JSON.stringify(team.players)}. Select exactly ${room.config.xiSize} distinct player IDs and briefly explain the balance.`);
    const validIds = new Set(team.players.map(p => p.id));
    const ids = [...new Set((result.playerIds || []).filter(id => validIds.has(id)))].slice(0, room.config.xiSize);
    if (ids.length !== room.config.xiSize) throw new Error('The AI returned an incomplete XI. Try again.');
    res.json({ ...result, playerIds: ids });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

function normalizePlayer(p, i) {
  const requestedPrice = Number(p.basePrice);
  const basePrice = Number.isFinite(requestedPrice) ? Math.max(0, Math.min(100, requestedPrice)) : 1;
  return { id: randomBytes(5).toString('hex'), name: cleanName(p.name) || `Player ${i + 1}`, role: roles.includes(p.role) ? p.role : roles[i % 4], country: cleanName(p.country) || 'International', battingStyle: cleanName(p.battingStyle) || 'Right-hand bat', bowlingStyle: cleanName(p.bowlingStyle) || 'None', rating: safeNum(p.rating, 55, 99), basePrice, note: cleanName(p.note).slice(0, 100), status: 'available', soldTo: null, soldPrice: null };
}

function nominateNextPlayer(room) {
  const next = room.players.find(p => p.status === 'available');
  room.currentPlayerId = next?.id || null;
  room.currentBid = null;
  room.bidEndsAt = next ? Date.now() + room.config.timerSeconds * 1000 : null;
  if (!next) room.status = 'finished';
}

function rulesFor(room) {
  const c = room.config;
  return { purse: c.purse, squadSize: c.squadSize, xiSize: c.xiSize, roleLimits: c.roleLimits || {} };
}
function teamCanBid(room, team, player, amount) {
  const { purse, squadSize, roleLimits } = rulesFor(room);
  if (team.players.length >= squadSize) return 'Squad is full.';
  const spent = team.players.reduce((n, p) => n + p.soldPrice, 0);
  const remainingPlayers = squadSize - team.players.length - 1;
  if (purse - spent < amount + remainingPlayers * room.config.minimumBid) return 'Not enough purse left to complete your squad.';
  if ((roleLimits[player.role] ?? squadSize) <= team.players.filter(p => p.role === player.role).length) return `Your ${player.role.toLowerCase()} limit is full.`;
  return '';
}

io.on('connection', socket => {
  socket.on('room:create', async (payload, cb = () => {}) => {
    const name = cleanName(payload?.hostName) || 'Host';
    const code = newCode(); const hostSecret = randomBytes(24).toString('hex');
    const config = {
      format: ['T20', 'ODI', 'Test'].includes(payload?.format) ? payload.format : 'T20',
      teamCount: safeNum(payload?.teamCount, 2, 16), purse: safeNum(payload?.purse, 10, 10000),
      squadSize: safeNum(payload?.squadSize, 11, 30), xiSize: safeNum(payload?.xiSize, 11, 11),
      minimumBid: safeNum(payload?.minimumBid, 1, 100), bidIncrement: safeNum(payload?.bidIncrement, 1, 100),
      timerSeconds: safeNum(payload?.timerSeconds, 10, 180),
      roleLimits: { Batter: 7, Bowler: 7, 'All-rounder': 5, Wicketkeeper: 2, ...payload?.roleLimits },
      roleMinimums: payload?.roleMinimums || { Batter: 3, Bowler: 3, 'All-rounder': 1, Wicketkeeper: 1 }
    };
    const room = { code, hostSecret, hostName: name, status: 'setup', config, teams: [], players: [], currentPlayerId: null, currentBid: null, bidEndsAt: null, soldLog: [], createdAt: Date.now() };
    for (let i = 0; i < config.teamCount; i++) room.teams.push({ id: randomBytes(4).toString('hex'), name: `Team ${i + 1}`, captain: null, socketId: null, players: [] });
    rooms.set(code, room); await persist(code); socket.data.hostSecret = hostSecret; socket.join(code);
    cb({ room: publicRoom(room), hostSecret });
  });

  socket.on('room:reconnect-host', ({ code, hostSecret }, cb = () => {}) => {
    const room = getRoom(code); if (!room || room.hostSecret !== hostSecret) return cb({ error: 'Host session not found.' });
    socket.data.hostSecret = hostSecret; socket.join(room.code); cb({ room: publicRoom(room) });
  });

  socket.on('room:join', async ({ code, teamId, captain }, cb = () => {}) => {
    const room = getRoom(code); if (!room) return cb({ error: 'Room code not found.' });
    const team = room.teams.find(t => t.id === teamId);
    if (!team) return cb({ error: 'That team could not be found.' });
    if (team.socketId && team.socketId !== socket.id) io.to(team.socketId).emit('team:disconnected');
    team.captain = cleanName(captain) || 'Captain'; team.socketId = socket.id;
    socket.data.roomCode = room.code; socket.data.teamId = team.id; socket.join(room.code);
    await persist(room.code); emitRoom(room.code); cb({ room: publicRoom(room), teamId: team.id });
  });

  socket.on('host:rename-team', async ({ code, teamId, name }, cb = () => {}) => {
    const room = getRoom(code); if (!isHost(socket, room)) return cb({ error: 'Host access required.' });
    const team = room.teams.find(t => t.id === teamId); if (!team) return cb({ error: 'Team not found.' });
    team.name = cleanName(name) || team.name; await persist(code); emitRoom(code); cb({ ok: true });
  });

  socket.on('host:start', async ({ code }, cb = () => {}) => {
    const room = getRoom(code); if (!isHost(socket, room)) return cb({ error: 'Host access required.' });
    if (room.players.length === 0) return cb({ error: 'Generate a player pool first.' });
    if (room.teams.filter(t => t.captain).length < 2) return cb({ error: 'At least two teams need to join.' });
    room.status = 'live'; nominateNextPlayer(room); await persist(code); emitRoom(code); cb({ ok: true });
  });

  socket.on('host:nominate', async ({ code, playerId }, cb = () => {}) => {
    const room = getRoom(code); if (!isHost(socket, room)) return cb({ error: 'Host access required.' });
    if (room.status !== 'live') return cb({ error: 'Start the auction first.' });
    const p = room.players.find(x => x.id === playerId);
    if (!p || !['available', 'unsold'].includes(p.status)) return cb({ error: 'Player is no longer available.' });
    p.status = 'available';
    room.currentPlayerId = p.id; room.currentBid = null; room.bidEndsAt = Date.now() + room.config.timerSeconds * 1000; await persist(code); emitRoom(code); cb({ ok: true });
  });

  socket.on('team:bid', async ({ code, amount }, cb = () => {}) => {
    const room = getRoom(code); const team = room?.teams.find(t => t.id === socket.data.teamId);
    const p = room?.players.find(x => x.id === room.currentPlayerId);
    if (!room || !team || team.socketId !== socket.id) return cb({ error: 'Join a team before bidding.' });
    if (!p || !room.bidEndsAt || room.bidEndsAt <= Date.now()) return cb({ error: 'Bidding is closed.' });
    const min = room.currentBid ? room.currentBid.amount + room.config.bidIncrement : Math.max(p.basePrice, room.config.minimumBid);
    if (amount !== min) return cb({ error: `Next bid must be ${min}.` });
    const why = teamCanBid(room, team, p, amount); if (why) return cb({ error: why });
    room.currentBid = { teamId: team.id, amount, captain: team.captain };
    room.bidEndsAt = Date.now() + room.config.timerSeconds * 1000; await persist(code); emitRoom(code); cb({ ok: true });
  });

  socket.on('host:close-bidding', async ({ code, outcome }, cb = () => {}) => {
    const room = getRoom(code); if (!isHost(socket, room)) return cb({ error: 'Host access required.' });
    const p = room?.players.find(x => x.id === room.currentPlayerId);
    if (!room || !p) return cb({ error: 'No player is up for auction.' });
    if (outcome === 'sold' && room.currentBid) {
      const team = room.teams.find(t => t.id === room.currentBid.teamId);
      team.players.push({ ...p, soldPrice: room.currentBid.amount }); p.status = 'sold'; p.soldTo = team.id; p.soldPrice = room.currentBid.amount;
      room.soldLog.unshift({ player: p.name, team: team.name, price: p.soldPrice, role: p.role });
    } else { p.status = 'unsold'; room.soldLog.unshift({ player: p.name, team: null, price: null, role: p.role }); }
    nominateNextPlayer(room); await persist(code); emitRoom(code); cb({ ok: true });
  });

  socket.on('host:reopen-unsold', async ({ code, playerId }, cb = () => {}) => {
    const room = getRoom(code); if (!isHost(socket, room)) return cb({ error: 'Host access required.' });
    const p = room?.players.find(x => x.id === playerId && x.status === 'unsold');
    if (!p) return cb({ error: 'Player is not unsold.' }); p.status = 'available'; await persist(code); emitRoom(code); cb({ ok: true });
  });

  socket.on('host:finish', async ({ code }, cb = () => {}) => {
    const room = getRoom(code); if (!isHost(socket, room)) return cb({ error: 'Host access required.' });
    room.status = 'finished'; room.currentPlayerId = null; room.bidEndsAt = null; await persist(code); emitRoom(code); cb({ ok: true });
  });
  socket.on('disconnect', () => {
    const room = getRoom(socket.data.roomCode); const team = room?.teams.find(t => t.id === socket.data.teamId);
    if (team?.socketId === socket.id) { team.socketId = null; persist(room.code).catch(error => console.error('Could not save room after disconnect:', error.message)); emitRoom(room.code); }
  });
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
}
const port = Number(process.env.PORT) || 3001;
httpServer.listen(port, '0.0.0.0', () => console.log(`Crease server listening on ${port}`));
