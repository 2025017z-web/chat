const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // 10MB対応
});

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = "admin"; // 👑 管理者パスワード
const DATA_FILE = path.join(__dirname, 'data.json');

// --- データベース（メモリ ＆ ファイル保存） ---
let db = {
  users: {},    // ユーザー情報
  messages: [], // チャット履歴
  stamps: [],   // スタンプ情報
  groups: []    // グループ情報
};

// 初期スタンプ作成用の補助関数（SVGエンコード）
function makeSvgDataUrl(emoji) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${emoji}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// 起動時にデータ復元
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const dataStr = fs.readFileSync(DATA_FILE, 'utf8');
      db = JSON.parse(dataStr);
      if (!db.groups) db.groups = [];
      
      // オンライン状態のリセット
      Object.keys(db.users).forEach(id => {
        db.users[id].isOnline = false;
        db.users[id].socketId = null;
      });
      console.log('📂 データを data.json から復元しました');
    } catch (err) {
      console.error('❌ データ読み込みエラー:', err);
    }
  } else {
    // 初期データの作成
    db.stamps = [
      { id: 'stamp_default_1', name: 'いいね！', imageUrl: makeSvgDataUrl('👍'), price: 0 },
      { id: 'stamp_default_2', name: 'OK', imageUrl: makeSvgDataUrl('🙆'), price: 0 },
      { id: 'stamp_default_3', name: 'ありがとう', imageUrl: makeSvgDataUrl('🙏'), price: 0 }
    ];
    db.groups = [];
    saveData();
    console.log('🆕 新しい data.json を作成しました');
  }
}

// 変更時に書き込み
function saveData() {
  try {
    const copyUsers = {};
    Object.keys(db.users).forEach(id => {
      const u = { ...db.users[id] };
      delete u.socketId;
      u.isOnline = false;
      copyUsers[id] = u;
    });

    const saveDataObj = {
      users: copyUsers,
      messages: db.messages,
      stamps: db.stamps,
      groups: db.groups || []
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(saveDataObj, null, 2), 'utf8');
  } catch (err) {
    console.error('❌ データ保存エラー:', err);
  }
}

loadData();

// 静的ファイルの提供設定
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (fs.existsSync(path.join(__dirname, 'index.html'))) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else if (fs.existsSync(path.join(__dirname, 'public', 'index.html'))) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).send('index.html が見つかりません。');
  }
});

function getDefaultMissions() {
  return [
    { id: 'm1', title: 'メッセージを5回送信', current: 0, goal: 5, reward: 50 },
    { id: 'm2', title: 'メッセージを20回送信', current: 0, goal: 20, reward: 200 },
    { id: 'm3', title: 'スタンプを購入・自作してみよう', current: 0, goal: 1, reward: 100 }
  ];
}

// ユーザー＆グループ情報配信
function broadcastUserList() {
  const usersArray = Object.values(db.users).map(u => ({
    userId: u.userId,
    name: u.name,
    avatar: u.avatar || null,
    bgImage: u.bgImage || null,
    coins: u.coins || 0,
    isOnline: !!u.isOnline,
    friends: u.friends || [],
    requestsSent: u.requestsSent || [],
    ownedStamps: u.ownedStamps || [],
    missions: u.missions || []
  }));

  const chatPairsMap = new Map();
  db.messages.forEach(m => {
    if (m.toUserId === 'ADMIN_REPORT_ROOM' || m.toGroupId) return;
    const pairKey = [m.fromUserId, m.toUserId].sort().join('_');
    if (!chatPairsMap.has(pairKey)) {
      const u1 = db.users[m.fromUserId];
      const u2 = db.users[m.toUserId];
      if (u1 && u2) {
        chatPairsMap.set(pairKey, {
          userA: { userId: u1.userId, name: u1.name },
          userB: { userId: u2.userId, name: u2.name }
        });
      }
    }
  });

  io.emit('user_list_update', {
    users: usersArray,
    groups: db.groups || [],
    chatPairs: Array.from(chatPairsMap.values())
  });
}

// ソケット通信
io.on('connection', (socket) => {
  let currentUserId = null;

  socket.on('register', ({ userId, name, savedFriends, savedRequests }) => {
    currentUserId = userId;
    
    if (!db.users[userId]) {
      db.users[userId] = {
        userId,
        name,
        avatar: null,
        bgImage: null,
        coins: 100,
        friends: savedFriends || [],
        requestsSent: savedRequests || [],
        ownedStamps: ['stamp_default_1', 'stamp_default_2', 'stamp_default_3'],
        missions: getDefaultMissions()
      };
    }

    db.users[userId].name = name;
    db.users[userId].isOnline = true;
    db.users[userId].socketId = socket.id;

    if (!db.users[userId].ownedStamps) {
      db.users[userId].ownedStamps = ['stamp_default_1', 'stamp_default_2', 'stamp_default_3'];
    }

    saveData();
    socket.emit('update_stamps_list', db.stamps);
    broadcastUserList();
  });

  socket.on('update_profile', ({ name, avatar, bgImage }) => {
    if (!currentUserId || !db.users[currentUserId]) return;
    if (name) db.users[currentUserId].name = name;
    if (avatar) db.users[currentUserId].avatar = avatar;
    if (bgImage) db.users[currentUserId].bgImage = bgImage;

    saveData();
    socket.emit('profile_updated_success', { name, avatar, bgImage });
    broadcastUserList();
  });

  socket.on('send_friend_request', (targetUserId) => {
    if (!currentUserId || !db.users[currentUserId] || !db.users[targetUserId]) return;

    if (!db.users[currentUserId].requestsSent.includes(targetUserId)) {
      db.users[currentUserId].requestsSent.push(targetUserId);
    }
    if (!db.users[currentUserId].friends.includes(targetUserId)) {
      db.users[currentUserId].friends.push(targetUserId);
    }
    if (!db.users[targetUserId].friends.includes(currentUserId)) {
      db.users[targetUserId].friends.push(currentUserId);
    }

    saveData();
    broadcastUserList();
  });

  // チャット履歴取得
  socket.on('get_chat_history', ({ partnerId, groupId, userA, userB }) => {
    let history = [];
    if (groupId) {
      history = db.messages.filter(m => m.toGroupId === groupId);
    } else if (partnerId === 'ADMIN_REPORT_ROOM') {
      history = db.messages.filter(m => m.toUserId === 'ADMIN_REPORT_ROOM' || m.fromUserId === currentUserId);
    } else if (userA && userB) {
      history = db.messages.filter(m => 
        (m.fromUserId === userA && m.toUserId === userB) || (m.fromUserId === userB && m.toUserId === userA)
      );
    } else if (partnerId) {
      history = db.messages.filter(m => 
        !m.toGroupId &&
        ((m.fromUserId === currentUserId && m.toUserId === partnerId) || 
         (m.fromUserId === partnerId && m.toUserId === currentUserId))
      );
    }

    socket.emit('chat_history', { partnerId: partnerId || userB, groupId, messages: history });
  });

  // メッセージ送信
  socket.on('send_message', ({ toUserId, toGroupId, text, file, stampUrl, impersonateUserId }) => {
    if (!currentUserId || !db.users[currentUserId]) return;

    const senderId = impersonateUserId || currentUserId;
    const sender = db.users[senderId] || { name: '管理者', avatar: null };

    const now = new Date();
    const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;

    const msgObj = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      fromUserId: senderId,
      fromName: sender.name,
      fromAvatar: sender.avatar,
      toUserId: toGroupId ? null : toUserId,
      toGroupId: toGroupId || null,
      text: text || '',
      file: file || null,
      stampUrl: stampUrl || null,
      time: timeStr,
      read: false,
      timestamp: Date.now()
    };

    db.messages.push(msgObj);

    // コイン加算 (+5)
    if (db.users[senderId]) {
      db.users[senderId].coins = (db.users[senderId].coins || 0) + 5;
      if (db.users[senderId].missions) {
        db.users[senderId].missions.forEach(m => {
          if (m.id === 'm1' || m.id === 'm2') m.current += 1;
        });
      }
    }

    saveData();
    io.emit('receive_message', msgObj);
    broadcastUserList();
  });

  socket.on('mark_as_read', ({ partnerId, watchedUserA }) => {
    const targetA = watchedUserA || currentUserId;
    let updated = false;

    db.messages.forEach(m => {
      if (m.fromUserId === partnerId && m.toUserId === targetA && !m.read) {
        m.read = true;
        updated = true;
      }
    });

    if (updated) {
      saveData();
      io.emit('chat_history', {
        partnerId: partnerId,
        messages: db.messages.filter(m => 
          (m.fromUserId === targetA && m.toUserId === partnerId) || 
          (m.fromUserId === partnerId && m.toUserId === targetA)
        )
      });
    }
  });

  // スタンプ自作
  socket.on('create_stamp', ({ name, imageUrl, price }) => {
    if (!currentUserId) return;
    const newStamp = {
      id: 'stamp_' + Date.now(),
      name,
      imageUrl,
      price: parseInt(price) || 0,
      creatorId: currentUserId
    };

    db.stamps.push(newStamp);
    if (!db.users[currentUserId].ownedStamps) db.users[currentUserId].ownedStamps = [];
    db.users[currentUserId].ownedStamps.push(newStamp.id);

    if (db.users[currentUserId].missions) {
      const m = db.users[currentUserId].missions.find(x => x.id === 'm3');
      if (m) m.current = 1;
    }

    saveData();
    io.emit('update_stamps_list', db.stamps);
    broadcastUserList();
  });

  // スタンプ購入 (★ 手数料10% / クリエイターへ90%還元)
  socket.on('buy_stamp', (stampId) => {
    const stamp = db.stamps.find(s => s.id === stampId);
    const user = db.users[currentUserId];
    if (!stamp || !user) return;

    if ((user.coins || 0) < stamp.price) {
      return socket.emit('error_message', 'コインが不足しています');
    }

    user.coins -= stamp.price;
    if (!user.ownedStamps) user.ownedStamps = [];
    user.ownedStamps.push(stampId);

    // 販売者に 90% 還元（10%が手数料）
    if (stamp.creatorId && db.users[stamp.creatorId]) {
      const reward = Math.floor(stamp.price * 0.9);
      db.users[stamp.creatorId].coins = (db.users[stamp.creatorId].coins || 0) + reward;
    }

    if (user.missions) {
      const m = user.missions.find(x => x.id === 'm3');
      if (m) m.current = 1;
    }

    saveData();
    broadcastUserList();
    socket.emit('update_stamps_list', db.stamps);
  });

  socket.on('claim_mission', (missionId) => {
    const user = db.users[currentUserId];
    if (!user || !user.missions) return;

    const mission = user.missions.find(m => m.id === missionId);
    if (mission && mission.current >= mission.goal) {
      user.coins = (user.coins || 0) + mission.reward;
      mission.current = 0;
      saveData();
      broadcastUserList();
      socket.emit('system_alert', `🎉 ミッションクリア！ ${mission.reward} コインを獲得しました！`);
    }
  });

  // --- 管理者機能 ---
  socket.on('admin_auth', ({ code }) => {
    if (code === ADMIN_PASSWORD) {
      socket.emit('admin_auth_result', { success: true });
    } else {
      socket.emit('admin_auth_result', { success: false });
    }
  });

  socket.on('admin_logout', () => {
    socket.emit('admin_logout_result');
  });

  // 管理者によるグループ作成
  socket.on('admin_create_group', ({ groupName, memberUserIds }) => {
    if (!groupName) return;
    const newGroup = {
      id: 'group_' + Date.now(),
      name: groupName,
      members: memberUserIds || [] // 空なら全員参加
    };
    if (!db.groups) db.groups = [];
    db.groups.push(newGroup);

    saveData();
    broadcastUserList();
    socket.emit('system_alert', `👨‍👩‍👧‍👦 グループ「${groupName}」を作成しました`);
  });

  socket.on('admin_set_coins', ({ targetUserId, amount }) => {
    if (db.users[targetUserId]) {
      db.users[targetUserId].coins = parseInt(amount) || 0;
      saveData();
      broadcastUserList();
    }
  });

  socket.on('admin_ban_user', ({ targetUserId, minutes }) => {
    const targetSocketId = db.users[targetUserId]?.socketId;
    if (targetSocketId) {
      io.to(targetSocketId).emit('system_alert', `⛔ あなたのアカウントは ${minutes} 分間 BAN されました。`);
    }
  });

  socket.on('admin_broadcast_alert', ({ message }) => {
    io.emit('receive_broadcast_alert', {
      title: '📢 管理者からの重要なお知らせ',
      message: message
    });
  });

  socket.on('disconnect', () => {
    if (currentUserId && db.users[currentUserId]) {
      db.users[currentUserId].isOnline = false;
      db.users[currentUserId].socketId = null;
      saveData();
      broadcastUserList();
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 サーバーが起動しました: http://localhost:${PORT}`);
});
