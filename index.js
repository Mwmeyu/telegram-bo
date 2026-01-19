const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// Create necessary directories
const createDirectories = async () => {
  const dirs = ['sessions', 'logs'];
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      // Directory already exists
    }
  }
};

// Initialize
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

// ========== DATABASE MODELS ==========
const UserSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  lastName: String,
  isPremium: { type: Boolean, default: false },
  subscriptionExpiry: Date,
  apiLimit: { type: Number, default: 3 },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

const AccountSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  apiId: { type: String, required: true },
  apiHash: { type: String, required: true },
  sessionString: { type: String, required: true },
  isActive: { type: Boolean, default: true },
  isBanned: { type: Boolean, default: false },
  ownerUserId: { type: Number, required: true },
  ownerUsername: String,
  has2FA: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  lastUsed: { type: Date, default: Date.now }
});

const GroupSchema = new mongoose.Schema({
  groupName: String,
  chatId: String,
  inviteLink: String,
  createdByAccount: String,
  createdByUser: Number,
  createdAt: { type: Date, default: Date.now },
  memberCount: { type: Number, default: 1 },
  isActive: { type: Boolean, default: true }
});

const User = mongoose.model('User', UserSchema);
const Account = mongoose.model('Account', AccountSchema);
const Group = mongoose.model('Group', GroupSchema);

// ========== ENCRYPTION ==========
class Encryption {
  static encrypt(text) {
    const key = process.env.ENCRYPTION_KEY || 'default-key-32-chars-long-here!!';
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key.padEnd(32, '0').slice(0, 32)), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`;
  }

  static decrypt(text) {
    const key = process.env.ENCRYPTION_KEY || 'default-key-32-chars-long-here!!';
    const [ivHex, encryptedHex, authTagHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key.padEnd(32, '0').slice(0, 32)), iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}

// ========== SIMPLIFIED TELEGRAM SERVICE ==========
class TelegramService {
  constructor(apiId, apiHash, phone) {
    this.apiId = parseInt(apiId);
    this.apiHash = apiHash;
    this.phone = phone;
    this.client = null;
  }

  async connect(sessionString = '') {
    try {
      const { TelegramClient } = await import('telegram');
      const { StringSession } = await import('telegram/sessions');
      
      this.stringSession = new StringSession(sessionString);
      this.client = new TelegramClient(this.stringSession, this.apiId, this.apiHash, {
        connectionRetries: 3,
      });
      
      await this.client.connect();
      return true;
    } catch (error) {
      console.error('Connection error:', error.message);
      return false;
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
    }
  }

  async sendCode() {
    try {
      if (!this.client) {
        const connected = await this.connect();
        if (!connected) return false;
      }
      
      await this.client.sendCode({
        apiId: this.apiId,
        apiHash: this.apiHash,
      }, this.phone);
      return true;
    } catch (error) {
      console.error('Send code error:', error.message);
      return false;
    }
  }

  async signIn(code) {
    try {
      await this.client.signIn({
        phoneNumber: this.phone,
        phoneCode: code,
      });
      return true;
    } catch (error) {
      if (error.message?.includes('SESSION_PASSWORD_NEEDED') || error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        return '2FA_NEEDED';
      }
      throw error;
    }
  }

  async signInWithPassword(password) {
    try {
      await this.client.signIn({
        password: password,
      });
      return true;
    } catch (error) {
      throw error;
    }
  }

  async getSessionString() {
    if (this.client && this.client.session) {
      return this.client.session.save();
    }
    return '';
  }
}

// ========== SESSION MANAGEMENT ==========
const userSessions = new Map();
const ADMIN_USERNAMES = ["mwmeyu"];
const ADMIN_USER_IDS = [];

function isAdmin(userId, username) {
  if (ADMIN_USER_IDS.includes(userId)) return true;
  if (username && ADMIN_USERNAMES.includes(username.toLowerCase())) {
    if (!ADMIN_USER_IDS.includes(userId)) ADMIN_USER_IDS.push(userId);
    return true;
  }
  return false;
}

// Group name templates
const GROUP_NAME_TEMPLATES = [
  "Global Chat",
  "Friends Zone",
  "Discussion Hub",
  "Chat Group",
  "Community",
  "Talk Room",
  "Connect",
  "Social Hub",
  "Network",
  "Unity"
];

function generateGroupName() {
  const template = GROUP_NAME_TEMPLATES[Math.floor(Math.random() * GROUP_NAME_TEMPLATES.length)];
  const number = Math.floor(1000 + Math.random() * 9000);
  return `${template} ${number}`;
}

// ========== BOT COMMANDS ==========

// Start command
bot.command('start', async (ctx) => {
  const user = ctx.from;
  const userId = user.id;
  
  try {
    // Register or find user
    let userDoc = await User.findOne({ telegramId: userId });
    if (!userDoc) {
      userDoc = new User({
        telegramId: userId,
        username: user.username,
        firstName: user.first_name,
        lastName: user.last_name
      });
      await userDoc.save();
    }
    
    userDoc.lastActive = new Date();
    await userDoc.save();
    
    const admin = isAdmin(userId, user.username);
    const accountCount = await Account.countDocuments({ ownerUserId: userId, isActive: true, isBanned: false });
    const groupCount = await Group.countDocuments({ createdByUser: userId, isActive: true });
    
    const buttons = [
      [Markup.button.callback('➕ Add Account', 'add_account')],
      [Markup.button.callback('👥 Create Group', 'create_group')],
      [Markup.button.callback('📱 My Accounts', 'list_accounts')],
      [Markup.button.callback('📊 Stats', 'show_stats')]
    ];
    
    if (admin) {
      buttons.push([Markup.button.callback('👑 Admin Panel', 'admin_panel')]);
    }
    
    const keyboard = Markup.inlineKeyboard(buttons);
    
    await ctx.reply(`
🤖 <b>Cretee Bot - Full Version</b>

Welcome, ${user.first_name}! I'm your 24/7 Telegram group manager.

📋 <b>Features:</b>
• Multiple account support
• Group creation
• 24/7 uptime

👤 <b>Your Stats:</b>
📱 Accounts: ${accountCount}
👥 Groups Created: ${groupCount}
${admin ? '👑 Role: Admin' : '💎 Plan: Standard'}

Use buttons or commands below:
/addaccount - Add Telegram account
/creategroup - Create single group
/listaccounts - List your accounts
/status - Check bot status
${admin ? '/admin - Admin panel' : ''}
    `, {
      parse_mode: 'HTML',
      ...keyboard
    });
  } catch (error) {
    console.error('Start command error:', error);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
});

// Add account command
bot.command('addaccount', async (ctx) => {
  const userId = ctx.from.id;
  
  const userDoc = await User.findOne({ telegramId: userId });
  const maxAccounts = userDoc?.isPremium ? 10 : 3;
  const accountCount = await Account.countDocuments({ ownerUserId: userId, isActive: true, isBanned: false });
  
  if (accountCount >= maxAccounts) {
    return ctx.reply(`
❌ Account limit reached!

You have ${accountCount}/${maxAccounts} accounts.

💎 Upgrade to premium for more accounts.
    `);
  }
  
  userSessions.set(userId, {
    state: 'WAITING_API',
    data: {}
  });
  
  await ctx.reply(`
📱 <b>Add Real Telegram Account</b>

To add your account:

1. Go to <a href="https://my.telegram.org">my.telegram.org</a>
2. Login with your phone number
3. Go to "API Development Tools"
4. Create new application
5. Send me in this format:

<code>api_id api_hash phone_number</code>

Example: <code>123456 1a2b3c4d5e6f +1234567890</code>
  `, {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
});

// Handle API credentials input
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const userSession = userSessions.get(userId);
  
  if (!userSession) return;
  
  const text = ctx.message.text.trim();
  
  if (userSession.state === 'WAITING_API') {
    const parts = text.split(/\s+/);
    
    if (parts.length < 3) {
      return ctx.reply('❌ Invalid format. Send: api_id api_hash phone_number');
    }
    
    const [apiId, apiHash, phone] = parts;
    
    // Validate phone
    if (!/^\+[1-9]\d{1,14}$/.test(phone)) {
      return ctx.reply('❌ Invalid phone format. Use: +1234567890');
    }
    
    // Check if phone already exists
    const existing = await Account.findOne({ phone });
    if (existing) {
      return ctx.reply(`❌ Phone ${phone} already exists. Use different number.`);
    }
    
    userSession.state = 'WAITING_CODE';
    userSession.data = { apiId, apiHash, phone };
    userSessions.set(userId, userSession);
    
    try {
      const telegramService = new TelegramService(apiId, apiHash, phone);
      const sent = await telegramService.sendCode();
      
      if (sent) {
        userSession.telegramService = telegramService;
        await ctx.reply('✅ Code sent! Enter the 5-digit verification code:');
      } else {
        await ctx.reply('❌ Failed to send code. Check phone number.');
        userSessions.delete(userId);
      }
    } catch (error) {
      await ctx.reply(`❌ Error: ${error.message}`);
      userSessions.delete(userId);
    }
  }
  
  else if (userSession.state === 'WAITING_CODE') {
    if (!/^\d{5}$/.test(text)) {
      return ctx.reply('❌ Invalid code. Enter 5-digit code:');
    }
    
    try {
      const telegramService = userSession.telegramService;
      const result = await telegramService.signIn(text);
      
      if (result === true) {
        const sessionString = await telegramService.getSessionString();
        
        // Save account to database
        const account = new Account({
          phone: userSession.data.phone,
          apiId: userSession.data.apiId,
          apiHash: userSession.data.apiHash,
          sessionString: Encryption.encrypt(sessionString),
          ownerUserId: userId,
          ownerUsername: ctx.from.username,
          isActive: true
        });
        
        await account.save();
        await telegramService.disconnect();
        
        // Clear session
        userSessions.delete(userId);
        
        await ctx.reply(`
✅ <b>Account added successfully!</b>

Account: ${userSession.data.phone}
Use /creategroup to start creating groups.
        `, { parse_mode: 'HTML' });
        
      } else if (result === '2FA_NEEDED') {
        userSession.state = 'WAITING_PASSWORD';
        await ctx.reply('🔐 Account has 2FA. Enter your password:');
      } else {
        await ctx.reply('❌ Invalid code. Try /addaccount again.');
        userSessions.delete(userId);
      }
    } catch (error) {
      await ctx.reply(`❌ Error: ${error.message}`);
      userSessions.delete(userId);
    }
  }
  
  else if (userSession.state === 'WAITING_PASSWORD') {
    try {
      const telegramService = userSession.telegramService;
      const success = await telegramService.signInWithPassword(text);
      
      if (success) {
        const sessionString = await telegramService.getSessionString();
        
        // Save account to database
        const account = new Account({
          phone: userSession.data.phone,
          apiId: userSession.data.apiId,
          apiHash: userSession.data.apiHash,
          sessionString: Encryption.encrypt(sessionString),
          ownerUserId: userId,
          ownerUsername: ctx.from.username,
          isActive: true,
          has2FA: true
        });
        
        await account.save();
        await telegramService.disconnect();
        
        // Clear session
        userSessions.delete(userId);
        
        await ctx.reply(`
✅ <b>Account added with 2FA!</b>

Account: ${userSession.data.phone}
Use /creategroup to start.
        `, { parse_mode: 'HTML' });
      } else {
        await ctx.reply('❌ Invalid password. Try /addaccount again.');
        userSessions.delete(userId);
      }
    } catch (error) {
      await ctx.reply(`❌ Error: ${error.message}`);
      userSessions.delete(userId);
    }
  }
});

// Create group command - SIMPLIFIED FOR NOW
bot.command('creategroup', async (ctx) => {
  await ctx.reply(`
🚧 <b>Feature Under Development</b>

Group creation feature is being updated.
Please check back soon!

For now, you can:
1. Add accounts with /addaccount
2. List accounts with /listaccounts
  `, { parse_mode: 'HTML' });
});

// List accounts command
bot.command('listaccounts', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  
  try {
    const accounts = await Account.find(
      isAdmin(userId, username) 
        ? { isActive: true, isBanned: false }
        : { ownerUserId: userId, isActive: true, isBanned: false }
    ).sort({ lastUsed: -1 });
    
    if (accounts.length === 0) {
      return ctx.reply('📭 No accounts found. Use /addaccount to add one.');
    }
    
    let message = isAdmin(userId, username) 
      ? '📱 <b>All Accounts (Admin View)</b> 👑\n\n'
      : '📱 <b>Your Accounts</b>\n\n';
    
    accounts.forEach((acc, i) => {
      message += `${i + 1}. <b>${acc.phone}</b>\n`;
      message += `   Status: ${acc.isActive ? '🟢 Active' : '🔴 Inactive'}\n`;
      message += `   Last used: ${acc.lastUsed ? acc.lastUsed.toLocaleDateString() : 'Never'}\n`;
      if (i < accounts.length - 1) message += '\n';
    });
    
    await ctx.reply(message, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('List accounts error:', error);
    await ctx.reply('❌ Error loading accounts.');
  }
});

// Status command
bot.command('status', async (ctx) => {
  try {
    const totalAccounts = await Account.countDocuments();
    const activeAccounts = await Account.countDocuments({ isActive: true, isBanned: false });
    
    await ctx.reply(`
📊 <b>Bot Status</b>

✅ Online 24/7
🌐 Host: Render.com
💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
⏰ Uptime: ${Math.floor(process.uptime() / 60)} minutes

📈 <b>Statistics:</b>
Total Accounts: ${totalAccounts}
Active Accounts: ${activeAccounts}
    `, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply('📊 Bot is online! Database statistics temporarily unavailable.');
  }
});

// Admin command
bot.command('admin', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  
  if (!isAdmin(userId, username)) {
    return ctx.reply('❌ This command is only for administrators.');
  }
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📊 System Stats', 'admin_stats')],
    [Markup.button.callback('👥 List All Users', 'admin_list_users')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')]
  ]);
  
  await ctx.reply(`
👑 <b>Admin Panel</b>

Welcome, ${ctx.from.first_name}!

Select an option:
  `, {
    parse_mode: 'HTML',
    ...keyboard
  });
});

// Handle callback queries
bot.action('add_account', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Use /addaccount command to add a new account.');
});

bot.action('create_group', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Use /creategroup command to create a new group.');
});

bot.action('list_accounts', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Use /listaccounts command to see your accounts.');
});

bot.action('show_stats', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  
  try {
    const accountCount = await Account.countDocuments({ ownerUserId: userId, isActive: true, isBanned: false });
    const groupCount = await Group.countDocuments({ createdByUser: userId, isActive: true });
    
    await ctx.reply(`
📊 <b>Your Statistics</b>

📱 Accounts: ${accountCount}
👥 Total Groups: ${groupCount}
    `, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply('📊 Statistics temporarily unavailable.');
  }
});

bot.action('admin_panel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Use /admin command for admin panel.');
});

bot.action('admin_stats', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('👑 Admin statistics coming soon...');
});

bot.action('admin_list_users', async (ctx) => {
  await ctx.answerCbQuery();
  
  try {
    const users = await Account.aggregate([
      {
        $group: {
          _id: '$ownerUserId',
          username: { $first: '$ownerUsername' },
          accountCount: { $sum: 1 },
          activeCount: { $sum: { $cond: [{ $and: ['$isActive', { $not: '$isBanned' }] }, 1, 0] } }
        }
      },
      { $sort: { accountCount: -1 } }
    ]);
    
    if (users.length === 0) {
      return ctx.reply('No users found.');
    }
    
    let message = '👥 <b>All Users</b> 👑\n\n';
    
    users.forEach((user, i) => {
      message += `<b>User ID:</b> ${user._id}\n`;
      if (user.username) {
        message += `<b>Username:</b> @${user.username}\n`;
      }
      message += `<b>Accounts:</b> ${user.activeCount}/${user.accountCount} active\n`;
      message += '─'.repeat(20) + '\n\n';
    });
    
    await ctx.reply(message, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply('❌ Error loading users.');
  }
});

bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🏠 <b>Main Menu</b>\n\nUse /start to see all commands.', {
    parse_mode: 'HTML'
  });
});

// Error handling
bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
  ctx.reply('❌ An error occurred. Please try again.');
});

// ========== EXPRESS SERVER FOR 24/7 ==========
// FIXED: No async operations in template string
app.get('/', async (req, res) => {
  try {
    // Get stats safely
    let userCount = 0;
    let accountCount = 0;
    let groupCount = 0;
    
    try {
      userCount = await User.countDocuments() || 0;
      accountCount = await Account.countDocuments() || 0;
      groupCount = await Group.countDocuments() || 0;
    } catch (dbError) {
      console.log('Database stats temporarily unavailable');
    }
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Cretee Bot - Telegram Group Manager</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
          }
          .container { 
            max-width: 800px; 
            width: 100%;
            background: white; 
            padding: 40px; 
            border-radius: 20px; 
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
          }
          h1 { 
            color: #333; 
            margin-bottom: 20px;
            font-size: 2.5em;
          }
          .status { 
            padding: 25px; 
            border-radius: 15px; 
            margin: 25px 0; 
            background: #d4edda;
            border-left: 5px solid #28a745;
          }
          .online h2 { 
            color: #155724; 
            margin-bottom: 10px;
          }
          .info { 
            background: #d1ecf1; 
            border-left: 5px solid #17a2b8;
          }
          .info h3 { 
            color: #0c5460; 
            margin-bottom: 15px;
          }
          .btn { 
            display: inline-block; 
            padding: 15px 30px; 
            background: #007bff; 
            color: white; 
            text-decoration: none; 
            border-radius: 50px; 
            margin: 10px; 
            font-weight: bold;
            transition: all 0.3s ease;
            border: none;
            cursor: pointer;
          }
          .btn:hover { 
            background: #0056b3; 
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,123,255,0.3);
          }
          .features { 
            text-align: left; 
            margin: 30px 0;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 10px;
          }
          .features li { 
            margin: 10px 0; 
            padding-left: 20px;
            position: relative;
          }
          .features li:before {
            content: "✓";
            color: #28a745;
            position: absolute;
            left: 0;
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🤖 Cretee Bot</h1>
          <div class="status online">
            <h2>✅ Bot Status: ONLINE 24/7</h2>
            <p>Running on Render.com</p>
          </div>
          <div class="status info">
            <h3>📊 Server Information</h3>
            <p><strong>Uptime:</strong> ${Math.floor(process.uptime() / 3600)} hours</p>
            <p><strong>Memory:</strong> ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB</p>
            <p><strong>Node.js:</strong> ${process.version}</p>
            <p><strong>Users:</strong> ${userCount}</p>
            <p><strong>Accounts:</strong> ${accountCount}</p>
            <p><strong>Groups Created:</strong> ${groupCount}</p>
          </div>
          
          <a href="https://t.me/${process.env.BOT_TOKEN ? 'YourBotUsername' : 'cretee_bot'}" class="btn" target="_blank">
            Open Telegram Bot
          </a>
          <a href="https://render.com" class="btn" target="_blank">
            View Hosting
          </a>
          
          <div class="features">
            <h3>🚀 Features:</h3>
            <ul>
              <li>Multiple Telegram account management</li>
              <li>Secure credential storage</li>
              <li>24/7 uptime monitoring</li>
              <li>Admin panel for management</li>
              <li>Group creation (coming soon)</li>
              <li>Bulk operations (coming soon)</li>
            </ul>
          </div>
          
          <h3>📖 How to Use:</h3>
          <p>1. Open Telegram and search for the bot</p>
          <p>2. Send /start to begin</p>
          <p>3. Add your Telegram accounts via API</p>
          <p>4. Manage your accounts</p>
        </div>
        
        <script>
          // Auto-refresh every 5 minutes to keep server alive
          setTimeout(() => location.reload(), 300000);
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    res.send(`
      <html>
        <body>
          <h1>🤖 Cretee Bot</h1>
          <p>✅ Bot is running...</p>
          <p>Error loading stats: ${error.message}</p>
        </body>
      </html>
    `);
  }
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// ========== START BOT ==========
async function start() {
  try {
    // Create directories
    await createDirectories();
    
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/cretee_bot';
    console.log('🔗 Connecting to MongoDB...');
    
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    console.log('✅ Connected to MongoDB');
    
    // Start web server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🌐 Web server running on port ${PORT}`);
      console.log(`🔗 Health check: http://localhost:${PORT}/health`);
      console.log(`🔗 Main page: http://localhost:${PORT}/`);
    });
    
    // Start bot
    console.log('🤖 Starting Telegram bot...');
    await bot.launch();
    
    console.log('✅ Bot is running online!');
    console.log(`👑 Admin users: ${ADMIN_USERNAMES.join(', ')}`);
    console.log(`🚀 Bot ready for use`);
    
    // Graceful shutdown
    process.once('SIGINT', () => {
      console.log('🛑 Shutting down gracefully...');
      bot.stop('SIGINT');
      mongoose.disconnect();
      process.exit(0);
    });
    
    process.once('SIGTERM', () => {
      console.log('🛑 Received SIGTERM, shutting down...');
      bot.stop('SIGTERM');
      mongoose.disconnect();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('❌ Failed to start:', error);
    console.log('Trying to continue without database...');
    
    // Start web server even without DB
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🌐 Web server running on port ${PORT} (no DB)`);
    });
    
    // Start bot without DB
    try {
      await bot.launch();
      console.log('✅ Bot running (without database)');
    } catch (botError) {
      console.error('❌ Bot failed:', botError.message);
    }
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error.message);
});

// Start the application
start();