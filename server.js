require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const { createMarket, refillMarketTile, getPublicMarket } = require('./market');
const { scoreBoard, validSequences, getClaimPositions, validateWordClaim } = require('./scoring');
const { buildGameSummary } = require('./summary');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

const changelog = JSON.parse(fs.readFileSync(path.join(__dirname, 'changelog.json'), 'utf8'));
const rooms = {};
const BOARD_SIZE = 5;
const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;
const TOTAL_ROUNDS = BOARD_CELLS;
const TURN_TIMEOUT_MS = 30000;
const GRACE_PERIOD_MS = 120000;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/changelog', (req, res) => res.json(changelog));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? null : 'admin123');

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD must be set in production.');
  process.exit(1);
}

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (token === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized: Invalid Admin Password' });
}

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/api/admin/verify', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) return res.json({ success: true, token: ADMIN_PASSWORD });
  return res.status(401).json({ success: false, message: 'Incorrect password.' });
});

app.get('/api/admin/replays', requireAdminAuth, async (req, res) => {
  res.json({ replays: await db.getAllReplays(), stats: await db.getStats() });
});

app.get('/api/admin/replays/:id', requireAdminAuth, async (req, res) => {
  const replay = await db.getReplayById(req.params.id);
  if (!replay) return res.status(404).json({ error: 'Replay not found' });
  return res.json({ replay });
});

app.delete('/api/admin/replays/:id', requireAdminAuth, async (req, res) => {
  if (!await db.deleteReplay(req.params.id)) return res.status(400).json({ error: 'Could not delete replay' });
  return res.json({ success: true });
});

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let index = 0; index < 4; index++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function generatePlayerId() {
  return 'p_' + Math.random().toString(36).substring(2, 10);
}

function emptyBoard() {
  return Array(BOARD_CELLS).fill('');
}

function updatePlayerScore(player) {
  const result = scoreBoard(player.board || emptyBoard());
  player.score = result.total;
  player.matches = result.words;
}

function getRandomEmptyIndex(board) {
  const emptyIndices = [];
  board.forEach((cell, index) => {
    if (!cell) emptyIndices.push(index);
  });
  if (emptyIndices.length === 0) return -1;
  return emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
}

function shuffledPlayerIds(players) {
  const playerIds = players.map(player => player.id);
  for (let index = playerIds.length - 1; index > 0; index--) {
    const otherIndex = Math.floor(Math.random() * (index + 1));
    [playerIds[index], playerIds[otherIndex]] = [playerIds[otherIndex], playerIds[index]];
  }
  return playerIds;
}

function createTurnOrder(players) {
  const turnOrder = [];
  while (turnOrder.length < TOTAL_ROUNDS) {
    const nextCycle = shuffledPlayerIds(players);
    turnOrder.push(...nextCycle.slice(0, TOTAL_ROUNDS - turnOrder.length));
  }
  return turnOrder;
}

function activePlayers(room) {
  return room.players.filter(player => !player.spectator);
}

function clearPhaseTimer(room) {
  if (room.phaseTimer) clearTimeout(room.phaseTimer);
  room.phaseTimer = null;
  room.phaseDeadline = null;
}

function getGameState(room) {
  const selector = room.players.find(player => player.id === room.currentSelectorId);
  const summary = buildGameSummary(room);
  return {
    market: getPublicMarket(room.market),
    round: room.roundIndex + 1,
    totalRounds: TOTAL_ROUNDS,
    selectorId: room.currentSelectorId,
    selectorName: selector?.name || null,
    turnTimer: room.turnTimer,
    spectatorHost: room.spectatorHost === true,
    spectatorPlayerId: room.spectatorHostId || null,
    scores: room.players.map(player => ({
      playerId: player.id,
      playerName: player.name,
      score: player.score || 0,
      spectator: player.spectator === true
    })),
    stage: room.turnStage,
    selectedTile: room.pendingTile?.symbol || null,
    deadline: room.phaseDeadline,
    placementStatus: room.players.map(player => ({
      playerId: player.id,
      playerName: player.name,
      placed: player.spectator === true || player.placedThisRound === true,
      spectator: player.spectator === true,
      connected: player.connected !== false
    })),
    summary,
    phase: room.phase,
    manualDeadline: room.manualScoringDeadline,
    manualProgress: room.phase === 'manual_scoring' ? getManualProgress(room) : [],
    automaticScoring: room.automaticScoring === true
  };
}

function broadcastGameState(room) {
  if (room.phase === 'playing' || room.phase === 'manual_scoring' || room.phase === 'finished') {
    io.to(room.id).emit('game_state', getGameState(room));
  }
}

function startPhaseTimer(room) {
  clearPhaseTimer(room);
  if (room.turnTimer === 0) return;
  room.phaseDeadline = Date.now() + room.turnTimer * 1000;
  room.phaseTimer = setTimeout(() => {
    if (rooms[room.id] !== room || room.phase !== 'playing') return;

    if (room.turnStage === 'selecting') {
      const fallbackTile = room.market[Math.floor(Math.random() * room.market.length)];
      if (fallbackTile) selectMarketTile(room, fallbackTile.id);
      return;
    }

    if (room.turnStage === 'placing') {
      room.players
        .filter(player => !player.placedThisRound)
        .forEach(player => autoPlaceTile(room, player));
      finishRound(room);
    }
  }, room.turnTimer * 1000);
}

function autoPlaceTile(room, player) {
  if (player.spectator) {
    player.placedThisRound = true;
    return;
  }
  const board = Array.isArray(player.board) && player.board.length === BOARD_CELLS
    ? player.board
    : emptyBoard();
  const index = getRandomEmptyIndex(board);
  if (index !== -1 && room.pendingTile) board[index] = room.pendingTile.symbol;
  player.board = board;
  updatePlayerScore(player);
  player.placedThisRound = true;
  if (player.connected && player.socketId) {
    io.to(player.socketId).emit('board_updated', { grid: board.slice(), automatic: true });
  }
}

function getManualProgress(room) {
  return activePlayers(room)
    .map(player => {
      const claims = room.manualClaims?.get(player.id) || [];
      return {
        playerId: player.id,
        name: player.name,
        words: claims.length,
        score: claims.reduce((total, word) => total + word.score, 0),
        ready: room.manualReady?.has(player.id) === true
      };
    })
    .sort((a, b) => b.score - a.score || b.words - a.words || a.name.localeCompare(b.name));
}

function startManualScoring(room) {
  clearPhaseTimer(room);
  room.phase = 'manual_scoring';
  room.turnStage = 'manual_scoring';
  room.manualClaims = new Map();
  room.manualReady = new Set();
  if (room.manualScoringTimeout) clearTimeout(room.manualScoringTimeout);

  const duration = room.manualSearchDuration || 120;
  room.manualScoringDeadline = Date.now() + duration * 1000;
  room.manualScoringTimeout = setTimeout(() => {
    if (rooms[room.id] === room && room.phase === 'manual_scoring') {
      finishManualScoring(room);
    }
  }, duration * 1000);

  io.to(room.id).emit('manual_scoring_started', {
    duration,
    deadline: room.manualScoringDeadline,
    progress: getManualProgress(room)
  });
  broadcastGameState(room);
  emitRoomState(room);
}

function finishManualScoring(room) {
  if (room.phase !== 'manual_scoring') return;
  if (room.manualScoringTimeout) clearTimeout(room.manualScoringTimeout);
  room.manualScoringTimeout = null;
  room.manualScoringDeadline = null;

  activePlayers(room).forEach(player => {
    const claims = room.manualClaims?.get(player.id) || [];
    const claimedMap = new Map(
      claims.map(item => [`${item.character}:${item.positions.join(',')}`, item])
    );
    const { words: allPossibleWords } = scoreBoard(player.board || emptyBoard());

    const finalWords = allPossibleWords.map(word => {
      const key = `${word.character}:${word.positions.join(',')}`;
      const claimed = claimedMap.get(key);
      return claimed
        ? { ...word, manual: true }
        : { ...word, score: 0, manual: false };
    });

    player.matches = finalWords;
    player.score = finalWords.reduce((sum, word) => sum + word.score, 0);
  });

  room.phase = 'finished';
  room.turnStage = 'finished';
  const summary = buildGameSummary(room);
  room.summary = summary;
  io.to(room.id).emit('game_finished', { summary });
  broadcastGameState(room);
  emitRoomState(room);

  const hostPlayer = room.players.find(p => p.id === room.hostId);
  const hostName = hostPlayer ? hostPlayer.name : (summary?.leaderboard?.[0]?.playerName || 'Unknown');
  db.saveReplay({
    roomId: room.id,
    hostName,
    calledLetters: [],
    leaderboard: summary.leaderboard.map(p => ({
      name: p.playerName,
      score: p.score,
      words: p.words,
      board: p.board
    }))
  });
}

function finishRound(room) {
  clearPhaseTimer(room);
  room.pendingTile = null;
  if (room.roundIndex + 1 >= TOTAL_ROUNDS) {
    if (room.automaticScoring) {
      room.phase = 'finished';
      room.turnStage = 'finished';
      activePlayers(room).forEach(player => {
        updatePlayerScore(player);
      });
      const summary = buildGameSummary(room);
      room.summary = summary;
      io.to(room.id).emit('game_finished', { summary });
      broadcastGameState(room);
      emitRoomState(room);

      const hostPlayer = room.players.find(p => p.id === room.hostId);
      const hostName = hostPlayer ? hostPlayer.name : (summary?.leaderboard?.[0]?.playerName || 'Unknown');
      db.saveReplay({
        roomId: room.id,
        hostName,
        calledLetters: [],
        leaderboard: summary.leaderboard.map(p => ({
          name: p.playerName,
          score: p.score,
          words: p.words,
          board: p.board
        }))
      });
    } else {
      startManualScoring(room);
    }
    return;
  }

  room.roundIndex++;
  room.currentSelectorId = room.turnOrder[room.roundIndex];
  room.turnStage = 'selecting';
  room.players.forEach(player => { player.placedThisRound = player.spectator === true; });
  startPhaseTimer(room);
  broadcastGameState(room);
}

function selectMarketTile(room, tileId) {
  const selectedTile = room.market.find(tile => tile.id === tileId);
  if (!selectedTile) return false;

  room.pendingTile = { symbol: selectedTile.symbol };
  room.market = refillMarketTile(room.market, tileId);
  room.turnStage = 'placing';
  room.players.forEach(player => {
    player.placedThisRound = player.spectator === true;
    if (!player.connected && !player.spectator) autoPlaceTile(room, player);
  });
  startPhaseTimer(room);
  broadcastGameState(room);
  return true;
}

function sanitiseRoom(room) {
  return {
    id: room.id,
    hostId: room.hostId,
    phase: room.phase,
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      connected: player.connected !== false,
      spectator: player.spectator === true
    }))
  };
}

function emitRoomState(room) {
  io.to(room.id).emit('room_state', sanitiseRoom(room));
}

function attachPlayer(socket, room, player) {
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  player.disconnectTimer = null;
  player.connected = true;
  player.socketId = socket.id;
  socket.join(room.id);
  socket.data.roomId = room.id;
  socket.data.playerId = player.id;
  socket.data.playerName = player.name;
}

function rejoinPlayer(socket, room, player) {
  const previousSocketId = player.socketId;
  attachPlayer(socket, room, player);

  if (previousSocketId && previousSocketId !== socket.id) {
    io.sockets.sockets.get(previousSocketId)?.disconnect(true);
  }

  socket.emit('rejoined_success', {
    roomId: room.id,
    playerId: player.id,
    playerName: player.name,
    hostId: room.hostId,
    isHost: room.hostId === player.id,
    phase: room.phase,
    players: sanitiseRoom(room).players,
    grid: player.board || emptyBoard(),
    spectator: player.spectator === true,
    gameState: room.phase === 'playing' || room.phase === 'manual_scoring' || room.phase === 'finished' ? getGameState(room) : null,
    manualClaims: room.phase === 'manual_scoring' ? (room.manualClaims?.get(player.id) || []) : [],
    manualReady: room.phase === 'manual_scoring' && room.manualReady?.has(player.id) === true
  });
  emitRoomState(room);
  console.log(`${player.name} (${player.id}) reconnected to room ${room.id}`);
}

function removePlayer(room, playerId) {
  const index = room.players.findIndex(player => player.id === playerId);
  if (index === -1) return null;
  const [player] = room.players.splice(index, 1);
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);

  if (room.players.length === 0) {
    clearPhaseTimer(room);
    delete rooms[room.id];
    return player;
  }

  if (room.hostId === playerId) {
    const nextHost = room.players.find(current => current.connected) || room.players[0];
    room.hostId = nextHost.id;
    io.to(room.id).emit('host_changed', { newHostId: nextHost.id, newHostName: nextHost.name });
  }
  if (room.spectatorHostId === playerId) {
    room.spectatorHost = false;
    room.spectatorHostId = null;
  }

  io.to(room.id).emit('player_left', {
    playerName: player.name,
    players: sanitiseRoom(room).players
  });

  if (room.phase === 'manual_scoring') {
    if (room.manualClaims) room.manualClaims.delete(playerId);
    if (room.manualReady) room.manualReady.delete(playerId);
    const active = activePlayers(room);
    if (active.length === 0) {
      if (room.manualScoringTimeout) clearTimeout(room.manualScoringTimeout);
      delete rooms[room.id];
      return player;
    }
    if (active.every(p => !p.connected || room.manualReady.has(p.id))) {
      finishManualScoring(room);
    } else {
      io.to(room.id).emit('manual_scoring_progress', { progress: getManualProgress(room) });
      broadcastGameState(room);
    }
  }

  if (room.phase === 'playing') {
    if (room.turnStage === 'selecting' && room.currentSelectorId === playerId) {
      const nextSelector = activePlayers(room).find(current => current.connected) || activePlayers(room)[0];
      if (!nextSelector) {
        room.phase = 'finished';
        room.turnStage = 'finished';
        clearPhaseTimer(room);
        io.to(room.id).emit('game_finished');
        broadcastGameState(room);
        return player;
      }
      room.currentSelectorId = nextSelector.id;
      room.turnOrder[room.roundIndex] = room.currentSelectorId;
      startPhaseTimer(room);
    }
    if (room.turnStage === 'placing' && room.players.every(current => current.placedThisRound)) {
      finishRound(room);
    } else {
      broadcastGameState(room);
    }
  }
  return player;
}

io.on('connection', socket => {
  console.log('connected:', socket.id);

  socket.on('create_room', ({ playerName } = {}) => {
    const name = String(playerName || '').trim().slice(0, 20);
    if (!name) return socket.emit('error', { message: '请输入你的名字。' });

    let roomId;
    do { roomId = generateRoomId(); } while (rooms[roomId]);
    const playerId = generatePlayerId();
    const room = {
      id: roomId,
      hostId: playerId,
      phase: 'lobby',
      players: [{
        id: playerId,
        socketId: socket.id,
        name,
        connected: true,
        disconnectTimer: null,
        board: null
      }]
    };
    rooms[roomId] = room;
    attachPlayer(socket, room, room.players[0]);
    socket.emit('room_created', { roomId, playerId, playerName: name });
    emitRoomState(room);
    console.log(`Room ${roomId} created by ${name} (${playerId})`);
  });

  socket.on('join_room', ({ roomId, playerName } = {}) => {
    const id = String(roomId || '').trim().toUpperCase();
    const name = String(playerName || '').trim().slice(0, 20);
    const room = rooms[id];
    if (!name) return socket.emit('error', { message: '请输入你的名字。' });
    if (!room) return socket.emit('error', { message: '未找到该房间。' });

    const existingPlayer = room.players.find(player => player.name.toLowerCase() === name.toLowerCase());
    if (room.phase !== 'lobby') {
      if (existingPlayer && !existingPlayer.connected) return rejoinPlayer(socket, room, existingPlayer);
      return socket.emit('error', { message: '游戏进行中，新玩家无法加入。' });
    }
    if (room.players.length >= 50) return socket.emit('error', { message: '房间已满。' });
    if (existingPlayer) {
      if (!existingPlayer.connected) return rejoinPlayer(socket, room, existingPlayer);
      return socket.emit('error', { message: '该名字在房间中已被占用。' });
    }

    const player = {
      id: generatePlayerId(),
      socketId: socket.id,
      name,
      connected: true,
      disconnectTimer: null,
      board: null
    };
    room.players.push(player);
    attachPlayer(socket, room, player);
    socket.emit('room_joined', { roomId: id, playerId: player.id, playerName: name });
    emitRoomState(room);
    console.log(`${name} (${player.id}) joined room ${id}`);
  });

  socket.on('rejoin_room', ({ roomId, playerId, playerName } = {}) => {
    const room = rooms[String(roomId || '').toUpperCase()];
    if (!room) return socket.emit('rejoin_failed', { message: '房间已不存在。' });
    const name = String(playerName || '').trim().toLowerCase();
    const player = room.players.find(current => current.id === playerId || (current.name.toLowerCase() === name && !current.connected));
    if (!player) return socket.emit('rejoin_failed', { message: '会话已过期或玩家不在房间内。' });
    rejoinPlayer(socket, room, player);
  });

  socket.on('start_game', (options = {}) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    if (room.hostId !== socket.data.playerId) return socket.emit('error', { message: '只有房主可以开始游戏。' });
    if (room.phase !== 'lobby') return;

    const spectatorHost = options.spectatorHost === true;
    const automaticScoring = options.automaticScoring === true;
    const requestedManualDuration = Number.parseInt(options.manualSearchDuration, 10);
    const manualSearchDuration = Number.isFinite(requestedManualDuration)
      ? Math.min(Math.max(requestedManualDuration, 30), 600)
      : 120;
    const playingPlayers = room.players.filter(player => !(spectatorHost && player.id === room.hostId));
    if (playingPlayers.length < 2) return socket.emit('error', { message: '需要至少 2 名玩家参与游戏。' });
    const requestedTimer = Number.parseInt(options.turnTimer, 10);
    const turnTimer = options.unlimitedTime === true
      ? 0
      : Number.isFinite(requestedTimer) ? Math.min(Math.max(requestedTimer, 1), 300) : 30;

    room.phase = 'playing';
    room.players.forEach(player => {
      player.board = emptyBoard();
      player.score = 0;
      player.matches = [];
      player.spectator = spectatorHost && player.id === room.hostId;
      player.placedThisRound = player.spectator;
    });
    room.turnTimer = turnTimer;
    room.spectatorHost = spectatorHost;
    room.spectatorHostId = spectatorHost ? room.hostId : null;
    room.automaticScoring = automaticScoring;
    room.manualSearchDuration = manualSearchDuration;
    room.manualClaims = new Map();
    room.manualReady = new Set();
    room.manualScoringDeadline = null;
    if (room.manualScoringTimeout) clearTimeout(room.manualScoringTimeout);
    room.manualScoringTimeout = null;
    room.market = createMarket();
    room.turnOrder = createTurnOrder(playingPlayers);
    room.roundIndex = 0;
    room.currentSelectorId = room.turnOrder[0];
    room.turnStage = 'selecting';
    room.pendingTile = null;
    startPhaseTimer(room);
    io.to(room.id).emit('game_started', getGameState(room));
    emitRoomState(room);
  });

  socket.on('select_market_tile', ({ tileId } = {}) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.phase !== 'playing' || room.turnStage !== 'selecting') return;
    if (socket.data.playerId !== room.currentSelectorId) {
      return socket.emit('error', { message: '还没到你的选牌回合。' });
    }
    if (!selectMarketTile(room, tileId)) {
      return socket.emit('error', { message: '该牌已不在市场中。' });
    }
  });

  socket.on('place_tile', ({ index } = {}) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.phase !== 'playing' || room.turnStage !== 'placing' || !room.pendingTile) return;
    const player = room.players.find(current => current.id === socket.data.playerId);
    if (!player || !player.connected || player.spectator) return;
    if (player.placedThisRound) return socket.emit('error', { message: '你已经放置了本回合的字。' });
    if (!Number.isInteger(index) || index < 0 || index >= BOARD_CELLS || player.board[index]) {
      return socket.emit('error', { message: '请选择一个空格。' });
    }

    player.board[index] = room.pendingTile.symbol;
    updatePlayerScore(player);
    player.placedThisRound = true;
    socket.emit('board_updated', { grid: player.board.slice(), automatic: false });

    if (room.players.every(current => current.placedThisRound)) {
      finishRound(room);
    } else {
      broadcastGameState(room);
    }
  });

  socket.on('claim_word', ({ start, end } = {}) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.phase !== 'manual_scoring') return;
    const player = room.players.find(current => current.id === socket.data.playerId);
    if (!player || !player.connected || player.spectator) return;

    const result = validateWordClaim(player.board, start, end);
    if (!result.valid) {
      return socket.emit('word_claim_result', { valid: false, message: result.error });
    }

    const currentClaims = room.manualClaims.get(player.id) || [];
    const existingKeys = new Set(currentClaims.map(c => `${c.character}:${c.positions.join(',')}`));

    const newlyClaimed = [];
    for (const character of result.characters) {
      const key = `${character}:${result.positions.join(',')}`;
      if (!existingKeys.has(key)) {
        newlyClaimed.push({
          character,
          word: character,
          score: result.tileCount,
          positions: result.positions,
          tileCount: result.tileCount,
          orientation: result.orientation,
          sequence: result.sequence
        });
      }
    }

    if (newlyClaimed.length === 0) {
      return socket.emit('word_claim_result', {
        valid: false,
        message: `你已经认领过该位置组成的「${result.characters.join(' / ')}」了。`
      });
    }

    currentClaims.push(...newlyClaimed);
    room.manualClaims.set(player.id, currentClaims);

    const totalScore = currentClaims.reduce((sum, item) => sum + item.score, 0);
    const claimedNames = newlyClaimed.map(c => `「${c.character}」(+${c.score}分)`).join('、');

    socket.emit('word_claim_result', {
      valid: true,
      words: newlyClaimed,
      claims: currentClaims,
      total: totalScore,
      message: `成功认领 ${claimedNames}！`
    });

    io.to(room.id).emit('manual_scoring_progress', { progress: getManualProgress(room) });
  });

  socket.on('manual_ready', ({ ready = true } = {}) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.phase !== 'manual_scoring') return;
    const player = room.players.find(current => current.id === socket.data.playerId);
    if (!player || !player.connected || player.spectator) return;

    if (ready) {
      room.manualReady.add(player.id);
    } else {
      room.manualReady.delete(player.id);
    }

    io.to(room.id).emit('manual_scoring_progress', { progress: getManualProgress(room) });

    const active = activePlayers(room);
    if (ready && active.every(p => !p.connected || room.manualReady.has(p.id))) {
      finishManualScoring(room);
    }
  });

  socket.on('leave_room', () => {
    const room = rooms[socket.data.roomId];
    const playerId = socket.data.playerId;
    if (!room || !playerId) return;
    socket.leave(room.id);
    socket.data.roomId = null;
    socket.data.playerId = null;
    socket.data.playerName = null;
    removePlayer(room, playerId);
  });

  socket.on('kick_player', ({ targetPlayerId } = {}) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    if (room.hostId !== socket.data.playerId) return socket.emit('error', { message: '只有房主可以踢出玩家。' });
    if (targetPlayerId === room.hostId) return socket.emit('error', { message: '房主不能踢出自己。' });

    const target = room.players.find(player => player.id === targetPlayerId);
    if (!target) return;
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      targetSocket.leave(room.id);
      targetSocket.data.roomId = null;
      targetSocket.data.playerId = null;
      targetSocket.data.playerName = null;
      targetSocket.emit('kicked_from_room', { message: '你已被房主移出房间。' });
    }
    removePlayer(room, targetPlayerId);
    io.to(room.id).emit('player_kicked', { kickedPlayerId: targetPlayerId, kickedPlayerName: target.name });
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.data.roomId];
    const player = room?.players.find(current => current.id === socket.data.playerId);
    if (!player || player.socketId !== socket.id) return;

    player.connected = false;
    emitRoomState(room);
    broadcastGameState(room);
    player.disconnectTimer = setTimeout(() => {
      if (!rooms[room.id] || player.connected) return;
      removePlayer(room, player.id);
    }, GRACE_PERIOD_MS);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wordsworth server running on port ${PORT}`));
