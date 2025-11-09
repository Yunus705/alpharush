import React, { useState, useEffect } from "react";
import { io } from "socket.io-client";

const SERVER = process.env.REACT_APP_SERVER || (window.location.hostname === 'localhost' ? 'http://localhost:5000' : `http://${window.location.hostname}:5000`);
const socket = io(SERVER, { transports: ['websocket','polling'] });

export default function App() {
  const [name, setName] = useState("");
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);
  const [room, setRoom] = useState(null);
  const [letter, setLetter] = useState("-");
  const [round, setRound] = useState(0);
  const [answers, setAnswers] = useState({ Name: "", City: "", Thing: "", Animal: "" });
  const [players, setPlayers] = useState([]);
  const [roundResults, setRoundResults] = useState(null);
  const [gameOver, setGameOver] = useState(false);

  useEffect(() => {
    socket.on("roomUpdate", r => {
      setRoom(r);
      setPlayers(r.players || []);
    });
    socket.on("roundStarted", ({ round, letter }) => {
      setRound(round); setLetter(letter); setRoundResults(null);
    });
    socket.on("playerSubmitted", () => { /* optional */ });
    socket.on("roundScored", ({ round, roundScores, totals }) => {
      // map totals to display
      setRoundResults({ round, roundScores, totals });
    });
    socket.on("gameOver", ({ totals }) => {
      setGameOver(true);
      setRoundResults(null);
      setPlayers(totals);
    });
    return () => {
      socket.off("roomUpdate");
      socket.off("roundStarted");
      socket.off("playerSubmitted");
      socket.off("roundScored");
      socket.off("gameOver");
    };
  }, []);

  const createRoom = () => {
    if (!roomId || !name) return alert("Room & name required");
    socket.emit("createRoom", { roomId, name }, (res) => {
      if (res && res.ok) {
        setJoined(true); setRoom(res.room);
      } else if (res && res.error) alert(res.error);
    });
  };

  const joinRoom = () => {
    if (!roomId || !name) return alert("Room & name required");
    socket.emit("joinRoom", { roomId, name }, (res) => {
      if (res && res.ok) { setJoined(true); setRoom(res.room); }
      else if (res && res.error) alert(res.error);
    });
  };

  const startGame = () => { socket.emit("startGame", { roomId }); };
  const submit = () => {
    if (!round) return alert("No active round");
    socket.emit("submitAnswers", { roomId, round, answers }, res => {
      if (res && !res.ok) alert(res.error || "Submit failed");
    });
  };

  return (
    <div className="container">
      <div className="header">
        <h1>AlphaRush</h1>
        <div className="small">Round: {round} | Letter: {letter}</div>
      </div>

      <div className="card">
        {!joined ? (
          <div>
            <div style={{display:'flex', gap:8}}>
              <input className="input" placeholder="Your name" value={name} onChange={e=>setName(e.target.value)} />
              <input className="input" placeholder="Room id" value={roomId} onChange={e=>setRoomId(e.target.value)} />
            </div>
            <div style={{marginTop:10}}>
              <button className="btn btn-primary" onClick={createRoom}>Create Room</button>
              <button className="btn" style={{marginLeft:8}} onClick={joinRoom}>Join Room</button>
            </div>
          </div>
        ) : (
          <div>
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
              <div>
                <div className="small">Room: <strong>{roomId}</strong></div>
                <div className="small">Players:</div>
                <div className="players">
                  {players.map(p => <div key={p.socketId || p.name} className="playerChip">{p.name} ({p.score||0})</div>)}
                </div>
              </div>
              <div>
                <button className="btn btn-primary" onClick={startGame}>Start</button>
              </div>
            </div>

            <hr style={{margin:'12px 0', borderColor:'rgba(255,255,255,0.03)'}} />

            <div>
              <div className="small">Write answers starting with letter: <strong>{letter}</strong></div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginTop:8}}>
                <input className="input" placeholder="Name" value={answers.Name} onChange={e=>setAnswers(a=>({...a, Name:e.target.value}))} />
                <input className="input" placeholder="City" value={answers.City} onChange={e=>setAnswers(a=>({...a, City:e.target.value}))} />
                <input className="input" placeholder="Thing" value={answers.Thing} onChange={e=>setAnswers(a=>({...a, Thing:e.target.value}))} />
                <input className="input" placeholder="Animal" value={answers.Animal} onChange={e=>setAnswers(a=>({...a, Animal:e.target.value}))} />
              </div>

              <div style={{marginTop:10}}>
                <button className="btn btn-primary" onClick={submit}>Submit Answers</button>
              </div>
            </div>

            {roundResults && (
              <div style={{marginTop:16}}>
                <h3>Round {roundResults.round} Results</h3>
                <div>
                  {Object.entries(roundResults.roundScores || {}).map(([sid, pts]) => {
                    const p = players.find(x=>x.socketId===sid) || players.find(x=>x.id===sid) || { name: sid };
                    return <div key={sid}>{p.name}: {pts} pts</div>;
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{marginTop:12}} className="small">Note: This is a ready-to-run minimal UI. I can add a nicer theme, lobby chat, avatars, or host-controlled next-round behavior — tell me which you want next.</div>
    </div>
  );
}
