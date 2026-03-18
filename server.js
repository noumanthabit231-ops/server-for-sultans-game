// ФОРСИРУЕМ ОБНОВЛЕНИЕ СЕРВЕРА 1.1 - РЕВАНШ РАБОТАЕТ
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000, 
  pingInterval: 15000,
  transports: ['websocket', 'polling']
});

const rooms = {};

app.get("/", (req, res) => res.send("Sultan Server Active"));

io.on("connection", (socket) => {
  // ВЕСЬ КОД ДОЛЖЕН БЫТЬ ВНУТРИ ЭТОЙ ФУНКЦИИ!
  
  socket.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));

  socket.on("create_room", (data) => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[roomId] = {
      id: roomId,
      name: data.name || `Sultan_${roomId}`,
      hostId: socket.id,
      status: 'lobby',
      players: [{ id: socket.id, name: "Great Agha", isHost: true, x: 600, y: 600, votedForRematch: false }],
      maxPlayers: Number(data.limit) || 10,
      rematchVotes: 0
    };

    socket.join(roomId);
    socket.emit("join_success", rooms[roomId]);
    io.to(roomId).emit("room_update", rooms[roomId]); 
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  });

  socket.on("join_room", (roomId) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", "Комната не найдена");
    if (room.status !== 'lobby') return socket.emit("error", "Битва уже идет!");

    socket.join(roomId);
    const exists = room.players.find(p => p.id === socket.id);
    if (!exists) {
      room.players.push({ id: socket.id, name: `Janissary_${socket.id.substring(0, 3)}`, isHost: false, x: 600, y: 600, votedForRematch: false });
    }

    socket.emit("join_success", room);
    io.to(roomId).emit("room_update", room);
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  });

  socket.on("sync_data", (data) => {
    if (data.roomId) socket.to(data.roomId).emit("remote_update", { id: socket.id, ...data });
  });

  socket.on("start_match_request", (roomId) => {
    if (rooms[roomId] && rooms[roomId].hostId === socket.id) {
      rooms[roomId].status = 'starting';
      io.to(roomId).emit("start_countdown", 5);
      io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));

      setTimeout(() => {
        if (rooms[roomId]) {
          rooms[roomId].status = 'active';
          io.to(roomId).emit("match_started"); 
        }
      }, 5000);
    }
  });

  // --- ИСПРАВЛЕННЫЙ БЛОК: ГОЛОСОВАНИЕ ЗА РЕВАНШ ---
  // --- БЕЗОТКАЗНОЕ ГОЛОСОВАНИЕ ЗА РЕВАНШ ---
  socket.on("vote_rematch", (roomId) => {
    console.log(`[SERVER DEBUG] Получен сигнал vote_rematch от ${socket.id} для комнаты ${roomId}`);
    const room = rooms[roomId];

    // Убрали проверку room.status === 'active', просто проверяем что комната существует
    if (room) { 
      const player = room.players.find(p => p.id === socket.id);

      if (player && !player.votedForRematch) {
        player.votedForRematch = true; 
        room.rematchVotes = (room.rematchVotes || 0) + 1; 
        
        console.log(`[VOTE SUCCESS] Игрок ${socket.id} проголосовал. Итого: ${room.rematchVotes}/${room.players.length}`);

        // Шлем обновленный счетчик ВСЕМ в комнате
        io.to(roomId).emit("update_rematch_votes", {
          votedPlayers: room.rematchVotes,
          maxPlayers: room.players.length
        });

        // Проверяем, если проголосовали ВСЕ
        if (room.rematchVotes >= room.players.length) {
          console.log(`[REMATCH START] Все проголосовали! Перезапуск комнаты ${roomId}`);
          
          room.rematchVotes = 0; 
          room.status = 'lobby';
          room.players.forEach(p => p.votedForRematch = false); 
          
          io.to(roomId).emit("rematch_started", room);
          io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
        }
      } else {
        console.log(`[VOTE REJECTED] Игрок не найден или уже голосовал: ${socket.id}`);
      }
    } else {
      console.log(`[VOTE REJECTED] Комната не найдена: ${roomId}`);
    }
  });

  // --- СИНХРОНИЗАЦИЯ СМЕРТИ (EXECUTION) ---
  socket.on("player_killed", (victimId) => {
    console.log(`[FATALITY] Игрок ${socket.id} убил ${victimId}`);
    
    // Мгновенно шлем жертве команду умереть
    io.to(victimId).emit("you_died"); 
    
    // Рассылаем всем остальным, что этот игрок труп (чтобы убрали его модельку)
    socket.broadcast.emit("remote_player_died", victimId);
  });

  // --- СИНХРОНИЗАЦИЯ ПОСТРОЕК (БАШНИ И ЗАБОРЫ) ---
  socket.on("building_placed", (buildingData) => {
    // buildingData содержит: roomId, type, x, y, faction, health
    console.log(`[BUILD] Игрок ${socket.id} построил ${buildingData.type} в комнате ${buildingData.roomId}`);
    
    // Рассылаем всем остальным в комнате данные о новой постройке
    socket.to(buildingData.roomId).emit("remote_building_placed", { 
      ownerId: socket.id, 
      ...buildingData 
    });
  });

  // --- СИНХРОНИЗАЦИЯ ПОВРЕЖДЕНИЙ ПОСТРОЕК ---
  socket.on("building_hit", (data) => {
    // data: { roomId, buildingId, damage }
    const room = rooms[data.roomId];
    if (room) {
      // Транслируем всем, что постройку бьют
      socket.to(data.roomId).emit("remote_building_hit", data);
    }
  });

  socket.on("building_destroyed", (data) => {
    // data: { roomId, buildingId }
    socket.to(data.roomId).emit("remote_building_destroyed", data.buildingId);
  });

  socket.on("unit_hit", (data) => {
    // data: { targetPlayerId, unitIndex, damage }
    io.to(data.targetPlayerId).emit("take_unit_damage", data);
  });

  socket.on("tower_fire", (data) => {
    // Рассылаем всем в комнате, что башня выстрелила (для визуала)
    socket.broadcast.emit("remote_tower_fire", data);
  });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        if (room.hostId === socket.id && room.players.length > 0) {
          room.hostId = room.players[0].id;
          room.players[0].isHost = true;
        }
        if (room.players.length === 0) {
          delete rooms[roomId];
        } else {
          io.to(roomId).emit("room_update", room);
        }
      }
    }
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  });
}); // <--- ВОТ ЗДЕСЬ ЗАКРЫВАЕТСЯ io.on

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`--- SULTAN ENGINE ONLINE: ${PORT} ---`));
