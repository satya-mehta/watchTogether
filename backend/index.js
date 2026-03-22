const http = require('http');
const { WebSocketServer } = require('ws');
const { app } = require('./app');
const { handleConnection } = require('./wsHandler');
const { roomManager } = require('./roomManager');

// ── Global error handlers to prevent process crash ─────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  // Log but don't crash - let the process continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  // Log but don't crash - let the process continue
});

const server = http.createServer(app);

// ── WebSocket server ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  handleConnection(ws, req, roomManager);
});

// BUG FIX: reduced from 5000ms to 2000ms.
// At 5s, a dead socket can linger for up to 10s (missed ping + another full
// interval before terminate fires). During that window, if the peer reconnects
// and tries to rejoin, the room appears full. 2s heartbeat means stale sockets
// are evicted within ~4s, well within the client's 2s rejoin delay.
const HEARTBEAT_INTERVAL_MS = 2000;
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeatTimer);
});

const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
server.listen(PORT, () => {
  console.log(`\n🎬 Backend running on ${BASE_URL}`);
console.log(`🔌 WebSocket: ${BASE_URL.replace('http', 'ws')}/ws`);
console.log(`❤️ Health: ${BASE_URL}/health\n`);
});
