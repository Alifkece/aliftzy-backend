// api/index.js
//
// Migrasi dari route Express `app.get("/", ...)` di server.js lama (health
// check). Path tetap "/" (root) berkat rewrite di vercel.json.

import { applyCors } from "../lib/http.js";

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  return res.status(200).send("Aliftzy Backend Aktif");
}
