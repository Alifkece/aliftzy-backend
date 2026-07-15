import admin from "firebase-admin";

// Sama seperti lib/firebase.js di project frontend (Aliftzy-store):
// service account JSON disimpan di environment variable FIREBASE_KEY.
// Backend Railway butuh akses Firestore yang sama supaya validasi stok,
// order, dan auto delivery konsisten dengan data yang dipakai frontend.
if (!admin.apps.length) {
  const key = process.env.FIREBASE_KEY;

  if (!key) {
    throw new Error("FIREBASE_KEY belum di-set di environment Railway");
  }

  let credentials;
  try {
    credentials = JSON.parse(key);
  } catch (err) {
    throw new Error("FIREBASE_KEY bukan JSON yang valid: " + err.message);
  }

  admin.initializeApp({
    credential: admin.credential.cert(credentials)
  });
}

export const db = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;
