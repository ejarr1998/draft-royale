const socket = io();
let myName = '', myLobbyId = null, mySocketId = null, mySessionId = null, isHost = false;
let currentFilter = 'all', currentPosFilter = 'all', availablePlayers = [], draftTimerInterval = null;
let draftGames = [], currentGameFilter = 'all';
let lobbyState = null, amIDrafting = false, draftOrderList = [];

// Session management - persists across refreshes AND tab closes
function getSessionId() {
  // Use localStorage so session survives tab close/reopen
  let sid = localStorage.getItem('dr_sessionId');
  if (!sid) {
    sid = 'ses_' + Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
    localStorage.setItem('dr_sessionId', sid);
  }
  return sid;
}
mySessionId = getSessionId();

// Active game state persistence
function saveActiveGame(lobbyId, phase, playerName) {
  localStorage.setItem('dr_activeGame', JSON.stringify({
    lobbyId, phase, playerName, sessionId: mySessionId, savedAt: Date.now()
  }));
}
function getActiveGame() {
  try {
    const data = JSON.parse(localStorage.getItem('dr_activeGame'));
    if (!data) return null;
    // Expire after 5 hours (games don't last longer)
    if (Date.now() - data.savedAt > 5 * 60 * 60 * 1000) {
      clearActiveGame();
      return null;
    }
    return data;
  } catch { return null; }
}
function clearActiveGame() {
  localStorage.removeItem('dr_activeGame');
}
function updateActiveGamePhase(phase) {
  const ag = getActiveGame();
  if (ag) { ag.phase = phase; ag.savedAt = Date.now(); localStorage.setItem('dr_activeGame', JSON.stringify(ag)); }
}

// Check for active game and show banner on home screen
function renderActiveGameBanner() {
  const banner = document.getElementById('activeGameBanner');
  const ag = getActiveGame();
  if (!ag) { banner.style.display = 'none'; return; }
  const phaseLabel = ag.phase === 'waiting' ? '⏳ In Lobby' :
                     ag.phase === 'drafting' ? '⚔️ Drafting' :
                     ag.phase === 'live' ? '🔴 Live' :
                     ag.phase === 'finished' ? '✅ Finished' : '🎮 Active';
  banner.style.display = 'flex';
  banner.innerHTML = `
    <div class="active-game-banner" onclick="rejoinActiveGame()">
      <div class="agb-pip"></div>
      <div class="agb-info">
        <div class="agb-title">${phaseLabel} — Room ${ag.lobbyId}</div>
        <div class="agb-sub">Playing as ${ag.playerName}</div>
      </div>
      <button class="agb-btn" onclick="event.stopPropagation(); rejoinActiveGame()">REJOIN</button>
      <button class="agb-leave" onclick="event.stopPropagation(); abandonGame()">✕</button>
    </div>`;
}

function rejoinActiveGame() {
  const ag = getActiveGame();
  if (!ag) return;
  // Make sure we're using the right session
  mySessionId = ag.sessionId;
  localStorage.setItem('dr_sessionId', mySessionId);
  socket.emit('rejoin', { sessionId: mySessionId });
}

function abandonGame() {
  if (!confirm('Leave this game? You won\'t be able to rejoin.')) return;
  clearActiveGame();
  // Generate a fresh session so the server won't associate us anymore
  mySessionId = 'ses_' + Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
  localStorage.setItem('dr_sessionId', mySessionId);
  myLobbyId = null; isHost = false;
  renderActiveGameBanner();
  showToast('Left the game');
}

socket.on('connect', () => {
  mySocketId = socket.id;
  // Check for join code in URL
  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get('join');
  if (joinCode) {
    document.getElementById('joinCode').value = joinCode.toUpperCase();
    window.history.replaceState({}, '', window.location.pathname);
    // Fresh session so rejoin won't hijack us into an old game
    clearActiveGame();
    mySessionId = 'ses_' + Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
    localStorage.setItem('dr_sessionId', mySessionId);
    renderActiveGameBanner();
    return; // skip rejoin, user will manually click join
  }
  // Attempt rejoin if we have an active game
  const ag = getActiveGame();
  if (ag && mySessionId) {
    socket.emit('rejoin', { sessionId: mySessionId });
  }
  renderActiveGameBanner();
});

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}
function goHome() {
  showScreen('homeScreen');
  // Don't destroy the session — just navigate back so user can rejoin
  renderActiveGameBanner();
}

function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast visible' + (isError ? ' error' : '');
  setTimeout(() => t.classList.remove('visible'), 3000);
}

function toggleScoring(btn) {
  btn.classList.toggle('open');
  document.getElementById('scoringBody').classList.toggle('open');
}

async function loadGamesForDate(dateStr) {
  try {
    const url = dateStr ? `/api/games?date=${dateStr}` : '/api/games';
    const res = await fetch(url);
    const games = await res.json();
    const c = document.getElementById('todaysGames');
    if (!games.length) { c.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem;padding:10px;">No games scheduled</div>'; return; }
    c.innerHTML = games.map(g => {
      const time = new Date(g.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const isLive = g.state === 'in' || g.state === 'LIVE';
      const isFinal = g.state === 'post' || g.state === 'OFF' || g.state === 'FINAL';
      const isUpcoming = g.state === 'pre' || g.state === 'FUT';
      const statusText = isLive ? '● LIVE' : isFinal ? 'FINAL' : time;
      const statusClass = isLive ? 'game-tile-live' : isFinal ? 'game-tile-final' : '';
      const draftable = !isFinal ? '<div class="game-tile-draftable">✓ Draftable</div>' : '';
      return `<div class="game-tile ${isFinal ? 'game-tile-started' : ''}">
        <div class="game-tile-league ${g.league}">${g.league}</div>
        <div class="game-tile-teams">${g.awayTeam} @ ${g.homeTeam}</div>
        <div class="game-tile-time ${statusClass}">${statusText}</div>
        ${draftable}
      </div>`;
    }).join('');
  } catch(e) { console.error(e); }
}

// Init home screen
buildHomeDatePicker();
loadGamesForDate(null);
renderActiveGameBanner();
// Restore player name from previous session
const savedName = localStorage.getItem('dr_playerName');
if (savedName) document.getElementById('playerName').value = savedName;

// Lobby settings state
let lobbySettings = {
  draftType: 'snake',
  timePerPick: 30,
  rosterSlots: { nba: 4, nhl: 2 },
  leagues: 'both',
  maxPlayers: 2,
  isPublic: false,
  gameDate: null // null = today
};

// Date helpers
function getDateOptions() {
  const options = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    // Use local date components to avoid UTC timezone shift
    const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    let label;
    if (i === 0) label = 'Today';
    else if (i === 1) label = 'Tomorrow';
    else label = d.toLocaleDateString('en-US', { weekday: 'short' });
    const dateNum = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    options.push({ iso, label, dateNum, dayLabel: label });
  }
  return options;
}

let selectedHomeDate = null; // null = today

function buildHomeDatePicker() {
  const opts = getDateOptions();
  const row = document.getElementById('datePickerRow');
  row.innerHTML = opts.map((o, i) => `
    <button class="date-chip ${i === 0 ? 'date-active' : ''}" data-date="${o.iso}" onclick="selectHomeDate('${o.iso}', this)">
      <span class="date-day">${o.dayLabel}</span>
      ${o.dateNum}
    </button>
  `).join('');
}

function selectHomeDate(iso, btn) {
  selectedHomeDate = iso;
  document.querySelectorAll('.date-chip').forEach(b => b.classList.remove('date-active'));
  btn.classList.add('date-active');
  loadGamesForDate(iso);
}

function createLobby() {
  myName = document.getElementById('playerName').value.trim();
  if (!myName) return showToast('Enter your name!', true);
  localStorage.setItem('dr_playerName', myName);
  socket.emit('createLobby', {
    playerName: myName,
    maxPlayers: lobbySettings.maxPlayers,
    isPublic: lobbySettings.isPublic,
    sessionId: mySessionId,
    settings: lobbySettings
  });
}

function joinLobby() {
  myName = document.getElementById('playerName').value.trim();
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  if (!myName) return showToast('Enter your name!', true);
  if (!code) return showToast('Enter a room code!', true);
  localStorage.setItem('dr_playerName', myName);
  socket.emit('joinLobby', { lobbyId: code, playerName: myName, sessionId: mySessionId });
}

// Simplified basic app structure focusing on caching setup

// Socket event handlers - simplified
socket.on('lobbyCreated', ({ lobbyId, lobby }) => {
  myLobbyId = lobbyId; 
  isHost = true; 
  showToast('Lobby created!');
});

socket.on('error', ({ message }) => {
  showToast(message, true);
});

