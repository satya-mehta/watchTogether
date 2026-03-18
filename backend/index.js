const http = require('http');
const { WebSocketServer } = require('ws');
const { app } = require('./app');
const { handleConnection } = require('./wsHandler');
const { roomManager } = require('./roomManager');

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

const HEARTBEAT_INTERVAL_MS = 5000;
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
