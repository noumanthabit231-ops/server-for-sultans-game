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

app.get("/", (req, res) => res.send("Sultan Server Engine v1.4 Active"));

// --- ГЛОБАЛЬНЫЙ ЦИКЛ СЕРВЕРНОЙ ПОДДЕРЖКИ (Для фоновых вкладок) ---
setInterval(() => {
  Object.values(rooms).forEach(room => {
    if (room.status !== 'active' || !room.buildings) return;

    room.buildings.forEach(tower => {
      if (tower.type !== 'TOWER') return;

      for (const player of room.players) {
        // Проверка фракций: башня не бьет своих
        if (player.faction === tower.faction) continue;

        const dx = (player.x || 0) - tower.x;
        const dy = (player.y || 0) - tower.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 450) { // Радиус башни
          // Сервер сам инициирует выстрел, если видит цель
          io.to(room.id).emit("remote_tower_fire", {
            towerId: tower.id,
            targetId: player.id,
            targetX: player.x,
            targetY: player.y,
            startX: tower.x,
            startY: tower.y
          });
          break; // Одна башня — одна цель в секунду
        }
      }
    });
  });
}, 1000);

io.on("connection", (socket) => {
  console.log(`[CONNECT] New Sultan connected: ${socket.id}`);

  socket.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));

  socket.on("create_room", (data) => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[roomId] = {
      id: roomId,
      name: data.name || `Sultan_${roomId}`,
      hostId: socket.id,
      status: 'lobby',
      players: [{ 
        id: socket.id, 
        name: "Great Agha", 
        isHost: true, 
        x: 600, 
        y: 600, 
        faction: 'green',
        votedForRematch: false 
      }],
      buildings: [],
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

  socket.on("sync_data", (data) => {
    const room = rooms[data.roomId];
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.x = data.x;
        player.y = data.y;
        player.faction = data.faction || player.faction;
      }
      socket.to(data.roomId).emit("remote_update", { id: socket.id, ...data });
    }
  });

  socket.on("start_match_request", (roomId) => {
    const room = rooms[roomId];
    if (room && room.hostId === socket.id) {
      room.status = 'starting';
      io.to(roomId).emit("start_countdown", 5);
      setTimeout(() => {
        if (rooms[roomId]) {
          rooms[roomId].status = 'active';
          io.to(roomId).emit("match_started"); 
        }
      }, 5000);
    }
  });

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
          room.players.forEach(p => p.votedForRematch = false); 
          io.to(roomId).emit("rematch_started", room);
        }
      }
    }
  });

  socket.on("player_killed", (vId) => {
    io.to(vId).emit("you_died"); 
    socket.broadcast.emit("remote_player_died", vId);
  });

  socket.on("building_placed", (bData) => {
    const room = rooms[bData.roomId];
    if (room) {
      const newB = { ...bData, id: "T-" + Math.random().toString(36).substring(7), ownerId: socket.id };
      room.buildings.push(newB);
      io.to(bData.roomId).emit("remote_building_placed", newB);
    }
  });

  socket.on("building_hit", (data) => {
    const room = rooms[data.roomId];
    if (room) {
      const b = room.buildings.find(item => item.id === data.buildingId);
      if (b) {
        b.health = (b.health || 100) - data.damage;
        if (b.health <= 0) {
          room.buildings = room.buildings.filter(item => item.id !== data.buildingId);
          io.to(data.roomId).emit("remote_building_destroyed", data.buildingId);
        } else {
          socket.to(data.roomId).emit("remote_building_hit", data);
        }
      }
    }
  });

  socket.on("unit_hit", (data) => {
    io.to(data.targetPlayerId).emit("take_unit_damage", data);
  });

  // --- ТОТ САМЫЙ КРИТИЧЕСКИЙ ЛИСТЕНЕР ДЛЯ ВИЗУАЛА ---
  socket.on("tower_fire", (data) => {
    // Если клиент сам посчитал выстрел (в активной вкладке), транслируем всем
    socket.to(data.roomId).emit("remote_tower_fire", data);
  });

  socket.on("disconnect", () => {
    for (const rid in rooms) {
      const room = rooms[rid];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[rid];
      } else {
        if (room.hostId === socket.id) {
          room.hostId = room.players[0].id;
          room.players[0].isHost = true;
        }
        io.to(rid).emit("room_update", room);
      }
    }
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`--- SULTAN ENGINE ONLINE: ${PORT} ---`));
