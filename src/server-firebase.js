// server-firebase.js - Firebase Admin SDK setup for server
const admin = require('firebase-admin');

// Initialize Firebase Admin
// Service account will be loaded from environment variable in Railway
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./firebase-service-account.json'); // Fallback for local dev

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'draft-royale'
});

const db = admin.firestore();
const auth = admin.auth();

console.log('🔥 Firebase Admin initialized');

module.exports = { admin, db, auth };
