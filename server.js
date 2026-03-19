// ==========================================
// SULTAN ENGINE v1.7 - СЕРВЕРНАЯ ВЛАСТЬ (FULL)
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
  // При подключении отправляем список лобби
  socket.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));

  // --- ВНУТРЕННЯЯ ЛОГИКА ВХОДА (Чтобы не дублировать код) ---
  function joinRoomInternal(socket, roomId, defaultName, isHost) {
    const room = rooms[roomId];
    if (!room) return;

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

    // Отправляем игроку ПОЛНЫЙ снимок комнаты
    socket.emit("join_success", room);
    
    // Оповещаем остальных в комнате
    io.to(roomId).emit("room_update", room);
    
    // Обновляем глобальный список лобби
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  }

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

  // --- СИНХРОНИЗАЦИЯ ДАННЫХ ---
  socket.on("sync_data", (data) => {
    if (data.roomId && rooms[data.roomId]) {
      const p = rooms[data.roomId].players.find(player => player.id === socket.id);
      if (p) {
        p.x = data.x;
        p.y = data.y;
        p.hp = data.hp;
      }
      // Транслируем всем остальным в комнате
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
  // --- СИСТЕМА ФИКСАЦИИ ПОБЕДЫ (БЕТОН) ---
  // --- СИСТЕМА ФИКСАЦИИ СМЕРТИ И ПОБЕДЫ (BATTLE ROYALE) ---
  // --- СИСТЕМА ФИКСАЦИИ СМЕРТИ И ПОБЕДЫ (ВЫЖИВАЕТ СИЛЬНЕЙШИЙ) ---
  socket.on("commander_death_detected", (data) => {
    // data: { roomId, winnerId, loserId }
    const room = rooms[data.roomId];
    
    if (room && room.status === 'active') {
      // 1. Помечаем убитого игрока как мертвого
      const loser = room.players.find(p => p.id === data.loserId);
      if (loser) loser.isAlive = false; 

      // 2. Ищем имя убийцы
      const winner = room.players.find(p => p.id === data.winnerId);
      const winnerName = winner ? winner.name : "Unknown Sultan";

      console.log(`[ELIMINATION] Султан ${data.loserId} убит игроком ${winnerName}`);

      // 3. Сообщаем ВСЕМ, что выбыл ТОЛЬКО ОДИН игрок (другие продолжают играть!)
      io.to(data.roomId).emit("player_eliminated", {
        loserId: data.loserId,
        winnerId: data.winnerId,
        winnerName: winnerName
      });

      // 4. Считаем, сколько Султанов еще живо
      const alivePlayers = room.players.filter(p => p.isAlive !== false);

      // 5. Если остался ТОЛЬКО ОДИН выживший (или ноль) — вот тогда заканчиваем игру
      if (alivePlayers.length <= 1) {
        console.log(`[MATCH OVER] В комнате ${data.roomId} остался 1 выживший!`);
        room.status = 'finished';

        const finalWinner = alivePlayers[0] || winner; // Тот самый последний выживший

        // Рассылаем финальный приказ завершить матч всем
        io.to(data.roomId).emit("game_over_final", {
          winnerId: finalWinner ? finalWinner.id : null,
          winnerName: finalWinner ? finalWinner.name : "Draw"
        });
      }
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
            p.isAlive = true; // <--- ВАЖНО: Воскрешаем всех для нового матча!
          });
          io.to(roomId).emit("rematch_started", room);
        }
      }
    }
  });

  // --- ПОСТРОЙКИ (УСТАНОВКА) ---
  socket.on("building_placed", (buildingData) => {
    const room = rooms[buildingData.roomId];
    if (room) {
      const newBuilding = { 
        ...buildingData, 
        ownerId: socket.id,
        isOpen: false 
      };
      room.buildings.push(newBuilding);
      io.to(buildingData.roomId).emit("remote_building_placed", newBuilding);
    }
  });

  // --- ПОВРЕЖДЕНИЕ ПОСТРОЕК ---
  socket.on("building_hit", (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit("remote_building_hit", data);
    }
  });

  // --- СНОС ПОСТРОЕК ---
  socket.on("building_destroyed", (data) => {
    const room = rooms[data.roomId];
    if (room) {
      room.buildings = room.buildings.filter(b => b.id !== data.buildingId);
      io.to(data.roomId).emit("remote_building_destroyed", data.buildingId);
    }
  });

  // --- ВОРОТА (ОТКРЫТЬ/ЗАКРЫТЬ) ---
  socket.on("toggle_gate", (data) => {
    // data: { roomId, buildingId, isOpen }
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

  // --- БОЕВАЯ СИНХРОНИЗАЦИЯ (ЮНИТЫ И СТРЕЛЬБА) ---
  socket.on("unit_hit", (data) => {
    io.to(data.targetPlayerId).emit("take_unit_damage", data);
  });

  socket.on("tower_fire", (data) => {
    socket.to(data.roomId).emit("remote_tower_fire", data);
  });

  socket.on("player_killed", (victimId) => {
    // Старая функция для совместимости
    io.to(victimId).emit("you_died"); 
    socket.broadcast.emit("remote_player_died", victimId);
  });

  // --- ОТКЛЮЧЕНИЕ ИГРОКА ---
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        
        // Передача хоста, если создатель вышел
        if (room.hostId === socket.id && room.players.length > 0) {
          room.hostId = room.players[0].id;
          room.players[0].isHost = true;
        }

        // Удаление комнаты, если она пуста
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
server.listen(PORT, () => console.log(`--- SULTAN ENGINE v1.7 ONLINE: ${PORT} ---`));
