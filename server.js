// ==========================================
// SULTAN ENGINE v1.8 - GLOBAL QUEUE & CULLING
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

// ГЛОБАЛЬНЫЕ ЛИМИТЫ
const MAX_GLOBAL_PLAYERS = 1000; 
let activeConnections = 0; 
const waitingQueue = []; // Очередь ожидающих сокетов

app.get("/", (req, res) => res.send(`--- SULTAN ENGINE v1.8 ONLINE | PLAYERS: ${activeConnections}/${MAX_GLOBAL_PLAYERS} ---`));

io.on("connection", (socket) => {
  
  // 1. ПРОВЕРКА ОЧЕРЕДИ ПРИ ПОДКЛЮЧЕНИИ
  socket.emit("server_capacity", { active: activeConnections, max: MAX_GLOBAL_PLAYERS });

  if (activeConnections >= MAX_GLOBAL_PLAYERS) {
    // Мест нет, кидаем в очередь
    waitingQueue.push(socket);
    socket.isQueued = true;
    socket.emit("queue_update", { position: waitingQueue.length });
    console.log(`[QUEUE] Игрок ${socket.id} в очереди. Позиция: ${waitingQueue.length}`);
  } else {
    // Места есть, пускаем в лобби
    activeConnections++;
    socket.isQueued = false;
    socket.emit("queue_approved");
    io.emit("server_capacity", { active: activeConnections, max: MAX_GLOBAL_PLAYERS });
    socket.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  }

  // Внутренняя логика входа в комнату
  function joinRoomInternal(socket, roomId, defaultName, isHost) {
    if (socket.isQueued) return; // Защита: очередник не может зайти в комнату
    const room = rooms[roomId];
    if (!room) return;

    socket.join(roomId);
    const player = {
      id: socket.id, name: defaultName, isHost: isHost,
      x: 600, y: 600, faction: isHost ? 'green' : 'blue',
      votedForRematch: false, hp: 100, isAlive: true
    };
    room.players.push(player);
    socket.emit("join_success", room);
    io.to(roomId).emit("room_update", room);
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  }

  socket.on("create_room", (data) => {
    if (socket.isQueued) return;
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[roomId] = {
      id: roomId, name: data.name || `Sultan_${roomId}`, hostId: socket.id,
      status: 'lobby', players: [], buildings: [], 
      maxPlayers: Number(data.limit) || 10, rematchVotes: 0, seed: Math.random()
    };
    joinRoomInternal(socket, roomId, "Great Agha", true);
  });

  socket.on("join_room", (roomId) => {
    if (socket.isQueued) return;
    const room = rooms[roomId];
    if (!room) return socket.emit("error", "Комната не найдена");
    if (room.status !== 'lobby') return socket.emit("error", "Битва уже идет!");
    joinRoomInternal(socket, roomId, `Janissary_${socket.id.substring(0, 3)}`, false);
  });

  socket.on("sync_data", (data) => {
    if (socket.isQueued) return;
    if (data.roomId && rooms[data.roomId]) {
      const p = rooms[data.roomId].players.find(player => player.id === socket.id);
      if (p) { p.x = data.x; p.y = data.y; p.hp = data.hp; }
      socket.to(data.roomId).emit("remote_update", { id: socket.id, ...data });
    }
  });

  socket.on("start_match_request", (roomId) => {
    const room = rooms[roomId];
    if (room && room.hostId === socket.id) {
      room.status = 'active';
      io.to(roomId).emit("match_started", room);
      io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
    }
  });

  socket.on("commander_death_detected", (data) => {
    const room = rooms[data.roomId];
    if (room && room.status === 'active') {
      const loser = room.players.find(p => p.id === data.loserId);
      if (loser) loser.isAlive = false; 

      const winner = room.players.find(p => p.id === data.winnerId);
      const winnerName = winner ? winner.name : "Unknown Sultan";

      io.to(data.roomId).emit("player_eliminated", {
        loserId: data.loserId, winnerId: data.winnerId, winnerName: winnerName
      });

      const alivePlayers = room.players.filter(p => p.isAlive !== false);
      if (alivePlayers.length <= 1) {
        room.status = 'finished';
        const finalWinner = alivePlayers[0] || winner; 
        io.to(data.roomId).emit("game_over_final", {
          winnerId: finalWinner ? finalWinner.id : null,
          winnerName: finalWinner ? finalWinner.name : "Draw"
        });
      }
    }
  });

  socket.on("vote_rematch", (roomId) => {
    const room = rooms[roomId];
    if (room) { 
      const player = room.players.find(p => p.id === socket.id);
      if (player && !player.votedForRematch) {
        player.votedForRematch = true; 
        room.rematchVotes = (room.rematchVotes || 0) + 1; 
        io.to(roomId).emit("update_rematch_votes", { votedPlayers: room.rematchVotes, maxPlayers: room.players.length });

        if (room.rematchVotes >= room.players.length) {
          room.rematchVotes = 0; room.status = 'lobby'; room.buildings = []; 
          room.players.forEach(p => { p.votedForRematch = false; p.hp = 100; p.isAlive = true; });
          io.to(roomId).emit("rematch_started", room);
        }
      }
    }
  });

  socket.on("building_placed", (d) => {
    const room = rooms[d.roomId];
    if (room) {
      const newBuilding = { ...d, ownerId: socket.id, isOpen: false };
      room.buildings.push(newBuilding);
      io.to(d.roomId).emit("remote_building_placed", newBuilding);
    }
  });
  socket.on("building_hit", (d) => { if (d.roomId) socket.to(d.roomId).emit("remote_building_hit", d); });
  socket.on("building_destroyed", (d) => {
    const room = rooms[d.roomId];
    if (room) {
      room.buildings = room.buildings.filter(b => b.id !== d.buildingId);
      io.to(d.roomId).emit("remote_building_destroyed", d.buildingId);
    }
  });

    socket.on("garrison_destroyed", (d) => {
    if (d.roomId) {
      // Рассылаем всем в комнате, чтобы ВСЕ удалили этот отряд и поставили "надгробие"
      io.to(d.roomId).emit("garrison_destroyed", d);
    }
  });
  
  socket.on("toggle_gate", (d) => {
    const room = rooms[d.roomId];
    if (room) {
      const gate = room.buildings.find(b => b.id === d.buildingId);
      if (gate) { gate.isOpen = d.isOpen; io.to(d.roomId).emit("remote_gate_toggled", d); }
    }
  });
  socket.on("unit_hit", (d) => io.to(d.targetPlayerId).emit("take_unit_damage", d));
  socket.on("tower_fire", (d) => socket.to(d.roomId).emit("remote_tower_fire", d));

  // --- ОТКЛЮЧЕНИЕ И ПРОДВИЖЕНИЕ ОЧЕРЕДИ ---
  socket.on("disconnect", () => {
    if (socket.isQueued) {
      // Игрок ушел, не дождавшись очереди
      const idx = waitingQueue.indexOf(socket);
      if (idx !== -1) waitingQueue.splice(idx, 1);
      // Сдвигаем остальных
      waitingQueue.forEach((sq, i) => sq.emit("queue_update", { position: i + 1 }));
    } else {
      // Игрок из лобби/игры ушел, освободилось место!
      activeConnections--;
      
      if (waitingQueue.length > 0) {
        const nextSocket = waitingQueue.shift();
        nextSocket.isQueued = false;
        activeConnections++;
        nextSocket.emit("queue_approved");
        // Обновляем список лобби для счастливчика
        nextSocket.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
        // Сдвигаем остальных в очереди
        waitingQueue.forEach((sq, i) => sq.emit("queue_update", { position: i + 1 }));
      }
      io.emit("server_capacity", { active: activeConnections, max: MAX_GLOBAL_PLAYERS });
    }

    // Чистка комнат (осталась без изменений)
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        if (room.hostId === socket.id && room.players.length > 0) {
          room.hostId = room.players[0].id; room.players[0].isHost = true;
        }
        if (room.players.length === 0) delete rooms[roomId];
        else io.to(roomId).emit("room_update", room);
      }
    }
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`--- SULTAN ENGINE v1.8 ONLINE: ${PORT} ---`));
