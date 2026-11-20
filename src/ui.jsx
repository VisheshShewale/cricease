import React, { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';

const SERVER_URL = (import.meta.env.VITE_SERVER_URL || '').replace(/\/$/, '');
const apiFetch = (pathname, options) => fetch(`${SERVER_URL}${pathname}`, options);
const socket = io(SERVER_URL || undefined);
const roleList = ['Batter', 'Bowler', 'All-rounder', 'Wicketkeeper'];
const money = n => `${n} cr`;
const getInitialCode = () => new URLSearchParams(location.search).get('room')?.toUpperCase() || '';

export default function AuctionApp() {
  const [room, setRoom] = useState(null);
  const [hostSecret, setHostSecret] = useState(localStorage.getItem('creaseHostSecret') || '');
  const [isHost, setIsHost] = useState(false);
  const [teamId, setTeamId] = useState(sessionStorage.getItem('creaseTeamId') || '');
  const [captain, setCaptain] = useState('');
  const [roomCode, setRoomCode] = useState(getInitialCode());
  const [lanAddress, setLanAddress] = useState('');
  const [clientPort, setClientPort] = useState(5173);
  const [setup, setSetup] = useState({ hostName: '', format: 'T20', teamCount: 4, purse: 100, squadSize: 15, xiSize: 11, minimumBid: 1, bidIncrement: 1, timerSeconds: 20, playerCount: 100, roleLimits: { Batter: 7, Bowler: 7, 'All-rounder': 5, Wicketkeeper: 2 } });
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [bestXi, setBestXi] = useState(null);
  const [teamName, setTeamName] = useState('');
  const [bidAmount, setBidAmount] = useState(0);
  const [playerFile, setPlayerFile] = useState(null);

  useEffect(() => {
    socket.on('room:update', setRoom);
    socket.on('action:error', setError);
    socket.on('team:disconnected', () => setNotice('Your team opened on another device. This device is now read-only.'));
    return () => { socket.off('room:update'); socket.off('action:error'); socket.off('team:disconnected'); };
  }, []);
  useEffect(() => {
    apiFetch('/api/network-info').then(r => r.ok ? r.json() : null).then(info => {
      if (info?.addresses?.length) setLanAddress(info.addresses[0]);
      if (info?.clientPort) setClientPort(info.clientPort);
    }).catch(() => {});
  }, []);
  useEffect(() => { const clear = () => { setError(''); setNotice(''); }; document.addEventListener('clear-feedback', clear); return () => document.removeEventListener('clear-feedback', clear); }, []);
  useEffect(() => {
    if (!roomCode) return;
    const savedSecret = localStorage.getItem(`crease:${roomCode}:host`);
    if (savedSecret) socket.emit('room:reconnect-host', { code: roomCode, hostSecret: savedSecret }, res => {
      if (res?.room) { setRoom(res.room); setHostSecret(savedSecret); setIsHost(true); }
    });
    apiFetch(`/api/room/${roomCode}`).then(r => r.ok ? r.json() : null).then(data => { if (data) setRoom(data); }).catch(() => {});
    const savedTeam = sessionStorage.getItem(`crease:${roomCode}:team`);
    if (savedTeam) setTeamId(savedTeam);
  }, [roomCode]);
  useEffect(() => {
    if (!room?.code || isHost) return;
    const savedTeam = sessionStorage.getItem(`crease:${room.code}:team`);
    const savedCaptain = sessionStorage.getItem(`crease:${room.code}:captain`);
    if (savedTeam && savedCaptain) socket.emit('room:join', { code: room.code, teamId: savedTeam, captain: savedCaptain }, res => {
      if (res?.room) { setTeamId(savedTeam); setRoom(res.room); }
    });
  }, [room?.code, isHost]);
  useEffect(() => {
    if (room?.currentPlayerId && room.currentBid) setBidAmount(room.currentBid.amount + room.config.bidIncrement);
    else if (currentPlayer) setBidAmount(Math.max(currentPlayer.basePrice, room.config.minimumBid));
  }, [room?.currentPlayerId, room?.currentBid?.amount]);

  const currentPlayer = room?.players.find(p => p.id === room.currentPlayerId);
  const myTeam = room?.teams.find(t => t.id === teamId);
  const isLoopbackHost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const inviteOrigin = isLoopbackHost && lanAddress ? `http://${lanAddress}:${clientPort}` : location.origin;
  const inviteUrl = `${inviteOrigin}${location.pathname}?room=${room?.code || ''}`;
  const connectedCount = room?.teams.filter(t => t.captain).length || 0;
  const bidWinner = room?.teams.find(t => t.id === room?.currentBid?.teamId);
  const timeLeft = useTimer(room?.bidEndsAt);

  function invoke(event, data) {
    return new Promise(resolve => socket.emit(event, data, res => {
      if (res?.error) { setError(res.error); resolve(false); }
      else { setError(''); resolve(res || true); }
    }));
  }
  async function createRoom(e) {
    e.preventDefault(); setBusy('Creating your room');
    const res = await invoke('room:create', setup);
    if (res?.room) {
      setRoom(res.room); setRoomCode(res.room.code); setHostSecret(res.hostSecret); setIsHost(true);
      localStorage.setItem(`crease:${res.room.code}:host`, res.hostSecret); localStorage.setItem('creaseHostSecret', res.hostSecret);
      history.replaceState(null, '', `?room=${res.room.code}`);
      if (res.room.config.format === 'ODI') {
        setBusy('Adding the included ODI players');
        try {
          const fileResponse = await fetch('/odi-100-player-pool.csv');
          if (!fileResponse.ok) throw new Error('The included ODI player list could not be loaded.');
          const players = parsePlayerList(await fileResponse.text());
          const response = await apiFetch(`/api/rooms/${res.room.code}/players/import`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-host-secret': res.hostSecret },
            body: JSON.stringify({ players })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Could not add the ODI player list.');
          setRoom({ ...res.room, players: data.players });
          setNotice('The 100-player ODI pool is ready. Every base price is 0.');
          setError('');
        } catch (error) { setError(error.message); }
      }
    }
    setBusy('');
  }
  async function joinTeam(id) {
    const res = await invoke('room:join', { code: room.code, teamId: id, captain });
    if (res?.teamId) { setTeamId(res.teamId); sessionStorage.setItem(`crease:${room.code}:team`, res.teamId); setNotice('You joined the auction.'); }
  }
  async function generatePlayers() {
    setBusy('Creating player pool');
    try {
      const response = await apiFetch(`/api/rooms/${room.code}/players/generate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-host-secret': hostSecret }, body: JSON.stringify({ count: setup.playerCount }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not generate player pool.');
      setNotice(`${data.players.length} players added to the pool.`);
    } catch (e) { setError(e.message); }
    setBusy('');
  }
  async function importPlayerList() {
    if (!playerFile) return setError('Choose a .csv or .txt player list first.');
    setBusy('Importing player list');
    try {
      const players = parsePlayerList(await playerFile.text());
      const data = await savePlayerList(players);
      setPlayerFile(null);
      setNotice(`${data.players.length} players imported. Every base price is 0.`);
      setError('');
    } catch (e) { setError(e.message); }
    setBusy('');
  }
  async function loadIncludedPlayers() {
    setBusy('Loading ODI player pool');
    try {
      const response = await fetch('/odi-100-player-pool.csv');
      if (!response.ok) throw new Error('The included ODI player list could not be loaded.');
      const data = await savePlayerList(parsePlayerList(await response.text()));
      setNotice(`${data.players.length} ODI players added. Every base price is 0.`);
      setError('');
    } catch (e) { setError(e.message); }
    setBusy('');
  }
  async function savePlayerList(players) {
    if (!players.length) throw new Error('No player names were found. Use one name per line or a CSV with a name column.');
    if (players.length > 150) throw new Error('Import up to 150 players at a time.');
    const response = await apiFetch(`/api/rooms/${room.code}/players/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-host-secret': hostSecret },
      body: JSON.stringify({ players })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not import player list.');
    return data;
  }
  async function doBestXi(team) {
    setBusy(`Choosing ${team.name}’s XI`); setBestXi(null);
    try {
      const response = await apiFetch(`/api/rooms/${room.code}/teams/${team.id}/best-xi`, { method: 'POST' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not select a playing XI.');
      setBestXi({ teamId: team.id, ...data }); setError('');
    } catch (e) { setError(e.message); }
    setBusy('');
  }
  async function renameTeam() { if (teamName.trim()) await invoke('host:rename-team', { code: room.code, teamId: myTeam.id, name: teamName }); setTeamName(''); }
  const statusCounts = useMemo(() => (room?.players || []).reduce((o, p) => (o[p.status] = (o[p.status] || 0) + 1, o), {}), [room?.players]);
  const remaining = (team) => room.config.purse - team.players.reduce((sum, p) => sum + p.soldPrice, 0);
  const nextBid = currentPlayer ? (room.currentBid ? room.currentBid.amount + room.config.bidIncrement : Math.max(currentPlayer.basePrice, room.config.minimumBid)) : 0;
  const canBid = myTeam && currentPlayer && room.status === 'live' && timeLeft > 0 && myTeam.id !== room.currentBid?.teamId && bidAmount === nextBid && remaining(myTeam) >= nextBid + Math.max(0, room.config.squadSize - myTeam.players.length - 1) * room.config.minimumBid;

  if (!room) return <main className="landing"><header className="brand"><div className="mark">C</div><span>CREASE</span><small>CRICKET AUCTION ROOM</small></header><section className="hero"><p className="eyebrow">YOUR DRAFT. YOUR RULES.</p><h1>Build a team<br/><em>worth cheering for.</em></h1><p className="lead">A live cricket auction for your crew. Host the room, invite your friends, and let the bidding begin.</p></section><section className="entry-grid"><form className="panel create-panel" onSubmit={createRoom}><p className="eyebrow">HOST A ROOM</p><h2>Set up your auction</h2><div className="form-grid"><label>Host name<input value={setup.hostName} onChange={e => setSetup({ ...setup, hostName: e.target.value })} required placeholder="Captain's name"/></label><label>Cricket format<select value={setup.format} onChange={e => setSetup({ ...setup, format: e.target.value })}><option>T20</option><option>ODI</option><option>Test</option></select></label><label>Number of teams<input type="number" min="2" max="16" value={setup.teamCount} onChange={e => setSetup({ ...setup, teamCount: +e.target.value })}/></label><label>Purse per team<input type="number" min="10" value={setup.purse} onChange={e => setSetup({ ...setup, purse: +e.target.value })}/></label><label>Squad size<input type="number" min="11" max="30" value={setup.squadSize} onChange={e => setSetup({ ...setup, squadSize: +e.target.value })}/></label><label>Bid timer (seconds)<input type="number" min="10" max="180" value={setup.timerSeconds} onChange={e => setSetup({ ...setup, timerSeconds: +e.target.value })}/></label><label>Bid increment<input type="number" min="1" value={setup.bidIncrement} onChange={e => setSetup({ ...setup, bidIncrement: +e.target.value })}/></label><label>Players to generate<input type="number" min="12" max="150" value={setup.playerCount} onChange={e => setSetup({ ...setup, playerCount: +e.target.value })}/></label><label>Minimum bid<input type="number" min="1" value={setup.minimumBid} onChange={e => setSetup({ ...setup, minimumBid: +e.target.value })}/></label></div><fieldset className="limits-field"><legend>MAX PLAYERS PER ROLE</legend><div className="role-limit-grid">{roleList.map(role=><label key={role}>{role}<input type="number" min="1" max={setup.squadSize} value={setup.roleLimits[role]} onChange={e=>setSetup({...setup,roleLimits:{...setup.roleLimits,[role]:+e.target.value}})}/></label>)}</div></fieldset><button className="primary wide" disabled={!!busy}>{busy || 'Create auction room'} <span>↗</span></button></form><form className="panel join-panel" onSubmit={e => { e.preventDefault(); const code = roomCode.trim().toUpperCase(); setRoomCode(code); fetch(`/api/room/${code}`).then(r => r.ok ? r.json() : null).then(data => { if (data) { setRoom(data); setError(''); } else setError('Room code not found.'); }).catch(() => setError('Room code not found.')); }}><p className="eyebrow">JOIN YOUR CREW</p><h2>Got a room code?</h2><label>Room code<input value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase())} maxLength="6" placeholder="e.g. A4K9Q2"/></label><button className="secondary wide">Find my room <span>→</span></button><p className="hint">Ask the host for their six-character code or scan the invite QR.</p></form></section><Feedback error={error} notice={notice}/><footer>CREATED FOR THE LOVE OF THE GAME <span>●</span> BUILT TO PLAY TOGETHER</footer></main>;

  return <main className="app-shell"><header className="topbar"><a className="brand compact" href="/"><div className="mark">C</div><span>CREASE</span></a><div className="room-tag"><span className="live-dot"/> {room.status === 'live' ? 'LIVE AUCTION' : room.status === 'finished' ? 'AUCTION COMPLETE' : 'ROOM SETUP'} <b>{room.code}</b></div><div className="top-meta">{room.config.format} <i/> {room.teams.length} TEAMS <i/> {money(room.config.purse)} PURSE</div></header>
  <div className="dashboard"><section className="auction-main"><div className="section-heading"><div><p className="eyebrow">{room.status === 'setup' ? 'GET THE ROOM READY' : 'THE AUCTION FLOOR'}</p><h1>{room.status === 'setup' ? 'Welcome to the room.' : 'Every bid counts.'}</h1></div>{isHost && <div className="host-chip"><span>✦</span> HOST DESK</div>}</div>
  {room.status === 'setup' && isHost && <div className="setup-board"><div className="invite-card"><div><p className="eyebrow">SCAN TO JOIN</p><strong>Bring your captains in.</strong><p>Scan from a phone on the same Wi-Fi. Invite link: <code>{inviteOrigin}</code></p><div className="code-box"><span>ROOM CODE</span><b>{room.code}</b><button onClick={() => navigator.clipboard?.writeText(room.code)}>COPY</button></div></div><div className="qr-frame"><QRCodeSVG value={inviteUrl} size={136} level="M"/><span>CREASE AUCTION</span></div></div><div className="pool-card"><p className="eyebrow">PLAYER POOL</p><strong>{room.players.length ? `${room.players.length} players ready` : 'Make your player list'}</strong><p>Load the included ODI list at zero base price, or import your own file.</p><button className="primary wide" onClick={loadIncludedPlayers} disabled={!!busy}>{busy || "Load included ODI player pool"} ✦</button><label className="compact-label">Player list (.csv or .txt)<input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={e=>setPlayerFile(e.target.files?.[0] || null)}/></label><button className="secondary wide" onClick={importPlayerList} disabled={!!busy || !playerFile}>Import selected list</button><label className="compact-label">Number of players<input type="number" min="12" max="150" value={setup.playerCount} onChange={e => setSetup({ ...setup, playerCount: +e.target.value })}/></label><button className="primary" onClick={generatePlayers} disabled={!!busy}>{busy || (room.players.length ? 'Regenerate pool' : 'Generate players')} ✦</button></div></div>}
  {room.status === 'setup' && !isHost && myTeam && <div className="joined-note"><span className="live-dot"/> You are in as <b>{myTeam.name}</b>. Waiting for the host to start.</div>}
  {room.status === 'setup' && !isHost && !myTeam && <div className="panel join-choice"><p className="eyebrow">ROOM {room.code}</p><h2>Choose your team</h2><p>Enter your captain name, then take the seat you'd like.</p><label>Your name<input value={captain} onChange={e => setCaptain(e.target.value)} placeholder="Captain name"/></label><div className="team-choices">{room.teams.map(t => <button key={t.id} disabled={!!t.captain} onClick={() => joinTeam(t.id)}><span>{t.name}</span><small>{t.captain ? `${t.captain} joined` : 'OPEN SEAT →'}</small></button>)}</div></div>}
  {room.status === 'live' && <div className="current-auction"><div className="auction-label"><span className="live-dot"/> NOW ON THE BLOCK <span>LOT {String(room.soldLog.length + (currentPlayer ? 1 : 0)).padStart(2, '0')}</span></div>{currentPlayer ? <><div className="player-stage"><div className="player-orb"><span>{currentPlayer.name.split(' ').map(s=>s[0]).join('').slice(0,2).toUpperCase()}</span><small>RATING {currentPlayer.rating}</small></div><div className="player-info"><span className="role-pill">{currentPlayer.role}</span><h2>{currentPlayer.name}</h2><p>{currentPlayer.country} <i/> {currentPlayer.battingStyle}</p><div className="base-price">BASE PRICE <b>{money(currentPlayer.basePrice)}</b></div></div><div className={`timer ${timeLeft <= 5 ? 'urgent' : ''}`}><span>GOING IN</span><strong>{String(timeLeft).padStart(2,'0')}</strong><small>SECONDS</small></div></div><div className="bid-strip"><div><span>HIGHEST BID</span><strong>{room.currentBid ? money(room.currentBid.amount) : '—'}</strong><small>{bidWinner ? `${bidWinner.name} · ${bidWinner.captain || 'Captain'}` : 'No bids yet'}</small></div>{isHost && <div className="host-actions"><button className="secondary" onClick={() => invoke('host:close-bidding',{code:room.code,outcome:'unsold'})}>Pass player</button><button className="primary" onClick={() => invoke('host:close-bidding',{code:room.code,outcome:'sold'})} disabled={!room.currentBid}>SOLD ✓</button></div>}</div></> : <div className="waiting-stage"><div className="radar">✦</div><h2>Ready for the next name?</h2><p>Host can nominate a player from the pool.</p></div>}{myTeam && currentPlayer && <div className="mobile-bid"><label>Your next offer<input type="number" value={bidAmount} min={nextBid} onChange={e => setBidAmount(+e.target.value)}/></label><button className="primary" disabled={!canBid || teamId === room.currentBid?.teamId} onClick={() => invoke('team:bid',{code:room.code,amount:bidAmount})}>{teamId === room.currentBid?.teamId ? 'YOU’RE LEADING' : `BID ${money(nextBid)}`}</button></div>}</div>}
  {room.status === 'finished' && <div className="waiting-stage"><div className="radar">✓</div><h2>The auction is complete.</h2><p>Review your squad and get a coach’s take on your best XI.</p></div>}
  {isHost && room.status === 'setup' && <div className="start-row"><span>{connectedCount} of {room.teams.length} captains joined · {room.players.length} players in pool</span><button className="primary" onClick={() => invoke('host:start',{code:room.code})} disabled={connectedCount < 2 || !room.players.length}>Start the auction <span>→</span></button></div>}
  {isHost && room.status === 'live' && <div className="nomination-bar"><div><p className="eyebrow">AUTOMATIC PLAYER QUEUE</p><strong>{statusCounts.available || 0} players remaining</strong><p>The next player appears automatically after each player is sold or passed.</p></div><button className="finish-link" onClick={() => invoke('host:finish',{code:room.code})}>Finish auction</button></div>}
  <div className="team-section"><div className="team-head"><div><p className="eyebrow">THE FRANCHISES</p><h2>Meet the squads <span>{connectedCount}/{room.teams.length} in room</span></h2></div><div className="pool-stats"><b>{statusCounts.sold || 0}</b> SOLD <i/> <b>{statusCounts.available || 0}</b> LEFT</div></div><div className="team-grid">{room.teams.map((team, index) => <TeamCard key={team.id} team={team} index={index} purse={room.config.purse} mine={team.id===teamId} isHost={isHost} bestXi={bestXi?.teamId===team.id?bestXi:null} onBest={() => doBestXi(team)}/>)}</div></div></section>
  <aside className="side-rail"><section className="side-card"><div className="side-head"><span className="eyebrow">AUCTION RULES</span><span>⚙</span></div><div className="rule-row"><span>Format</span><b>{room.config.format} cricket</b></div><div className="rule-row"><span>Team purse</span><b>{money(room.config.purse)}</b></div><div className="rule-row"><span>Squad size</span><b>{room.config.squadSize} players</b></div><div className="rule-row"><span>Bid step</span><b>{money(room.config.bidIncrement)}</b></div><div className="role-rules"><p>ROLE LIMITS</p><div>{roleList.map(r=><span key={r}>{r}<b>{room.config.roleLimits?.[r] || '—'}</b></span>)}</div></div></section><section className="side-card activity"><div className="side-head"><span className="eyebrow">LATEST MOVES</span><span>↗</span></div>{room.soldLog.length ? room.soldLog.slice(0,7).map((x,i)=><div className="move" key={`${x.player}-${i}`}><span className={x.team?'move-dot':'move-dot pass'}/><div><b>{x.player}</b><small>{x.team?`to ${x.team}`:'went unsold'}</small></div><strong>{x.price?money(x.price):'PASS'}</strong></div>):<div className="empty-moves">No players sold yet.<br/>The action will show here.</div>}</section>{myTeam && <section className="my-seat"><span className="eyebrow">YOUR SEAT</span><b>{myTeam.name}</b><small>{myTeam.captain}</small><div className="seat-bottom"><span>{myTeam.players.length}/{room.config.squadSize} players</span><b>{money(remaining(myTeam))}</b></div><div className="rename"><input placeholder="Rename your team" value={teamName} onChange={e=>setTeamName(e.target.value)}/><button onClick={renameTeam} disabled={!teamName}>↗</button></div></section>}</aside></div><Feedback error={error} notice={notice}/><footer>CREASE <span>●</span> THE GAME IS BETTER TOGETHER</footer></main>;
}

function useTimer(deadline) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id=setInterval(()=>setNow(Date.now()),250); return ()=>clearInterval(id); }, []);
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}
function parsePlayerList(text) {
  const pipePlayers = String(text).split(/\r?\n/).map(line => {
    const match = line.match(/^\s*#\s*\d+\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)/);
    if (!match) return null;
    const [, set, name, country, specialty] = match.map(value => value?.trim());
    return {
      name, country, role: roleFromSpecialty(specialty), basePrice: 0,
      note: 'Imported ' + set + ' | ' + specialty
    };
  }).filter(Boolean);
  if (pipePlayers.length) return pipePlayers;

  const rows = parseCsvRows(text).filter(row => row.some(cell => cell.trim()));
  if (!rows.length) return [];
  const headers = rows[0].map(cell => cell.trim().toLowerCase().replace(/[^a-z]/g, ''));
  const nameColumn = headers.findIndex(value => ['name', 'player', 'playername'].includes(value));
  const hasHeader = nameColumn >= 0;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const column = (row, names, fallback) => {
    const index = hasHeader ? headers.findIndex(value => names.includes(value)) : fallback;
    return index >= 0 ? (row[index] || '').trim() : '';
  };
  return dataRows.map((row, index) => ({
    name: column(row, ['name', 'player', 'playername'], 0),
    role: column(row, ['role', 'position'], 1),
    country: column(row, ['country', 'team', 'nation'], 2),
    battingStyle: column(row, ['battingstyle'], 3),
    bowlingStyle: column(row, ['bowlingstyle'], 4),
    rating: column(row, ['rating'], 5),
    basePrice: 0,
    note: column(row, ['note', 'specialty', 'roleorspecialty'], hasHeader ? -1 : 6) || ('Imported from player list #' + (index + 1))
  })).filter(player => player.name);
}
function roleFromSpecialty(specialty = '') {
  const text = specialty.toLowerCase();
  if (/all[\s-]?rounder/.test(text)) return 'All-rounder';
  if (/wicket.?keeper|\bwk\b/.test(text)) return 'Wicketkeeper';
  if (/bowler|fast|spin|seam|swing|express|wrist|off-spin|leg-spin|orthodox|cutters|death/.test(text)) return 'Bowler';
  return 'Batter';
}
function parseCsvRows(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const input = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function TeamCard({team,index,purse,mine,isHost,bestXi,onBest}) {
  const spent=team.players.reduce((n,p)=>n+p.soldPrice,0); const percent=Math.min(100,spent/purse*100);
  return <article className={`team-card team-${index%4} ${mine?'is-mine':''}`}><div className="team-card-head"><div className="team-emblem">{team.name.slice(0,1).toUpperCase()}</div><div><h3>{team.name}</h3><span>{team.captain || (team.socketId?'Joined':'Waiting for captain')}</span></div>{mine&&<small className="you-pill">YOU</small>}</div><div className="purse-line"><span>PURSE LEFT</span><b>{money(purse-spent)}</b></div><div className="purse-track"><i style={{width:`${percent}%`}}/></div><div className="squad-mini"><span>{team.players.length} PLAYERS</span><span>{roleList.map(r=>{const count=team.players.filter(p=>p.role===r).length;return count?`${count} ${r[0]}`:null}).filter(Boolean).join(' · ')||'Empty squad'}</span></div>{team.players.length>0&&<div className="player-chips">{team.players.map(p=><span key={p.id}>{p.name}<b>{money(p.soldPrice)}</b></span>)}</div>}{team.players.length>=11&&<button className="xi-button" onClick={onBest} disabled={!team.captain}>✦ Find best XI</button>}{bestXi&&<div className="xi-result"><b>COACH’S XI</b><p>{bestXi.summary}</p><span>{bestXi.playerIds.map(id=>team.players.find(p=>p.id===id)?.name).join(' · ')}</span><small>Captain: {team.players.find(p=>p.id===bestXi.captainId)?.name || '—'} · Vice captain: {team.players.find(p=>p.id===bestXi.viceCaptainId)?.name || '—'}</small></div>}</article>
}
function Feedback({error,notice}) { if(!error&&!notice)return null; return <div className={`feedback ${error?'has-error':''}`} role="status">{error||notice}<button onClick={()=>{document.dispatchEvent(new CustomEvent('clear-feedback'))}}>×</button></div>; }
