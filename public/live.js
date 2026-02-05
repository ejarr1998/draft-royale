const socket = io();

let mySessionId = localStorage.getItem('dr_sessionId') || '';
let myLobbyId = null;
let gameState = null;
let prevScores = {};
let activityFeedItems = [];
let myRosterCollapsed = false;
let opponentCollapseState = {};

const avatarClasses = ['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4', 'avatar-5'];

// Initialize
socket.on('connect', () => {
  console.log('🔌 Socket connected');
  const urlParams = new URLSearchParams(window.location.search);
  const lobbyId = urlParams.get('lobby');
  console.log('📋 URL params:', { lobbyId, mySessionId });
  
  if (lobbyId && mySessionId) {
    myLobbyId = lobbyId;
    console.log('📤 Sending rejoin request...');
    socket.emit('rejoin', { sessionId: mySessionId });
  } else {
    console.error('❌ Missing lobbyId or sessionId');
  }
});

socket.on('rejoinState', (data) => {
  console.log('📥 Received rejoinState:', {
    phase: data.phase,
    lobbyId: data.lobby?.id,
    playerCount: data.players?.length
  });
  
  if (data.phase === 'live' || data.phase === 'finished') {
    myLobbyId = data.lobby.id;
    gameState = data;
    console.log('✅ Set gameState, rendering live screen');
    renderLiveScreen(data.players, data.phase);
  } else {
    console.warn('❌ Not in live/finished phase, redirecting home');
    window.location.href = '/';
  }
});

socket.on('scoreUpdate', ({ players, state }) => {
  console.log('📊 Received scoreUpdate:', {
    playerCount: players.length,
    state,
    hasGameState: !!gameState,
    scores: players.map(p => ({ name: p.name, score: p.totalScore }))
  });
  
  if (gameState) {
    gameState.players = players;
    gameState.phase = state;
    renderLiveScreen(players, state);
    console.log('✅ Updated live screen');
  } else {
    console.warn('❌ No gameState - cannot update screen');
  }
});

// Main render function
function renderLiveScreen(players, phase) {
  const isH2H = players.length === 2;
  
  // Update status indicator
  const statusEl = document.querySelector('.live-status');
  const statusText = document.querySelector('.live-status-text');
  if (phase === 'finished') {
    statusEl.classList.add('finished');
    statusText.textContent = 'FINAL';
  } else {
    statusEl.classList.remove('finished');
    statusText.textContent = 'LIVE';
  }
  
  // Render appropriate header
  if (isH2H) {
    renderH2HHeader(players);
    document.getElementById('h2hHeader').style.display = 'block';
    document.getElementById('rankingsHeader').style.display = 'none';
  } else {
    renderRankingsHeader(players);
    document.getElementById('h2hHeader').style.display = 'none';
    document.getElementById('rankingsHeader').style.display = 'block';
  }
  
  // Render rosters
  renderRosters(players);
  
  // Render active games
  renderActiveGames(players);
  
  // Show winner banner if finished
  if (phase === 'finished') {
    showWinnerBanner(players);
  }
  
  // Track scores for next update
  players.forEach(p => {
    prevScores[p.id] = p.totalScore || 0;
  });
}

// H2H Header
function renderH2HHeader(players) {
  let me = players.find(p => p.id === mySessionId);
  let opp = players.find(p => p.id !== mySessionId);
  if (!me) { me = players[0]; opp = players[1]; }
  
  const myScore = me.totalScore || 0;
  const oppScore = opp.totalScore || 0;
  const diff = myScore - oppScore;
  
  // Left side (me)
  document.getElementById('h2hAvatarLeft').className = `h2h-avatar ${avatarClasses[0]}`;
  document.getElementById('h2hAvatarLeft').textContent = me.name.charAt(0).toUpperCase();
  document.getElementById('h2hNameLeft').textContent = me.name;
  
  const leftScore = document.getElementById('h2hScoreLeft');
  leftScore.textContent = myScore.toFixed(1);
  leftScore.className = 'h2h-score ' + (diff > 0 ? 'leading' : diff < 0 ? 'trailing' : 'tied');
  
  // Right side (opponent)
  document.getElementById('h2hAvatarRight').className = `h2h-avatar ${avatarClasses[1]}`;
  document.getElementById('h2hAvatarRight').textContent = opp.name.charAt(0).toUpperCase();
  document.getElementById('h2hNameRight').textContent = opp.name;
  
  const rightScore = document.getElementById('h2hScoreRight');
  rightScore.textContent = oppScore.toFixed(1);
  rightScore.className = 'h2h-score ' + (diff < 0 ? 'leading' : diff > 0 ? 'trailing' : 'tied');
  
  // Differential
  const diffEl = document.getElementById('h2hDiff');
  if (diff === 0) {
    diffEl.textContent = 'TIED';
    diffEl.className = 'h2h-diff tied';
  } else {
    const absDiff = Math.abs(diff).toFixed(1);
    diffEl.textContent = `${diff > 0 ? '+' : ''}${diff.toFixed(1)}`;
    diffEl.className = `h2h-diff ${diff > 0 ? 'winning' : 'losing'}`;
  }
  
  // Animate score changes
  if (prevScores[me.id] !== undefined && prevScores[me.id] !== myScore) {
    leftScore.classList.add('score-bump');
    setTimeout(() => leftScore.classList.remove('score-bump'), 500);
    addActivityItem(me, myScore - prevScores[me.id]);
  }
  if (prevScores[opp.id] !== undefined && prevScores[opp.id] !== oppScore) {
    rightScore.classList.add('score-bump');
    setTimeout(() => rightScore.classList.remove('score-bump'), 500);
    addActivityItem(opp, oppScore - prevScores[opp.id]);
  }
}

// Rankings Header
function renderRankingsHeader(players) {
  const sorted = [...players].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
  const list = document.getElementById('rankingsList');
  
  list.innerHTML = sorted.map((p, i) => {
    const isMe = p.id === mySessionId;
    const posClass = i === 0 ? 'pos-1' : i === 1 ? 'pos-2' : i === 2 ? 'pos-3' : 'pos-other';
    return `
      <div class="ranking-item ${isMe ? 'me' : ''}">
        <div class="ranking-pos ${posClass}">${i + 1}</div>
        <div class="ranking-avatar ${avatarClasses[i % 5]}">${p.name.charAt(0).toUpperCase()}</div>
        <div class="ranking-info">
          <div class="ranking-name">${p.name}${isMe ? ' (You)' : ''}</div>
          <div class="ranking-players">${(p.roster || []).length} players</div>
        </div>
        <div class="ranking-score">${(p.totalScore || 0).toFixed(1)}</div>
      </div>
    `;
  }).join('');
}

// Activity Feed
function addActivityItem(player, pointsChange) {
  if (pointsChange === 0) return;
  
  const isPositive = pointsChange > 0;
  const item = {
    player: player.name,
    points: pointsChange,
    isPositive,
    timestamp: Date.now()
  };
  
  activityFeedItems.unshift(item);
  if (activityFeedItems.length > 10) activityFeedItems.pop();
  
  renderActivityFeed();
}

function renderActivityFeed() {
  const feed = document.getElementById('activityFeed');
  
  if (activityFeedItems.length === 0) {
    feed.innerHTML = '<div class="activity-empty">Waiting for game action...</div>';
    return;
  }
  
  feed.innerHTML = activityFeedItems.map(item => `
    <div class="activity-item ${item.isPositive ? 'positive' : 'negative'}">
      <span class="activity-player">${item.player}</span>
      <span class="activity-points ${item.isPositive ? 'positive' : 'negative'}">
        ${item.isPositive ? '+' : ''}${item.points.toFixed(1)}
      </span>
    </div>
  `).join('');
}

// Active Games
function renderActiveGames(players) {
  // Extract unique games from all player rosters
  const gamesMap = {};
  
  players.forEach(player => {
    (player.roster || []).forEach(pick => {
      const gameId = pick.gameId || `${pick.team}-game`;
      if (!gamesMap[gameId]) {
        gamesMap[gameId] = {
          gameId,
          league: pick.league,
          gameStatus: pick.gameStatus || '',
          teams: pick.opponent || pick.team,
          players: []
        };
      }
      gamesMap[gameId].players.push(pick);
    });
  });
  
  const games = Object.values(gamesMap);
  const scroll = document.getElementById('activeGamesScroll');
  
  if (games.length === 0) {
    scroll.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem;">No active games</div>';
    return;
  }
  
  scroll.innerHTML = games.map(g => {
    const isLive = g.gameStatus && (g.gameStatus.includes('LIVE') || g.gameStatus.includes('Q') || g.gameStatus.includes('Half'));
    const isFinal = g.gameStatus && (g.gameStatus.includes('Final') || g.gameStatus.includes('OFF'));
    const timeClass = isLive ? 'live' : isFinal ? 'final' : 'upcoming';
    
    return `
      <div class="game-chip">
        <div class="game-chip-league ${g.league}">${g.league.toUpperCase()}</div>
        <div class="game-chip-matchup">${g.teams}</div>
        <div class="game-chip-time ${timeClass}">${g.gameStatus || 'Scheduled'}</div>
      </div>
    `;
  }).join('');
}

// Rosters
function renderRosters(players) {
  const me = players.find(p => p.id === mySessionId) || players[0];
  const opponents = players.filter(p => p.id !== mySessionId);
  
  // My roster
  renderMyRoster(me);
  
  // Opponent rosters
  const oppContainer = document.getElementById('opponentRosters');
  oppContainer.innerHTML = opponents.map((p, idx) => renderOpponentRoster(p, idx)).join('');
}

function renderMyRoster(player) {
  document.getElementById('myAvatarSmall').className = `roster-avatar-small ${avatarClasses[0]}`;
  document.getElementById('myAvatarSmall').textContent = player.name.charAt(0).toUpperCase();
  document.getElementById('myRosterName').textContent = player.name;
  document.getElementById('myRosterScore').textContent = `${(player.totalScore || 0).toFixed(1)} pts`;
  
  const body = document.getElementById('myRosterBody');
  body.innerHTML = (player.roster || []).map((pick, idx) => renderPlayerCard(pick, player.id, idx)).join('');
  
  // Apply collapse state
  if (myRosterCollapsed) {
    body.classList.add('collapsed');
    document.getElementById('myCollapseBtn').classList.add('collapsed');
  }
}

function renderOpponentRoster(player, idx) {
  const avatarClass = avatarClasses[(idx + 1) % 5];
  const isCollapsed = opponentCollapseState[player.id] || false;
  
  return `
    <div class="roster-container">
      <div class="roster-header" onclick="toggleOpponentRoster('${player.id}')">
        <div class="roster-header-left">
          <div class="roster-avatar-small ${avatarClass}">${player.name.charAt(0).toUpperCase()}</div>
          <div class="roster-header-title">
            <div class="roster-header-name">${player.name}</div>
            <div class="roster-header-score">${(player.totalScore || 0).toFixed(1)} pts</div>
          </div>
        </div>
        <button class="roster-collapse-btn ${isCollapsed ? 'collapsed' : ''}" id="collapse-${player.id}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="18 15 12 9 6 15"></polyline>
          </svg>
        </button>
      </div>
      <div class="roster-body ${isCollapsed ? 'collapsed' : ''}" id="roster-body-${player.id}">
        ${(player.roster || []).map((pick, i) => renderPlayerCard(pick, player.id, i)).join('')}
      </div>
    </div>
  `;
}

function renderPlayerCard(pick, ownerId, idx) {
  const cardId = `player-${ownerId}-${idx}`;
  const statPreview = getStatPreview(pick);
  
  const gameStatus = pick.gameStatus || '';
  const gameClass = gameStatus.includes('LIVE') || gameStatus.includes('Q') || gameStatus.includes('Half')
    ? 'live' : gameStatus.includes('Final') || gameStatus.includes('OFF')
    ? 'final' : 'upcoming';
  
  return `
    <div class="player-roster-card" onclick="togglePlayerDetail('${cardId}')">
      <div class="player-card-league-bar ${pick.league}"></div>
      ${pick.headshot
        ? `<img class="player-card-photo" src="${pick.headshot}" onerror="this.outerHTML='<div class=\\'player-card-photo-placeholder\\'>${pick.position}</div>'">`
        : `<div class="player-card-photo-placeholder">${pick.position}</div>`
      }
      <div class="player-card-info">
        <div class="player-card-name">${pick.name}</div>
        <div class="player-card-team">${pick.team} · ${pick.position}</div>
        ${gameStatus ? `<div class="player-card-game-status ${gameClass}">${gameStatus}</div>` : ''}
      </div>
      <div class="player-card-stats">
        <div class="player-card-fantasy">${(pick.fantasyScore || 0).toFixed(1)}</div>
        <div class="player-card-stat-line">${statPreview}</div>
      </div>
      <div class="player-card-chevron" id="chevron-${cardId}">▼</div>
    </div>
    <div class="player-details" id="${cardId}">
      ${renderStatGrid(pick)}
    </div>
  `;
}

function getStatPreview(pick) {
  const s = pick.stats || {};
  if (pick.league === 'nba') return `${s.points||0}p ${s.rebounds||0}r ${s.assists||0}a`;
  if (pick.league === 'nhl') {
    if (pick.isGoalie) return `${s.saves||0}sv ${s.goalsAgainst||0}ga`;
    return `${s.goals||0}g ${s.assists||0}a`;
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
        { label: 'G', val: s.goals||0, mult: 9 },
        { label: 'A', val: s.assists||0, mult: 6 },
        { label: 'SOG', val: s.shotsOnGoal||0, mult: 3 },
        { label: 'BLK', val: s.blockedShots||0, mult: 5 },
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

// Toggle functions
function toggleMyRoster() {
  myRosterCollapsed = !myRosterCollapsed;
  document.getElementById('myRosterBody').classList.toggle('collapsed');
  document.getElementById('myCollapseBtn').classList.toggle('collapsed');
}

function toggleOpponentRoster(playerId) {
  opponentCollapseState[playerId] = !opponentCollapseState[playerId];
  document.getElementById(`roster-body-${playerId}`).classList.toggle('collapsed');
  document.getElementById(`collapse-${playerId}`).classList.toggle('collapsed');
}

function togglePlayerDetail(cardId) {
  const details = document.getElementById(cardId);
  const chevron = document.getElementById(`chevron-${cardId}`);
  details.classList.toggle('visible');
  chevron.classList.toggle('open');
}

// Winner banner
function showWinnerBanner(players) {
  const sorted = [...players].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));
  if (sorted.length === 0) return;
  
  const winner = sorted[0];
  document.getElementById('winnerName').textContent = `${winner.name} Wins!`;
  document.getElementById('winnerScore').textContent = `${(winner.totalScore || 0).toFixed(1)} fantasy points`;
  document.getElementById('winnerBanner').style.display = 'block';
}

// Navigation
function goHome() {
  console.log('🏠 Going home from live screen');
  console.log('Redirecting to index.html...');
  
  // Force fresh load of index.html, bypass cache
  window.location.replace('/index.html');
}

function leaveGame() {
  if (!confirm('Leave this game permanently? You won\'t be able to rejoin.')) return;
  
  console.log('🚪 Leaving game:', { myLobbyId, mySessionId });
  
  // Remove this specific game from multi-game storage
  const games = JSON.parse(localStorage.getItem('dr_activeGames') || '{}');
  if (myLobbyId) {
    delete games[myLobbyId];
    localStorage.setItem('dr_activeGames', JSON.stringify(games));
    console.log('✅ Removed game from storage');
  }
  
  // Notify server to remove from THIS lobby only
  if (myLobbyId && mySessionId) {
    socket.emit('leaveGame', { sessionId: mySessionId, lobbyId: myLobbyId });
  }
  
  // Clean up old storage format (backwards compatibility)
  localStorage.removeItem('dr_activeGame');
  
  // Check if user has other active games
  const remainingGames = Object.keys(games).length;
  console.log(`📊 ${remainingGames} other games remaining`);
  
  // Redirect home (user can access other games from there)
  setTimeout(() => {
    window.location.href = '/';
  }, 100);
}

// Toast
function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast visible' + (isError ? ' error' : '');
  setTimeout(() => t.classList.remove('visible'), 3000);
}
