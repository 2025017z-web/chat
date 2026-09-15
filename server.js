const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e8 // 大容量ファイル・画像送信対応
});

app.use(express.static(__dirname));

// 🔑 管理者コード
const ADMIN_CODE = "hamsteromu";

// --- データ保存処理 ---
const DATA_FILE = path.join(__dirname, 'chat_data.json');
let db = { 
  users: {}, 
  messages: [], 
  stamps: [
    { id: 'stamp_default_1', name: 'ひよこ', imageUrl: 'https://api.iconify.design/fluent-emoji:chick.svg', price: 0, creatorId: 'system' },
    { id: 'stamp_default_2', name: 'いいね', imageUrl: 'https://api.iconify.design/fluent-emoji:thumbs-up.svg', price: 0, creatorId: 'system' }
  ] 
};

if (fs.existsSync(DATA_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db = { ...db, ...loaded };
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

// 日本時間（JST）取得
function getJSTime() {
  return new Date().toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function sanitizeName(name) {
  if (!name || typeof name !== 'string') return '名無し';
  return name.trim().slice(0, 20);
}

const onlineSockets = {}; // userId -> socketId

// ミッション定義
const MISSIONS = {
  PROFILE_UPDATE: { id: 'PROFILE_UPDATE', title: 'プロフィールを設定しよう', reward: 50 },
  FRIEND_ADD: { id: 'FRIEND_ADD', title: '友達を1人追加しよう', reward: 100 },
  CHAT_10: { id: 'CHAT_10', title: 'メッセージを10回送信しよう', reward: 150 }
};

io.on('connection', (socket) => {

  // 1. ユーザー初期化
  socket.on('register', ({ userId, name, savedFriends, savedRequests }) => {
    socket.userId = userId;
    onlineSockets[userId] = socket.id;

    const safeName = sanitizeName(name);

    if (!db.users[userId]) {
      db.users[userId] = {
        userId,
        name: safeName,
        avatar: '',
        bgImage: '',
        coins: 100, // 初期コイン
        ownedStamps: ['stamp_default_1', 'stamp_default_2'],
        claimedMissions: [],
        msgCount: 0,
        friends: Array.isArray(savedFriends) ? savedFriends : [],
        requestsSent: Array.isArray(savedRequests) ? savedRequests : [],
        bannedUntil: 0
      };
    } else {
      db.users[userId].name = safeName;
      if (!db.users[userId].ownedStamps) db.users[userId].ownedStamps = ['stamp_default_1', 'stamp_default_2'];
      if (db.users[userId].coins === undefined) db.users[userId].coins = 100;
      if (!db.users[userId].claimedMissions) db.users[userId].claimedMissions = [];
      if (!db.users[userId].msgCount) db.users[userId].msgCount = 0;
    }

    saveData();
    broadcastUserList();
    socket.emit('update_stamps_list', db.stamps);
  });

  // プロフィール（名前・アイコン・背景）変更
  socket.on('update_profile', ({ name, avatar, bgImage }) => {
    const u = db.users[socket.userId];
    if (u) {
      if (name) u.name = sanitizeName(name);
      if (avatar !== undefined) u.avatar = avatar;
      if (bgImage !== undefined) u.bgImage = bgImage;
      
      // ミッション判定: プロフィール更新
      checkAndTriggerMission(u, 'PROFILE_UPDATE');

      saveData();
      broadcastUserList();
      socket.emit('profile_updated_success', { name: u.name, avatar: u.avatar, bgImage: u.bgImage });
    }
  });

  // 2. 友達申請
  socket.on('send_friend_request', (targetUserId) => {
    if (isBanned(socket.userId)) return;
    const sender = db.users[socket.userId];
    const target = db.users[targetUserId];

    if (!sender || !target) return;

    if (!sender.requestsSent.includes(targetUserId)) {
      sender.requestsSent.push(targetUserId);
    }

    if (target.requestsSent.includes(socket.userId)) {
      if (!sender.friends.includes(targetUserId)) sender.friends.push(targetUserId);
      if (!target.friends.includes(socket.userId)) target.friends.push(socket.userId);
      
      checkAndTriggerMission(sender, 'FRIEND_ADD');
      checkAndTriggerMission(target, 'FRIEND_ADD');
    }

    saveData();
    broadcastUserList();
  });

  // 3. チャット履歴取得
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

  // 4. メッセージ・スタンプ送信（コイン獲得ロジック付き）
  socket.on('send_message', ({ toUserId, text, file, stampUrl, impersonateUserId }) => {
    if (isBanned(socket.userId)) {
      return socket.emit('error_message', '現在BAN状態のため送信できません。');
    }

    let actualSenderId = socket.userId;
    if (socket.isAdmin && impersonateUserId) {
      actualSenderId = impersonateUserId;
    }

    const sender = db.users[actualSenderId];
    if (!sender || !toUserId) return;

    // チャット報酬: +5 コイン獲得
    if (!socket.isAdmin || !impersonateUserId) {
      sender.coins = (sender.coins || 0) + 5;
      sender.msgCount = (sender.msgCount || 0) + 1;
      if (sender.msgCount >= 10) {
        checkAndTriggerMission(sender, 'CHAT_10');
      }
    }

    const msg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      fromUserId: actualSenderId,
      fromName: sender.name,
      fromAvatar: sender.avatar,
      toUserId: toUserId,
      text: text || '',
      file: file || null,
      stampUrl: stampUrl || null,
      time: getJSTime(),
      timestamp: Date.now(),
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

  // 既読
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

  // 5. スタンプの自作と販売登録
  socket.on('create_stamp', ({ name, imageUrl, price }) => {
    const u = db.users[socket.userId];
    if (!u) return;

    const stampId = 'stamp_' + Date.now();
    const newStamp = {
      id: stampId,
      name: name || '自作スタンプ',
      imageUrl: imageUrl,
      price: parseInt(price) || 0,
      creatorId: socket.userId
    };

    db.stamps.push(newStamp);
    u.ownedStamps.push(stampId); // 作成者は自動所有

    saveData();
    io.emit('update_stamps_list', db.stamps);
    broadcastUserList();
    socket.emit('system_alert', '🎨 スタンプを登録・販売開始しました！');
  });

  // スタンプの購入
  socket.on('buy_stamp', (stampId) => {
    const u = db.users[socket.userId];
    const stamp = db.stamps.find(s => s.id === stampId);

    if (!u || !stamp) return;

    if (u.ownedStamps.includes(stampId)) {
      return socket.emit('error_message', 'すでに購入済みのスタンプです。');
    }

    if (u.coins < stamp.price) {
      return socket.emit('error_message', 'コインが足りません！');
    }

    u.coins -= stamp.price;
    u.ownedStamps.push(stampId);

    // 作者にコインを還元
    if (stamp.creatorId && db.users[stamp.creatorId]) {
      db.users[stamp.creatorId].coins += stamp.price;
    }

    saveData();
    broadcastUserList();
    socket.emit('system_alert', `🎉 スタンプ「${stamp.name}」を購入しました！`);
  });

  // ミッション報酬受取
  socket.on('claim_mission', (missionId) => {
    const u = db.users[socket.userId];
    const m = MISSIONS[missionId];
    if (u && m && !u.claimedMissions.includes(missionId)) {
      u.claimedMissions.push(missionId);
      u.coins += m.reward;
      saveData();
      broadcastUserList();
      socket.emit('system_alert', `🎁 ミッションクリア！ ${m.reward} コインを獲得しました！`);
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

  socket.on('admin_logout', () => {
    socket.isAdmin = false;
    socket.emit('admin_logout_result');
  });

  socket.on('admin_broadcast_alert', ({ message, playSound }) => {
    if (!socket.isAdmin) return;
    io.emit('receive_broadcast_alert', {
      title: `📢 管理者からの一斉アナウンス`,
      message: message,
      playSound: playSound
    });
  });

  socket.on('admin_rename_user', ({ targetUserId, newName }) => {
    if (!socket.isAdmin) return;
    const safeName = sanitizeName(newName);
    if (db.users[targetUserId] && safeName) {
      db.users[targetUserId].name = safeName;
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
        io.to(targetSocketId).emit('error_message', `管理者により ${minutes} 分間BANされました。`);
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      delete onlineSockets[socket.userId];
    }
    broadcastUserList();
  });

  function checkAndTriggerMission(user, missionKey) {
    if (!user.claimedMissions.includes(missionKey)) {
      // 受取可能フラグ管理用にクライアント通知
    }
  }

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
        if (u1 && u2) chatPairs.push({ userA: u1, userB: u2 });
      }
    });

    io.emit('user_list_update', { users: userList, chatPairs, messages: db.messages });
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
