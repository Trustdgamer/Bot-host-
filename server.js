const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// --- DATABASE MODELS ---
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  walletBalance: { type: Number, default: 0 },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  apiKey: { type: String, default: () => 'tb_live_' + Math.random().toString(36).substr(2, 10) },
  createdAt: { type: Date, default: Date.now }
});

const BotSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  language: String,
  ram: Number,
  status: { type: String, enum: ['DEPLOYING', 'RUNNING', 'STOPPED', 'SUSPENDED', 'EXPIRED'], default: 'DEPLOYING' },
  expiryDate: Date,
  planId: String,
  port: Number,
  logs: [String],
  createdAt: { type: Date, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: Number,
  type: { type: String, enum: ['DEPOSIT', 'DEDUCTION'] },
  description: String,
  timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Bot = mongoose.model('Bot', BotSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

// --- MIDDLEWARE ---
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Unauthorized' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.user = await User.findById(decoded.id);
    if (!req.user) return res.status(401).json({ message: 'User not found' });
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
  next();
};

// --- ROUTES ---

// Auth
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret');
  res.json({ user, token });
});

app.get('/api/auth/me', authenticate, (req, res) => res.json(req.user));

// Admin
app.post('/api/admin/create-user', authenticate, isAdmin, async (req, res) => {
  const { username, email, password, role, walletBalance } = req.body;
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ username, email, password: passwordHash, role, walletBalance });
  res.json(user);
});

app.get('/api/admin/users', authenticate, isAdmin, async (req, res) => {
  const users = await User.find();
  res.json(users);
});

app.post('/api/admin/users/:id/add-funds', authenticate, isAdmin, async (req, res) => {
  const user = await User.findById(req.params.id);
  user.walletBalance += req.body.amount;
  await user.save();
  await Transaction.create({ userId: user._id, amount: req.body.amount, type: 'DEPOSIT', description: 'Admin Deposit' });
  res.json({ message: 'Funds added' });
});

// Bots
app.get('/api/bots', authenticate, async (req, res) => {
  const bots = await Bot.find({ ownerId: req.user._id });
  res.json(bots);
});

app.post('/api/bots/create', authenticate, async (req, res) => {
  const { name, language, ram, planId, expiryDate, price } = req.body;
  if (req.user.walletBalance < price) return res.status(400).json({ message: 'Insufficient funds' });
  
  const bot = await Bot.create({
    ownerId: req.user._id,
    name, language, ram, planId, expiryDate,
    status: 'RUNNING',
    port: Math.floor(Math.random() * 6000) + 3000,
    logs: ['[System] Instance initialized.']
  });
  
  req.user.walletBalance -= price;
  await req.user.save();
  await Transaction.create({ userId: req.user._id, amount: -price, type: 'DEDUCTION', description: `Deployment: ${name}` });
  
  res.json(bot);
});

// Paystack Integration
app.post('/api/paystack/initialize', authenticate, async (req, res) => {
  try {
    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: req.user.email,
      amount: req.body.amount * 100, // In kobo
      callback_url: 'http://localhost:3000/wallet'
    }, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` }
    });
    res.json(response.data.data);
  } catch (err) {
    res.status(500).json({ message: 'Paystack initialization failed' });
  }
});

// --- EXPIRY JOB ---
setInterval(async () => {
  const now = new Date();
  const expiredBots = await Bot.find({ expiryDate: { $lt: now }, status: 'RUNNING' });
  for (let bot of expiredBots) {
    bot.status = 'EXPIRED';
    await bot.save();
    console.log(`Bot ${bot._id} marked as expired.`);
  }
}, 5 * 60 * 1000); // Every 5 minutes

// --- START SERVER ---
const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/trustbit').then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
  
