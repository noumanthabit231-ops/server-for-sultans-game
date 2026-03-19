// ==========================================
// SULTAN ENGINE v1.7 - SERVER AUTHORITY WIN
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
  transports: ['websocket', 'polling']
});

const rooms = {};

app.get("/", (req, res) => res.send("--- SULTAN ENGINE v1.7 ONLINE ---"));

io.on("connection", (socket) => {
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
      seed: Math.random()
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

  function joinRoomInternal(socket, roomId, defaultName, isHost) {
    const room = rooms[roomId];
    socket.join(roomId);
    const player = {
      id: socket.id,
      name: defaultName,
      isHost: isHost,
      x: 600, y: 600,
      faction: isHost ? 'green' : 'blue',
      votedForRematch: false,
      hp: 100
    };
    room.players.push(player);
    socket.emit("join_success", room);
    io.to(roomId).emit("room_update", room);
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  }

  // --- СИНХРОНИЗАЦИЯ (20Hz Throttle) ---
  socket.on("sync_data", (data) => {
    if (data.roomId && rooms[data.roomId]) {
      const p = rooms[data.roomId].players.find(player => player.id === socket.id);
      if (p) {
        p.x = data.x; p.y = data.y; p.hp = data.hp;
      }
      socket.to(data.roomId).emit("remote_update", { id: socket.id, ...data });
    }
  });

  // --- СТАРТ МАТЧА ---
  socket.on("start_match_request", (roomId) => {
    const room = rooms[roomId];
    if (room && room.hostId === socket.id) {
      room.status = 'active';
      io.to(roomId).emit("match_started", room);
      io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
    }
  });

  // --- СИСТЕМА ФИКСАЦИИ ПОБЕДЫ (БЕТОН) ---
  socket.on("commander_death_detected", (data) => {
    // data: { roomId, winnerId, loserId }
    const room = rooms[data.roomId];
    
    // Проверяем, что комната существует и матч еще не помечен как законченный
    if (room && room.status === 'active') {
      console.log(`[BATTLE END] Султан ${data.loserId} пал. Победитель: ${data.winnerId}`);
      
      room.status = 'finished'; // Официально закрываем матч на сервере

      // Рассылаем УЛЬТИМАТИВНЫЙ приказ всем закончить игру
      io.to(data.roomId).emit("game_over_final", {
        winnerId: data.winnerId,
        loserId: data.loserId
      });
    }
  });

  // Реванш
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
          room.players.forEach(p => { p.votedForRematch = false; p.hp = 100; });
          io.to(roomId).emit("rematch_started", room);
        }
      }
    }
  });

  // --- ПОСТРОЙКИ ---
  socket.on("building_placed", (buildingData) => {
    const room = rooms[buildingData.roomId];
    if (room) {
      const newBuilding = { ...buildingData, ownerId: socket.id, isOpen: false };
      room.buildings.push(newBuilding);
      io.to(buildingData.roomId).emit("remote_building_placed", newBuilding);
    }
  });

  socket.on("building_destroyed", (data) => {
    const room = rooms[data.roomId];
    if (room) {
      room.buildings = room.buildings.filter(b => b.id !== data.buildingId);
      io.to(data.roomId).emit("remote_building_destroyed", data.buildingId);
    }
  });

  socket.on("toggle_gate", (data) => {
    const room = rooms[data.roomId];
    if (room) {
      const gate = room.buildings.find(b => b.id === data.buildingId);
      if (gate) {
        gate.isOpen = data.isOpen;
        io.to(data.roomId).emit("remote_gate_toggled", data);
      }
    }
  });

  // Прочие события
  socket.on("unit_hit", (d) => io.to(d.targetPlayerId).emit("take_unit_damage", d));
  socket.on("tower_fire", (d) => socket.to(d.roomId).emit("remote_tower_fire", d));

  socket.on("disconnect", () => {
    for (const rid in rooms) {
      const r = rooms[rid];
      r.players = r.players.filter(p => p.id !== socket.id);
      if (r.players.length === 0) delete rooms[rid];
      else io.to(rid).emit("room_update", r);
    }
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`--- SULTAN ENGINE v1.7 ONLINE ---`));
