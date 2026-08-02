// api/create-payment.js
//
// Migrasi dari route Express `app.post("/create-payment", ...)` di server.js
// lama ke Vercel Serverless Function. LOGIKA BISNIS TIDAK DIUBAH SAMA SEKALI
// — hanya dibungkus ulang jadi handler (req, res) tunggal karena Vercel tidak
// memakai app.listen()/Express router.
//
// Endpoint tetap dapat diakses di path yang SAMA PERSIS (/create-payment)
// berkat rewrite di vercel.json.

import { hasAvailableStock, createPendingOrder } from "../lib/orders.js";
import { applyCors, getJsonBody } from "../lib/http.js";

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
    const { amount, username, productId, packageName } = body;

    if (!amount || !username) {
      return res.status(400).json({
        error: "amount dan username wajib diisi"
      });
    }

    // ==== REVISI STOK QRIS ====
    // productId bersifat OPSIONAL (field baru, tidak menggantikan field lama)
    // supaya tetap kompatibel dengan client lama yang belum mengirimnya.
    // packageName JUGA opsional dengan alasan yang sama (fail-open untuk
    // client lama), tapi kalau dikirim (client Store yang sudah direvisi
    // SELALU mengirimnya), stok divalidasi per PAKET - bukan cuma per
    // productId - supaya paket yang stoknya kosong (mis. "1 Bulan") tidak
    // dianggap tersedia hanya karena paket lain dari produk yang sama
    // (mis. "1 Tahun") masih ada stok.
    // Kalau productId dikirim dan stok (paket ini, atau produk ini kalau
    // packageName tidak dikirim) sudah pasti habis, JANGAN generate
    // QRIS / invoice / transaksi sama sekali.
    if (productId) {
      try {
        const available = await hasAvailableStock(productId, packageName);
        if (!available) {
          return res.status(400).json({
            success: false,
            outOfStock: true,
            error: packageName
              ? "Stock paket ini sedang habis."
              : "Stok produk ini sedang habis. Silakan pilih produk lain atau coba lagi nanti."
          });
        }
      } catch (stockErr) {
        // Kalau pengecekan stok gagal (mis. Firestore bermasalah), jangan
        // sampai buyer lama yang tidak pakai fitur ini ikut terdampak.
        console.error("STOCK CHECK ERROR:", stockErr.message);
      }
    }

    const response = await fetch(
      "https://rest.sitranfer.com/payment/api/generate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          key: process.env.SITRANSFER_KEY,
          channel: "QRIS",
          amount: Number(amount),
          player_username: username
        })
      }
    );

    const result = await response.json();

    // ==== REVISI STOK QRIS ====
    // Catat order PENDING (hanya jika productId dikirim) supaya /webhook
    // nanti tahu stok mana yang harus diklaim untuk transaction_id ini.
    // Ini tidak mengubah response yang dikirim ke frontend sama sekali.
    if (productId && result && result.success !== false && result?.data?.transaction_id) {
      try {
        await createPendingOrder({
          transactionId: result.data.transaction_id,
          productId,
          packageName,
          username,
          amount,
          expiredAt: result.data.expired_at
        });
      } catch (orderErr) {
        console.error("ORDER CREATE ERROR:", orderErr.message);
      }
    }

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
}
