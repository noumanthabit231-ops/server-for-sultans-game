// SULTAN ENGINE v1.5 - FIX SEED & INDIVIDUAL GATES
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
  // Отправляем список лобби при подключении
  socket.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));

  // --- СОЗДАНИЕ КОМНАТЫ ---
  socket.on("create_room", (data) => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[roomId] = {
      id: roomId,
      name: data.name || `Sultan_${roomId}`,
      hostId: socket.id,
      status: 'lobby',
      players: [{ id: socket.id, name: "Great Agha", isHost: true, x: 600, y: 600, faction: 'green', votedForRematch: false }],
      buildings: [], // Хранилище всех построек для отслеживания состояния (ворот и т.д.)
      maxPlayers: Number(data.limit) || 10,
      rematchVotes: 0,
      seed: Math.random() // Генерируем SEED, чтобы убрать ошибку (reading 'seed')
    };

    socket.join(roomId);
    socket.emit("join_success", rooms[roomId]);
    io.to(roomId).emit("room_update", rooms[roomId]); 
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  });

  // --- ВХОД В КОМНАТУ ---
  socket.on("join_room", (roomId) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", "Комната не найдена");
    if (room.status !== 'lobby') return socket.emit("error", "Битва уже идет!");

    socket.join(roomId);
    const exists = room.players.find(p => p.id === socket.id);
    if (!exists) {
      room.players.push({ 
        id: socket.id, 
        name: `Janissary_${socket.id.substring(0, 3)}`, 
        isHost: false, 
        x: 600, 
        y: 600, 
        faction: 'blue', 
        votedForRematch: false 
      });
    }

    socket.emit("join_success", room);
    io.to(roomId).emit("room_update", room);
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  });

  // --- СИНХРОНИЗАЦИЯ ПОЗИЦИЙ ---
  socket.on("sync_data", (data) => {
    if (data.roomId) socket.to(data.roomId).emit("remote_update", { id: socket.id, ...data });
  });

  // --- СТАРТ МАТЧА ---
  socket.on("start_match_request", (roomId) => {
    const room = rooms[roomId];
    if (room && room.hostId === socket.id) {
      room.status = 'starting';
      io.to(roomId).emit("start_countdown", 5);
      io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));

      setTimeout(() => {
        if (rooms[roomId]) {
          rooms[roomId].status = 'active';
          // Передаем весь объект комнаты, включая seed, чтобы игра не крашилась
          io.to(roomId).emit("match_started", rooms[roomId]); 
        }
      }, 5000);
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
          room.buildings = []; // Очищаем постройки для новой игры
          room.players.forEach(p => p.votedForRematch = false); 
          
          io.to(roomId).emit("rematch_started", room);
          io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
        }
      }
    }
  });

  // --- СМЕРТЬ ИГРОКА ---
  socket.on("player_killed", (victimId) => {
    io.to(victimId).emit("you_died"); 
    socket.broadcast.emit("remote_player_died", victimId);
  });

  // --- УСТАНОВКА ПОСТРОЕК (БАШНИ, ЗАБОРЫ, ВОРОТА) ---
  socket.on("building_placed", (buildingData) => {
    const room = rooms[buildingData.roomId];
    if (room) {
      // Сохраняем постройку в памяти сервера с уникальным ID
      const newBuilding = { 
        ...buildingData, 
        id: buildingData.id || `B-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        ownerId: socket.id,
        isOpen: false // По умолчанию ворота закрыты
      };
      room.buildings.push(newBuilding);
      
      // Рассылаем всем в комнате
      io.to(buildingData.roomId).emit("remote_building_placed", newBuilding);
    }
  });

  // --- ПОВРЕЖДЕНИЕ ПОСТРОЕК ---
  socket.on("building_hit", (data) => {
    if (data.roomId) socket.to(data.roomId).emit("remote_building_hit", data);
  });

  // --- СНОС ПОСТРОЕК ---
  socket.on("building_destroyed", (data) => {
    if (data.roomId && data.buildingId) {
      const room = rooms[data.roomId];
      if (room) {
        room.buildings = room.buildings.filter(b => b.id !== data.buildingId);
      }
      io.to(data.roomId).emit("remote_building_destroyed", data.buildingId);
    }
  });

  // --- УРОН ЮНИТАМ ---
  socket.on("unit_hit", (data) => {
    io.to(data.targetPlayerId).emit("take_unit_damage", data);
  });

  // --- ВИЗУАЛ СТРЕЛЬБЫ ---
  socket.on("tower_fire", (data) => {
    socket.to(data.roomId).emit("remote_tower_fire", data);
  });

  // --- УПРАВЛЕНИЕ ВОРОТАМИ (ОТКРЫТЬ/ЗАКРЫТЬ) ---
  socket.on("toggle_gate", (data) => {
    // data: { roomId, buildingId, isOpen }
    const room = rooms[data.roomId];
    if (room) {
      const gate = room.buildings.find(b => b.id === data.buildingId);
      if (gate) {
        gate.isOpen = data.isOpen;
        // Рассылаем всем ОБЯЗАТЕЛЬНО через io.to().emit, чтобы все увидели анимацию
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
server.listen(PORT, () => console.log(`--- SULTAN ENGINE ONLINE: ${PORT} ---`));
