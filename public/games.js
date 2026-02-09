// My Games Page
const socket = io();

let mySessionId = localStorage.getItem('dr_sessionId') || '';
let currentFilter = 'all';
let games = {};

// Initialize
loadGames();

// Get active games from localStorage
function getActiveGames() {
  const stored = localStorage.getItem('dr_activeGames');
  return stored ? JSON.parse(stored) : {};
}

// Load games
function loadGames() {
  games = getActiveGames();
  renderGames();
}

// Render games list
function renderGames() {
  const gamesList = document.getElementById('gamesList');
  const emptyState = document.getElementById('emptyState');
  const gameArray = Object.values(games);
  
  // Update counts
  const allCount = gameArray.length;
  const liveCount = gameArray.filter(g => g.phase === 'live').length;
  const draftingCount = gameArray.filter(g => g.phase === 'drafting').length;
  const waitingCount = gameArray.filter(g => g.phase === 'waiting').length;
  const finishedCount = gameArray.filter(g => g.phase === 'finished').length;
  
  document.getElementById('countAll').textContent = allCount;
  document.getElementById('countLive').textContent = liveCount;
  document.getElementById('countDrafting').textContent = draftingCount;
  document.getElementById('countWaiting').textContent = waitingCount;
  document.getElementById('countFinished').textContent = finishedCount;
  
  // Show empty state if no games
  if (gameArray.length === 0) {
    gamesList.style.display = 'none';
    emptyState.style.display = 'flex';
    return;
  }
  
  gamesList.style.display = 'flex';
  emptyState.style.display = 'none';
  
  // Sort by urgency: Live > Drafting > Waiting > Finished
  const phaseOrder = { live: 1, drafting: 2, waiting: 3, finished: 4 };
  gameArray.sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase]);
  
  // Render game cards
  gamesList.innerHTML = gameArray.map(game => {
    const phaseIcon = game.phase === 'live' ? '🔴' :
                      game.phase === 'drafting' ? '⚔️' :
                      game.phase === 'waiting' ? '⏳' : '✅';
    const phaseLabel = game.phase === 'live' ? 'Live' :
                       game.phase === 'drafting' ? 'Drafting' :
                       game.phase === 'waiting' ? 'In Lobby' : 'Finished';
    
    // Button text based on phase
    const primaryBtnText = game.phase === 'live' ? '👁️ Watch' :
                           game.phase === 'drafting' ? '▶️ Continue Draft' :
                           game.phase === 'waiting' ? '▶️ Rejoin Lobby' : '📊 View Results';
    
    const secondaryBtnText = game.phase === 'finished' ? '🗑️ Delete' : '👋 Leave';
    
    // Time info
    const lastUpdated = game.lastUpdated ? new Date(game.lastUpdated) : null;
    const timeAgo = lastUpdated ? getTimeAgo(lastUpdated) : '';
    
    return `
      <div class="game-card ${game.phase}" data-phase="${game.phase}">
        <div class="game-card-header">
          <div class="game-card-status">${phaseIcon} ${phaseLabel}</div>
          <div class="game-card-code">Room ${game.lobbyId}</div>
        </div>
        <div class="game-card-info">
          <div class="game-card-player">Playing as <strong>${game.playerName}</strong></div>
          ${timeAgo ? `<div class="game-card-meta">
            <div class="game-card-meta-item">⏱️ ${timeAgo}</div>
          </div>` : ''}
        </div>
        <div class="game-card-actions">
          <button class="game-card-btn primary" onclick="rejoinGame('${game.lobbyId}')">
            ${primaryBtnText}
          </button>
          <button class="game-card-btn danger" onclick="leaveGame('${game.lobbyId}', ${game.phase === 'finished'})">
            ${secondaryBtnText}
          </button>
        </div>
      </div>
    `;
  }).join('');
  
  // Apply filter
  applyFilter();
}

// Filter games
function filterGames(filter) {
  currentFilter = filter;
  
  // Update active tab
  document.querySelectorAll('.games-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  document.querySelector(`[data-filter="${filter}"]`).classList.add('active');
  
  applyFilter();
}

function applyFilter() {
  const cards = document.querySelectorAll('.game-card');
  cards.forEach(card => {
    const phase = card.dataset.phase;
    if (currentFilter === 'all' || phase === currentFilter) {
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
  });
}

// Rejoin or view game
function rejoinGame(lobbyId) {
  const game = games[lobbyId];
  if (!game) {
    alert('Game not found');
    return;
  }
  
  // For finished games, always go to live.html to view final scores
  if (game.phase === 'finished' || game.phase === 'live') {
    window.location.href = `/live.html?lobby=${lobbyId}`;
  } else {
    // For waiting/drafting, go to home to rejoin
    window.location.href = `/?rejoin=${lobbyId}`;
  }
}

// Leave or delete game
function leaveGame(lobbyId, isFinished = false) {
  const action = isFinished ? 'delete' : 'leave';
  const message = isFinished 
    ? 'Delete this finished game? You can no longer view the results.' 
    : 'Are you sure you want to leave this game?';
  
  if (!confirm(message)) {
    return;
  }
  
  // Remove from localStorage
  delete games[lobbyId];
  localStorage.setItem('dr_activeGames', JSON.stringify(games));
  
  // Emit leave event to server (removes from Firestore)
  socket.emit('leaveGame', { lobbyId, sessionId: mySessionId });
  
  console.log(`${isFinished ? '🗑️ Deleted' : '👋 Left'} game ${lobbyId}`);
  
  // Re-render
  renderGames();
}

// Go home
function goHome() {
  window.location.href = '/';
}

// Time ago helper
function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Refresh games periodically
setInterval(loadGames, 30000); // Every 30 seconds
