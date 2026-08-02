// lib/http.js
//
// File BARU untuk migrasi Express -> Vercel Serverless Functions.
//
// Tujuan: menggantikan middleware `app.use(cors())` dan `app.use(express.json())`
// dari server.js lama dengan versi manual, KARENA Vercel Serverless Functions
// tidak menjalankan middleware Express secara global — setiap file di /api
// adalah handler yang berdiri sendiri.
//
// TIDAK ADA logika bisnis / pembayaran di file ini. Murni infrastruktur HTTP:
//   - applyCors(): replikasi perilaku default paket `cors` (izinkan semua origin,
//     method umum, header Content-Type) supaya Frontend Store & Admin tetap
//     bisa memanggil endpoint ini seperti sebelumnya.
//   - getJsonBody(): Vercel Node.js Functions BIASANYA sudah otomatis mem-parse
//     body JSON ke `req.body` (setara express.json()). Fungsi ini tetap
//     menyediakan fallback baca raw stream untuk jaga-jaga jika suatu saat
//     auto-parsing tidak aktif (mis. Content-Type tidak standar), supaya
//     perilaku selalu identik dengan server.js lama yang selalu berhasil
//     mem-parse body JSON dari client.

export function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export async function getJsonBody(req) {
  // Kasus umum di Vercel: req.body sudah berupa object hasil auto-parse.
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  // Kadang req.body berupa string JSON mentah.
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }

  // Fallback: baca raw stream secara manual (setara express.json()).
  return await new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}
