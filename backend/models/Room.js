// backend/models/Room.js
const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  socketId: String,
  name: String,
  score: { type: Number, default: 0 },
  lastSubmitAt: Date,
  answers: { type: Object, default: {} }
});

const roomSchema = new mongoose.Schema({
  roomId: { type: String, unique: true },
  password: { type: String, default: '' },
  hostSocket: String,
  players: [playerSchema],
  round: { type: Number, default: 0 },
  usedLetters: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Room', roomSchema);
