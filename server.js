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

// 🔑 管理者コード（ここを好きな文字・パスワードに変更してください！）
const ADMIN_CODE = "hamsteromu";

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

  // 1. ユーザー初期化（サーバー再起動時のフレンド相互自動復元付き）
  socket.on('register', ({ userId, name, savedFriends, savedRequests }) => {
    socket.userId = userId;
    onlineSockets[userId] = socket.id;

    if (!db.users[userId]) {
      db.users[userId] = {
        userId,
        name,
        friends: Array.isArray(savedFriends) ? savedFriends : [],
        requestsSent: Array.isArray(savedRequests) ? savedRequests : [],
        bannedUntil: 0
      };
    } else {
      db.users[userId].name = name;
      if (Array.isArray(savedFriends)) {
        savedFriends.forEach(fId => {
          if (!db.users[userId].friends.includes(fId)) db.users[userId].friends.push(fId);
        });
      }
      if (Array.isArray(savedRequests)) {
        savedRequests.forEach(rId => {
          if (!db.users[userId].requestsSent.includes(rId)) db.users[userId].requestsSent.push(rId);
        });
      }
    }

    // サーバーファイル消滅時対策：相手側のリストにも相互復元
    if (Array.isArray(savedFriends)) {
      savedFriends.forEach(fId => {
        if (db.users[fId]) {
          if (!db.users[fId].friends.includes(userId)) db.users[fId].friends.push(userId);
        }
      });
    }

    saveData();
    broadcastUserList();
  });

  // 2. 名前変更
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
  socket.on('get_chat_history', ({ partnerId, userA, userB }) => {
    if (partnerId === 'ADMIN_REPORT_ROOM') {
      if (!socket.isAdmin) return;
      const history = db.messages.filter(m => m.toUserId === 'ADMIN_REPORT_ROOM');
      return socket.emit('chat_history', { partnerId: 'ADMIN_REPORT_ROOM', messages: history });
    }

    let u1 = socket.userId;
    let u2 = partnerId;

    if (socket.isAdmin && userA && userB) {
      u1 = userA;
      u2 = userB;
    }

    const history = db.messages.filter(m => 
      (m.fromUserId === u1 && m.toUserId === u2) ||
      (m.fromUserId === u2 && m.toUserId === u1)
    );

    socket.emit('chat_history', { userA: u1, userB: u2, partnerId: u2, messages: history });
  });

  // 5. メッセージ送信
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

    if (toUserId === 'ADMIN_REPORT_ROOM') {
      return io.emit('receive_message', msg);
    }

    socket.emit('receive_message', msg);

    const targetSocketId = onlineSockets[toUserId];
    if (targetSocketId && targetSocketId !== socket.id) {
      io.to(targetSocketId).emit('receive_message', msg);
    }

    const senderSocketId = onlineSockets[actualSenderId];
    if (senderSocketId && senderSocketId !== socket.id && senderSocketId !== targetSocketId) {
      io.to(senderSocketId).emit('receive_message', msg);
    }

    broadcastUserList();
  });

  // 6. 既読処理
  socket.on('mark_as_read', ({ partnerId, watchedUserA }) => {
    const myId = watchedUserA || socket.userId;
    if (!myId || !partnerId || partnerId === 'ADMIN_REPORT_ROOM') return;

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

  // 👑 管理者機能：一斉アナウンス配信
  socket.on('admin_broadcast_alert', ({ message, playSound }) => {
    if (!socket.isAdmin) return;

    const sender = db.users[socket.userId];
    const senderName = sender ? sender.name : "管理者";

    io.emit('receive_broadcast_alert', {
      title: `📢 ${senderName} からの一斉緊急アナウンス`,
      message: message,
      playSound: playSound
    });
  });

  // 👑 管理者認証
  socket.on('admin_auth', ({ code }) => {
    if (code === ADMIN_CODE) {
      socket.isAdmin = true;
      socket.emit('admin_auth_result', { success: true });
    } else {
      socket.emit('admin_auth_result', { success: false });
    }
  });

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

    const pairMap = new Set();
    const chatPairs = [];
    db.messages.forEach(m => {
      if (m.toUserId === 'ADMIN_REPORT_ROOM') return;
      const key = [m.fromUserId, m.toUserId].sort().join('_');
      if (!pairMap.has(key)) {
        pairMap.add(key);
        const u1 = db.users[m.fromUserId];
        const u2 = db.users[m.toUserId];
        if (u1 && u2) {
          chatPairs.push({ userA: u1, userB: u2 });
        }
      }
    });

    io.emit('user_list_update', { users: userList, chatPairs });
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
