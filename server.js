const io = require("socket.io")(process.env.PORT || 3001, {
  cors: { origin: "*" },
  pingInterval: 2000, // Часто пингуем, чтобы не уснул
  pingTimeout: 5000
});

let rooms = {}; 

io.on("connection", (socket) => {
  console.log("+++ Подключен:", socket.id);
  socket.emit("room_list", Object.values(rooms));

  socket.on("create_room", (data) => {
    const roomId = `room_${Math.random().toString(36).substr(2, 5)}`;
    rooms[roomId] = { 
      id: roomId, 
      name: data.name || "Sultan Battle", 
      players: [socket.id], 
      maxPlayers: 2, // Для теста поставим 2
      status: 'waiting' 
    };
    socket.join(roomId);
    socket.emit("join_success", rooms[roomId]); 
    io.emit("room_list", Object.values(rooms));
    console.log(`>>> Комната ${roomId} создана Султаном ${socket.id}`);
  });

  socket.on("join_room", (rawId) => {
    const roomId = typeof rawId === 'object' ? rawId.id : rawId;
    const room = rooms[roomId];

    if (room) {
      if (!room.players.includes(socket.id)) {
        room.players.push(socket.id);
      }
      socket.join(roomId);
      
      console.log(`>>> Игрок ${socket.id} вошел в ${roomId}. В комнате: ${room.players.join(', ')}`);
      
      socket.emit("join_success", room); 
      // Шлем всем в комнате обновленный список
      io.to(roomId).emit("player_joined", room.players);
      io.emit("room_list", Object.values(rooms));

      if (room.players.length >= room.maxPlayers) {
        io.to(roomId).emit("start_countdown", 5);
      }
    } else {
      socket.emit("error", "Комната не найдена в списке сервера!");
    }
  });

  socket.on("sync_data", (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit("remote_update", { id: socket.id, ...data });
    }
  });

  socket.on("disconnect", () => {
    console.log("--- Отключен:", socket.id);
    for (let id in rooms) {
      if (rooms[id].players.includes(socket.id)) {
        rooms[id].players = rooms[id].players.filter(p => p !== socket.id);
        io.to(id).emit("player_joined", rooms[id].players);
        // Удаляем комнату только если там ВООБЩЕ никого нет
        if (rooms[id].players.length === 0) delete rooms[id];
      }
    }
    io.emit("room_list", Object.values(rooms));
  });
});
