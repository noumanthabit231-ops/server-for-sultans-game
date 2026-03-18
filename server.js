const io = require("socket.io")(process.env.PORT || 3001, {
  cors: { origin: "*" },
  pingTimeout: 60000, // Увеличиваем таймаут, чтобы вкладки не вылетали сразу
});

let rooms = {}; 

io.on("connection", (socket) => {
  console.log("Sultan connected:", socket.id);
  socket.emit("room_list", Object.values(rooms));

  socket.on("create_room", (data) => {
    const roomId = `room_${Math.random().toString(36).substr(2, 5)}`;
    rooms[roomId] = { 
      id: roomId, 
      name: data.name || "Sultan Match", 
      players: [socket.id], 
      maxPlayers: Number(data.limit) || 2, 
      status: 'waiting' 
    };
    socket.join(roomId);
    socket.emit("join_success", rooms[roomId]); 
    io.emit("room_list", Object.values(rooms));
  });

  socket.on("join_room", (rawId) => {
    const roomId = typeof rawId === 'object' ? rawId.id : rawId;
    const room = rooms[roomId];

    if (room && room.players.length < room.maxPlayers) {
      if (!room.players.includes(socket.id)) {
        room.players.push(socket.id);
      }
      socket.join(roomId);
      
      // Сначала подтверждаем вход лично игроку
      socket.emit("join_success", room); 
      // Затем уведомляем всех в комнате (включая вошедшего)
      io.to(roomId).emit("player_joined", room.players);
      io.emit("room_list", Object.values(rooms));

      if (room.players.length >= room.maxPlayers) {
        io.to(roomId).emit("start_countdown", 5);
      }
    } else {
      socket.emit("error", "Room is full or doesn't exist");
    }
  });

  socket.on("sync_data", (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit("remote_update", { id: socket.id, ...data });
    }
  });

  socket.on("disconnect", () => {
    for (let id in rooms) {
      if (rooms[id].players.includes(socket.id)) {
        rooms[id].players = rooms[id].players.filter(p => p !== socket.id);
        io.to(id).emit("player_joined", rooms[id].players);
        if (rooms[id].players.length === 0) delete rooms[id];
      }
    }
    io.emit("room_list", Object.values(rooms));
  });
});
