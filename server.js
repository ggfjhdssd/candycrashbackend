const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { Server } = require('socket.io');
const http = require('http');
const mongoose = require('mongoose');
const crypto = require('crypto');
const https = require('https');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-id,x-telegram-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ─── Static asset serving with correct MIME types ───────────────
const path = require('path');
const mimeMap = { '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.png':'image/png', '.jpg':'image/jpeg' };
function setMimeHeaders(res, filePath) {
  const ext = require('path').extname(filePath).toLowerCase();
  const mime = mimeMap[ext];
  if (mime) {
    res.setHeader('Content-Type', mime);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}
app.use('/audio', express.static(path.join(__dirname, 'audio'), { setHeaders: setMimeHeaders }));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { setHeaders: setMimeHeaders }));
// ────────────────────────────────────────────────────────────────



    onlineResults.forEach(r => { if (r.status==='fulfilled' && r.value) sent.push(r.value); });
    setImmediate(async () => {
      const CHUNK = 25;
      for (let i=0;i<offlineUsers.length;i+=CHUNK) {
        if (!waitingQueue.find(w=>w.gameId===gameId)) break;
        const batch = offlineUsers.slice(i,i+CHUNK);
        await Promise.allSettled(batch.map(async u => {
          try { const msg = await bot.telegram.sendMessage(u.telegramId, msgText, {parse_mode:'HTML',reply_markup:replyMarkup}); sent.push({userId:u.telegramId,msgId:msg.message_id}); } catch(e){}
        }));
        if (i+CHUNK<offlineUsers.length) await new Promise(r=>setTimeout(r,50));
      }
    });
    searchNotifications.set(gameId, sent);
  } catch(e){ console.error('notify err:', e.stack || e); }
}

async function deleteSearchMsgs(gameId) {
  if (!bot) return;
  const msgs = searchNotifications.get(gameId);
  if (!msgs) return;
  searchNotifications.delete(gameId);
  for (const {userId, msgId} of msgs) {
    try { await bot.telegram.deleteMessage(userId, msgId); await new Promise(r=>setTimeout(r,30)); } catch(e){}
  }
}

async function sendFakeSearchNotification() {
  if (!bot) return;
  const fakeEnabled = await getSetting('fakeNotifications', false);
  if (!fakeEnabled) return;
  const fakeGameId = genGameId();
  fakeGameIds.add(fakeGameId);
  const fakeName = randomAIName();
  const displayName = obfuscateUsername(fakeName);
  const allFakeUsers = await User.find({ isBanned: { $ne: true } }).select('telegramId lastActive').lean();
  const fakeOnline  = allFakeUsers.filter(u => userSockets.has(u.telegramId));
  const fakeOffline = allFakeUsers.filter(u => !userSockets.has(u.telegramId)).sort((a,b)=>(b.lastActive||0)-(a.lastActive||0));
  const users = [...fakeOnline, ...fakeOffline];
  const sent = [];
  const CHUNK = 30;
  const fakeMsgText = `🍭 <b>${displayName}</b> ပွဲရှာနေသည်!\n\n⏱ ${SEARCH_TIMEOUT_S} စက္ကန့်အတွင်း Join မနှိပ်ရင် ပွဲပျောက်မည်\n💰 ဝင်ကြေး: ${ENTRY_FEE.toLocaleString()} MMK  •  🏆 ဆု: ${WIN_PRIZE.toLocaleString()} MMK`;
  for (let i=0;i<users.length;i+=CHUNK) {
    const batch = users.slice(i,i+CHUNK);
    await Promise.allSettled(batch.map(async u => {
      try { const msg = await bot.telegram.sendMessage(u.telegramId, fakeMsgText, {parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🍭 ကစားမည်',callback_data:`join_${fakeGameId}`},{text:'❌ မကစားဘူး',callback_data:'dismiss'}]]}}); sent.push({userId:u.telegramId,msgId:msg.message_id}); } catch(e){}
    }));
    if (i+CHUNK<users.length) await new Promise(r=>setTimeout(r,100));
  }
  searchNotifications.set(fakeGameId, sent);
  setTimeout(() => deleteSearchMsgs(fakeGameId), 3600000);
}

// ===== Zombie cleanup =====
setInterval(async () => {
  const now = Date.now();
  const IDLE_LIMIT_MS = (GAME_DURATION_S + 60) * 1000;
  for (const [gameId, game] of activeGames.entries()) {
    if (game.status !== 'active') continue;
    const lastMove = game.lastMoveAt || game.startedAt || 0;
    if (now - lastMove < IDLE_LIMIT_MS) continue;
    console.log(`🧹 Zombie game cleanup: ${gameId}`);
    try {
      if (game.isAIGame) {
        await endCandyGameAI(gameId, -1, 'timeout');
      } else {
        for (const pid of (game.players || [])) {
          await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:ENTRY_FEE}}).catch(()=>{});
        }
        io.to(gameId).emit('gameOver', { winner: -1, reason: 'timeout', scores: game.scores || {} });
        activeGames.delete(gameId);
        clearTurnTimer(gameId);
        for (const pid of (game.players || [])) {
          const t = searchTimeouts.get(pid); if (t) { clearTimeout(t); searchTimeouts.delete(pid); }
        }
        setTimeout(()=>deleteSearchMsgs(gameId),500);
      }
    } catch(e) { console.error('Zombie cleanup err:', e); }
  }
}, 5 * 60 * 1000);

let fakeNotifTimer = null;
async function scheduleFakeNotification() {
  if (fakeNotifTimer) { clearTimeout(fakeNotifTimer); fakeNotifTimer = null; }
  const intervalMins = await getSetting('fakeNotifInterval', 3);
  const delay = Math.max(1, Number(intervalMins)) * 60 * 1000;
  fakeNotifTimer = setTimeout(async () => {
    await sendFakeSearchNotification();
    scheduleFakeNotification();
  }, delay);
}
scheduleFakeNotification();

// ===== Game Timer Helper =====
function clearTurnTimer(gameId) {
  const t = gameTurnTimeouts.get(gameId);
  if (t) { clearTimeout(t); gameTurnTimeouts.delete(gameId); }
}

// ★ ===== End PvP Game (score-based) =====
async function endGame(gameId, winner, reason='timeup') {
  const game = activeGames.get(gameId);
  if (!game || (game.status !== 'active' && game.status !== 'ending')) return;
  clearTurnTimer(gameId);
  game.status = 'completed';
  const winnerId = winner === -1 ? -1 : Number(winner);

  try {
    if (winnerId === -1) {
      for (const pid of game.players) {
        await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:DRAW_REFUND,totalGames:1}});
      }
    } else if (winnerId) {
      const loser = game.players.find(p => Number(p) !== winnerId);
      await User.findOneAndUpdate({telegramId:winnerId},{$inc:{balance:WIN_PRIZE,wins:1,totalGames:1}});
      if (loser) await User.findOneAndUpdate({telegramId:loser},{$inc:{losses:1,totalGames:1}});
    }
    await Game.findOneAndUpdate({gameId},{
      winner: winnerId, status:'completed',
      scores: game.scores,
      playerNames: game.playerNames,
      winnerName: winnerId===-1 ? 'draw' : (game.playerNames?.[winnerId] || String(winnerId)),
      isAIGame: !!game.isAIGame
    },{upsert:true});
  } catch(e){ console.error('endGame err:', e.stack || e); }

  io.to(gameId).emit('gameOver', {
    winner: winnerId,
    reason,
    scores: game.scores
  });

  activeGames.delete(gameId);
  clearTurnTimer(gameId);
  for (const pid of (game.players || [])) {
    const t = searchTimeouts.get(pid);
    if (t) { clearTimeout(t); searchTimeouts.delete(pid); }
    moveCooldowns.delete(pid);
    findGameCooldowns.delete(pid);
    processingUsers.delete(pid);
  }
  setTimeout(()=>deleteSearchMsgs(gameId),500);
}

// ===== Socket =====
io.on('connection', (socket) => {
  let myUserId = null;
  let myGameId = null;

  socket.on('findGame', async ({userId}) => {
    if (!userId) return socket.emit('error',{msg:'userId မပါ'});
    myUserId = parseInt(userId);

    const lastFG = findGameCooldowns.get(myUserId) || 0;
    if (Date.now() - lastFG < FINDGAME_COOLDOWN_MS) return socket.emit('error',{msg:'နည်းနည်းစောင့်ပါ...'});
    findGameCooldowns.set(myUserId, Date.now());

    if (processingUsers.has(myUserId)) return socket.emit('error',{msg:'ရှာဖွေနေဆဲ ဖြစ်သည်'});
    processingUsers.add(myUserId);

    try {
      userSockets.set(myUserId, socket.id);

      const existEntry = [...activeGames.entries()].find(([,g])=>g.players.includes(myUserId));
      if (existEntry) {
        const [gid, game] = existEntry;
        myGameId = gid;
        socket.join(gid);
        const oppId = game.players.find(p => p !== myUserId);
        socket.emit('gameResumed',{
          gameId: gid,
          duration: GAME_DURATION_S,
          players: game.playerNames,
          myId: myUserId,
          opponentId: oppId,
          myScore: game.scores[myUserId] || 0,
          opponentScore: game.scores[oppId] || 0,
          elapsedMs: Date.now() - game.startedAt
        });
        return;
      }

      const user = await User.findOne({telegramId:myUserId}).lean();
      if (!user) return socket.emit('error',{msg:'User မတွေ့ပါ'});
      if (user.isBanned===true) return socket.emit('error',{msg:'ကောင်ပိတ်ဆို့ထားသည်'});
      if (user.balance < ENTRY_FEE) return socket.emit('insufficientBalance',{balance:user.balance,required:ENTRY_FEE});

      User.findOneAndUpdate({telegramId:myUserId},{lastActive:new Date()}).catch(()=>{});

      const allBotMode = await getSetting('allBotMode', false);
      const joinGameId = socket.handshake.query?.join;

      if (joinGameId && fakeGameIds.has(joinGameId)) {
        if (allBotMode) {
          const gameId = genGameId(); myGameId = gameId;
          const uName = user.firstName || user.username || `User${myUserId}`;
          await startCandyAIGame(socket, myUserId, gameId, uName);
          await deleteSearchMsgs(joinGameId); return;
        } else {
          deleteSearchMsgs(joinGameId); fakeGameIds.delete(joinGameId);
        }
      }

      if (allBotMode) {
        const gameId = genGameId(); myGameId = gameId;
        const uName = user.firstName || user.username || `User${myUserId}`;
        await startCandyAIGame(socket, myUserId, gameId, uName); return;
      }

      if (user.botMode && allBotMode) {
        const gameId = genGameId(); myGameId = gameId;
        const uName = user.firstName || user.username || `User${myUserId}`;
        await startCandyAIGame(socket, myUserId, gameId, uName); return;
      }

      // Normal matchmaking
      let waiterIdx = -1;
      if (joinGameId) waiterIdx = waitingQueue.findIndex(w=>w.gameId===joinGameId && w.userId!==myUserId);
      if (waiterIdx === -1) waiterIdx = waitingQueue.findIndex(w=>w.userId!==myUserId);

      if (waiterIdx !== -1) {
        const waiter = waitingQueue.splice(waiterIdx,1)[0];
        myGameId = waiter.gameId;

        const timeout = searchTimeouts.get(myUserId);
        if (timeout) { clearTimeout(timeout); searchTimeouts.delete(myUserId); }

        try {
          const [w1, w2] = await Promise.all([
            User.findOneAndUpdate({telegramId:waiter.userId,balance:{$gte:ENTRY_FEE}},{$inc:{balance:-ENTRY_FEE}},{new:true}),
            User.findOneAndUpdate({telegramId:myUserId,balance:{$gte:ENTRY_FEE}},{$inc:{balance:-ENTRY_FEE}},{new:true})
          ]);
          if (!w1||!w2) {
            await Promise.all([
              w1 ? User.findOneAndUpdate({telegramId:waiter.userId},{$inc:{balance:ENTRY_FEE}}) : Promise.resolve(),
              w2 ? User.findOneAndUpdate({telegramId:myUserId},{$inc:{balance:ENTRY_FEE}}) : Promise.resolve()
            ]);
            if (!w1) {
              const waiterSockId = userSockets.get(waiter.userId);
              const waiterSock = waiterSockId ? io.sockets.sockets.get(waiterSockId) : null;
              const wUser = await User.findOne({telegramId:waiter.userId}).select('balance').lean();
              if (waiterSock) waiterSock.emit('insufficientBalance',{balance:wUser?.balance||0,required:ENTRY_FEE});
            } else { waitingQueue.push(waiter); }
            if (!w2) {
              const jUser = await User.findOne({telegramId:myUserId}).select('balance').lean();
              return socket.emit('insufficientBalance',{balance:jUser?.balance||0,required:ENTRY_FEE});
            }
            return;
          }
        } catch(e) { waitingQueue.push(waiter); return socket.emit('error',{msg:'ငွေ ဆုတ်ယူ မအောင်မြင်ပါ'}); }

        const waiterUser = await User.findOne({telegramId:waiter.userId}).lean();
        const joinerUser = user;

        // ★ Candy crush game state (score-based, no board/symbols)
        const gameState = {
          gameId: myGameId, players: [waiter.userId, myUserId],
          scores: { [waiter.userId]: 0, [myUserId]: 0 },
          status: 'active',
          startedAt: Date.now(), lastMoveAt: Date.now(),
          playerNames: {
            [waiter.userId]: waiterUser?.firstName||waiterUser?.username||`User${waiter.userId}`,
            [myUserId]: joinerUser?.firstName||joinerUser?.username||`User${myUserId}`
          }
        };
        activeGames.set(myGameId, gameState);
        new Game({gameId:myGameId, players:gameState.players, status:'active'}).save().catch(e=>console.error('Game save:',e));

        socket.join(myGameId);
        const waiterSocket = io.sockets.sockets.get(waiter.socketId);
        if (waiterSocket) waiterSocket.join(myGameId);

        // ★ Emit gameStarted with duration (no symbols/board)
        const basePayload = {
          gameId: myGameId,
          duration: GAME_DURATION_S,
          players: gameState.playerNames
        };
        socket.emit('gameStarted', {...basePayload, myId: myUserId, opponentId: waiter.userId, opponentName: gameState.playerNames[waiter.userId]});
        if (waiterSocket) waiterSocket.emit('gameStarted', {...basePayload, myId: waiter.userId, opponentId: myUserId, opponentName: gameState.playerNames[myUserId]});

        await deleteSearchMsgs(myGameId);

        // ★ Start 3-minute game timer
        const t = setTimeout(() => endGameByTime(myGameId), GAME_DURATION_S * 1000 + 2000);
        gameTurnTimeouts.set(myGameId, t);

      } else {
        const gameId = genGameId();
        myGameId = gameId;
        socket.join(gameId);
        waitingQueue.push({socketId:socket.id, userId:myUserId, gameId});
        socket.emit('waitingForPlayer',{gameId, searchTimeout:SEARCH_TIMEOUT_S});
        notifyUsersGameSearch(myUserId, gameId);

        const timeout = setTimeout(() => {
          if (socket.connected) socket.emit('searchUpdate',{message:'လက်ရှိဆော့ကစားနေသူမရှိသေးပါ ဆက်လက်ရှာဖွေဖို့'});
        }, SEARCH_TIMEOUT_S * 1000);
        searchTimeouts.set(myUserId, timeout);
      }
    } catch(e) {
      console.error('findGame err:', e);
      socket.emit('error',{msg:'ဆာဗာ error ဖြစ်သည်'});
    } finally {
      processingUsers.delete(myUserId);
    }
  });

  // ★ ===== Score Update (replaces makeMove for Candy Crush) =====
  socket.on('scoreUpdate', async ({gameId, score}) => {
    const lastMove = moveCooldowns.get(myUserId) || 0;
    if (Date.now() - lastMove < MOVE_COOLDOWN_MS) return;
    moveCooldowns.set(myUserId, Date.now());

    try {
      const game = activeGames.get(gameId);
      if (!game || game.status !== 'active') return;
      if (!game.players.includes(myUserId)) return;

      const prevScore = game.scores[myUserId] || 0;
      const newScore = Math.max(prevScore, parseInt(score) || 0);

      // ★ Sabotage check for AI games: if user would overtake AI, trigger disconnect
      if (game.isAIGame && game.aiType === AI_TYPE_SABOTAGE) {
        const aiScore = game.scores[AI_ID] || 0;
        // If user's new score would beat AI by >200 pts, trigger sabotage
        if (newScore > aiScore + 200) {
          game.status = 'ending';
          await handleSabotage(game, myUserId);
          return;
        }
      }

      game.scores[myUserId] = newScore;
      game.lastMoveAt = Date.now();

      // Broadcast to opponent
      const opponent = game.players.find(p => p !== myUserId);
      if (opponent && opponent !== AI_ID) {
        const oppSockId = userSockets.get(opponent);
        const oppSock = oppSockId ? io.sockets.sockets.get(oppSockId) : null;
        if (oppSock) {
          oppSock.emit('opponentScore', { score: newScore, playerId: myUserId });
        }
      }
    } catch(e) { console.error('scoreUpdate err:', e); }
  });

  // ★ End game by time (server-side timer fires)
  async function endGameByTime(gameId) {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'active') return;

    const [p1, p2] = game.players;
    const s1 = game.scores[p1] || 0;
    const s2 = game.scores[p2] || 0;
    let winner;
    if (s1 > s2) winner = p1;
    else if (s2 > s1) winner = p2;
    else winner = -1;

    await endGame(gameId, winner, 'timeup');
  }

  socket.on('cancelSearch', async ({userId}) => {
    const uid = parseInt(userId||myUserId);
    const idx = waitingQueue.findIndex(w=>w.userId===uid);
    if (idx!==-1) { const {gameId} = waitingQueue[idx]; waitingQueue.splice(idx,1); await deleteSearchMsgs(gameId); }
    const timeout = searchTimeouts.get(uid);
    if (timeout) { clearTimeout(timeout); searchTimeouts.delete(uid); }
    socket.emit('searchCancelled');
  });

  socket.on('disconnect', async () => {
    const wIdx = waitingQueue.findIndex(w=>w.socketId===socket.id);
    if (wIdx!==-1) {
      const {gameId, userId} = waitingQueue[wIdx];
      waitingQueue.splice(wIdx,1);
      await deleteSearchMsgs(gameId);
      const timeout = searchTimeouts.get(userId);
      if (timeout) { clearTimeout(timeout); searchTimeouts.delete(userId); }
    }

    const disconnectedUserId = myUserId;
    const disconnectedGameId = myGameId;

    if (disconnectedUserId) {
      userSockets.delete(disconnectedUserId);
      processingUsers.delete(disconnectedUserId);
      moveCooldowns.delete(disconnectedUserId);
      findGameCooldowns.delete(disconnectedUserId);
    }

    if (disconnectedGameId && activeGames.has(disconnectedGameId)) {
      setTimeout(async () => {
        const reconnected = disconnectedUserId && userSockets.has(disconnectedUserId);
        if (reconnected) return;

        const game = activeGames.get(disconnectedGameId);
        if (!game || game.status !== 'active') return;

        if (game.isAIGame) {
          await endCandyGameAI(disconnectedGameId, AI_ID, 'disconnect');
        } else {
          const opp = game.players.find(p => Number(p) !== Number(disconnectedUserId));
          if (opp) await endGame(disconnectedGameId, opp, 'disconnect');
        }
      }, 5000);
    }
  });

  socket.on('sendEmote', ({ gameId, emote }) => {
    try {
      if (!gameId || !emote || !myUserId) return;
      const game = activeGames.get(gameId);
      if (!game || game.status !== 'active') return;
      if (!game.players.includes(myUserId)) return;
      io.to(gameId).emit('emoteReceived', { senderId: myUserId, emote });
    } catch(e) { console.error('emote err:', e); }
  });
});

// ===== Admin middleware =====
function isAdmin(req,res,next) {
  const aid = parseInt(req.headers['x-admin-id']||req.query.adminId);
  if (!aid||aid!==ADMIN_ID) return res.status(403).json({error:'Forbidden'});
  next();
}

app.post('/api/admin/verify', async(req,res)=>{
  try {
    const {telegramId}=req.body;
    if (!telegramId) return res.status(400).json({error:'telegramId required'});
    const tid=parseInt(telegramId);
    if (!ADMIN_ID||tid!==ADMIN_ID) return res.status(403).json({error:'Admin မဟုတ်ပါ'});
    res.json({ok:true,adminId:tid});
  } catch(e){ res.status(500).json({error:'Server error'}); }
});

// ===== Agent Milestone Helper =====
async function updateAgentMilestone(agentTelegramId, depositAmount) {
  try {
    const agentUser = await User.findOne({ telegramId: agentTelegramId, role: 'agent' }).lean();
    if (!agentUser) return;
    let agent = await Agent.findOne({ telegramId: agentTelegramId });
    if (!agent) { agent = new Agent({ telegramId: agentTelegramId, referralCode: agentUser.referralCode }); await agent.save(); }
    for (const cfg of BOX_CONFIG) {
      const ms = agent.milestones[cfg.box];
      if (!ms || ms.claimed) continue;
      if (depositAmount >= cfg.perPerson) {
        if (ms.current < cfg.people) agent.milestones[cfg.box].current = ms.current + 1;
      }
    }
    await agent.save();
  } catch(e) { console.error('agentMilestone err:', e); }
}

// ===== Routes =====
app.get('/', (_,res)=>res.json({ok:true,game:'Candy Crush Multiplayer'}));
app.get('/health', (_,res)=>res.json({ok:true,mongodb:isConnected?'connected':'disconnected',activeGames:activeGames.size,queue:waitingQueue.length}));

app.post('/api/auth', async(req,res)=>{
  try {
    const {initData,telegramId:devId} = req.body;
    let tid,username,firstName;
    if (initData) {
      const u=verifyTgAuth(initData);
      if (!u) return res.status(401).json({error:'Telegram auth မှား'});
      tid=u.id; username=u.username||''; firstName=u.first_name||'';
    } else if (devId) {
      tid=parseInt(devId); username=''; firstName='User';
    } else return res.status(401).json({error:'Auth required'});
    const maint=await getSetting('maintenance',false);
    if (maint&&tid!==ADMIN_ID) return res.status(503).json({error:'🔧 ဆာဗာ ပြင်ဆင်နေပါသည်'});
    let user=await User.findOne({telegramId:tid});
    if (!user) { user=new User({telegramId:tid,username,firstName,referralCode:genRefCode(tid)}); await user.save(); }
    else {
      let d=false;
      if (username&&user.username!==username){user.username=username;d=true;}
      if (firstName&&user.firstName!==firstName){user.firstName=firstName;d=true;}
      if (d) await user.save();
    }
    if (user.isBanned) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားပါသည်'});
    res.json({telegramId:user.telegramId,username:user.username||user.firstName||`User${user.telegramId}`,firstName:user.firstName,balance:user.balance,referralCode:user.referralCode,totalGames:user.totalGames,wins:user.wins,losses:user.losses,botMode:user.botMode});
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

app.get('/api/user/:id', async(req,res)=>{
  try {
    const u=await User.findOne({telegramId:parseInt(req.params.id)}).select('balance totalGames wins losses botMode').lean();
    if (!u) return res.status(404).json({error:'Not found'});
    res.json(u);
  } catch(e){ res.status(500).json({error:'Server error'}); }
});

app.post('/api/deposit', async(req,res)=>{
  try {
    const {telegramId,kpayName,transactionId,amount,paymentMethod}=req.body;
    if (!telegramId||!kpayName||!transactionId||!amount) return res.status(400).json({error:'ကွင်းလပ်များ ဖြည့်ပေးပါ'});
    if (parseInt(amount)<500) return res.status(400).json({error:'အနည်းဆုံး 500 MMK'});
    const u=await User.findOne({telegramId:parseInt(telegramId)}).lean();
    if (!u) return res.status(404).json({error:'User not found'});
    if (u.isBanned) return res.status(403).json({error:'ကောင်ပိတ်ဆို့ထားသည်'});
    const dup=await Deposit.findOne({transactionId}).lean();
    if (dup) return res.status(400).json({error:'Transaction ID ကို အသုံးပြုပြီးသည်'});
    const method = (paymentMethod === 'wave') ? 'wave' : 'kpay';
    const methodLabel = method === 'wave' ? '🌊 Wave Pay' : '📱 KPay';
    const dep=await new Deposit({userId:u.telegramId,kpayName,transactionId,amount:parseInt(amount),paymentMethod:method}).save();
    if (bot) bot.telegram.sendMessage(ADMIN_ID,`💰 *ငွေသွင်း တောင်းဆိုမှု*\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${parseInt(amount).toLocaleString()} ကျပ်\n${methodLabel} ဖြင့် သွင်းထားသည်\n📝 ${kpayName}\n🔢 \`${transactionId}\``,{parse_mode:'Markdown'}).catch(()=>{});
    res.json({success:true,depositId:dep._id});
  } catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

app.post('/api/withdraw', async(req,res)=>{
  try {
    const {telegramId,kpayName,kpayNumber,amount,paymentMethod}=req.body;
    if (!telegramId||!kpayName||!kpayNumber||!amount) return res.status(400).json({error:'ကွင်းလပ်များ ဖြည့်ပေးပါ'});
    const amt=parseInt(amount);
    if (isNaN(amt)||amt<2500) return res.status(400).json({error:'အနည်းဆုံး 2,500 MMK'});
    const tid=parseInt(telegramId);
    const chk=await User.findOne({telegramId:tid}).select('balance isBanned firstName username').lean();
    if (!chk) return res.status(404).json({error:'User မတွေ့ပါ'});
    if (chk.isBanned===true) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားသည်'});
    if (chk.balance<amt) return res.status(400).json({error:`လက်ကျန်ငွေ မလုံလောက်ပါ (ကျန်: ${chk.balance.toLocaleString()} MMK)`});
    const method = (paymentMethod === 'wave') ? 'wave' : 'kpay';
    const methodLabel = method === 'wave' ? '🌊 Wave Pay' : '📱 KPay';
    let wd;
    try { wd=await new Withdrawal({userId:tid,kpayName,kpayNumber,amount:amt,paymentMethod:method}).save(); }
    catch(saveErr) { return res.status(500).json({error:'Record သိမ်းမရပါ'}); }
    const u=await User.findOneAndUpdate({telegramId:tid,balance:{$gte:amt},isBanned:{$ne:true}},{$inc:{balance:-amt}},{new:true});
    if (!u) {
      await Withdrawal.findByIdAndDelete(wd._id).catch(()=>{});
      const rechk=await User.findOne({telegramId:tid}).select('balance isBanned').lean();
      if (rechk?.isBanned===true) return res.status(403).json({error:'🚫 ကောင်ပိတ်ဆို့ထားသည်'});
      return res.status(400).json({error:`လက်ကျန်ငွေ မလုံလောက်ပါ`});
    }
    if (bot) bot.telegram.sendMessage(ADMIN_ID,`💸 *ငွေထုတ် တောင်းဆိုမှု*\n👤 ${u.firstName||u.username} (${u.telegramId})\n💵 ${amt.toLocaleString()} ကျပ်\n${methodLabel} ဖြင့် ထုတ်မည်\n📝 ${kpayName}\n📱 ${kpayNumber}\n🏦 ကျန်: ${u.balance.toLocaleString()} ကျပ်`,{parse_mode:'Markdown'}).catch(()=>{});
    res.json({success:true,withdrawalId:wd._id,newBalance:u.balance});
  } catch(e){ console.error('withdraw err:',e); res.status(500).json({error:'Server error'}); }
});

app.get('/api/referrals/:telegramId', async(req,res)=>{
  try {
    const tid = parseInt(req.params.telegramId);
    if (isNaN(tid)) return res.status(400).json({error:'Invalid ID'});
    const referrals = await User.find({referredBy:tid}).select('firstName username balance createdAt').sort({createdAt:-1}).lean();
    const list = referrals.map(u=>({name:u.firstName||u.username||`User${u.telegramId}`,username:u.username||'',balance:u.balance||0,joinedAt:u.createdAt}));
    res.json({total:list.length,referrals:list});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ===== Admin Routes =====
app.get('/api/admin/games', isAdmin, async(req,res)=>{
  try {
    const {page=1,search=''}=req.query;
    const limit=20; const skip=(parseInt(page)-1)*limit;
    let q={status:'completed'};
    if (search) { const tid=isNaN(search)?null:parseInt(search); if (tid) q={...q,players:tid}; }
    const games=await Game.find(q).sort({createdAt:-1}).skip(skip).limit(limit).lean();
    const total=await Game.countDocuments(q);
    const enriched=await Promise.all(games.map(async g=>{
      const pNames={};
      for (const pid of (g.players||[])) {
        if (pid===-999999){pNames[pid]='🤖 AI';continue;}
        const nm=g.playerNames?(g.playerNames instanceof Map?g.playerNames.get(String(pid)):g.playerNames[pid]):null;
        if (nm){pNames[pid]=nm;continue;}
        const u=await User.findOne({telegramId:pid}).select('firstName username').lean();
        pNames[pid]=u?.firstName||u?.username||`User${pid}`;
      }
      const winnerName=g.winner===-1?'🤝 သရေ':g.winner?(pNames[g.winner]||String(g.winner)):'—';
      const scoresObj=g.scores?(g.scores instanceof Map?Object.fromEntries(g.scores):g.scores):{};
      return {...g,pNames,winnerName,scoresObj};
    }));
    res.json({games:enriched,total,pages:Math.ceil(total/limit)});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/admin/games/:gameId', isAdmin, async(req,res)=>{
  try {
    const g=await Game.findOne({gameId:req.params.gameId}).lean();
    if (!g) return res.status(404).json({error:'Game not found'});
    if (g.status==='completed'&&g.winner&&g.winner!==-1&&g.winner!==-999999) {
      await User.findOneAndUpdate({telegramId:g.winner},{$inc:{balance:-WIN_PRIZE,wins:-1,totalGames:-1}});
      const loser=(g.players||[]).find(p=>p!==g.winner&&p!==-999999);
      if (loser) await User.findOneAndUpdate({telegramId:loser},{$inc:{losses:-1,totalGames:-1}});
    } else if (g.status==='completed'&&g.winner===-1) {
      for (const pid of (g.players||[])) {
        if (pid===-999999) continue;
        await User.findOneAndUpdate({telegramId:pid},{$inc:{balance:-DRAW_REFUND,totalGames:-1}});
      }
    }
    await Game.deleteOne({gameId:req.params.gameId});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/stats', isAdmin, async(_,res)=>{
  try {
    const [tu,tg,pd,pw]=await Promise.all([User.countDocuments(),Game.countDocuments({status:'completed'}),Deposit.countDocuments({status:'pending'}),Withdrawal.countDocuments({status:'pending'})]);
    const [depAgg,wdAgg]=await Promise.all([Deposit.aggregate([{$match:{status:'confirmed'}},{$group:{_id:null,t:{$sum:'$amount'}}}]),Withdrawal.aggregate([{$match:{status:'confirmed'}},{$group:{_id:null,t:{$sum:'$amount'}}}])]);
    res.json({totalUsers:tu,totalGames:tg,pendingDeposits:pd,pendingWithdrawals:pw,activeGames:activeGames.size,queueLength:waitingQueue.length,totalDeposited:depAgg[0]?.t||0,totalWithdrawn:wdAgg[0]?.t||0});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/settings', isAdmin, async(_,res)=>{
  const maint=await getSetting('maintenance',false);
  const allBotMode=await getSetting('allBotMode',false);
  const fakeNotifications=await getSetting('fakeNotifications',false);
  const fakeNotifInterval=await getSetting('fakeNotifInterval',3);
  res.json({maintenance:maint,allBotMode,fakeNotifications,fakeNotifInterval,entryFee:ENTRY_FEE,winPrize:WIN_PRIZE,drawRefund:DRAW_REFUND,gameDuration:GAME_DURATION_S});
});

app.post('/api/admin/maintenance', isAdmin, async(req,res)=>{ await setSetting('maintenance',!!req.body.enabled); res.json({success:true,maintenance:!!req.body.enabled}); });
app.get('/api/admin/allbotmode', isAdmin, async(req,res)=>{ const allBotMode=await getSetting('allBotMode',false); res.json({allBotMode}); });
app.post('/api/admin/allbotmode', isAdmin, async(req,res)=>{ await setSetting('allBotMode',!!req.body.enabled); res.json({success:true,allBotMode:!!req.body.enabled}); });
app.get('/api/admin/fakenotifications', isAdmin, async(req,res)=>{ const fakeNotifications=await getSetting('fakeNotifications',false); res.json({fakeNotifications}); });
app.post('/api/admin/fakenotifications', isAdmin, async(req,res)=>{ await setSetting('fakeNotifications',!!req.body.enabled); res.json({success:true,fakeNotifications:!!req.body.enabled}); });
app.post('/api/admin/fakenotifinterval', isAdmin, async(req,res)=>{ const mins=Math.max(1,Number(req.body.interval)||3); await setSetting('fakeNotifInterval',mins); scheduleFakeNotification(); res.json({success:true,fakeNotifInterval:mins}); });

app.get('/api/admin/deposits', isAdmin, async(req,res)=>{
  try {
    const agents=await User.find({role:'agent'}).select('telegramId').lean();
    const agentIds=agents.map(a=>a.telegramId);
    const agentReferredUserIds=agentIds.length?(await User.find({referredBy:{$in:agentIds}}).select('telegramId').lean()).map(u=>u.telegramId):[];
    const query={status:req.query.status||'pending'};
    if (agentReferredUserIds.length) query.userId={$nin:agentReferredUserIds};
    const deps=await Deposit.find(query).sort({createdAt:-1}).limit(50).lean();
    const out=await Promise.all(deps.map(async d=>{const u=await User.findOne({telegramId:d.userId}).select('firstName username').lean();return {...d,userName:u?.firstName||u?.username||String(d.userId)};}));
    res.json(out);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/deposits/:id/confirm', isAdmin, async(req,res)=>{
  try {
    const dep=await Deposit.findOneAndUpdate({_id:req.params.id,status:'pending'},{$set:{status:'confirmed',processedAt:new Date(),expireAt:new Date(Date.now()+72*60*60*1000)}},{new:true});
    if (!dep) return res.status(400).json({error:'Deposit မတွေ့ပါ သို့မဟုတ် ပြင်ဆင်ပြီးသားဖြစ်သည်'});
    await User.findOneAndUpdate({telegramId:dep.userId},{$inc:{balance:dep.amount}});
    const user=await User.findOne({telegramId:dep.userId}).lean();
    if (user?.referredBy) {
      const prevDeps=await Deposit.countDocuments({userId:dep.userId,status:'confirmed',_id:{$ne:dep._id}});
      if (prevDeps===0) { await User.findOneAndUpdate({telegramId:user.referredBy},{$inc:{balance:100}}); if (bot) bot.telegram.sendMessage(user.referredBy,`🎉 သင့် referral မှ ငွေဖြည့်သောကြောင့် <b>100 MMK</b> ရရှိပါပြီ!`,{parse_mode:'HTML'}).catch(()=>{}); }
      await updateAgentMilestone(user.referredBy, dep.amount);
    }
    if (bot) bot.telegram.sendMessage(dep.userId,`✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု အတည်ပြုပြီး!\n\nသင့်လက်ကျန်ငွေ ပေါင်းထည့်ပြီး 🎉`,Markup.inlineKeyboard([[Markup.button.webApp('🍭 ကစားမည်', FRONTEND_URL)]])).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/deposits/:id/reject', isAdmin, async(req,res)=>{
  try {
    const {reason}=req.body;
    const TTL_72H=new Date(Date.now()+72*60*60*1000);
    const dep=await Deposit.findByIdAndUpdate(req.params.id,{status:'rejected',processedAt:new Date(),expireAt:TTL_72H},{new:true});
    if (!dep) return res.status(404).json({error:'Deposit မတွေ့ပါ'});
    const reasonText=reason?`\nအကြောင်းပြချက်: ${reason}`:'';
    if (bot) bot.telegram.sendMessage(dep.userId,`❌ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု ပယ်ချပြီ\nTxn: ${dep.transactionId}${reasonText}`).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/withdrawals', isAdmin, async(req,res)=>{
  try {
    const wds=await Withdrawal.find({status:req.query.status||'pending'}).sort({createdAt:-1}).limit(50).lean();
    const out=await Promise.all(wds.map(async w=>{const u=await User.findOne({telegramId:w.userId}).select('firstName username balance').lean();return {...w,userName:u?.firstName||u?.username||String(w.userId),userBalance:u?.balance};}));
    res.json(out);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/withdrawals/:id/confirm', isAdmin, async(req,res)=>{
  try {
    const wd=await Withdrawal.findOneAndUpdate({_id:req.params.id,status:'pending'},{$set:{status:'confirmed',processedAt:new Date(),expireAt:new Date(Date.now()+72*60*60*1000)}},{new:true});
    if (!wd) return res.status(400).json({error:'Withdrawal မတွေ့ပါ သို့မဟုတ် ပြင်ဆင်ပြီးသားဖြစ်သည်'});
    if (bot) bot.telegram.sendMessage(wd.userId,`✅ ငွေ ${wd.amount.toLocaleString()} ကျပ် ထုတ်မှု အတည်ပြုပြီး!\n${wd.paymentMethod==='wave'?'🌊 Wave Pay':'📱 KPay'}: ${wd.kpayNumber} 🎉`).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/withdrawals/:id/reject', isAdmin, async(req,res)=>{
  try {
    const wd=await Withdrawal.findById(req.params.id);
    if (!wd) return res.status(404).json({error:'Withdrawal မတွေ့ပါ'});
    if (wd.status!=='pending') return res.status(400).json({error:'ဤ Withdrawal ကို ပြင်ဆင်ပြီးသားဖြစ်သည်'});
    const TTL_72H=new Date(Date.now()+72*60*60*1000);
    wd.status='rejected';wd.processedAt=new Date();wd.expireAt=TTL_72H;
    await wd.save();
    await User.findOneAndUpdate({telegramId:wd.userId},{$inc:{balance:wd.amount}});
    if (bot) bot.telegram.sendMessage(wd.userId,`❌ ငွေ ${wd.amount.toLocaleString()} ကျပ် ထုတ်မှု ပယ်ချပြီး ငွေပြန်အမ်းပြီ`).catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/users', isAdmin, async(req,res)=>{
  try {
    const {search,page=1}=req.query;
    const q=search?{$or:[{telegramId:isNaN(search)?-1:parseInt(search)},{username:{$regex:search,$options:'i'}},{firstName:{$regex:search,$options:'i'}}]}:{};
    const users=await User.find(q).sort({createdAt:-1}).skip((page-1)*20).limit(20).lean();
    const total=await User.countDocuments(q);
    res.json({users,total,pages:Math.ceil(total/20)});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/high-balancers', isAdmin, async(req,res)=>{
  try {
    const highUsers=await User.find({balance:{$gte:4000},isBanned:{$ne:true}}).sort({balance:-1}).lean();
    const enriched=await Promise.all(highUsers.map(async u=>{
      const deposits=await Deposit.aggregate([{$match:{userId:u.telegramId,status:'confirmed'}},{$group:{_id:null,total:{$sum:'$amount'}}}]);
      return {telegramId:u.telegramId,username:u.username,firstName:u.firstName,balance:u.balance,totalDeposited:deposits[0]?.total||0,botMode:u.botMode,isBanned:u.isBanned};
    }));
    res.json(enriched);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:tid/balance', isAdmin, async(req,res)=>{
  try {
    const {amount,reason}=req.body;
    const u=await User.findOneAndUpdate({telegramId:parseInt(req.params.tid)},{$inc:{balance:parseInt(amount)}},{new:true});
    if (!u) return res.status(404).json({error:'Not found'});
    if (bot){const sign=amount>0?'+':'';bot.telegram.sendMessage(u.telegramId,`💰 Admin မှ ${sign}${parseInt(amount).toLocaleString()} ကျပ်\n${reason?`မှတ်ချက်: ${reason}`:''}\nလက်ကျန်: ${u.balance.toLocaleString()} ကျပ်`).catch(()=>{});}
    res.json({success:true,newBalance:u.balance});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:tid/ban', isAdmin, async(req,res)=>{
  try {
    const {ban}=req.body;
    const u=await User.findOneAndUpdate({telegramId:parseInt(req.params.tid)},{isBanned:!!ban},{new:true});
    if (!u) return res.status(404).json({error:'Not found'});
    if (bot&&ban) bot.telegram.sendMessage(u.telegramId,'🚫 ကောင်ပိတ်ဆို့ထားပါသည်။ Admin ကို ဆက်သွယ်ပါ').catch(()=>{});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:tid/botmode', isAdmin, async(req,res)=>{
  try {
    const {enabled}=req.body;
    const u=await User.findOneAndUpdate({telegramId:parseInt(req.params.tid)},{botMode:!!enabled},{new:true});
    if (!u) return res.status(404).json({error:'User not found'});
    res.json({success:true,botMode:u.botMode});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/broadcast', isAdmin, async(req,res)=>{
  try {
    const {message,buttonText,buttonUrl}=req.body;
    if (!message) return res.status(400).json({error:'Message required'});
    res.json({success:true,msg:'Broadcast started in background'});
    setImmediate(async()=>{
      const users=await User.find({isBanned:{$ne:true}}).select('telegramId').lean();
      const kb=buttonText&&buttonUrl?{inline_keyboard:[[{text:buttonText,url:buttonUrl}]]}:undefined;
      let sent=0,fail=0;
      const CHUNK=30;
      for (let i=0;i<users.length;i+=CHUNK){
        const batch=users.slice(i,i+CHUNK);
        await Promise.allSettled(batch.map(async u=>{try{await bot.telegram.sendMessage(u.telegramId,message,{parse_mode:'HTML',reply_markup:kb});sent++;}catch(e){fail++;}}));
        if (i+CHUNK<users.length) await new Promise(r=>setTimeout(r,1000));
      }
      console.log(`Broadcast done: ${sent} sent, ${fail} failed`);
    });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/message', isAdmin, async(req,res)=>{
  try {
    const {telegramId,message}=req.body;
    if (!telegramId||!message) return res.status(400).json({error:'Missing fields'});
    await bot.telegram.sendMessage(parseInt(telegramId),message,{parse_mode:'HTML'});
    res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ===== Agent API =====
async function isAgent(req, res, next) {
  const tid = parseInt(req.headers['x-telegram-id'] || req.query.telegramId);
  if (!tid) return res.status(401).json({ error: 'Telegram ID မပါ' });
  const user = await User.findOne({ telegramId: tid, role: 'agent' }).lean();
  if (!user) return res.status(403).json({ error: 'Agent မဟုတ်သေးပါ' });
  req.agentUser = user;
  next();
}

app.get('/api/agent/panel', isAgent, async (req, res) => {
  try {
    const user = req.agentUser;
    let agent = await Agent.findOne({ telegramId: user.telegramId });
    if (!agent) { agent = new Agent({ telegramId: user.telegramId, referralCode: user.referralCode }); await agent.save(); }
    const totalReferrals = await User.countDocuments({ referredBy: user.telegramId });
    const referredIds = (await User.find({ referredBy: user.telegramId }).select('telegramId').lean()).map(u => u.telegramId);
    const salesAgg = referredIds.length ? await Deposit.aggregate([{$match:{userId:{$in:referredIds},status:'confirmed'}},{$group:{_id:null,total:{$sum:'$amount'}}}]) : [];
    const totalSales = salesAgg[0]?.total || 0;
    res.json({telegramId:user.telegramId,firstName:user.firstName,username:user.username,balance:user.balance,referralCode:user.referralCode,botUsername:BOT_USERNAME,milestones:agent.milestones,totalEarned:agent.totalEarned,completedBoxes:agent.completedBoxes,totalReferrals,totalSales});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/referrals', isAgent, async (req, res) => {
  try {
    const referrals = await User.find({ referredBy: req.agentUser.telegramId }).select('firstName username balance createdAt').sort({ createdAt: -1 }).lean();
    const list = referrals.map(u=>({name:u.firstName||u.username||`User${u.telegramId}`,username:u.username||'',balance:u.balance||0,joinedAt:u.createdAt}));
    res.json({ total: list.length, referrals: list });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/claim-box', isAgent, async (req, res) => {
  try {
    const { box } = req.body;
    const boxNum = parseInt(box);
    if (!boxNum || boxNum < 1 || boxNum > 10) return res.status(400).json({ error: 'Box နံပါတ် မမှန်ပါ' });
    const cfg = BOX_CONFIG.find(b => b.box === boxNum);
    if (!cfg) return res.status(400).json({ error: 'Box မတွေ့ပါ' });
    const user = req.agentUser;
    let agent = await Agent.findOne({ telegramId: user.telegramId });
    if (!agent) return res.status(404).json({ error: 'Agent Data မတွေ့ပါ' });
    const ms = agent.milestones[boxNum];
    if (!ms) return res.status(400).json({ error: 'Milestone မတွေ့ပါ' });
    if (boxNum === 10) { const box2 = agent.milestones[2]; if (!box2?.claimed) return res.status(400).json({ error: 'Box 2 အောင်မြင်မှ Box 10 ယူနိုင်မည်' }); }
    if (ms.current < cfg.people) return res.status(400).json({ error: `လူဦးရေ မပြည့်သေးပါ (${ms.current}/${cfg.people})` });
    if (!cfg.loop && ms.claimed) return res.status(400).json({ error: 'ဆုကြေး ယူပြီးသည်' });
    const updated = await User.findOneAndUpdate({ telegramId: user.telegramId }, { $inc: { balance: cfg.bonus } }, { new: true });
    if (cfg.loop) { agent.milestones[boxNum].current = 0; agent.milestones[boxNum].claimed = false; }
    else { agent.milestones[boxNum].claimed = true; agent.completedBoxes = (agent.completedBoxes || 0) + 1; }
    agent.totalEarned = (agent.totalEarned || 0) + cfg.bonus;
    await agent.save();
    if (bot) bot.telegram.sendMessage(user.telegramId,`🎉 <b>Box ${boxNum} ဆုကြေး ရပြီ!</b>\n\n💰 +${cfg.bonus.toLocaleString()} ကျပ်\n🏦 လက်ကျန်: ${updated.balance.toLocaleString()} ကျပ်`,{parse_mode:'HTML'}).catch(()=>{});
    res.json({ success: true, bonus: cfg.bonus, newBalance: updated.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agent/deposits', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;
    const referredUsers = await User.find({ referredBy: agentId }).select('telegramId firstName username').lean();
    if (!referredUsers.length) return res.json([]);
    const referredIds = referredUsers.map(u => u.telegramId);
    const userMap = {};
    referredUsers.forEach(u => { userMap[u.telegramId] = u.firstName || u.username || `User${u.telegramId}`; });
    const status = req.query.status || 'pending';
    const deps = await Deposit.find({ userId: { $in: referredIds }, status }).sort({ createdAt: -1 }).limit(50).lean();
    const out = deps.map(d => ({ ...d, userName: userMap[d.userId] || String(d.userId) }));
    res.json(out);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/deposits/:id/confirm', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;
    const dep = await Deposit.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: { status: 'confirming' } }, { new: false });
    if (!dep) { const existing = await Deposit.findById(req.params.id).lean(); if (!existing) return res.status(404).json({ error: 'မတွေ့ပါ' }); return res.status(400).json({ error: 'ပြင်ဆင်ပြီးသားဖြစ်သည်' }); }
    const user = await User.findOne({ telegramId: dep.userId }).lean();
    if (!user || user.referredBy !== agentId) { await Deposit.findByIdAndUpdate(dep._id, { $set: { status: 'pending' } }); return res.status(403).json({ error: 'ဤ User သည် သင့် Referral မဟုတ်ပါ' }); }
    const agentFresh = await User.findOne({ telegramId: agentId }).lean();
    if (!agentFresh || agentFresh.balance < dep.amount) { await Deposit.findByIdAndUpdate(dep._id, { $set: { status: 'pending' } }); return res.status(402).json({ error: `လက်ကျန်ငွေ မလောက်ပါ`, insufficientBalance: true, agentBalance: agentFresh?.balance || 0, required: dep.amount }); }
    const TTL_72H = new Date(Date.now() + 72 * 60 * 60 * 1000);
    await Deposit.findByIdAndUpdate(dep._id, { $set: { status: 'confirmed', processedAt: new Date(), processedBy: 'agent', expireAt: TTL_72H } });
    await User.findOneAndUpdate({ telegramId: agentId }, { $inc: { balance: -dep.amount } });
    await User.findOneAndUpdate({ telegramId: dep.userId }, { $inc: { balance: dep.amount } });
    const prevDeps = await Deposit.countDocuments({ userId: dep.userId, status: 'confirmed', _id: { $ne: dep._id } });
    if (prevDeps === 0) { await User.findOneAndUpdate({ telegramId: agentId }, { $inc: { balance: 100 } }); if (bot) bot.telegram.sendMessage(agentId,`🎉 Referral မှ ပထမဆုံး ငွေဖြည့်သောကြောင့် <b>၁၀၀ ကျပ်</b> ရရှိပါပြီ!`,{parse_mode:'HTML'}).catch(()=>{}); }
    await updateAgentMilestone(agentId, dep.amount);
    const methodLabel = dep.paymentMethod === 'wave' ? '🌊 Wave Pay' : '📱 KPay';
    if (bot) bot.telegram.sendMessage(dep.userId,`✅ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု အတည်ပြုပြီး!\n${methodLabel}\n\nသင့်လက်ကျန်ငွေ ပေါင်းထည့်ပြီး 🎉`,Markup.inlineKeyboard([[Markup.button.webApp('🍭 ကစားမည်', FRONTEND_URL)]])).catch(()=>{});
    const agentName = agentFresh.firstName || agentFresh.username || `Agent${agentId}`;
    const userName = user.firstName || user.username || `User${dep.userId}`;
    if (bot) bot.telegram.sendMessage(ADMIN_ID,`🎯 <b>Agent မှ Deposit Confirm</b>\n👤 User: ${userName} (${dep.userId})\n💰 ${dep.amount.toLocaleString()} ကျပ် (${methodLabel})\n🎯 Agent: ${agentName} (${agentId})\n🔢 Txn: <code>${dep.transactionId}</code>`,{parse_mode:'HTML'}).catch(()=>{});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent/deposits/:id/reject', isAgent, async (req, res) => {
  try {
    const agentId = req.agentUser.telegramId;
    const { reason } = req.body;
    const dep = await Deposit.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: { status: 'rejected', processedAt: new Date(), processedBy: 'agent', expireAt: new Date(Date.now() + 72 * 60 * 60 * 1000) } }, { new: true });
    if (!dep) { const existing = await Deposit.findById(req.params.id).lean(); if (!existing) return res.status(404).json({ error: 'မတွေ့ပါ' }); return res.status(400).json({ error: 'ပြင်ဆင်ပြီးသားဖြစ်သည်' }); }
    const user = await User.findOne({ telegramId: dep.userId }).lean();
    if (!user || user.referredBy !== agentId) return res.status(403).json({ error: 'ဤ User သည် သင့် Referral မဟုတ်ပါ' });
    const reasonText = reason ? `\nအကြောင်းပြချက်: ${reason}` : '';
    if (bot) bot.telegram.sendMessage(dep.userId,`❌ ငွေ ${dep.amount.toLocaleString()} ကျပ် သွင်းမှု ပယ်ချပြီ\nTxn: ${dep.transactionId}${reasonText}`).catch(()=>{});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/payment-info/:telegramId', async (req, res) => {
  try {
    const tid = parseInt(req.params.telegramId);
    const user = await User.findOne({ telegramId: tid }).lean();
    if (!user) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    const defaultInfo = { kpayNumber: process.env.ADMIN_KPAY_NUMBER || '09792310926', kpayName: process.env.ADMIN_KPAY_NAME || 'Daw Mi Thaung', hasWave: true, waveNumber: process.env.ADMIN_WAVE_NUMBER || '09792310926', waveName: process.env.ADMIN_WAVE_NAME || 'Min Oak Soe', isAgentPayment: false };
    if (!user.referredBy) return res.json(defaultInfo);
    const agentDoc = await Agent.findOne({ telegramId: user.referredBy }).lean();
    if (!agentDoc || !agentDoc.agentKpayNumber) return res.json(defaultInfo);
    res.json({ kpayNumber: agentDoc.agentKpayNumber, kpayName: agentDoc.agentKpayName || '', hasWave: agentDoc.hasWave || false, waveNumber: '', waveName: '', isAgentPayment: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/payment-info', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { kpayNumber, kpayName, hasWave } = req.body;
    if (!kpayNumber) return res.status(400).json({ error: 'KPay နံပါတ် လိုသည်' });
    const agent = await Agent.findOneAndUpdate({ telegramId: tid }, { $set: { agentKpayNumber: kpayNumber, agentKpayName: kpayName || '', hasWave: !!hasWave } }, { new: true, upsert: false });
    if (!agent) return res.status(404).json({ error: 'Agent Data မတွေ့ပါ' });
    res.json({ success: true, agentKpayNumber: agent.agentKpayNumber, agentKpayName: agent.agentKpayName });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/balance', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { amount, reason } = req.body;
    const amt = parseInt(amount);
    if (isNaN(amt) || amt === 0) return res.status(400).json({ error: 'Amount မှားနေသည်' });
    const u = await User.findOneAndUpdate({ telegramId: tid, role: 'agent' }, { $inc: { balance: amt } }, { new: true });
    if (!u) return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    if (bot) { const sign = amt > 0 ? '+' : ''; bot.telegram.sendMessage(tid,`💰 <b>Admin မှ Balance ဖြည့်ပေးသည်</b>\n${sign}${amt.toLocaleString()} ကျပ်${reason?`\nမှတ်ချက်: ${reason}`:''}\n🏦 လက်ကျန်: ${u.balance.toLocaleString()} ကျပ်`,{parse_mode:'HTML'}).catch(()=>{}); }
    res.json({ success: true, newBalance: u.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/agent-referrals', isAdmin, async (req, res) => {
  try {
    const agents = await User.find({ role: 'agent' }).select('telegramId firstName username balance').sort({ createdAt: -1 }).lean();
    const result = await Promise.all(agents.map(async agent => {
      const referredUsers = await User.find({ referredBy: agent.telegramId }).select('telegramId firstName username balance createdAt').lean();
      const referredIds = referredUsers.map(u => u.telegramId);
      let activeCount = 0, totalSales = 0;
      if (referredIds.length) {
        const depositors = await Deposit.aggregate([{$match:{userId:{$in:referredIds},status:'confirmed'}},{$group:{_id:'$userId',total:{$sum:'$amount'}}}]);
        activeCount = depositors.length; totalSales = depositors.reduce((s,d)=>s+d.total,0);
      }
      return { agentId: agent.telegramId, agentName: agent.firstName||agent.username||`Agent${agent.telegramId}`, agentBalance: agent.balance||0, totalReferrals: referredUsers.length, activeReferrals: activeCount, totalSales, referrals: referredUsers.map(u=>({telegramId:u.telegramId,name:u.firstName||u.username||`User${u.telegramId}`,username:u.username||'',balance:u.balance||0,joinedAt:u.createdAt})) };
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:tid/make-agent', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { isAgent: makeAgent } = req.body;
    const newRole = makeAgent ? 'agent' : 'user';
    const u = await User.findOneAndUpdate({ telegramId: tid }, { role: newRole }, { new: true });
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (makeAgent) {
      await Agent.findOneAndUpdate({ telegramId: tid }, { $setOnInsert: { telegramId: tid, referralCode: u.referralCode } }, { upsert: true });
      if (bot) bot.telegram.sendMessage(tid,`🎯 <b>Agent အဖြစ် ခွင့်ပြုပြီ!</b>\n\n🎉 မင်္ဂလာပါ Agent!\n\nBot တွင် <code>/agent</code> ရိုက်ပြီး Agent Panel ကို ဝင်ရောက်ပါ`,{parse_mode:'HTML'}).catch(()=>{});
    } else { if (bot) bot.telegram.sendMessage(tid,`ℹ️ သင်၏ Agent အဆင့်ကို ဖယ်ရှားပြီးပါပြီ`,{parse_mode:'HTML'}).catch(()=>{}); }
    res.json({ success: true, role: newRole });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/agents', isAdmin, async (req, res) => {
  try {
    const { page = 1, search = '' } = req.query;
    const limit = 20;
    const q = { role: 'agent' };
    if (search) { const tid = isNaN(search) ? null : parseInt(search); q.$or = [...(tid ? [{ telegramId: tid }] : []), { username: { $regex: search, $options: 'i' } }, { firstName: { $regex: search, $options: 'i' } }]; }
    const agents = await User.find(q).sort({ createdAt: -1 }).skip((page-1)*limit).limit(limit).lean();
    const total = await User.countDocuments(q);
    const enriched = await Promise.all(agents.map(async u => { const agentDoc = await Agent.findOne({ telegramId: u.telegramId }).lean(); const totalReferrals = await User.countDocuments({ referredBy: u.telegramId }); return { ...u, agentData: agentDoc, totalReferrals }; }));
    res.json({ agents: enriched, total, pages: Math.ceil(total / limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/agents/:tid', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const user = await User.findOne({ telegramId: tid, role: 'agent' }).lean();
    if (!user) return res.status(404).json({ error: 'Agent မတွေ့ပါ' });
    const agentDoc = await Agent.findOne({ telegramId: tid }).lean();
    const referrals = await User.find({ referredBy: tid }).select('firstName username balance createdAt').sort({ createdAt: -1 }).lean();
    res.json({ user, agentData: agentDoc, referrals, totalReferrals: referrals.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/reset-box', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { box } = req.body;
    const boxNum = parseInt(box);
    const agent = await Agent.findOne({ telegramId: tid });
    if (!agent) return res.status(404).json({ error: 'Agent Data မတွေ့ပါ' });
    agent.milestones[boxNum].current = 0; agent.milestones[boxNum].claimed = false;
    await agent.save();
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents/:tid/award-box', isAdmin, async (req, res) => {
  try {
    const tid = parseInt(req.params.tid);
    const { box } = req.body;
    const boxNum = parseInt(box);
    const cfg = BOX_CONFIG.find(b => b.box === boxNum);
    if (!cfg) return res.status(400).json({ error: 'Box မတွေ့ပါ' });
    const u = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: cfg.bonus } }, { new: true });
    if (!u) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    const agent = await Agent.findOne({ telegramId: tid });
    if (agent) { if (!cfg.loop) agent.milestones[boxNum].claimed = true; agent.totalEarned = (agent.totalEarned || 0) + cfg.bonus; await agent.save(); }
    if (bot) bot.telegram.sendMessage(tid,`🎁 <b>Admin မှ Box ${boxNum} ဆုကြေး ပေးအပ်</b>\n💰 +${cfg.bonus.toLocaleString()} MMK`,{parse_mode:'HTML'}).catch(()=>{});
    res.json({ success: true, bonus: cfg.bonus, newBalance: u.balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Redeem Code API =====
app.post('/api/redeem', async(req, res) => {
  try {
    const { telegramId, code } = req.body;
    if (!telegramId || !code) return res.status(400).json({ error: 'telegramId နှင့် code လိုအပ်သည်' });
    const tid = parseInt(telegramId);
    const user = await User.findOne({ telegramId: tid }).lean();
    if (!user) return res.status(404).json({ error: 'User မတွေ့ပါ' });
    if (user.isBanned) return res.status(403).json({ error: '🚫 ကောင်ပိတ်ဆို့ထားသည်' });
    const rc = await RedeemCode.findOne({ code: code.toUpperCase().trim() });
    if (!rc || !rc.isActive) return res.status(400).json({ error: '❌ Code မမှန်ပါ သို့မဟုတ် ပိတ်ထားပြီ' });
    if (rc.usedBy.includes(tid)) return res.status(400).json({ error: '⚠️ ဤ Code ကို သင် အသုံးပြုပြီးသားဖြစ်သည်' });
    if (rc.maxUses > 0 && rc.usedBy.length >= rc.maxUses) return res.status(400).json({ error: '⚠️ Code ကုန်ဆုံးပြီ' });
    await RedeemCode.updateOne({ _id: rc._id }, { $push: { usedBy: tid } });
    const updated = await User.findOneAndUpdate({ telegramId: tid }, { $inc: { balance: rc.amount } }, { new: true });
    if (bot) bot.telegram.sendMessage(ADMIN_ID,`🎟️ Redeem Code အသုံးပြု\n👤 ${user.firstName||user.username} (${tid})\n🎫 Code: <code>${rc.code}</code>\n💰 ${rc.amount.toLocaleString()} MMK`,{parse_mode:'HTML'}).catch(()=>{});
    res.json({ success: true, amount: rc.amount, newBalance: updated.balance });
  } catch(e) { console.error('redeem err:', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/redeem/create', isAdmin, async(req, res) => {
  try {
    const { code, amount, maxUses } = req.body;
    if (!code || !amount) return res.status(400).json({ error: 'code နှင့် amount လိုသည်' });
    const amt = parseInt(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Amount မှားနေသည်' });
    const mx = parseInt(maxUses) || 1;
    const rc = await new RedeemCode({ code: code.toUpperCase().trim(), amount: amt, maxUses: mx }).save();
    res.json({ success: true, code: rc });
  } catch(e) { if (e.code === 11000) return res.status(400).json({ error: 'ထို Code ရှိပြီးသားဖြစ်သည်' }); res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/redeem/list', isAdmin, async(req, res) => {
  try { const codes = await RedeemCode.find().sort({ createdAt: -1 }).lean(); res.json(codes); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/redeem/:id/toggle', isAdmin, async(req, res) => {
  try { const rc = await RedeemCode.findById(req.params.id); if (!rc) return res.status(404).json({ error: 'Not found' }); rc.isActive = !rc.isActive; await rc.save(); res.json({ success: true, isActive: rc.isActive }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/redeem/:id', isAdmin, async(req, res) => {
  try { await RedeemCode.findByIdAndDelete(req.params.id); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== Self-ping =====
setInterval(()=>{ try { https.get(`${BACKEND_URL}/health`,()=>{}).on('error',()=>{}); } catch(e){} }, 5*60*1000);

process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err); });

const PORT = process.env.PORT||3000;
server.listen(PORT, ()=>console.log(`🚀 Candy Crush Server on port ${PORT}`));
