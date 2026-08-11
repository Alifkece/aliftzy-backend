// api/stock-availability.js
//
// FITUR BARU (audit stok): endpoint publik yang HANYA mengembalikan jumlah
// stok tersedia/total per productId+packageName - TIDAK PERNAH mengembalikan
// field dokumen stock asli (email, password, note, dsb).
//
// Kenapa endpoint ini perlu ada:
// Firestore Rules production membatasi collection "stock" hanya bisa dibaca
// oleh Admin (match /stock/{docId} { allow read: if isAdmin(); }) karena
// dokumennya berisi kredensial akun. Sebelumnya Frontend Store membaca
// collection "stock" langsung dari browser (onSnapshot) - untuk user biasa
// ini SELALU gagal (permission-denied) karena rules memang menutupnya,
// sehingga badge stok/guard "stok habis" di Store tidak pernah dapat data.
// Endpoint ini menggantikan pembacaan langsung tsb: dipanggil dari server
// pakai Admin SDK (lib/firebase.js, tidak tunduk pada Firestore Rules
// client) lalu HANYA mengirim balik angka agregat yang aman.
//
// Dipanggil oleh Store (js/app.js loadStockPublic()) via GET, di-poll
// berkala supaya badge/guard stok tetap mengikuti perubahan terbaru selagi
// halaman terbuka.
//
// TIDAK menyentuh logic create-payment / webhook / klaim stok sama sekali.

import { applyCors } from "../lib/http.js";
import { getStockAvailability } from "../lib/orders.js";

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(404).end();
  }

  try {
    const data = await getStockAvailability();
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("STOCK AVAILABILITY ERROR:", err.message);
    // Fail-closed pada data, bukan pada request: kembalikan array kosong
    // supaya Store menganggap "tidak ada info stok" (hasStockData=false)
    // alih-alih mematahkan halaman produk.
    return res.status(200).json({ success: true, data: [] });
  }
}
