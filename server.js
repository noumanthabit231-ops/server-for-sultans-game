// ========================================================= 
// SULTAN ENGINE v1.8.2 - SECURE & AUTHORITATIVE SYNC 
// ========================================================= 
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
const waitingQueue = []; 

app.get("/", (req, res) => res.send(`--- SULTAN ENGINE v1.8.2 ONLINE | PLAYERS: ${activeConnections}/${MAX_GLOBAL_PLAYERS} ---`)); 

// Вспомогательная функция для логики выхода игрока из комнаты
function handlePlayerLeaving(socket, roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const playerIndex = room.players.findIndex(p => p.id === socket.id);
  if (playerIndex !== -1) {
    console.log(`[ROOM] Игрок ${socket.id} покинул комнату ${roomId}`);
    room.players.splice(playerIndex, 1);
    
    // Если вышедший был хостом и в комнате еще есть люди
    if (room.hostId === socket.id && room.players.length > 0) {
      const newHost = room.players[0];
      room.hostId = newHost.id;
      newHost.isHost = true;
      console.log(`[HOST] Новое лидерство в ${roomId} передано ${newHost.id}`);
    }

    // Если в комнате никого не осталось — удаляем её
    if (room.players.length === 0) {
      console.log(`[ROOM] Комната ${roomId} пуста и будет удалена.`);
      delete rooms[roomId];
    } else {
      // Иначе уведомляем оставшихся об изменениях
      io.to(roomId).emit("room_update", room);
    }
    
    socket.leave(roomId);
  }
}

io.on("connection", (socket) => { 
  
  const sendRoomList = () => { 
    const list = Object.values(rooms) 
      .filter(r => r.status === 'lobby') 
      .map(r => { 
        const { password, ...publicData } = r; 
        return { 
          ...publicData, 
          password: !!password 
        }; 
      }); 
    io.emit("room_list", list); 
  }; 

  socket.emit("server_capacity", { active: activeConnections, max: MAX_GLOBAL_PLAYERS }); 

  if (activeConnections >= MAX_GLOBAL_PLAYERS) { 
    waitingQueue.push(socket); 
    socket.isQueued = true; 
    socket.emit("queue_update", { position: waitingQueue.length }); 
  } else { 
    activeConnections++; 
    socket.isQueued = false; 
    socket.emit("queue_approved"); 
    io.emit("server_capacity", { active: activeConnections, max: MAX_GLOBAL_PLAYERS }); 
    sendRoomList(); 
  } 

  function joinRoomInternal(socket, roomId, defaultName, isHost) { 
    if (socket.isQueued) return; 
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
    sendRoomList(); 
  } 

  // В СОЗДАНИИ КОМНАТЫ
socket.on("create_room", (data) => { 
  if (socket.isQueued) return; 
  const roomId = Math.random().toString(36).substring(2, 7).toUpperCase(); 
  rooms[roomId] = { 
    id: roomId, 
    name: data.name || `Sultan_${roomId}`, 
    password: data.password || '', 
    hostId: socket.id, 
    status: 'lobby', 
    players: [], 
    buildings: [], 
    maxPlayers: Number(data.limit) || 10, 
    rematchVotes: 0, 
    seed: Math.random() 
  }; 
  // ИСПОЛЬЗУЕМ ИМЯ ИЗ ДАННЫХ КЛИЕНТА (data.playerName)
  joinRoomInternal(socket, roomId, data.playerName || "Great Agha", true); 
}); 

// В ВХОДЕ В КОМНАТУ
socket.on("join_room", (data) => { 
  if (socket.isQueued) return; 
  const roomId = typeof data === 'string' ? data : data.roomId; 
  const password = typeof data === 'string' ? '' : data.password; 
  const playerName = data.playerName || `Janissary_${socket.id.substring(0, 3)}`; // ИМЯ ИЗ КЛИЕНТА

  const room = rooms[roomId]; 
  if (!room) return socket.emit("error", "Комната не найдена"); 
  if (room.status !== 'lobby') return socket.emit("error", "Битва уже идет!"); 
  if (room.password && room.password !== password) return socket.emit("error", "Неверный пароль!"); 

  joinRoomInternal(socket, roomId, playerName, false); 
}); 

  // ЯВНЫЙ ВЫХОД ИЗ КОМНАТЫ
  socket.on("leave_room", (roomId) => {
    handlePlayerLeaving(socket, roomId);
    sendRoomList();
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
      sendRoomList(); 
    } 
  }); 

  socket.on("commander_death_detected", (data) => { 
    const room = rooms[data.roomId]; 
    if (room && room.status === 'active') { 
      const loser = room.players.find(p => p.id === data.loserId); 
      if (loser) loser.isAlive = false; 
      const winner = room.players.find(p => p.id === data.winnerId); 
      const winnerName = winner ? winner.name : "Enemy"; 

      io.to(data.roomId).emit("player_eliminated", { 
        loserId: data.loserId, winnerId: data.winnerId, winnerName: winnerName 
      }); 

      // Внутри обработчика io.on('connection', (socket) => { ... })

// Обработка создания/обновления норы
// 1. Хранение и обновление ям на сервере
// Внутри io.on('connection', (socket) => { ... })

// Создание ямы (туннеля)
  // ==========================================
  // СИНХРОНИЗАЦИЯ ЯМ (ТУННЕЛЕЙ) - ИСПРАВЛЕНО
  // ==========================================
  
  socket.on("tunnel_update", (data) => { 
    const room = rooms[data.roomId]; 
    if (room) { 
      if (!room.tunnels) room.tunnels = []; 
      
      const idx = room.tunnels.findIndex(t => t.id === data.id); 
      if (idx !== -1) { 
        room.tunnels[idx] = data; 
      } else { 
        room.tunnels.push(data); 
      } 
      
      // ВАЖНО: Отправляем ВСЕМ ОСТАЛЬНЫМ в комнате (как при строительстве башен)
      socket.to(data.roomId).emit("tunnel_update", data); 
    } 
  }); 

  socket.on("tunnel_remove", (data) => { 
    const room = rooms[data.roomId]; 
    if (room && room.tunnels) { 
      room.tunnels = room.tunnels.filter(t => t.id !== data.id); 
      
      // ВАЖНО: Отправляем ВСЕМ ОСТАЛЬНЫМ
      socket.to(data.roomId).emit("tunnel_remove", { id: data.id }); 
    } 
  }); 

  socket.on("request_tunnels", (data) => { 
    const room = rooms[data.roomId]; 
    if (room && room.tunnels) { 
      // Отправляем только тому, кто запросил (кто только что зашел)
      socket.emit("sync_tunnels", { tunnels: room.tunnels }); 
    } 
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
          sendRoomList(); 
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

  socket.on("garrison_hit", (d) => { if (d.roomId) io.to(d.roomId).emit("remote_garrison_hit", d); }); 
  socket.on("garrison_destroyed", (d) => { if (d.roomId) io.to(d.roomId).emit("garrison_destroyed", d); }); 

  socket.on("toggle_gate", (d) => { 
    const room = rooms[d.roomId]; 
    if (room) { 
      const gate = room.buildings.find(b => b.id === d.buildingId); 
      if (gate) { gate.isOpen = d.isOpen; io.to(d.roomId).emit("remote_gate_toggled", d); } 
    } 
  }); 

  socket.on("unit_hit", (d) => io.to(d.targetPlayerId).emit("take_unit_damage", d)); 
  socket.on("tower_fire", (d) => socket.to(d.roomId).emit("remote_tower_fire", d)); 

  socket.on("disconnect", () => { 
    if (socket.isQueued) { 
      const idx = waitingQueue.indexOf(socket); 
      if (idx !== -1) waitingQueue.splice(idx, 1); 
      waitingQueue.forEach((sq, i) => sq.emit("queue_update", { position: i + 1 })); 
    } else { 
      activeConnections--; 
      if (waitingQueue.length > 0) { 
        const nextSocket = waitingQueue.shift(); 
        nextSocket.isQueued = false; 
        activeConnections++; 
        nextSocket.emit("queue_approved"); 
        sendRoomList(); 
        waitingQueue.forEach((sq, i) => sq.emit("queue_update", { position: i + 1 })); 
      } 
      io.emit("server_capacity", { active: activeConnections, max: MAX_GLOBAL_PLAYERS }); 
    } 

    // Проверка всех комнат при дисконнекте
    for (const roomId in rooms) { 
      handlePlayerLeaving(socket, roomId);
    } 
    sendRoomList(); 
  }); 
}); 

const PORT = process.env.PORT || 3001; 
server.listen(PORT, () => console.log(`--- SULTAN ENGINE v1.8.2 ONLINE: ${PORT} ---`));
