// backend/server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/alpharush';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Mongoose models
mongoose.set('strictQuery', false);
mongoose.connect(MONGO_URI).then(()=> console.log('Mongo connected')).catch(err=>console.error(err));

const roomSchema = new mongoose.Schema({
  roomId: { type: String, unique: true },
  password: String,
  hostSocket: String,
  players: [{
    socketId: String,
    name: String,
    score: { type: Number, default: 0 },
    lastSubmitAt: Date
  }],
  round: { type: Number, default: 0 },
  usedLetters: [String],
  createdAt: { type: Date, default: Date.now }
});
const Room = mongoose.model('Room', roomSchema);

// Utility
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
function nextRandomLetter(used) {
  if (!used) used = [];
  const remaining = letters.filter(l => !used.includes(l));
  if (remaining.length === 0) return null;
  return remaining[Math.floor(Math.random() * remaining.length)];
}

// In-memory active answers map: roomId -> { round -> { socketId -> answers } }
const answersMap = {};

io.on('connection', socket => {
  console.log('conn', socket.id);

  socket.on('createRoom', async ({ roomId, name, password }, cb) => {
    try {
      const exists = await Room.findOne({ roomId }).lean();
      if (exists) return cb && cb({ ok: false, error: 'Room exists' });

      const room = new Room({
        roomId,
        password: password || '',
        hostSocket: socket.id,
        players: [{ socketId: socket.id, name, score: 0 }]
      });
      await room.save();
      socket.join(roomId);
      io.to(roomId).emit('roomUpdate', room);
      cb && cb({ ok: true, room });
    } catch (err) {
      console.error(err);
      cb && cb({ ok: false, error: 'Server error' });
    }
  });

  socket.on('joinRoom', async ({ roomId, name, password }, cb) => {
    try {
      const room = await Room.findOne({ roomId });
      if (!room) return cb && cb({ ok: false, error: 'No room' });
      if (room.password && room.password !== (password || '')) return cb && cb({ ok: false, error: 'Wrong password' });

      room.players.push({ socketId: socket.id, name, score: 0 });
      await room.save();
      socket.join(roomId);
      io.to(roomId).emit('roomUpdate', room);
      cb && cb({ ok: true, room });
    } catch (err) {
      console.error(err);
      cb && cb({ ok: false, error: 'Server error' });
    }
  });

  socket.on('startGame', async ({ roomId }, cb) => {
    try {
      const room = await Room.findOne({ roomId });
      if (!room) return cb && cb({ ok: false, error: 'No room' });
      room.round = 1;
      const letter = nextRandomLetter(room.usedLetters);
      if (!letter) return cb && cb({ ok: false, error: 'No letters left' });
      room.usedLetters.push(letter);
      await room.save();

      answersMap[roomId] = answersMap[roomId] || {};
      answersMap[roomId][room.round] = {};

      io.to(roomId).emit('roundStarted', { round: room.round, letter, rounds: 26 });
      io.to(roomId).emit('roomUpdate', room);
      cb && cb({ ok: true });
    } catch (err) { console.error(err); cb && cb({ ok: false, error: 'Server error' }); }
  });

  socket.on('submitAnswers', async ({ roomId, round, answers }, cb) => {
    try {
      const room = await Room.findOne({ roomId });
      if (!room) return cb && cb({ ok: false, error: 'No room' });

      answersMap[roomId] = answersMap[roomId] || {};
      answersMap[roomId][round] = answersMap[roomId][round] || {};
      answersMap[roomId][round][socket.id] = {
        answers,
        submittedAt: new Date()
      };

      // mark player's lastSubmitAt
      const p = room.players.find(x => x.socketId === socket.id);
      if (p) { p.lastSubmitAt = new Date(); await room.save(); }

      io.to(roomId).emit('playerSubmitted', { socketId: socket.id, round });

      // if all players submitted -> score
      const playersCount = room.players.length;
      const submittedCount = Object.keys(answersMap[roomId][round]).length;
      if (submittedCount >= playersCount) {
        // scoring
        const categories = ['Name','City','Thing','Animal'];
        const catMap = {};
        categories.forEach(c => catMap[c] = {});
        room.players.forEach(pl => {
          const ent = answersMap[roomId][round][pl.socketId];
          const raw = ent && ent.answers ? ent.answers : {};
          categories.forEach(cat => {
            const v = (raw[cat] || '').trim().toLowerCase();
            if (!catMap[cat][v]) catMap[cat][v] = [];
            catMap[cat][v].push(pl.socketId);
          });
        });
        // compute per-player points
        const roundScores = {};
        room.players.forEach(pl => roundScores[pl.socketId] = 0);
        categories.forEach(cat => {
          Object.keys(catMap[cat]).forEach(k => {
            if (k === '') return;
            const list = catMap[cat][k];
            const pts = list.length === 1 ? 10 : 5;
            list.forEach(pid => roundScores[pid] += pts);
          });
        });
        // apply
        room.players.forEach(pl => {
          pl.score = (pl.score || 0) + (roundScores[pl.socketId] || 0);
        });
        await room.save();

        io.to(roomId).emit('roundScored', { round, roundScores, totals: room.players.map(p=>({socketId:p.socketId,name:p.name,score:p.score})) });

        // auto-advance after short pause (you can change: host can control next)
        setTimeout(async () => {
          const r = await Room.findOne({ roomId });
          r.round = (r.round || 1) + 1;
          if (r.round > 26) {
            io.to(roomId).emit('gameOver', { totals: r.players.map(p=>({ name:p.name, score:p.score })) });
            return;
          }
          const letter = nextRandomLetter(r.usedLetters);
          r.usedLetters.push(letter);
          await r.save();
          answersMap[roomId][r.round] = {};
          io.to(roomId).emit('roundStarted', { round: r.round, letter, rounds: 26 });
          io.to(roomId).emit('roomUpdate', r);
        }, 3500);
      }

      cb && cb({ ok: true });
    } catch (err) {
      console.error(err);
      cb && cb({ ok: false, error: 'Server error' });
    }
  });

  socket.on('disconnecting', async () => {
    try {
      const roomsList = await Room.find({ 'players.socketId': socket.id });
      for (const r of roomsList) {
        r.players = r.players.filter(p => p.socketId !== socket.id);
        if (r.hostSocket === socket.id && r.players.length > 0) {
          r.hostSocket = r.players[0].socketId;
        }
        await r.save();
        io.to(r.roomId).emit('roomUpdate', r);
      }
    } catch (e) { console.error(e); }
  });
});

// simple health route
app.get('/health', (req, res) => res.json({ ok: true }));

server.listen(PORT, () => console.log('Server listening on', PORT));
