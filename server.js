const io = require("socket.io")(process.env.PORT || 3001, {
  cors: { origin: "*" }
});

let rooms = {}; // Тут храним все созданные комнаты

io.on("connection", (socket) => {
  // 1. Отправляем список всех живых комнат новому игроку
  socket.emit("room_list", Object.values(rooms));

  // 2. Создание новой комнаты (Лимит 20 штук)
  socket.on("create_room", (data) => {
    if (Object.keys(rooms).length >= 20) {
      return socket.emit("error", "Лимит комнат исчерпан (макс. 20)");
    }
    const roomId = `room_${Math.random().toString(36).substr(2, 5)}`;
    rooms[roomId] = { 
      id: roomId, 
      name: data.name, 
      players: [], 
      maxPlayers: data.limit || 10, 
      status: 'waiting' 
    };
    socket.join(roomId);
    socket.emit("room_created", roomId);
    io.emit("room_list", Object.values(rooms)); // Обновляем список у всех
  });

  // 3. Вход в комнату
  socket.on("join_room", (roomId) => {
    const room = rooms[roomId];
    if (room && room.players.length < room.maxPlayers) {
      socket.join(roomId);
      if (!room.players.includes(socket.id)) room.players.push(socket.id);
      io.to(roomId).emit("player_joined", room.players);
      io.emit("room_list", Object.values(rooms));
    }
  });

  // 4. Удаление комнаты, если все вышли
  socket.on("disconnect", () => {
    for (let id in rooms) {
      rooms[id].players = rooms[id].players.filter(p => p !== socket.id);
      if (rooms[id].players.length === 0) delete rooms[id];
    }
    io.emit("room_list", Object.values(rooms));
  });
});
