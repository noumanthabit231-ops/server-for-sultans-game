const uWS = require('uWebSockets.js');
const { TextDecoder } = require('util');

const PORT = Number(process.env.PORT || 3001);
const MAX_GLOBAL_PLAYERS = 1000;
const SYNC_PACKET_HEADER_SIZE = 25;
const SYNC_PACKET_UNIT_COUNT_SENTINEL = 0xffffffff;

let activeConnections = 0;

const rooms = {};
const clients = new Map();
const waitingQueue = [];
const decoder = new TextDecoder();

const makeId = () => Math.random().toString(36).slice(2, 12);
const makeRoomId = () => Math.random().toString(36).slice(2, 7).toUpperCase();

const send = (ws, type, data) => {
  try {
    ws.send(JSON.stringify(data === undefined ? { type } : { type, data }));
  } catch {}
};

const serializeRoom = (room) => ({
  id: room.id,
  name: room.name,
  password: room.password,
  hostId: room.hostId,
  status: room.status,
  players: room.players,
  buildings: room.buildings,
  maxPlayers: room.maxPlayers,
  rematchVotes: room.rematchVotes,
  seed: room.seed,
  tunnels: room.tunnels || []
});

const serializeRoomList = () =>
  Object.values(rooms)
    .filter((room) => room.status === 'lobby')
    .map((room) => {
      const publicRoom = serializeRoom(room);
      publicRoom.password = !!room.password;
      return publicRoom;
    });

const broadcastAll = (type, data) => {
  for (const ws of clients.values()) {
    send(ws, type, data);
  }
};

const broadcastRoom = (roomId, type, data, excludeWs = null) => {
  const room = rooms[roomId];
  if (!room) return;

  for (const peer of Array.from(room.connections)) {
    if (peer !== excludeWs) {
      send(peer, type, data);
    }
  }
};

const updateCapacity = () => {
  broadcastAll('server_capacity', { active: activeConnections, max: MAX_GLOBAL_PLAYERS });
};

const sendRoomList = (targetWs = null) => {
  const list = serializeRoomList();
  if (targetWs) {
    send(targetWs, 'room_list', list);
    return;
  }
  broadcastAll('room_list', list);
};

const removeFromQueue = (ws) => {
  const idx = waitingQueue.indexOf(ws);
  if (idx !== -1) waitingQueue.splice(idx, 1);
};

const refreshQueuePositions = () => {
  waitingQueue.forEach((queuedWs, index) => {
    send(queuedWs, 'queue_update', { position: index + 1 });
  });
};

const approveNextQueuedClient = () => {
  while (waitingQueue.length > 0 && activeConnections < MAX_GLOBAL_PLAYERS) {
    const nextWs = waitingQueue.shift();
    if (!nextWs || nextWs.closed) continue;

    nextWs.isQueued = false;
    activeConnections++;
    send(nextWs, 'queue_approved');
    send(nextWs, 'server_capacity', { active: activeConnections, max: MAX_GLOBAL_PLAYERS });
    sendRoomList(nextWs);
    refreshQueuePositions();
    updateCapacity();
    return;
  }

  refreshQueuePositions();
  updateCapacity();
};

const handlePlayerLeaving = (ws, explicitRoomId = null) => {
  const roomId = explicitRoomId || ws.roomId;
  if (!roomId) return;

  const room = rooms[roomId];
  if (!room) {
    if (ws.roomId === roomId) ws.roomId = null;
    return;
  }

  room.connections.delete(ws);

  const playerIndex = room.players.findIndex((player) => player.id === ws.id);
  if (playerIndex !== -1) {
    room.players.splice(playerIndex, 1);
  }

  if (room.hostId === ws.id && room.players.length > 0) {
    room.hostId = room.players[0].id;
    room.players.forEach((player) => {
      player.isHost = player.id === room.hostId;
    });
  }

  if (room.players.length === 0) {
    delete rooms[roomId];
  } else {
    broadcastRoom(roomId, 'room_update', serializeRoom(room));
  }

  if (ws.roomId === roomId) ws.roomId = null;
};

const joinRoomInternal = (ws, roomId, defaultName, isHost) => {
  if (ws.isQueued) return;

  const room = rooms[roomId];
  if (!room) return;

  const alreadyInRoom = room.players.some((player) => player.id === ws.id);
  if (alreadyInRoom) return;

  ws.roomId = roomId;
  room.connections.add(ws);

  const player = {
    id: ws.id,
    name: defaultName,
    isHost,
    x: 600,
    y: 600,
    faction: isHost ? 'green' : 'blue',
    votedForRematch: false,
    hp: 100,
    isAlive: true,
    empireId: null,
    unitCount: 1,
    isUnderground: false
  };

  room.players.push(player);

  const roomData = serializeRoom(room);
  send(ws, 'join_success', roomData);
  broadcastRoom(roomId, 'room_update', roomData);
  sendRoomList();
};

const toArrayBuffer = (message) => {
  if (message instanceof ArrayBuffer) return message;

  if (ArrayBuffer.isView(message)) {
    return message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength);
  }

  const buffer = Buffer.from(message);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};

const decodeSyncPacket = (message) => {
  const buffer = toArrayBuffer(message);
  if (buffer.byteLength < SYNC_PACKET_HEADER_SIZE) return null;

  const view = new DataView(buffer);
  const payload = {};

  const x = view.getFloat32(0, true);
  const y = view.getFloat32(4, true);
  const rotation = view.getFloat32(8, true);
  const hp = view.getFloat32(12, true);
  const unitCount = view.getUint32(16, true);
  const flags = view.getUint8(20);
  const jsonLength = view.getUint32(21, true);

  if (jsonLength > 0 && buffer.byteLength >= SYNC_PACKET_HEADER_SIZE + jsonLength) {
    const jsonBytes = new Uint8Array(buffer, SYNC_PACKET_HEADER_SIZE, jsonLength);
    const jsonText = decoder.decode(jsonBytes);

    if (jsonText) {
      try {
        Object.assign(payload, JSON.parse(jsonText));
      } catch {}
    }
  }

  if (Number.isFinite(x)) payload.x = x;
  if (Number.isFinite(y)) payload.y = y;
  if (Number.isFinite(rotation)) payload.rotation = rotation;
  if (Number.isFinite(hp)) payload.hp = hp;
  if (unitCount !== SYNC_PACKET_UNIT_COUNT_SENTINEL) payload.unitCount = unitCount;
  if (payload.isUnderground === undefined) payload.isUnderground = Boolean(flags & 1);

  return payload;
};

const applySyncData = (ws, payload) => {
  const roomId = payload.roomId || ws.roomId;
  if (!roomId || !rooms[roomId]) return;

  const room = rooms[roomId];
  ws.roomId = roomId;
  room.connections.add(ws);

  const player = room.players.find((entry) => entry.id === ws.id);
  if (player) {
    if (typeof payload.x === 'number') player.x = payload.x;
    if (typeof payload.y === 'number') player.y = payload.y;
    if (typeof payload.hp === 'number') player.hp = payload.hp;
    if (typeof payload.unitCount === 'number') player.unitCount = payload.unitCount;
    if (typeof payload.isUnderground === 'boolean') player.isUnderground = payload.isUnderground;
    if (typeof payload.name === 'string' && payload.name.trim()) player.name = payload.name;
    if (payload.empireId) player.empireId = payload.empireId;
    if (payload.faction) player.faction = payload.faction;
  }

  const mergedPayload = {
    id: ws.id,
    roomId,
    x: player?.x ?? payload.x ?? 0,
    y: player?.y ?? payload.y ?? 0,
    hp: player?.hp ?? payload.hp ?? 100,
    unitCount: player?.unitCount ?? payload.unitCount ?? 1,
    isUnderground: player?.isUnderground ?? payload.isUnderground ?? false,
    ...payload
  };

  broadcastRoom(roomId, 'remote_update', mergedPayload, ws);
};

const app = uWS.App();

app.get('/', (res) => {
  res.end(`--- SULTAN ENGINE v1.8.2 ONLINE | PLAYERS: ${activeConnections}/${MAX_GLOBAL_PLAYERS} ---`);
});

app.ws('/*', {
  compression: uWS.SHARED_COMPRESSOR,
  maxPayloadLength: 16 * 1024 * 1024,
  idleTimeout: 60,

  open: (ws) => {
    ws.id = makeId();
    ws.roomId = null;
    ws.isQueued = false;
    ws.closed = false;

    clients.set(ws.id, ws);

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
    updateCapacity();
    sendRoomList();
  },

  message: (ws, message, isBinary) => {
    if (isBinary) {
      const syncPayload = decodeSyncPacket(message);
      if (syncPayload) {
        applySyncData(ws, syncPayload);
      }
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(message).toString());
    } catch {
      return;
    }

    if (!parsed || typeof parsed.type !== 'string') return;

    const type = parsed.type;
    const data = parsed.data;

    switch (type) {
      case 'get_room_list': {
        sendRoomList(ws);
        break;
      }

      case 'create_room': {
        if (ws.isQueued) break;

        const roomId = makeRoomId();
        rooms[roomId] = {
          id: roomId,
          name: data?.name || `Sultan_${roomId}`,
          password: data?.password || '',
          hostId: ws.id,
          status: 'lobby',
          players: [],
          buildings: [],
          tunnels: [],
          connections: new Set(),
          maxPlayers: Number(data?.limit) || 10,
          rematchVotes: 0,
          seed: Math.random()
        };

        joinRoomInternal(ws, roomId, data?.playerName || 'Great Agha', true);
        break;
      }

      case 'join_room': {
        if (ws.isQueued) break;

        const roomId = typeof data === 'string' ? data : data?.roomId;
        const password = typeof data === 'string' ? '' : data?.password || '';
        const playerName =
          typeof data === 'object' && data?.playerName
            ? data.playerName
            : `Janissary_${ws.id.slice(0, 3)}`;

        const room = rooms[roomId];
        if (!room) {
          send(ws, 'error', 'Комната не найдена');
          break;
        }

        if (room.status !== 'lobby') {
          send(ws, 'error', 'Битва уже идет!');
          break;
        }

        if (room.password && room.password !== password) {
          send(ws, 'error', 'Неверный пароль!');
          break;
        }

        if (room.players.length >= room.maxPlayers) {
          send(ws, 'error', 'Комната заполнена');
          break;
        }

        joinRoomInternal(ws, roomId, playerName, false);
        break;
      }

      case 'leave_room': {
        const roomId = typeof data === 'string' ? data : data?.roomId || ws.roomId;
        handlePlayerLeaving(ws, roomId);
        sendRoomList();
        break;
      }

      case 'update_player_name': {
        const roomId = data?.roomId || ws.roomId;
        const room = rooms[roomId];
        if (!room) break;

        const player = room.players.find((entry) => entry.id === ws.id);
        if (!player) break;

        if (typeof data?.name === 'string' && data.name.trim()) {
          player.name = data.name;
        }

        if (data?.empireId) {
          player.empireId = data.empireId;
        }

        broadcastRoom(roomId, 'room_update', serializeRoom(room));
        break;
      }

      case 'sync_data': {
        applySyncData(ws, data || {});
        break;
      }

      case 'remote_hp_sync': {
        const roomId = data?.roomId || ws.roomId;
        const room = rooms[roomId];
        if (!room) break;

        const player = room.players.find((entry) => entry.id === (data?.id || ws.id));
        if (player && typeof data?.hp === 'number') {
          player.hp = data.hp;
        }

        broadcastRoom(
          roomId,
          'remote_hp_sync',
          { id: data?.id || ws.id, hp: typeof data?.hp === 'number' ? data.hp : player?.hp ?? 100 },
          ws
        );
        break;
      }

      case 'start_match_request': {
        const roomId = typeof data === 'string' ? data : data?.roomId;
        const room = rooms[roomId];
        if (!room || room.hostId !== ws.id) break;

        room.status = 'active';
        broadcastRoom(roomId, 'match_started', serializeRoom(room));
        sendRoomList();
        break;
      }

      case 'start_countdown': {
        const roomId = typeof data === 'string' ? data : data?.roomId;
        const seconds = Number(data?.seconds) || 5;
        if (roomId) {
          broadcastRoom(roomId, 'start_countdown', seconds);
        }
        break;
      }

      case 'commander_death_detected': {
        const room = rooms[data?.roomId];
        if (!room || room.status !== 'active') break;

        const loser = room.players.find((player) => player.id === data.loserId);
        if (loser) loser.isAlive = false;

        const winner = room.players.find((player) => player.id === data.winnerId);
        const winnerName = winner ? winner.name : 'Enemy';

        broadcastRoom(data.roomId, 'player_eliminated', {
          loserId: data.loserId,
          winnerId: data.winnerId,
          winnerName
        });

        const alivePlayers = room.players.filter((player) => player.isAlive !== false);
        if (alivePlayers.length <= 1) {
          room.status = 'finished';
          const finalWinner = alivePlayers[0] || winner || null;

          broadcastRoom(data.roomId, 'game_over_final', {
            winnerId: finalWinner ? finalWinner.id : null,
            winnerName: finalWinner ? finalWinner.name : 'Draw'
          });
        }
        break;
      }

      case 'vote_rematch': {
        const roomId = typeof data === 'string' ? data : data?.roomId || ws.roomId;
        const room = rooms[roomId];
        if (!room) break;

        const player = room.players.find((entry) => entry.id === ws.id);
        if (!player || player.votedForRematch) break;

        player.votedForRematch = true;
        room.rematchVotes = (room.rematchVotes || 0) + 1;

        broadcastRoom(roomId, 'update_rematch_votes', {
          votedPlayers: room.rematchVotes,
          maxPlayers: room.players.length
        });

        if (room.rematchVotes >= room.players.length) {
          room.rematchVotes = 0;
          room.status = 'lobby';
          room.buildings = [];
          room.tunnels = [];

          room.players.forEach((entry) => {
            entry.votedForRematch = false;
            entry.hp = 100;
            entry.isAlive = true;
          });

          broadcastRoom(roomId, 'rematch_started', serializeRoom(room));
          sendRoomList();
        }
        break;
      }

      case 'request_tunnels': {
        const roomId = data?.roomId || ws.roomId;
        const room = rooms[roomId];
        if (!room) break;

        send(ws, 'sync_tunnels', { tunnels: room.tunnels || [] });
        break;
      }

      case 'tunnel_update': {
        const roomId = data?.roomId || ws.roomId;
        const room = rooms[roomId];
        if (!room) break;

        const tunnel = { ...data, ownerId: ws.id };
        const idx = room.tunnels.findIndex((entry) => entry.id === tunnel.id);

        if (idx !== -1) room.tunnels[idx] = tunnel;
        else room.tunnels.push(tunnel);

        broadcastRoom(roomId, 'remote_tunnel_update', tunnel, ws);
        break;
      }

      case 'tunnel_remove': {
        const roomId = data?.roomId || ws.roomId;
        const room = rooms[roomId];
        if (!room) break;

        room.tunnels = room.tunnels.filter((entry) => entry.id !== data.id);
        broadcastRoom(roomId, 'remote_tunnel_remove', { id: data.id }, ws);
        break;
      }

      case 'building_placed': {
        const roomId = data?.roomId || ws.roomId;
        const room = rooms[roomId];
        if (!room) break;

        if (data?.type === 'tunnel' || data?.type === 'pit') {
          const tunnel = { ...data, ownerId: ws.id };
          room.tunnels.push(tunnel);
          broadcastRoom(roomId, 'remote_tunnel_update', tunnel, ws);
          break;
        }

        const building = { ...data, ownerId: ws.id, isOpen: false };
        room.buildings.push(building);
        broadcastRoom(roomId, 'remote_building_placed', building);
        break;
      }

      case 'building_hit': {
        const roomId = data?.roomId || ws.roomId;
        if (roomId) {
          broadcastRoom(roomId, 'remote_building_hit', data, ws);
        }
        break;
      }

      case 'building_destroyed': {
        const roomId = data?.roomId || ws.roomId;
        const room = rooms[roomId];
        if (!room) break;

        const beforeBuildings = room.buildings.length;
        room.buildings = room.buildings.filter((entry) => entry.id !== data.buildingId);

        if (room.buildings.length !== beforeBuildings) {
          broadcastRoom(roomId, 'remote_building_destroyed', data.buildingId);
          break;
        }

        const beforeTunnels = room.tunnels.length;
        room.tunnels = room.tunnels.filter((entry) => entry.id !== data.buildingId);

        if (room.tunnels.length !== beforeTunnels) {
          broadcastRoom(roomId, 'remote_tunnel_remove', { id: data.buildingId });
        }
        break;
      }

      case 'garrison_hit': {
        const roomId = data?.roomId || ws.roomId;
        if (roomId) {
          broadcastRoom(roomId, 'remote_garrison_hit', data);
        }
        break;
      }

      case 'garrison_destroyed': {
        const roomId = data?.roomId || ws.roomId;
        if (roomId) {
          broadcastRoom(roomId, 'garrison_destroyed', data);
        }
        break;
      }

      case 'toggle_gate': {
        const roomId = data?.roomId || ws.roomId;
        const room = rooms[roomId];
        if (!room) break;

        const gate = room.buildings.find((entry) => entry.id === data.buildingId);
        if (!gate) break;

        gate.isOpen = data.isOpen;
        broadcastRoom(roomId, 'remote_gate_toggled', data);
        break;
      }

      case 'unit_hit': {
        const targetWs = clients.get(data?.targetPlayerId);
        if (targetWs) {
          send(targetWs, 'take_unit_damage', data);
        }
        break;
      }

      case 'tower_fire': {
        const roomId = data?.roomId || ws.roomId;
        if (roomId) {
          broadcastRoom(roomId, 'remote_tower_fire', data, ws);
        }
        break;
      }

      case 'attack': {
        const roomId = data?.roomId || ws.roomId;
        if (roomId) {
          broadcastRoom(roomId, 'attack_event', { id: ws.id }, ws);
        }
        break;
      }

      case 'host_sync_world': {
        const roomId = data?.roomId || ws.roomId;
        const room = rooms[roomId];
        if (!room || room.hostId !== ws.id) break;

        broadcastRoom(roomId, 'sync_world', {
          neutrals: data.neutrals || [],
          towers: data.towers || []
        }, ws);
        break;
      }

      case 'village_spawned': {
        const roomId = data?.roomId || ws.roomId;
        if (roomId) {
          broadcastRoom(roomId, 'village_spawned', data, ws);
        }
        break;
      }

      case 'heartbeat':
      case 'garrison_update':
      default: {
        break;
      }
    }
  },

  close: (ws) => {
    ws.closed = true;
    clients.delete(ws.id);

    if (ws.isQueued) {
      removeFromQueue(ws);
      refreshQueuePositions();
      return;
    }

    if (activeConnections > 0) {
      activeConnections--;
    }

    handlePlayerLeaving(ws);
    sendRoomList();
    approveNextQueuedClient();
  }
});

app.listen('0.0.0.0', PORT, (token) => {
  if (token) {
    console.log(`--- SULTAN ENGINE uWS ONLINE: ${PORT} ---`);
  } else {
    console.log(`Failed to listen on port ${PORT}`);
  }
});
