import React, { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';

// Auto-detect server (works for localhost and EC2 with public IP)
const SERVER = process.env.REACT_APP_SERVER || (window.location.hostname === 'localhost' ? 'http://localhost:5000' : `http://${window.location.hostname}:5000`);
const socket = io(SERVER, { transports: ['websocket','polling'] });

export default function App(){
  const [stage, setStage] = useState('home'); // home,lobby,playing,results,final
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [room, setRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [letter, setLetter] = useState('-');
  const [round, setRound] = useState(0);
  const [answers, setAnswers] = useState({ Name:'', City:'', Thing:'', Animal:'' });
  const [submitted, setSubmitted] = useState(false);
  const [grace, setGrace] = useState(0);
  const [roundResults, setRoundResults] = useState(null);
  const graceRef = useRef(null);
  const draftTimer = useRef(null);

  useEffect(() => {
    socket.on('roomUpdate', r => {
      setRoom(r);
      setPlayers(r.players || []);
      if(stage === 'home') setStage('lobby');
    });

    socket.on('roundStarted', ({ round, letter }) => {
      setRound(round);
      setLetter(letter);
      setStage('playing');
      setSubmitted(false);
      setRoundResults(null);
      setAnswers({ Name:'', City:'', Thing:'', Animal:'' });
      stopGrace();
    });

    socket.on('playerSubmitted', () => {
      if (!graceRef.current) startGraceCountdown();
    });

    socket.on('roundScored', payload => {
      setRoundResults(payload);
      setStage('results');
      stopGrace();
    });

    socket.on('gameOver', ({ totals }) => {
      setPlayers(totals);
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

  // Create / Join / Start
  function createRoom(){
    if(!roomId || !name) return alert('Room & name required');
    socket.emit('createRoom', { roomId, name }, res => {
      if(res?.ok) setStage('lobby');
      else alert(res?.error || 'Create failed');
    });
  }
  function joinRoom(){
    if(!roomId || !name) return alert('Room & name required');
    socket.emit('joinRoom', { roomId, name }, res => {
      if(res?.ok) setStage('lobby');
      else alert(res?.error || 'Join failed');
    });
  }
  function startGame(){
    if(!room) return;
    socket.emit('startGame', { roomId }, res => {
      if(!(res && res.ok)) alert(res?.error || 'Start failed');
    });
  }

  // handle input change + debounced updateAnswers
  function handleChange(field, val){
    setAnswers(a => ({ ...a, [field]: val }));

    if(draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      socket.emit('updateAnswers', { roomId, round, answers: { ...answers, [field]: val } });
      draftTimer.current = null;
    }, 250);
  }

  // explicit submit
  function submitAnswers(){
    if(submitted) return;
    socket.emit('submitAnswers', { roomId, round, answers }, res => {
      if(res?.ok) setSubmitted(true);
      else alert('Submit failed');
    });
    if(!graceRef.current) startGraceCountdown();
  }

  // grace countdown (starts when first submit occurs)
  function startGraceCountdown(){
    if(graceRef.current) return;
    setGrace(10);
    graceRef.current = setInterval(() => {
      setGrace(g => {
        if(g <= 1){
          clearInterval(graceRef.current);
          graceRef.current = null;
          // score the round (but do NOT advance)
          socket.emit('forceScore', { roomId, round });
          return 0;
        }
        return g-1;
      });
    }, 1000);
  }
  function stopGrace(){
    if(graceRef.current){ clearInterval(graceRef.current); graceRef.current = null; setGrace(0); }
  }

  function isHost(){
    return room && room.hostSocket === socket.id;
  }

  function nextRoundByHost(){
    socket.emit('nextRound', { roomId }, res => {
      if (res && !res.ok) alert(res.error || 'Next failed');
    });
  }

  function restart(){
    setStage('home'); setRoom(null); setPlayers([]); setRound(0); setLetter('-'); setRoundResults(null);
  }

  // host invalidation toggle
  function invalidateAnswer(targetSocketId, category, invalidate) {
    if (!room) return;
    socket.emit('invalidateAnswer', { roomId, round, targetSocketId, category, invalidate }, res => {
      if (res && !res.ok) alert(res.error || 'Action failed');
      // server will emit updated 'roundScored' and 'roomUpdate'
    });
  }

  // download CSV (host)
  async function downloadAnswersCSV() {
    try {
      const url = `${SERVER.replace(/\/$/, '')}/export/${roomId}`;
      const resp = await fetch(url);
      if (!resp.ok) return alert('Export failed');
      const blob = await resp.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `alpharush_${roomId}_answers.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
    } catch (e) {
      console.error(e);
      alert('Export error');
    }
  }

  // render UI
  return (
    <div className="container">
      <div className="header">
        <div>
          <h1>AlphaRush Arena</h1>
          <div className="small">Mobile-first • 26 rounds • Max players {process.env.REACT_APP_MAX_PLAYERS || 8}</div>
        </div>
        <div className="small">Round: <strong>{round}</strong> | Letter: <span className="score">{letter}</span></div>
      </div>

      <div className={ (stage === 'playing' || stage === 'results' || stage === 'lobby') ? 'game-with-leaderboard' : '' }>

        <div>
          {/* HOME */}
          {stage === 'home' && (
            <div className="card center" style={{ maxWidth:480, margin:'0 auto' }}>
              <input className="input" placeholder="Your name" value={name} onChange={e=>setName(e.target.value)} />
              <input className="input" placeholder="Room ID (like ABC1)" value={roomId} onChange={e=>setRoomId(e.target.value)} />
              <div style={{ display:'flex', gap:8, justifyContent:'center', marginTop:10 }}>
                <button className="btn btn-primary" onClick={createRoom}>Create Room</button>
                <button className="btn" onClick={joinRoom}>Join Room</button>
              </div>
            </div>
          )}

          {/* LOBBY */}
          {stage === 'lobby' && room && (
            <div className="card">
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <div className="small">Room</div>
                  <h2>{room.roomId}</h2>
                  <div className="small">Host: {room.players?.[0]?.name}</div>
                </div>

                <div>
                  <div className="small">Players</div>
                  <div className="players">
                    {players.map(p => <div key={p.socketId} className="playerChip">{p.name} <div className="small">({p.score||0})</div></div>)}
                  </div>
                </div>

                <div style={{ textAlign:'right' }}>
                  {isHost() ? <button className="btn btn-primary" onClick={startGame}>Start Game</button> : <div className="small">Waiting for host...</div>}
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

              <div style={{ marginTop:12, maxWidth:720, marginLeft:'auto', marginRight:'auto' }}>
                <div className="grid-2">
                  {['Name','City','Thing','Animal'].map(k => (
                    <input key={k} className="input" placeholder={k} value={answers[k]} onChange={e => handleChange(k, e.target.value)} />
                  ))}
                </div>

                <div style={{ display:'flex', justifyContent:'center', gap:8, marginTop:12 }}>
                  {!submitted ? <button className="btn btn-primary" onClick={submitAnswers}>Submit</button> : <div className="small">You submitted — waiting...</div>}
                  {grace > 0 && (
                    <div className="small" style={{ fontWeight:'bold', color:'#22c55e' }}>
                      Countdown: {grace}s
                    </div>
                  )}
                </div>

                <div className="timerBar"><div className="timerFill" style={{ width: `${(10 - grace) * 10}%` }} /></div>
              </div>
            </div>
          )}

          {/* RESULTS */}
          {stage === 'results' && roundResults && (
            <div className="card">
              <h2 className="center">Round {roundResults.round} Results</h2>
              <div style={{ marginTop:8 }}>
                <div style={{ display:'grid', gap:8 }}>
                  {roundResults.totals.map(p => {
                    const pts = (roundResults.roundScores && roundResults.roundScores[p.socketId]) || 0;
                    const ansObj = (roundResults.answers && roundResults.answers[p.socketId] && roundResults.answers[p.socketId].answers) || {};
                    return (
                      <div key={p.socketId} className="resultsGrid card" style={{ padding:10 }}>
                        <div>
                          <div style={{ fontWeight:700 }}>{p.name}</div>

                          {['Name','City','Thing','Animal'].map(k => {
                            const val = ansObj[k] || '-';
                            const invalidFlag = (roundResults.answers && roundResults.answers[p.socketId] && roundResults.answers[p.socketId].invalid && roundResults.answers[p.socketId].invalid[k]) || false;
                            return (
                              <div key={k} className="small" style={{ display:'flex', alignItems:'center', gap:8 }}>
                                <div style={{ textDecoration: invalidFlag ? 'line-through' : 'none', opacity: invalidFlag ? 0.55 : 1 }}>
                                  {k}: {val || '-'}
                                </div>

                                {isHost() && (val && val !== '-') && (
                                  <button
                                    className="btn"
                                    style={{ padding:'4px 8px', fontSize:12 }}
                                    onClick={() => invalidateAnswer(p.socketId, k, !invalidFlag)}
                                  >
                                    {invalidFlag ? 'Undo' : 'Invalidate'}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div style={{ textAlign:'right' }}>
                          <div className="score">{pts} pts</div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ display:'flex', justifyContent:'center', gap:8, marginTop:12 }}>
                  {isHost() ? <button className="btn btn-primary" onClick={nextRoundByHost}>Next Round (Host)</button> : <div className="small">Waiting for host to continue...</div>}
                </div>
              </div>
            </div>
          )}

          {/* FINAL */}
          {stage === 'final' && (
            <div className="card center">
              <h2>🏆 Final Leaderboard</h2>
              <div className="leaderboard" style={{ marginTop:10 }}>
                {players.slice().sort((a,b)=>b.score - a.score).map((p,i)=>(
                  <div key={p.name} className="leaderboard-item">
                    <div className="rank">#{i+1}</div>
                    <div className="name">{p.name}</div>
                    <div className="points">{p.score} pts</div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop:12 }}>
                <button className="btn" onClick={restart}>Exit / Restart</button>
                {isHost() && <button className="btn btn-primary" onClick={downloadAnswersCSV} style={{ marginLeft: 8 }}>Download Answers CSV</button>}
              </div>
            </div>
          )}
        </div>

        {/* LIVE LEADERBOARD */}
        <div>
          {(stage === 'lobby' || stage === 'playing' || stage === 'results') && (
            <div className="leaderboard" style={{ position: 'sticky', top: 80 }}>
              <h3>Leaderboard</h3>
              {players.slice().sort((a,b)=>b.score - a.score).map((p,i) => (
                <div key={p.socketId || p.name} className="leaderboard-item" title={`${p.name}`}>
                  <div className="rank">{i+1}</div>
                  <div className="name">{p.name}</div>
                  <div className="points">{p.score || 0} pts</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop:12 }} className="small center">AlphaRush Arena — play on mobile or desktop</div>
    </div>
  );
}
