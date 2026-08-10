// api/webhook.js
//
// MIGRASI: webhook sekarang dikirim oleh Casaku, bukan SiTransfer lagi.
// WAJIB verifikasi signature (HMAC-SHA256 atas RAW body + header
// X-Casaku-Signature) SEBELUM memproses apa pun — lihat
// lib/casaku.js#verifyWebhookSignature. Request dengan signature tidak
// valid ditolak dengan HTTP 401 dan TIDAK PERNAH menyentuh Firestore.
//
// bodyParser Vercel DIMATIKAN (lihat `config` di bawah) khusus untuk file
// ini, supaya kita bisa membaca RAW body mentah — signature Casaku
// dihitung dari raw body SEBELUM di-parse; hasil JSON.parse ulang tidak
// dijamin menghasilkan urutan key yang identik dengan body asli, sehingga
// signature tidak akan pernah cocok kalau kita memakai body yang sudah
// di-parse ulang.
//
// Logika klaim stok (claimStockForOrder) TIDAK DIUBAH selain menambahkan
// pengaman idempotency di lib/orders.js — lihat catatan di file itu.
//
// PENTING: path webhook TETAP /webhook (rewrite di vercel.json tidak
// diubah) — hanya URL INI yang perlu didaftarkan ulang di dashboard
// Casaku (bukan URL Frontend Store/Admin yang berubah).

import { claimStockForOrder } from "../lib/orders.js";
import { applyCors } from "../lib/http.js";
import { verifyWebhookSignature } from "../lib/casaku.js";

export const config = {
  api: {
    bodyParser: false
  }
};

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(404).end();
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error("WEBHOOK: gagal membaca raw body:", err.message);
    return res.status(400).json({ error: "Gagal membaca body" });
  }

  const signature = req.headers["x-casaku-signature"];
  const isValidSignature = verifyWebhookSignature(rawBody, signature);

  if (!isValidSignature) {
    console.error("WEBHOOK: signature TIDAK VALID — request ditolak.");
    return res.status(401).json({ error: "Invalid signature" });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    return res.status(400).json({ error: "Body bukan JSON valid" });
  }

  console.log("WEBHOOK CASAKU MASUK:", body);

  // ==== REVISI STOK QRIS (logic tidak diubah dari sebelumnya, hanya
  // sumber data status/transactionId yang sekarang mengikuti struktur
  // payload Casaku: { transactionId, amount, packageName, status, paidAt })
  try {
    const isSuccess = String(body?.status || "").toLowerCase() === "paid";

    if (isSuccess) {
      const trx = body?.transactionId;
      const paymentType = "casaku";

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
    // Jangan sampai error di logic stok membuat webhook gagal merespons —
    // Casaku akan retry sampai 3x kalau responsnya bukan 2xx.
    console.error("WEBHOOK STOCK CLAIM ERROR:", webhookErr.message);
  }

  return res.status(200).json({
    status: "ok"
  });
}
