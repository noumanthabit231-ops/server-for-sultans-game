const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 30000, // Увеличенный таймаут для стабильности на мобильных сетях
  pingInterval: 10000,
  transports: ['websocket', 'polling'] // Поддержка всех типов соединений
});

// Глобальное состояние сервера
const rooms = {};

app.get("/", (req, res) => res.send("Sultan Server Engine v1.0 - Operational"));

io.on("connection", (socket) => {
  console.log(`[CONNECT] New Agha: ${socket.id}`);

  // При входе сразу отдаем список доступных лобби
  socket.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));

  // --- СОЗДАНИЕ КОМНАТЫ (AMONG US STYLE) ---
  socket.on("create_room", (data) => {
    // Генерируем короткий код комнаты (4-5 символов)
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    
    rooms[roomId] = {
      id: roomId,
      name: data.name || `Sultan_${roomId}`,
      hostId: socket.id,
      status: 'lobby', // lobby -> starting -> active
      players: [{
        id: socket.id,
        name: data.playerName || "Great Agha",
        isHost: true,
        x: 600, y: 600 // Начальная точка в дворике
      }],
      maxPlayers: Number(data.limit) || 10
    };

    socket.join(roomId);
    socket.emit("join_success", rooms[roomId]);
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
    console.log(`[ROOM CREATED] ${roomId} by ${socket.id}`);
  });

  // --- ВХОД В КОМНАТУ ---
  socket.on("join_room", (roomId) => {
    const room = rooms[roomId];

    if (!room) return socket.emit("error", "Казарма не найдена!");
    if (room.status !== 'lobby') return socket.emit("error", "Битва уже идет!");
    if (room.players.length >= room.maxPlayers) return socket.emit("error", "Армия переполнена!");

    socket.join(roomId);
    
    const newPlayer = {
      id: socket.id,
      name: `Janissary_${socket.id.substring(0, 3)}`,
      isHost: false,
      x: 600, y: 600
    };

    room.players.push(newPlayer);

    // Уведомляем всех, включая вошедшего, полным объектом комнаты
    socket.emit("join_success", room);
    io.to(roomId).emit("room_update", room);
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  });

  // --- СИНХРОНИЗАЦИЯ В ЛОББИ И БОЮ ---
  socket.on("sync_data", (data) => {
    if (data.roomId) {
      // Трансляция данных всем остальным в комнате
      socket.to(data.roomId).emit("remote_update", {
        id: socket.id,
        ...data
      });
    }
  });

  // --- СТАРТ ИГРЫ (ТОЛЬКО ХОСТ) ---
  socket.on("start_match_request", (roomId) => {
    const room = rooms[roomId];
    if (room && room.hostId === socket.id) {
      room.status = 'starting';
      io.to(roomId).emit("start_countdown", 5);
      io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
    }
  });

  // --- ОБРАБОТКА ВЫХОДА (Host Migration) ---
  socket.on("disconnect", (reason) => {
    console.log(`[DISCONNECT] ${socket.id}. Reason: ${reason}`);
    
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);

      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);

        // Если вышел хост, назначаем следующего
        if (room.hostId === socket.id && room.players.length > 0) {
          room.hostId = room.players[0].id;
          room.players[0].isHost = true;
          console.log(`[HOST MIGRATED] New host in ${roomId}: ${room.hostId}`);
        }

        // Если комната пуста — удаляем
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
