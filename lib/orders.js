import { db, FieldValue } from "./firebase.js";

/**
 * Semua logika stok, order, dan auto delivery dipusatkan di sini supaya
 * checkout, payment, webhook, dan orders memakai aturan yang sama persis
 * (tidak ada logika stok yang duplikat/berbeda antar endpoint).
 *
 * Koleksi Firestore yang dipakai (sama seperti yang sudah dipakai frontend):
 * - products: { name, price, packages[], ... }
 * - stock:    { productId, sold: boolean, email?, password?, loginUrl?, note?, orderId?, soldAt? }
 * - orders:   { userId, username, productId, productName, price, packageName,
 *               status, payment, createdAt, paidAt, expiredAt,
 *               deliveryStatus, deliveredEmail, deliveredPassword,
 *               deliveredLoginUrl, deliveredNote }
 */

/**
 * Hitung jumlah stok yang masih tersedia (belum sold) untuk sebuah produk.
 * Dipakai sebagai pengecekan cepat SEBELUM generate QRIS, supaya kalau
 * stok sudah kosong kita tidak perlu memanggil payment gateway sama sekali.
 *
 * Catatan: ini hanya pengecekan awal (best-effort), bukan reservasi.
 * Reservasi stok yang sebenarnya (anti race condition) terjadi di
 * validateStockAndDeliver() memakai Firestore transaction saat webhook
 * pembayaran sukses masuk.
 */
export async function getAvailableStockCount(productId) {
  const snap = await db
    .collection("stock")
    .where("productId", "==", productId)
    .where("sold", "==", false)
    .count()
    .get();

  return snap.data().count || 0;
}

/**
 * Buat order baru dengan status PENDING. ID dokumen order = transaction_id
 * dari payment gateway, supaya webhook bisa langsung doc(trx) tanpa query
 * tambahan (dan otomatis idempotent per transaksi).
 */
export async function createPendingOrder({
  transactionId,
  userId,
  username,
  productId,
  productName,
  price,
  packageName,
  expiredAt
}) {
  const orderRef = db.collection("orders").doc(transactionId);

  await orderRef.set(
    {
      userId: userId || null,
      username: username || null,
      productId,
      productName: productName || null,
      price: Number(price) || 0,
      packageName: packageName || null,
      status: "PENDING",
      deliveryStatus: "PENDING",
      payment: null,
      createdAt: FieldValue.serverTimestamp(),
      paidAt: null,
      expiredAt: expiredAt || null
    },
    { merge: true }
  );

  return orderRef;
}

export async function getOrder(transactionId) {
  const snap = await db.collection("orders").doc(transactionId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Dipanggil dari /webhook saat payment gateway melaporkan pembayaran sukses.
 *
 * Ini adalah titik validasi ulang stok yang WAJIB ada (stok bisa saja habis
 * di antara waktu QRIS dibuat dan waktu pembayaran benar-benar masuk, karena
 * QRIS tidak mengunci/reservasi stok). Proteksi race condition dilakukan
 * dengan Firestore transaction: baca order + query stok + tulis perubahan
 * semuanya dalam satu transaction atomik. Kalau ada request lain yang
 * mengubah dokumen stok yang sama di tengah jalan, Firestore otomatis
 * me-retry transaction ini sampai konsisten — jadi tidak mungkin dua order
 * mendapat unit stok yang sama (no double delivery / no oversell).
 *
 * Idempotent: kalau webhook dipanggil berkali-kali (retry dari payment
 * gateway) untuk transaction_id yang sama, hanya proses pertama yang
 * benar-benar mengurangi stok. Panggilan berikutnya akan mendeteksi order
 * sudah PAID dan tidak melakukan apa-apa lagi.
 */
export async function validateStockAndDeliver(transactionId, paymentType) {
  const orderRef = db.collection("orders").doc(transactionId);

  return db.runTransaction(async (t) => {
    const orderSnap = await t.get(orderRef);

    if (!orderSnap.exists) {
      return { ok: false, reason: "ORDER_NOT_FOUND" };
    }

    const order = orderSnap.data();

    // Idempotent guard — sudah pernah diproses sebelumnya, jangan diulang.
    if (order.status === "PAID" || order.status === "PAID_OUT_OF_STOCK") {
      return { ok: true, reason: "ALREADY_PROCESSED", order };
    }

    // Validasi ulang stok di dalam transaction yang sama (anti race condition).
    const stockQuery = db
      .collection("stock")
      .where("productId", "==", order.productId)
      .where("sold", "==", false)
      .limit(1);

    const stockSnap = await t.get(stockQuery);

    if (stockSnap.empty) {
      // Pembayaran sukses tapi stok sudah habis saat validasi ulang.
      // Jangan pura-pura berhasil kirim akun — tandai butuh tindakan admin
      // (refund/restock manual) alih-alih diam-diam gagal.
      t.update(orderRef, {
        status: "PAID_OUT_OF_STOCK",
        deliveryStatus: "NEEDS_ADMIN_ACTION",
        payment: paymentType || null,
        paidAt: FieldValue.serverTimestamp()
      });
      return { ok: true, reason: "OUT_OF_STOCK_ON_PAYMENT" };
    }

    const stockDoc = stockSnap.docs[0];
    const stockData = stockDoc.data();

    // Reservasi unit stok ini untuk order ini (atomic bersama update order).
    t.update(stockDoc.ref, {
      sold: true,
      orderId: transactionId,
      soldAt: FieldValue.serverTimestamp()
    });

    t.update(orderRef, {
      status: "PAID",
      deliveryStatus: "DELIVERED",
      payment: paymentType || null,
      paidAt: FieldValue.serverTimestamp(),
      deliveredEmail: stockData.email || null,
      deliveredPassword: stockData.password || null,
      deliveredLoginUrl: stockData.loginUrl || null,
      deliveredNote: stockData.note || null
    });

    return { ok: true, reason: "DELIVERED" };
  });
}

/**
 * Tandai order sebagai gagal/kadaluarsa (dipanggil dari webhook untuk status
 * selain success, atau dari /status saat mendeteksi order pending yang sudah
 * lewat waktu expired). Tidak menyentuh stok karena tidak ada stok yang
 * pernah direservasi untuk order yang gagal/kadaluarsa.
 */
export async function markOrderTerminalStatus(transactionId, status) {
  const orderRef = db.collection("orders").doc(transactionId);
  const snap = await orderRef.get();
  if (!snap.exists) return null;

  const current = snap.data();
  // Jangan timpa order yang sudah PAID/PAID_OUT_OF_STOCK.
  if (current.status === "PAID" || current.status === "PAID_OUT_OF_STOCK") {
    return current;
  }
  if (current.status === status) {
    return current;
  }

  await orderRef.update({ status });
  return { ...current, status };
}
