// backend/server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const Room = require('./models/Room');

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/alpharush';
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || '8', 10);

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

mongoose.set('strictQuery', false);
mongoose.connect(MONGO_URI).then(()=> console.log('Mongo connected')).catch(err=>console.error(err));

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// helpers
function pickLetter(used){
  const remaining = LETTERS.filter(l => !used.includes(l));
  if(remaining.length === 0) return null;
  return remaining[Math.floor(Math.random()*remaining.length)];
}

// In-memory answers map: { roomId: { round: { socketId: { answers, submittedAt }, _scored: bool } } }
const answersMap = {};

io.on('connection', socket => {
  console.log('conn', socket.id);

  // create room
  socket.on('createRoom', async ({ roomId, name, password }, cb) => {
    try {
      if(!roomId || !name) return cb && cb({ ok:false, error:'roomId & name required' });
      const exists = await Room.findOne({ roomId });
      if(exists) return cb && cb({ ok:false, error:'Room exists' });

      const r = new Room({
        roomId,
        password: password || '',
        hostSocket: socket.id,
        players: [{ socketId: socket.id, name, score:0 }]
      });
      await r.save();
      socket.join(roomId);
      answersMap[roomId] = {};
      io.to(roomId).emit('roomUpdate', r);
      cb && cb({ ok:true, room:r });
    } catch(e) { console.error(e); cb && cb({ ok:false, error:'server error' }); }
  });

  // join room
  socket.on('joinRoom', async ({ roomId, name, password }, cb) => {
    try {
      if(!roomId || !name) return cb && cb({ ok:false, error:'roomId & name required' });
      const room = await Room.findOne({ roomId });
      if(!room) return cb && cb({ ok:false, error:'No such room' });
      if(room.players.length >= MAX_PLAYERS) return cb && cb({ ok:false, error:'Room full' });
      if(room.password && room.password !== (password || '')) return cb && cb({ ok:false, error:'Wrong password' });

      room.players.push({ socketId: socket.id, name, score:0 });
      await room.save();
      socket.join(roomId);
      io.to(roomId).emit('roomUpdate', room);
      cb && cb({ ok:true, room });
    } catch(e){ console.error(e); cb && cb({ ok:false, error:'server error' }); }
  });

  // start game (host)
  socket.on('startGame', async ({ roomId }, cb) => {
    try {
      const room = await Room.findOne({ roomId });
      if(!room) return cb && cb({ ok:false, error:'No room' });
      if(room.hostSocket !== socket.id) return cb && cb({ ok:false, error:'Only host' });

      room.round = 1;
      room.usedLetters = room.usedLetters || [];
      const letter = pickLetter(room.usedLetters || []);
      room.usedLetters.push(letter);
      await room.save();

      answersMap[roomId] = {};
      answersMap[roomId][room.round] = { _scored: false };
      io.to(roomId).emit('roundStarted', { round: room.round, letter, rounds:26 });
      io.to(roomId).emit('roomUpdate', room);
      cb && cb({ ok:true });
    } catch(e){ console.error(e); cb && cb({ ok:false, error:'server error' }); }
  });

  // update partial answers (real-time save while typing)
  socket.on('updateAnswers', async ({ roomId, round, answers }, cb) => {
    try {
      if(!answersMap[roomId]) answersMap[roomId] = {};
      if(!answersMap[roomId][round]) answersMap[roomId][round] = { _scored: false };
      const prev = answersMap[roomId][round][socket.id] || {};
      answersMap[roomId][round][socket.id] = { ...prev, answers }; // keep submittedAt if present
      cb && cb({ ok:true });
    } catch (e) { console.error(e); cb && cb({ ok:false }); }
  });

  // submit answers (explicit submit)
  socket.on('submitAnswers', async ({ roomId, round, answers }, cb) => {
    try {
      const room = await Room.findOne({ roomId });
      if(!room) return cb && cb({ ok:false, error:'No room' });

      if(!answersMap[roomId]) answersMap[roomId] = {};
      if(!answersMap[roomId][round]) answersMap[roomId][round] = { _scored: false };
      answersMap[roomId][round][socket.id] = { answers, submittedAt: new Date() };

      // update player's lastSubmitAt
      const pl = room.players.find(p => p.socketId === socket.id);
      if(pl){ pl.lastSubmitAt = new Date(); await room.save(); }

      io.to(roomId).emit('playerSubmitted', { socketId: socket.id, round });

      // if all submitted -> score (but do not advance)
      const submittedCount = Object.keys(answersMap[roomId][round]).filter(k => k !== '_scored').length;
      if(submittedCount >= room.players.length){
        await scoreRound(roomId, round); // scores only
      }
      cb && cb({ ok:true });
    } catch(e){ console.error(e); cb && cb({ ok:false, error:'server error' }); }
  });

  // force score (host or auto grace) - will score but NOT advance to next round
  socket.on('forceScore', async ({ roomId, round }, cb) => {
    try {
      await scoreRound(roomId, round);
      cb && cb({ ok:true });
    } catch(e){ console.error(e); cb && cb({ ok:false }); }
  });

  // nextRound (host-triggered) -> starts the next round only when host clicks Next
  socket.on('nextRound', async ({ roomId }, cb) => {
    try {
      const room = await Room.findOne({ roomId });
      if(!room) return cb && cb({ ok:false, error:'No room' });
      if(room.hostSocket !== socket.id) return cb && cb({ ok:false, error:'Only host' });

      // increment round and pick next letter
      room.round = (room.round || 0) + 1;
      if(room.round > 26){
        // game over
        io.to(roomId).emit('gameOver', { totals: room.players.map(p => ({ name: p.name, score: p.score })) });
        await room.save();
        return cb && cb({ ok:true });
      }

      room.usedLetters = room.usedLetters || [];
      const letter = pickLetter(room.usedLetters);
      room.usedLetters.push(letter);
      await room.save();

      // prepare answers map for new round
      if(!answersMap[roomId]) answersMap[roomId] = {};
      answersMap[roomId][room.round] = { _scored: false };

      io.to(roomId).emit('roundStarted', { round: room.round, letter, rounds:26 });
      io.to(roomId).emit('roomUpdate', room);
      cb && cb({ ok:true });
    } catch(e){ console.error(e); cb && cb({ ok:false, error:'server error' }); }
  });

  socket.on('disconnecting', async () => {
    try {
      const rooms = await Room.find({ 'players.socketId': socket.id });
      for(const r of rooms){
        r.players = r.players.filter(p => p.socketId !== socket.id);
        if(r.hostSocket === socket.id && r.players.length > 0) r.hostSocket = r.players[0].socketId;
        await r.save();
        io.to(r.roomId).emit('roomUpdate', r);
      }
    } catch(e){ console.error(e); }
  });
});

/* scoring (only scoring; no auto-advance) */
async function scoreRound(roomId, round){
  const room = await Room.findOne({ roomId });
  if(!room) return;

  // guard: skip if already scored
  if(answersMap[roomId] && answersMap[roomId][round] && answersMap[roomId][round]._scored) {
    console.log('Round already scored', roomId, round);
    return;
  }

  const answersForRound = (answersMap[roomId] && answersMap[roomId][round]) || {};
  const categories = ['Name','City','Thing','Animal'];

  // build normalized category map
  const catMap = {};
  categories.forEach(c=> catMap[c] = {});

  room.players.forEach(pl => {
    const ent = answersForRound[pl.socketId] || { answers: {} };
    const raw = ent.answers || {};
    categories.forEach(cat => {
      const v = (raw[cat] || '').trim().toLowerCase();
      if(!catMap[cat][v]) catMap[cat][v] = [];
      catMap[cat][v].push(pl.socketId);
    });
  });

  const roundScores = {};
  room.players.forEach(pl => roundScores[pl.socketId] = 0);

  categories.forEach(cat => {
    Object.keys(catMap[cat]).forEach(k => {
      if(k === '') return;
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

  // mark scored to prevent double scoring
  if(!answersMap[roomId]) answersMap[roomId] = {};
  if(!answersMap[roomId][round]) answersMap[roomId][round] = {};
  answersMap[roomId][round]._scored = true;

  // emit results + updated room (so leaderboard updates)
  io.to(roomId).emit('roundScored', {
    round,
    roundScores,
    totals: room.players.map(p => ({ socketId: p.socketId, name: p.name, score: p.score })),
    answers: answersMap[roomId][round] || {}
  });

  io.to(roomId).emit('roomUpdate', room);
}

/* health */
app.get('/health', (req,res)=> res.json({ ok:true }));

server.listen(PORT, ()=> console.log('Backend running on', PORT));
