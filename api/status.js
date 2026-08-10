// api/status.js
//
// MIGRASI: cek status sekarang ke Casaku (POST /api/generate/check-status),
// bukan lagi SiTransfer. Dipanggil oleh Frontend Store
// (js/app.js -> checkPaymentStatus()) setiap 4 detik selama modal QRIS
// terbuka.
//
// Response ke Frontend Store DIPERTAHANKAN PERSIS SAMA seperti sebelumnya
// — { data: { status, transaction_id } } — supaya checkPaymentStatus() di
// js/app.js TIDAK PERLU direvisi.
//
// Normalisasi status: Casaku mengirim status resmi "pending" | "paid" |
// "cancel" | "expired". js/app.js (era SiTransfer) mengenali
// "success"/"paid"/"completed" sebagai sukses, dan "expired"/"failed"
// sebagai gagal — "paid" & "expired" Casaku sudah cocok apa adanya, hanya
// "cancel" yang dipetakan ke "expired" (satu-satunya kosakata gagal yang
// dikenali frontend) supaya UI tidak macet di status "pending" saat
// transaksi sebenarnya sudah dibatalkan.
//
// TIDAK menyentuh Firestore / logika klaim stok sama sekali — itu murni
// tanggung jawab /webhook.

import { applyCors, getJsonBody } from "../lib/http.js";
import { checkStatus } from "../lib/casaku.js";

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

    const casakuStatus = await checkStatus(transactionId);
    const normalizedStatus =
      casakuStatus.status === "cancel" ? "expired" : casakuStatus.status;

    return res.status(200).json({
      data: {
        transaction_id: casakuStatus.transactionId,
        status: normalizedStatus
      }
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
}
