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

// Вспомогательная функция для распаковки бинарных данных (25 байт)
function unpackSyncData(message) {
  // message в uWS — это ArrayBuffer, в Node.js работаем через Buffer
  try {
    const view = Buffer.from(message);
    return {
      shortId: view.readUInt32LE(0),
      x: view.readFloatLE(4),
      y: view.readFloatLE(8),
      rotation: view.readFloatLE(12),
      hp: view.readFloatLE(16),
      unitCount: view.readUInt32LE(20),
      isUnderground: view.readUInt8(24) === 1 // БИТ ПОДЗЕМЕЛЬЯ
    };
  } catch (e) {
    console.error("Error unpacking sync data", e);
    return { shortId: 0, x: 0, y: 0, rotation: 0, hp: 0, unitCount: 0, isUnderground: false };
  }
}

// Вынос логики смерти в отдельную функцию для Authority
function handleCommanderDeath(room, loserId, winnerId = null) {
  if (room.status !== 'active') return;
  
  const loser = room.players.find(p => p.id === loserId);
  if (!loser || loser.isAlive === false) return;
  
  loser.isAlive = false;
  const winner = room.players.find(p => p.id === winnerId);
  const winnerName = winner ? winner.name : "Enemy";

  broadcastToRoom(room.id, { 
    type: "player_eliminated", 
    data: { loserId: loserId, winnerId: winnerId, winnerName: winnerName } 
  });

  const alivePlayers = room.players.filter(p => p.isAlive !== false);
  if (alivePlayers.length <= 1) {
    room.status = 'finished';
    const finalWinner = alivePlayers[0] || winner;
    broadcastToRoom(room.id, { 
      type: "game_over_final", 
      data: { winnerId: finalWinner ? finalWinner.id : null, winnerName: finalWinner ? finalWinner.name : "Draw" } 
    });
  }
}

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

try {
  uWS.App().ws('/*', {
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
          // TOTAL BINARY BROADCAST: Мгновенная пересылка байтов всем в комнате (uWS mode)
          ws.publish(ws.roomId, message, true);

          // РАСПАКОВКА И ОБНОВЛЕНИЕ ПАМЯТИ СЕРВЕРА (Арбитраж)
          const room = rooms.get(ws.roomId);
          if (room) {
            const syncData = unpackSyncData(message);
            const p = room.players.find(player => player.shortId === syncData.shortId);
            if (p) {
              p.x = syncData.x;
              p.y = syncData.y;
              p.hp = syncData.hp;
              p.unitCount = syncData.unitCount;
              p.isUnderground = syncData.isUnderground; // ОБНОВЛЯЕМ СОСТОЯНИЕ В ПАМЯТИ

              // SERVER AUTHORITY: Смерть при достижении 0 юнитов
              if (p.unitCount === 0 && p.isAlive !== false && room.status === 'active') {
                 handleCommanderDeath(room, p.id);
              }
            }
          }
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

          // --- БОЕВКА И СМЕРТИ (Арбитраж) ---
          case 'commander_death_detected': {
            const room = rooms.get(data.roomId);
            if (room) handleCommanderDeath(room, data.loserId, data.winnerId);
            break;
          }

          case 'unit_hit': {
            if (data.roomId) {
              const room = rooms.get(data.roomId);
              if (room) {
                const attacker = room.players.find(p => p.id === data.attackerId);
                const victim = room.players.find(p => p.id === data.targetPlayerId);
                
                // NEW: Изоляция урона - подземные игроки неуязвимы и не могут атаковать
                if (victim && victim.isUnderground) {
                  return console.log(`[COMBAT ARBITER] Hit blocked: victim ${victim.id} is underground`);
                }
                if (attacker && attacker.isUnderground) {
                  return console.log(`[COMBAT ARBITER] Hit blocked: attacker ${attacker.id} is underground`);
                }

                let sourcePos = null;
                let maxDist = 350; // Базовое расстояние для меча

                // Если атака от башни
                if (data.attackerId === 'tower') {
                   // В данных башни ищем ту, что ближе всего к месту удара (или по ID если добавим)
                   // Для простоты берем любую башню атакующего в радиусе поражения
                   const towers = room.buildings.filter(b => b.ownerId === ws.id && b.type !== 'WALL' && b.type !== 'GATE');
                   const nearestTower = towers.find(t => {
                      const d = Math.sqrt((t.x - victim.x)**2 + (t.y - victim.y)**2);
                      return d < 850; // Радиус башни + запас
                   });
                   if (nearestTower) {
                      sourcePos = { x: nearestTower.x, y: nearestTower.y };
                      maxDist = 850;
                   }
                } else if (attacker) {
                   sourcePos = { x: attacker.x, y: attacker.y };
                   // Учитываем радиус армии (Кнопка C)
                   const armyRadius = (attacker.unitCount || 0) * 0.5 + 150;
                   maxDist = armyRadius + 100; 
                }

                if (sourcePos && victim) {
                  // ПОДЗЕМЕЛЬЕ: Игнорируем урон, если цель под землей
                  if (victim.isUnderground) {
                    return console.log(`[COMBAT ARBITER] Hit blocked: victim ${victim.id} is underground`);
                  }

                  const dist = Math.sqrt((sourcePos.x - victim.x)**2 + (sourcePos.y - victim.y)**2);
                  if (dist > maxDist) return console.log(`[COMBAT ARBITER] Hit blocked: distance ${Math.floor(dist)} > ${maxDist}`);
                  
                  // ОБНОВЛЕНИЕ HP В ПАМЯТИ СЕРВЕРА
                  victim.hp = Math.max(0, (victim.hp || 100) - (data.damage || 1));
                  data.currentHp = victim.hp; // Добавляем актуальное HP в пакет для рассылки
                  
                  if (victim.hp <= 0 && victim.isAlive !== false) {
                     handleCommanderDeath(room, victim.id, data.attackerId);
                  }
                }
              }
              broadcastToRoom(data.roomId, { type: "take_unit_damage", data });
            }
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

          // --- ПОСТРОЙКИ И ЯМЫ ---
          case 'building_placed': {
            const room = rooms.get(data.roomId);
            if (room) {
              if (data.type === 'tunnel' || data.type === 'pit') {
                 if (!room.tunnels) room.tunnels = [];
                 const newTunnel = { ...data, ownerId: ws.id };
                 room.tunnels.push(newTunnel);
                 broadcastToRoom(data.roomId, { type: "remote_tunnel_update", data: newTunnel });
              } else {
                 const newBuilding = { ...data, ownerId: ws.id, isOpen: false };
                 room.buildings.push(newBuilding);
                 broadcastToRoom(data.roomId, { type: "remote_building_placed", data: newBuilding });
              }
            }
            break;
          }

          case 'building_hit': {
            if (data.roomId) {
              const room = rooms.get(data.roomId);
              if (room) {
                const attacker = room.players.find(p => p.id === data.attackerId);
                if (attacker && attacker.isUnderground) {
                  return console.log(`[COMBAT ARBITER] Building hit blocked: attacker ${attacker.id} is underground`);
                }
                ws.publish(data.roomId, JSON.stringify({ type: "remote_building_hit", data }));
              }
            }
            break;
          }

          case 'building_destroyed': {
            const room = rooms.get(data.roomId);
            if (room) {
              // Сначала ищем в постройках
              const initialLen = room.buildings.length;
              room.buildings = room.buildings.filter(b => b.id !== data.buildingId);
              
              if (room.buildings.length < initialLen) {
                 broadcastToRoom(data.roomId, { type: "remote_building_destroyed", data: data.buildingId });
              } else {
                 // Если не нашли в постройках, ищем в туннелях (ямах)
                 if (room.tunnels) {
                   const tLen = room.tunnels.length;
                   room.tunnels = room.tunnels.filter(t => t.id !== data.buildingId);
                   if (room.tunnels.length < tLen) {
                     broadcastToRoom(data.roomId, { type: "remote_tunnel_remove", data: { id: data.buildingId } });
                   }
                 }
              }
            }
            break;
          }

          case 'hide_pit': {
            const room = rooms.get(data.roomId);
            if (room && room.tunnels) {
              room.tunnels = room.tunnels.filter(t => t.id !== data.id);
              // BROADCAST PIT REMOVAL TO ALL
              broadcastToRoom(data.roomId, { type: "pit_removed", data: { id: data.id } });
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
  }).listen('0.0.0.0', Number(PORT), (token) => {
    if (token) {
      console.log(`--- SULTAN ENGINE v1.8.2 (uWS+BINARY) ONLINE: ${PORT} ---`);
      console.log(`--- SERVER IS LIVE ON PORT ${PORT} ---`);
    } else {
      console.log(`Failed to listen on port ${PORT}`);
    }
  });
} catch (err) {
  console.error("FATAL ERROR DURING STARTUP:", err);
}

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
    votedForRematch: false, hp: 100, isAlive: true,
    isUnderground: false // ИНИЦИАЛИЗАЦИЯ
  }; 
  room.players.push(player); 
  
  ws.send(JSON.stringify({ type: "join_success", data: room })); 
  broadcastToRoom(roomId, { type: "room_update", data: room }); 
  sendRoomList(); 
}

// Express для статики (Railway требует один порт, но для локальной отладки или проксирования полезно)
app.listen(Number(PORT) + 1, () => console.log(`Express backup on ${Number(PORT) + 1}`));
