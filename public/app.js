// Socket will be initialized after Firebase auth
let socket = null;
let myName = '', myLobbyId = null, mySocketId = null, mySessionId = null, isHost = false;
let currentFilter = 'all', currentPosFilter = 'all', availablePlayers = [], draftTimerInterval = null;
let draftGames = [], currentGameFilter = 'all';
let lobbyState = null, amIDrafting = false, draftOrderList = [];

// Initialize socket connection (called after Firebase auth)
function initializeSocket() {
  if (socket) return; // Already initialized
  
  console.log('🔌 Initializing Socket.IO connection');
  socket = io();
  
  // Authenticate with server after connection
  socket.on('connect', () => {
    console.log('✅ Socket connected:', socket.id);
    
    if (currentUser) {
      // Send Firebase UID to server
      socket.emit('authenticate', {
        uid: currentUser.uid,
        displayName: currentUser.displayName,
        photoURL: currentUser.photoURL
      });
    } else {
      // Fallback to old session system
      socket.emit('authenticate', {
        uid: null,
        sessionId: mySessionId
      });
    }
  });
  
  socket.on('authenticated', ({ uid }) => {
    console.log('✅ Authenticated with server:', uid);
  });
  
  socket.on('authError', ({ message }) => {
    console.error('❌ Authentication error:', message);
    alert('Please sign in to continue');
  });
  
  // Set up all other socket listeners
  setupSocketListeners();
}

// Session management - persists across refreshes AND tab closes  
function getSessionId() {
  let sid = localStorage.getItem('dr_sessionId');
  if (!sid) {
    sid = 'ses_' + Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
    localStorage.setItem('dr_sessionId', sid);
  }
  return sid;
}
mySessionId = getSessionId();

// Active game state persistence
// Multi-game storage (supports 3-4 simultaneous games)
function saveActiveGame(lobbyId, phase, playerName) {
  const games = JSON.parse(localStorage.getItem('dr_activeGames') || '{}');
  games[lobbyId] = {
    lobbyId, phase, playerName, sessionId: mySessionId, savedAt: Date.now()
  };
  localStorage.setItem('dr_activeGames', JSON.stringify(games));
  
  // Cleanup old games (>5 hours)
  const now = Date.now();
  Object.keys(games).forEach(id => {
    if (now - games[id].savedAt > 5 * 60 * 60 * 1000) {
      delete games[id];
    }
  });
  localStorage.setItem('dr_activeGames', JSON.stringify(games));
}

function getActiveGames() {
  try {
    const games = JSON.parse(localStorage.getItem('dr_activeGames') || '{}');
    const now = Date.now();
    
    // Filter out stale games
    Object.keys(games).forEach(id => {
      if (now - games[id].savedAt > 5 * 60 * 60 * 1000) {
        delete games[id];
      }
    });
    
    return games;
  } catch { return {}; }
}

function getActiveGame() {
  // For backwards compatibility - returns most recent game
  const games = getActiveGames();
  const gameList = Object.values(games);
  if (gameList.length === 0) return null;
  
  // Return most recently saved game
  return gameList.sort((a, b) => b.savedAt - a.savedAt)[0];
}

function clearActiveGame(lobbyId) {
  const games = getActiveGames();
  if (lobbyId) {
    // Clear specific game
    delete games[lobbyId];
  } else {
    // Clear all (backwards compatibility)
    Object.keys(games).forEach(id => delete games[id]);
  }
  localStorage.setItem('dr_activeGames', JSON.stringify(games));
  
  // Clean up old format
  localStorage.removeItem('dr_activeGame');
}

function updateActiveGamePhase(phase) {
  if (!myLobbyId) return;
  const games = getActiveGames();
  if (games[myLobbyId]) {
    games[myLobbyId].phase = phase;
    games[myLobbyId].savedAt = Date.now();
    localStorage.setItem('dr_activeGames', JSON.stringify(games));
  }
}

// Check for active game and show banner on home screen
function renderActiveGameBanner() {
  const banner = document.getElementById('activeGameBanner');
  const games = getActiveGames();
  const gameList = Object.values(games);
  
  if (gameList.length === 0) {
    banner.style.display = 'none';
    return;
  }
  
  if (gameList.length === 1) {
    // Single game - compact banner
    const ag = gameList[0];
    const phaseLabel = ag.phase === 'waiting' ? '⏳ In Lobby' :
                       ag.phase === 'drafting' ? '⚔️ Drafting' :
                       ag.phase === 'live' ? '🔴 Live' :
                       ag.phase === 'finished' ? '✅ Finished' : '🎮 Active';
    banner.style.display = 'flex';
    banner.innerHTML = `
      <div class="active-game-banner" onclick="rejoinActiveGame('${ag.lobbyId}')">
        <div class="agb-pip"></div>
        <div class="agb-info">
          <div class="agb-title">${phaseLabel} — Room ${ag.lobbyId}</div>
          <div class="agb-sub">Playing as ${ag.playerName}</div>
        </div>
        <button class="agb-btn" onclick="event.stopPropagation(); rejoinActiveGame('${ag.lobbyId}')">REJOIN</button>
        <button class="agb-leave" onclick="event.stopPropagation(); abandonGame('${ag.lobbyId}')">✕</button>
      </div>`;
  } else {
    // Multiple games - show count with VIEW ALL
    const liveCount = gameList.filter(g => g.phase === 'live').length;
    const draftingCount = gameList.filter(g => g.phase === 'drafting').length;
    const waitingCount = gameList.filter(g => g.phase === 'waiting').length;
    
    const statusParts = [];
    if (liveCount) statusParts.push(`${liveCount} Live`);
    if (draftingCount) statusParts.push(`${draftingCount} Drafting`);
    if (waitingCount) statusParts.push(`${waitingCount} Waiting`);
    const statusText = statusParts.join(' • ');
    
    banner.style.display = 'flex';
    banner.innerHTML = `
      <div class="active-games-lobby" onclick="showGamesLobby()">
        <div class="agb-pip"></div>
        <div class="agb-info">
          <div class="agb-title">🎮 ${gameList.length} Active Games</div>
          <div class="agb-sub">${statusText}</div>
        </div>
        <button class="agb-btn" onclick="event.stopPropagation(); showGamesLobby()">VIEW ALL</button>
      </div>`;
  }
}

function rejoinActiveGame(lobbyId) {
  const games = getActiveGames();
  const ag = lobbyId ? games[lobbyId] : getActiveGame();
  if (!ag) return;
  mySessionId = ag.sessionId;
  localStorage.setItem('dr_sessionId', mySessionId);
  socket.emit('rejoin', { sessionId: mySessionId });
}

function abandonGame(lobbyId) {
  if (!confirm('Leave this game? You won\'t be able to rejoin.')) return;
  
  console.log('🚪 Abandoning game:', lobbyId);
  
  // Get current game to notify server
  const games = getActiveGames();
  const game = games[lobbyId];
  
  if (game && game.sessionId) {
    socket.emit('leaveGame', { sessionId: game.sessionId, lobbyId });
  }
  
  // Clear from storage
  clearActiveGame(lobbyId);
  
  // If no more games, reset everything
  const remaining = Object.keys(getActiveGames()).length;
  if (remaining === 0) {
    myLobbyId = null;
    isHost = false;
  }
  
  renderActiveGameBanner();
  closeGamesLobby();
  showToast('Left the game');
}

socket.on('connect', () => {
  mySocketId = socket.id;
  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get('join');
  if (joinCode) {
    document.getElementById('joinCode').value = joinCode.toUpperCase();
    window.history.replaceState({}, '', window.location.pathname);
    clearActiveGame();
    mySessionId = 'ses_' + Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
    localStorage.setItem('dr_sessionId', mySessionId);
    renderActiveGameBanner();
    return;
  }
  const ag = getActiveGame();
  if (ag && mySessionId) {
    socket.emit('rejoin', { sessionId: mySessionId });
  }
  renderActiveGameBanner();
});

socket.on('rejoinState', (data) => {
  mySessionId = data.sessionId;
  isHost = data.isHost;
  lobbyState = data.lobby;
  myLobbyId = data.lobby.id;
  myName = data.lobby.players.find(p => p.id === mySessionId)?.name || myName;

  saveActiveGame(myLobbyId, data.phase, myName);

  if (data.phase === 'waiting') {
    showScreen('lobbyScreen');
    document.getElementById('lobbyCode').textContent = data.lobby.id;
    if (isHost) {
      document.getElementById('hostControls').style.display = 'block';
      document.getElementById('waitingMsg').style.display = 'none';
      // Restore settings from server state (in case host reconnects)
      if (data.lobby.settings) {
        lobbySettings = {
          ...lobbySettings,
          ...data.lobby.settings,
          maxPlayers: data.lobby.maxPlayers,
          isPublic: data.lobby.isPublic
        };
        syncSettingsUI();
      }
      updateSettingsSummary();
      buildLobbyDatePicker();
      // Broadcast preview so guests see current settings
      broadcastSettingsPreview();
    } else {
      document.getElementById('hostControls').style.display = 'none';
      document.getElementById('waitingMsg').style.display = 'block';
    }
    renderLobbyPlayers(data.lobby);
    showToast('Reconnected to lobby!');
  } else if (data.phase === 'drafting') {
    showScreen('draftScreen');
    availablePlayers = data.availablePlayers;
    draftOrderList = data.draftOrder;
    draftGames = data.games || []; currentGameFilter = 'all';
    amIDrafting = data.currentDrafter === mySessionId;
    updateLeagueFilterVisibility();
    buildPositionFilters(data.availablePlayers);
    renderDraftGamesBar();
    renderDraftRosters(data.lobby.players, data.currentDrafter);
    updateDraftUI(data.currentPick, data.currentDrafter, data.timePerPick);
    renderPlayerPool();
    showToast('Reconnected to draft!');
  } else if (data.phase === 'live' || data.phase === 'finished') {
    // Redirect to live.html page
    window.location.href = `/live.html?lobby=${data.lobby.id}`;
    showToast('Reconnected to game!');
  }
});

socket.on('rejoinFailed', () => {
  clearActiveGame();
  renderActiveGameBanner();
});

socket.on('playerReconnected', ({ playerName }) => {
  showToast(`${playerName} reconnected`);
});

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}
function goHome() {
  showScreen('homeScreen');
  renderActiveGameBanner();
}
function leaveGame() {
  if (!confirm('Leave this game permanently? You won\'t be able to rejoin.')) return;
  
  console.log('🚪 Leaving game:', { myLobbyId, mySessionId });
  
  // Notify server to remove from THIS lobby only
  if (myLobbyId && mySessionId) {
    socket.emit('leaveGame', { sessionId: mySessionId, lobbyId: myLobbyId });
  }
  
  // Clear this specific game from storage (keeps other games intact)
  clearActiveGame(myLobbyId);
  
  // Reset current lobby state
  myLobbyId = null;
  isHost = false;
  
  // Go home (user can access other games from active games banner)
  showScreen('homeScreen');
  renderActiveGameBanner();
  showToast('Left the game');
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
const savedName = localStorage.getItem('dr_playerName');
if (savedName) document.getElementById('playerName').value = savedName;

// ============================================
// LOBBY SETTINGS — purely local until Start Draft
// ============================================
let lobbySettings = {
  draftType: 'snake',
  timePerPick: 30,
  rosterSlots: { nba: 4, nhl: 2 },
  leagues: 'both',
  maxPlayers: 2,
  isPublic: false,
  gameDate: null
};

// Date helpers
function getDateOptions() {
  const options = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
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

let selectedHomeDate = null;

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

function buildLobbyDatePicker() {
  const opts = getDateOptions();
  const c = document.getElementById('gameDateControl');
  const currentDate = lobbySettings.gameDate || opts[0].iso;
  c.innerHTML = opts.map(o => `
    <button class="seg-btn ${o.iso === currentDate ? 'seg-active' : ''}" onclick="setGameDate('${o.iso}', this)">${o.label}</button>
  `).join('');
}

function setGameDate(iso, btn) {
  lobbySettings.gameDate = iso;
  document.querySelectorAll('#gameDateControl .seg-btn').forEach(b => b.className = 'seg-btn');
  btn.classList.add('seg-active');
  onSettingsChanged();
}

function getTotalSlots() {
  const s = lobbySettings;
  if (s.leagues === 'nba') return s.rosterSlots.nba;
  if (s.leagues === 'nhl') return s.rosterSlots.nhl;
  return s.rosterSlots.nba + s.rosterSlots.nhl;
}

function setLeague(val, btn) {
  lobbySettings.leagues = val;
  document.querySelectorAll('#leagueControl .seg-btn').forEach(b => {
    b.className = 'seg-btn';
  });
  if (val === 'nba') btn.classList.add('seg-active');
  else if (val === 'nhl') btn.classList.add('seg-active-nhl');
  else btn.classList.add('seg-active-both');
  updateRosterUI();
  onSettingsChanged();
}

function setDraftType(val, btn) {
  lobbySettings.draftType = val;
  document.querySelectorAll('#draftTypeControl .seg-btn').forEach(b => b.className = 'seg-btn');
  btn.classList.add('seg-active');
  onSettingsChanged();
}

function adjustTime(delta) {
  lobbySettings.timePerPick = Math.min(120, Math.max(10, lobbySettings.timePerPick + delta));
  document.getElementById('timeVal').textContent = lobbySettings.timePerPick;
  onSettingsChanged();
}

function adjustSlot(league, delta) {
  const cur = lobbySettings.rosterSlots[league] || 0;
  lobbySettings.rosterSlots[league] = Math.min(10, Math.max(1, cur + delta));
  updateRosterUI();
  onSettingsChanged();
}

function updateRosterUI() {
  const s = lobbySettings;
  const lg = s.leagues;
  const controls = document.getElementById('rosterControls');

  document.getElementById('nbaSlotsVal').textContent = s.rosterSlots.nba;
  document.getElementById('nhlSlotsVal').textContent = s.rosterSlots.nhl;
  document.getElementById('totalSlotsVal').textContent = getTotalSlots();

  const nhlControl = controls.querySelectorAll('.slot-control')[1];
  const dividers = controls.querySelectorAll('.slot-divider');
  const totalEl = document.getElementById('totalSlotsVal');

  if (lg === 'nba') {
    controls.querySelectorAll('.slot-control')[0].style.display = 'flex';
    if (nhlControl) nhlControl.style.display = 'none';
    dividers.forEach(d => d.style.display = 'none');
    totalEl.style.display = 'none';
  } else if (lg === 'nhl') {
    controls.querySelectorAll('.slot-control')[0].style.display = 'none';
    if (nhlControl) nhlControl.style.display = 'flex';
    dividers.forEach(d => d.style.display = 'none');
    totalEl.style.display = 'none';
  } else {
    controls.querySelectorAll('.slot-control')[0].style.display = 'flex';
    if (nhlControl) nhlControl.style.display = 'flex';
    dividers.forEach(d => d.style.display = 'block');
    totalEl.style.display = 'inline';
  }
}

function adjustMaxPlayers(delta) {
  lobbySettings.maxPlayers = Math.min(8, Math.max(1, lobbySettings.maxPlayers + delta));
  document.getElementById('maxPlayersVal').textContent = lobbySettings.maxPlayers;
  onSettingsChanged();
}

function togglePublic() {
  lobbySettings.isPublic = !lobbySettings.isPublic;
  document.getElementById('publicToggle').classList.toggle('on');
  
  // Immediately update server so public lobby list updates in real-time
  console.log('Toggle public:', {
    isPublic: lobbySettings.isPublic,
    isHost,
    myLobbyId,
    willEmit: isHost && myLobbyId
  });
  
  if (isHost && myLobbyId) {
    socket.emit('updateSettings', { 
      settings: { isPublic: lobbySettings.isPublic } 
    });
    console.log('✅ Sent updateSettings to server');
  } else {
    console.warn('❌ Cannot send updateSettings:', { isHost, myLobbyId });
  }
  
  onSettingsChanged();
}

// Sync all UI controls to match lobbySettings (used on reconnect)
function syncSettingsUI() {
  document.getElementById('timeVal').textContent = lobbySettings.timePerPick;
  document.getElementById('maxPlayersVal').textContent = lobbySettings.maxPlayers;

  // League buttons
  document.querySelectorAll('#leagueControl .seg-btn').forEach(b => b.className = 'seg-btn');
  const leagueBtns = document.querySelectorAll('#leagueControl .seg-btn');
  leagueBtns.forEach(b => {
    const text = b.textContent.trim().toLowerCase();
    if (lobbySettings.leagues === 'nba' && text.includes('nba')) b.classList.add('seg-active');
    else if (lobbySettings.leagues === 'nhl' && text.includes('nhl')) b.classList.add('seg-active-nhl');
    else if (lobbySettings.leagues === 'both' && text === 'both') b.classList.add('seg-active-both');
  });

  // Draft type buttons
  document.querySelectorAll('#draftTypeControl .seg-btn').forEach(b => {
    b.className = 'seg-btn';
    const text = b.textContent.trim().toLowerCase();
    if (lobbySettings.draftType === 'snake' && text.includes('snake')) b.classList.add('seg-active');
    else if (lobbySettings.draftType === 'linear' && text.includes('linear')) b.classList.add('seg-active');
  });

  // Public toggle
  const toggle = document.getElementById('publicToggle');
  if (lobbySettings.isPublic) toggle.classList.add('on');
  else toggle.classList.remove('on');

  updateRosterUI();
}

// ── Called on every local settings change ──
// Updates the local summary and broadcasts a lightweight preview to guests.
// Does NOT send settings to the server.
function onSettingsChanged() {
  updateSettingsSummary();
  broadcastSettingsPreview();
}

// Send a lightweight settings preview to other players in the lobby
// This goes through the server as a simple relay — no server-side mutation.
function broadcastSettingsPreview() {
  if (!isHost || !myLobbyId) return;
  socket.emit('settingsPreview', {
    summary: buildSettingsSummaryText(),
    maxPlayers: lobbySettings.maxPlayers,
    isPublic: lobbySettings.isPublic
  });
}

function buildSettingsSummaryText() {
  const s = lobbySettings;
  const total = getTotalSlots();
  let rosterStr;
  if (s.leagues === 'nba') rosterStr = `${s.rosterSlots.nba} NBA`;
  else if (s.leagues === 'nhl') rosterStr = `${s.rosterSlots.nhl} NHL`;
  else rosterStr = `${s.rosterSlots.nba}🏀 + ${s.rosterSlots.nhl}🏒 = ${total}`;
  const draftStr = s.draftType === 'snake' ? 'Snake' : 'Linear';
  const dateLabel = getDateLabel(s.gameDate);
  return `${dateLabel} · ${rosterStr} · ${draftStr} · ${s.timePerPick}s/pick · ${s.maxPlayers} players`;
}

function updateSettingsSummary() {
  document.getElementById('settingsSummary').textContent = buildSettingsSummaryText();
}

function getDateLabel(iso) {
  if (!iso) return 'Today';
  const d = new Date(iso + 'T12:00:00');
  const today = new Date(); today.setHours(12,0,0,0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Receive settings preview from host (guests only) ──
socket.on('settingsPreview', ({ summary, maxPlayers }) => {
  // Update guest summary display
  const el = document.getElementById('guestSettingsSummary');
  if (el) el.textContent = summary;

  // If maxPlayers changed, re-render player slots
  if (lobbyState && maxPlayers !== undefined) {
    lobbyState.maxPlayers = maxPlayers;
    renderLobbyPlayers(lobbyState);
  }
});

function createLobby() {
  myName = document.getElementById('playerName').value.trim();
  if (!myName) return showToast('Enter your name!', true);
  localStorage.setItem('dr_playerName', myName);
  // Send only name and initial maxPlayers/isPublic — settings are NOT sent here
  socket.emit('createLobby', {
    playerName: myName,
    maxPlayers: lobbySettings.maxPlayers,
    isPublic: lobbySettings.isPublic,
    sessionId: mySessionId
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
function findPublicGame() {
  myName = document.getElementById('playerName').value.trim();
  if (!myName) return showToast('Enter your name!', true);
  socket.emit('findPublicLobby', { playerName: myName });
}
function copyLobbyCode() { navigator.clipboard.writeText(myLobbyId).then(() => showToast('Code copied!')); }
function shareLobby() {
  const url = `${window.location.origin}?join=${myLobbyId}`;
  if (navigator.share) {
    navigator.share({ title: 'Join my Draft Royale lobby!', text: `Room code: ${myLobbyId}`, url }).catch(()=>{});
  } else {
    navigator.clipboard.writeText(url).then(() => showToast('Link copied!'));
  }
}
function startDraft() {
  showDraftLoading('Fetching games & players...');
  // ── Send ALL settings to the server now, at draft time ──
  socket.emit('startDraft', {
    settings: {
      draftType: lobbySettings.draftType,
      timePerPick: lobbySettings.timePerPick,
      rosterSlots: lobbySettings.rosterSlots,
      leagues: lobbySettings.leagues,
      gameDate: lobbySettings.gameDate,
      maxPlayers: lobbySettings.maxPlayers,
      isPublic: lobbySettings.isPublic
    }
  });
}

function showDraftLoading(msg) {
  const overlay = document.getElementById('draftLoadingOverlay');
  const msgEl = document.getElementById('draftLoadingMsg');
  if (msgEl) msgEl.textContent = msg || 'Preparing draft...';
  overlay.classList.add('visible');
}
function hideDraftLoading() {
  document.getElementById('draftLoadingOverlay').classList.remove('visible');
}
function leaveLobby() {
  clearActiveGame();
  mySessionId = 'ses_' + Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
  localStorage.setItem('dr_sessionId', mySessionId);
  myLobbyId = null; isHost = false;
  socket.disconnect();
  socket.connect();
  showScreen('homeScreen');
  renderActiveGameBanner();
}

// SOCKET EVENTS
socket.on('lobbyCreated', ({ lobbyId, lobby }) => {
  myLobbyId = lobbyId; isHost = true; lobbyState = lobby;
  saveActiveGame(lobbyId, 'waiting', myName);
  showScreen('lobbyScreen');
  document.getElementById('lobbyCode').textContent = lobbyId;
  document.getElementById('hostControls').style.display = 'block';
  document.getElementById('waitingMsg').style.display = 'none';
  syncSettingsUI();
  updateSettingsSummary();
  buildLobbyDatePicker();
  renderLobbyPlayers(lobby);
});

socket.on('lobbyUpdate', (lobby) => {
  if (!myLobbyId) {
    myLobbyId = lobby.id;
    showScreen('lobbyScreen');
    document.getElementById('lobbyCode').textContent = lobby.id;
    myName = lobby.players.find(p => p.id === mySessionId)?.name || myName;
  }
  lobbyState = lobby;
  saveActiveGame(lobby.id, lobby.state || 'waiting', myName);
  
  // Check host status — handles host transfer
  const me = lobby.players.find(p => p.id === mySessionId);
  if (me?.isHost && !isHost) {
    isHost = true;
    document.getElementById('hostControls').style.display = 'block';
    document.getElementById('waitingMsg').style.display = 'none';
    // On host transfer, adopt the lobby's current maxPlayers
    lobbySettings.maxPlayers = lobby.maxPlayers;
    lobbySettings.isPublic = lobby.isPublic;
    syncSettingsUI();
    updateSettingsSummary();
    buildLobbyDatePicker();
    broadcastSettingsPreview();
    showToast('You are now the host!');
  } else if (!me?.isHost) {
    isHost = false;
    document.getElementById('hostControls').style.display = 'none';
    document.getElementById('waitingMsg').style.display = 'block';
  }

  renderLobbyPlayers(lobby);
});

socket.on('publicLobbyFound', ({ lobbyId }) => { socket.emit('joinLobby', { lobbyId, playerName: myName, sessionId: mySessionId }); });

socket.on('draftLoading', ({ message }) => {
  showDraftLoading(message || 'Preparing draft...');
});
socket.on('draftLoadingDone', () => {
  hideDraftLoading();
});

socket.on('draftStart', ({ lobby, availablePlayers: players, draftOrder, currentPick, currentDrafter, timePerPick, games }) => {
  hideDraftLoading();
  lobbyState = lobby; availablePlayers = players; draftOrderList = draftOrder;
  draftGames = games || []; currentGameFilter = 'all';
  updateActiveGamePhase('drafting');
  showScreen('draftScreen');
  updateLeagueFilterVisibility();
  buildPositionFilters(players);
  renderDraftGamesBar();
  renderDraftRosters(lobby.players, currentDrafter);
  amIDrafting = currentDrafter === mySessionId;
  updateDraftUI(currentPick, currentDrafter, timePerPick);
  renderPlayerPool();
  if (amIDrafting) notifyMyTurn();
});

socket.on('pickMade', ({ picker, player, pickNumber, availablePlayers: remaining, autoPick, players }) => {
  availablePlayers = remaining;
  if (lobbyState) lobbyState.players = players;
  addDraftLog(picker.name, player, autoPick);
  const currentDrafterNow = draftOrderList[pickNumber + 1] || null;
  renderDraftRosters(players, currentDrafterNow);
  renderDraftGamesBar();
  renderPlayerPool();
});

socket.on('nextPick', ({ currentPick, currentDrafter, timePerPick }) => {
  amIDrafting = currentDrafter === mySessionId;
  renderDraftRosters(lobbyState?.players || [], currentDrafter);
  updateDraftUI(currentPick, currentDrafter, timePerPick);
  renderPlayerPool();
  if (amIDrafting) notifyMyTurn();
});

// ⭐ NEW: Handle personalized player pool updates
socket.on('personalizedPlayerPool', ({ availablePlayers: personalizedPlayers, fullLeagues }) => {
  // If we receive a personalized pool, use it instead of the full pool
  if (personalizedPlayers) {
    availablePlayers = personalizedPlayers;
    renderPlayerPool();
    
    // Optional: Show toast if leagues are full
    if (fullLeagues) {
      if (fullLeagues.nba && fullLeagues.nhl) {
        showToast('Your roster is full!');
      } else if (fullLeagues.nba) {
        showToast('NBA roster full - only NHL players shown');
      } else if (fullLeagues.nhl) {
        showToast('NHL roster full - only NBA players shown');
      }
    }
  }
});

let pendingLivePlayers = null;

socket.on('draftComplete', ({ players }) => {
  if (draftTimerInterval) { clearInterval(draftTimerInterval); draftTimerInterval = null; }
  pendingLivePlayers = players;
  updateActiveGamePhase('live');
  showScreen('recapScreen');
  renderRecap(players);
});

function renderRecap(players) {
  const body = document.getElementById('recapBody');
  body.innerHTML = players.map(p => {
    const picks = (p.roster || []).map((pick, i) => `
      <div class="recap-pick ${pick.league}">
        <span class="recap-pick-num">#${i+1}</span>
        <span class="recap-pick-name">${pick.name}</span>
        <span style="color:var(--text-dim);font-size:0.7rem;">${pick.team} · ${pick.position}</span>
      </div>
    `).join('');
    const isMe = p.id === mySessionId;
    return `<div class="recap-player ${isMe ? 'is-you' : ''}">
      <div class="recap-pname">${p.name}${isMe ? ' (you)' : ''}</div>
      <div class="recap-picks">${picks}</div>
    </div>`;
  }).join('');
}

function goToLive() {
  // Save current game as 'live' so user can return to home screen
  saveActiveGame(myLobbyId, 'live', myName);
  
  // Redirect to standalone live.html page
  window.location.href = `/live.html?lobby=${myLobbyId}`;
}

socket.on('scoreUpdate', ({ players, state }) => {
  // Score updates are handled by live.html now
  // This handler only needed if user is still on recap screen
  if (state === 'finished') {
    updateActiveGamePhase('finished');
  }
});

socket.on('error', ({ message }) => { hideDraftLoading(); showToast(message, true); });
socket.on('playerDisconnected', ({ playerName }) => showToast(`${playerName} disconnected`));

// RENDER
function renderLobbyPlayers(lobby) {
  const c = document.getElementById('playerSlots');
  const av = ['avatar-1','avatar-2','avatar-3','avatar-4','avatar-5'];
  const maxP = lobby.maxPlayers || lobbySettings.maxPlayers;
  let html = '';
  for (let i = 0; i < maxP; i++) {
    const p = lobby.players[i];
    if (p) {
      const isMe = p.id === mySessionId;
      const dcClass = p.disconnected ? 'disconnected' : '';
      html += `<div class="player-card-lobby ${isMe?'is-you':''} ${dcClass}" style="animation-delay:${i*0.08}s">
        <div class="player-avatar ${av[i]}">${p.name.charAt(0).toUpperCase()}</div>
        <div class="player-card-name">${p.name}</div>
        ${isMe?'<span class="player-card-you">You</span>':''}
        ${p.isHost?'<span class="host-chip">Host</span>':''}
        ${p.disconnected?'<span class="dc-chip">Offline</span>':''}
      </div>`;
    } else {
      html += `<div class="empty-slot-lobby">Waiting for player...</div>`;
    }
  }
  c.innerHTML = html;
}

function renderDraftRosters(players, currentDrafter) {
  const c = document.getElementById('draftRosters');
  const s = lobbyState?.settings || {};
  const slots = s.rosterSlots || { nba: 4, nhl: 2 };
  let rSize;
  if (s.leagues === 'nba') rSize = slots.nba;
  else if (s.leagues === 'nhl') rSize = slots.nhl;
  else rSize = (slots.nba || 0) + (slots.nhl || 0);
  rSize = rSize || 5;
  c.innerHTML = players.map(p => {
    const isActive = p.id === currentDrafter, isMe = p.id === mySessionId;
    const roster = p.roster || [];
    let slots = '';
    for (let i = 0; i < rSize; i++) {
      if (roster[i]) {
        const r = roster[i];
        slots += `<div class="mini-pick filled ${r.league}"><div class="mini-pick-name">${r.name}</div><div class="mini-pick-team">${r.team} · ${r.position}</div></div>`;
      } else slots += `<div class="mini-pick empty">—</div>`;
    }
    return `<div class="roster-mini ${isActive?'active-drafter':''} ${isMe?'is-you':''}">
      <div class="roster-mini-name">${p.name}${isMe?' (you)':''} ${isActive?'<span class="picking-badge">Picking</span>':''}</div>
      ${slots}</div>`;
  }).join('');
}

function buildPositionFilters(players) {
  const positions = new Set(players.map(p => p.position));
  const sorted = [...positions].sort();
  const c = document.getElementById('positionFilters');
  c.innerHTML = `<button class="filter-chip active-pos" data-pos="all" onclick="setPosFilter('all',this)">All Pos</button>` +
    sorted.map(pos => `<button class="filter-chip" data-pos="${pos}" onclick="setPosFilter('${pos}',this)">${pos}</button>`).join('');
}

function renderDraftGamesBar() {
  const bar = document.getElementById('draftGamesBar');
  const scroll = document.getElementById('draftGamesScroll');
  if (!draftGames.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';

  const filteredGames = currentFilter === 'all' ? draftGames : draftGames.filter(g => g.league === currentFilter);

  const countByGame = {};
  let countedPlayers = availablePlayers;
  if (currentFilter !== 'all') countedPlayers = countedPlayers.filter(p => p.league === currentFilter);
  for (const p of countedPlayers) {
    countByGame[p.gameId] = (countByGame[p.gameId] || 0) + 1;
  }

  const totalPlayers = countedPlayers.length;

  if (currentGameFilter !== 'all' && !filteredGames.some(g => g.gameId === currentGameFilter)) {
    currentGameFilter = 'all';
  }

  let html = `<div class="draft-game-chip chip-all ${currentGameFilter === 'all' ? 'chip-active' : ''}" onclick="setGameFilter('all')">
    <div class="dgc-info">
      <div class="dgc-matchup">All Games</div>
      <div class="dgc-count">${totalPlayers} players</div>
    </div>
  </div>`;

  const sorted = [...filteredGames].sort((a, b) => {
    const aFinal = a.state === 'post' || a.state === 'OFF' || a.state === 'FINAL';
    const bFinal = b.state === 'post' || b.state === 'OFF' || b.state === 'FINAL';
    if (aFinal !== bFinal) return aFinal ? 1 : -1;
    return new Date(a.startTime) - new Date(b.startTime);
  });

  for (const g of sorted) {
    const count = countByGame[g.gameId] || 0;
    const isActive = currentGameFilter === g.gameId;
    const isNHL = g.league === 'nhl';
    const activeClass = isActive ? (isNHL ? 'chip-active-nhl' : 'chip-active') : '';
    const time = new Date(g.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const isLive = g.state === 'in' || g.state === 'LIVE';
    const isFinal = g.state === 'post' || g.state === 'OFF' || g.state === 'FINAL';
    const timeText = isLive ? '● LIVE' : isFinal ? 'FINAL' : time;
    const timeClass = isLive ? 'dgc-live' : '';

    html += `<div class="draft-game-chip ${activeClass}" onclick="setGameFilter('${g.gameId}')" ${count === 0 && !isActive ? 'style="opacity:0.4;"' : ''}>
      <div class="dgc-league ${g.league}">${g.league}</div>
      <div class="dgc-info">
        <div class="dgc-matchup">${g.awayTeam} @ ${g.homeTeam}</div>
        <div class="dgc-time ${timeClass}">${timeText} · ${count} avail</div>
      </div>
    </div>`;
  }

  scroll.innerHTML = html;
}

function setGameFilter(gameId) {
  currentGameFilter = gameId;
  currentPosFilter = 'all';
  let visible = availablePlayers;
  if (gameId !== 'all') visible = visible.filter(p => p.gameId === gameId);
  if (currentFilter !== 'all') visible = visible.filter(p => p.league === currentFilter);
  buildPositionFilters(visible);
  renderDraftGamesBar();
  renderPlayerPool();
}

function setPosFilter(pos, btn) {
  currentPosFilter = pos;
  document.querySelectorAll('#positionFilters .filter-chip').forEach(b => b.classList.remove('active-pos'));
  btn.classList.add('active-pos');
  filterPlayers();
}

function getMyLeagueCounts() {
  const me = lobbyState?.players?.find(p => p.id === mySessionId);
  const roster = me?.roster || [];
  return {
    nba: roster.filter(r => r.league === 'nba').length,
    nhl: roster.filter(r => r.league === 'nhl').length
  };
}

function getLeagueSlots() {
  const s = lobbyState?.settings || {};
  return s.rosterSlots || { nba: 4, nhl: 2 };
}

function renderPlayerPool() {
  const c = document.getElementById('playerPool');
  const scrollTop = c.scrollTop; // preserve scroll position
  const search = (document.getElementById('playerSearch')?.value||'').toLowerCase();
  const banner = document.getElementById('waitingBanner');
  let filtered = availablePlayers;
  if (currentGameFilter !== 'all') filtered = filtered.filter(p => p.gameId === currentGameFilter);
  if (currentFilter !== 'all') filtered = filtered.filter(p => p.league === currentFilter);
  if (currentPosFilter !== 'all') filtered = filtered.filter(p => p.position === currentPosFilter);
  if (search) filtered = filtered.filter(p => p.name.toLowerCase().includes(search) || p.team.toLowerCase().includes(search) || (p.teamName||'').toLowerCase().includes(search));
  
  const counts = getMyLeagueCounts();
  const slots = getLeagueSlots();
  const nbaFull = counts.nba >= (slots.nba || 99);
  const nhlFull = counts.nhl >= (slots.nhl || 99);

  banner.style.display = amIDrafting ? 'none' : 'block';

  const leagues = lobbyState?.settings?.leagues || 'both';
  let slotHTML = '';
  if (amIDrafting) {
    if (leagues === 'both' || leagues === 'nba') {
      slotHTML += `<span class="slot-pill ${nbaFull?'slot-full':''}">🏀 ${counts.nba}/${slots.nba}</span>`;
    }
    if (leagues === 'both' || leagues === 'nhl') {
      slotHTML += `<span class="slot-pill ${nhlFull?'slot-full':''}">🏒 ${counts.nhl}/${slots.nhl}</span>`;
    }
  }
  document.getElementById('slotIndicator').innerHTML = slotHTML;

  c.innerHTML = filtered.map(p => {
    const avgLine = getAvgLine(p);
    const tierClass = p.tier || 'bench';
    const tierLabel = p.tierLabel || '⚪ Bench';
    const leagueFull = (p.league === 'nba' && nbaFull) || (p.league === 'nhl' && nhlFull);
    const isLocked = !amIDrafting || leagueFull;
    
    // Injury status tag
    let injuryTag = '';
    if (p.injuryStatus) {
      const status = p.injuryStatus.toUpperCase();
      const tagClass = status === 'OUT' ? 'injury-out' : 
                       status === 'DOUBTFUL' ? 'injury-doubtful' : 
                       'injury-questionable';
      injuryTag = `<span class="injury-tag ${tagClass}">${status}</span>`;
    }
    
    return `
    <div class="player-card ${p.league} ${isLocked?'disabled':''} ${leagueFull?'league-full':''}" onclick="${leagueFull?'':`openPlayerModal('${p.id}')`}">
      ${p.headshot?`<img class="pc-photo" src="${p.headshot}" onerror="this.outerHTML='<div class=\\'pc-photo-placeholder\\'><span class=\\'pc-pos-badge\\'>${p.position}</span></div>'">`:`<div class="pc-photo-placeholder"><span class="pc-pos-badge">${p.position}</span></div>`}
      <div class="pc-info">
        <div class="pc-name">${p.name} ${injuryTag}</div>
        <div class="pc-meta"><div class="pc-league-dot ${p.league}"></div><span class="pc-team">${p.team} · ${p.position}</span></div>
        <div class="pc-avgs">${avgLine}</div>
      </div>
      <div class="pc-right">
        <div class="pc-proj">${p.projectedScore || 0}</div>
        <div class="pc-proj-label">Proj</div>
        ${leagueFull ? '<span class="pc-tier bench">FULL</span>' : `<span class="pc-tier ${tierClass}">${tierLabel}</span>`}
      </div>
    </div>`;
  }).join('');

  if (!filtered.length) c.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-dim);">No players found</div>';

  c.scrollTop = scrollTop; // restore scroll position
}

function getAvgLine(p) {
  const a = p.seasonAvg || {};
  if (p.league === 'nba') {
    return `${a.points||0} ppg · ${a.rebounds||0} rpg · ${a.assists||0} apg`;
  }
  if (p.league === 'nhl') {
    if (p.isGoalie) return `${a.saves||0} sv/g · ${a.goalsAgainst||0} ga/g`;
    return `${a.goals||0} g/g · ${a.assists||0} a/g · ${a.shotsOnGoal||0} sog/g`;
  }
  return '';
}

function notifyMyTurn() {
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch(e) {}
}

let draftPickPending = false;
function draftPlayer(playerId) {
  if (!amIDrafting || draftPickPending) return;
  draftPickPending = true;
  socket.emit('draftPick', { playerId });
  closeModal();
  // Reset after a short delay to prevent accidental double-picks
  setTimeout(() => { draftPickPending = false; }, 2000);
}

// Player Detail Modal
const gameLogClientCache = {};

async function openPlayerModal(playerId) {
  const p = availablePlayers.find(pl => pl.id === playerId);
  if (!p) return;

  const modal = document.getElementById('playerModal');
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  document.getElementById('modalHeader').innerHTML = `
    ${p.headshot ? `<img class="modal-photo" src="${p.headshot}" onerror="this.outerHTML='<div class=\\'modal-photo-placeholder\\'>${p.position}</div>'">`
      : `<div class="modal-photo-placeholder">${p.position}</div>`}
    <div>
      <div class="modal-name">${p.name}</div>
      <div class="modal-team-pos">${p.teamName || p.team} · ${p.position} · <span class="pc-tier ${p.tier||'bench'}" style="display:inline;">${p.tierLabel||'⚪ Bench'}</span></div>
    </div>`;

  const a = p.seasonAvg || {};
  let avgCells = '';
  if (p.league === 'nba') {
    avgCells = [
      { val: a.points||0, label: 'PPG' },
      { val: a.rebounds||0, label: 'RPG' },
      { val: a.assists||0, label: 'APG' },
      { val: a.steals||0, label: 'SPG' },
      { val: a.blocks||0, label: 'BPG' },
    ].map(s => `<div class="modal-avg-cell"><div class="modal-avg-val">${s.val}</div><div class="modal-avg-label">${s.label}</div></div>`).join('');
  } else if (p.isGoalie) {
    avgCells = [
      { val: a.saves||0, label: 'SV/G' },
      { val: a.goalsAgainst||0, label: 'GA/G' },
    ].map(s => `<div class="modal-avg-cell"><div class="modal-avg-val">${s.val}</div><div class="modal-avg-label">${s.label}</div></div>`).join('');
  } else {
    avgCells = [
      { val: a.goals||0, label: 'G/G' },
      { val: a.assists||0, label: 'A/G' },
      { val: a.shotsOnGoal||0, label: 'SOG/G' },
    ].map(s => `<div class="modal-avg-cell"><div class="modal-avg-val">${s.val}</div><div class="modal-avg-label">${s.label}</div></div>`).join('');
  }
  avgCells += `<div class="modal-avg-cell" style="border-color:rgba(255,87,34,0.3);"><div class="modal-avg-val" style="color:var(--accent);">${p.projectedScore||0}</div><div class="modal-avg-label">Proj FPts</div></div>`;
  document.getElementById('modalAvgGrid').innerHTML = avgCells;

  const counts = getMyLeagueCounts();
  const slots = getLeagueSlots();
  const leagueFull = (p.league === 'nba' && counts.nba >= (slots.nba || 99)) ||
                     (p.league === 'nhl' && counts.nhl >= (slots.nhl || 99));

  let draftBarHTML;
  if (!amIDrafting) {
    draftBarHTML = `<div style="flex:1;text-align:center;color:var(--text-dim);font-size:0.85rem;">Not your pick</div>`;
  } else if (leagueFull) {
    draftBarHTML = `<div style="flex:1;text-align:center;color:var(--accent);font-size:0.85rem;font-weight:600;">${p.league.toUpperCase()} roster full (${p.league === 'nba' ? counts.nba : counts.nhl}/${p.league === 'nba' ? slots.nba : slots.nhl})</div>`;
  } else {
    draftBarHTML = `<button class="btn btn-hero" onclick="draftPlayer('${p.id}')">⚔️ DRAFT ${p.name.split(' ').pop().toUpperCase()}</button>`;
  }
  document.getElementById('modalDraftBar').innerHTML = draftBarHTML;

  // Game log — use client-side cache
  const logBody = document.getElementById('modalGameLogBody');
  const athleteId = p.athleteId || p.id.replace('nba-','').replace('nhl-','');
  const cacheKey = `${p.league}-${athleteId}`;

  if (gameLogClientCache[cacheKey] && Date.now() - gameLogClientCache[cacheKey].ts < 600000) {
    renderGameLog(logBody, gameLogClientCache[cacheKey].data, p);
    return;
  }

  logBody.innerHTML = '<div class="modal-loading">Loading game log...</div>';

  try {
    const res = await fetch(`/api/gamelog/${p.league}/${athleteId}`);
    const data = await res.json();
    gameLogClientCache[cacheKey] = { data, ts: Date.now() };
    renderGameLog(logBody, data, p);
  } catch (e) {
    logBody.innerHTML = '<div class="modal-loading" style="color:var(--text-dim);">Could not load game log</div>';
  }
}

function renderGameLog(container, data, player) {
  if (!data.games || data.games.length === 0) {
    container.innerHTML = '<div class="modal-loading" style="color:var(--text-dim);">No recent games found</div>';
    return;
  }

  container.innerHTML = data.games.map(g => {
    let statLine = '', fpts = 0;
    if (player.league === 'nba') {
      const s = g.stats;
      statLine = `${s.points}p ${s.rebounds}r ${s.assists}a ${s.steals}s ${s.blocks}b`;
      fpts = (s.points*1) + (s.rebounds*1.5) + (s.assists*2) + (s.steals*3) + (s.blocks*3);
      const cats = [s.points, s.rebounds, s.assists, s.steals, s.blocks].filter(v => v >= 10);
      if (cats.length >= 3) fpts += 10;
      else if (cats.length >= 2) fpts += 5;
    } else {
      const s = g.stats;
      if (s.saves !== undefined) {
        statLine = `${s.saves}sv ${s.goalsAgainst}ga ${s.savePct||''}`;
        fpts = (s.saves||0)*0.5;
        if ((s.goalsAgainst||0) === 0 && (s.saves||0) > 0) fpts += 5;
      } else {
        statLine = `${s.goals}g ${s.assists}a ${s.shotsOnGoal||0}sog`;
        fpts = (s.goals||0)*5 + (s.assists||0)*3 + (s.shotsOnGoal||0)*1;
        if ((s.goals||0) >= 3) fpts += 3;
      }
    }
    fpts = Math.round(fpts * 10) / 10;
    return `<div class="modal-gamelog-row">
      <div class="modal-gl-date">${g.date}</div>
      <div class="modal-gl-opp">${g.opponent}</div>
      <div class="modal-gl-stats">${statLine}</div>
      <div class="modal-gl-fpts">${fpts}</div>
    </div>`;
  }).join('');
}

function closeModal() {
  const modal = document.getElementById('playerModal');
  modal.classList.remove('open');
  document.body.style.overflow = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

function updateDraftUI(currentPick, currentDrafter, timePerPick) {
  const numPlayers = lobbyState?.players?.length || 2;
  const totalPicks = draftOrderList.length || (numPlayers * 5);
  const round = Math.floor(currentPick / numPlayers) + 1;
  const drafter = lobbyState?.players.find(p => p.id === currentDrafter);
  const isMe = currentDrafter === mySessionId;
  const turnEl = document.getElementById('draftTurnName');
  turnEl.textContent = isMe ? '🎯 Your Pick!' : `${drafter?.name || '?'}`;
  turnEl.className = 'draft-turn-name' + (isMe ? ' is-you' : '');
  document.getElementById('draftRoundPill').textContent = `R${round} · P${currentPick+1}/${totalPicks}`;
  if (draftTimerInterval) clearInterval(draftTimerInterval);
  let timeLeft = timePerPick;
  const clockEl = document.getElementById('draftClock'), numEl = document.getElementById('draftTimerNum');
  numEl.textContent = timeLeft;
  clockEl.classList.remove('urgent');
  draftTimerInterval = setInterval(() => {
    timeLeft--;
    numEl.textContent = timeLeft;
    if (timeLeft <= 5) clockEl.classList.add('urgent');
    if (timeLeft <= 0) { clearInterval(draftTimerInterval); draftTimerInterval = null; }
  }, 1000);
}

function addDraftLog(pickerName, player, autoPick) {
  const log = document.getElementById('draftLog');
  const e = document.createElement('div');
  e.className = 'log-entry';
  e.innerHTML = `<span class="picker">${pickerName}</span> ${autoPick?'<span class="auto">auto-</span>':''}drafted <span class="picked">${player.name}</span> (${player.team})`;
  log.prepend(e);
}

function updateLeagueFilterVisibility() {
  const leagues = lobbyState?.settings?.leagues || 'both';
  const filterRow = document.getElementById('leagueFilterRow');
  if (!filterRow) return;
  if (leagues === 'nba' || leagues === 'nhl') {
    filterRow.style.display = 'none';
    currentFilter = 'all';
  } else {
    filterRow.style.display = 'flex';
  }
}

function setFilter(filter, btn) {
  currentFilter = filter;
  currentPosFilter = 'all';
  document.querySelectorAll('#draftPool .filter-chip').forEach(b => b.classList.remove('active','active-nhl'));
  btn.classList.add(filter === 'nhl' ? 'active-nhl' : 'active');
  let visible = availablePlayers;
  if (currentGameFilter !== 'all') visible = visible.filter(p => p.gameId === currentGameFilter);
  if (filter !== 'all') visible = visible.filter(p => p.league === filter);
  buildPositionFilters(visible);
  renderDraftGamesBar();
  filterPlayers();
}
function filterPlayers() { renderPlayerPool(); }

// Games Lobby Modal (for viewing multiple active games)
function showGamesLobby() {
  const modal = document.getElementById('gamesLobbyModal');
  const gamesList = document.getElementById('gamesLobbyList');
  
  const games = getActiveGames();
  const gameList = Object.values(games);
  
  // Sort by urgency: Live > Drafting > Waiting > Finished
  const phaseOrder = { live: 1, drafting: 2, waiting: 3, finished: 4 };
  gameList.sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase]);
  
  gamesList.innerHTML = gameList.map(game => {
    const phaseIcon = game.phase === 'live' ? '🔴' :
                      game.phase === 'drafting' ? '⚔️' :
                      game.phase === 'waiting' ? '⏳' : '✅';
    const phaseLabel = game.phase === 'live' ? 'Live' :
                       game.phase === 'drafting' ? 'Drafting' :
                       game.phase === 'waiting' ? 'Waiting' : 'Finished';
    const phaseColor = game.phase === 'live' ? 'live' :
                       game.phase === 'drafting' ? 'drafting' :
                       game.phase === 'waiting' ? 'waiting' : 'finished';
    
    return `
      <div class="game-lobby-card ${phaseColor}">
        <div class="game-card-header">
          <div class="game-card-status">${phaseIcon} ${phaseLabel}</div>
          <div class="game-card-code">Room ${game.lobbyId}</div>
        </div>
        <div class="game-card-player">Playing as ${game.playerName}</div>
        <div class="game-card-actions">
          <button class="btn-primary" onclick="rejoinActiveGame('${game.lobbyId}'); closeGamesLobby();">
            ${game.phase === 'live' ? '👁️ WATCH' : '▶️ REJOIN'}
          </button>
          <button class="btn-danger" onclick="abandonGame('${game.lobbyId}')">LEAVE</button>
        </div>
      </div>
    `;
  }).join('');
  
  modal.classList.add('open');
  modal.style.display = 'flex';
}

function closeGamesLobby() {
  const modal = document.getElementById('gamesLobbyModal');
  modal.classList.remove('open');
  modal.style.display = 'none';
}

// Old live screen functions removed - now using live.html
