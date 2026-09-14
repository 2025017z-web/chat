const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e8 
});

app.use(express.static(__dirname));

const ADMIN_CODE = "admin123";

// --- データ保存処理 ---
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

const onlineSockets = {}; // userId -> socketId

io.on('connection', (socket) => {

  // 1. ユーザー初期化
  socket.on('register', ({ userId, name }) => {
    socket.userId = userId;
    onlineSockets[userId] = socket.id;

    if (!db.users[userId]) {
      db.users[userId] = { userId, name, friends: [], requestsSent: [], bannedUntil: 0 };
    }
    saveData();
    broadcastUserList();
  });

  // 2. 自分の名前変更
  socket.on('change_name', ({ newName }) => {
    const userId = socket.userId;
    if (db.users[userId] && newName.trim()) {
      db.users[userId].name = newName.trim();
      saveData();
      broadcastUserList();
    }
  });

  // 3. 友達申請
  socket.on('send_friend_request', (targetUserId) => {
    if (isBanned(socket.userId)) return;
    const senderId = socket.userId;
    const sender = db.users[senderId];
    const target = db.users[targetUserId];

    if (!sender || !target) return;

    if (!sender.requestsSent.includes(targetUserId)) {
      sender.requestsSent.push(targetUserId);
    }

    if (target.requestsSent.includes(senderId)) {
      if (!sender.friends.includes(targetUserId)) sender.friends.push(targetUserId);
      if (!target.friends.includes(senderId)) target.friends.push(senderId);
    }

    saveData();
    broadcastUserList();
  });

  // 4. チャット履歴の取得
  socket.on('get_chat_history', ({ partnerId, customFromId, customToId }) => {
    const myId = socket.userId;
    let u1 = myId;
    let u2 = partnerId;

    if (socket.isAdmin && customFromId && customToId) {
      u1 = customFromId;
      u2 = customToId;
    }

    const history = db.messages.filter(m => 
      (m.fromUserId === u1 && m.toUserId === u2) ||
      (m.fromUserId === u2 && m.toUserId === u1)
    );

    socket.emit('chat_history', { partnerId: u2, messages: history });
  });

  // 5. メッセージ送信（バグ修正済み）
  socket.on('send_message', ({ toUserId, text, file, impersonateUserId }) => {
    if (isBanned(socket.userId)) {
      return socket.emit('error_message', '現在使用禁止（BAN）に設定されています。');
    }

    let actualSenderId = socket.userId;

    if (socket.isAdmin && impersonateUserId) {
      actualSenderId = impersonateUserId;
    }

    const sender = db.users[actualSenderId];
    if (!sender || !toUserId) return;

    const msg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      fromUserId: actualSenderId,
      fromName: sender.name,
      toUserId: toUserId,
      text: text,
      file: file,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      read: false
    };

    db.messages.push(msg);
    saveData();

    // ★送信者（自分）へ直接返信（表示バグの修正）
    socket.emit('receive_message', msg);

    // ★受信者（相手）へ配信
    const targetSocketId = onlineSockets[toUserId];
    if (targetSocketId && targetSocketId !== socket.id) {
      io.to(targetSocketId).emit('receive_message', msg);
    }

    // ★なりすまし元のユーザーへ配信（自身と宛先を除く）
    const senderSocketId = onlineSockets[actualSenderId];
    if (senderSocketId && senderSocketId !== socket.id && senderSocketId !== targetSocketId) {
      io.to(senderSocketId).emit('receive_message', msg);
    }
  });

  // 6. 既読処理
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
      const partnerSocketId = onlineSockets[partnerId];
      if (partnerSocketId) io.to(partnerSocketId).emit('messages_read_notification', { readerId: myId });
      socket.emit('messages_read_notification', { readerId: partnerId });
    }
  });

  // 👑 管理者機能
  socket.on('admin_auth', ({ code }) => {
    if (code === ADMIN_CODE) {
      socket.isAdmin = true;
      socket.emit('admin_auth_result', { success: true });
    } else {
      socket.emit('admin_auth_result', { success: false });
    }
  });

  // 👑 管理者モード解除
  socket.on('admin_logout', () => {
    socket.isAdmin = false;
    socket.emit('admin_logout_result');
  });

  socket.on('admin_rename_user', ({ targetUserId, newName }) => {
    if (!socket.isAdmin) return;
    if (db.users[targetUserId] && newName.trim()) {
      db.users[targetUserId].name = newName.trim();
      saveData();
      broadcastUserList();
    }
  });

  socket.on('admin_ban_user', ({ targetUserId, minutes }) => {
    if (!socket.isAdmin) return;
    if (db.users[targetUserId]) {
      const banTime = Date.now() + (minutes * 60 * 1000);
      db.users[targetUserId].bannedUntil = banTime;
      saveData();
      broadcastUserList();
      
      const targetSocketId = onlineSockets[targetUserId];
      if (targetSocketId) {
        io.to(targetSocketId).emit('error_message', `管理者により ${minutes} 分間使用禁止になりました。`);
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      delete onlineSockets[socket.userId];
    }
    broadcastUserList();
  });

  function broadcastUserList() {
    const now = Date.now();
    const userList = Object.values(db.users).map(u => ({
      ...u,
      isOnline: !!onlineSockets[u.userId],
      isBanned: u.bannedUntil > now
    }));
    io.emit('user_list_update', userList);
  }

  function isBanned(userId) {
    const u = db.users[userId];
    return u && u.bannedUntil > Date.now();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
