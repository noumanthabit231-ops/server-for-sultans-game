const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Разрешаем подключения с любых доменов
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000, // Даем игрокам минуту на "лаги"
  pingInterval: 10000
});

// Хранилище комнат
let rooms = {};

// Базовый роут для проверки (чтобы Railway не ругался)
app.get("/", (req, res) => {
  res.send("Sultan's Server is Running...");
});

io.on("connection", (socket) => {
  console.log(`+++ Султан прибыл: ${socket.id}`);

  // Сразу шлем список доступных комнат (только те, что в ожидании)
  socket.emit("room_list", Object.values(rooms).filter(r => r.status === 'waiting'));

  // --- СОЗДАНИЕ КОМНАТЫ ---
  socket.on("create_room", (data) => {
    if (Object.keys(rooms).length >= 20) {
      return socket.emit("error", "Все казармы заняты (лимит 20 комнат)");
    }

    const roomId = `room_${Math.random().toString(36).substr(2, 5)}`;
    
    rooms[roomId] = {
      id: roomId,
      name: data.name || `Battle of ${socket.id.substr(0, 4)}`,
      hostId: socket.id, // Кто создал, тот и главный
      players: [{
        id: socket.id,
        name: data.playerName || "Great Agha",
        isHost: true
      }],
      maxPlayers: Number(data.limit) || 10,
      status: 'waiting' // 'waiting' или 'active'
    };

    socket.join(roomId);
    socket.emit("join_success", rooms[roomId]);
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'waiting'));
    console.log(`>>> Создана комната ${roomId} (Хост: ${socket.id})`);
  });

  // --- ВХОД В КОМНАТУ ---
  socket.on("join_room", (rawId) => {
    const roomId = typeof rawId === 'object' ? rawId.id : rawId;
    const room = rooms[roomId];

    if (!room) return socket.emit("error", "Комната не найдена");
    if (room.status !== 'waiting') return socket.emit("error", "Битва уже началась!");
    if (room.players.length >= room.maxPlayers) return socket.emit("error", "В этой армии нет мест");

    socket.join(roomId);
    
    const newPlayer = {
      id: socket.id,
      name: `Janissary #${room.players.length + 1}`,
      isHost: false
    };

    room.players.push(newPlayer);

    // Подтверждаем вход лично игроку
    socket.emit("join_success", room);
    // Уведомляем всех в комнате об обновлении списка игроков
    io.to(roomId).emit("room_update", room);
    // Обновляем список комнат в меню для всех остальных
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'waiting'));
    
    console.log(`>>> Игрок ${socket.id} вошел в ${roomId}`);
  });

  // --- ЗАПРОС НА СТАРТ (Только от Хоста) ---
  socket.on("start_match_request", (roomId) => {
    const room = rooms[roomId];
    if (room && room.hostId === socket.id) {
      if (room.players.length >= 2) { // Минимум 2 игрока для старта
        room.status = 'active'; // Комната исчезает из списка поиска
        io.to(roomId).emit("start_countdown", 5);
        io.emit("room_list", Object.values(rooms).filter(r => r.status === 'waiting'));
        console.log(`!!! СТАРТ БИТВЫ в ${roomId} !!!`);
      } else {
        socket.emit("error", "Нужен хотя бы еще один противник!");
      }
    }
  });

  // --- СИНХРОНИЗАЦИЯ ДАННЫХ В БОЮ ---
  socket.on("sync_data", (data) => {
    // Рассылаем координаты всем в комнате, КРОМЕ отправителя
    if (data.roomId) {
      socket.to(data.roomId).emit("remote_update", {
        id: socket.id,
        ...data
      });
    }
  });

  // --- ОБРАБОТКА ВЫХОДА (Самое важное!) ---
  socket.on("disconnect", () => {
    console.log(`--- Султан покинул нас: ${socket.id}`);
    
    for (let roomId in rooms) {
      let room = rooms[roomId];
      let playerIndex = room.players.findIndex(p => p.id === socket.id);

      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);

        // Если вышел Хост, но в комнате остались люди — передаем власть
        if (room.hostId === socket.id && room.players.length > 0) {
          room.hostId = room.players[0].id;
          room.players[0].isHost = true;
          console.log(`*** Новая власть в ${roomId}: ${room.hostId}`);
        }

        // Если в комнате никого не осталось — удаляем её
        if (room.players.length === 0) {
          console.log(`XXX Комната ${roomId} удалена`);
          delete rooms[roomId];
        } else {
          // Иначе уведомляем выживших об изменениях
          io.to(roomId).emit("room_update", room);
        }
      }
    }
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'waiting'));
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n===================================`);
  console.log(`SULTAN SERVER ONLINE ON PORT ${PORT}`);
  console.log(`===================================\n`);
});
