const express = require('express');
const cors = require('cors');
const { roomManager } = require('./roomManager');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
};

app.use(cors(corsOptions));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    name: 'watchtogether-backend',
    status: 'ok',
    message: 'Backend is running. Use /health or the /api routes.',
  });
});

app.post('/api/rooms', (req, res) => {
  const room = roomManager.create();
  res.json({ roomCode: room.code, roomId: room.id });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = roomManager.findByCode(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.peers.size >= 2) return res.status(403).json({ error: 'Room is full' });
  return res.json({ roomId: room.id, peerCount: room.peers.size });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: roomManager.count(),
    peers: roomManager.totalPeers(),
  });
});

module.exports = { app };
