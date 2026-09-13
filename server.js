const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Socket.ioの設定（ファイル送信用に上限を100MBに設定）
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // 100MB
});

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// オンラインユーザー管理
const users = {};       // socketId -> { userId, name }
const userSockets = {}; // userId -> socketId

io.on('connection', (socket) => {
  // ユーザーの初期登録
  socket.on('register', (data) => {
    const { userId, name } = data;
    users[socket.id] = { userId, name };
    userSockets[userId] = socket.id;
  });

  // フレンド検索・確認
  socket.on('add-friend', (targetUserId, callback) => {
    const targetSocketId = userSockets[targetUserId];
    if (targetSocketId && users[targetSocketId]) {
      callback({ success: true, name: users[targetSocketId].name });
    } else {
      callback({ success: false, message: '相手が見つかりません。コードを確認するか、相手がオンラインであることを確認してください。' });
    }
  });

  // メッセージ・ファイル送信
  socket.on('send-message', (data) => {
    const { toUserId, message, file, fileName, fileType } = data;
    const sender = users[socket.id];
    if (!sender) return;

    const targetSocketId = userSockets[toUserId];
    const payload = {
      fromUserId: sender.userId,
      fromName: sender.name,
      message: message || '',
      file: file || null,
      fileName: fileName || null,
      fileType: fileType || null,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    // 相手に送信
    if (targetSocketId) {
      io.to(targetSocketId).emit('receive-message', payload);
    }
    // 自分側にも送信結果を返す
    socket.emit('receive-message', { ...payload, isSelf: true });
  });

  // 切断処理
  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      delete userSockets[user.userId];
      delete users[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
