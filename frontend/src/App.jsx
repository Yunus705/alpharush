import React, { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';

const SERVER =
  process.env.REACT_APP_SERVER ||
  (window.location.hostname === 'localhost'
    ? 'http://localhost:5000'
    : `http://${window.location.hostname}:5000`);
const socket = io(SERVER, { transports: ['websocket', 'polling'] });

export default function App() {
  const [stage, setStage] = useState('home');
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [room, setRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [letter, setLetter] = useState('-');
  const [round, setRound] = useState(0);
  const [answers, setAnswers] = useState({ Name: '', City: '', Thing: '', Animal: '' });
  const [submitted, setSubmitted] = useState(false);
  const [grace, setGrace] = useState(0);
  const graceRef = useRef(null);
  const [roundResults, setRoundResults] = useState(null);
  const [gameOver, setGameOver] = useState(false);

  useEffect(() => {
    socket.on('roomUpdate', (r) => {
      setRoom(r);
      setPlayers(r.players || []);
      if (stage === 'home') setStage('lobby');
    });
    socket.on('roundStarted', ({ round, letter }) => {
      setRound(round);
      setLetter(letter);
      setStage('playing');
      setSubmitted(false);
      setRoundResults(null);
      setAnswers({ Name: '', City: '', Thing: '', Animal: '' });
      stopGrace();
    });
    socket.on('playerSubmitted', () => {
      if (!graceRef.current) startGraceCountdown();
    });
    socket.on('roundScored', (payload) => {
      setRoundResults(payload);
      setStage('results');
    });
    socket.on('gameOver', ({ totals }) => {
      setPlayers(totals);
      setGameOver(true);
      setStage('final');
    });

    return () => {
      socket.off('roomUpdate');
      socket.off('roundStarted');
      socket.off('playerSubmitted');
      socket.off('roundScored');
      socket.off('gameOver');
    };
  }, [stage]);

  function createRoom() {
    if (!roomId || !name) return alert('Room & name required');
    socket.emit('createRoom', { roomId, name }, (res) => {
      if (res && res.ok) {
        setStage('lobby');
        setRoom(res.room);
      } else alert(res?.error || 'Create failed');
    });
  }

  function joinRoom() {
    if (!roomId || !name) return alert('Room & name required');
    socket.emit('joinRoom', { roomId, name }, (res) => {
      if (res && res.ok) {
        setStage('lobby');
        setRoom(res.room);
      } else alert(res?.error || 'Join failed');
    });
  }

  function startGame() {
    if (!room) return;
    socket.emit('startGame', { roomId }, (res) => {
      if (!(res && res.ok)) alert(res?.error || 'Start failed');
    });
  }

  function submitAnswers() {
    if (submitted) return;
    socket.emit('submitAnswers', { roomId, round, answers }, (res) => {
      if (res && res.ok) setSubmitted(true);
      else alert('submit failed');
    });
    if (!graceRef.current) startGraceCountdown();
  }

  function startGraceCountdown() {
    setGrace(10);
    graceRef.current = setInterval(() => {
      setGrace((g) => {
        if (g <= 1) {
          clearInterval(graceRef.current);
          graceRef.current = null;
          socket.emit('forceScore', { roomId, round });
          return 0;
        }
        return g - 1;
      });
    }, 1000);
  }

  function stopGrace() {
    if (graceRef.current) {
      clearInterval(graceRef.current);
      graceRef.current = null;
      setGrace(0);
    }
  }

  function isHost() {
    return room && room.hostSocket === socket.id;
  }

  function restart() {
    setStage('home');
    setRoom(null);
    setPlayers([]);
    setRound(0);
    setLetter('-');
    setGameOver(false);
  }

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1>AlphaRush Arena</h1>
          <div className="small">
            Mobile-first • 26 rounds • Max players {process.env.REACT_APP_MAX_PLAYERS || 8}
          </div>
        </div>
        <div className="small">
          Round: <strong>{round}</strong> | Letter:{' '}
          <span className="score">{letter}</span>
        </div>
      </div>

      {/* HOME */}
      {stage === 'home' && (
        <div className="card center" style={{ maxWidth: 480, margin: '0 auto' }}>
          <input
            className="input"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="input"
            placeholder="Room ID (like ABC1)"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 10 }}>
            <button className="btn btn-primary" onClick={createRoom}>
              Create Room
            </button>
            <button className="btn" onClick={joinRoom}>
              Join Room
            </button>
          </div>
          <div className="small" style={{ marginTop: 8 }}>
            Share Room ID with friends. Open this page on mobile or desktop.
          </div>
        </div>
      )}

      {/* LOBBY */}
      {stage === 'lobby' && room && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div className="small">Room</div>
              <h2>{room.roomId}</h2>
              <div className="small">
                Host: {room.players && room.players[0] ? room.players[0].name : ''}
              </div>
            </div>
            <div>
              <div className="small">Players</div>
              <div className="players">
                {players.map((p) => (
                  <div key={p.socketId || p.name} className="playerChip">
                    {p.name} <div className="small">({p.score || 0})</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              {isHost() ? (
                <button className="btn btn-primary" onClick={startGame}>
                  Start Game
                </button>
              ) : (
                <div className="small">Waiting for host to start</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* PLAYING */}
      {stage === 'playing' && (
        <div className="card center">
          <div>
            <div className="roundBadge small">Round {round} / 26</div>
            <div className="bigLetter">{letter}</div>
          </div>
          <div style={{ marginTop: 12, maxWidth: 720, marginLeft: 'auto', marginRight: 'auto' }}>
            <div className="grid-2">
              {['Name', 'City', 'Thing', 'Animal'].map((key) => (
                <input
                  key={key}
                  className="input"
                  placeholder={key}
                  value={answers[key]}
                  onChange={(e) => setAnswers((a) => ({ ...a, [key]: e.target.value }))}
                />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 }}>
              {!submitted ? (
                <button className="btn btn-primary" onClick={submitAnswers}>
                  Submit
                </button>
              ) : (
                <div className="small">You submitted — waiting...</div>
              )}
              {grace > 0 && <div className="small">Grace: {grace}s</div>}
            </div>
            <div className="timerBar">
              <div className="timerFill" style={{ width: `${(10 - grace) * 10}%` }}></div>
            </div>
          </div>
        </div>
      )}

      {/* RESULTS */}
      {stage === 'results' && roundResults && (
        <div className="card">
          <div className="center">
            <h2>Round {roundResults.round} Results</h2>
          </div>
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'grid', gap: 8 }}>
              {roundResults.totals.map((p) => {
                const pts = (roundResults.roundScores && roundResults.roundScores[p.socketId]) || 0;
                const ansObj =
                  (roundResults.answers &&
                    roundResults.answers[p.socketId] &&
                    roundResults.answers[p.socketId].answers) ||
                  {};
                return (
                  <div key={p.socketId} className="resultsGrid card" style={{ padding: 10 }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{p.name}</div>
                      <div className="small">Name: {ansObj.Name || '-'}</div>
                      <div className="small">City: {ansObj.City || '-'}</div>
                      <div className="small">Thing: {ansObj.Thing || '-'}</div>
                      <div className="small">Animal: {ansObj.Animal || '-'}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="score">{pts} pts</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 }}>
              {isHost() ? (
                <button className="btn btn-primary" onClick={() => socket.emit('forceScore', { roomId, round })}>
                  Next Round (Host)
                </button>
              ) : (
                <div className="small">Waiting for host to continue...</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* FINAL */}
      {stage === 'final' && (
        <div className="card center">
          <h2>🏆 Final Leaderboard 🏆</h2>
          <div className="leaderboard">
            {players
              .slice()
              .sort((a, b) => b.score - a.score)
              .map((p, i) => (
                <div key={p.name} className="leaderboard-item">
                  <span className="rank">#{i + 1}</span>
                  <span className="name">{p.name}</span>
                  <span className="points">{p.score} pts</span>
                </div>
              ))}
          </div>
          <button className="btn" onClick={restart} style={{ marginTop: 12 }}>
            Exit / Home
          </button>
        </div>
      )}

      <div style={{ marginTop: 12 }} className="small center">
        AlphaRush Arena — play on mobile or desktop
      </div>
    </div>
  );
}
