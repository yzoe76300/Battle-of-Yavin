const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 8000;

// middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// data files
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// init
function initDataFiles() {
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, JSON.stringify({}));
}

function getUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function getSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// in-memory matchmaking queue
const matchmakingQueue = [];

// In-memory room role registry
// rooms: Map<roomId, { player1: {socketId,userId,username} | null, player2: {...} | null }>
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { player1: null, player2: null });
  }
  return rooms.get(roomId);
}

function roleOccupied(room, role) {
  return !!room[role];
}

function assignRole(room, preferredRole, socket, userId, username) {
  // If preferredRole free, take it; otherwise take the other if free.
  if (preferredRole && !roleOccupied(room, preferredRole)) {
    room[preferredRole] = { socketId: socket.id, userId, username };
    return preferredRole;
  }
  const other = preferredRole === 'player1' ? 'player2' : 'player1';
  if (!roleOccupied(room, other)) {
    room[other] = { socketId: socket.id, userId, username };
    return other;
  }
  // If both taken but one is the same user reconnecting, replace their slot.
  for (const r of ['player1', 'player2']) {
    if (room[r]?.userId === userId) {
      room[r] = { socketId: socket.id, userId, username };
      return r;
    }
  }
  return null; // room full
}

function releaseRole(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const r of ['player1', 'player2']) {
    if (room[r]?.socketId === socketId) {
      room[r] = null;
    }
  }
  // Cleanup empty room
  if (!room.player1 && !room.player2) {
    rooms.delete(roomId);
  }
}

function emitRoster(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const roster = ['player1', 'player2'].map(r => {
    const p = room[r];
    return p ? { role: r, userId: p.userId, username: p.username } : { role: r, userId: null, username: null };
  });
  io.to(roomId).emit('roomRoster', roster);
}

// REST: register
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password is required' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username length should be at least 3 and at most 20 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }

  const users = getUsers();
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: Date.now().toString(),
    username,
    password: hashedPassword,
    createdAt: new Date().toISOString()
  };
  users.push(newUser);
  saveUsers(users);

  res.json({
    success: true,
    message: 'Registered successfully',
    user: { id: newUser.id, username: newUser.username }
  });
});

// REST: login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password is required' });

  const users = getUsers();
  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Username doesn\'t exist' });

  const isValidPassword = await bcrypt.compare(password, user.password);
  if (!isValidPassword) return res.status(401).json({ error: 'User password wrong' });

  const sessions = getSessions();
  const sessionToken = crypto.randomBytes(32).toString('hex');
  sessions[sessionToken] = {
    userId: user.id,
    username: user.username,
    createdAt: new Date().toISOString()
  };
  saveSessions(sessions);

  res.json({
    success: true,
    message: '登录成功',
    token: sessionToken,
    user: { id: user.id, username: user.username }
  });
});

// REST: verify
app.post('/api/verify', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const sessions = getSessions();
  const session = sessions[token];
  if (!session) return res.status(401).json({ error: 'Invalid token' });

  res.json({ success: true, user: { id: session.userId, username: session.username } });
});

// REST: logout
app.post('/api/logout', (req, res) => {
  const { token } = req.body;
  if (token) {
    const sessions = getSessions();
    delete sessions[token];
    saveSessions(sessions);
  }
  res.json({ success: true, message: 'Logout successful' });
});

// socket.io
io.on('connection', (socket) => {
  console.log('User connect...:', socket.id);

  // matchmaking join
  socket.on('joinMatchmaking', (data) => {
    const { username, userId } = data;

    const existingIndex = matchmakingQueue.findIndex(p => p.userId === userId);
    if (existingIndex !== -1) {
      socket.emit('matchmakingStatus', {
        status: 'already_in_queue',
        message: 'You are already_in_queue!'
      });
      return;
    }

    const player = { socketId: socket.id, userId, username, joinedAt: Date.now() };
    matchmakingQueue.push(player);

    if (matchmakingQueue.length >= 2) {
      const player1 = matchmakingQueue.shift();
      const player2 = matchmakingQueue.shift();

      const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      io.sockets.sockets.get(player1.socketId)?.join(roomId);
      io.sockets.sockets.get(player2.socketId)?.join(roomId);

      // Initialize room slots
      rooms.set(roomId, {
        player1: { socketId: player1.socketId, userId: player1.userId, username: player1.username },
        player2: { socketId: player2.socketId, userId: player2.userId, username: player2.username }
      });

      io.to(player1.socketId).emit('matchFound', {
        roomId,
        opponent: { username: player2.username, userId: player2.userId },
        playerRole: 'player1'
      });
      io.to(player2.socketId).emit('matchFound', {
        roomId,
        opponent: { username: player1.username, userId: player1.userId },
        playerRole: 'player2'
      });

      console.log(`match success: ${player1.username} vs ${player2.username} (Room: ${roomId})`);

      emitRoster(roomId);
    } else {
      socket.emit('matchmakingStatus', {
        status: 'waiting',
        message: 'Looking for rival ...',
        queueLength: matchmakingQueue.length
      });
    }
  });

  // matchmaking cancel
  socket.on('cancelMatchmaking', (data) => {
    const { userId } = data;
    const index = matchmakingQueue.findIndex(p => p.userId === userId);
    if (index !== -1) {
      matchmakingQueue.splice(index, 1);
      socket.emit('matchmakingStatus', {
        status: 'cancelled',
        message: 'Canceled Successfully',
      });
    }
  });

  // ===== Game room events =====
  socket.on('joinGameRoom', ({ roomId, username, userId, role: preferredRole }) => {
    if (!roomId) return;

    socket.join(roomId);
    const room = getOrCreateRoom(roomId);

    // Assign a role
    const assigned = assignRole(room, preferredRole === 'player2' ? 'player2' : 'player1', socket, userId, username);
    if (!assigned) {
      socket.emit('roomFull', { roomId, message: 'Room is full' });
      return;
    }

    // Persist metadata on the socket
    socket.data.game = { roomId, username, userId, role: assigned };

    // Let the client know their authoritative role
    socket.emit('roleAssigned', { roomId, role: assigned });

    // Notify roster
    emitRoster(roomId);
    socket.emit('roomJoined', { roomId, role: assigned });
  });

  // Player turret angle update
  socket.on('turretUpdate', ({ roomId, angle, ts }) => {
    if (!roomId || typeof angle !== 'number') return;
    socket.to(roomId).emit('opponentTurret', { angle, ts });
  });

  // Relay bullet fire to opponent
  socket.on('fire', ({ roomId, x, y, vx, vy, ts }) => {
    if (!roomId) return;
    // Optionally, trust socket.data.game.roomId:
    // const roomId = socket.data?.game?.roomId; if (!roomId) return;
    socket.to(roomId).emit('opponentFire', { x, y, vx, vy, ts });
  });

  // Relay fighter spawns
  socket.on('spawnFighters', ({ roomId, fighters }) => {
    if (!roomId || !Array.isArray(fighters)) return;
    socket.to(roomId).emit('fighterSpawn', { fighters });
  });

  // Relay fighter down
  socket.on('fighterDown', ({ roomId, id }) => {
    if (!roomId || !id) return;
    socket.to(roomId).emit('fighterDown', { id });
  });

  // Relay shield breach life loss
  socket.on('breach', ({ roomId, side }) => {
    if (!roomId || !side) return;
    socket.to(roomId).emit('breach', { side });
  });

  // Broadcast game over to both clients in the room
  socket.on('gameOver', ({ roomId, winner, lives }) => {
    if (!roomId) return;
    io.to(roomId).emit('gameOver', { winner, lives }); // lives = { left, right }
  });

  // Cheat toggle
  socket.on('cheatToggle', ({ roomId, enabled }) => {
    if (!roomId) return;
    socket.to(roomId).emit('opponentCheat', { enabled });
  });

  // disconnect
  socket.on('disconnect', () => {
    console.log('用户断开连接:', socket.id);

    // remove from matchmaking queue
    const idx = matchmakingQueue.findIndex(p => p.socketId === socket.id);
    if (idx !== -1) matchmakingQueue.splice(idx, 1);

    // release room role and update roster
    const { game } = socket.data || {};
    if (game?.roomId) {
      releaseRole(game.roomId, socket.id);
      // Delay to ensure socket leaves room first
      setTimeout(() => emitRoster(game.roomId), 0);
    }
  });
});

// start server
initDataFiles();
server.listen(PORT, () => {
  console.log(`Server operating on http://localhost:${PORT}`);
});