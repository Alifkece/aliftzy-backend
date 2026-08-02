// api/webhook.js
//
// Migrasi dari route Express `app.post("/webhook", ...)` di server.js lama
// ke Vercel Serverless Function. LOGIKA VALIDASI & KLAIM STOK TIDAK DIUBAH
// SAMA SEKALI — hanya dibungkus ulang jadi handler (req, res) tunggal.
//
// PENTING: webhook ini dipanggil oleh SiTransfer (payment gateway), bukan
// oleh Frontend Store. Path tetap /webhook (sama persis) berkat rewrite di
// vercel.json, supaya konfigurasi callback URL di dashboard SiTransfer TIDAK
// PERLU diubah.

import { claimStockForOrder } from "../lib/orders.js";
import { applyCors, getJsonBody } from "../lib/http.js";

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(404).end();
  }

  const body = await getJsonBody(req);

  console.log("WEBHOOK MASUK:");
  console.log(body);

  // ==== REVISI STOK QRIS ====
  // Setelah pembayaran sukses: cek ulang & klaim stok secara atomik supaya
  // tidak ada 2 buyer yang mendapat stok yang sama (race condition).
  // Kalau order untuk transaction_id ini tidak ditemukan (mis. dibuat
  // sebelum revisi ini, atau productId tidak dikirim saat create-payment),
  // fungsi ini tidak melakukan apa-apa - flow lama (hanya log) tetap berjalan
  // persis seperti sebelumnya.
  try {
    const isSuccess =
      body?.success === true && body?.data?.status === "success";

    if (isSuccess) {
      const trx = body?.data?.transaction_id;
      const paymentType = body?.data?.type || "unknown";

      if (trx) {
        const result = await claimStockForOrder(trx, paymentType);

        if (result.handled) {
          console.log(
            result.stockClaimed
              ? `ORDER ${trx} PAID & stok berhasil diklaim.`
              : `ORDER ${trx} PAID tetapi STOK HABIS - transaksi ditandai gagal, admin sudah dinotifikasi.`
          );
        }
      }
    }
  } catch (webhookErr) {
    // Jangan sampai error di logic stok membuat webhook gagal merespons -
    // gateway pembayaran bisa retry berulang kalau responsnya bukan 200.
    console.error("WEBHOOK STOCK CLAIM ERROR:", webhookErr.message);
  }

  return res.status(200).json({
    status: "ok"
  });
}
