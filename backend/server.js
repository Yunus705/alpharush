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

// helper: pick a random unused letter
function pickLetter(used){
  const remaining = LETTERS.filter(l => !used.includes(l));
  if(remaining.length === 0) return null;
  return remaining[Math.floor(Math.random()*remaining.length)];
}

// In-memory answers map:
// answersMap = { roomId: { roundNumber: { socketId: { answers: {...}, submittedAt, invalid: {Name:true}, ... }, _scored: bool } } }
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

  // update partial answers (draft save while typing)
  socket.on('updateAnswers', async ({ roomId, round, answers }, cb) => {
    try {
      if(!answersMap[roomId]) answersMap[roomId] = {};
      if(!answersMap[roomId][round]) answersMap[roomId][round] = { _scored: false };
      const prev = answersMap[roomId][round][socket.id] || {};
      answersMap[roomId][round][socket.id] = { ...prev, answers }; // keep submittedAt if present
      cb && cb({ ok:true });
    } catch (e) { console.error(e); cb && cb({ ok:false }); }
  });

  // submit answers (explicit)
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

      // if all submitted -> score (no auto-advance)
      const submittedCount = Object.keys(answersMap[roomId][round]).filter(k => k !== '_scored').length;
      if(submittedCount >= room.players.length){
        await scoreRound(roomId, round);
      }
      cb && cb({ ok:true });
    } catch(e){ console.error(e); cb && cb({ ok:false, error:'server error' }); }
  });

  // force score (grace end). Scores current state but DOES NOT auto-advance
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

      room.round = (room.round || 0) + 1;
      if(room.round > 26){
        io.to(roomId).emit('gameOver', { totals: room.players.map(p => ({ name: p.name, score: p.score })) });
        await room.save();
        return cb && cb({ ok:true });
      }

      room.usedLetters = room.usedLetters || [];
      const letter = pickLetter(room.usedLetters);
      room.usedLetters.push(letter);
      await room.save();

      if(!answersMap[roomId]) answersMap[roomId] = {};
      answersMap[roomId][room.round] = { _scored: false };

      io.to(roomId).emit('roundStarted', { round: room.round, letter, rounds:26 });
      io.to(roomId).emit('roomUpdate', room);
      cb && cb({ ok:true });
    } catch(e){ console.error(e); cb && cb({ ok:false, error:'server error' }); }
  });

  // Host can invalidate/restore an individual player's category answer for a round
  socket.on('invalidateAnswer', async ({ roomId, round, targetSocketId, category, invalidate }, cb) => {
    try {
      const room = await Room.findOne({ roomId });
      if (!room) return cb && cb({ ok:false, error:'No room' });
      if (room.hostSocket !== socket.id) return cb && cb({ ok:false, error:'Only host' });

      if (!answersMap[roomId] || !answersMap[roomId][round]) return cb && cb({ ok:false, error:'No answers for round' });
      if (!answersMap[roomId][round][targetSocketId]) return cb && cb({ ok:false, error:'Target player has no answers' });

      answersMap[roomId][round][targetSocketId].invalid = answersMap[roomId][round][targetSocketId].invalid || {};
      answersMap[roomId][round][targetSocketId].invalid[category] = !!invalidate;

      // recompute totals and per-round contributions
      await recomputeRoundScores(roomId, round);

      cb && cb({ ok:true });
    } catch (e) {
      console.error('invalidateAnswer error', e);
      cb && cb({ ok:false, error:'server error' });
    }
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
async function scoreRound(roomId, round) {
  const room = await Room.findOne({ roomId });
  if (!room) return;

  // guard: skip if already scored
  if (answersMap[roomId] && answersMap[roomId][round] && answersMap[roomId][round]._scored) {
    console.log('Round already scored', roomId, round);
    return;
  }

  const answersForRound = (answersMap[roomId] && answersMap[roomId][round]) || {};
  const categories = ['Name', 'City', 'Thing', 'Animal'];

  // find current round letter
  const currentLetter = (room.usedLetters || [])[round - 1] || '';

  const catMap = {};
  categories.forEach(c => catMap[c] = {});

  // Validation rules:
  // - length >= 3
  // - only alphabets (a-z)
  // - starts with currentLetter (case-insensitive)
  // - reject repeated-only words like 'xxxxx' (handled by regex below implicitly via alphabets-only + length check and later filter)
  const ALPHA_RE = /^[a-zA-Z]+$/;
  const REPEAT_CHAR_RE = /^(.)\1+$/i;
  const MIN_LEN = 3;

  room.players.forEach(pl => {
    const ent = answersForRound[pl.socketId] || { answers: {} };
    const raw = ent.answers || {};
    categories.forEach(cat => {
      let v = (raw[cat] || '').trim();
      if (!v) return;
      if (v.length < MIN_LEN) return;
      if (!ALPHA_RE.test(v)) return;
      if (REPEAT_CHAR_RE.test(v)) return;
      if (currentLetter && v[0].toUpperCase() !== currentLetter.toUpperCase()) return;

      const lower = v.toLowerCase();
      if (!catMap[cat][lower]) catMap[cat][lower] = [];
      catMap[cat][lower].push(pl.socketId);
    });
  });

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

  // apply scores
  room.players.forEach(pl => {
    pl.score = (pl.score || 0) + (roundScores[pl.socketId] || 0);
  });

  await room.save();

  // mark scored to prevent double scoring
  if (!answersMap[roomId]) answersMap[roomId] = {};
  if (!answersMap[roomId][round]) answersMap[roomId][round] = {};
  answersMap[roomId][round]._scored = true;

  // emit results + updated room (so leaderboard updates)
  io.to(roomId).emit('roundScored', {
    round,
    roundScores,
    totals: room.players.map(p => ({
      socketId: p.socketId,
      name: p.name,
      score: p.score
    })),
    answers: answersMap[roomId][round] || {}
  });

  io.to(roomId).emit('roomUpdate', room);
}

/* recomputeRoundScores: rebuild totals from answersMap (respect invalid flags) */
async function recomputeRoundScores(roomId, round) {
  const room = await Room.findOne({ roomId });
  if (!room) return;

  const categories = ['Name','City','Thing','Animal'];
  const MIN_ANSWER_LENGTH = 3;
  const ALPHA_RE = /^[a-z]+$/;
  const REPEAT_CHAR_RE = /^(.)\1+$/i;

  // totals per player
  const totals = {};
  room.players.forEach(p => totals[p.socketId] = 0);

  // iterate rounds present in answersMap
  const roundsForRoom = Object.keys(answersMap[roomId] || {}).filter(k => k !== '_meta');
  roundsForRoom.forEach(rKey => {
    const rNum = parseInt(rKey, 10);
    if (isNaN(rNum)) return;
    const answersR = answersMap[roomId][rNum] || {};

    // determine letter for this round
    const letter = (room.usedLetters && room.usedLetters[rNum - 1]) ? room.usedLetters[rNum - 1].toLowerCase() : null;

    // build per-round catMap
    const catMapR = {};
    categories.forEach(c => catMapR[c] = {});

    room.players.forEach(pl => {
      const ent = answersR[pl.socketId] || { answers: {} };
      const raw = ent.answers || {};
      const invalidObj = ent.invalid || {};

      categories.forEach(cat => {
        if (invalidObj[cat]) return;
        const rawVal = (raw[cat] || '').trim().toLowerCase();
        if (!rawVal) return;
        if (rawVal.length < MIN_ANSWER_LENGTH) return;
        if (!ALPHA_RE.test(rawVal)) return;
        if (REPEAT_CHAR_RE.test(rawVal)) return;
        if (letter && rawVal[0] !== letter) return;

        if (!catMapR[cat][rawVal]) catMapR[cat][rawVal] = [];
        catMapR[cat][rawVal].push(pl.socketId);
      });
    });

    // calculate contributions
    categories.forEach(cat => {
      Object.keys(catMapR[cat]).forEach(ansText => {
        const list = catMapR[cat][ansText];
        const pts = list.length === 1 ? 10 : 5;
        list.forEach(pid => totals[pid] += pts);
      });
    });
  });

  // update room player totals
  room.players.forEach(p => {
    p.score = totals[p.socketId] || 0;
  });
  await room.save();

  // build per-player contributions for the requested round
  const roundContribution = {};
  room.players.forEach(p => roundContribution[p.socketId] = 0);
  if (answersMap[roomId] && answersMap[roomId][round]) {
    const answersR = answersMap[roomId][round];
    const letter = (room.usedLetters && room.usedLetters[round - 1]) ? room.usedLetters[round - 1].toLowerCase() : null;
    const catMapThis = {};
    categories.forEach(c => catMapThis[c] = {});

    room.players.forEach(pl => {
      const ent = answersR[pl.socketId] || { answers: {} };
      const raw = ent.answers || {};
      const invalidObj = ent.invalid || {};
      categories.forEach(cat => {
        if (invalidObj[cat]) return;
        const rawVal = (raw[cat] || '').trim().toLowerCase();
        if (!rawVal) return;
        if (rawVal.length < MIN_ANSWER_LENGTH) return;
        if (!ALPHA_RE.test(rawVal)) return;
        if (REPEAT_CHAR_RE.test(rawVal)) return;
        if (letter && rawVal[0] !== letter) return;

        if (!catMapThis[cat][rawVal]) catMapThis[cat][rawVal] = [];
        catMapThis[cat][rawVal].push(pl.socketId);
      });
    });

    categories.forEach(cat => {
      Object.keys(catMapThis[cat]).forEach(k => {
        const list = catMapThis[cat][k];
        const pts = list.length === 1 ? 10 : 5;
        list.forEach(pid => roundContribution[pid] += pts);
      });
    });
  }

  // ensure _scored flag exists
  if (!answersMap[roomId]) answersMap[roomId] = {};
  if (!answersMap[roomId][round]) answersMap[roomId][round] = {};
  answersMap[roomId][round]._scored = true;

  // emit updated roundScored and roomUpdate
  io.to(roomId).emit('roundScored', {
    round,
    roundScores: roundContribution,
    totals: room.players.map(p => ({ socketId: p.socketId, name: p.name, score: p.score })),
    answers: answersMap[roomId][round] || {}
  });

  io.to(roomId).emit('roomUpdate', room);
}

/* CSV export route (host can call) */
const { stringify } = require('csv-stringify/sync');

app.get('/export/:roomId', async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const room = await Room.findOne({ roomId });
    if (!room) return res.status(404).send('Room not found');

    const categories = ['Name','City','Thing','Animal'];
    const rows = [];
    rows.push(['Round','Letter','PlayerSocketId','PlayerName','Category','Answer','Invalid','PointsThisCategory']);

    const roundsForRoom = Object.keys(answersMap[roomId] || {}).filter(k => k !== '_meta').map(n => parseInt(n,10)).sort((a,b)=>a-b);

    roundsForRoom.forEach(r => {
      const letter = (room.usedLetters && room.usedLetters[r-1]) ? room.usedLetters[r-1] : '';
      const answersR = answersMap[roomId][r] || {};
      // build catMap for the round
      const catMap = {};
      categories.forEach(c => catMap[c] = {});
      room.players.forEach(p => {
        const ent = answersR[p.socketId] || { answers: {} };
        const raw = ent.answers || {};
        const invalidObj = ent.invalid || {};
        categories.forEach(cat => {
          const val = (raw[cat] || '').trim();
          const valid = val && val.length >= 3 && /^[a-zA-Z]+$/.test(val) && val[0].toLowerCase() === (letter||'').toLowerCase() && !invalidObj[cat];
          if (valid) {
            const norm = val.toLowerCase();
            if (!catMap[cat][norm]) catMap[cat][norm] = [];
            catMap[cat][norm].push(p.socketId);
          }
        });
      });

      // points per player for this round
      const pointsByPlayer = {};
      room.players.forEach(p => pointsByPlayer[p.socketId] = 0);
      categories.forEach(cat => {
        Object.keys(catMap[cat]).forEach(ansText => {
          const list = catMap[cat][ansText];
          const pts = list.length === 1 ? 10 : 5;
          list.forEach(pid => pointsByPlayer[pid] += pts);
        });
      });

      // produce CSV rows
      room.players.forEach(p => {
        const ent = answersR[p.socketId] || { answers: {} };
        const invalidObj = ent.invalid || {};
        categories.forEach(cat => {
          const ansVal = (ent.answers && ent.answers[cat]) ? ent.answers[cat] : '';
          const invalidFlag = !!invalidObj[cat];
          let pts = 0;
          const norm = (ansVal || '').trim().toLowerCase();
          if (norm && catMap[cat][norm]) {
            const list = catMap[cat][norm];
            pts = (list.length === 1) ? 10 : 5;
          }
          if (invalidFlag) pts = 0;
          rows.push([r, letter, p.socketId, p.name, cat, ansVal || '', invalidFlag ? 'yes' : 'no', pts]);
        });
      });
    });

    const csv = stringify(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="alpharush_${roomId}_answers.csv"`);
    return res.send(csv);
  } catch (e) {
    console.error('export error', e);
    return res.status(500).send('server error');
  }
});

/* health */
app.get('/health', (req,res)=> res.json({ ok:true }));

server.listen(PORT, ()=> console.log('Backend running on', PORT));
