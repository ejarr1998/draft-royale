// My Games Page
const socket = io();

let mySessionId = localStorage.getItem('dr_sessionId') || '';
let currentUser = null;
let currentFilter = 'all';
let games = {};

// Firebase already initialized in firebase-config.js
// db, auth, firebase are already available globally

// Wait for auth, then load games
auth.onAuthStateChanged(async (user) => {
  console.log('🔐 Auth state changed:', user ? user.uid : 'no user');
  
  if (user) {
    currentUser = user;
    mySessionId = user.uid;
    console.log('✅ Authenticated as:', user.displayName, user.uid);
    
    // TEST: Direct query to see what's in Firestore
    console.log('🧪 TEST: Querying Firestore directly...');
    try {
      const testDoc = await db.collection('users').doc(user.uid).get();
      console.log('   User doc exists?', testDoc.exists);
      if (testDoc.exists) {
        const data = testDoc.data();
        console.log('   Full user data:', data);
        console.log('   activeGames field:', data.activeGames);
        console.log('   activeGames type:', typeof data.activeGames);
        console.log('   activeGames isArray:', Array.isArray(data.activeGames));
      }
    } catch (err) {
      console.error('   ❌ Test query failed:', err);
    }
    
    console.log('   Calling loadGames()...');
    
    try {
      await loadGames();
      console.log('   ✅ loadGames() completed');
    } catch (err) {
      console.error('   ❌ loadGames() failed:', err);
    }
  } else {
    console.log('❌ Not authenticated, redirecting to home...');
    setTimeout(() => {
      window.location.href = '/';
    }, 1000);
  }
});

// Load games from Firestore (database)
async function loadGames() {
  console.log('📡 loadGames() called');
  console.log('   currentUser:', currentUser ? currentUser.uid : 'null');
  
  if (!currentUser) {
    console.warn('   ⚠️ No user, cannot load games');
    games = {};
    renderGames();
    return;
  }
  
  try {
    console.log(`   Fetching user document from Firestore...`);
    
    const userRef = db.collection('users').doc(currentUser.uid);
    console.log('   User ref:', userRef.path);
    
    const userDoc = await userRef.get();
    console.log('   User doc exists?', userDoc.exists);
    
    if (!userDoc.exists) {
      console.warn('   ⚠️ User document does not exist in Firestore');
      games = {};
      renderGames();
      return;
    }
    
    const userData = userDoc.data();
    console.log('   User data:', userData);
    
    // Load active games
    const activeGamesArray = userData?.activeGames || [];
    console.log(`   📂 Found ${activeGamesArray.length} active games`);
    
    // Load game history IDs
    const gameHistoryIds = userData?.gameHistory || [];
    console.log(`   📜 Found ${gameHistoryIds.length} games in history`);
    
    // Convert active games to object format
    games = {};
    for (const game of activeGamesArray) {
      if (!game || !game.lobbyId) {
        console.warn('   ⚠️ Invalid game object:', game);
        continue;
      }
      
      games[game.lobbyId] = {
        lobbyId: game.lobbyId,
        phase: game.phase || 'waiting',
        playerName: game.playerName || 'Unknown',
        lastUpdated: game.lastUpdated,
        isHistory: false
      };
    }
    
    // Load completed games from gameHistory collection
    if (gameHistoryIds.length > 0) {
      console.log(`   📖 Loading ${gameHistoryIds.length} completed games...`);
      
      for (const gameId of gameHistoryIds) {
        try {
          const gameDoc = await db.collection('gameHistory').doc(gameId).get();
          
          if (gameDoc.exists) {
            const gameData = gameDoc.data();
            const player = gameData.players?.find(p => p.uid === currentUser.uid);
            
            games[gameId] = {
              lobbyId: gameId,
              phase: 'completed', // Special phase for archived games
              playerName: player?.name || 'Unknown',
              lastUpdated: gameData.finishedAt?.toMillis() || gameData.createdAt,
              isHistory: true,
              winner: gameData.winner,
              finalScore: player?.score || 0,
              finalStandings: gameData.players
            };
          }
        } catch (err) {
          console.error(`   Error loading game ${gameId}:`, err.message);
        }
      }
    }
    
    console.log(`   ✅ Converted to ${Object.keys(games).length} total games`);
    console.log('   Games object:', games);
    
    // Cache to localStorage
    localStorage.setItem('dr_activeGames', JSON.stringify(games));
    
    renderGames();
  } catch (err) {
    console.error('   ❌ Error loading games from Firestore:', err);
    console.error('   Error details:', err.message, err.stack);
    games = {};
    renderGames();
  }
}

// Render games list
function renderGames() {
  const gamesList = document.getElementById('gamesList');
  const emptyState = document.getElementById('emptyState');
  const gameArray = Object.values(games);
  
  console.log(`🎮 Rendering ${gameArray.length} games:`, gameArray);
  
  // Update counts
  const allCount = gameArray.length;
  const liveCount = gameArray.filter(g => g.phase === 'live').length;
  const draftingCount = gameArray.filter(g => g.phase === 'drafting').length;
  const waitingCount = gameArray.filter(g => g.phase === 'waiting').length;
  const finishedCount = gameArray.filter(g => g.phase === 'finished').length;
  const completedCount = gameArray.filter(g => g.phase === 'completed').length;
  
  console.log(`   Phase counts: Live=${liveCount}, Drafting=${draftingCount}, Waiting=${waitingCount}, Finished=${finishedCount}, Completed=${completedCount}`);
  
  document.getElementById('countAll').textContent = allCount;
  document.getElementById('countLive').textContent = liveCount;
  document.getElementById('countDrafting').textContent = draftingCount;
  document.getElementById('countWaiting').textContent = waitingCount;
  document.getElementById('countFinished').textContent = finishedCount;
  document.getElementById('countCompleted').textContent = completedCount;
  
  // Show empty state if no games
  if (gameArray.length === 0) {
    gamesList.style.display = 'none';
    emptyState.style.display = 'flex';
    return;
  }
  
  gamesList.style.display = 'flex';
  emptyState.style.display = 'none';
  
  // Sort by urgency: Live > Drafting > Waiting > Finished > Completed
  const phaseOrder = { live: 1, drafting: 2, waiting: 3, finished: 4, completed: 5 };
  gameArray.sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase]);
  
  // Render game cards
  gamesList.innerHTML = gameArray.map(game => {
    const phaseLabel = game.phase === 'live' ? 'Live' :
                       game.phase === 'drafting' ? 'Drafting' :
                       game.phase === 'waiting' ? 'Lobby' :
                       game.phase === 'completed' ? 'Completed' : 'Finished';
    
    // Button text based on phase
    const primaryBtnText = game.phase === 'live' ? 'Watch Live' :
                           game.phase === 'drafting' ? 'Continue Draft' :
                           game.phase === 'waiting' ? 'Rejoin Lobby' :
                           game.phase === 'completed' ? 'View Results' : 'View Results';
    
    const secondaryBtnText = (game.phase === 'finished' || game.phase === 'completed') ? 'Delete' : 'Leave';
    
    // Time info - handle various timestamp formats
    let lastUpdated = null;
    if (game.lastUpdated) {
      if (typeof game.lastUpdated === 'number') {
        lastUpdated = new Date(game.lastUpdated);
      } else if (game.lastUpdated.toDate) {
        // Firestore Timestamp
        lastUpdated = game.lastUpdated.toDate();
      } else if (game.lastUpdated instanceof Date) {
        lastUpdated = game.lastUpdated;
      }
    }
    const timeAgo = lastUpdated ? getTimeAgo(lastUpdated) : '';
    
    // For completed games, show winner and score
    let extraInfo = '';
    if (game.phase === 'completed' && game.winner) {
      const isWinner = game.winner.uid === (currentUser ? currentUser.uid : null);
      extraInfo = `
        <div class="game-card-winner">
          ${isWinner ? '🏆 You won!' : `🏆 ${game.winner.name} won`} · ${game.finalScore || 0} pts
        </div>
      `;
    }
    
    return `
      <div class="game-card ${game.phase}" data-phase="${game.phase}">
        <div class="game-card-header">
          <div class="game-card-status">
            <div class="status-indicator"></div>
            ${phaseLabel}
          </div>
          <div class="game-card-code">${game.lobbyId}</div>
        </div>
        <div class="game-card-info">
          <div class="game-card-player">Playing as <strong>${game.playerName}</strong></div>
          ${extraInfo}
          ${timeAgo ? `<div class="game-card-meta">
            <div class="game-card-meta-item">${timeAgo}</div>
          </div>` : ''}
        </div>
        <div class="game-card-actions">
          <button class="game-card-btn primary" onclick="rejoinGame('${game.lobbyId}')">
            ${primaryBtnText}
          </button>
          <button class="game-card-btn danger" onclick="leaveGame('${game.lobbyId}', ${game.phase === 'finished' || game.phase === 'completed'})">
            ${secondaryBtnText}
          </button>
        </div>
      </div>
    `;
  }).join('');
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
async function leaveGame(lobbyId, isFinished = false) {
  const game = games[lobbyId];
  const isCompleted = game?.phase === 'completed';
  
  const action = isFinished || isCompleted ? 'delete' : 'leave';
  const message = isFinished || isCompleted
    ? 'Delete this game? You can no longer view the results.' 
    : 'Are you sure you want to leave this game?';
  
  if (!confirm(message)) {
    return;
  }
  
  try {
    // Remove from Firestore
    if (currentUser) {
      const userRef = db.collection('users').doc(currentUser.uid);
      const userDoc = await userRef.get();
      
      if (userDoc.exists) {
        if (isCompleted) {
          // Remove from gameHistory array
          const gameHistory = userDoc.data().gameHistory || [];
          const updatedHistory = gameHistory.filter(id => id !== lobbyId);
          await userRef.update({ gameHistory: updatedHistory });
          console.log(`✅ Removed ${lobbyId} from gameHistory`);
        } else {
          // Remove from activeGames array
          const activeGames = userDoc.data().activeGames || [];
          const updatedGames = activeGames.filter(g => g.lobbyId !== lobbyId);
          await userRef.update({ activeGames: updatedGames });
          console.log(`✅ Removed ${lobbyId} from activeGames`);
        }
      }
    }
    
    // Emit leave event to server (removes from lobby)
    socket.emit('leaveGame', { lobbyId, sessionId: mySessionId });
    
    console.log(`${isFinished || isCompleted ? '🗑️ Deleted' : '👋 Left'} game ${lobbyId}`);
    
    // Reload games from Firestore
    await loadGames();
    
  } catch (err) {
    console.error('Error leaving game:', err);
    alert('Failed to leave game. Please try again.');
  }
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
