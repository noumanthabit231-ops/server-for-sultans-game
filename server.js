const io = require("socket.io")(process.env.PORT || 3001, {
  cors: { origin: "*" }
});

let rooms = {}; 

io.on("connection", (socket) => {
  console.log(">>> Новый Султан подключился:", socket.id);
  socket.emit("room_list", Object.values(rooms));

  socket.on("create_room", (data) => {
    const roomId = `room_${Math.random().toString(36).substr(2, 5)}`;
    rooms[roomId] = { 
      id: roomId, 
      name: data.name || "Sultan Battle", 
      players: [socket.id], 
      maxPlayers: Number(data.limit) || 2, 
      status: 'waiting' 
    };
    socket.join(roomId);
    socket.emit("join_success", rooms[roomId]); 
    io.emit("room_list", Object.values(rooms));
    console.log(">>> Создана комната:", roomId);
  });

  socket.on("join_room", (rawId) => {
    const roomId = typeof rawId === 'object' ? rawId.id : rawId;
    const room = rooms[roomId];

    if (room && room.players.length < room.maxPlayers) {
      socket.join(roomId);
      if (!room.players.includes(socket.id)) {
        room.players.push(socket.id);
      }
      
      console.log(`>>> Игрок ${socket.id} вошел в ${roomId}. Всего: ${room.players.length}`);
      
      socket.emit("join_success", room); 
      io.to(roomId).emit("player_joined", room.players);
      io.emit("room_list", Object.values(rooms));

      // АВТО-СТАРТ: если набралось нужное количество людей
      if (room.players.length >= room.maxPlayers) {
        console.log(">>> Комната полная! Начинаем отсчет...");
        io.to(roomId).emit("start_countdown", 5); // 5 секунд до старта
      }
    } else {
      socket.emit("error", "Комната полна или не найдена");
    }
  });

  socket.on("sync_data", (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit("remote_update", { id: socket.id, ...data });
    }
  });

  socket.on("disconnect", () => {
    console.log("<<< Султан ушел:", socket.id);
    for (let id in rooms) {
      if (rooms[id].players.includes(socket.id)) {
        rooms[id].players = rooms[id].players.filter(p => p !== socket.id);
        io.to(id).emit("player_joined", rooms[id].players);
        
        if (rooms[id].players.length === 0) {
          console.log(">>> Комната пуста и удалена:", id);
          delete rooms[id];
        }
      }
    }
    io.emit("room_list", Object.values(rooms));
  });
});
