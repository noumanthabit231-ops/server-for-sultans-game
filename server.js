const io = require("socket.io")(process.env.PORT || 3001, {
  cors: { origin: "*" },
  pingTimeout: 60000,
});

let rooms = {}; 

io.on("connection", (socket) => {
  socket.emit("room_list", Object.values(rooms));

  socket.on("create_room", (data) => {
    const roomId = `room_${Math.random().toString(36).substr(2, 5)}`;
    rooms[roomId] = { 
      id: roomId, 
      name: data.name || "Sultan's Raid", 
      host: socket.id, // Запоминаем, кто батя (создатель)
      players: [{ id: socket.id, name: "Agha (Host)" }], 
      maxPlayers: Number(data.limit) || 4, 
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
      const playerName = `Janissary #${room.players.length + 1}`;
      room.players.push({ id: socket.id, name: playerName });
      
      socket.emit("join_success", room); 
      io.to(roomId).emit("room_update", room); // Шлем ВСЮ комнату со всеми игроками
      io.emit("room_list", Object.values(rooms));
    }
  });

  socket.on("start_match_request", (roomId) => {
    const room = rooms[roomId];
    if (room && room.host === socket.id) { // Только Хост может запустить
        io.to(roomId).emit("start_countdown", 5);
    }
  });

  socket.on("sync_data", (data) => {
    if (data.roomId) socket.to(data.roomId).emit("remote_update", { id: socket.id, ...data });
  });

  socket.on("disconnect", () => {
    for (let id in rooms) {
      rooms[id].players = rooms[id].players.filter(p => p.id !== socket.id);
      if (rooms[id].host === socket.id && rooms[id].players.length > 0) {
          rooms[id].host = rooms[id].players[0].id; // Передаем права Хоста другому
      }
      io.to(id).emit("room_update", rooms[id]);
      if (rooms[id].players.length === 0) delete rooms[id];
    }
    io.emit("room_list", Object.values(rooms));
  });
});
