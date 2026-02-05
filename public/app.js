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

socket.on('rejoinState', (data) => {
  mySessionId = data.sessionId;
  isHost = data.isHost;
  lobbyState = data.lobby;
  myLobbyId = data.lobby.id;
  myName = data.lobby.players.find(p => p.id === mySessionId)?.name || myName;

  // Persist active game state
  saveActiveGame(myLobbyId, data.phase, myName);

  if (data.phase === 'waiting') {
    showScreen('lobbyScreen');
    document.getElementById('lobbyCode').textContent = data.lobby.id;
    if (isHost) {
      document.getElementById('hostControls').style.display = 'block';
      document.getElementById('waitingMsg').style.display = 'none';
      if (data.lobby.settings) {
        lobbySettings = { ...lobbySettings, ...data.lobby.settings, maxPlayers: data.lobby.maxPlayers, isPublic: data.lobby.isPublic };
        document.getElementById('timeVal').textContent = lobbySettings.timePerPick;
        document.getElementById('maxPlayersVal').textContent = lobbySettings.maxPlayers;
        updateRosterUI();
        buildLobbyDatePicker();
      }
      updateSettingsSummary();
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
    showScreen('liveScreen');
    renderLive(data.players, data.phase);
    if (data.phase === 'finished') {
      const bar = document.getElementById('liveBar');
      bar.classList.add('finished');
      bar.querySelector('.live-pip-label').textContent = 'Final';
      const sorted = [...data.players].sort((a, b) => b.totalScore - a.totalScore);
      if (sorted.length) {
        document.getElementById('winnerBanner').style.display = 'block';
        document.getElementById('winnerName').textContent = `${sorted[0].name} Wins!`;
        document.getElementById('winnerScore').textContent = `${sorted[0].totalScore} fantasy points`;
      }
    }
    showToast('Reconnected to game!');
  }
});

socket.on('rejoinFailed', () => {
  // No active session on server — clear stale local data
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
  // Don't destroy the session — just navigate back so user can rejoin
  renderActiveGameBanner();
}
function leaveGame() {
  if (!confirm('Leave this game permanently? You won\'t be able to rejoin.')) return;
  clearActiveGame();
  // Generate fresh sessionId so server won't reconnect us
  mySessionId = 'ses_' + Math.random().toString(36).substr(2, 12) + Date.now().toString(36);
  localStorage.setItem('dr_sessionId', mySessionId);
  myLobbyId = null; isHost = false;
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
  emitSettings();
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
  emitSettings();
}

function setDraftType(val, btn) {
  lobbySettings.draftType = val;
  document.querySelectorAll('#draftTypeControl .seg-btn').forEach(b => b.className = 'seg-btn');
  btn.classList.add('seg-active');
  emitSettings();
}

function adjustTime(delta) {
  lobbySettings.timePerPick = Math.min(120, Math.max(10, lobbySettings.timePerPick + delta));
  document.getElementById('timeVal').textContent = lobbySettings.timePerPick;
  emitSettings();
}

function adjustSlot(league, delta) {
  const cur = lobbySettings.rosterSlots[league] || 0;
  lobbySettings.rosterSlots[league] = Math.min(10, Math.max(1, cur + delta));
  updateRosterUI();
  emitSettings();
}

function updateRosterUI() {
  const s = lobbySettings;
  const lg = s.leagues;
  const rosterRow = document.getElementById('rosterRow');
  const controls = document.getElementById('rosterControls');

  document.getElementById('nbaSlotsVal').textContent = s.rosterSlots.nba;
  document.getElementById('nhlSlotsVal').textContent = s.rosterSlots.nhl;
  document.getElementById('totalSlotsVal').textContent = getTotalSlots();

  // Show/hide league slot controls based on league selection
  const nbaEls = controls.querySelectorAll('.nba-slot, .slot-control:first-child');
  const nhlEls = controls.querySelectorAll('.nhl-slot');
  const nhlControl = controls.querySelectorAll('.slot-control')[1];
  const dividers = controls.querySelectorAll('.slot-divider');
  const totalEl = document.getElementById('totalSlotsVal');

  if (lg === 'nba') {
    // Only NBA: show single stepper
    controls.querySelectorAll('.slot-control')[0].style.display = 'flex';
    if (nhlControl) nhlControl.style.display = 'none';
    dividers.forEach(d => d.style.display = 'none');
    totalEl.style.display = 'none';
  } else if (lg === 'nhl') {
    // Only NHL: show single stepper
    controls.querySelectorAll('.slot-control')[0].style.display = 'none';
    if (nhlControl) nhlControl.style.display = 'flex';
    dividers.forEach(d => d.style.display = 'none');
    totalEl.style.display = 'none';
  } else {
    // Both: show both with + = total
    controls.querySelectorAll('.slot-control')[0].style.display = 'flex';
    if (nhlControl) nhlControl.style.display = 'flex';
    dividers.forEach(d => d.style.display = 'block');
    totalEl.style.display = 'inline';
  }
}

function adjustMaxPlayers(delta) {
  lobbySettings.maxPlayers = Math.min(8, Math.max(1, lobbySettings.maxPlayers + delta));
  document.getElementById('maxPlayersVal').textContent = lobbySettings.maxPlayers;
  emitSettings();
}

function togglePublic() {
  lobbySettings.isPublic = !lobbySettings.isPublic;
  document.getElementById('publicToggle').classList.toggle('on');
  emitSettings();
}

function emitSettings() {
  updateSettingsSummary();
  socket.emit('updateSettings', { settings: {
    ...lobbySettings,
  }});
}

function updateSettingsSummary() {
  const s = lobbySettings;
  const total = getTotalSlots();
  let rosterStr;
  if (s.leagues === 'nba') rosterStr = `${s.rosterSlots.nba} NBA`;
  else if (s.leagues === 'nhl') rosterStr = `${s.rosterSlots.nhl} NHL`;
  else rosterStr = `${s.rosterSlots.nba}🏀 + ${s.rosterSlots.nhl}🏒 = ${total}`;
  const draftStr = s.draftType === 'snake' ? 'Snake' : 'Linear';
  const dateLabel = getDateLabel(s.gameDate);
  document.getElementById('settingsSummary').textContent =
    `${dateLabel} · ${rosterStr} · ${draftStr} · ${s.timePerPick}s/pick · ${s.maxPlayers} players`;
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

function createLobby() {
  myName = document.getElementById('playerName').value.trim();
  if (!myName) return showToast('Enter your name!', true);
  localStorage.setItem('dr_playerName', myName);
  socket.emit('createLobby', {
    playerName: myName,
    maxPlayers: lobbySettings.maxPlayers,
    isPublic: lobbySettings.isPublic,
    sessionId: mySessionId,
    settings: {
      draftType: lobbySettings.draftType,
      timePerPick: lobbySettings.timePerPick,
      rosterSlots: lobbySettings.rosterSlots,
      leagues: lobbySettings.leagues,
      gameDate: lobbySettings.gameDate
    }
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
  // Show loading overlay immediately
  showDraftLoading('Fetching games & players...');
  socket.emit('startDraft');
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
  // Sync settings from server
  if (lobby.settings) {
    lobbySettings = { ...lobbySettings, ...lobby.settings, maxPlayers: lobby.maxPlayers, isPublic: lobby.isPublic };
    document.getElementById('timeVal').textContent = lobbySettings.timePerPick;
    document.getElementById('maxPlayersVal').textContent = lobbySettings.maxPlayers;
    updateRosterUI();
  }
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
  
  // Always check host status — handles host transfer
  const me = lobby.players.find(p => p.id === mySessionId);
  if (me?.isHost && !isHost) {
    isHost = true;
    document.getElementById('hostControls').style.display = 'block';
    document.getElementById('waitingMsg').style.display = 'none';
    // Sync settings UI
    if (lobby.settings) {
      lobbySettings = { ...lobbySettings, ...lobby.settings, maxPlayers: lobby.maxPlayers, isPublic: lobby.isPublic };
      document.getElementById('timeVal').textContent = lobbySettings.timePerPick;
      document.getElementById('maxPlayersVal').textContent = lobbySettings.maxPlayers;
      updateRosterUI();
      buildLobbyDatePicker();
    }
    updateSettingsSummary();
    showToast('You are now the host!');
  } else if (!me?.isHost) {
    isHost = false;
    document.getElementById('hostControls').style.display = 'none';
    document.getElementById('waitingMsg').style.display = 'block';
  }

  // Show settings to guests
  if (!isHost && lobby.settings) {
    const s = lobby.settings;
    const slots = s.rosterSlots || { nba: 4, nhl: 2 };
    let rosterStr;
    if (s.leagues === 'nba') rosterStr = `${slots.nba} NBA`;
    else if (s.leagues === 'nhl') rosterStr = `${slots.nhl} NHL`;
    else rosterStr = `${slots.nba}🏀 + ${slots.nhl}🏒`;
    const draftStr = s.draftType === 'snake' ? 'Snake' : 'Linear';
    const dateLabel = getDateLabel(s.gameDate);
    const el = document.getElementById('guestSettingsSummary');
    if (el) el.textContent = `${dateLabel} · ${rosterStr} · ${draftStr} · ${s.timePerPick}s/pick · ${lobby.maxPlayers} max`;
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
  // Re-render rosters immediately to show the pick
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
  showScreen('liveScreen');
  if (pendingLivePlayers) renderLive(pendingLivePlayers, 'live');
}

socket.on('scoreUpdate', ({ players, state }) => {
  pendingLivePlayers = players; // keep updated in case still on recap
  const activeScreen = document.querySelector('.screen.active');
  if (activeScreen && activeScreen.id === 'liveScreen') {
    renderLive(players, state);
  }
  if (state === 'finished') {
    updateActiveGamePhase('finished');
    const bar = document.getElementById('liveBar');
    bar.classList.add('finished');
    bar.querySelector('.live-pip-label').textContent = 'Final';
    const sorted = [...players].sort((a, b) => b.totalScore - a.totalScore);
    if (sorted.length) {
      document.getElementById('winnerBanner').style.display = 'block';
      document.getElementById('winnerName').textContent = `${sorted[0].name} Wins!`;
      document.getElementById('winnerScore').textContent = `${sorted[0].totalScore} fantasy points`;
    }
  }
});

socket.on('error', ({ message }) => { hideDraftLoading(); showToast(message, true); });
socket.on('playerDisconnected', ({ playerName }) => showToast(`${playerName} disconnected`));

// RENDER
function renderLobbyPlayers(lobby) {
  const c = document.getElementById('playerSlots');
  const av = ['avatar-1','avatar-2','avatar-3','avatar-4','avatar-5'];
  let html = '';
  for (let i = 0; i < lobby.maxPlayers; i++) {
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

  // Filter games by current league filter
  const filteredGames = currentFilter === 'all' ? draftGames : draftGames.filter(g => g.league === currentFilter);

  // Count available players per game (also respecting league filter)
  const countByGame = {};
  let countedPlayers = availablePlayers;
  if (currentFilter !== 'all') countedPlayers = countedPlayers.filter(p => p.league === currentFilter);
  for (const p of countedPlayers) {
    countByGame[p.gameId] = (countByGame[p.gameId] || 0) + 1;
  }

  const totalPlayers = countedPlayers.length;
  const isAllActive = currentGameFilter === 'all';

  // If the currently selected game filter is no longer visible, reset to 'all'
  if (currentGameFilter !== 'all' && !filteredGames.some(g => g.gameId === currentGameFilter)) {
    currentGameFilter = 'all';
  }

  let html = `<div class="draft-game-chip chip-all ${currentGameFilter === 'all' ? 'chip-active' : ''}" onclick="setGameFilter('all')">
    <div class="dgc-info">
      <div class="dgc-matchup">All Games</div>
      <div class="dgc-count">${totalPlayers} players</div>
    </div>
  </div>`;

  // Sort: draftable games first (pre/FUT/in/LIVE), then final; within groups sort by start time
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
  currentPosFilter = 'all'; // reset position when switching game
  // Rebuild position filters for the visible subset
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
  const search = (document.getElementById('playerSearch')?.value||'').toLowerCase();
  const banner = document.getElementById('waitingBanner');
  let filtered = availablePlayers;
  if (currentGameFilter !== 'all') filtered = filtered.filter(p => p.gameId === currentGameFilter);
  if (currentFilter !== 'all') filtered = filtered.filter(p => p.league === currentFilter);
  if (currentPosFilter !== 'all') filtered = filtered.filter(p => p.position === currentPosFilter);
  if (search) filtered = filtered.filter(p => p.name.toLowerCase().includes(search) || p.team.toLowerCase().includes(search) || (p.teamName||'').toLowerCase().includes(search));
  
  // Check league slot limits for my roster
  const counts = getMyLeagueCounts();
  const slots = getLeagueSlots();
  const nbaFull = counts.nba >= (slots.nba || 99);
  const nhlFull = counts.nhl >= (slots.nhl || 99);

  banner.style.display = amIDrafting ? 'none' : 'block';

  // Slot indicator
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
    return `
    <div class="player-card ${p.league} ${isLocked?'disabled':''} ${leagueFull?'league-full':''}" onclick="${leagueFull?'':`openPlayerModal('${p.id}')`}">
      ${p.headshot?`<img class="pc-photo" src="${p.headshot}" onerror="this.outerHTML='<div class=\\'pc-photo-placeholder\\'><span class=\\'pc-pos-badge\\'>${p.position}</span></div>'">`:`<div class="pc-photo-placeholder"><span class="pc-pos-badge">${p.position}</span></div>`}
      <div class="pc-info">
        <div class="pc-name">${p.name}</div>
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
  // Vibrate on mobile
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  // Audio beep using Web Audio API
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

function draftPlayer(playerId) { if (!amIDrafting) return; socket.emit('draftPick', { playerId }); closeModal(); }

// Player Detail Modal
async function openPlayerModal(playerId) {
  const p = availablePlayers.find(pl => pl.id === playerId);
  if (!p) return;

  const modal = document.getElementById('playerModal');
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Header
  document.getElementById('modalHeader').innerHTML = `
    ${p.headshot ? `<img class="modal-photo" src="${p.headshot}" onerror="this.outerHTML='<div class=\\'modal-photo-placeholder\\'>${p.position}</div>'">`
      : `<div class="modal-photo-placeholder">${p.position}</div>`}
    <div>
      <div class="modal-name">${p.name}</div>
      <div class="modal-team-pos">${p.teamName || p.team} · ${p.position} · <span class="pc-tier ${p.tier||'bench'}" style="display:inline;">${p.tierLabel||'⚪ Bench'}</span></div>
    </div>`;

  // Season averages
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
  // Add projected score cell
  avgCells += `<div class="modal-avg-cell" style="border-color:rgba(255,87,34,0.3);"><div class="modal-avg-val" style="color:var(--accent);">${p.projectedScore||0}</div><div class="modal-avg-label">Proj FPts</div></div>`;
  document.getElementById('modalAvgGrid').innerHTML = avgCells;

  // Draft bar - check league slot limits
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

  // Game log - fetch async
  const logBody = document.getElementById('modalGameLogBody');
  logBody.innerHTML = '<div class="modal-loading">Loading game log...</div>';

  try {
    const athleteId = p.athleteId || p.id.replace('nba-','').replace('nhl-','');
    const res = await fetch(`/api/gamelog/${p.league}/${athleteId}`);
    const data = await res.json();

    if (!data.games || data.games.length === 0) {
      logBody.innerHTML = '<div class="modal-loading" style="color:var(--text-dim);">No recent games found</div>';
      return;
    }

    logBody.innerHTML = data.games.map(g => {
      let statLine = '', fpts = 0;
      if (p.league === 'nba') {
        const s = g.stats;
        statLine = `${s.points}p ${s.rebounds}r ${s.assists}a ${s.steals}s ${s.blocks}b`;
        fpts = (s.points*1) + (s.rebounds*1.5) + (s.assists*2) + (s.steals*3) + (s.blocks*3);
        // Bonuses
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
  } catch (e) {
    logBody.innerHTML = '<div class="modal-loading" style="color:var(--text-dim);">Could not load game log</div>';
  }
}

function closeModal() {
  const modal = document.getElementById('playerModal');
  modal.classList.remove('open');
  document.body.style.overflow = '';
}

// Close modal on Escape key
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
  const filterAll = document.getElementById('filterAll');
  const filterNba = document.getElementById('filterNba');
  const filterNhl = document.getElementById('filterNhl');
  if (!filterRow) return;
  if (leagues === 'nba') {
    // NBA only - hide the filter row entirely since there's only one league
    filterRow.style.display = 'none';
    currentFilter = 'all'; // reset to show all (which is only NBA)
  } else if (leagues === 'nhl') {
    // NHL only - hide the filter row entirely
    filterRow.style.display = 'none';
    currentFilter = 'all';
  } else {
    // Both - show all filters
    filterRow.style.display = 'flex';
  }
}

function setFilter(filter, btn) {
  currentFilter = filter;
  currentPosFilter = 'all'; // reset pos when switching league
  document.querySelectorAll('#draftPool .filter-chip').forEach(b => b.classList.remove('active','active-nhl'));
  btn.classList.add(filter === 'nhl' ? 'active-nhl' : 'active');
  // Rebuild position filters for visible players
  let visible = availablePlayers;
  if (currentGameFilter !== 'all') visible = visible.filter(p => p.gameId === currentGameFilter);
  if (filter !== 'all') visible = visible.filter(p => p.league === filter);
  buildPositionFilters(visible);
  renderDraftGamesBar(); // re-render games bar to reflect league filter
  filterPlayers();
}
function filterPlayers() { renderPlayerPool(); }

// Track previous scores for animations
let prevScores = {};

function renderLive(players, state) {
  const isH2H = players.length === 2;

  if (isH2H) {
    document.getElementById('matchupView').style.display = 'block';
    document.getElementById('rankListView').style.display = 'none';
    renderMatchup(players, state);
  } else {
    document.getElementById('matchupView').style.display = 'none';
    document.getElementById('rankListView').style.display = 'block';
    renderRankList(players, state);
  }

  // Store scores for delta animations
  players.forEach(p => { prevScores[p.id] = p.totalScore || 0; });
}

function renderMatchup(players, state) {
  // Figure out which is "me" and which is opponent
  let me = players.find(p => p.id === mySessionId);
  let opp = players.find(p => p.id !== mySessionId);
  // If spectating, just use order
  if (!me) { me = players[0]; opp = players[1]; }

  const myScore = me.totalScore || 0;
  const oppScore = opp.totalScore || 0;
  const diff = myScore - oppScore;

  const myState = diff > 0 ? 'leading' : diff < 0 ? 'trailing' : 'tied';
  const oppState = diff < 0 ? 'leading' : diff > 0 ? 'trailing' : 'tied';

  // Matchup header
  document.getElementById('mp-left').innerHTML = `
    <div class="mp-name ${me.id === mySessionId ? 'is-you' : ''}">${me.name}</div>
    <div class="mp-score ${myState}" id="score-${me.id}">${myScore}</div>
    <div class="mp-label">PTS</div>`;

  document.getElementById('mp-right').innerHTML = `
    <div class="mp-name ${opp.id === mySessionId ? 'is-you' : ''}">${opp.name}</div>
    <div class="mp-score ${oppState}" id="score-${opp.id}">${oppScore}</div>
    <div class="mp-label">PTS</div>`;

  // Diff pill
  const diffEl = document.getElementById('matchupDiff');
  if (diff === 0) {
    diffEl.innerHTML = `<span class="diff-pill tied-pill">TIED</span>`;
  } else {
    const absDiff = Math.abs(diff).toFixed(1);
    const isWinning = (me.id === mySessionId && diff > 0) || (me.id !== mySessionId && diff > 0);
    diffEl.innerHTML = `<span class="diff-pill ${isWinning ? 'winning' : 'losing'}">${isWinning ? '+' : '-'}${absDiff}</span>`;
  }

  // Score pop animation
  [me, opp].forEach(p => {
    if (prevScores[p.id] !== undefined && prevScores[p.id] !== (p.totalScore || 0)) {
      const el = document.getElementById(`score-${p.id}`);
      if (el) { el.classList.remove('score-changed'); void el.offsetWidth; el.classList.add('score-changed'); }
    }
  });

  // Rosters
  const av = ['avatar-1','avatar-2','avatar-3','avatar-4','avatar-5'];
  const c = document.getElementById('matchupRosters');
  c.innerHTML = [me, opp].map((p, idx) => {
    const isMe = p.id === mySessionId;
    return `
      <div class="roster-section">
        <div class="roster-section-header">
          <div class="roster-section-left">
            <div class="roster-section-avatar ${av[idx]}">${p.name.charAt(0).toUpperCase()}</div>
            <div class="roster-section-name">${p.name}${isMe ? '<span class="you-tag">(you)</span>' : ''}</div>
          </div>
          <div class="roster-section-total">${p.totalScore || 0}</div>
        </div>
        ${renderRosterCards(p.roster || [], p.id)}
      </div>`;
  }).join('');
}

function renderRankList(players, state) {
  const c = document.getElementById('rankListView');
  const sorted = [...players].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
  const av = ['avatar-1','avatar-2','avatar-3','avatar-4','avatar-5'];

  c.innerHTML = sorted.map((p, i) => {
    const rbClass = i === 0 ? 'rb1' : i === 1 ? 'rb2' : i === 2 ? 'rb3' : 'rb4';
    const isMe = p.id === mySessionId;
    return `
      <div class="rank-list-entry ${i === 0 ? 'rank-1-entry' : ''}" onclick="toggleRankExpand('rank-exp-${i}')">
        <div class="rank-badge ${rbClass}">${i + 1}</div>
        <div class="rank-info">
          <div class="rank-pname">${p.name}${isMe ? ' (you)' : ''}</div>
          <div class="rank-pmeta">${(p.roster || []).length} players</div>
        </div>
        <div class="rank-pts">${p.totalScore || 0}</div>
      </div>
      <div id="rank-exp-${i}" style="display:none;margin-bottom:10px;">
        ${renderRosterCards(p.roster || [], p.id)}
      </div>`;
  }).join('');
}

function toggleRankExpand(id) {
  const el = document.getElementById(id);
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function renderRosterCards(roster, ownerId) {
  return roster.map((pick, idx) => {
    const cardId = `rpc-${ownerId}-${idx}`;
    const statPreview = getStatPreview(pick);
    const gameStatus = pick.gameStatus || '';
    const gameClass = gameStatus.includes('LIVE') || gameStatus.includes('In Progress') || gameStatus.includes('Q') || gameStatus.includes('Half')
      ? 'game-live' : gameStatus.includes('Final') || gameStatus.includes('OFF')
      ? 'game-final' : 'game-upcoming';

    return `
      <div class="roster-player-card">
        <div class="rpc-main" onclick="togglePlayerDetail('${cardId}')">
          <div class="rpc-league-accent ${pick.league}"></div>
          ${pick.headshot
            ? `<img class="rpc-photo" src="${pick.headshot}" onerror="this.outerHTML='<div class=\\'rpc-photo-placeholder\\'>${pick.position}</div>'">`
            : `<div class="rpc-photo-placeholder">${pick.position}</div>`
          }
          <div class="rpc-info">
            <div class="rpc-name">${pick.name}</div>
            <div class="rpc-team">${pick.team} · ${pick.position}</div>
            ${gameStatus ? `<div class="rpc-game-status ${gameClass}">${gameStatus}</div>` : ''}
          </div>
          <div class="rpc-score-col">
            <div class="rpc-fantasy">${pick.fantasyScore || 0}</div>
            <div class="rpc-stat-preview">${statPreview}</div>
          </div>
          <div class="rpc-chevron" id="chev-${cardId}">▼</div>
        </div>
        <div class="rpc-details" id="${cardId}">
          ${renderStatGrid(pick)}
        </div>
      </div>`;
  }).join('');
}

function togglePlayerDetail(id) {
  const el = document.getElementById(id);
  const chev = document.getElementById('chev-' + id);
  el.classList.toggle('visible');
  chev?.classList.toggle('open');
}

function getStatPreview(pick) {
  const s = pick.stats || {};
  if (pick.league === 'nba') return `${s.points||0}p/${s.rebounds||0}r/${s.assists||0}a`;
  if (pick.league === 'nhl') {
    if (pick.isGoalie) return `${s.saves||0}sv`;
    return `${s.goals||0}g/${s.assists||0}a`;
  }
  return '';
}

function renderStatGrid(pick) {
  const s = pick.stats || {};
  let cells = '';
  let bonuses = [];

  if (pick.league === 'nba') {
    const stats = [
      { label: 'PTS', val: s.points||0, mult: 1 },
      { label: 'REB', val: s.rebounds||0, mult: 1.5 },
      { label: 'AST', val: s.assists||0, mult: 2 },
      { label: 'STL', val: s.steals||0, mult: 3 },
      { label: 'BLK', val: s.blocks||0, mult: 3 },
    ];
    cells = stats.map(st => {
      const pts = (st.val * st.mult);
      return `<div class="stat-cell">
        <div class="stat-val ${pts > 0 ? 'has-points' : ''}">${st.val}</div>
        <div class="stat-label">${st.label}</div>
        ${pts > 0 ? `<div class="stat-pts">+${pts % 1 === 0 ? pts : pts.toFixed(1)}</div>` : ''}
      </div>`;
    }).join('');

    // Check bonuses
    const cats = [s.points, s.rebounds, s.assists, s.steals, s.blocks].filter(v => v >= 10);
    if (cats.length >= 3) bonuses.push('Triple-Double +10');
    else if (cats.length >= 2) bonuses.push('Double-Double +5');
  }

  if (pick.league === 'nhl') {
    if (pick.isGoalie) {
      const stats = [
        { label: 'SAVES', val: s.saves||0, mult: 0.5 },
        { label: 'GA', val: s.goalsAgainst||0, mult: 0 },
      ];
      cells = stats.map(st => {
        const pts = st.val * st.mult;
        return `<div class="stat-cell">
          <div class="stat-val ${pts > 0 ? 'has-points' : ''}">${st.val}</div>
          <div class="stat-label">${st.label}</div>
          ${pts > 0 ? `<div class="stat-pts">+${pts % 1 === 0 ? pts : pts.toFixed(1)}</div>` : ''}
        </div>`;
      }).join('');
      if ((s.goalsAgainst||0) === 0 && (s.saves||0) > 0) bonuses.push('Shutout +5');
    } else {
      const stats = [
        { label: 'G', val: s.goals||0, mult: 5 },
        { label: 'A', val: s.assists||0, mult: 3 },
        { label: 'SOG', val: s.shotsOnGoal||0, mult: 1 },
        { label: 'BLK', val: s.blockedShots||0, mult: 2 },
      ];
      cells = stats.map(st => {
        const pts = st.val * st.mult;
        return `<div class="stat-cell">
          <div class="stat-val ${pts > 0 ? 'has-points' : ''}">${st.val}</div>
          <div class="stat-label">${st.label}</div>
          ${pts > 0 ? `<div class="stat-pts">+${pts}</div>` : ''}
        </div>`;
      }).join('');
      if ((s.goals||0) >= 3) bonuses.push('Hat Trick +3');
    }
  }

  let bonusHtml = '';
  if (bonuses.length) {
    bonusHtml = `<div class="bonus-row">${bonuses.map(b => `<div class="bonus-chip">🌟 ${b}</div>`).join('')}</div>`;
  }

  return `<div class="stat-grid">${cells}</div>${bonusHtml}`;
}
