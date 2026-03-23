// ========================================================= 
// SULTAN ENGINE v1.8.2 - HIGH PERFORMANCE uWS + BINARY
// ========================================================= 
const uWS = require('uWebSockets.js');
const express = require("express"); 

const app = express(); 
const PORT = process.env.PORT || 3001; 

// ГЛОБАЛЬНЫЕ ЛИМИТЫ 
const MAX_GLOBAL_PLAYERS = 1000; 
let activeConnections = 0; 
const waitingQueue = []; 

// Хранилище комнат и игроков через Map() для мгновенного поиска
const rooms = new Map(); 

app.get("/", (req, res) => res.send(`--- SULTAN ENGINE v1.8.2 ONLINE | PLAYERS: ${activeConnections}/${MAX_GLOBAL_PLAYERS} ---`)); 

// Вспомогательная функция для логики выхода игрока из комнаты 
function handlePlayerLeaving(ws) { 
  if (!ws.roomId) return;
  const room = rooms.get(ws.roomId); 
  if (!room) return; 

  const playerIndex = room.players.findIndex(p => p.id === ws.id); 
  if (playerIndex !== -1) { 
    console.log(`[ROOM] Игрок ${ws.id} покинул комнату ${ws.roomId}`); 
    room.players.splice(playerIndex, 1); 
    
    // Если вышедший был хостом и в комнате еще есть люди 
    if (room.hostId === ws.id && room.players.length > 0) { 
      const newHost = room.players[0]; 
      room.hostId = newHost.id; 
      newHost.isHost = true; 
      console.log(`[HOST] Новое лидерство в ${ws.roomId} передано ${newHost.id}`); 
    } 

    // Если в комнате никого не осталось — удаляем её 
    if (room.players.length === 0) { 
      console.log(`[ROOM] Комната ${ws.roomId} пуста и будет удалена.`); 
      rooms.delete(ws.roomId); 
    } else { 
      // Иначе уведомляем оставшихся об изменениях 
      broadcastToRoom(ws.roomId, { type: "room_update", data: room }); 
    } 
  } 
} 

function broadcast(message) {
  const data = JSON.stringify(message);
  server.publish('global', data);
}

function broadcastToRoom(roomId, message, excludeWs = null) {
  const data = JSON.stringify(message);
  if (excludeWs) {
    excludeWs.publish(roomId, data);
  } else {
    server.publish(roomId, data);
  }
}

function sendRoomList(ws = null) { 
  const list = Array.from(rooms.values()) 
    .filter(r => r.status === 'lobby') 
    .map(r => { 
      const { password, ...publicData } = r; 
      return { 
        ...publicData, 
        password: !!password 
      }; 
    }); 
  const msg = JSON.stringify({ type: "room_list", data: list });
  if (ws) {
    ws.send(msg);
  } else {
    server.publish('global', msg);
  }
} 

const server = uWS.App().ws('/*', {
  compression: uWS.SHARED_COMPRESSOR,
  maxPayloadLength: 16 * 1024 * 1024,
  idleTimeout: 60,

  open: (ws) => {
    ws.id = Math.random().toString(36).substring(2, 15);
    ws.subscribe('global');
    
    // Передаем ID клиенту
    ws.send(JSON.stringify({ type: 'set_id', data: ws.id }));
    
    ws.send(JSON.stringify({ 
      type: "server_capacity", 
      data: { active: activeConnections, max: MAX_GLOBAL_PLAYERS } 
    }));

    if (activeConnections >= MAX_GLOBAL_PLAYERS) { 
      waitingQueue.push(ws); 
      ws.isQueued = true; 
      ws.send(JSON.stringify({ type: "queue_update", data: { position: waitingQueue.length } })); 
    } else { 
      activeConnections++; 
      ws.isQueued = false; 
      ws.send(JSON.stringify({ type: "queue_approved" })); 
      broadcast({ type: "server_capacity", data: { active: activeConnections, max: MAX_GLOBAL_PLAYERS } }); 
      sendRoomList(ws); 
    }
  },

  message: (ws, message, isBinary) => {
    // ВЫСОКОЧАСТОТНЫЕ ДАННЫЕ (БИНАРНЫЕ)
    if (isBinary) {
      if (ws.roomId) {
        // Просто перекидываем байты в комнату без парсинга (БЕЗУМНАЯ СКОРОСТЬ)
        ws.publish(ws.roomId, message, true);
      }
      return;
    }

    // РЕДКИЕ СОБЫТИЯ (JSON)
    try {
      const { type, data } = JSON.parse(Buffer.from(message).toString());
      
      switch (type) {
        case 'create_room': {
          if (ws.isQueued) return;
          const roomId = Math.random().toString(36).substring(2, 7).toUpperCase(); 
          const room = { 
            id: roomId, 
            name: data.name || `Sultan_${roomId}`, 
            password: data.password || '', 
            hostId: ws.id, 
            status: 'lobby', 
            players: [], 
            buildings: [], 
            tunnels: [], 
            maxPlayers: Number(data.limit) || 10, 
            rematchVotes: 0, 
            seed: Math.random() 
          };
          rooms.set(roomId, room);
          joinRoomInternal(ws, roomId, data.playerName || "Great Agha", true);
          break;
        }

        case 'join_room': {
          if (ws.isQueued) return;
          const roomId = typeof data === 'string' ? data : data.roomId; 
          const password = typeof data === 'string' ? '' : data.password; 
          const playerName = data.playerName || `Janissary_${ws.id.substring(0, 3)}`; 

          const room = rooms.get(roomId); 
          if (!room) return ws.send(JSON.stringify({ type: "error", data: "Комната не найдена" })); 
          if (room.status !== 'lobby') return ws.send(JSON.stringify({ type: "error", data: "Битва уже идет!" })); 
          if (room.password && room.password !== password) return ws.send(JSON.stringify({ type: "error", data: "Неверный пароль!" })); 

          joinRoomInternal(ws, roomId, playerName, false); 
          break;
        }

        case 'leave_room': {
          handlePlayerLeaving(ws);
          if (ws.roomId) ws.unsubscribe(ws.roomId);
          ws.roomId = null;
          sendRoomList();
          break;
        }

        case 'update_player_name': {
          const room = rooms.get(data.roomId);
          if (room) {
            const p = room.players.find(player => player.id === ws.id);
            if (p) {
              p.name = data.name;
              p.empireId = data.empireId;
              broadcastToRoom(data.roomId, { type: "room_update", data: room });
            }
          }
          break;
        }

        case 'start_match_request': {
          const room = rooms.get(data);
          if (room && room.hostId === ws.id) {
            room.status = 'active';
            broadcastToRoom(data, { type: "match_started", data: room });
            sendRoomList();
          }
          break;
        }

        // --- БОЕВКА И СМЕРТИ ---
        case 'commander_death_detected': {
          const room = rooms.get(data.roomId);
          if (room && room.status === 'active') {
            const loser = room.players.find(p => p.id === data.loserId);
            if (loser) loser.isAlive = false;
            const winner = room.players.find(p => p.id === data.winnerId);
            const winnerName = winner ? winner.name : "Enemy";

            broadcastToRoom(data.roomId, { 
              type: "player_eliminated", 
              data: { loserId: data.loserId, winnerId: data.winnerId, winnerName: winnerName } 
            });

            const alivePlayers = room.players.filter(p => p.isAlive !== false);
            if (alivePlayers.length <= 1) {
              room.status = 'finished';
              const finalWinner = alivePlayers[0] || winner;
              broadcastToRoom(data.roomId, { 
                type: "game_over_final", 
                data: { winnerId: finalWinner ? finalWinner.id : null, winnerName: finalWinner ? finalWinner.name : "Draw" } 
              });
            }
          }
          break;
        }

        case 'unit_hit': {
          if (data.roomId) broadcastToRoom(data.roomId, { type: "take_unit_damage", data });
          break;
        }

        case 'tower_fire': {
          if (data.roomId) ws.publish(data.roomId, JSON.stringify({ type: "remote_tower_fire", data }));
          break;
        }

        case 'attack': {
           if (data.roomId) ws.publish(data.roomId, JSON.stringify({ type: "attack_event", data: { id: ws.id } }));
           break;
        }

        // --- ТУННЕЛИ ---
        case 'tunnel_update': {
          const room = rooms.get(data.roomId);
          if (room) {
            if (!room.tunnels) room.tunnels = [];
            const newTunnel = { ...data, ownerId: ws.id };
            const idx = room.tunnels.findIndex(t => t.id === data.id);
            if (idx !== -1) room.tunnels[idx] = newTunnel;
            else room.tunnels.push(newTunnel);
            ws.publish(data.roomId, JSON.stringify({ type: "remote_tunnel_update", data: newTunnel }));
          }
          break;
        }

        case 'tunnel_remove': {
          const room = rooms.get(data.roomId);
          if (room && room.tunnels) {
            room.tunnels = room.tunnels.filter(t => t.id !== data.id);
            ws.publish(data.roomId, JSON.stringify({ type: "remote_tunnel_remove", data: { id: data.id } }));
          }
          break;
        }

        case 'request_tunnels': {
          const room = rooms.get(data.roomId);
          if (room && room.tunnels) {
            ws.send(JSON.stringify({ type: "sync_tunnels", data: { tunnels: room.tunnels } }));
          }
          break;
        }

        // --- ПОСТРОЙКИ ---
        case 'building_placed': {
          const room = rooms.get(data.roomId);
          if (room) {
            const newBuilding = { ...data, ownerId: ws.id, isOpen: false };
            room.buildings.push(newBuilding);
            broadcastToRoom(data.roomId, { type: "remote_building_placed", data: newBuilding });
          }
          break;
        }

        case 'building_hit': {
          if (data.roomId) ws.publish(data.roomId, JSON.stringify({ type: "remote_building_hit", data }));
          break;
        }

        case 'building_destroyed': {
          const room = rooms.get(data.roomId);
          if (room) {
            room.buildings = room.buildings.filter(b => b.id !== data.buildingId);
            broadcastToRoom(data.roomId, { type: "remote_building_destroyed", data: data.buildingId });
          }
          break;
        }

        case 'toggle_gate': {
          const room = rooms.get(data.roomId);
          if (room) {
            const gate = room.buildings.find(b => b.id === data.buildingId);
            if (gate) { gate.isOpen = data.isOpen; broadcastToRoom(data.roomId, { type: "remote_gate_toggled", data }); }
          }
          break;
        }

        case 'garrison_hit': {
          if (data.roomId) broadcastToRoom(data.roomId, { type: "remote_garrison_hit", data });
          break;
        }

        case 'garrison_destroyed': {
          if (data.roomId) broadcastToRoom(data.roomId, { type: "garrison_destroyed", data });
          break;
        }

        // --- РЕМАТЧ ---
        case 'vote_rematch': {
          const room = rooms.get(data);
          if (room) {
            const player = room.players.find(p => p.id === ws.id);
            if (player && !player.votedForRematch) {
              player.votedForRematch = true;
              room.rematchVotes = (room.rematchVotes || 0) + 1;
              broadcastToRoom(data, { 
                type: "update_rematch_votes", 
                data: { votedPlayers: room.rematchVotes, maxPlayers: room.players.length } 
              });

              if (room.rematchVotes >= room.players.length) {
                room.rematchVotes = 0; room.status = 'lobby'; room.buildings = []; room.tunnels = [];
                room.players.forEach(p => { p.votedForRematch = false; p.hp = 100; p.isAlive = true; });
                broadcastToRoom(data, { type: "rematch_started", data: room });
                sendRoomList();
              }
            }
          }
          break;
        }
      }
    } catch (e) {
      console.error("JSON Parse error", e);
    }
  },

  close: (ws) => {
    if (ws.isQueued) { 
      const idx = waitingQueue.indexOf(ws); 
      if (idx !== -1) waitingQueue.splice(idx, 1); 
      waitingQueue.forEach((sq, i) => sq.send(JSON.stringify({ type: "queue_update", data: { position: i + 1 } }))); 
    } else { 
      activeConnections--; 
      if (waitingQueue.length > 0) { 
        const nextWs = waitingQueue.shift(); 
        nextWs.isQueued = false; 
        activeConnections++; 
        nextWs.send(JSON.stringify({ type: "queue_approved" })); 
        sendRoomList(); 
        waitingQueue.forEach((sq, i) => sq.send(JSON.stringify({ type: "queue_update", data: { position: i + 1 } }))); 
      } 
      broadcast({ type: "server_capacity", data: { active: activeConnections, max: MAX_GLOBAL_PLAYERS } }); 
    } 

    handlePlayerLeaving(ws);
    sendRoomList(); 
  }
}).listen(PORT, (token) => {
  if (token) {
    console.log(`--- SULTAN ENGINE v1.8.2 (uWS+BINARY) ONLINE: ${PORT} ---`);
  } else {
    console.log(`Failed to listen on port ${PORT}`);
  }
});

function joinRoomInternal(ws, roomId, defaultName, isHost) { 
  if (ws.isQueued) return; 
  const room = rooms.get(roomId); 
  if (!room) return; 

  ws.subscribe(roomId);
  ws.roomId = roomId;
  // Короткий ID для бинарной синхронизации (1 байт, до 255 игроков)
  ws.shortId = (room.players.length + 1) % 255; 

  const player = { 
    id: ws.id, 
    shortId: ws.shortId,
    name: defaultName, isHost: isHost, 
    x: 600, y: 600, faction: isHost ? 'green' : 'blue', 
    votedForRematch: false, hp: 100, isAlive: true 
  }; 
  room.players.push(player); 
  
  ws.send(JSON.stringify({ type: "join_success", data: room })); 
  broadcastToRoom(roomId, { type: "room_update", data: room }); 
  sendRoomList(); 
}

// Express для статики (Railway требует один порт, но для локальной отладки или проксирования полезно)
app.listen(Number(PORT) + 1, () => console.log(`Express backup on ${Number(PORT) + 1}`));
