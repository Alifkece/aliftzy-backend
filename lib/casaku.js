// lib/casaku.js
// FILE BARU — migrasi payment gateway dari SiTransfer ke Casaku.
//
// Berisi SELURUH pemanggilan REST API Casaku (generate QRIS v2, cek status)
// serta verifikasi signature webhook. TIDAK ADA logic stok/Firestore di sini
// — itu tetap murni tanggung jawab lib/orders.js, sama seperti sebelumnya.
//
// Sumber kebenaran: https://casaku.id/docs
//
// Credential (CASAKU_LICENSE_KEY, CASAKU_WEBHOOK_SECRET, CASAKU_QR_ID) HANYA
// dibaca dari environment variable — tidak pernah di-hardcode, tidak pernah
// di-return ke frontend.

import crypto from "crypto";
import QRCode from "qrcode";

const CASAKU_BASE_URL = "https://api.casaku.id";

function getLicenseKey() {
  const key = process.env.CASAKU_LICENSE_KEY;
  if (!key) throw new Error("CASAKU_LICENSE_KEY tidak terbaca di environment");
  return key;
}

function getQrId() {
  const id = process.env.CASAKU_QR_ID;
  if (!id) throw new Error("CASAKU_QR_ID tidak terbaca di environment");
  return id;
}

/**
 * Buat transaksi QRIS dinamis lewat Casaku (Generate QRIS v2).
 * QRIS merchant yang dipakai (via CASAKU_QR_ID) sudah terdaftar khusus
 * untuk provider DANA — packageIds dibatasi ke "id.dana" sesuai QRIS
 * merchant yang aktif di akun Casaku.
 *
 * Mengembalikan bentuk yang sudah dinormalisasi supaya adapter di
 * api/create-payment.js tinggal pakai langsung:
 *   { transactionId, totalAmount, qrString, expiredInMinutes }
 */
async function generateQris(amount) {
  const expiredInMinutes = 15;

  const response = await fetch(`${CASAKU_BASE_URL}/api/generate/v2/qris`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-license-key": getLicenseKey()
    },
    body: JSON.stringify({
      qr_id: getQrId(),
      amount: Number(amount),
      useUniqueCode: true,
      packageIds: ["id.dana"],
      expiredInMinutes,
      qrType: "dynamic",
      paymentMethod: "qris",
      useQris: true
    })
  });

  const result = await response.json();
  const data = result?.data || result;

  if (!response.ok || !data?.qr_string || !data?.transactionId) {
    const message =
      result?.message || result?.error || "Gagal membuat transaksi QRIS di Casaku";
    const err = new Error(message);
    err.raw = result;
    throw err;
  }

  return {
    transactionId: data.transactionId,
    totalAmount: Number(data.totalAmount ?? amount),
    qrString: data.qr_string,
    expiredInMinutes
  };
}

/**
 * Ubah qr_string (raw payload QRIS) hasil Casaku menjadi image data URL
 * (PNG base64) yang di-render di server. Ini supaya Frontend Store tetap
 * bisa memakai `fetch(data.qris_image).then(r => r.blob())` PERSIS seperti
 * waktu SiTransfer mengirim URL gambar QR langsung — fetch() browser modern
 * mendukung data: URL, jadi js/app.js TIDAK PERLU direvisi sama sekali.
 */
async function qrStringToImageDataUrl(qrString) {
  return QRCode.toDataURL(qrString, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 512
  });
}

/**
 * Cek status transaksi Casaku. Mengembalikan status resmi Casaku APA
 * ADANYA ("pending" | "paid" | "cancel" | "expired") — normalisasi ke
 * kosakata yang sudah dikenali js/app.js dilakukan di api/status.js, BUKAN
 * di sini, supaya file ini murni wrapper API Casaku.
 */
async function checkStatus(transactionId) {
  const response = await fetch(`${CASAKU_BASE_URL}/api/generate/check-status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-license-key": getLicenseKey()
    },
    body: JSON.stringify({ transactionId })
  });

  const result = await response.json();
  const data = result?.data || result;

  return {
    transactionId: data?.transactionId || transactionId,
    status: String(data?.status || "").toLowerCase(),
    amount: data?.amount
  };
}

/**
 * Verifikasi signature webhook Casaku (HMAC-SHA256 atas RAW body, memakai
 * CASAKU_WEBHOOK_SECRET) — WAJIB dipanggil SEBELUM body di-parse/dipercaya
 * sama sekali, sesuai dokumentasi resmi Casaku (raw body, bukan hasil
 * JSON.parse ulang, karena urutan key tidak dijamin identik).
 *
 * rawBody HARUS Buffer/string mentah (belum di-JSON.parse).
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.CASAKU_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      "[casaku] CASAKU_WEBHOOK_SECRET belum diset — webhook DITOLAK demi keamanan."
    );
    return false;
  }
  if (!signatureHeader || typeof signatureHeader !== "string") return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  let expectedBuf, receivedBuf;
  try {
    expectedBuf = Buffer.from(expected, "hex");
    receivedBuf = Buffer.from(signatureHeader, "hex");
  } catch {
    return false;
  }

  if (expectedBuf.length !== receivedBuf.length) return false;

  try {
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

export { generateQris, qrStringToImageDataUrl, checkStatus, verifyWebhookSignature };
