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
server.listen(PORT, () => {
  console.log(`\n🎬  Watch Together backend running on http://localhost:${PORT}`);
  console.log(`🔌  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`❤️  Health: http://localhost:${PORT}/health\n`);
});
