import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { hasAvailableStock, createPendingOrder, claimStockForOrder } from "./lib/orders.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());


app.post("/create-payment", async (req, res) => {

  try {

    const { amount, username, productId, packageName } = req.body;


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


    return res.json(result);


  } catch (err) {


    return res.status(500).json({
      error: err.message
    });


  }

});



app.post("/webhook", async (req, res) => {


  console.log("WEBHOOK MASUK:");
  console.log(req.body);


  // ==== REVISI STOK QRIS ====
  // Setelah pembayaran sukses: cek ulang & klaim stok secara atomik supaya
  // tidak ada 2 buyer yang mendapat stok yang sama (race condition).
  // Kalau order untuk transaction_id ini tidak ditemukan (mis. dibuat
  // sebelum revisi ini, atau productId tidak dikirim saat create-payment),
  // fungsi ini tidak melakukan apa-apa - flow lama (hanya log) tetap berjalan
  // persis seperti sebelumnya.
  try {
    const body = req.body || {};

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


  res.json({
    status:"ok"
  });


});



app.get("/", (req,res)=>{

  res.send("Aliftzy Backend Aktif");

});



app.listen(3000, ()=>{

  console.log("Backend jalan di port 3000");

});
