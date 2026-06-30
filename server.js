import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());


app.post("/create-payment", async (req, res) => {

  try {

    const { amount, username } = req.body;


    if (!amount || !username) {
      return res.status(400).json({
        error: "amount dan username wajib diisi"
      });
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


    return res.json(result);


  } catch (err) {


    return res.status(500).json({
      error: err.message
    });


  }

});



app.post("/webhook", (req, res) => {


  console.log("WEBHOOK MASUK:");
  console.log(req.body);


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
