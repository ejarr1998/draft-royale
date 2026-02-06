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
    
    // Ensure user document exists
    await ensureUserDocument(user);
    
    // Authenticate with Socket.IO server
    socket.emit('authenticate', { 
      uid: user.uid,
      displayName: currentUser.displayName,
      photoURL: currentUser.photoURL
    });
    
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
    const activeGameIds = userDoc.data()?.activeGames || [];
    
    console.log(`📂 Loading ${activeGameIds.length} active games from Firestore`);
    
    // Convert to old format for compatibility
    const games = {};
    for (const lobbyId of activeGameIds) {
      const lobbyDoc = await db.collection('lobbies').doc(lobbyId).get();
      if (lobbyDoc.exists) {
        const lobby = lobbyDoc.data();
        const player = lobby.players?.find(p => p.uid === currentUser.uid);
        if (player) {
          games[lobbyId] = {
            lobbyId,
            phase: lobby.state,
            playerName: player.name,
            sessionId: currentUser.uid, // Use uid as sessionId
            savedAt: lobby.updatedAt?.toMillis() || Date.now()
          };
        }
      }
    }
    
    // Save to localStorage for backwards compatibility
    localStorage.setItem('dr_activeGames', JSON.stringify(games));
    
    // Render banner
    renderActiveGameBanner();
    
  } catch (err) {
    console.error('Error loading active games:', err);
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
  document.getElementById('loginScreen')?.classList.remove('active');
  document.getElementById('homeScreen')?.classList.add('active');
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
