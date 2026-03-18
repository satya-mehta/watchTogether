const http = require('http');
const { WebSocketServer } = require('ws');
const { app } = require('./app');
const { handleConnection } = require('./wsHandler');
const { roomManager } = require('./roomManager');

const server = http.createServer(app);

// ── WebSocket server ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => handleConnection(ws, req, roomManager));

const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
server.listen(PORT, () => {
  console.log(`\n🎬 Backend running on ${BASE_URL}`);
console.log(`🔌 WebSocket: ${BASE_URL.replace('http', 'ws')}/ws`);
console.log(`❤️ Health: ${BASE_URL}/health\n`);
});
