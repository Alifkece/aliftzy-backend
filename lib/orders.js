// lib/orders.js
// File BARU untuk revisi stok QRIS.
//
// Semua logic yang berkaitan dengan pengecekan stok, pembuatan order,
// dan klaim stok atomik (webhook) dikumpulkan di sini supaya server.js
// tidak perlu dirombak besar-besaran.
//
// Koleksi Firestore yang dipakai (mengikuti struktur yang SUDAH ADA
// di Store, lihat README Store bagian "Database"):
//   - stock   : { productId, packageName, sold, ...data pengiriman akun }
//   - orders  : dokumen baru dibuat oleh backend ini, id = transaction_id
//
// Koleksi BARU yang ditambahkan (murni tambahan, tidak mengganggu apapun):
//   - admin_alerts : notifikasi ke admin saat stok habis pas webhook diproses
//
// UPDATE STOK PER PAKET: sebelumnya stok hanya dicek/diklaim berdasarkan
// productId, jadi produk yang stoknya cuma tersedia di satu paket (mis.
// "1 Tahun") dianggap tersedia juga untuk paket lain (mis. "1 Bulan") yang
// sebenarnya kosong. Sekarang seluruh pengecekan & klaim stok memakai
// kombinasi productId + packageName, sama persis dengan yang dipakai
// Dashboard Admin saat menambah stok dan Store (Vercel) di lib/orders.js.
// packageName tetap OPSIONAL (fail-open) supaya request lama yang belum
// mengirim packageName tidak langsung dianggap error - baru kalau
// packageName dikirim, validasi per-paket diterapkan secara ketat.

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
 * Cek cepat (non-transaksi) apakah suatu produk (opsional: + paket
 * tertentu) masih punya stok. Dipanggil SEBELUM generate QRIS. Ini bukan
 * penjamin 100% anti race condition (itu tugas claimStockForOrder di
 * webhook) - ini hanya "penjaga pintu depan" supaya QRIS tidak dibuat
 * kalau stok SUDAH pasti kosong.
 *
 * packageName OPSIONAL (fail-open untuk klien lama yang belum mengirimnya):
 * kalau diisi, stok dicek per KOMBINASI productId + packageName supaya
 * paket yang kosong tidak dianggap tersedia hanya karena paket lain dari
 * produk yang sama masih ada stok. Kalau tidak diisi, fallback ke
 * perilaku lama (cek per productId saja).
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
 * transaction_id tersebut. Dipanggil SETELAH SiTransfer sukses generate
 * QRIS.
 *
 * Kegagalan fungsi ini TIDAK BOLEH menggagalkan response ke buyer -
 * dipanggil dengan try/catch di server.js.
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
    let stockQuery = db
      .collection(STOCK_COLLECTION)
      .where("productId", "==", order.productId);

    // Order yang punya packageName (order baru, sejak stok dipisah per
    // paket) WAJIB diklaim dari stok paket yang SAMA PERSIS - supaya order
    // paket "1 Bulan" tidak pernah bisa mengambil stok paket "1 Tahun".
    // Order lama tanpa packageName (dibuat sebelum revisi ini) tetap
    // fallback ke perilaku lama (klaim dari stok manapun milik productId
    // itu) supaya tidak ada transaksi in-flight yang tiba-tiba gagal.
    if (order.packageName) {
      stockQuery = stockQuery.where("packageName", "==", order.packageName);
    }

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
