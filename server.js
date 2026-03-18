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
  socket.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));

  socket.on("create_room", (data) => {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[roomId] = {
      id: roomId,
      name: data.name || `Sultan_${roomId}`,
      hostId: socket.id,
      status: 'lobby',
      players: [{ id: socket.id, name: "Great Agha", isHost: true, x: 600, y: 600 }],
      maxPlayers: Number(data.limit) || 10
    };

    socket.join(roomId);
    socket.emit("join_success", rooms[roomId]);
    io.to(roomId).emit("room_update", rooms[roomId]); // Отправляем ВСЕМУ лобби
    io.emit("room_list", Object.values(rooms).filter(r => r.status === 'lobby'));
  });

  socket.on("join_room", (roomId) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", "Комната не найдена");
    if (room.status !== 'lobby') return socket.emit("error", "Битва уже идет!");

    socket.join(roomId);
    const exists = room.players.find(p => p.id === socket.id);
    if (!exists) {
      room.players.push({ id: socket.id, name: `Janissary_${socket.id.substring(0, 3)}`, isHost: false, x: 600, y: 600 });
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
    }
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
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`--- SULTAN ENGINE ONLINE: ${PORT} ---`));
