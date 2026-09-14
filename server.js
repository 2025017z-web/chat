const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

// 大容量ファイル送信対応（最大約100MB）
const io = new Server(server, {
  maxHttpBufferSize: 1e8 
});

app.use(express.static(__dirname));

// --- データのファイル保存（簡易データベース） ---
const DATA_FILE = path.join(__dirname, 'chat_data.json');
let db = { users: {}, messages: [] };

if (fs.existsSync(DATA_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error("データ読込エラー:", e);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("データ保存エラー:", e);
  }
}

// オンライン中のソケット管理 (userId -> socketId)
const onlineSockets = {};

io.on('connection', (socket) => {

  // 1. ユーザー登録（固有のuserId）
  socket.on('register', ({ userId, name }) => {
    socket.userId = userId;
    onlineSockets[userId] = socket.id;

    if (!db.users[userId]) {
      db.users[userId] = { userId, name, friends: [], requestsSent: [] };
    } else {
      db.users[userId].name = name; // 名前更新対応
    }
    saveData();
    broadcastUserList();
  });

  // 2. 友達申請
  socket.on('send_friend_request', (targetUserId) => {
    const senderId = socket.userId;
    const sender = db.users[senderId];
    const target = db.users[targetUserId];

    if (!sender || !target) return;

    if (!sender.requestsSent.includes(targetUserId)) {
      sender.requestsSent.push(targetUserId);
    }

    // 相互申請なら友達成立
    if (target.requestsSent.includes(senderId)) {
      if (!sender.friends.includes(targetUserId)) sender.friends.push(targetUserId);
      if (!target.friends.includes(senderId)) target.friends.push(senderId);
    }

    saveData();
    broadcastUserList();
  });

  // 3. 過去のチャット履歴を取得
  socket.on('get_chat_history', ({ partnerId }) => {
    const myId = socket.userId;
    if (!myId || !partnerId) return;

    const history = db.messages.filter(m => 
      (m.fromUserId === myId && m.toUserId === partnerId) ||
      (m.fromUserId === partnerId && m.toUserId === myId)
    );

    socket.emit('chat_history', { partnerId, messages: history });
  });

  // 4. メッセージ送信
  socket.on('send_message', ({ toUserId, text, file }) => {
    const fromUserId = socket.userId;
    const sender = db.users[fromUserId];
    if (!sender || !toUserId) return;

    const msg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      fromUserId: fromUserId,
      fromName: sender.name,
      toUserId: toUserId,
      text: text,
      file: file,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      read: false
    };

    db.messages.push(msg);
    saveData();

    // 自分に送信
    socket.emit('receive_message', msg);

    // 相手がオンラインなら送信
    const targetSocketId = onlineSockets[toUserId];
    if (targetSocketId) {
      io.to(targetSocketId).emit('receive_message', msg);
    }
  });

  // 5. 既読をつける処理
  socket.on('mark_as_read', ({ partnerId }) => {
    const myId = socket.userId;
    if (!myId || !partnerId) return;

    let updated = false;
    db.messages.forEach(m => {
      if (m.fromUserId === partnerId && m.toUserId === myId && !m.read) {
        m.read = true;
        updated = true;
      }
    });

    if (updated) {
      saveData();
      // 送信元（相手）へ「既読がついた」ことを通知
      const partnerSocketId = onlineSockets[partnerId];
      if (partnerSocketId) {
        io.to(partnerSocketId).emit('messages_read_notification', { readerId: myId });
      }
      socket.emit('messages_read_notification', { readerId: partnerId });
    }
  });

  // 切断
  socket.on('disconnect', () => {
    if (socket.userId) {
      delete onlineSockets[socket.userId];
    }
    broadcastUserList();
  });

  function broadcastUserList() {
    const userList = Object.values(db.users).map(u => ({
      ...u,
      isOnline: !!onlineSockets[u.userId]
    }));
    io.emit('user_list_update', userList);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
