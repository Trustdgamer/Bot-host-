// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pm2 = require('pm2');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// --- ENSURE REQUIRED DIRECTORIES EXIST ---
const uploadDir = path.join(__dirname, 'uploads');
const botsDir = path.join(__dirname, 'bots');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(botsDir)) fs.mkdirSync(botsDir);

// --- ROUTES ---
const authRoutes = require('./routes/auth');
const botRoutes = require('./routes/bots');
const adminRoutes = require('./routes/admin');
const walletRoutes = require('./routes/wallet');

app.use('/api/auth', authRoutes);
app.use('/api/bots', botRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/wallet', walletRoutes);

// --- EXPIRY JOB ---
const Bot = require('./models/Bot');

setInterval(async () => {
  const now = new Date();
  const expiredBots = await Bot.find({ expiryDate: { $lt: now }, status: { $ne: 'EXPIRED' } });

  if (!expiredBots.length) return;

  pm2.connect((err) => {
    if (err) return console.error('PM2 Connection Error in Job:', err);

    expiredBots.forEach(async (bot) => {
      pm2.delete(`bot_${bot._id}`, async (pm2Err) => {
        if (pm2Err) console.error(`Failed to stop bot ${bot._id}:`, pm2Err);

        bot.status = 'EXPIRED';
        await bot.save();
        console.log(`Bot ${bot._id} stopped and marked as EXPIRED.`);
      });
    });

    pm2.disconnect();
  });
}, 5 * 60 * 1000); // Check every 5 minutes

// --- DATABASE CONNECTION ---
const PORT = process.env.PORT || 5000;
mongoose
  .connect(process.env.MONGO_URI || 'mongodb://localhost:27017/trustbit')
  .then(() => {
    app.listen(PORT, () => console.log(`TrustBit Backend running on port ${PORT}`));
  })
  .catch((err) => console.error('MongoDB connection error:', err));
