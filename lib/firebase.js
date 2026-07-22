// lib/firebase.js
// File BARU untuk revisi stok QRIS.
//
// Tujuan: menghubungkan backend (Railway) ke Firebase project yang SAMA
// dengan yang dipakai Store & Dashboard Admin (project: aliftzy-store),
// supaya backend bisa membaca koleksi "stock" dan menulis koleksi "orders".
//
// PENTING - FAIL SAFE:
// Modul ini SENGAJA tidak melempar error (throw) kalau env var FIREBASE_KEY
// belum diset. Kalau FIREBASE_KEY kosong/tidak valid, `db` akan bernilai
// `null` dan seluruh fitur cek-stok di server.js otomatis dilewati
// (fallback ke behavior lama: tanpa cek stok). Ini untuk memastikan
// endpoint lama (/create-payment, /webhook) TIDAK PERNAH crash hanya
// karena konfigurasi Firebase belum lengkap di Railway.
//
// Cara isi FIREBASE_KEY di Railway:
// - Sama seperti FIREBASE_KEY yang sudah dipakai di Vercel untuk Store
//   (Project Settings > Environment Variables > FIREBASE_KEY di Vercel).
// - Isinya adalah JSON service account Firebase (di-stringify jadi satu baris).

import admin from "firebase-admin";

let db = null;

try {
  const key = process.env.FIREBASE_KEY;

  if (key) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(key))
      });
    }
    db = admin.firestore();
    console.log("[firebase] Firestore terhubung. Fitur cek stok aktif.");
  } else {
    console.warn(
      "[firebase] FIREBASE_KEY belum diset di environment Railway. " +
      "Fitur cek stok otomatis DINONAKTIFKAN sementara — semua endpoint lama " +
      "tetap berjalan seperti sebelum revisi (tanpa validasi stok)."
    );
  }
} catch (err) {
  console.error(
    "[firebase] Gagal inisialisasi Firebase Admin (cek format FIREBASE_KEY):",
    err.message
  );
  db = null;
}

export { db };
