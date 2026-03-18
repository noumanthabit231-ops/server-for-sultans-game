const io = require("socket.io")(process.env.PORT || 3001, {
  cors: { origin: "*" }
});

let rooms = {}; 

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);
  socket.emit("room_list", Object.values(rooms));

  socket.on("create_room", (data) => {
    if (Object.keys(rooms).length >= 20) {
      return socket.emit("error", "Лимит комнат исчерпан (макс. 20)");
    }
    const roomId = `room_${Math.random().toString(36).substr(2, 5)}`;
    rooms[roomId] = { 
      id: roomId, 
      name: data.name, 
      players: [socket.id], // Сразу добавляем создателя
      maxPlayers: data.limit || 10, 
      status: 'waiting' 
    };
    socket.join(roomId);
    socket.emit("room_created", roomId);
    socket.emit("join_success", rooms[roomId]); // Подтверждаем успех создателю
    io.emit("room_list", Object.values(rooms));
  });

  socket.on("join_room", (roomId) => {
    const room = rooms[roomId];
    if (room && room.players.length < room.maxPlayers) {
      socket.join(roomId);
      if (!room.players.includes(socket.id)) {
        room.players.push(socket.id);
      }
      
      // КРИТИЧЕСКИЙ МОМЕНТ: отправляем подтверждение клиенту
      socket.emit("join_success", room); 
      
      // Уведомляем остальных в комнате
      io.to(roomId).emit("player_joined", room.players);
      // Обновляем глобальный список
      io.emit("room_list", Object.values(rooms));
    } else {
      socket.emit("error", "Не удалось зайти: комната полна или не существует");
    }
  });

  // Синхронизация данных в реальном времени
  socket.on("sync_data", (data) => {
    // Пересылаем данные всем остальным в этой же комнате
    socket.to(data.roomId).emit("remote_update", { id: socket.id, ...data });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    for (let id in rooms) {
      if (rooms[id].players.includes(socket.id)) {
        rooms[id].players = rooms[id].players.filter(p => p !== socket.id);
        
        // Уведомляем оставшихся, что игрок вышел
        io.to(id).emit("player_left", socket.id);
        io.to(id).emit("player_joined", rooms[id].players);

        if (rooms[id].players.length === 0) {
          delete rooms[id];
        }
      }
    }
    io.emit("room_list", Object.values(rooms));
  });
});
