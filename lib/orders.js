// lib/orders.js
//
// Semua logic yang berkaitan dengan pengecekan stok, pembuatan order,
// dan klaim stok atomik (webhook) dikumpulkan di sini supaya endpoint
// tidak perlu dirombak besar-besaran.
//
// Koleksi Firestore yang dipakai (mengikuti struktur yang SUDAH ADA
// di Store, lihat README Store bagian "Database"):
//   - stock   : { productId, packageName, sold, ...data pengiriman akun }
//   - orders  : dokumen dibuat oleh backend ini, id = transactionId
//
// Koleksi tambahan:
//   - admin_alerts : notifikasi ke admin saat stok habis pas webhook diproses
//
// ==== PERUBAHAN UNTUK MIGRASI CASAKU ====
// claimStockForOrder() sekarang menolak memproses ulang order yang
// statusnya SUDAH final (PAID / FAILED_STOCK_EMPTY) SEBELUM masuk ke
// Firestore Transaction. Sebelumnya, webhook duplicate/retry pada order
// yang stoknya SUDAH diklaim (sold: true) akan salah dibaca sebagai "stok
// habis" oleh isStockAvailable() dan order yang sudah PAID bisa
// ditimpa/ditandai FAILED_STOCK_EMPTY secara keliru. Casaku melakukan
// retry webhook otomatis hingga 3x bila server tidak merespons 2xx dalam
// 10 detik, jadi pengaman ini WAJIB ada supaya "1 order = 1 fulfillment"
// tetap terjaga walau webhook yang sama datang berkali-kali.

import { db } from "./firebase.js";

const STOCK_COLLECTION = "stock";
const ORDERS_COLLECTION = "orders";
const ADMIN_ALERTS_COLLECTION = "admin_alerts";

// Status order yang dianggap FINAL — webhook duplicate untuk transactionId
// dengan status ini harus di-skip tanpa menyentuh stok/Firestore lagi.
const FINAL_ORDER_STATUSES = ["PAID", "FAILED_STOCK_EMPTY"];

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
 * Cek cepat (non-transaksi) apakah suatu produk (opsional: + paket
 * tertentu) masih punya stok. Dipanggil SEBELUM generate QRIS.
 */
async function hasAvailableStock(productId, packageName) {
  if (!db || !productId) return true; // fail-open: lihat catatan di lib/firebase.js

  let query = db.collection(STOCK_COLLECTION).where("productId", "==", productId);
  if (packageName) {
    query = query.where("packageName", "==", packageName);
  }

  const snap = await query.get();

  return snap.docs.some((doc) => isStockAvailable(doc.data()));
}

/**
 * Simpan order PENDING setelah QRIS berhasil dibuat, supaya webhook
 * nanti tahu produk (+ paket) mana yang harus diklaim stoknya untuk
 * transactionId tersebut. Dipanggil SETELAH Casaku sukses generate QRIS.
 *
 * Kegagalan fungsi ini TIDAK BOLEH menggagalkan response ke buyer -
 * dipanggil dengan try/catch di api/create-payment.js.
 */
async function createPendingOrder({ transactionId, productId, packageName, username, amount, expiredAt }) {
  if (!db || !productId || !transactionId) return;

  await db
    .collection(ORDERS_COLLECTION)
    .doc(String(transactionId))
    .set(
      {
        transactionId: String(transactionId),
        productId,
        packageName: packageName || null,
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
 * Jika order untuk transactionId ini tidak ditemukan, fungsi ini tidak
 * melakukan apa-apa.
 *
 * IDEMPOTENCY: jika order SUDAH berstatus final (PAID / FAILED_STOCK_EMPTY),
 * fungsi ini langsung return tanpa menjalankan Firestore Transaction lagi -
 * mencegah webhook duplicate/retry Casaku menimpa status order yang sudah
 * final atau salah menandai stok "habis" padahal sebenarnya sudah terklaim
 * sebelumnya.
 */
async function claimStockForOrder(transactionId, paymentType) {
  if (!db || !transactionId) return { handled: false };

  const orderRef = db.collection(ORDERS_COLLECTION).doc(String(transactionId));
  const orderSnap = await orderRef.get();

  if (!orderSnap.exists) {
    // Order tidak dibuat oleh backend ini. Jangan sentuh apapun.
    return { handled: false };
  }

  const order = orderSnap.data();

  // ==== GUARD IDEMPOTENCY (baru) ====
  if (FINAL_ORDER_STATUSES.includes(order.status)) {
    return { handled: true, stockClaimed: order.status === "PAID", alreadyProcessed: true };
  }

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
    // Baca ulang order DI DALAM transaction supaya aman dari race condition
    // kalau dua webhook untuk transactionId yang sama diproses hampir
    // bersamaan (bukan hanya berurutan seperti guard di atas).
    const freshOrderSnap = await t.get(orderRef);
    const freshOrder = freshOrderSnap.data();

    if (FINAL_ORDER_STATUSES.includes(freshOrder.status)) {
      stockClaimed = freshOrder.status === "PAID";
      return;
    }

    let stockQuery = db
      .collection(STOCK_COLLECTION)
      .where("productId", "==", order.productId);

    if (order.packageName) {
      stockQuery = stockQuery.where("packageName", "==", order.packageName);
    }

    const stockSnap = await t.get(stockQuery);
    const availableDoc = stockSnap.docs.find((doc) => isStockAvailable(doc.data()));

    if (!availableDoc) {
      // ==== STOK HABIS SAAT WEBHOOK DIPROSES ====
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
        packageName: order.packageName || null,
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
