// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getFirestore } from 'firebase/firestore'
import { getAuth } from 'firebase/auth'
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAPQhA1jcX5Wa-RaUuleVOeLX1_fjwGo0c",
  authDomain: "fintech-e3f78.firebaseapp.com",
  projectId: "fintech-e3f78",
  storageBucket: "fintech-e3f78.firebasestorage.app",
  messagingSenderId: "717586112372",
  appId: "1:717586112372:web:7c1766ecbc2e5d1e685621",
  measurementId: "G-Q1GVTXYZPN"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getFirestore(app);
const auth = getAuth(app);

export { app, analytics, db, auth };
