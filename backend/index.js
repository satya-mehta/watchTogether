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
  ws.missedPongs = 0;
  ws.on('pong', () => {
    ws.missedPongs = 0;
  });
  handleConnection(ws, req, roomManager);
});

// Ping less aggressively and only terminate after repeated missed pongs.
// A single missed mobile pong should not instantly eject the participant.
const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_MISSED_PONGS = 2;
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.missedPongs = (ws.missedPongs || 0) + 1;
    if (ws.missedPongs > MAX_MISSED_PONGS) {
      ws.terminate();
      return;
    }
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
