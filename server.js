require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const changelog = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'changelog.json'), 'utf8')
);

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/changelog', (req, res) => {
  res.json(changelog);
});

// ── Admin Routes & Authorization ──────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? null : 'admin123');

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD must be set in production.');
  process.exit(1);
}

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized: Invalid Admin Password' });
}

// Serve admin portal
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin APIs
app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true, token: ADMIN_PASSWORD });
  }
  return res.status(401).json({ success: false, message: 'Incorrect password.' });
});

app.get('/api/admin/replays', requireAdminAuth, async (req, res) => {
  const replays = await db.getAllReplays();
  const stats = await db.getStats();
  res.json({ replays, stats });
});

app.get('/api/admin/replays/:id', requireAdminAuth, async (req, res) => {
  const replay = await db.getReplayById(req.params.id);
  if (!replay) return res.status(404).json({ error: 'Replay not found' });
  res.json({ replay });
});

app.delete('/api/admin/replays/:id', requireAdminAuth, async (req, res) => {
  const success = await db.deleteReplay(req.params.id);
  if (!success) return res.status(400).json({ error: 'Could not delete replay' });
  res.json({ success: true });
});


// ── In-memory store ──────────────────────────────────────────────
const rooms = {};
const GRACE_PERIOD_MS = 120000;

function activePlayers(room) {
  return room.players.filter(player => !player.spectator);
}

function connectedActivePlayers(room) {
  return room.players.filter(player => !player.spectator && player.connected);
}

function emitPlacementStatus(roomId, room) {
  const active = activePlayers(room);
  const connectedActive = connectedActivePlayers(room);
  io.to(roomId).emit('placement_status', {
    turnId: room.activeTurnId,
    completedPlayerIds: [...(room.playersPlacedThisTurn || [])],
    players: room.players.map(player => {
      const isDisconnected = !player.connected;
      const timeLeft = isDisconnected && player.disconnectExpiresAt
        ? Math.max(0, Math.ceil((player.disconnectExpiresAt - Date.now()) / 1000))
        : 0;
      return {
        playerId: player.id,
        completed: player.spectator || room.playersPlacedThisTurn?.has(player.id) === true,
        disconnected: isDisconnected,
        reconnectTimeLeft: timeLeft,
        spectator: !!player.spectator
      };
    }),
    completed: room.playersPlacedThisTurn?.size || 0,
    total: connectedActive.length
  });
}

// ── Local dictionary & Chinese Rarity Pools ────────────────────
const dictionaryEntries = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'chengyu_dictionary.json'), 'utf8')
);

const DICTIONARY = new Map();

dictionaryEntries.forEach(item => {
  if (!item.characters || typeof item.characters !== 'string') return;
  const word = item.characters.trim();
  if (word.length >= 3 && word.length <= 6 && /^[\u4e00-\u9fa5]+$/.test(word)) {
    if (!DICTIONARY.has(word)) {
      DICTIONARY.set(word, []);
    }
    const meaning = item.meaning_cn || item.meaning_en || '';
    const defStr = item.pinyin ? `[${item.pinyin}] ${meaning}` : meaning;
    DICTIONARY.get(word).push(defStr);
  }
});

const characterPoolData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'character_pools.json'), 'utf8')
);
const COMMON_CHARS = characterPoolData.pools?.COMMON;
const UNCOMMON_CHARS = characterPoolData.pools?.UNCOMMON;
const RARE_CHARS = characterPoolData.pools?.RARE;

const characterPoolDefinitions = [
  ['COMMON', COMMON_CHARS, 12],
  ['UNCOMMON', UNCOMMON_CHARS, 6],
  ['RARE', RARE_CHARS, 2]
];
const seenPoolCharacters = new Set();
for (const [tier, pool, minimumSize] of characterPoolDefinitions) {
  if (!Array.isArray(pool) || pool.length < minimumSize || characterPoolData.counts?.[tier] !== pool.length) {
    throw new Error(`Invalid ${tier} character pool in character_pools.json.`);
  }
  for (const character of pool) {
    if (typeof character !== 'string' || !/^[\u4e00-\u9fa5]$/.test(character) || seenPoolCharacters.has(character)) {
      throw new Error(`Invalid or duplicate character in ${tier} pool in character_pools.json.`);
    }
    seenPoolCharacters.add(character);
  }
}

function getRandomCharFromPool(pool, excludeSet = new Set()) {
  const candidates = pool.filter(c => !excludeSet.has(c));
  if (candidates.length === 0) {
    return pool[Math.floor(Math.random() * pool.length)];
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function generateMarket() {
  const market = [];
  const used = new Set();

  // 12 common slots: indices 0–11
  for (let i = 0; i < 12; i++) {
    const char = getRandomCharFromPool(COMMON_CHARS, used);
    used.add(char);
    market.push({ char, tier: 'common', index: i });
  }
  // 6 uncommon slots: indices 12–17
  for (let i = 12; i <= 17; i++) {
    const char = getRandomCharFromPool(UNCOMMON_CHARS, used);
    used.add(char);
    market.push({ char, tier: 'uncommon', index: i });
  }
  // 2 rare slots: indices 18–19
  for (let i = 18; i <= 19; i++) {
    const char = getRandomCharFromPool(RARE_CHARS, used);
    used.add(char);
    market.push({ char, tier: 'rare', index: i });
  }

  return market;
}

function refillMarketSlot(market, index) {
  if (!market || !market[index]) return;
  const currentChars = new Set(market.map(m => m.char));
  let pool = COMMON_CHARS;
  let tier = 'common';

  if (index >= 12 && index <= 17) {
    pool = UNCOMMON_CHARS;
    tier = 'uncommon';
  } else if (index >= 18) {
    pool = RARE_CHARS;
    tier = 'rare';
  }

  const newChar = getRandomCharFromPool(pool, currentChars);
  market[index] = { char: newChar, tier, index };
}

console.log(`Chinese Dictionary loaded: ${DICTIONARY.size} 3-6 char words. Common: ${COMMON_CHARS.length}, Uncommon: ${UNCOMMON_CHARS.length}, Rare: ${RARE_CHARS.length}`);

// ── Helpers ──────────────────────────────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function generatePlayerId() {
  return 'p_' + Math.random().toString(36).substring(2, 10);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getRandomEmptyIndex(board) {
  const currentBoard = Array.isArray(board) && board.length === 36
    ? board
    : Array(36).fill('');
  const emptyIndices = [];
  for (let i = 0; i < 36; i++) {
    if (!currentBoard[i]) emptyIndices.push(i);
  }
  if (emptyIndices.length === 0) return -1;
  return emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
}

// Score a 6x6 board (array of 36 cells, row-major)
function scoreBoard(grid) {
  const words = [];
  const size = 6;

  function checkLine(cells, positions) {
    const line = cells.map(c => c || '');
    for (let start = 0; start < size; start++) {
      for (let end = start + 3; end <= size; end++) {
        const slice = line.slice(start, end);
        const slicePositions = positions.slice(start, end);
        if (slice.some(c => !c)) continue;
        const word = slice.join('');
        const wordDefinitions = DICTIONARY.get(word);
        if (wordDefinitions) {
          let score = 0;
          if (word.length === 3) score = 3;
          else if (word.length === 4) score = 8;
          else if (word.length === 5) score = 12;
          else if (word.length === 6) score = 20;

          words.push({
            word,
            score,
            positions: slicePositions,
            meanings: [{
              partOfSpeech: 'definition',
              definitions: wordDefinitions.slice(0, 2)
            }]
          });
        }
      }
    }
  }

  // Rows
  for (let r = 0; r < size; r++) {
    const rowPositions = Array.from({ length: size }, (_, c) => r * size + c);
    checkLine(grid.slice(r * size, r * size + size), rowPositions);
  }
  // Columns
  for (let c = 0; c < size; c++) {
    const col = [];
    const colPositions = [];
    for (let r = 0; r < size; r++) {
      col.push(grid[r * size + c]);
      colPositions.push(r * size + c);
    }
    checkLine(col, colPositions);
  }

  const total = words.reduce((sum, w) => sum + w.score, 0);
  return { words, total };
}

// ── Socket.io ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // CREATE ROOM
  socket.on('create_room', ({ playerName }) => {
    let roomId;
    do { roomId = generateRoomId(); } while (rooms[roomId]);

    const playerId = generatePlayerId();

    rooms[roomId] = {
      id: roomId,
      hostId: playerId,
      players: [{
        id: playerId,
        socketId: socket.id,
        name: playerName,
        connected: true,
        disconnectTimer: null,
        disconnectExpiresAt: null,
        board: null,
        score: null,
        words: null,
        spectator: false
      }],
      phase: 'lobby',       // lobby | playing | manual_scoring | scoring
      turnOrder: [],
      currentTurnIndex: 0,
      calledLetters: [],    // [{letter, calledBy}]
      lettersLeft: 25,
      activeTurnId: null,
      finalTurnStarted: false,
      finalTurnSelections: new Map(),
      automaticScoring: false,
      manualClaims: new Map(),
      manualReady: new Set(),
      manualSearchDuration: 120,
      manualScoringTimeout: null,
      manualScoringDeadline: null
    };

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    socket.data.playerName = playerName;

    socket.emit('room_created', { roomId, playerId, playerName });
    socket.emit('room_state', sanitiseRoom(rooms[roomId]));
    console.log(`Room ${roomId} created by ${playerName} (${playerId})`);
  });

  function rejoinPlayer(socket, room, player) {
    const previousSocketId = player.socketId;
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    player.connected = true;
    player.socketId = socket.id;
    player.disconnectExpiresAt = null;

    if (previousSocketId && previousSocketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      if (previousSocket) previousSocket.disconnect(true);
    }

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.playerId = player.id;
    socket.data.playerName = player.name;

    const currentTurnPlayer = room.turnOrder ? room.players.find(p => p.id === room.turnOrder[room.currentTurnIndex]) : null;
    const hasPlacedThisTurn = room.playersPlacedThisTurn ? room.playersPlacedThisTurn.has(player.id) : false;
    const lastCalled = room.calledLetters && room.calledLetters.length > 0 ? room.calledLetters[room.calledLetters.length - 1] : null;

    socket.emit('rejoined_success', {
      roomId: room.id,
      playerId: player.id,
      playerName: player.name,
      isHost: room.hostId === player.id,
      hostId: room.hostId,
      phase: room.phase,
      players: sanitiseRoom(room).players,
      grid: player.board || Array(25).fill(''),
      calledLetters: room.calledLetters || [],
      currentTurnPlayerId: currentTurnPlayer ? currentTurnPlayer.id : null,
      currentTurnPlayerName: currentTurnPlayer ? currentTurnPlayer.name : null,
      turnIndex: room.currentTurnIndex || 0,
      totalTurns: room.turnOrder ? room.turnOrder.length : 0,
      turnTimer: room.turnTimer || 0,
      currentLetter: room.letterCalledThisTurn && lastCalled ? lastCalled.letter : null,
      currentLetterCaller: room.letterCalledThisTurn && lastCalled ? lastCalled.calledBy : null,
      activeTurnId: room.activeTurnId || null,
      placementStatus: room.players.map(currentPlayer => {
        const isDisconnected = !currentPlayer.connected;
        const timeLeft = isDisconnected && currentPlayer.disconnectExpiresAt
          ? Math.max(0, Math.ceil((currentPlayer.disconnectExpiresAt - Date.now()) / 1000))
          : 0;
        return {
          playerId: currentPlayer.id,
          completed: currentPlayer.spectator || room.playersPlacedThisTurn?.has(currentPlayer.id) === true,
          disconnected: isDisconnected,
          reconnectTimeLeft: timeLeft,
          spectator: !!currentPlayer.spectator
        };
      }),
      placedThisTurn: hasPlacedThisTurn,
      letterCalledThisTurn: room.letterCalledThisTurn || false,
      finalTurnStarted: room.finalTurnStarted || false,
      manualScoringDeadline: room.phase === 'manual_scoring' ? room.manualScoringDeadline : null,
      manualClaims: room.phase === 'manual_scoring' ? (room.manualClaims.get(player.id) || []) : [],
      manualProgress: room.phase === 'manual_scoring' ? getManualProgress(room) : [],
      manualReady: room.phase === 'manual_scoring' && room.manualReady.has(player.id),
      automaticScoring: room.automaticScoring === true,
      spectator: !!player.spectator,
      leaderboard: room.phase === 'scoring'
        ? activePlayers(room)
          .map(p => ({ name: p.name, score: p.score, words: p.words, board: p.board }))
          .sort((a, b) => (b.score || 0) - (a.score || 0))
        : null
    });

    const host = room.players.find(p => p.id === room.hostId && p.connected);
    if (host && host.socketId) {
      io.to(host.socketId).emit('player_reconnected', {
        playerId: player.id,
        playerName: player.name,
        players: sanitiseRoom(room).players
      });
    }
    emitPlacementStatus(room.id, room);

    console.log(`${player.name} (${player.id}) reconnected to room ${room.id}`);
  }

  // JOIN ROOM
  socket.on('join_room', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', { message: '未找到该房间。' });

    const existingPlayer = room.players.find(p => p.name.trim().toLowerCase() === playerName.trim().toLowerCase());

    if (room.phase !== 'lobby') {
      if (existingPlayer && !existingPlayer.connected) {
        return rejoinPlayer(socket, room, existingPlayer);
      }
      return socket.emit('error', { message: '游戏进行中，新玩家无法加入。' });
    }

    if (room.players.length >= 50) return socket.emit('error', { message: '房间已满。' });
    if (existingPlayer) {
      if (!existingPlayer.connected) {
        return rejoinPlayer(socket, room, existingPlayer);
      }
      return socket.emit('error', { message: '该名字在房间中已被占用。' });
    }

    const playerId = generatePlayerId();

    room.players.push({
      id: playerId,
      socketId: socket.id,
      name: playerName,
      connected: true,
      disconnectTimer: null,
      disconnectExpiresAt: null,
      board: null,
      score: null,
      words: null,
      spectator: false
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    socket.data.playerName = playerName;

    socket.emit('room_joined', { roomId, playerId, playerName });
    io.to(roomId).emit('room_state', sanitiseRoom(room));
    console.log(`${playerName} (${playerId}) joined room ${roomId}`);
  });

  socket.on('claim_word', ({ start, end }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.phase !== 'manual_scoring') return;

    const player = room.players.find(currentPlayer => currentPlayer.id === socket.data.playerId);
    if (!player || player.spectator) return;

    const claim = validateWordClaim(player, start, end);
    if (claim.error) {
      return socket.emit('word_claim_result', { valid: false, message: claim.error });
    }

    const claims = room.manualClaims.get(player.id) || [];
    const claimKey = claim.positions.join(',');
    if (claims.some(existing => existing.positions.join(',') === claimKey)) {
      return socket.emit('word_claim_result', { valid: false, message: '你已经找到了该词语。' });
    }

    claims.push(claim);
    room.manualClaims.set(player.id, claims);
    const score = claims.reduce((total, word) => total + word.score, 0);
    socket.emit('word_claim_result', { valid: true, word: claim, total: score });
    io.to(roomId).emit('manual_scoring_progress', { progress: getManualProgress(room) });
  });

  socket.on('manual_ready', ({ ready = true } = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.phase !== 'manual_scoring') return;

    const player = room.players.find(currentPlayer => currentPlayer.id === socket.data.playerId);
    if (!player || player.spectator) return;
    if (ready) {
      room.manualReady.add(player.id);
    } else {
      room.manualReady.delete(player.id);
    }
    io.to(roomId).emit('manual_scoring_progress', { progress: getManualProgress(room) });

    if (ready && activePlayers(room).every(activePlayer => room.manualReady.has(activePlayer.id))) {
      finishManualScoring(roomId, room);
    }
  });

  // REJOIN ROOM (Session Restore)
  socket.on('rejoin_room', ({ roomId, playerId, playerName }) => {
    const room = rooms[roomId];
    if (!room) {
      return socket.emit('rejoin_failed', { message: '房间已不存在。' });
    }

    const player = room.players.find(p => p.id === playerId || (p.name.trim().toLowerCase() === playerName.trim().toLowerCase() && !p.connected));
    if (!player) {
      return socket.emit('rejoin_failed', { message: '会话已过期或玩家不在房间内。' });
    }

    rejoinPlayer(socket, room, player);
  });

  function handleActivePlayerRemoval(roomId, room, playerId) {
    if (room.phase !== 'playing') return;

    const remainingActive = activePlayers(room);
    const remainingIds = remainingActive.map(p => p.id);

    if (remainingIds.length === 0) {
      if (room.turnTimeout) clearTimeout(room.turnTimeout);
      if (room.finalTurnTimeout) clearTimeout(room.finalTurnTimeout);
      delete rooms[roomId];
      console.log(`Room ${roomId} deleted (no active players left)`);
      return;
    }

    let wasTheirTurn = (room.turnOrder && room.turnOrder[room.currentTurnIndex] === playerId);

    if (room.turnOrder) {
      for (let i = room.currentTurnIndex; i < room.turnOrder.length; i++) {
        if (room.turnOrder[i] === playerId) {
          room.turnOrder[i] = remainingIds[Math.floor(Math.random() * remainingIds.length)];
        }
      }
    }

    if (room.finalTurnStarted) {
      if (room.finalTurnSelections) room.finalTurnSelections.delete(playerId);
      const connectedActive = connectedActivePlayers(room);
      if (room.finalTurnSelections && room.finalTurnSelections.size >= connectedActive.length) {
        finishFinalTurnAndScore(roomId, room);
      }
    } else {
      if (wasTheirTurn && !room.letterCalledThisTurn) {
        const nextId = room.turnOrder[room.currentTurnIndex];
        const nextPlayer = room.players.find(p => p.id === nextId);
        io.to(roomId).emit('next_turn', {
          playerId: nextId,
          playerName: nextPlayer?.name,
          turnIndex: room.currentTurnIndex,
          totalTurns: room.turnOrder.length,
          turnTimer: room.turnTimer
        });
        startCallTimer(roomId, room, nextId);
      }

      if (room.letterCalledThisTurn) {
        if (room.playersPlacedThisTurn) room.playersPlacedThisTurn.delete(playerId);
        const connectedActive = connectedActivePlayers(room);
        if (room.playersPlacedThisTurn && room.playersPlacedThisTurn.size >= connectedActive.length) {
          resolveTurnPlacements(roomId, room, room.activeTurnId);
        }
      }
    }

    emitPlacementStatus(roomId, room);
  }

  // LEAVE ROOM
  socket.on('leave_room', () => {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    const room = rooms[roomId];
    if (!room || !playerId) return;

    const playerIndex = room.players.findIndex(player => player.id === playerId);
    if (playerIndex === -1) return;

    const [leavingPlayer] = room.players.splice(playerIndex, 1);
    if (leavingPlayer.disconnectTimer) clearTimeout(leavingPlayer.disconnectTimer);
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.playerId = null;
    socket.data.playerName = null;

    console.log(`${leavingPlayer.name} (${leavingPlayer.id}) left room ${roomId}`);

    if (room.players.length === 0) {
      if (room.turnTimeout) clearTimeout(room.turnTimeout);
      if (room.finalTurnTimeout) clearTimeout(room.finalTurnTimeout);
      delete rooms[roomId];
      console.log(`Room ${roomId} deleted (empty)`);
      return;
    }

    if (room.hostId === playerId) {
      const nextHost = room.players.find(player => player.connected) || room.players[0];
      room.hostId = nextHost.id;
      io.to(roomId).emit('host_changed', {
        newHostId: nextHost.id,
        newHostName: nextHost.name
      });
    }

    io.to(roomId).emit('player_left', {
      playerName: leavingPlayer.name,
      players: sanitiseRoom(room).players
    });

    handleActivePlayerRemoval(roomId, room, playerId);
  });

  // HOST KICKS A PLAYER
  socket.on('kick_player', ({ targetPlayerId }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;

    if (room.hostId !== socket.data.playerId) {
      return socket.emit('error', { message: '只有房主可以踢出玩家。' });
    }
    if (targetPlayerId === room.hostId) {
      return socket.emit('error', { message: '房主不能踢出自己。' });
    }

    const playerIndex = room.players.findIndex(p => p.id === targetPlayerId);
    if (playerIndex === -1) return;

    const [kickedPlayer] = room.players.splice(playerIndex, 1);
    if (kickedPlayer.disconnectTimer) clearTimeout(kickedPlayer.disconnectTimer);

    if (kickedPlayer.socketId) {
      const kickedSocket = io.sockets.sockets.get(kickedPlayer.socketId);
      if (kickedSocket) {
        kickedSocket.leave(roomId);
        kickedSocket.data.roomId = null;
        kickedSocket.data.playerId = null;
        kickedSocket.data.playerName = null;
        kickedSocket.emit('kicked_from_room', { message: '你已被房主踢出房间。' });
      }
    }

    io.to(roomId).emit('player_kicked', {
      kickedPlayerId: targetPlayerId,
      kickedPlayerName: kickedPlayer.name,
      players: sanitiseRoom(room).players
    });

    console.log(`${kickedPlayer.name} (${kickedPlayer.id}) was kicked from room ${roomId} by host`);

    handleActivePlayerRemoval(roomId, room, targetPlayerId);
  });

  // HOST STARTS GAME
  socket.on('start_game', (data) => {
    const turnTimer = data && data.turnTimer ? data.turnTimer : 0;
    const spectatorHost = data && data.spectatorHost === true;
    const automaticScoring = data && data.automaticScoring === true;
    const requestedManualSearchDuration = Number.parseInt(data?.manualSearchDuration, 10);
    const manualSearchDuration = Number.isFinite(requestedManualSearchDuration)
      ? Math.min(Math.max(requestedManualSearchDuration, 60), 600)
      : 120;
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    if (room.hostId !== socket.data.playerId) return socket.emit('error', { message: '只有房主可以开始游戏。' });
    const activePlayerCount = room.players.length - (spectatorHost ? 1 : 0);
    if (activePlayerCount < 2) return socket.emit('error', { message: '需要至少 2 名玩家参与游戏。' });
    if (room.phase !== 'lobby') return;

    room.phase = 'playing';
    room.players.forEach(player => { player.spectator = spectatorHost && player.id === socket.data.playerId; });
    room.calledLetters = [];
    room.currentTurnIndex = 0;
    room.playersPlacedThisTurn = new Set();
    room.letterCalledThisTurn = false;
    room.activeTurnId = null;
    room.turnTimer = turnTimer;
    room.finalTurnStarted = false;
    room.finalTurnSelections = new Map();
    room.automaticScoring = automaticScoring;
    room.manualSearchDuration = manualSearchDuration;
    room.manualClaims = new Map();
    room.manualReady = new Set();
    room.manualScoringDeadline = null;
    if (room.manualScoringTimeout) clearTimeout(room.manualScoringTimeout);
    room.manualScoringTimeout = null;
    if (room.turnTimeout) clearTimeout(room.turnTimeout);
    if (room.finalTurnTimeout) clearTimeout(room.finalTurnTimeout);

    const TOTAL_TURNS = 35;
    room.lettersLeft = TOTAL_TURNS;
    room.market = generateMarket();

    let generatedTurnOrder = [];
    let playerIds = activePlayers(room).map(p => p.id);

    while (generatedTurnOrder.length < TOTAL_TURNS) {
      let shuffled = shuffle([...playerIds]);
      let needed = TOTAL_TURNS - generatedTurnOrder.length;
      generatedTurnOrder = generatedTurnOrder.concat(shuffled.slice(0, needed));
    }

    room.turnOrder = generatedTurnOrder;

    const currentPlayer = room.players.find(p => p.id === room.turnOrder[0]);
    io.to(roomId).emit('game_started', {
      turnOrder: room.turnOrder.map(id => room.players.find(p => p.id === id)?.name),
      currentTurn: {
        playerId: room.turnOrder[0],
        playerName: currentPlayer?.name
      },
      totalTurns: room.lettersLeft,
      turnTimer: room.turnTimer,
      market: room.market,
      spectatorHost,
      automaticScoring
    });

    startCallTimer(roomId, room, room.turnOrder[0]);
    emitPlacementStatus(roomId, room);
    console.log(`Game started in room ${roomId} with ${room.players.length} players. Timer: ${turnTimer}s`);
  });

  // PLAYER CALLS A LETTER FROM MARKET
  socket.on('call_letter', ({ letterIndex, letter }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.phase !== 'playing') return;
    if (room.finalTurnStarted) {
      return socket.emit('error', { message: '最终回合由每位玩家各自进行。' });
    }
    if (room.letterCalledThisTurn) {
      return socket.emit('error', { message: '本回合已选择过汉字。' });
    }

    const expectedId = room.turnOrder[room.currentTurnIndex];
    if (socket.data.playerId !== expectedId) return socket.emit('error', { message: "还没到你的回合。" });

    let marketSlot = room.market ? room.market[letterIndex] : null;
    if (!marketSlot && letter && room.market) {
      marketSlot = room.market.find(m => m.char === letter);
    }
    if (!marketSlot) return socket.emit('error', { message: '所选汉字目前在市场中不可用。' });

    const chosenChar = marketSlot.char;
    const slotIdx = marketSlot.index;

    const turnId = `${room.currentTurnIndex}-${room.calledLetters.length + 1}`;
    room.activeTurnId = turnId;
    room.currentLetter = chosenChar;
    room.calledLetters.push({ letter: chosenChar, calledBy: socket.data.playerName, turnId });
    room.letterCalledThisTurn = true;
    room.playersPlacedThisTurn = new Set();

    // Refill the picked market slot with same rarity
    refillMarketSlot(room.market, slotIdx);

    io.to(roomId).emit('letter_called', {
      letter: chosenChar,
      calledBy: socket.data.playerName,
      calledLetters: room.calledLetters,
      market: room.market,
      turnId,
      turnsLeft: room.turnOrder.length - room.calledLetters.length,
      turnTimer: room.turnTimer
    });
    emitPlacementStatus(roomId, room);

    startPlaceTimer(roomId, room, chosenChar, turnId);
  });

  socket.on('final_letter_choice', ({ letter }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || !room.finalTurnStarted || room.phase !== 'playing') return;

    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player) return;
    if (player.spectator) return socket.emit('error', { message: '观战者无法挑选汉字。' });

    const l = String(letter || '').trim();
    if (!/^[\u4e00-\u9fa5]$/.test(l)) return socket.emit('error', { message: '无效汉字。' });
    if (room.finalTurnSelections.has(player.id)) {
      return socket.emit('error', { message: '你已提交终局汉字。' });
    }

    const emptyIndex = (player.board || []).findIndex(cell => !cell);
    if (emptyIndex === -1) {
      return socket.emit('error', { message: '你的棋盘已没有空格。' });
    }

    player.board[emptyIndex] = l;
    room.finalTurnSelections.set(player.id, l);

    const connectedActive = connectedActivePlayers(room);
    io.to(roomId).emit('final_letter_confirmed', {
      playerId: player.id,
      playerName: player.name,
      letter: l,
      grid: player.board || Array(36).fill(''),
      emptyIndex,
      remaining: connectedActive.length - room.finalTurnSelections.size,
      allChosen: room.finalTurnSelections.size >= connectedActive.length
    });

    if (room.finalTurnSelections.size >= connectedActive.length) {
      finishFinalTurnAndScore(roomId, room);
    }
  });

  // PLAYER PLACES A LETTER
  socket.on('letter_placed', ({ grid, turnId }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.phase !== 'playing') return;
    if (room.finalTurnStarted) return;

    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player || player.spectator || !room.letterCalledThisTurn || turnId !== room.activeTurnId) return;
    if (room.playersPlacedThisTurn.has(player.id)) return;
    if (!isValidPlacement(player.board, grid, room.currentLetter)) {
      return socket.emit('error', { message: '放置位置无效。', rollback: true, grid: player.board || Array(36).fill('') });
    }

    player.board = grid.slice();
    room.playersPlacedThisTurn.add(player.id);
    emitPlacementStatus(roomId, room);

    const connectedActive = connectedActivePlayers(room);
    if (room.playersPlacedThisTurn.size >= connectedActive.length) {
      resolveTurnPlacements(roomId, room, turnId);
    }
  });

  function isValidPlacement(previousGrid, nextGrid, letter) {
    if (!Array.isArray(nextGrid) || nextGrid.length !== 36 || !/^[\u4e00-\u9fa5]$/.test(letter || '')) return false;
    if (nextGrid.some(cell => cell !== '' && !/^[\u4e00-\u9fa5]$/.test(cell))) return false;

    const previous = Array.isArray(previousGrid) && previousGrid.length === 36
      ? previousGrid
      : Array(36).fill('');
    let changedIndex = -1;
    for (let index = 0; index < 36; index++) {
      if (nextGrid[index] !== previous[index]) {
        if (changedIndex !== -1 || previous[index] !== '' || nextGrid[index] !== letter) return false;
        changedIndex = index;
      }
    }
    return changedIndex !== -1;
  }

  // DISCONNECT
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !rooms[roomId] || !playerId) return;

    const room = rooms[roomId];
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    if (player.socketId !== socket.id) return;

    player.connected = false;
    player.disconnectExpiresAt = Date.now() + GRACE_PERIOD_MS;
    console.log(`${player.name} (${player.id}) temporarily disconnected from ${roomId}`);

    const host = room.players.find(p => p.id === room.hostId && p.connected);
    if (host && host.socketId) {
      io.to(host.socketId).emit('player_disconnected', {
        playerId: player.id,
        playerName: player.name,
        players: sanitiseRoom(room).players,
        reconnectTimeLeft: Math.ceil(GRACE_PERIOD_MS / 1000)
      });
    }

    emitPlacementStatus(roomId, room);

    // Start grace period timer for player to reconnect
    player.disconnectTimer = setTimeout(() => {
      if (!rooms[roomId]) return;
      const currentRoom = rooms[roomId];
      const pIndex = currentRoom.players.findIndex(p => p.id === playerId);
      if (pIndex === -1) return;

      const targetPlayer = currentRoom.players[pIndex];
      if (targetPlayer.connected) return;

      currentRoom.players.splice(pIndex, 1);
      console.log(`${targetPlayer.name} grace period expired. Permanently removed from ${roomId}`);

      if (currentRoom.players.length === 0) {
        delete rooms[roomId];
        console.log(`Room ${roomId} deleted (empty)`);
        return;
      }

      if (currentRoom.hostId === playerId) {
        const nextHost = currentRoom.players.find(pl => pl.connected) || currentRoom.players[0];
        currentRoom.hostId = nextHost.id;
        io.to(roomId).emit('host_changed', { newHostId: currentRoom.hostId, newHostName: nextHost.name });
      }

      io.to(roomId).emit('player_left', {
        playerName: targetPlayer.name,
        players: sanitiseRoom(currentRoom).players
      });

      if (currentRoom.phase === 'playing') {
        const remainingIds = currentRoom.players.map(p => p.id);
        let wasTheirTurn = (currentRoom.turnOrder[currentRoom.currentTurnIndex] === playerId);

        for (let i = currentRoom.currentTurnIndex; i < currentRoom.turnOrder.length; i++) {
          if (currentRoom.turnOrder[i] === playerId) {
            currentRoom.turnOrder[i] = remainingIds[Math.floor(Math.random() * remainingIds.length)];
          }
        }

        if (wasTheirTurn && !currentRoom.letterCalledThisTurn) {
          const nextId = currentRoom.turnOrder[currentRoom.currentTurnIndex];
          const nextPlayer = currentRoom.players.find(p => p.id === nextId);
          io.to(roomId).emit('next_turn', {
            playerId: nextId,
            playerName: nextPlayer?.name,
            turnIndex: currentRoom.currentTurnIndex,
            totalTurns: currentRoom.turnOrder.length,
            turnTimer: currentRoom.turnTimer,
            market: currentRoom.market
          });
          startCallTimer(roomId, currentRoom, nextId);
        }

        if (currentRoom.letterCalledThisTurn) {
          if (currentRoom.playersPlacedThisTurn) currentRoom.playersPlacedThisTurn.delete(playerId);
          const connectedActive = connectedActivePlayers(currentRoom);
          if (currentRoom.playersPlacedThisTurn && currentRoom.playersPlacedThisTurn.size >= connectedActive.length) {
            resolveTurnPlacements(roomId, currentRoom, currentRoom.activeTurnId);
          }
        }
      }
    }, GRACE_PERIOD_MS);
  });
});

function finishFinalTurnAndScore(roomId, room) {
  activePlayers(room).forEach(player => {
    if (room.finalTurnSelections.has(player.id)) return;
    const board = Array.isArray(player.board) && player.board.length === 36
      ? player.board.slice()
      : Array(36).fill('');
    const randomIndex = getRandomEmptyIndex(board);
    const fallbackLetter = COMMON_CHARS[Math.floor(Math.random() * COMMON_CHARS.length)];
    if (randomIndex !== -1) board[randomIndex] = fallbackLetter;
    player.board = board;
    room.finalTurnSelections.set(player.id, fallbackLetter);
  });
  if (room.automaticScoring) {
    scoreAllAndEnd(roomId, room);
  } else {
    startManualScoring(roomId, room);
  }
}

function getClaimPositions(start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 35) return null;
  const startRow = Math.floor(start / 6);
  const endRow = Math.floor(end / 6);
  const startColumn = start % 6;
  const endColumn = end % 6;
  const positions = [];

  if (startRow === endRow && endColumn >= startColumn) {
    for (let column = startColumn; column <= endColumn; column++) positions.push(startRow * 6 + column);
  } else if (startColumn === endColumn && endRow >= startRow) {
    for (let row = startRow; row <= endRow; row++) positions.push(row * 6 + startColumn);
  } else {
    return null;
  }

  return positions.length >= 3 && positions.length <= 6 ? positions : null;
}

function startManualScoring(roomId, room) {
  room.phase = 'manual_scoring';
  room.manualClaims = new Map();
  if (room.manualScoringTimeout) clearTimeout(room.manualScoringTimeout);
  const duration = room.manualSearchDuration || 120;
  room.manualScoringDeadline = Date.now() + duration * 1000;
  room.manualScoringTimeout = setTimeout(() => finishManualScoring(roomId, room), duration * 1000);

  io.to(roomId).emit('manual_scoring_started', {
    duration,
    deadline: room.manualScoringDeadline,
    progress: getManualProgress(room)
  });
}

function getManualProgress(room) {
  return activePlayers(room)
    .map(player => {
      const words = room.manualClaims.get(player.id) || [];
      return {
        playerId: player.id,
        name: player.name,
        words: words.length,
        score: words.reduce((total, word) => total + word.score, 0),
        ready: room.manualReady.has(player.id)
      };
    })
    .sort((a, b) => b.score - a.score || b.words - a.words || a.name.localeCompare(b.name));
}

function finishManualScoring(roomId, room) {
  if (room.phase !== 'manual_scoring') return;
  room.manualScoringTimeout = null;
  room.manualScoringDeadline = null;

  activePlayers(room).forEach(player => {
    const claimed = new Map(
      (room.manualClaims.get(player.id) || []).map(word => [word.positions.join(','), word])
    );
    const allWords = scoreBoard(player.board || Array(36).fill('')).words;
    const words = allWords.map(word => {
      const manualWord = claimed.get(word.positions.join(','));
      return manualWord
        ? { ...word, score: word.score, manual: true }
        : { ...word, score: 1, manual: false };
    });
    player.words = words;
    player.score = words.reduce((total, word) => total + word.score, 0);
  });

  scoreAllAndEnd(roomId, room);
}

function validateWordClaim(player, start, end) {
  const positions = getClaimPositions(start, end);
  if (!positions) return { error: '请在同一行或同一列中选择 3 到 6 个汉字。' };
  const board = Array.isArray(player.board) ? player.board : [];
  if (positions.some(position => !board[position])) return { error: '选中的范围包含空格。' };

  const word = positions.map(position => board[position]).join('');
  const wordDefinitions = DICTIONARY.get(word);
  if (!wordDefinitions) return { error: `“${word}”不是词典中的有效词语。` };

  let score = 0;
  if (word.length === 3) score = 3;
  else if (word.length === 4) score = 8;
  else if (word.length === 5) score = 12;
  else if (word.length === 6) score = 20;

  return {
    word,
    score,
    positions,
    meanings: [{ partOfSpeech: '释义', definitions: wordDefinitions.slice(0, 2) }]
  };
}

function resolveTurnPlacements(roomId, room, turnId) {
  if (!room.letterCalledThisTurn || room.activeTurnId !== turnId) return;

  const missingPlayers = activePlayers(room).filter(player => !room.playersPlacedThisTurn.has(player.id));
  for (const player of missingPlayers) {
    const board = Array.isArray(player.board) && player.board.length === 36
      ? player.board.slice()
      : Array(36).fill('');
    const randomIndex = getRandomEmptyIndex(board);
    if (randomIndex !== -1) board[randomIndex] = room.currentLetter;
    player.board = board;
    room.playersPlacedThisTurn.add(player.id);
    if (player.connected && player.socketId) {
      io.to(player.socketId).emit('placement_applied', {
        turnId,
        letter: room.currentLetter,
        grid: board,
        automatic: true
      });
    }
  }

  const targetCount = room.calledLetters.length;
  for (const player of activePlayers(room)) {
    const currentPlaced = (player.board || []).filter(cell => !!cell).length;
    if (currentPlaced < targetCount) {
      const board = Array.isArray(player.board) && player.board.length === 36
        ? player.board.slice()
        : Array(36).fill('');
      const randomIndex = getRandomEmptyIndex(board);
      if (randomIndex !== -1) board[randomIndex] = room.currentLetter;
      player.board = board;
    }
  }

  emitPlacementStatus(roomId, room);
  advanceTurn(roomId, room, turnId);
}

function advanceTurn(roomId, room, turnId) {
  if (turnId && room.activeTurnId !== turnId) return;
  room.letterCalledThisTurn = false;
  room.activeTurnId = null;
  room.currentLetter = null;
  room.currentTurnIndex++;
  const isLastTurn = room.currentTurnIndex >= room.turnOrder.length;

  if (room.turnTimeout) clearTimeout(room.turnTimeout);

  if (room.finalTurnStarted) return;

  if (isLastTurn) {
    startFinalLetterTurn(roomId, room);
  } else {
    // Refresh market every 5th turn
    if (room.currentTurnIndex % 5 === 0) {
      room.market = generateMarket();
      io.to(roomId).emit('market_refreshed', { market: room.market, message: '市场已刷新，供接下来 5 个回合选择！' });
    }

    const nextId = room.turnOrder[room.currentTurnIndex];
    const nextPlayer = room.players.find(p => p.id === nextId);
    io.to(roomId).emit('next_turn', {
      playerId: nextId,
      playerName: nextPlayer?.name,
      turnIndex: room.currentTurnIndex,
      totalTurns: room.turnOrder.length,
      turnTimer: room.turnTimer,
      market: room.market
    });
    startCallTimer(roomId, room, nextId);
  }
}

function startFinalLetterTurn(roomId, room) {
  if (room.finalTurnStarted) return;

  room.phase = 'playing';
  room.finalTurnStarted = true;
  room.finalTurnSelections = new Map();
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  if (room.finalTurnTimeout) clearTimeout(room.finalTurnTimeout);

  io.to(roomId).emit('final_turn_started', {
    turnTimer: room.turnTimer,
    message: '最终回合（第36回合）：在最后一个空格中输入任意汉字。'
  });

  if (room.turnTimer > 0) {
    startFinalTurnTimeout(roomId, room);
  }

  console.log(`Final character phase started in room ${roomId}`);
}

function startFinalTurnTimeout(roomId, room) {
  if (room.finalTurnTimeout) return;

  room.finalTurnTimeout = setTimeout(() => {
    if (room.phase !== 'playing' || !room.finalTurnStarted) return;
    room.finalTurnTimeout = null;

    activePlayers(room).forEach(player => {
      if (room.finalTurnSelections.has(player.id)) return;
      const board = Array.isArray(player.board) && player.board.length === 36
        ? player.board.slice()
        : Array(36).fill('');
      const randomIndex = getRandomEmptyIndex(board);
      const fallbackLetter = COMMON_CHARS[Math.floor(Math.random() * COMMON_CHARS.length)];
      if (randomIndex !== -1) board[randomIndex] = fallbackLetter;
      player.board = board;
      room.finalTurnSelections.set(player.id, fallbackLetter);
      io.to(roomId).emit('final_letter_confirmed', {
        playerId: player.id,
        playerName: player.name,
        letter: fallbackLetter,
        grid: player.board || Array(36).fill(''),
        emptyIndex: randomIndex === -1 ? null : randomIndex,
        remaining: room.players.length - room.finalTurnSelections.size,
        allChosen: room.finalTurnSelections.size >= room.players.length
      });
    });

    finishFinalTurnAndScore(roomId, room);
  }, room.turnTimer * 1000);
}

function scoreAllAndEnd(roomId, room) {
  activePlayers(room).forEach(p => {
    if (room.phase === 'manual_scoring') {
      const words = p.words || [];
      p.score = words.reduce((total, word) => total + word.score, 0);
      p.words = words;
    } else {
      const { words, total } = scoreBoard(p.board || Array(36).fill(''));
      p.score = total;
      p.words = words.map(word => ({ ...word, manual: false }));
    }
  });

  const leaderboard = activePlayers(room)
    .map(p => ({ name: p.name, score: p.score, words: p.words, board: p.board }))
    .sort((a, b) => b.score - a.score);

  room.phase = 'scoring';
  room.finalTurnStarted = false;
  room.finalTurnSelections = new Map();
  if (room.finalTurnTimeout) clearTimeout(room.finalTurnTimeout);
  room.finalTurnTimeout = null;

  io.to(roomId).emit('game_over', { leaderboard });
  console.log(`Game over in room ${roomId}`);

  const hostPlayer = room.players.find(p => p.id === room.hostId);
  const hostName = hostPlayer ? hostPlayer.name : (leaderboard[0]?.name || 'Unknown');
  db.saveReplay({
    roomId,
    hostName,
    calledLetters: room.calledLetters || [],
    leaderboard
  });
}

function startCallTimer(roomId, room, nextId) {
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  if (room.turnTimer > 0) {
    room.turnTimeout = setTimeout(() => {
      if (room.phase !== 'playing') return;
      if (room.letterCalledThisTurn) return;
      const expectedId = room.turnOrder[room.currentTurnIndex];
      if (expectedId === nextId) {
        // Pick randomly from market
        const randomMarketItem = room.market ? room.market[Math.floor(Math.random() * room.market.length)] : null;
        const randomLetter = randomMarketItem ? randomMarketItem.char : COMMON_CHARS[0];
        const slotIdx = randomMarketItem ? randomMarketItem.index : 0;
        const p = room.players.find(pl => pl.id === nextId);
        const playerName = p ? p.name : 'Server';

        const turnId = `${room.currentTurnIndex}-${room.calledLetters.length + 1}`;
        room.activeTurnId = turnId;
        room.currentLetter = randomLetter;
        room.calledLetters.push({ letter: randomLetter, calledBy: playerName + ' (Auto)', turnId });
        room.letterCalledThisTurn = true;
        room.playersPlacedThisTurn = new Set();

        if (room.market) refillMarketSlot(room.market, slotIdx);

        io.to(roomId).emit('letter_called', {
          letter: randomLetter,
          calledBy: playerName + ' (Auto)',
          calledLetters: room.calledLetters,
          market: room.market,
          turnId,
          turnsLeft: room.turnOrder.length - room.calledLetters.length,
          turnTimer: room.turnTimer
        });
        emitPlacementStatus(roomId, room);

        startPlaceTimer(roomId, room, randomLetter, turnId);
      }
    }, room.turnTimer * 1000);
  }
}

function startPlaceTimer(roomId, room, letter, turnId) {
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  if (room.turnTimer > 0) {
    room.turnTimeout = setTimeout(() => {
      if (room.phase !== 'playing' || !room.letterCalledThisTurn || room.activeTurnId !== turnId) return;
      io.to(roomId).emit('force_place', { letter });
      resolveTurnPlacements(roomId, room, turnId);
    }, room.turnTimer * 1000);
  }
}

function sanitiseRoom(room) {
  return {
    id: room.id,
    hostId: room.hostId,
    phase: room.phase,
    players: room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected !== false, spectator: !!p.spectator })),
    calledLetters: room.calledLetters,
    currentTurnIndex: room.currentTurnIndex,
    turnOrder: room.turnOrder,
    market: room.market
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wordsworth server running on port ${PORT}`));

