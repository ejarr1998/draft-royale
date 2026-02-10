// Authentication State Management
let currentUser = null;

// Auth state listener
auth.onAuthStateChanged(async (user) => {
  console.log('🔐 Auth state changed:', user ? user.uid : 'signed out');
  
  if (user) {
    currentUser = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || user.email.split('@')[0],
      photoURL: user.photoURL
    };
    
    // CRITICAL: Set mySessionId to UID for consistency with server
    mySessionId = user.uid;
    localStorage.setItem('dr_sessionId', user.uid);
    console.log('✅ Set mySessionId to UID:', mySessionId);
    
    // Ensure user document exists
    await ensureUserDocument(user);
    
    // Authenticate socket with UID (if socket is already connected)
    if (typeof authenticateSocket === 'function') {
      authenticateSocket();
    }
    
    // Load active games
    await loadActiveGamesFromFirestore();
    
    // Show main app
    showMainApp();
    
  } else {
    currentUser = null;
    showLoginScreen();
  }
});

// Ensure user document exists in Firestore
async function ensureUserDocument(user) {
  const userRef = db.collection('users').doc(user.uid);
  const userDoc = await userRef.get();
  
  if (!userDoc.exists) {
    console.log('📝 Creating user document for', user.uid);
    await userRef.set({
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || user.email.split('@')[0],
      photoURL: user.photoURL || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      activeGames: [],
      stats: {
        gamesPlayed: 0,
        wins: 0,
        totalPoints: 0
      }
    });
  }
}

// Load active games from Firestore
async function loadActiveGamesFromFirestore() {
  if (!currentUser) return;
  
  try {
    const userDoc = await db.collection('users').doc(currentUser.uid).get();
    const activeGamesArray = userDoc.data()?.activeGames || [];
    
    console.log(`📂 Loading ${activeGamesArray.length} active games from Firestore`);
    
    // Convert array to object format for localStorage (cache only)
    const games = {};
    for (const game of activeGamesArray) {
      // New format already has {lobbyId, phase, playerName, lastUpdated}
      games[game.lobbyId] = {
        lobbyId: game.lobbyId,
        phase: game.phase,
        playerName: game.playerName,
        lastUpdated: game.lastUpdated?.toMillis ? game.lastUpdated.toMillis() : game.lastUpdated,
        isHistory: false
      };
    }
    
    console.log(`✅ Loaded games:`, Object.keys(games));
    
    // Cache to localStorage (Firestore is source of truth)
    localStorage.setItem('dr_activeGames', JSON.stringify(games));
    
    // Update My Games button
    if (typeof updateMyGamesButton === 'function') {
      updateMyGamesButton();
    }
    
  } catch (err) {
    console.error('Error loading active games:', err);
  }
}

// Sync active games from localStorage to Firestore
async function syncActiveGamesToFirestore(games) {
  if (!currentUser) return;
  
  try {
    // Convert object to array format
    const activeGamesArray = Object.values(games).map(game => ({
      lobbyId: game.lobbyId,
      phase: game.phase,
      playerName: game.playerName,
      lastUpdated: new Date(game.lastUpdated || Date.now())
    }));
    
    await db.collection('users').doc(currentUser.uid).update({
      activeGames: activeGamesArray
    });
    
    console.log(`💾 Synced ${activeGamesArray.length} games to Firestore`);
  } catch (err) {
    console.error('Error syncing games to Firestore:', err);
  }
}

// Sign in with Google
async function signInWithGoogle() {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
    console.log('✅ Signed in with Google');
  } catch (err) {
    console.error('Google sign-in error:', err);
    showToast('Sign-in failed: ' + err.message, true);
  }
}

// Sign in with email/password
async function signInWithEmail(email, password) {
  try {
    await auth.signInWithEmailAndPassword(email, password);
    console.log('✅ Signed in with email');
  } catch (err) {
    console.error('Email sign-in error:', err);
    showToast('Sign-in failed: ' + err.message, true);
  }
}

// Sign up with email/password
async function signUpWithEmail(email, password, displayName) {
  try {
    const result = await auth.createUserWithEmailAndPassword(email, password);
    
    // Update profile with display name
    await result.user.updateProfile({ displayName });
    
    // Create user document
    await db.collection('users').doc(result.user.uid).set({
      uid: result.user.uid,
      email,
      displayName,
      photoURL: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      activeGames: [],
      stats: { gamesPlayed: 0, wins: 0, totalPoints: 0 }
    });
    
    console.log('✅ Account created');
  } catch (err) {
    console.error('Sign-up error:', err);
    showToast('Sign-up failed: ' + err.message, true);
  }
}

// Sign out
async function signOut() {
  try {
    await auth.signOut();
    localStorage.clear();
    console.log('✅ Signed out');
  } catch (err) {
    console.error('Sign-out error:', err);
  }
}

// Show login screen
function showLoginScreen() {
  document.getElementById('loginScreen')?.classList.add('active');
  document.getElementById('homeScreen')?.classList.remove('active');
  document.getElementById('lobbyScreen')?.classList.remove('active');
  document.getElementById('draftScreen')?.classList.remove('active');
}

// Show main app
function showMainApp() {
  console.log('📱 Showing main app, hiding login screen');
  
  // Hide login, show home
  const loginScreen = document.getElementById('loginScreen');
  const homeScreen = document.getElementById('homeScreen');
  
  if (loginScreen) {
    loginScreen.classList.remove('active');
    loginScreen.style.display = 'none'; // Force hide
  }
  
  if (homeScreen) {
    homeScreen.classList.add('active');
    homeScreen.style.display = 'block'; // Force show
  }
  
  // Add user profile indicator to home screen
  addUserProfile();
}

// Add user profile display
function addUserProfile() {
  if (!currentUser) return;
  
  const homeScreen = document.getElementById('homeScreen');
  if (!homeScreen) return;
  
  // Check if profile already exists
  let profileEl = document.getElementById('userProfile');
  if (!profileEl) {
    profileEl = document.createElement('div');
    profileEl.id = 'userProfile';
    profileEl.className = 'user-profile';
    homeScreen.insertBefore(profileEl, homeScreen.firstChild);
  }
  
  profileEl.innerHTML = `
    <div class="user-info">
      ${currentUser.photoURL ? `<img src="${currentUser.photoURL}" class="user-avatar" />` : `<div class="user-avatar-placeholder">${currentUser.displayName[0]}</div>`}
      <span class="user-name">${currentUser.displayName}</span>
    </div>
    <button class="btn-text btn-signout" onclick="signOut()">Sign Out</button>
  `;
}

// Handle email sign-in form
function handleEmailSignIn() {
  const email = document.getElementById('emailInput').value;
  const password = document.getElementById('passwordInput').value;
  
  if (!email || !password) {
    showToast('Please enter email and password', true);
    return;
  }
  
  signInWithEmail(email, password);
}

// Show sign-up form
function showSignUp() {
  const container = document.getElementById('emailSignIn');
  container.innerHTML = `
    <input type="text" id="displayNameInput" placeholder="Display Name" />
    <input type="email" id="emailInput" placeholder="Email" />
    <input type="password" id="passwordInput" placeholder="Password (min 6 characters)" />
    <button class="btn-primary" onclick="handleEmailSignUp()">Create Account</button>
    <button class="btn-text" onclick="showSignIn()">Back to Sign In</button>
  `;
}

// Show sign-in form
function showSignIn() {
  const container = document.getElementById('emailSignIn');
  container.innerHTML = `
    <input type="email" id="emailInput" placeholder="Email" />
    <input type="password" id="passwordInput" placeholder="Password" />
    <button class="btn-primary" onclick="handleEmailSignIn()">Sign In</button>
    <button class="btn-text" onclick="showSignUp()">Create Account</button>
  `;
}

// Handle email sign-up form
function handleEmailSignUp() {
  const displayName = document.getElementById('displayNameInput').value;
  const email = document.getElementById('emailInput').value;
  const password = document.getElementById('passwordInput').value;
  
  if (!displayName) {
    showToast('Please enter a display name', true);
    return;
  }
  
  if (!email || !password) {
    showToast('Please enter email and password', true);
    return;
  }
  
  if (password.length < 6) {
    showToast('Password must be at least 6 characters', true);
    return;
  }
  
  signUpWithEmail(email, password, displayName);
}
