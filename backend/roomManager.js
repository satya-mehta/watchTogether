const { v4: uuidv4 } = require('uuid');

// ── Room code generator ────────────────────────────────────────────────────
const ADJECTIVES = ['COOL','NIGHT','SOFT','CALM','SWEET','LAZY','COZY','WILD','DARK','BRIGHT','VELVET','CRISP','MELLOW','SILVER'];
const NOUNS      = ['NOOK','DEN','SOFA','FILM','DUSK','MOON','STAR','COVE','REEF','GLOW','LOFT','NEST','TIDE','VALE','HAZE','PINE'];

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

// How long an empty room is kept alive before GC removes it (10 minutes).
// This window lets both peers reconnect after a WS drop without losing
// their room code.
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

class RoomManager {
  constructor() {
    this.rooms = new Map();     // roomId → room
    this.codeIndex = new Map(); // code   → roomId

    // Run GC every minute so empty rooms are collected promptly after their TTL
    setInterval(() => this._gc(), 60 * 1000);
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
    if (room.peers.size === 1) room.playState.masterId = peerId;
    // Clear the empty-room timer — someone joined, room is active again
    room.emptyAt = null;
    console.log(`[Room] ${room.code}  +peer ${name} (${peerId})  total=${room.peers.size}`);
  }

  removePeer(room, peerId) {
    const peer = room.peers.get(peerId);
    room.peers.delete(peerId);
    console.log(`[Room] ${room.code}  -peer ${peer?.name}  remaining=${room.peers.size}`);

    if (room.playState.masterId === peerId && room.peers.size > 0) {
      room.playState.masterId = [...room.peers.keys()][0];
    }

    if (room.peers.size === 0) {
      // Don't destroy immediately — record when the room became empty and let
      // the GC clean it up after EMPTY_ROOM_TTL_MS. This gives both peers time
      // to reconnect after a WS drop (Render free tier, mobile networks, etc.)
      // without losing their room code.
      room.emptyAt = Date.now();
      console.log(`[Room] ${room.code}  empty — will expire in ${EMPTY_ROOM_TTL_MS / 60000} min`);
    }
  }

  // ── Current position ─────────────────────────────────────────────────────
  // BUG FIX: old version had no upper bound. If the video was playing and
  // no sync_check from the master had updated positionSec recently (e.g.
  // after a reconnect or tab switch), currentPosition() could extrapolate
  // way past the actual end of the file. The non-master would receive a
  // sync_nudge pointing past EOF → browser clamps to duration → infinite
  // drift loop.
  //
  // Fix: cap at the shortest known file duration in the room so the server
  // clock never runs past the end of the video.
  currentPosition(room) {
    const ps = room.playState;
    if (!ps.playing) return ps.positionSec;

    const elapsed = (Date.now() - ps.lastUpdatedAt) / 1000;
    const raw = ps.positionSec + elapsed;

    // Determine shortest file duration known in room as an upper cap
    let maxPos = Infinity;
    room.peers.forEach(p => {
      if (typeof p.fileDuration === 'number' && p.fileDuration > 0) {
        maxPos = Math.min(maxPos, p.fileDuration);
      }
    });

    return maxPos === Infinity ? raw : Math.min(raw, maxPos);
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
      // Only collect rooms that are empty AND have been empty longer than the TTL.
      // Rooms with peers are never collected here regardless of age.
      if (room.peers.size === 0 && room.emptyAt && (now - room.emptyAt) >= EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(id);
        this.codeIndex.delete(room.code);
        console.log(`[GC] Removed expired empty room ${room.code} (empty for ${Math.round((now - room.emptyAt) / 60000)} min)`);
      }
    });
  }
}

const roomManager = new RoomManager();
module.exports = { roomManager };
