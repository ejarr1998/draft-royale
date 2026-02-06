// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyApL5ItMqVQQT9EIGTv_iiJ6oglJwIw2hA",
  authDomain: "draft-royale.firebaseapp.com",
  projectId: "draft-royale",
  storageBucket: "draft-royale.firebasestorage.app",
  messagingSenderId: "978206769715",
  appId: "1:978206769715:web:45bf0093e1d1a07e291946",
  measurementId: "G-29M8HPNLWM"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Initialize services
const auth = firebase.auth();
const db = firebase.firestore();

console.log('🔥 Firebase initialized');
