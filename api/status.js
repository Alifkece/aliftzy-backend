// api/status.js
//
// FILE BARU. Endpoint ini dipanggil oleh Frontend Store (js/app.js ->
// checkPaymentStatus()) setiap 4 detik selama modal QRIS terbuka, untuk
// menampilkan status pembayaran secara real-time. Endpoint ini SEBELUMNYA
// tidak ada di server.js yang diupload, meskipun sudah dipanggil aktif oleh
// Store dan disebut di README lama.
//
// Diimplementasikan mengikuti dokumentasi resmi SiTransfer (base URL
// https://rest.sitranfer.com/payment/api, route POST /status) yang
// dikonfirmasi oleh pemilik project - BUKAN hasil tebakan.
//
// Pola autentikasi & request PERSIS mengikuti /create-payment: otentikasi
// lewat field `key` di dalam body JSON (SITRANSFER_KEY), tanpa header
// khusus, ke host yang sama (rest.sitranfer.com/payment/api). Response dari
// SiTransfer di-passthrough apa adanya ke Frontend Store (sama seperti pola
// /create-payment yang juga meneruskan `result` SiTransfer tanpa
// dimodifikasi), supaya format `{ success, data: { transaction_id, status,
// ... } }` yang sudah dibaca oleh checkPaymentStatus() di Store tetap sama
// persis.
//
// TIDAK menyentuh Firestore / logika klaim stok sama sekali - itu murni
// tanggung jawab /webhook, tidak diduplikasi di sini.

import { applyCors, getJsonBody } from "../lib/http.js";

const SITRANSFER_STATUS_URL = "https://rest.sitranfer.com/payment/api/status";

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(404).end();
  }

  try {
    const body = await getJsonBody(req);
    const transactionId = body.transaction_id;

    if (!transactionId) {
      return res.status(400).json({
        error: "transaction_id wajib diisi"
      });
    }

    const response = await fetch(SITRANSFER_STATUS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key: process.env.SITRANSFER_KEY,
        transaction_id: transactionId
      })
    });

    const result = await response.json();

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
}
