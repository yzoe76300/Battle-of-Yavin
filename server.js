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

const PORT = process.env.PORT || 3000;

// 中间件
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// 数据存储文件路径
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// 初始化数据文件
function initDataFiles() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([]));
  }
  if (!fs.existsSync(SESSIONS_FILE)) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify({}));
  }
}

// 读取用户数据
function getUsers() {
  try {
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

// 保存用户数据
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// 读取会话数据
function getSessions() {
  try {
    const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

// 保存会话数据
function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// 匹配队列, 使用内存，list 匹配
const matchmakingQueue = [];

// API 路由

// 用户注册
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
  
  // 检查用户名是否已存在
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  // 加密密码
  const hashedPassword = await bcrypt.hash(password, 10);

  // 创建新用户
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
    user: {
      id: newUser.id,
      username: newUser.username
    }
  });
});

// 用户登录
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password is required' });
  }

  const users = getUsers();
  const user = users.find(u => u.username === username);

  if (!user) {
    return res.status(401).json({ error: 'Username doesn\'t exist' });
  }

  // 验证密码
  const isValidPassword = await bcrypt.compare(password, user.password);
  if (!isValidPassword) {
    return res.status(401).json({ error: 'User password wrong' });
  }

  // 创建 Session 并储存
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
    user: {
      id: user.id,
      username: user.username
    }
  });
});

// 验证会话
app.post('/api/verify', (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const sessions = getSessions();
  const session = sessions[token];

  if (!session) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  res.json({
    success: true,
    user: {
      id: session.userId,
      username: session.username
    }
  });
});

// 用户登出
app.post('/api/logout', (req, res) => {
  const { token } = req.body;

  if (token) {
    const sessions = getSessions();
    delete sessions[token];
    saveSessions(sessions);
  }

  res.json({ success: true, message: 'Logout successful' });
});

// Socket.io 匹配处理
io.on('connection', (socket) => {
  console.log('User connect...:', socket.id);

  // 加入匹配队列
  socket.on('joinMatchmaking', (data) => {
    const { username, userId } = data;
    
    // 检查是否已在队列中
    const existingIndex = matchmakingQueue.findIndex(p => p.userId === userId);
    if (existingIndex !== -1) {
      socket.emit('matchmakingStatus', { 
        status: 'already_in_queue',
        message: 'You are already_in_queue!'
      });
      return;
    }

    // 添加到队列
    const player = {
      socketId: socket.id,
      userId,
      username,
      joinedAt: Date.now()
    };
    matchmakingQueue.push(player);

    // 尝试匹配
    if (matchmakingQueue.length >= 2) {
      const player1 = matchmakingQueue.shift();
      const player2 = matchmakingQueue.shift();

      // 创建房间ID
      const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // 将两个玩家加入房间
      io.sockets.sockets.get(player1.socketId)?.join(roomId);
      io.sockets.sockets.get(player2.socketId)?.join(roomId);

      // 通知两个玩家匹配成功
      io.to(player1.socketId).emit('matchFound', {
        roomId,
        opponent: {
          username: player2.username,
          userId: player2.userId
        },
        playerRole: 'player1'
      });

      io.to(player2.socketId).emit('matchFound', {
        roomId,
        opponent: {
          username: player1.username,
          userId: player1.userId
        },
        playerRole: 'player2'
      });

      console.log(`match success: ${player1.username} vs ${player2.username} (Room: ${roomId})`);
    } else {
      socket.emit('matchmakingStatus', {
        status: 'waiting',
        message: 'Looking for rival ...',
        queueLength: matchmakingQueue.length
      });
    }
  });

  // 取消匹配
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

  // 断开连接处理
  socket.on('disconnect', () => {
    console.log('用户断开连接:', socket.id);
    
    // 从匹配队列中移除
    const index = matchmakingQueue.findIndex(p => p.socketId === socket.id);
    if (index !== -1) {
      matchmakingQueue.splice(index, 1);
    }
  });
});

// 启动服务器
initDataFiles();
server.listen(PORT, () => {
  console.log(`Server operating on http://localhost:${PORT}`);
});

