import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import {
  getAvailableStockCount,
  createPendingOrder,
  getOrder,
  validateStockAndDeliver,
  markOrderTerminalStatus
} from "./lib/orders.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const SITRANSFER_GENERATE_URL = "https://rest.sitranfer.com/payment/api/generate";

app.post("/create-payment", async (req, res) => {
  try {
    const {
      amount,
      username,
      productId,
      productName,
      packageName,
      userId
    } = req.body || {};

    if (!amount || !username) {
      return res.status(400).json({
        error: "amount dan username wajib diisi"
      });
    }

    // productId wajib supaya stok bisa divalidasi sebelum QRIS dibuat.
    // Tanpa ini kita tidak tahu produk mana yang mau dicek stoknya, jadi
    // request ditolak lebih awal daripada diam-diam melewati validasi stok.
    if (!productId) {
      return res.status(400).json({
        error: "productId wajib diisi untuk validasi stok"
      });
    }

    const cleanAmount = Number(amount);
    if (!cleanAmount || isNaN(cleanAmount) || cleanAmount <= 0) {
      return res.status(400).json({
        error: "amount tidak valid"
      });
    }

    // ===== 1) CEK STOK SEBELUM GENERATE QRIS =====
    let availableStock;
    try {
      availableStock = await getAvailableStockCount(productId);
    } catch (err) {
      console.error("GAGAL CEK STOK:", err);
      return res.status(500).json({
        error: "Gagal memeriksa stok, coba lagi"
      });
    }

    if (availableStock <= 0) {
      // Stok kosong: JANGAN generate QRIS, JANGAN buat invoice/order,
      // JANGAN panggil payment gateway sama sekali.
      return res.status(409).json({
        success: false,
        outOfStock: true,
        error: "Stok habis"
      });
    }

    // ===== 2) BARU generate QRIS via payment gateway =====
    const key = process.env.SITRANSFER_KEY;
    if (!key) {
      return res.status(500).json({
        error: "SITRANSFER_KEY tidak terbaca di environment"
      });
    }

    const response = await fetch(SITRANSFER_GENERATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key,
        channel: "QRIS",
        amount: cleanAmount,
        player_username: username
      })
    });

    const result = await response.json();

    if (!response.ok || result?.success === false || result?.error) {
      return res.status(response.ok ? 400 : response.status).json(result);
    }

    const data = result.data || result;
    const transactionId = data.transaction_id;

    // ===== 3) Simpan order PENDING (baru dibuat setelah QRIS berhasil) =====
    if (transactionId) {
      try {
        await createPendingOrder({
          transactionId,
          userId,
          username,
          productId,
          productName,
          price: cleanAmount,
          packageName,
          expiredAt: data.expired_at || null
        });
      } catch (err) {
        // QRIS sudah terlanjur dibuat di sisi gateway. Order tetap dicatat
        // gagal disimpan di log supaya kelihatan di monitoring Railway,
        // tapi tetap kembalikan QRIS ke user (uang belum dibayar, tidak
        // fatal) — webhook nanti akan gagal cocok kalau order benar-benar
        // tidak pernah tersimpan, dan itu ter-log jelas di /webhook.
        console.error("GAGAL SIMPAN ORDER PENDING:", transactionId, err);
      }
    } else {
      console.error("RESPON SITRANSFER TIDAK ADA transaction_id:", result);
    }

    return res.json(result);
  } catch (err) {
    console.error("ERROR /create-payment:", err);
    return res.status(500).json({
      error: err.message
    });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body || {};

    console.log("WEBHOOK MASUK:", body);

    const trx = body?.data?.transaction_id;
    if (!trx) {
      return res.status(400).json({
        error: "transaction_id tidak ditemukan"
      });
    }

    const status = String(body?.data?.status || "").toLowerCase();
    const isSuccess = body?.success === true && status === "success";

    if (isSuccess) {
      // ===== VALIDASI ULANG STOK + AUTO DELIVERY (race-condition safe) =====
      const paymentType = body?.data?.type || "unknown";

      try {
        const result = await validateStockAndDeliver(trx, paymentType);

        if (!result.ok && result.reason === "ORDER_NOT_FOUND") {
          console.error(
            "WEBHOOK: order tidak ditemukan untuk transaction_id",
            trx
          );
          // Tetap balas 200 supaya payment gateway tidak retry terus-menerus
          // untuk order yang memang tidak pernah tercatat di sisi kita.
          return res.status(200).json({
            status: "ok",
            message: "order not found, ignored"
          });
        }

        if (result.reason === "OUT_OF_STOCK_ON_PAYMENT") {
          console.error(
            "WEBHOOK: pembayaran sukses tapi stok habis saat validasi ulang untuk",
            trx
          );
        }

        return res.status(200).json({
          status: "ok",
          message: "payment processed",
          detail: result.reason
        });
      } catch (err) {
        console.error("WEBHOOK: gagal proses stok/delivery:", trx, err);
        return res.status(500).json({
          error: err.message
        });
      }
    }

    // Status selain success (failed/expired/dll) — sinkronkan status order
    // supaya /status dan halaman "Pesanan Saya" tidak stuck di PENDING.
    if (status === "failed" || status === "expired") {
      try {
        await markOrderTerminalStatus(trx, status.toUpperCase());
      } catch (err) {
        console.error("WEBHOOK: gagal update status terminal:", trx, err);
      }
    }

    return res.status(200).json({
      status: "ok",
      message: "Not paid or invalid payload"
    });
  } catch (err) {
    console.error("ERROR /webhook:", err);
    return res.status(500).json({
      error: err.message
    });
  }
});

app.post("/status", async (req, res) => {
  try {
    const { transaction_id } = req.body || {};

    if (!transaction_id) {
      return res.status(400).json({
        error: "transaction_id wajib diisi"
      });
    }

    const order = await getOrder(transaction_id);

    if (!order) {
      return res.status(404).json({
        error: "Transaksi tidak ditemukan"
      });
    }

    let status = order.status || "PENDING";

    // Deteksi expired berdasarkan waktu, konsisten dengan countdown di frontend.
    if (
      status === "PENDING" &&
      order.expiredAt &&
      Date.now() > new Date(order.expiredAt).getTime()
    ) {
      status = "EXPIRED";
      try {
        await markOrderTerminalStatus(transaction_id, "EXPIRED");
      } catch (err) {
        console.error("STATUS: gagal update order jadi EXPIRED:", err);
      }
    }

    // PAID_OUT_OF_STOCK tetap dilaporkan sebagai "paid" ke frontend karena
    // pembayaran memang sukses — kasus stok habis ditangani manual oleh
    // admin (refund/restock), bukan mengubah UI pembeli.
    const normalized =
      status === "PAID" || status === "PAID_OUT_OF_STOCK"
        ? "paid"
        : status.toLowerCase();

    return res.json({
      success: true,
      data: {
        transaction_id,
        status: normalized,
        amount: order.price,
        productId: order.productId,
        deliveryStatus: order.deliveryStatus || null
      }
    });
  } catch (err) {
    console.error("ERROR /status:", err);
    return res.status(500).json({
      error: err.message
    });
  }
});

app.get("/", (req, res) => {
  res.send("Aliftzy Backend Aktif");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend jalan di port ${PORT}`);
});
