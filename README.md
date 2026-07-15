# aliftzy-backend

## Environment Variables (Railway)

- `SITRANSFER_KEY` — API key payment gateway SiTransfer.
- `FIREBASE_KEY` — Service account JSON (satu baris, sama seperti yang dipakai di project frontend) untuk akses Firestore (stock/orders validation, auto delivery).
- `PORT` — otomatis di-set oleh Railway, tidak perlu diisi manual.

## Endpoints

- `POST /create-payment` — cek stok produk dulu, baru generate QRIS kalau stok tersedia. Body: `{ amount, username, productId, productName?, packageName?, userId? }`.
- `POST /webhook` — dipanggil oleh payment gateway. Validasi ulang stok secara atomik (Firestore transaction) sebelum menandai order PAID dan mengirim akun (auto delivery).
- `POST /status` — cek status order berdasarkan `{ transaction_id }`, dipakai frontend untuk polling status pembayaran.
- `GET /` — health check.
