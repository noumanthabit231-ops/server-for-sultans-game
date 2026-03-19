// ==========================================
// SULTAN ENGINE v1.6 - GLOBAL SYNC & PERFORMANCE
// ==========================================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000, 
  pingInterval: 15000,
  transports: ['websocket', 'polling'] // WebSocket в приоритете для скорости
});

const rooms = {};

app.get("/", (req, res) => res.send("--- SULTAN ENGINE v1.6 ONLINE ---"));

io.on("connection", (socket) => {
  // При подключении сразу шлем список доступных лобби
  socket.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));

  // --- СОЗДАНИЕ КОМНАТЫ ---
  socket.on("create_room", (data) => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[roomId] = {
      id: roomId,
      name: data.name || `Sultan_${roomId}`,
      hostId: socket.id,
      status: 'lobby',
      players: [], 
      buildings: [], 
      maxPlayers: Number(data.limit) || 10,
      rematchVotes: 0,
      seed: Math.random() // Seed для синхронизации карты
    };

    joinRoomInternal(socket, roomId, "Great Agha", true);
  });

  // --- ВХОД В КОМНАТУ ---
  socket.on("join_room", (roomId) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", "Комната не найдена");
    if (room.status !== 'lobby') return socket.emit("error", "Битва уже идет!");
    
    joinRoomInternal(socket, roomId, `Janissary_${socket.id.substring(0, 3)}`, false);
  });

  // Внутренняя логика входа для чистоты кода
  function joinRoomInternal(socket, roomId, defaultName, isHost) {
    const room = rooms[roomId];
    socket.join(roomId);

    const player = {
      id: socket.id,
      name: defaultName,
      isHost: isHost,
      x: 600,
      y: 600,
      faction: isHost ? 'green' : 'blue',
      votedForRematch: false,
      hp: 100
    };

    room.players.push(player);

    // ВАЖНО: Шлем новому игроку ПОЛНЫЙ снимок комнаты (игроки + постройки)
    socket.emit("join_success", room);
    
    // Оповещаем остальных, что состав комнаты изменился
    io.to(roomId).emit("room_update", room);
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  }

  // --- СИНХРОНИЗАЦИЯ (ОПТИМИЗИРОВАНО) ---
  socket.on("sync_data", (data) => {
    if (data.roomId && rooms[data.roomId]) {
      // Обновляем состояние игрока на сервере для новых участников
      const p = rooms[data.roomId].players.find(player => player.id === socket.id);
      if (p) {
        p.x = data.x;
        p.y = data.y;
        p.hp = data.hp;
      }
      // Рассылаем остальным только нужные дельты (координаты)
      socket.to(data.roomId).emit("remote_update", { id: socket.id, ...data });
    }
  });

  // --- СТАРТ МАТЧА ---
  socket.on("start_match_request", (roomId) => {
    const room = rooms[roomId];
    if (room && room.hostId === socket.id) {
      room.status = 'active'; // Сразу в active для скорости
      io.to(roomId).emit("match_started", room); // Передаем весь объект с seed и постройками
      io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
    }
  });

  // --- ГОЛОСОВАНИЕ ЗА РЕВАНШ ---
  socket.on("vote_rematch", (roomId) => {
    const room = rooms[roomId];
    if (room) { 
      const player = room.players.find(p => p.id === socket.id);
      if (player && !player.votedForRematch) {
        player.votedForRematch = true; 
        room.rematchVotes = (room.rematchVotes || 0) + 1; 

        io.to(roomId).emit("update_rematch_votes", {
          votedPlayers: room.rematchVotes,
          maxPlayers: room.players.length
        });

        if (room.rematchVotes >= room.players.length) {
          room.rematchVotes = 0; 
          room.status = 'lobby';
          room.buildings = []; 
          room.players.forEach(p => {
            p.votedForRematch = false;
            p.hp = 100;
          });
          io.to(roomId).emit("rematch_started", room);
        }
      }
    }
  });

  // --- БОЕВАЯ СИСТЕМА ---
  socket.on("player_killed", (victimId) => {
    io.to(victimId).emit("you_died"); 
    socket.broadcast.emit("remote_player_died", victimId);
  });

  socket.on("unit_hit", (data) => {
    io.to(data.targetPlayerId).emit("take_unit_damage", data);
  });

  socket.on("tower_fire", (data) => {
    socket.to(data.roomId).emit("remote_tower_fire", data);
  });

  // --- ПОСТРОЙКИ (СИНХРОНИЗИРОВАНО) ---
  socket.on("building_placed", (buildingData) => {
    const room = rooms[buildingData.roomId];
    if (room) {
      const newBuilding = { 
        ...buildingData, 
        id: buildingData.id, // Используем ID от клиента (паспорт)
        ownerId: socket.id,
        isOpen: false 
      };
      room.buildings.push(newBuilding);
      io.to(buildingData.roomId).emit("remote_building_placed", newBuilding);
    }
  });

  socket.on("building_hit", (data) => {
    if (data.roomId) socket.to(data.roomId).emit("remote_building_hit", data);
  });

  socket.on("building_destroyed", (data) => {
    const room = rooms[data.roomId];
    if (room) {
      room.buildings = room.buildings.filter(b => b.id !== data.buildingId);
      io.to(data.roomId).emit("remote_building_destroyed", data.buildingId);
    }
  });

  // --- ВОРОТА (ИНДИВИДУАЛЬНО) ---
  socket.on("toggle_gate", (data) => {
    const room = rooms[data.roomId];
    if (room) {
      const gate = room.buildings.find(b => b.id === data.buildingId);
      if (gate) {
        gate.isOpen = data.isOpen;
        io.to(data.roomId).emit("remote_gate_toggled", {
          buildingId: data.buildingId,
          isOpen: data.isOpen
        });
      }
    }
  });

  // --- ОТКЛЮЧЕНИЕ ---
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
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`--- SULTAN ENGINE v1.6 ONLINE ---`));
