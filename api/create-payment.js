// api/create-payment.js
//
// MIGRASI PAYMENT GATEWAY: SiTransfer -> Casaku (lihat lib/casaku.js).
// Validasi stok, createPendingOrder, dan urutan logic TIDAK diubah dari
// versi sebelumnya — hanya pemanggilan payment gateway yang diganti.
// Format response ke Frontend Store DIPERTAHANKAN PERSIS SAMA
// ({ success, data: { qris_image, transaction_id, amount, expired_at } })
// supaya js/app.js (createOrderQris) TIDAK PERLU direvisi sama sekali.
//
// Endpoint tetap di path yang sama (/create-payment) berkat rewrite di
// vercel.json — tidak berubah.

import { hasAvailableStock, createPendingOrder } from "../lib/orders.js";
import { applyCors, getJsonBody } from "../lib/http.js";
import { generateQris, qrStringToImageDataUrl } from "../lib/casaku.js";

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

    // ==== REVISI STOK QRIS (logic tidak diubah dari sebelumnya) ====
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

    let casakuTrx;
    try {
      casakuTrx = await generateQris(amount);
    } catch (casakuErr) {
      console.error("CASAKU GENERATE ERROR:", casakuErr.message, casakuErr.raw || "");
      return res.status(502).json({
        success: false,
        error: "Gagal membuat transaksi QRIS. Coba lagi sebentar lagi."
      });
    }

    const qrisImageDataUrl = await qrStringToImageDataUrl(casakuTrx.qrString);
    const expiredAt = new Date(
      Date.now() + casakuTrx.expiredInMinutes * 60 * 1000
    ).toISOString();

    // ==== REVISI STOK QRIS (logic tidak diubah dari sebelumnya) ====
    // Catat order PENDING supaya /webhook nanti tahu stok mana yang harus
    // diklaim untuk transactionId Casaku ini.
    if (productId && casakuTrx.transactionId) {
      try {
        await createPendingOrder({
          transactionId: casakuTrx.transactionId,
          productId,
          packageName,
          username,
          amount: casakuTrx.totalAmount,
          expiredAt
        });
      } catch (orderErr) {
        console.error("ORDER CREATE ERROR:", orderErr.message);
      }
    }

    // Adapter: bentuk response PERSIS SAMA seperti waktu masih SiTransfer.
    return res.status(200).json({
      success: true,
      data: {
        transaction_id: casakuTrx.transactionId,
        qris_image: qrisImageDataUrl,
        amount: casakuTrx.totalAmount,
        expired_at: expiredAt
      }
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
}
