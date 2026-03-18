const io = require("socket.io")(process.env.PORT || 3001, {
  cors: { origin: "*" },
  pingTimeout: 60000, // Ждем 60 секунд, прежде чем считать игрока вылетевшим
  pingInterval: 10000
});

let rooms = {}; 

io.on("connection", (socket) => {
  console.log("+++ Подключен:", socket.id);

  socket.on("create_room", (data) => {
    const roomId = `room_${Math.random().toString(36).substr(2, 5)}`;
    rooms[roomId] = { 
      id: roomId, 
      hostId: socket.id,
      players: [{ id: socket.id, name: "Host Agha" }], 
      maxPlayers: 2, 
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
      socket.join(roomId);
      // Проверяем, нет ли его уже там (чтобы не дублировать)
      if (!room.players.find(p => p.id === socket.id)) {
        room.players.push({ id: socket.id, name: `Janissary #${room.players.length + 1}` });
      }
      
      socket.emit("join_success", room); 
      io.to(roomId).emit("player_joined", room.players); // Шлем ВСЕМ в комнате
      io.emit("room_list", Object.values(rooms));
    }
  });

  socket.on("sync_data", (data) => {
    // Очень важно: прокидываем данные другим игрокам
    socket.to(data.roomId).emit("remote_update", { id: socket.id, ...data });
  });

  socket.on("disconnect", () => {
    console.log("--- Отключен:", socket.id);
    for (let id in rooms) {
      rooms[id].players = rooms[id].players.filter(p => p.id !== socket.id);
      if (rooms[id].players.length === 0) {
        delete rooms[id];
      } else {
        io.to(id).emit("player_joined", rooms[id].players);
      }
    }
    io.emit("room_list", Object.values(rooms));
  });
});
