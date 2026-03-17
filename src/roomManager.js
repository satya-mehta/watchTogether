const { v4: uuidv4 } = require('uuid');

// ── Room code generator ────────────────────────────────────────────────────
const ADJECTIVES = ['COZY','WARM','SOFT','CALM','SWEET','LAZY','GOLDEN','QUIET'];
const NOUNS      = ['NOOK','DEN','SOFA','FILM','DUSK','MOON','STAR','NIGHT'];

function generateCode() {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num  = Math.floor(Math.random() * 9000) + 1000;
  return `${adj}-${num}`;
}

// ── Room structure ─────────────────────────────────────────────────────────
//  room = {
//    id:        string (uuid)
//    code:      string e.g. "COZY-4827"
//    createdAt: Date
//    peers:     Map<peerId, PeerState>
//    playState: PlayState
//  }
//
//  PeerState = { ws, peerId, name, fileDuration, isReady, isHost }
//  PlayState = { playing, positionSec, lastUpdatedAt, masterId }

class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomId → room
    this.codeIndex = new Map(); // code → roomId

    // Clean up empty rooms every 10 minutes
    setInterval(() => this._gc(), 10 * 60 * 1000);
  }

  // ── Create ───────────────────────────────────────────────────────────────
  create() {
    const id   = uuidv4();
    const code = this._uniqueCode();
    const room = {
      id,
      code,
      createdAt: new Date(),
      peers: new Map(),
      playState: {
        playing: false,
        positionSec: 0,
        lastUpdatedAt: Date.now(),
        masterId: null,
      },
    };
    this.rooms.set(id, room);
    this.codeIndex.set(code, id);
    console.log(`[Room] Created  ${code} (${id})`);
    return room;
  }

  // ── Look up ──────────────────────────────────────────────────────────────
  findByCode(code) {
    const id = this.codeIndex.get(code);
    return id ? this.rooms.get(id) : null;
  }

  findById(id) {
    return this.rooms.get(id);
  }

  // ── Peer management ──────────────────────────────────────────────────────
  addPeer(room, ws, peerId, name, isHost) {
    room.peers.set(peerId, {
      ws,
      peerId,
      name,
      isHost,
      fileDuration: null,
      isReady: false,
    });
    // First peer becomes master
    if (room.peers.size === 1) room.playState.masterId = peerId;
    console.log(`[Room] ${room.code}  +peer ${name} (${peerId})  total=${room.peers.size}`);
  }

  removePeer(room, peerId) {
    const peer = room.peers.get(peerId);
    room.peers.delete(peerId);
    console.log(`[Room] ${room.code}  -peer ${peer?.name}  remaining=${room.peers.size}`);

    // Hand master to the other peer if master left
    if (room.playState.masterId === peerId && room.peers.size > 0) {
      room.playState.masterId = [...room.peers.keys()][0];
    }

    // Destroy room when empty
    if (room.peers.size === 0) {
      this.rooms.delete(room.id);
      this.codeIndex.delete(room.code);
      console.log(`[Room] ${room.code}  destroyed (empty)`);
    }
  }

  // ── Current position (accounts for elapsed time since last update) ───────
  currentPosition(room) {
    const ps = room.playState;
    if (!ps.playing) return ps.positionSec;
    const elapsed = (Date.now() - ps.lastUpdatedAt) / 1000;
    return ps.positionSec + elapsed;
  }

  // ── Stats ────────────────────────────────────────────────────────────────
  count() { return this.rooms.size; }
  totalPeers() {
    let n = 0;
    this.rooms.forEach(r => (n += r.peers.size));
    return n;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  _uniqueCode() {
    let code;
    do { code = generateCode(); } while (this.codeIndex.has(code));
    return code;
  }

  _gc() {
    const now = Date.now();
    this.rooms.forEach((room, id) => {
      const age = (now - room.createdAt) / 1000 / 60; // minutes
      if (room.peers.size === 0 && age > 30) {
        this.rooms.delete(id);
        this.codeIndex.delete(room.code);
        console.log(`[GC] Removed stale room ${room.code}`);
      }
    });
  }
}

const roomManager = new RoomManager();
module.exports = { roomManager };
