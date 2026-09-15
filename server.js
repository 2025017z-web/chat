const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // 10MBまでの画像・ファイル送信に対応
});

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = "adminhamu"; // 👑 管理者パスワード
const DATA_FILE = path.join(__dirname, 'data.json');

// --- データベース（メモリ ＆ ファイル保存） ---
let db = {
  users: {},    // ユーザー情報
  messages: [], // チャット履歴
  stamps: []    // スタンプ情報
};

// 起動時にファイルからデータを復元
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const dataStr = fs.readFileSync(DATA_FILE, 'utf8');
      db = JSON.parse(dataStr);
      // 再起動時は全ユーザーのオンライン状態をオフラインにリセット
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
      { id: 'stamp_default_1', name: 'いいね！', imageUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">👍</text></svg>', price: 0 },
      { id: 'stamp_default_2', name: 'OK', imageUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🙆</text></svg>', price: 0 },
      { id: 'stamp_default_3', name: 'ありがとう', imageUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🙏</text></svg>', price: 0 }
    ];
    saveData();
    console.log('🆕 新しい data.json を作成しました');
  }
}

// 変更時にファイルへ書き込み
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
      stamps: db.stamps
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(saveDataObj, null, 2), 'utf8');
  } catch (err) {
    console.error('❌ データ保存エラー:', err);
  }
}

loadData();

// 静的ファイルの提供設定（ルートおよびpublicフォルダの両方に対応）
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (fs.existsSync(path.join(__dirname, 'index.html'))) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else if (fs.existsSync(path.join(__dirname, 'public', 'index.html'))) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).send('index.html が見つかりません。server.js と同じフォルダに index.html を配置してください。');
  }
});

// デフォルトのミッション設定
function getDefaultMissions() {
  return [
    { id: 'm1', title: 'メッセージを5回送信', current: 0, goal: 5, reward: 50 },
    { id: 'm2', title: 'メッセージを20回送信', current: 0, goal: 20, reward: 200 },
    { id: 'm3', title: 'スタンプを購入・自作してみよう', current: 0, goal: 1, reward: 100 }
  ];
}

// ユーザー情報一括配信
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
    if (m.toUserId === 'ADMIN_REPORT_ROOM') return;
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
    chatPairs: Array.from(chatPairsMap.values())
  });
}

// ソケット通信設定
io.on('connection', (socket) => {
  let currentUserId = null;

  // 1. ユーザーログイン・登録
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

  // 2. プロフィール変更
  socket.on('update_profile', ({ name, avatar, bgImage }) => {
    if (!currentUserId || !db.users[currentUserId]) return;
    if (name) db.users[currentUserId].name = name;
    if (avatar) db.users[currentUserId].avatar = avatar;
    if (bgImage) db.users[currentUserId].bgImage = bgImage;

    saveData();
    socket.emit('profile_updated_success', { name, avatar, bgImage });
    broadcastUserList();
  });

  // 3. 友達申請
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

  // 4. チャット履歴の取得
  socket.on('get_chat_history', ({ partnerId, userA, userB }) => {
    let history = [];
    if (partnerId === 'ADMIN_REPORT_ROOM') {
      history = db.messages.filter(m => m.toUserId === 'ADMIN_REPORT_ROOM' || m.fromUserId === currentUserId);
    } else if (userA && userB) {
      history = db.messages.filter(m => 
        (m.fromUserId === userA && m.toUserId === userB) || (m.fromUserId === userB && m.toUserId === userA)
      );
    } else if (partnerId) {
      history = db.messages.filter(m => 
        (m.fromUserId === currentUserId && m.toUserId === partnerId) || 
        (m.fromUserId === partnerId && m.toUserId === currentUserId)
      );
    }

    socket.emit('chat_history', { partnerId: partnerId || userB, messages: history });
  });

  // 5. メッセージ送信
  socket.on('send_message', ({ toUserId, text, file, stampUrl, impersonateUserId }) => {
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
      toUserId: toUserId,
      text: text || '',
      file: file || null,
      stampUrl: stampUrl || null,
      time: timeStr,
      read: false,
      timestamp: Date.now()
    };

    db.messages.push(msgObj);

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

  // 6. 既読処理
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

  // 7. スタンプ自作
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

  // 8. スタンプ購入
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

    if (stamp.creatorId && db.users[stamp.creatorId]) {
      db.users[stamp.creatorId].coins = (db.users[stamp.creatorId].coins || 0) + Math.floor(stamp.price * 0.8);
    }

    if (user.missions) {
      const m = user.missions.find(x => x.id === 'm3');
      if (m) m.current = 1;
    }

    saveData();
    broadcastUserList();
    socket.emit('update_stamps_list', db.stamps);
  });

  // 9. ミッション達成
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

  // 切断
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
