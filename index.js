const { Telegraf, session, Scenes: { Stage, BaseScene }, Markup } = require('telegraf');
const { Sequelize, DataTypes } = require('sequelize');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const winston = require('winston');
const AsyncLock = require('async-lock');

// Setup logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ]
});

// Database setup
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: 'bot_database.db',
  logging: false,
  retry: {
    max: 5,
    timeout: 30000
  }
});

// Models
const UserAccount = sequelize.define('UserAccount', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  phone: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  api_id: {
    type: DataTypes.STRING,
    allowNull: false
  },
  api_hash: {
    type: DataTypes.STRING,
    allowNull: false
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  session_file: {
    type: DataTypes.STRING
  },
  session_string: {
    type: DataTypes.TEXT
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  last_used: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  is_banned: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  owner_user_id: {
    type: DataTypes.BIGINT,
    allowNull: false,
    defaultValue: 0
  },
  owner_username: {
    type: DataTypes.STRING
  }
}, {
  tableName: 'user_accounts',
  indexes: [
    { fields: ['owner_user_id'] },
    { fields: ['phone'] },
    { fields: ['is_active'] }
  ]
});

const CreatedGroup = sequelize.define('CreatedGroup', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  group_name: {
    type: DataTypes.STRING
  },
  chat_id: {
    type: DataTypes.STRING
  },
  invite_link: {
    type: DataTypes.STRING
  },
  created_by_account: {
    type: DataTypes.STRING
  },
  created_by_user: {
    type: DataTypes.BIGINT
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  member_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  tableName: 'created_groups',
  indexes: [
    { fields: ['created_by_user'] }
  ]
});

// Initialize database
async function initDatabase() {
  try {
    await sequelize.sync();
    logger.info('✅ Database initialized successfully');
  } catch (error) {
    logger.error('❌ Database initialization failed:', error);
    throw error;
  }
}

// Bot token from environment variable
const BOT_TOKEN = process.env.BOT_TOKEN || '7558633348:AAFE8w35Egwot45wUX2eVunfBUeMdlfg0Rs';

// Admin configuration
const ADMIN_USERNAMES = ['mwmeyu'];
const ADMIN_USER_IDS = new Set();

// User sessions management
const userSessions = new Map();
const sessionLock = new AsyncLock();

// Group name templates
const GROUP_NAME_TEMPLATES = [
  'Global Chat {number}',
  'Friends Zone {number}',
  'Discussion Hub {number}',
  'Chat Group {number}',
  'Community {number}',
  'Talk Room {number}',
  'Connect {number}',
  'Social Hub {number}',
  'Network {number}',
  'Unity {number}'
];

// Helper functions
function isAdmin(userId, username = null) {
  if (ADMIN_USER_IDS.has(userId)) return true;
  if (username && ADMIN_USERNAMES.includes(username.toLowerCase())) return true;
  return false;
}

function getUsernameFromCtx(ctx) {
  return ctx.from?.username || null;
}

function generateGroupName() {
  const template = GROUP_NAME_TEMPLATES[Math.floor(Math.random() * GROUP_NAME_TEMPLATES.length)];
  const number = Math.floor(1000 + Math.random() * 9000);
  return template.replace('{number}', number);
}

async function getUserSession(userId) {
  return new Promise((resolve) => {
    sessionLock.acquire(userId.toString(), () => {
      resolve(userSessions.get(userId) || {});
    });
  });
}

async function setUserSession(userId, key, value) {
  return new Promise((resolve) => {
    sessionLock.acquire(userId.toString(), () => {
      if (!userSessions.has(userId)) {
        userSessions.set(userId, {});
      }
      userSessions.get(userId)[key] = value;
      resolve();
    });
  });
}

async function clearUserSession(userId) {
  return new Promise((resolve) => {
    sessionLock.acquire(userId.toString(), () => {
      userSessions.delete(userId);
      resolve();
    });
  });
}

// Telegram User Account Manager
class UserAccountManager {
  constructor(phone, apiId, apiHash) {
    this.phone = phone;
    this.api_id = apiId;
    this.api_hash = apiHash;
    this.session_string = null;
    this.client = null;
    this.is_connected = false;
  }

  async connect() {
    if (!this.is_connected) {
      const stringSession = new StringSession(this.session_string || '');
      this.client = new TelegramClient(
        stringSession,
        parseInt(this.api_id),
        this.api_hash,
        {
          connectionRetries: 5,
          timeout: 30,
          autoReconnect: true
        }
      );
      
      await this.client.connect();
      this.is_connected = true;
    }
  }

  async disconnect() {
    if (this.is_connected && this.client) {
      await this.client.disconnect();
      this.is_connected = false;
    }
  }

  async sendCode() {
    try {
      await this.connect();
      const result = await this.client.sendCode({
        apiId: parseInt(this.api_id),
        apiHash: this.api_hash,
      }, this.phone);
      return { success: true, phoneCodeHash: result.phoneCodeHash };
    } catch (error) {
      logger.error('Failed to send code:', error);
      return { success: false, error: error.message };
    }
  }

  async signIn(code, phoneCodeHash) {
    try {
      const result = await this.client.signIn({
        phoneNumber: this.phone,
        phoneCode: code,
        phoneCodeHash: phoneCodeHash
      });
      
      // Save session string
      this.session_string = this.client.session.save();
      return { success: true, session: this.session_string };
    } catch (error) {
      if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        return { success: false, requires2FA: true };
      }
      logger.error('Sign in failed:', error);
      return { success: false, error: error.message };
    }
  }

  async signInWithPassword(password) {
    try {
      await this.client.signIn({
        password: password
      });
      
      // Save session string
      this.session_string = this.client.session.save();
      return { success: true, session: this.session_string };
    } catch (error) {
      logger.error('2FA sign in failed:', error);
      return { success: false, error: error.message };
    }
  }

  async createGroupWithFeatures(groupName, options = {}) {
    const {
      welcomeMessageText = 'hello',
      chatHistoryVisible = true,
      sendWelcomeMessage = true,
      openAllPermissions = true,
      members = []
    } = options;

    try {
      await this.connect();

      // Create the group/channel
      const result = await this.client.invoke({
        _: 'channels.createChannel',
        title: groupName,
        about: '',
        megagroup: true,
        broadcast: false
      });

      const channel = result.chats[0];

      // Make chat history visible if requested
      if (chatHistoryVisible) {
        try {
          await this.client.invoke({
            _: 'channels.togglePreHistoryHidden',
            channel: channel,
            enabled: false
          });
        } catch (error) {
          logger.warning('Could not set chat history visible:', error.message);
        }
      }

      // Open all permissions if requested
      if (openAllPermissions) {
        try {
          const defaultBannedRights = {
            _: 'chatBannedRights',
            until_date: 0,
            view_messages: false,
            send_messages: false,
            send_media: false,
            send_stickers: false,
            send_gifs: false,
            send_games: false,
            send_inline: false,
            embed_links: false,
            send_polls: false,
            change_info: false,
            invite_users: false,
            pin_messages: false
          };

          await this.client.invoke({
            _: 'messages.editChatDefaultBannedRights',
            peer: channel,
            banned_rights: defaultBannedRights
          });
        } catch (error) {
          logger.warning('Could not open all permissions:', error.message);
        }
      }

      // Generate invite link
      const invite = await this.client.invoke({
        _: 'messages.exportChatInvite',
        peer: channel
      });

      // Send welcome message if requested
      if (sendWelcomeMessage) {
        try {
          await this.client.sendMessage(channel, {
            message: welcomeMessageText
          });
        } catch (error) {
          logger.warning('Could not send welcome message:', error.message);
        }
      }

      // Add members if provided
      let addedMembers = 0;
      for (const username of members) {
        try {
          const user = await this.client.getEntity(username);
          await this.client.invoke({
            _: 'channels.inviteToChannel',
            channel: channel,
            users: [user]
          });
          addedMembers++;
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          logger.error(`Failed to add ${username}:`, error.message);
        }
      }

      return {
        success: true,
        chat_id: channel.id.toString(),
        invite_link: invite.link,
        title: channel.title,
        members_added: addedMembers,
        total_members: addedMembers + 1
      };
    } catch (error) {
      logger.error('Error creating group:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getSelfCreatedGroups() {
    try {
      await this.connect();
      const dialogs = await this.client.getDialogs({});
      
      const selfCreatedGroups = [];
      
      for (const dialog of dialogs) {
        try {
          const entity = dialog.entity;
          
          // Skip private chats
          if (!entity || dialog.isUser) continue;
          
          // Check if it's a group/channel
          const isGroup = entity.megagroup || entity._ === 'chat' || entity._ === 'channel';
          if (!isGroup) continue;
          
          // Check if user is the creator
          let isCreator = false;
          
          if (entity.creator) {
            isCreator = true;
          } else {
            try {
              const participant = await this.client.getParticipant(entity, await this.client.getMe());
              if (participant && participant.isCreator) {
                isCreator = true;
              }
            } catch (e) {
              // Skip if we can't get participant info
            }
          }
          
          if (isCreator) {
            selfCreatedGroups.push({
              id: entity.id,
              title: entity.title,
              username: entity.username || null
            });
          }
        } catch (error) {
          logger.error('Error processing dialog:', error);
        }
      }
      
      return selfCreatedGroups;
    } catch (error) {
      logger.error('Error getting self-created groups:', error);
      return [];
    }
  }

  async sendMessageToGroups(groups, messageText) {
    const results = [];
    
    for (const group of groups) {
      try {
        await this.client.sendMessage(group.id, {
          message: messageText
        });
        results.push({
          group_id: group.id,
          title: group.title,
          success: true
        });
        
        // Wait 1 second between messages to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        results.push({
          group_id: group.id,
          title: group.title,
          success: false,
          error: error.message
        });
      }
    }
    
    return results;
  }
}

// Create bot scenes
const addAccountScene = new BaseScene('addAccount');
const createBulkScene = new BaseScene('createBulk');
const createSingleScene = new BaseScene('createSingle');
const createMultiScene = new BaseScene('createMulti');
const sendMessageScene = new BaseScene('sendMessage');

// Add Account Scene
addAccountScene.enter(async (ctx) => {
  await clearUserSession(ctx.from.id);
  await setUserSession(ctx.from.id, 'step', 'api_id');
  
  await ctx.reply(
    '📋 **Add Telegram User Account**\n\n' +
    '1. Go to https://my.telegram.org\n' +
    '2. Login with your phone number\n' +
    '3. Create an app to get API credentials\n\n' +
    'Please send your **API ID**:'
  );
});

addAccountScene.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  const step = session.step;
  const text = ctx.message.text.trim();

  switch (step) {
    case 'api_id':
      if (!/^\d+$/.test(text)) {
        await ctx.reply('❌ API ID must be a number. Try again:');
        return;
      }
      await setUserSession(userId, 'api_id', text);
      await setUserSession(userId, 'step', 'api_hash');
      await ctx.reply('✅ Got API ID. Now send your **API HASH**:');
      break;

    case 'api_hash':
      if (text.length < 10) {
        await ctx.reply('❌ Invalid API Hash. Try again:');
        return;
      }
      await setUserSession(userId, 'api_hash', text);
      await setUserSession(userId, 'step', 'phone');
      await ctx.reply(
        '✅ Got API Hash.\n\n' +
        'Now send your **Phone Number** in international format:\n' +
        'Example: +1234567890'
      );
      break;

    case 'phone':
      if (!/^\+[1-9]\d{1,14}$/.test(text)) {
        await ctx.reply(
          '❌ Invalid phone format. Use international format: +1234567890\n' +
          'Try again:'
        );
        return;
      }

      // Check if phone already exists
      const existingAccount = await UserAccount.findOne({ where: { phone: text } });
      if (existingAccount) {
        if (existingAccount.owner_user_id === userId || isAdmin(userId, getUsernameFromCtx(ctx))) {
          await ctx.reply(
            `✅ Phone number ${text} already exists in your accounts.\n` +
            'You can use it directly.'
          );
          return ctx.scene.leave();
        } else {
          await ctx.reply(
            `❌ Phone number ${text} already exists in database.\n` +
            'Use a different phone number.'
          );
          return ctx.scene.leave();
        }
      }

      await setUserSession(userId, 'phone', text);
      
      const sessionData = await getUserSession(userId);
      if (!sessionData.api_id || !sessionData.api_hash) {
        await ctx.reply('❌ Session expired. Start again with /addaccount');
        return ctx.scene.leave();
      }

      // Initialize UserAccountManager and send code
      const account = new UserAccountManager(
        text,
        sessionData.api_id,
        sessionData.api_hash
      );

      const codeResult = await account.sendCode();
      if (codeResult.success) {
        await setUserSession(userId, 'account', account);
        await setUserSession(userId, 'phoneCodeHash', codeResult.phoneCodeHash);
        await setUserSession(userId, 'step', 'code');
        
        await ctx.reply(
          '✅ Code sent to your Telegram app!\n\n' +
          'Please send the **verification code** you received:'
        );
      } else {
        await ctx.reply('❌ Failed to send code. Check phone number.');
        return ctx.scene.leave();
      }
      break;

    case 'code':
      if (!/^\d{5}$/.test(text)) {
        await ctx.reply('❌ Invalid code format. Send 5-digit code:');
        return;
      }

      const userSession = await getUserSession(userId);
      if (!userSession.account || !userSession.phoneCodeHash) {
        await ctx.reply('❌ Session expired. Start again.');
        return ctx.scene.leave();
      }

      const signInResult = await userSession.account.signIn(text, userSession.phoneCodeHash);
      
      if (signInResult.success) {
        // Save account to database
        const newAccount = await UserAccount.create({
          phone: userSession.phone,
          api_id: userSession.api_id,
          api_hash: userSession.api_hash,
          session_string: signInResult.session,
          is_active: true,
          owner_user_id: userId,
          owner_username: getUsernameFromCtx(ctx)
        });

        await clearUserSession(userId);
        await ctx.reply(
          '✅ **Account added successfully!**\n\n' +
          'This account can now create groups.\n' +
          'Use /creategroup to start.'
        );
        return ctx.scene.leave();
      } else if (signInResult.requires2FA) {
        await setUserSession(userId, 'step', 'password');
        await ctx.reply(
          '🔐 **Two-Factor Authentication Enabled**\n\n' +
          'Please send your 2FA password:'
        );
      } else {
        await ctx.reply('❌ Invalid code. Try /addaccount again.');
        return ctx.scene.leave();
      }
      break;

    case 'password':
      const sessionData2 = await getUserSession(userId);
      if (!sessionData2.account) {
        await ctx.reply('❌ Session expired. Start again.');
        return ctx.scene.leave();
      }

      const passwordResult = await sessionData2.account.signInWithPassword(text);
      
      if (passwordResult.success) {
        // Save account to database
        const newAccount = await UserAccount.create({
          phone: sessionData2.phone,
          api_id: sessionData2.api_id,
          api_hash: sessionData2.api_hash,
          session_string: passwordResult.session,
          is_active: true,
          owner_user_id: userId,
          owner_username: getUsernameFromCtx(ctx)
        });

        await clearUserSession(userId);
        await ctx.reply(
          '✅ **Account added successfully with 2FA!**\n\n' +
          'Use /creategroup to start creating groups.'
        );
        return ctx.scene.leave();
      } else {
        await ctx.reply('❌ Invalid password. Try /addaccount again.');
        return ctx.scene.leave();
      }
      break;
  }
});

addAccountScene.command('cancel', async (ctx) => {
  await clearUserSession(ctx.from.id);
  await ctx.reply('❌ Operation cancelled.');
  return ctx.scene.leave();
});

// Create Single Group Scene
createSingleScene.enter(async (ctx) => {
  const userId = ctx.from.id;
  const username = getUsernameFromCtx(ctx);
  
  let accounts;
  if (isAdmin(userId, username)) {
    accounts = await UserAccount.findAll({
      where: { is_active: true, is_banned: false }
    });
  } else {
    accounts = await UserAccount.findAll({
      where: { owner_user_id: userId, is_active: true, is_banned: false }
    });
  }

  if (!accounts.length) {
    await ctx.reply(
      '❌ No active accounts found.\n' +
      'Use /addaccount to add a Telegram user account first.'
    );
    return ctx.scene.leave();
  }

  await setUserSession(userId, 'accounts', accounts);
  await setUserSession(userId, 'mode', 'single');

  const keyboard = accounts.map((acc, i) => [
    Markup.button.callback(
      `${i + 1}. ${acc.phone}${isAdmin(acc.owner_user_id, acc.owner_username) ? ' 👑' : ''}`,
      `select_acc_${i}`
    )
  ]);

  keyboard.push([Markup.button.callback('❌ Cancel', 'cancel_selection')]);

  const adminNote = isAdmin(userId, username) ? ' (All accounts - Admin View)' : '';
  
  await ctx.reply(
    `📱 **Select Account for Group Creation**${adminNote}\n\n` +
    `Available accounts (${accounts.length}):`,
    Markup.inlineKeyboard(keyboard)
  );
});

createSingleScene.action(/select_acc_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const userId = ctx.from.id;
  const username = getUsernameFromCtx(ctx);
  const accIndex = parseInt(ctx.match[1]);
  
  const session = await getUserSession(userId);
  const accounts = session.accounts || [];
  
  if (accIndex >= accounts.length) {
    await ctx.editMessageText('❌ Invalid account selection.');
    return ctx.scene.leave();
  }
  
  const selectedAccount = accounts[accIndex];
  
  // Check ownership for non-admin users
  if (!isAdmin(userId, username) && selectedAccount.owner_user_id !== userId) {
    await ctx.editMessageText('❌ You don\'t have permission to use this account.');
    return ctx.scene.leave();
  }
  
  await setUserSession(userId, 'selected_account', selectedAccount);
  
  const groupName = generateGroupName();
  
  await ctx.editMessageText(
    `✅ Selected account: **${selectedAccount.phone}**\n\n` +
    `Creating group with auto-generated name...`
  );
  
  // Create the group
  try {
    const account = new UserAccountManager(
      selectedAccount.phone,
      selectedAccount.api_id,
      selectedAccount.api_hash
    );
    account.session_string = selectedAccount.session_string;
    
    const result = await account.createGroupWithFeatures(groupName);
    
    if (result.success) {
      // Update last used
      await selectedAccount.update({ last_used: new Date() });
      
      const keyboard = [
        [Markup.button.url('🔗 Open Group', result.invite_link)],
        [Markup.button.callback('📋 Copy Link', `copy_${result.invite_link}`)],
        [
          Markup.button.callback('📱 List Accounts', 'list_accounts'),
          Markup.button.callback('🚀 Create Another', 'create_another')
        ],
        [Markup.button.callback('🏠 Main Menu', 'main_menu')]
      ];
      
      await ctx.editMessageText(
        `✅ **Group Created Successfully!**\n\n` +
        `**Name:** ${groupName}\n` +
        `**ID:** ${result.chat_id}\n` +
        `**Account:** ${selectedAccount.phone}\n` +
        `**Features:**\n` +
        `• ✅ 'hello' message sent\n` +
        `• ✅ All permissions open\n` +
        `• ✅ Chat history visible\n\n` +
        `What would you like to do next?`,
        Markup.inlineKeyboard(keyboard)
      );
    } else {
      await ctx.editMessageText(`❌ Failed to create group: ${result.error || 'Unknown error'}`);
    }
    
    await account.disconnect();
  } catch (error) {
    logger.error('Error creating single group:', error);
    await ctx.editMessageText(`❌ Error creating group: ${error.message}`);
  }
  
  return ctx.scene.leave();
});

createSingleScene.action('cancel_selection', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('❌ Operation cancelled.');
  return ctx.scene.leave();
});

// Send Message Scene
sendMessageScene.enter(async (ctx) => {
  await ctx.reply(
    '📤 **Send Message to Your Self-Created Groups**\n\n' +
    'This feature will send a message to all groups/channels ' +
    'where you are the **CREATOR** (not just admin).\n\n' +
    '**Important:** Only sends to groups you created yourself.\n\n' +
    '**Please choose account type:**',
    Markup.inlineKeyboard([
      [Markup.button.callback('📱 Single Account', 'msg_single')],
      [Markup.button.callback('📱📱 Multiple Accounts', 'msg_multi')],
      [Markup.button.callback('❌ Cancel', 'cancel_selection')]
    ])
  );
});

sendMessageScene.action('msg_single', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('📱 **Select Account for Message Sending**\n\nChoose which account to use:');
  
  const userId = ctx.from.id;
  const username = getUsernameFromCtx(ctx);
  
  let accounts;
  if (isAdmin(userId, username)) {
    accounts = await UserAccount.findAll({
      where: { is_active: true, is_banned: false }
    });
  } else {
    accounts = await UserAccount.findAll({
      where: { owner_user_id: userId, is_active: true, is_banned: false }
    });
  }
  
  if (!accounts.length) {
    await ctx.editMessageText('❌ No active accounts found.');
    return ctx.scene.leave();
  }
  
  await setUserSession(userId, 'msg_mode', 'single');
  await setUserSession(userId, 'accounts', accounts);
  await setUserSession(userId, 'selected_msg_accounts', []);
  
  const keyboard = accounts.map((acc, i) => [
    Markup.button.callback(
      `${i + 1}. ${acc.phone}${isAdmin(acc.owner_user_id, acc.owner_username) ? ' 👑' : ''}`,
      `msg_acc_${i}`
    )
  ]);
  
  keyboard.push([Markup.button.callback('❌ Cancel', 'cancel_selection')]);
  
  const adminNote = isAdmin(userId, username) ? ' (All accounts - Admin View)' : '';
  
  await ctx.editMessageText(
    `📱 **Select Account for Message Sending**${adminNote}\n\n` +
    `Available accounts (${accounts.length}):`,
    Markup.inlineKeyboard(keyboard)
  );
});

sendMessageScene.action(/msg_acc_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const userId = ctx.from.id;
  const username = getUsernameFromCtx(ctx);
  const accIndex = parseInt(ctx.match[1]);
  
  const session = await getUserSession(userId);
  const accounts = session.accounts || [];
  
  if (accIndex >= accounts.length) {
    await ctx.editMessageText('❌ Invalid account selection.');
    return ctx.scene.leave();
  }
  
  const selectedAccount = accounts[accIndex];
  
  // Check ownership for non-admin users
  if (!isAdmin(userId, username) && selectedAccount.owner_user_id !== userId) {
    await ctx.editMessageText('❌ You don\'t have permission to use this account.');
    return ctx.scene.leave();
  }
  
  await setUserSession(userId, 'selected_msg_accounts', [selectedAccount]);
  
  await ctx.editMessageText(
    `✅ Selected account: **${selectedAccount.phone}**\n\n` +
    `Now send the **message text** you want to send to all self-created groups:`
  );
  
  // Set state to wait for message text
  await setUserSession(userId, 'step', 'get_message_text');
});

sendMessageScene.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = await getUserSession(userId);
  
  if (session.step === 'get_message_text') {
    const messageText = ctx.message.text.trim();
    
    if (!messageText) {
      await ctx.reply('❌ Message cannot be empty. Try again:');
      return;
    }
    
    const selectedAccounts = session.selected_msg_accounts || [];
    
    if (!selectedAccounts.length) {
      await ctx.reply('❌ No accounts selected. Start again.');
      return ctx.scene.leave();
    }
    
    // Start sending messages
    const statusMsg = await ctx.reply(
      `📤 **Sending Message to Self-Created Groups**\n\n` +
      `**Account:** ${selectedAccounts[0].phone}\n` +
      `**Message:** ${messageText.substring(0, 50)}...\n` +
      `**Target:** Only groups you created (you're creator)\n` +
      `**Status:** Checking your groups from Telegram...`
    );
    
    try {
      const account = new UserAccountManager(
        selectedAccounts[0].phone,
        selectedAccounts[0].api_id,
        selectedAccounts[0].api_hash
      );
      account.session_string = selectedAccounts[0].session_string;
      
      // Get self-created groups
      const groups = await account.getSelfCreatedGroups();
      
      if (!groups.length) {
        await ctx.editMessageText(
          `❌ No self-created groups found for account ${selectedAccounts[0].phone}.\n` +
          `This account didn't create any groups or you're not the creator.\n\n` +
          `Note: We only send to groups where you are the creator, not just admin.`
        );
        await account.disconnect();
        return ctx.scene.leave();
      }
      
      await ctx.editMessageText(
        `📤 **Sending Message to Self-Created Groups**\n\n` +
        `**Account:** ${selectedAccounts[0].phone}\n` +
        `**Message:** ${messageText.substring(0, 50)}...\n` +
        `**Target:** ${groups.length} groups (you're creator)\n` +
        `**Status:** Sending messages...\n\n` +
        `Progress: 0/${groups.length} (0%)`
      );
      
      // Send messages
      const results = await account.sendMessageToGroups(groups, messageText);
      
      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;
      
      // Update account last used
      await selectedAccounts[0].update({ last_used: new Date() });
      
      const successRate = groups.length > 0 ? (successCount / groups.length) * 100 : 0;
      
      const keyboard = [
        [
          Markup.button.callback('📱 List Accounts', 'list_accounts'),
          Markup.button.callback('📤 Send Another', 'send_another')
        ],
        [Markup.button.callback('🏠 Main Menu', 'main_menu')]
      ];
      
      await ctx.editMessageText(
        `✅ **Message Sending Complete!**\n\n` +
        `**Account:** ${selectedAccounts[0].phone}\n` +
        `**Self-created groups found:** ${groups.length}\n` +
        `**✅ Success:** ${successCount}\n` +
        `**❌ Failed:** ${failedCount}\n` +
        `**Success Rate:** ${successRate.toFixed(1)}%\n\n` +
        `**Note:** Messages sent only to groups where you're the creator.\n\n` +
        `**Message:** ${messageText.substring(0, 100)}...`,
        Markup.inlineKeyboard(keyboard)
      );
      
      await account.disconnect();
    } catch (error) {
      logger.error('Error sending messages:', error);
      await ctx.editMessageText(`❌ **Failed to send messages**\n\nError: ${error.message}`);
    }
    
    return ctx.scene.leave();
  }
});

sendMessageScene.action('cancel_selection', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('❌ Operation cancelled.');
  return ctx.scene.leave();
});

// Initialize bot
const bot = new Telegraf(BOT_TOKEN);

// Session middleware
bot.use(session());
bot.use(async (ctx, next) => {
  // Store user info in session
  if (ctx.from) {
    ctx.session.userId = ctx.from.id;
    ctx.session.username = ctx.from.username;
    
    // Register admin if applicable
    if (ctx.from.username && ADMIN_USERNAMES.includes(ctx.from.username.toLowerCase())) {
      ADMIN_USER_IDS.add(ctx.from.id);
    }
  }
  await next();
});

// Stage for scenes
const stage = new Stage([
  addAccountScene,
  createSingleScene,
  createBulkScene,
  createMultiScene,
  sendMessageScene
]);

bot.use(stage.middleware());

// Start command
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  
  // Register admin if applicable
  if (username && ADMIN_USERNAMES.includes(username.toLowerCase())) {
    ADMIN_USER_IDS.add(userId);
    logger.info(`Admin user registered: ${username} (ID: ${userId})`);
  }
  
  const adminBadge = isAdmin(userId, username) ? ' 👑' : '';
  
  let message = `🤖 **Auto Group Creator Bot**${adminBadge}\n\n` +
    `**Available commands:**\n` +
    `/addaccount - Add Telegram user account\n` +
    `/creategroup - Create single group (choose account)\n` +
    `/createbulk - Create multiple groups (choose account)\n` +
    `/createmulti - Create groups for multiple/all accounts\n` +
    `/quickcreate - Quick single group (auto-select account)\n` +
    `/listaccounts - List your accounts\n` +
    `/cleanup - Cleanup old sessions\n` +
    `/sendmessage - Send message to your self-created groups\n` +
    `/stats - Show statistics\n` +
    `/cancel - Cancel current operation\n`;
  
  if (isAdmin(userId, username)) {
    message += `/admin - Admin panel\n\n`;
  }
  
  message += `**Features:**\n` +
    `• Create 50+ groups automatically\n` +
    `• 5-second intervals between creations\n` +
    `• Auto-generated group names\n` +
    `• 'hello' welcome message\n` +
    `• Open all permissions\n` +
    `• Chat history visible\n` +
    `• Account selection menu\n` +
    `• NEW: Send messages to your self-created groups\n\n` +
    `⚠️ **Note**: You need a Telegram user account (not bot) ` +
    `with API credentials from https://my.telegram.org`;
  
  await ctx.reply(message);
});

// Quick create command
bot.command('quickcreate', async (ctx) => {
  const userId = ctx.from.id;
  const username = getUsernameFromCtx(ctx);
  
  let account;
  if (isAdmin(userId, username)) {
    account = await UserAccount.findOne({
      where: { is_active: true, is_banned: false },
      order: [['last_used', 'ASC']]
    });
  } else {
    account = await UserAccount.findOne({
      where: { owner_user_id: userId, is_active: true, is_banned: false },
      order: [['last_used', 'ASC']]
    });
  }
  
  if (!account) {
    await ctx.reply(
      '❌ No active accounts found.\n' +
      'Use /addaccount to add a Telegram user account first.'
    );
    return;
  }
  
  const groupName = generateGroupName();
  
  const statusMsg = await ctx.reply(
    `⚡ **Quick Group Creation**\n\n` +
    `**Account:** ${account.phone}\n` +
    `**Group:** ${groupName}\n` +
    `**Features:** 'hello' + Open permissions\n` +
    `**Status:** Creating...`
  );
  
  try {
    const userAccount = new UserAccountManager(account.phone, account.api_id, account.api_hash);
    userAccount.session_string = account.session_string;
    
    const result = await userAccount.createGroupWithFeatures(groupName);
    
    if (result.success) {
      await account.update({ last_used: new Date() });
      
      const keyboard = [
        [Markup.button.url('🔗 Open Group', result.invite_link)],
        [Markup.button.callback('📋 Copy Link', `copy_${result.invite_link}`)],
        [Markup.button.callback('🏠 Main Menu', 'main_menu')]
      ];
      
      await ctx.telegram.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        null,
        `✅ **Group Created Successfully!**\n\n` +
        `**Name:** ${groupName}\n` +
        `**ID:** ${result.chat_id}\n` +
        `**Account:** ${account.phone}\n` +
        `**Features:** ✅ 'hello' message + Open permissions`,
        { reply_markup: Markup.inlineKeyboard(keyboard).reply_markup }
      );
    } else {
      await ctx.telegram.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        null,
        `❌ Failed to create group: ${result.error || 'Unknown error'}`
      );
    }
    
    await userAccount.disconnect();
  } catch (error) {
    await ctx.telegram.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      null,
      `❌ Error: ${error.message}`
    );
  }
});

// List accounts command
bot.command('listaccounts', async (ctx) => {
  const userId = ctx.from.id;
  const username = getUsernameFromCtx(ctx);
  
  let accounts;
  if (isAdmin(userId, username)) {
    accounts = await UserAccount.findAll({
      order: [
        ['owner_user_id', 'ASC'],
        ['is_active', 'DESC'],
        ['last_used', 'DESC']
      ]
    });
  } else {
    accounts = await UserAccount.findAll({
      where: { owner_user_id: userId },
      order: [
        ['is_active', 'DESC'],
        ['last_used', 'DESC']
      ]
    });
  }
  
  if (!accounts.length) {
    await ctx.reply('No accounts added yet. Use /addaccount');
    return;
  }
  
  let text;
  if (isAdmin(userId, username)) {
    text = '📱 **All User Accounts (Admin View)** 👑\n\n';
    const accountsByOwner = {};
    
    for (const acc of accounts) {
      const ownerId = acc.owner_user_id;
      if (!accountsByOwner[ownerId]) {
        accountsByOwner[ownerId] = [];
      }
      accountsByOwner[ownerId].push(acc);
    }
    
    for (const [ownerId, ownerAccounts] of Object.entries(accountsByOwner)) {
      text += `👤 **User ID:** ${ownerId}\n`;
      if (ownerAccounts[0].owner_username) {
        text += `👤 **Username:** @${ownerAccounts[0].owner_username}\n`;
      }
      
      for (const [i, acc] of ownerAccounts.entries()) {
        const status = acc.is_active ? '🟢 Active' : '🔴 Inactive';
        const banned = acc.is_banned ? '🚫 Banned' : '';
        
        text += `  ${i + 1}. **${acc.phone}**\n`;
        text += `     Status: ${status} ${banned}\n`;
        text += `     Last used: ${acc.last_used ? acc.last_used.toLocaleString() : 'Never'}\n`;
        text += `     Added: ${acc.created_at.toLocaleDateString()}\n\n`;
      }
      
      text += '\n';
    }
  } else {
    text = '📱 **Your Accounts:**\n\n';
    for (const [i, acc] of accounts.entries()) {
      const status = acc.is_active ? '🟢 Active' : '🔴 Inactive';
      const banned = acc.is_banned ? '🚫 Banned' : '';
      
      text += `**${i + 1}. ${acc.phone}**\n`;
      text += `   Status: ${status} ${banned}\n`;
      text += `   Last used: ${acc.last_used ? acc.last_used.toLocaleString() : 'Never'}\n`;
      text += `   Added: ${acc.created_at.toLocaleDateString()}\n\n`;
    }
  }
  
  await ctx.reply(text);
});

// Stats command
bot.command('stats', async (ctx) => {
  const userId = ctx.from.id;
  const username = getUsernameFromCtx(ctx);
  
  const totalAccounts = await UserAccount.count();
  const activeAccounts = await UserAccount.count({ where: { is_active: true } });
  const bannedAccounts = await UserAccount.count({ where: { is_banned: true } });
  const uniqueUsers = await UserAccount.aggregate('owner_user_id', 'DISTINCT', { plain: false });
  
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentAccounts = await UserAccount.count({
    where: {
      last_used: {
        [Sequelize.Op.gte]: dayAgo
      }
    }
  });
  
  let text = '📊 **Bot Statistics**\n\n';
  text += `**Total Accounts:** ${totalAccounts}\n`;
  text += `**Active Accounts:** ${activeAccounts}\n`;
  text += `**Banned Accounts:** ${bannedAccounts}\n`;
  text += `**Unique Users:** ${uniqueUsers.length}\n`;
  text += `**Active in last 24h:** ${recentAccounts}\n`;
  
  if (isAdmin(userId, username)) {
    text += `\n**Admin Users:** ${ADMIN_USER_IDS.size}\n`;
    text += `**Admin Usernames:** ${ADMIN_USERNAMES.map(u => '@' + u).join(', ')}\n`;
  }
  
  await ctx.reply(text);
});

// Cleanup command
bot.command('cleanup', async (ctx) => {
  const userId = ctx.from.id;
  const username = getUsernameFromCtx(ctx);
  
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  let whereClause;
  if (isAdmin(userId, username)) {
    whereClause = {
      last_used: { [Sequelize.Op.lt]: weekAgo },
      is_active: true
    };
  } else {
    whereClause = {
      owner_user_id: userId,
      last_used: { [Sequelize.Op.lt]: weekAgo },
      is_active: true
    };
  }
  
  const oldAccounts = await UserAccount.findAll({ where: whereClause });
  const deactivated = oldAccounts.length;
  
  for (const account of oldAccounts) {
    await account.update({ is_active: false });
  }
  
  if (isAdmin(userId, username)) {
    await ctx.reply(
      `🧹 **Admin Cleanup Completed!** 👑\n` +
      `Deactivated ${deactivated} inactive accounts (not used in 7 days).`
    );
  } else {
    await ctx.reply(
      `🧹 Cleanup completed!\n` +
      `Deactivated ${deactivated} of your inactive accounts (not used in 7 days).`
    );
  }
});

// Admin command
bot.command('admin', async (ctx) => {
  const userId = ctx.from.id;
  const username = getUsernameFromCtx(ctx);
  
  if (!isAdmin(userId, username)) {
    await ctx.reply('❌ This command is only for administrators.');
    return;
  }
  
  const keyboard = [
    [Markup.button.callback('📊 System Stats', 'admin_stats')],
    [Markup.button.callback('👥 List All Users', 'admin_list_users')],
    [Markup.button.callback('📱 List All Accounts', 'admin_list_all_accounts')],
    [Markup.button.callback('🔄 Activate/Deactivate', 'admin_toggle_account')],
    [Markup.button.callback('🚫 Ban/Unban Account', 'admin_ban_account')],
    [Markup.button.callback('🗑️ Delete Account', 'admin_delete_account')],
    [Markup.button.callback('🏠 Main Menu', 'main_menu')]
  ];
  
  await ctx.reply(
    '👑 **Admin Panel**\n\n' +
    'Select an option:',
    Markup.inlineKeyboard(keyboard)
  );
});

// Scene entry commands
bot.command('addaccount', (ctx) => ctx.scene.enter('addAccount'));
bot.command('creategroup', (ctx) => ctx.scene.enter('createSingle'));
bot.command('sendmessage', (ctx) => ctx.scene.enter('sendMessage'));

// Cancel command
bot.command('cancel', async (ctx) => {
  await clearUserSession(ctx.from.id);
  await ctx.reply('❌ Operation cancelled.');
  if (ctx.scene) {
    await ctx.scene.leave();
  }
});

// Button handler
bot.action(/copy_(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const link = ctx.match[1];
  await ctx.editMessageText(
    `📋 **Invite Link:**\n\n\`${link}\`\n\n` +
    'Copy and share this link!'
  );
});

bot.action('list_accounts', async (ctx) => {
  await ctx.answerCbQuery();
  // Simulate listaccounts command
  const userId = ctx.from.id;
  const username = ctx.from.username;
  
  let accounts;
  if (isAdmin(userId, username)) {
    accounts = await UserAccount.findAll({
      order: [
        ['owner_user_id', 'ASC'],
        ['is_active', 'DESC'],
        ['last_used', 'DESC']
      ]
    });
  } else {
    accounts = await UserAccount.findAll({
      where: { owner_user_id: userId },
      order: [
        ['is_active', 'DESC'],
        ['last_used', 'DESC']
      ]
    });
  }
  
  if (!accounts.length) {
    await ctx.editMessageText('No accounts added yet. Use /addaccount');
    return;
  }
  
  let text;
  if (isAdmin(userId, username)) {
    text = '📱 **All User Accounts (Admin View)** 👑\n\n';
    const accountsByOwner = {};
    
    for (const acc of accounts) {
      const ownerId = acc.owner_user_id;
      if (!accountsByOwner[ownerId]) {
        accountsByOwner[ownerId] = [];
      }
      accountsByOwner[ownerId].push(acc);
    }
    
    for (const [ownerId, ownerAccounts] of Object.entries(accountsByOwner)) {
      text += `👤 **User ID:** ${ownerId}\n`;
      if (ownerAccounts[0].owner_username) {
        text += `👤 **Username:** @${ownerAccounts[0].owner_username}\n`;
      }
      
      for (const [i, acc] of ownerAccounts.entries()) {
        const status = acc.is_active ? '🟢 Active' : '🔴 Inactive';
        const banned = acc.is_banned ? '🚫 Banned' : '';
        
        text += `  ${i + 1}. **${acc.phone}**\n`;
        text += `     Status: ${status} ${banned}\n`;
        text += `     Last used: ${acc.last_used ? acc.last_used.toLocaleString() : 'Never'}\n`;
        text += `     Added: ${acc.created_at.toLocaleDateString()}\n\n`;
      }
      
      text += '\n';
    }
  } else {
    text = '📱 **Your Accounts:**\n\n';
    for (const [i, acc] of accounts.entries()) {
      const status = acc.is_active ? '🟢 Active' : '🔴 Inactive';
      const banned = acc.is_banned ? '🚫 Banned' : '';
      
      text += `**${i + 1}. ${acc.phone}**\n`;
      text += `   Status: ${status} ${banned}\n`;
      text += `   Last used: ${acc.last_used ? acc.last_used.toLocaleString() : 'Never'}\n`;
      text += `   Added: ${acc.created_at.toLocaleDateString()}\n\n`;
    }
  }
  
  await ctx.editMessageText(text);
});

bot.action('create_another', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🚀 **Create Another Group**\n\n' +
    'Use the command: `/creategroup`'
  );
});

bot.action('send_another', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '📤 **Send Another Message**\n\n' +
    'Use the command: `/sendmessage`'
  );
});

bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🏠 **Main Menu**\n\n' +
    'Use the command: `/start`'
  );
});

bot.action('admin_stats', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const username = ctx.from.username;
  
  if (!isAdmin(userId, username)) {
    await ctx.answerCbQuery('Admin only!', { show_alert: true });
    return;
  }
  
  const totalAccounts = await UserAccount.count();
  const activeAccounts = await UserAccount.count({ where: { is_active: true } });
  const bannedAccounts = await UserAccount.count({ where: { is_banned: true } });
  const uniqueUsers = await UserAccount.aggregate('owner_user_id', 'DISTINCT', { plain: false });
  
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentAccounts = await UserAccount.count({
    where: {
      last_used: {
        [Sequelize.Op.gte]: dayAgo
      }
    }
  });
  
  let text = '📊 **Bot Statistics**\n\n';
  text += `**Total Accounts:** ${totalAccounts}\n`;
  text += `**Active Accounts:** ${activeAccounts}\n`;
  text += `**Banned Accounts:** ${bannedAccounts}\n`;
  text += `**Unique Users:** ${uniqueUsers.length}\n`;
  text += `**Active in last 24h:** ${recentAccounts}\n`;
  text += `\n**Admin Users:** ${ADMIN_USER_IDS.size}\n`;
  text += `**Admin Usernames:** ${ADMIN_USERNAMES.map(u => '@' + u).join(', ')}\n`;
  
  await ctx.editMessageText(text);
});

// Error handling
bot.catch((err, ctx) => {
  logger.error(`Error for ${ctx.updateType}:`, err);
  
  if (ctx.message) {
    ctx.reply('❌ An error occurred. Please try again.');
  }
});

// Health check endpoint
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Telegram Group Bot',
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Start bot
async function start() {
  try {
    // Initialize database
    await initDatabase();
    
    // Start web server for health checks
    app.listen(PORT, () => {
      logger.info(`Web server listening on port ${PORT}`);
    });
    
    // Launch bot
    await bot.launch();
    
    logger.info('🤖 Bot is running... Press Ctrl+C to stop');
    logger.info(`📊 Database initialized successfully`);
    logger.info(`👑 Admin users: ${ADMIN_USERNAMES.join(', ')}`);
    logger.info(`🎯 Features Available:`);
    logger.info(`   • Concurrent user handling`);
    logger.info(`   • User account isolation`);
    logger.info(`   • Admin controls for @${ADMIN_USERNAMES[0]}`);
    logger.info(`   • Welcome message: 'hello'`);
    logger.info(`   • Open all permissions`);
    logger.info(`   • Blank group descriptions`);
    logger.info(`   • 5-second intervals for bulk creation`);
    logger.info(`   • Send messages to self-created groups (creator only)`);
    
    // Enable graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    
  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  start();
}

module.exports = {
  bot,
  start,
  UserAccount,
  CreatedGroup,
  UserAccountManager
};
