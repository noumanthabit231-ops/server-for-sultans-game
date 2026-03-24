const uWS = require('uWebSockets.js');
const { TextDecoder } = require('util');

const PORT = Number(process.env.PORT || 3001);
const MAX_GLOBAL_PLAYERS = 1000;
const SYNC_PACKET_HEADER_SIZE = 25;
const SYNC_PACKET_UNIT_COUNT_SENTINEL = 0xffffffff;
const TUNNEL_LIFETIME_MS = 20000;
const TUNNEL_SWEEP_INTERVAL_MS = 1000;
const COMMANDER_MAX_HP = 500;
const COMMANDER_HIT_DAMAGE = 100;

const decoder = new TextDecoder();
const rooms = new Map();
const socketsById = new Map();
const waitingQueue = [];

let activeConnections = 0;

function getDistance(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

function serializeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    password: room.password,
    hostId: room.hostId,
    status: room.status,
    players: room.players,
    buildings: room.buildings,
    tunnels: room.tunnels || [],
    maxPlayers: room.maxPlayers,
    rematchVotes: room.rematchVotes,
    seed: room.seed
  };
}

function send(ws, type, data) {
  ws.send(JSON.stringify(data === undefined ? { type } : { type, data }));
}

function broadcast(server, message) {
  server.publish('global', JSON.stringify(message));
}

function broadcastToRoom(server, roomId, message) {
  server.publish(roomId, JSON.stringify(message));
}

function sendRoomList(server, targetWs = null) {
  const list = Array.from(rooms.values())
    .filter((room) => room.status === 'lobby')
    .map((room) => {
      const roomData = serializeRoom(room);
      roomData.password = !!room.password;
      return roomData;
    });

  if (targetWs) {
    send(targetWs, 'room_list', list);
    return;
  }

  broadcast(server, { type: 'room_list', data: list });
}

function updateServerCapacity(server) {
  broadcast(server, {
    type: 'server_capacity',
    data: { active: activeConnections, max: MAX_GLOBAL_PLAYERS }
  });
}

function removeFromWaitingQueue(ws) {
  const idx = waitingQueue.indexOf(ws);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function refreshQueuePositions() {
  waitingQueue.forEach((queuedWs, index) => {
    send(queuedWs, 'queue_update', { position: index + 1 });
  });
}

function approveNextQueuedClient(server) {
  while (waitingQueue.length > 0 && activeConnections < MAX_GLOBAL_PLAYERS) {
    const nextWs = waitingQueue.shift();
    if (!nextWs || nextWs.closed) continue;

    nextWs.isQueued = false;
    activeConnections++;
    send(nextWs, 'queue_approved');
    send(nextWs, 'server_capacity', { active: activeConnections, max: MAX_GLOBAL_PLAYERS });
    sendRoomList(server, nextWs);
    updateServerCapacity(server);
    refreshQueuePositions();
    return;
  }

  updateServerCapacity(server);
  refreshQueuePositions();
}

function normalizeSplitMode(mode) {
  return mode === 'HUNT' || mode === 'RECALL' ? mode : 'HOLD';
}

function upsertStructure(list, item) {
  const idx = list.findIndex((entry) => entry.id === item.id);
  if (idx === -1) list.push(item);
  else list[idx] = item;
}

function broadcastPlayerState(server, room, player, extraData = {}) {
  if (!room || !player) return;
  const visibleUnitCount = Math.max(0, Number.isFinite(player.unitCount) ? Math.floor(player.unitCount) : 0);

  broadcastToRoom(server, room.id, {
    type: 'remote_update',
    data: {
      ...extraData,
      id: player.id,
      roomId: room.id,
      x: player.x,
      y: player.y,
      hp: player.hp,
      unitCount: visibleUnitCount,
      isUnderground: player.isUnderground,
      faction: player.faction,
      empireId: player.empireId,
      name: player.name
    }
  });
}

function purgePlayerOwnedWorldState(server, room, playerId) {
  if (!room) return;

  const removedBuildingIds = room.buildings
    .filter((building) => building.ownerId === playerId)
    .map((building) => building.id);
  if (removedBuildingIds.length > 0) {
    room.buildings = room.buildings.filter((building) => building.ownerId !== playerId);
    removedBuildingIds.forEach((buildingId) => {
      broadcastToRoom(server, room.id, { type: 'remote_building_destroyed', data: buildingId });
    });
  }

  const removedTunnelIds = (room.tunnels || [])
    .filter((tunnel) => tunnel.ownerId === playerId)
    .map((tunnel) => tunnel.id);
  if (removedTunnelIds.length > 0) {
    room.tunnels = room.tunnels.filter((tunnel) => tunnel.ownerId !== playerId);
    removedTunnelIds.forEach((tunnelId) => {
      broadcastToRoom(server, room.id, { type: 'remote_tunnel_remove', data: { id: tunnelId } });
    });
  }
}

function cleanupSocketState(ws) {
  try {
    ws.unsubscribe('global');
  } catch {}

  if (ws.roomId) {
    try {
      ws.unsubscribe(ws.roomId);
    } catch {}
  }

  ws.roomId = null;
  ws.isQueued = false;
  ws.closed = true;
}

function handleCommanderDeath(server, room, loserId, winnerId = null) {
  if (!room || room.status !== 'active') return;

  const loser = room.players.find((player) => player.id === loserId);
  if (!loser || loser.isAlive === false) return;

  loser.isAlive = false;
  const winner = room.players.find((player) => player.id === winnerId);
  const winnerName = winner ? winner.name : 'Enemy';

  broadcastToRoom(server, room.id, {
    type: 'player_eliminated',
    data: { loserId, winnerId, winnerName }
  });

  const alivePlayers = room.players.filter((player) => player.isAlive !== false);
  if (alivePlayers.length <= 1) {
    room.status = 'finished';
    const finalWinner = alivePlayers[0] || winner || null;
    broadcastToRoom(server, room.id, {
      type: 'game_over_final',
      data: {
        winnerId: finalWinner ? finalWinner.id : null,
        winnerName: finalWinner ? finalWinner.name : 'Draw'
      }
    });
  }
}

function handlePlayerLeaving(server, ws) {
  if (!ws.roomId) return;

  const roomId = ws.roomId;
  const room = rooms.get(roomId);
  if (!room) {
    ws.roomId = null;
    return;
  }

  const playerIndex = room.players.findIndex((player) => player.id === ws.id);
  if (playerIndex !== -1) {
    room.players.splice(playerIndex, 1);
  }

  purgePlayerOwnedWorldState(server, room, ws.id);

  if (room.hostId === ws.id && room.players.length > 0) {
    const nextHost = room.players[0];
    room.hostId = nextHost.id;
    room.players.forEach((player) => {
      player.isHost = player.id === room.hostId;
    });
  }

  if (room.players.length === 0) {
    rooms.delete(roomId);
  } else {
    broadcastToRoom(server, roomId, { type: 'room_update', data: serializeRoom(room) });
  }

  try {
    ws.unsubscribe(roomId);
  } catch {}

  ws.roomId = null;
}

function joinRoomInternal(server, ws, roomId, defaultName, isHost) {
  if (ws.isQueued) return;

  const room = rooms.get(roomId);
  if (!room) return;

  if (ws.roomId && ws.roomId !== roomId) {
    handlePlayerLeaving(server, ws);
  }

  const existingPlayer = room.players.find((player) => player.id === ws.id);
  if (existingPlayer) return;

  ws.subscribe(roomId);
  ws.roomId = roomId;
  const initialIsUnderground = false;

  const player = {
    id: ws.id,
    name: defaultName,
    isHost,
    x: 600,
    y: 600,
    faction: isHost ? 'green' : 'blue',
    votedForRematch: false,
    hp: COMMANDER_MAX_HP,
    isAlive: true,
    isUnderground: initialIsUnderground,
    unitCount: 0,
    empireId: null
  };

  room.players.push(player);

  send(ws, 'join_success', serializeRoom(room));
  broadcastToRoom(server, roomId, { type: 'room_update', data: serializeRoom(room) });
  sendRoomList(server);
}

function decodeBinarySync(message) {
  const arrayBuffer = Buffer.isBuffer(message)
    ? message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength)
    : message;

  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < SYNC_PACKET_HEADER_SIZE) {
    return null;
  }

  const view = new DataView(arrayBuffer);
  const x = view.getFloat32(0, true);
  const y = view.getFloat32(4, true);
  const rotation = view.getFloat32(8, true);
  const hp = view.getFloat32(12, true);
  const unitCount = view.getUint32(16, true);
  const isUnderground = view.getUint8(20) === 1;
  const extraLength = view.getUint32(21, true);

  let extras = {};
  if (extraLength > 0 && arrayBuffer.byteLength >= SYNC_PACKET_HEADER_SIZE + extraLength) {
    const extraBytes = new Uint8Array(arrayBuffer, SYNC_PACKET_HEADER_SIZE, extraLength);
    const extraText = decoder.decode(extraBytes);
    if (extraText) {
      try {
        extras = JSON.parse(extraText);
      } catch {
        extras = {};
      }
    }
  }

  return {
    ...extras,
    x: Number.isFinite(x) ? x : undefined,
    y: Number.isFinite(y) ? y : undefined,
    rotation: Number.isFinite(rotation) ? rotation : undefined,
    hp: Number.isFinite(hp) ? hp : undefined,
    unitCount: unitCount === SYNC_PACKET_UNIT_COUNT_SENTINEL ? undefined : unitCount,
    isUnderground
  };
}

const server = uWS.App();

server.get('/', (res) => {
  res.end(`--- SULTAN ENGINE v1.8.2 ONLINE | PLAYERS: ${activeConnections}/${MAX_GLOBAL_PLAYERS} ---`);
});

server.ws('/*', {
  compression: uWS.SHARED_COMPRESSOR,
  maxPayloadLength: 16 * 1024 * 1024,
  idleTimeout: 60,

  open: (ws) => {
    ws.id = Math.random().toString(36).substring(2, 15);
    ws.roomId = null;
    ws.isQueued = false;
    ws.closed = false;

    socketsById.set(ws.id, ws);
    ws.subscribe('global');

    send(ws, 'set_id', ws.id);
    send(ws, 'server_capacity', { active: activeConnections, max: MAX_GLOBAL_PLAYERS });

    if (activeConnections >= MAX_GLOBAL_PLAYERS) {
      ws.isQueued = true;
      waitingQueue.push(ws);
      send(ws, 'queue_update', { position: waitingQueue.length });
      return;
    }

    activeConnections++;
    send(ws, 'queue_approved');
    updateServerCapacity(server);
    sendRoomList(server, ws);
  },

  message: (ws, message, isBinary) => {
    if (isBinary) {
      const syncData = decodeBinarySync(message);
      if (!syncData) return;

      const roomId = syncData.roomId || ws.roomId;
      if (!roomId) return;

      const room = rooms.get(roomId);
      if (!room) return;

      if (ws.roomId && ws.roomId !== roomId) {
        try {
          ws.unsubscribe(ws.roomId);
        } catch {}
      }

      if (ws.roomId !== roomId) {
        ws.subscribe(roomId);
        ws.roomId = roomId;
      }

      const player = room.players.find((entry) => entry.id === ws.id);
      if (!player) return;

      if (player) {
        if (typeof syncData.x === 'number') player.x = syncData.x;
        if (typeof syncData.y === 'number') player.y = syncData.y;
        player.isUnderground = syncData.isUnderground ?? false;
        if (typeof syncData.name === 'string' && syncData.name.trim()) player.name = syncData.name;
        if (syncData.empireId) player.empireId = syncData.empireId;
        if (syncData.faction) player.faction = syncData.faction;
      }

      broadcastPlayerState(server, room, player, syncData);

      return;
    }

    try {
      const { type, data } = JSON.parse(Buffer.from(message).toString());

      switch (type) {
        case 'get_room_list': {
          sendRoomList(server, ws);
          break;
        }

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
          joinRoomInternal(server, ws, roomId, data.playerName || 'Great Agha', true);
          break;
        }

        case 'join_room': {
          if (ws.isQueued) return;
          const roomId = typeof data === 'string' ? data : data.roomId;
          const password = typeof data === 'string' ? '' : data.password;
          const playerName = data.playerName || `Janissary_${ws.id.substring(0, 3)}`;
          const room = rooms.get(roomId);
          if (!room) return send(ws, 'error', 'Комната не найдена');
          if (room.status !== 'lobby') return send(ws, 'error', 'Битва уже идет!');
          if (room.password && room.password !== password) return send(ws, 'error', 'Неверный пароль!');
          if (room.players.length >= room.maxPlayers) return send(ws, 'error', 'Комната заполнена');
          joinRoomInternal(server, ws, roomId, playerName, false);
          break;
        }

        case 'leave_room': {
          handlePlayerLeaving(server, ws);
          sendRoomList(server);
          break;
        }

        case 'update_player_name': {
          const room = rooms.get(data.roomId);
          if (room) {
            const player = room.players.find((entry) => entry.id === ws.id);
            if (player) {
              player.name = data.name;
              player.empireId = data.empireId;
              broadcastToRoom(server, data.roomId, { type: 'room_update', data: serializeRoom(room) });
            }
          }
          break;
        }

        case 'request_split': {
          const roomId = data.roomId || ws.roomId;
          const room = rooms.get(roomId);
          if (!room) {
            send(ws, 'split_result', { success: false });
            break;
          }

          const player = room.players.find((entry) => entry.id === ws.id);
          if (!player) {
            send(ws, 'split_result', { success: false });
            break;
          }

          const strategy = data.strategy === 'SEPARATE_ALL' ? 'SEPARATE_ALL' : 'HALF';
          const mode = normalizeSplitMode(data.mode);
          const currentUnitCount = Math.max(0, Math.floor(player.unitCount || 0));

          if (strategy === 'SEPARATE_ALL') {
            if (currentUnitCount <= 0) {
              send(ws, 'split_result', { success: false, strategy, mode });
              break;
            }
          } else if (currentUnitCount < 14) {
            send(ws, 'split_result', { success: false, strategy, mode });
            break;
          }

          const splitCount = strategy === 'SEPARATE_ALL'
            ? Math.max(0, currentUnitCount)
            : Math.floor(currentUnitCount / 2);

          if (splitCount <= 0) {
            send(ws, 'split_result', { success: false, strategy, mode });
            break;
          }

          player.unitCount = Math.max(0, currentUnitCount - splitCount);

          send(ws, 'split_result', {
            success: true,
            strategy,
            mode,
            splitCount,
            remainingUnitCount: player.unitCount
          });

          broadcastPlayerState(server, room, player, data);
          break;
        }

        case 'request_tunnels': {
          const room = rooms.get(data.roomId);
          if (room && room.tunnels) {
            send(ws, 'sync_tunnels', { tunnels: room.tunnels });
          }
          break;
        }

        case 'start_match_request': {
          const roomId = typeof data === 'string' ? data : data.roomId;
          const room = rooms.get(roomId);
          if (room && room.hostId === ws.id) {
            room.status = 'active';
            broadcastToRoom(server, roomId, { type: 'match_started', data: serializeRoom(room) });
            sendRoomList(server);
          }
          break;
        }

        case 'start_countdown': {
          if (data.roomId) {
            broadcastToRoom(server, data.roomId, { type: 'start_countdown', data: 5 });
          }
          break;
        }

        case 'host_sync_world': {
          if (data.roomId) {
            const room = rooms.get(data.roomId);
            if (room && room.hostId === ws.id) {
              broadcastToRoom(server, data.roomId, {
                type: 'sync_world',
                data: {
                  neutrals: data.neutrals || []
                }
              });
            }
          }
          break;
        }

        case 'commander_death_detected': {
          const room = rooms.get(data.roomId);
          if (room) handleCommanderDeath(server, room, data.loserId, data.winnerId);
          break;
        }

        case 'remote_hp_sync': {
          const room = rooms.get(data.roomId);
          if (room) {
            const victim = room.players.find((player) => player.id === data.id);
            if (victim) {
              broadcastToRoom(server, data.roomId, {
                type: 'remote_hp_sync',
                data: { id: victim.id, hp: victim.hp }
              });
            }
          }
          break;
        }

        case 'unit_hit': {
          if (data.roomId) {
            const room = rooms.get(data.roomId);
            if (room) {
              const attacker = room.players.find((player) => player.id === data.attackerId);
              const victim = room.players.find((player) => player.id === data.targetPlayerId);

              const sameLayer = attacker && victim
                ? attacker.isUnderground === victim.isUnderground
                : !(victim && victim.isUnderground);
              if (!sameLayer) return;

              let sourcePos = null;
              let maxDist = 350;

              if (data.attackerId === 'tower') {
                const towers = room.buildings.filter((building) => building.ownerId === ws.id && building.type !== 'WALL' && building.type !== 'GATE');
                const nearestTower = towers.find((tower) => getDistance(tower.x, tower.y, victim.x, victim.y) < 850);
                if (nearestTower) {
                  sourcePos = { x: nearestTower.x, y: nearestTower.y };
                  maxDist = 850;
                }
              } else if (attacker) {
                sourcePos = { x: attacker.x, y: attacker.y };
                const armyRadius = (attacker.unitCount || 0) * 0.5 + 150;
                maxDist = armyRadius + 100;
              }

              if (sourcePos && victim) {
                const dist = getDistance(sourcePos.x, sourcePos.y, victim.x, victim.y);
                if (dist > maxDist) return;

                const normalizedUnitCount = Number.isFinite(victim.unitCount) ? Math.max(0, Math.floor(victim.unitCount)) : 0;
                const normalizedHp = Number.isFinite(victim.hp) ? victim.hp : COMMANDER_MAX_HP;

                if (normalizedUnitCount > 0) {
                  victim.unitCount -= 1;
                  victim.hp = normalizedHp;

                  data.currentHp = victim.hp;
                  data.currentUnitCount = victim.unitCount;

                  broadcastPlayerState(server, room, victim, {
                    currentHp: victim.hp,
                    currentUnitCount: victim.unitCount
                  });

                  const targetWs = socketsById.get(data.targetPlayerId);
                  if (targetWs) {
                    send(targetWs, 'take_unit_damage', {
                      ...data,
                      currentHp: victim.hp,
                      currentUnitCount: victim.unitCount,
                      serverMessage: `Тебя ударили, у тебя теперь ${victim.unitCount} воинов и ${victim.hp} здоровья`
                    });
                  }

                  return;
                }

                victim.unitCount = 0;
                victim.hp = Math.max(0, normalizedHp - COMMANDER_HIT_DAMAGE);

                data.currentHp = victim.hp;
                data.currentUnitCount = victim.unitCount;

                broadcastToRoom(server, data.roomId, {
                  type: 'remote_hp_sync',
                  data: { id: victim.id, hp: victim.hp }
                });

                broadcastPlayerState(server, room, victim, {
                  currentHp: victim.hp,
                  currentUnitCount: victim.unitCount
                });

                const targetWs = socketsById.get(data.targetPlayerId);
                if (targetWs) {
                  send(targetWs, 'take_unit_damage', {
                    ...data,
                    currentHp: victim.hp,
                    currentUnitCount: victim.unitCount,
                    serverMessage: `Тебя ударили, у тебя теперь ${victim.unitCount} воинов и ${victim.hp} здоровья`
                  });
                }

                if (victim.hp <= 0 && victim.isAlive !== false) {
                  handleCommanderDeath(server, room, victim.id, data.attackerId);
                }
              }
            }
          }
          break;
        }

        case 'tower_fire': {
          if (data.roomId) {
            broadcastToRoom(server, data.roomId, { type: 'remote_tower_fire', data });
          }
          break;
        }

        case 'attack': {
          if (data.roomId) {
            broadcastToRoom(server, data.roomId, { type: 'attack_event', data: { id: ws.id } });
          }
          break;
        }

        case 'tunnel_update': {
          const room = rooms.get(data.roomId);
          if (room) {
            if (!room.tunnels) room.tunnels = [];
            const newTunnel = { ...data, ownerId: ws.id, createdAt: Date.now() };
            upsertStructure(room.tunnels, newTunnel);
            broadcastToRoom(server, data.roomId, { type: 'remote_tunnel_update', data: newTunnel });
          }
          break;
        }

        case 'tunnel_remove': {
          const room = rooms.get(data.roomId);
          if (room && room.tunnels) {
            room.tunnels = room.tunnels.filter((tunnel) => tunnel.id !== data.id);
            broadcastToRoom(server, data.roomId, { type: 'remote_tunnel_remove', data: { id: data.id } });
          }
          break;
        }

        case 'building_placed': {
          const room = rooms.get(data.roomId);
          if (room) {
            if (data.type === 'tunnel' || data.type === 'pit') {
              if (!room.tunnels) room.tunnels = [];
              const newTunnel = { ...data, ownerId: ws.id, createdAt: Date.now() };
              upsertStructure(room.tunnels, newTunnel);
              broadcastToRoom(server, data.roomId, { type: 'remote_tunnel_update', data: newTunnel });
            } else {
              const newBuilding = {
                ...data,
                ownerId: ws.id,
                isOpen: data.type === 'GATE' || data.type === 'gate' ? !!data.isOpen : false
              };
              upsertStructure(room.buildings, newBuilding);
              broadcastToRoom(server, data.roomId, { type: 'remote_building_placed', data: newBuilding });
            }
          }
          break;
        }

        case 'building_hit': {
          if (data.roomId) {
            const room = rooms.get(data.roomId);
            if (room) {
              const attacker = room.players.find((player) => player.id === data.attackerId);
              if (attacker && attacker.isUnderground) return;
              broadcastToRoom(server, data.roomId, { type: 'remote_building_hit', data });
            }
          }
          break;
        }

        case 'building_destroyed': {
          const room = rooms.get(data.roomId);
          if (room) {
            const initialLen = room.buildings.length;
            room.buildings = room.buildings.filter((building) => building.id !== data.buildingId);
            if (room.buildings.length < initialLen) {
              broadcastToRoom(server, data.roomId, { type: 'remote_building_destroyed', data: data.buildingId });
            } else if (room.tunnels) {
              const tunnelLen = room.tunnels.length;
              room.tunnels = room.tunnels.filter((tunnel) => tunnel.id !== data.buildingId);
              if (room.tunnels.length < tunnelLen) {
                broadcastToRoom(server, data.roomId, { type: 'remote_tunnel_remove', data: { id: data.buildingId } });
              }
            }
          }
          break;
        }

        case 'toggle_gate': {
          const room = rooms.get(data.roomId);
          if (room) {
            const gate = room.buildings.find((building) => building.id === data.buildingId);
            if (gate) {
              gate.isOpen = data.isOpen;
              broadcastToRoom(server, data.roomId, { type: 'remote_gate_toggled', data });
            }
          }
          break;
        }

        case 'garrison_hit': {
          if (data.roomId) {
            broadcastToRoom(server, data.roomId, { type: 'remote_garrison_hit', data });
          }
          break;
        }

        case 'garrison_destroyed': {
          if (data.roomId) {
            broadcastToRoom(server, data.roomId, { type: 'garrison_destroyed', data });
          }
          break;
        }

        case 'vote_rematch': {
          const roomId = typeof data === 'string' ? data : data.roomId;
          const room = rooms.get(roomId);
          if (room) {
            const player = room.players.find((entry) => entry.id === ws.id);
            if (player && !player.votedForRematch) {
              player.votedForRematch = true;
              room.rematchVotes = (room.rematchVotes || 0) + 1;
              broadcastToRoom(server, roomId, {
                type: 'update_rematch_votes',
                data: { votedPlayers: room.rematchVotes, maxPlayers: room.players.length }
              });
              if (room.rematchVotes >= room.players.length) {
                room.rematchVotes = 0;
                room.status = 'lobby';
                room.buildings = [];
                room.tunnels = [];
                room.players.forEach((entry) => {
                  entry.votedForRematch = false;
                  entry.hp = COMMANDER_MAX_HP;
                  entry.isAlive = true;
                });
                broadcastToRoom(server, roomId, { type: 'rematch_started', data: serializeRoom(room) });
                sendRoomList(server);
              }
            }
          }
          break;
        }

        case 'village_spawned': {
          if (data.roomId) {
            broadcastToRoom(server, data.roomId, { type: 'village_spawned', data });
          }
          break;
        }
      }
    } catch (error) {
      console.error('JSON Parse error', error);
    }
  },

  close: (ws) => {
    socketsById.delete(ws.id);
    removeFromWaitingQueue(ws);

    if (ws.isQueued) {
      cleanupSocketState(ws);
      refreshQueuePositions();
      updateServerCapacity(server);
      return;
    }

    if (activeConnections > 0) {
      activeConnections--;
    }

    handlePlayerLeaving(server, ws);
    cleanupSocketState(ws);
    sendRoomList(server);
    approveNextQueuedClient(server);
  }
});

setInterval(() => {
  const now = Date.now();

  rooms.forEach((room) => {
    if (!room.tunnels || room.tunnels.length === 0) return;

    const expiredTunnelIds = room.tunnels
      .filter((tunnel) => now - (tunnel.createdAt || now) > TUNNEL_LIFETIME_MS)
      .map((tunnel) => tunnel.id);

    if (expiredTunnelIds.length === 0) return;

    room.tunnels = room.tunnels.filter((tunnel) => !expiredTunnelIds.includes(tunnel.id));
    expiredTunnelIds.forEach((tunnelId) => {
      broadcastToRoom(server, room.id, {
        type: 'remote_tunnel_remove',
        data: { id: tunnelId }
      });
    });
  });
}, TUNNEL_SWEEP_INTERVAL_MS);

server.listen('0.0.0.0', PORT, (token) => {
  if (token) {
    console.log(`--- SERVER IS LIVE ON PORT ${PORT} ---`);
  } else {
    console.log(`Failed to listen on port ${PORT}`);
  }
});
