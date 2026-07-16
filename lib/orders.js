// lib/orders.js
// File BARU untuk revisi stok QRIS.
//
// Semua logic yang berkaitan dengan pengecekan stok, pembuatan order,
// dan klaim stok atomik (webhook) dikumpulkan di sini supaya server.js
// tidak perlu dirombak besar-besaran.
//
// Koleksi Firestore yang dipakai (mengikuti struktur yang SUDAH ADA
// di Store, lihat README Store bagian "Database"):
//   - stock   : { productId, sold, ...data pengiriman akun }
//   - orders  : dokumen baru dibuat oleh backend ini, id = transaction_id
//
// Koleksi BARU yang ditambahkan (murni tambahan, tidak mengganggu apapun):
//   - admin_alerts : notifikasi ke admin saat stok habis pas webhook diproses

import { db } from "./firebase.js";

const STOCK_COLLECTION = "stock";
const ORDERS_COLLECTION = "orders";
const ADMIN_ALERTS_COLLECTION = "admin_alerts";

/**
 * Cocok/tidaknya sebuah dokumen stock dianggap "tersedia".
 * Meniru persis logic yang sudah dipakai di Store (js/app.js):
 *   const availableCount = pStock.filter(s => !s.sold).length;
 * Artinya field `sold` yang kosong/undefined dianggap TERSEDIA juga,
 * bukan hanya yang eksplisit `sold === false`.
 */
function isStockAvailable(stockData) {
  return !stockData?.sold;
}

/**
 * Best-effort mapping field pengiriman akun dari dokumen stock ke
 * field yang SUDAH dipakai Store untuk menampilkan hasil delivery
 * di halaman "My Orders" (o.deliveredEmail, o.deliveredPassword,
 * o.deliveredLoginUrl, o.deliveredNote - lihat js/app.js renderMyOrders).
 *
 * Karena skema pasti dokumen stock diatur oleh Dashboard Admin (repo
 * terpisah, tidak diupload), mapping ini mencoba beberapa nama field
 * yang umum dipakai. Kalau skema asli berbeda, cukup sesuaikan mapping
 * di bawah ini saja - tidak ada bagian lain yang perlu diubah.
 */
function mapStockToDelivery(stockData = {}) {
  return {
    deliveredEmail:
      stockData.deliveredEmail ?? stockData.email ?? stockData.username ?? null,
    deliveredPassword:
      stockData.deliveredPassword ?? stockData.password ?? null,
    deliveredLoginUrl:
      stockData.deliveredLoginUrl ??
      stockData.loginUrl ??
      stockData.login_url ??
      stockData.url ??
      null,
    deliveredNote:
      stockData.deliveredNote ?? stockData.note ?? stockData.notes ?? null
  };
}

/**
 * Cek cepat (non-transaksi) apakah suatu produk masih punya stok.
 * Dipakai SEBELUM generate QRIS. Ini bukan penjamin 100% anti race
 * condition (itu tugas claimStockForOrder di webhook) - ini hanya
 * "penjaga pintu depan" supaya QRIS tidak dibuat kalau stok SUDAH
 * pasti kosong.
 */
async function hasAvailableStock(productId) {
  if (!db || !productId) return true; // fail-open: lihat catatan di lib/firebase.js

  const snap = await db
    .collection(STOCK_COLLECTION)
    .where("productId", "==", productId)
    .get();

  return snap.docs.some((doc) => isStockAvailable(doc.data()));
}

/**
 * Simpan order PENDING setelah QRIS berhasil dibuat, supaya webhook
 * nanti tahu produk mana yang harus diklaim stoknya untuk transaction_id
 * tersebut. Dipanggil SETELAH SiTransfer sukses generate QRIS.
 *
 * Kegagalan fungsi ini TIDAK BOLEH menggagalkan response ke buyer -
 * dipanggil dengan try/catch di server.js.
 */
async function createPendingOrder({ transactionId, productId, username, amount, expiredAt }) {
  if (!db || !productId || !transactionId) return;

  await db
    .collection(ORDERS_COLLECTION)
    .doc(String(transactionId))
    .set(
      {
        transactionId: String(transactionId),
        productId,
        username: username || null,
        amount: Number(amount) || 0,
        status: "PENDING_PAYMENT",
        createdAt: new Date(),
        expiredAt: expiredAt || null
      },
      { merge: true }
    );
}

/**
 * Dipanggil dari /webhook saat pembayaran SUKSES.
 * Melakukan klaim stok secara ATOMIK menggunakan Firestore Transaction,
 * supaya kalau ada 2 buyer membayar bersamaan untuk stok tersisa 1,
 * hanya SATU yang berhasil mendapat stok.
 *
 * Jika order untuk transaction_id ini tidak ditemukan (mis. dibuat
 * sebelum revisi ini berjalan, atau productId tidak dikirim), fungsi
 * ini tidak melakukan apa-apa - biarkan flow lama (hanya log) berjalan.
 */
async function claimStockForOrder(transactionId, paymentType) {
  if (!db || !transactionId) return { handled: false };

  const orderRef = db.collection(ORDERS_COLLECTION).doc(String(transactionId));
  const orderSnap = await orderRef.get();

  if (!orderSnap.exists) {
    // Order tidak dibuat oleh backend ini (mis. transaksi lama / productId
    // tidak dikirim saat create-payment). Jangan sentuh apapun.
    return { handled: false };
  }

  const order = orderSnap.data();

  if (!order.productId) {
    // Order ada tapi tanpa productId -> tidak ada stok yang perlu diklaim.
    // Tetap tandai PAID supaya status order benar, tapi tanpa proses stok.
    await orderRef.set(
      { status: "PAID", payment: paymentType || "unknown", paidAt: new Date() },
      { merge: true }
    );
    return { handled: true, stockClaimed: false };
  }

  let stockClaimed = false;

  await db.runTransaction(async (t) => {
    const stockQuery = db
      .collection(STOCK_COLLECTION)
      .where("productId", "==", order.productId);

    const stockSnap = await t.get(stockQuery);
    const availableDoc = stockSnap.docs.find((doc) => isStockAvailable(doc.data()));

    if (!availableDoc) {
      // ==== STOK HABIS SAAT WEBHOOK DIPROSES ====
      // Jangan kirim produk, jangan tandai sukses.
      t.set(
        orderRef,
        {
          status: "FAILED_STOCK_EMPTY",
          payment: paymentType || "unknown",
          paidAt: new Date(),
          failReason: "Stok habis saat webhook diproses (sudah terjual ke buyer lain)"
        },
        { merge: true }
      );

      const alertRef = db.collection(ADMIN_ALERTS_COLLECTION).doc();
      t.set(alertRef, {
        type: "STOCK_EMPTY_AFTER_PAYMENT",
        transactionId: String(transactionId),
        productId: order.productId,
        username: order.username || null,
        amount: order.amount || null,
        createdAt: new Date()
      });

      stockClaimed = false;
      return;
    }

    // ==== KLAIM STOK ATOMIK ====
    const delivery = mapStockToDelivery(availableDoc.data());

    t.update(availableDoc.ref, {
      sold: true,
      soldAt: new Date(),
      soldTo: order.username || null,
      orderId: String(transactionId)
    });

    t.set(
      orderRef,
      {
        status: "PAID",
        payment: paymentType || "unknown",
        paidAt: new Date(),
        ...delivery
      },
      { merge: true }
    );

    stockClaimed = true;
  });

  return { handled: true, stockClaimed };
}

export { hasAvailableStock, createPendingOrder, claimStockForOrder };
