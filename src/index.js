const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { handleConnection } = require('./wsHandler');
const { roomManager } = require('./roomManager');

const app = express();
const server = http.createServer(app);

// Root of the project (one level up from src/)
const ROOT = path.join(__dirname, '..');

app.use(cors());
app.use(express.json());

// Serve everything in the project root as static files
app.use(express.static(ROOT));

// Explicitly serve index.html at /
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

// ── REST: create room ──────────────────────────────────────────────────────
app.post('/api/rooms', (req, res) => {
  const room = roomManager.create();
  res.json({ roomCode: room.code, roomId: room.id });
});

// ── REST: validate room code before joining ────────────────────────────────
app.get('/api/rooms/:code', (req, res) => {
  const room = roomManager.findByCode(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.peers.size >= 2) return res.status(403).json({ error: 'Room is full' });
  res.json({ roomId: room.id, peerCount: room.peers.size });
});

// Serve the same client app for shareable room URLs like /COOL-9710
app.get('/:roomCode([A-Za-z0-9-]+)', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

// ── WebSocket server ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => handleConnection(ws, req, roomManager));

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: roomManager.count(),
    peers: roomManager.totalPeers(),
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🎬  Watch Together running on http://localhost:${PORT}`);
  console.log(`🔌  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`🌐  Open http://localhost:${PORT} in two tabs to test\n`);
});
