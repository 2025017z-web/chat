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

const ADMIN_CODE = "adminiwamoto";
const DATA_FILE = path.join(__dirname, 'chat_data.json');

// バグらないインラインSVGスタンプデータ
const STAMP_HIYOKO = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='55' r='35' fill='%23FFD700'/><circle cx='35' cy='45' r='5' fill='%23000'/><circle cx='65' cy='45' r='5' fill='%23000'/><polygon points='50,50 38,62 62,62' fill='%23FF6B6B'/></svg>";
const STAMP_GOOD = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%234cd137'/><path d='M35 50 L45 60 L65 40' stroke='white' stroke-width='8' fill='none' stroke-linecap='round'/></svg>";

let db = { 
  users: {}, 
  messages: [], 
  stamps: [
    { id: 'stamp_default_1', name: 'ひよこ', imageUrl: STAMP_HIYOKO, price: 0, creatorId: 'system' },
    { id: 'stamp_default_2', name: 'いいね', imageUrl: STAMP_GOOD, price: 0, creatorId: 'system' }
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

function getJSTime() {
  return new Date().toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function sanitizeName(name) {
  if (!name || typeof name !== 'string') return '名無し';
  return name.trim().slice(0, 20);
}

// ユーザーの初期無尽蔵ミッションを生成
function generateInitialMissions() {
  return [
    { id: 'm_chat', type: 'chat', title: 'メッセージを送信しよう', goal: 5, current: 0, reward: 50 },
    { id: 'm_friend', type: 'friend', title: '友達を追加しよう', goal: 1, current: 0, reward: 100 },
    { id: 'm_buy', type: 'buy', title: 'スタンプを購入しよう', goal: 1, current: 0, reward: 150 }
  ];
}

const onlineSockets = {};

io.on('connection', (socket) => {

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
        coins: 100,
        ownedStamps: ['stamp_default_1', 'stamp_default_2'],
        missions: generateInitialMissions(),
        friends: Array.isArray(savedFriends) ? savedFriends : [],
        requestsSent: Array.isArray(savedRequests) ? savedRequests : [],
        bannedUntil: 0
      };
    } else {
      db.users[userId].name = safeName;
      if (!db.users[userId].ownedStamps) db.users[userId].ownedStamps = ['stamp_default_1', 'stamp_default_2'];
      if (db.users[userId].coins === undefined) db.users[userId].coins = 100;
      if (!db.users[userId].missions || db.users[userId].missions.length === 0) {
        db.users[userId].missions = generateInitialMissions();
      }
    }

    saveData();
    broadcastUserList();
    socket.emit('update_stamps_list', db.stamps);
  });

  socket.on('update_profile', ({ name, avatar, bgImage }) => {
    const u = db.users[socket.userId];
    if (u) {
      if (name) u.name = sanitizeName(name);
      if (avatar !== undefined) u.avatar = avatar;
      if (bgImage !== undefined) u.bgImage = bgImage;
      saveData();
      broadcastUserList();
      socket.emit('profile_updated_success', { name: u.name, avatar: u.avatar, bgImage: u.bgImage });
    }
  });

  socket.on('send_friend_request', (targetUserId) => {
    if (isBanned(socket.userId)) return;
    const sender = db.users[socket.userId];
    const target = db.users[targetUserId];

    if (!sender || !target) return;

    if (!sender.requestsSent.includes(targetUserId)) {
      sender.requestsSent.push(targetUserId);
    }

    if (target.requestsSent.includes(socket.userId)) {
      if (!sender.friends.includes(targetUserId)) {
        sender.friends.push(targetUserId);
        updateMissionProgress(sender, 'friend', 1);
      }
      if (!target.friends.includes(socket.userId)) {
        target.friends.push(socket.userId);
        updateMissionProgress(target, 'friend', 1);
      }
    }

    saveData();
    broadcastUserList();
  });

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

    if (!socket.isAdmin || !impersonateUserId) {
      sender.coins = (sender.coins || 0) + 5; // 送信ボーナス
      updateMissionProgress(sender, 'chat', 1);
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
    if (targetSocketId && targetSocketId !== socket.id) io.to(targetSocketId).emit('receive_message', msg);

    const senderSocketId = onlineSockets[actualSenderId];
    if (senderSocketId && senderSocketId !== socket.id && senderSocketId !== targetSocketId) {
      io.to(senderSocketId).emit('receive_message', msg);
    }

    broadcastUserList();
  });

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

  // 0未満を防止したスタンプ登録
  socket.on('create_stamp', ({ name, imageUrl, price }) => {
    const u = db.users[socket.userId];
    if (!u) return;

    const safePrice = Math.max(0, parseInt(price) || 0);
    const stampId = 'stamp_' + Date.now();
    const newStamp = {
      id: stampId,
      name: name || '自作スタンプ',
      imageUrl: imageUrl,
      price: safePrice,
      creatorId: socket.userId
    };

    db.stamps.push(newStamp);
    u.ownedStamps.push(stampId);

    saveData();
    io.emit('update_stamps_list', db.stamps);
    broadcastUserList();
    socket.emit('system_alert', '🎨 スタンプを登録・販売開始しました！');
  });

  socket.on('buy_stamp', (stampId) => {
    const u = db.users[socket.userId];
    const stamp = db.stamps.find(s => s.id === stampId);

    if (!u || !stamp) return;
    if (u.ownedStamps.includes(stampId)) return socket.emit('error_message', 'すでに所有しています。');
    if (u.coins < stamp.price) return socket.emit('error_message', 'コインが足りません！');

    u.coins -= stamp.price;
    u.ownedStamps.push(stampId);

    if (stamp.creatorId && db.users[stamp.creatorId]) {
      db.users[stamp.creatorId].coins += stamp.price;
    }

    updateMissionProgress(u, 'buy', 1);
    saveData();
    broadcastUserList();
    socket.emit('system_alert', `🎉 スタンプ「${stamp.name}」を購入しました！`);
  });

  // 無尽蔵ミッション受け取り & 次ミッションの自動補給
  socket.on('claim_mission', (missionId) => {
    const u = db.users[socket.userId];
    if (!u || !u.missions) return;

    const mIndex = u.missions.findIndex(m => m.id === missionId);
    if (mIndex === -1) return;

    const m = u.missions[mIndex];
    if (m.current < m.goal) {
      return socket.emit('error_message', 'まだミッション条件を達成していません！');
    }

    // 報酬獲得
    u.coins += m.reward;
    const claimedReward = m.reward;

    // 次の難易度の無尽蔵ミッション生成
    const nextGoal = m.goal + (m.type === 'chat' ? 5 : 1);
    const nextReward = m.reward + (m.type === 'chat' ? 50 : 100);

    u.missions[mIndex] = {
      id: 'm_' + m.type + '_' + Date.now(),
      type: m.type,
      title: m.title,
      goal: nextGoal,
      current: m.current, // 現在値を維持してカウント継続
      reward: nextReward
    };

    saveData();
    broadcastUserList();
    socket.emit('system_alert', `🎁 ミッション達成！ ${claimedReward} コインを獲得！次のミッションが解放されました！`);
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

  // 👑 コイン数を指定変更する機能
  socket.on('admin_set_coins', ({ targetUserId, amount }) => {
    if (!socket.isAdmin) return;
    const target = db.users[targetUserId];
    if (target) {
      target.coins = Math.max(0, parseInt(amount) || 0);
      saveData();
      broadcastUserList();
      socket.emit('system_alert', `⚙️ ${target.name} の所持コインを ${target.coins} に変更しました。`);
    }
  });

  socket.on('admin_broadcast_alert', ({ message }) => {
    if (!socket.isAdmin) return;
    io.emit('receive_broadcast_alert', { title: `📢 管理者アナウンス`, message });
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
      db.users[targetUserId].bannedUntil = Date.now() + (minutes * 60 * 1000);
      saveData();
      broadcastUserList();
    }
  });

  socket.on('disconnect', () => {
    if (socket.userId) delete onlineSockets[socket.userId];
    broadcastUserList();
  });

  function updateMissionProgress(user, type, amount) {
    if (!user.missions) return;
    user.missions.forEach(m => {
      if (m.type === type) {
        m.current += amount;
      }
    });
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
