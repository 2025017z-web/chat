const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// ファイル送信で容量制限でエラーにならないよう大きめに設定（約100MBまでOK）
const io = new Server(server, {
  maxHttpBufferSize: 1e8 
});

app.use(express.static(__dirname));

// 接続中のユーザー情報
const users = {};

io.on('connection', (socket) => {
  // ユーザー登録（名前の受信）
  socket.on('register', (name) => {
    users[socket.id] = {
      id: socket.id,
      name: name,
      requestsSent: [],
      friends: []
    };
    broadcastUserList();
  });

  // 友達申請
  socket.on('send_friend_request', (targetId) => {
    const sender = users[socket.id];
    const target = users[targetId];

    if (!sender || !target) return;

    if (!sender.requestsSent.includes(targetId)) {
      sender.requestsSent.push(targetId);
    }

    // お互いに申請しあっているか確認（相互申請で友達成立）
    if (target.requestsSent.includes(socket.id)) {
      if (!sender.friends.includes(targetId)) sender.friends.push(targetId);
      if (!target.friends.includes(socket.id)) target.friends.push(socket.id);
    }

    broadcastUserList();
  });

  // メッセージ送信（テキスト＋ファイル）
  socket.on('send_message', ({ toId, text, file }) => {
    const sender = users[socket.id];
    if (!sender) return;

    const messageData = {
      fromId: socket.id,
      fromName: sender.name,
      toId: toId,
      text: text,
      file: file, // { name, type, data }
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    // 自分と送信相手だけにリアルタイム配信
    socket.emit('receive_message', messageData);
    if (toId && io.sockets.sockets.get(toId)) {
      io.to(toId).emit('receive_message', messageData);
    }
  });

  // 切断時の処理
  socket.on('disconnect', () => {
    delete users[socket.id];
    broadcastUserList();
  });

  function broadcastUserList() {
    io.emit('user_list_update', Object.values(users));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
