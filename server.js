const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 托管静态文件（index.html / client.js / style.css）
app.use(express.static(__dirname));

/** roomId -> room */
const rooms = new Map();

// ===== 配置常量 =====
const CONFIG = {
  DECK_SIZE: 108,
  BOTTOM_CARDS_5P: 8,
  BOTTOM_CARDS_6P: 6,
  MIN_BID: 120,
  WIN_SCORE: 1000,
  MIN_PLAYERS: 5,
  MAX_PLAYERS: 6,
  BOTTOM_MULTIPLIER_NORMAL: 2,
  BOTTOM_MULTIPLIER_DOUBLE: 4,
};

// ===== 统一错误处理 =====
function sendError(cb, msg) {
  console.error(`[ERROR] ${msg}`);
  return cb && cb({ ok: false, error: msg });
}

function sendSuccess(cb, data = {}) {
  return cb && cb({ ok: true, ...data });
}

function genRoomId() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ====== 2 副牌（108 张：含大小王）=====
function newDeck() {
  const suits = ["S", "H", "D", "C"];
  const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck = [];

  // 两副 52
  for (let copy = 1; copy <= 2; copy++) {
    for (const s of suits) {
      for (const r of ranks) deck.push(`${s}-${r}-${copy}`);
    }
  }
  // 两副大小王
  for (let copy = 1; copy <= 2; copy++) {
    deck.push(`J-SJ-${copy}`); // 小王
    deck.push(`J-BJ-${copy}`); // 大王
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseCardId(cardId){
  const [suit, rank, copy] = String(cardId).split("-");
  return { suit, rank, copy };
}

// 计算单张牌的分值（5=5分，10/K=10分）
function cardPoints(cardId){
  const { rank } = parseCardId(cardId);
  if (rank === "5") return 5;
  if (rank === "10" || rank === "K") return 10;
  return 0;
}

// 计算多张牌的总分
function calculatePoints(cards){
  if (!Array.isArray(cards)) return 0;
  return cards.reduce((sum, card) => sum + cardPoints(card), 0);
}

function rankValue(rank){
  if (rank === "BJ") return 17; // 大王最大
  if (rank === "SJ") return 16; // 小王次之
  if (rank === "2") return 15;  // 2 第三大
  if (rank === "A") return 14;
  if (rank === "K") return 13;
  if (rank === "Q") return 12;
  if (rank === "J") return 11;
  return Number(rank);
}

// 判断是否为主牌（大小王、所有2、主花色牌）
function isTrumpCard(cardId, trumpSuit){
  const { suit, rank } = parseCardId(cardId);
  if (suit === "J") return true;           // 大小王是主牌
  if (rank === "2") return true;           // 所有2都是主牌
  if (trumpSuit && suit === trumpSuit) return true; // 主花色牌
  return false;
}

// 判断两张牌是否是对子（完全相同：同花色、同点数、不同副本）
function isPair(card1, card2){
  const c1 = parseCardId(card1);
  const c2 = parseCardId(card2);
  return c1.suit === c2.suit && c1.rank === c2.rank && c1.copy !== c2.copy;
}

// 比较两张牌的大小（a > b 返回 true）
function compareCard(a, b, trumpSuit){
  const A = parseCardId(a);
  const B = parseCardId(b);

  const isTrumpA = isTrumpCard(a, trumpSuit);
  const isTrumpB = isTrumpCard(b, trumpSuit);

  // 主牌 > 副牌
  if (isTrumpA && !isTrumpB) return true;
  if (!isTrumpA && isTrumpB) return false;

  // 都是主牌：按优先级比较
  if (isTrumpA && isTrumpB) {
    // 王 > 2 > 其他主牌
    const isJokerA = A.suit === "J";
    const isJokerB = B.suit === "J";
    const is2A = A.rank === "2";
    const is2B = B.rank === "2";

    // 王之间比较
    if (isJokerA && isJokerB) return rankValue(A.rank) > rankValue(B.rank);
    if (isJokerA) return true;
    if (isJokerB) return false;

    // 2之间比较：主花色的2 > 其他2
    if (is2A && is2B) {
      const isMainTrump2A = trumpSuit && A.suit === trumpSuit;
      const isMainTrump2B = trumpSuit && B.suit === trumpSuit;
      if (isMainTrump2A && !isMainTrump2B) return true;
      if (!isMainTrump2A && isMainTrump2B) return false;
      // ✅ 同等级的2，认为相等（先出者获胜）
      return false;
    }
    if (is2A) return true;
    if (is2B) return false;

    // 其他主牌按点数比较
    if (A.rank !== B.rank) return rankValue(A.rank) > rankValue(B.rank);
    // ✅ 同点数认为相等（先出者获胜）
    return false;
  }

  // 都是副牌：同花色比点数，不同花色无法比较（返回false，保持第一张牌优势）
  if (A.suit === B.suit) {
    if (A.rank !== B.rank) return rankValue(A.rank) > rankValue(B.rank);
    return Number(A.copy || 0) > Number(B.copy || 0);
  }

  return false; // 不同花色的副牌无法比较
}

function snapshot(room) {
  const g = room.game || {};
  const bottomCapacity = g.bottomNeed ?? CONFIG.BOTTOM_CARDS_6P;

  return {
    roomId: room.roomId,
    ownerId: room.ownerId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      connected: p.connected,
      cardsLeft: p.hand.length,
      trickPoints: p.trickPoints,
      totalScore: p.totalScore || 0,
      isFriend: p.isFriend || false,
      isRevealed: p.isRevealed || false,
    })),
    game: {
      started: g.started,
      phase: g.phase,
      actorId: g.actorId,
      turnId: g.turnId,

      bid: g.bid,
      bankerId: g.bankerId,
      trumpSuit: g.trumpSuit,

      friendCount: g.friendCount,
      friendDeclaration: g.friendDeclaration || "", // 朋友声明文字

      bottomNeed: bottomCapacity,
      bottomCount: bottomCapacity,
      bottomPhase: g.bottomPhase, // "HIDDEN" | "WITH_BANKER" | "REVEALED"

      currentTrick: g.currentTrick,
      table: g.table,
    },
    bottom: {
      capacity: bottomCapacity,
      phase: g.bottomPhase || "HIDDEN",
      // 只有 REVEALED 时才公开底牌
      cards: g.bottomPhase === "REVEALED" ? (g.bottomCards || []) : null,
    }
  };
}

function ensureRoom(roomId){
  const room = rooms.get(roomId);
  if (!room) return null;
  return room;
}

// ===== 游戏结束逻辑（提取函数） =====
function endGame(room, g) {
  g.phase = "OVER";
  g.started = false;
  g.bottomPhase = "REVEALED"; // 底牌翻面

  // ✅ 计算底牌分数（已在最后一墩加给赢家）
  const bottomPoints = calculatePoints(g.bottomCards);

  // ✅ 计算庄家方和农民方总分
  const bankerTeam = room.players.filter(x =>
    x.id === g.bankerId || (x.isFriend && x.isRevealed)
  );
  const bankerPoints = bankerTeam.reduce((sum, x) => sum + x.trickPoints, 0);

  const farmers = room.players.filter(p =>
    p.id !== g.bankerId && !(p.isFriend && p.isRevealed)
  );
  const farmerPoints = farmers.reduce((sum, p) => sum + p.trickPoints, 0);

  // ✅ 新的胜负判定：农民得分 > (200 - 叫分) 则农民胜
  const farmerTarget = 200 - g.bid;
  const success = farmerPoints <= farmerTarget; // 农民未达标，庄家胜

  // ✅ 更新累计总分
  updateScores(room.players, g, success, farmerPoints);

  io.to(room.roomId).emit("game:public", snapshot(room));
  io.to(room.roomId).emit("game:over", {
    success,
    bid: g.bid,
    bankerPoints,
    farmerPoints,
    farmerTarget,
    bottomPoints,
    bottomPointsAdded: g.bottomPointsAdded || bottomPoints, // 底牌加成后的分数
    lastTrickWasDouble: g.lastTrickWasDouble || false, // 最后一墩是否为对子
    lastTrickWinnerId: g.turnId,
    bankerTeam: bankerTeam.map(p => ({ id: p.id, name: p.name })),
    finalScores: room.players.map(p => ({
      id: p.id,
      name: p.name,
      trickPoints: p.trickPoints,
      totalScore: p.totalScore
    })),
  });
}

// ===== 更新积分逻辑（提取函数） =====
function updateScores(players, g, success, farmerPoints) {
  // ✅ 计算庄家方玩家ID集合
  const bankerTeamIds = new Set(
    players.filter(p => p.id === g.bankerId || (p.isFriend && p.isRevealed)).map(p => p.id)
  );

  players.forEach(p => {
    const isBankerTeam = bankerTeamIds.has(p.id);

    if (success) {
      // 庄家方完成：庄家方加叫分，农民们全都获得农民总得分
      if (isBankerTeam) {
        p.totalScore += g.bid;
      } else {
        p.totalScore += farmerPoints;
      }
    } else {
      // 庄家方失败：庄家方扣叫分，农民们全都获得农民总得分
      if (isBankerTeam) {
        p.totalScore -= g.bid;
      } else {
        p.totalScore += farmerPoints;
      }
    }
  });
}


io.on("connection", (socket) => {
  // 创建房间
  socket.on("room:create", ({ name }, cb) => {
    const roomId = genRoomId();
    const room = {
      roomId,
      ownerId: socket.id,
      players: [],
      deck: [],
      game: {
        started: false,
        phase: "LOBBY",
        actorId: null,
        turnId: null,

        bid: 0,
        bankerId: null,
        trumpSuit: null,

        friendCount: 2,
        friendDeclaration: "", // 庄家的朋友声明（任意文字）
        friendMarks: new Set(), // 庄家标记的朋友ID集合

        bottomNeed: CONFIG.BOTTOM_CARDS_6P,
        bottomCards: [],
        bottomPhase: "HIDDEN", // "HIDDEN" | "WITH_BANKER" | "REVEALED"

        currentTrick: { plays: [] },
        table: [],
        trickNo: 1,
      },
    };
    rooms.set(roomId, room);

    sendSuccess(cb, { roomId });
  });

  // 加入房间（最多 6 人）
  socket.on("room:join", ({ roomId, name }, cb) => {
    const room = ensureRoom(roomId);
    if (!room) return sendError(cb, "房间不存在");

    // 检查是否是重连玩家
    const existingPlayer = room.players.find(p => p.id === socket.id);
    if (existingPlayer) {
      existingPlayer.connected = true;
      socket.join(roomId);
      io.to(socket.id).emit("hand:deal", { hand: existingPlayer.hand });
      io.to(roomId).emit("room:state", snapshot(room));
      return sendSuccess(cb);
    }

    if (room.players.length >= CONFIG.MAX_PLAYERS) {
      return sendError(cb, `房间已满(最多${CONFIG.MAX_PLAYERS}人)`);
    }

    socket.join(roomId);
    room.players.push({
      id: socket.id,
      name: name || "player",
      ready: false,
      connected: true,
      hand: [],
      trickPoints: 0,
      totalScore: 0,
      isFriend: false,
      isRevealed: false,
    });

    io.to(roomId).emit("room:state", snapshot(room));
    sendSuccess(cb);
  });

  // 准备/取消
  socket.on("room:ready", ({ roomId, ready }, cb) => {
    const room = ensureRoom(roomId);
    if (!room) return sendError(cb, "房间不存在");

    const p = room.players.find(x => x.id === socket.id);
    if (!p) return sendError(cb, "你不在房间内");

    p.ready = !!ready;
    io.to(roomId).emit("room:state", snapshot(room));
    sendSuccess(cb);
  });

  // 房主开始（进入叫分）
  socket.on("game:start", ({ roomId }, cb) => {
    const room = ensureRoom(roomId);
    if (!room) return sendError(cb, "房间不存在");
    if (room.ownerId !== socket.id) return sendError(cb, "只有房主能开始");

    const playerCount = room.players.length;
    if (playerCount < CONFIG.MIN_PLAYERS || playerCount > CONFIG.MAX_PLAYERS) {
      return sendError(cb, `需要 ${CONFIG.MIN_PLAYERS}-${CONFIG.MAX_PLAYERS} 人才能开始`);
    }
    if (!room.players.every(p => p.ready)) return sendError(cb, "有人没准备");

    room.deck = shuffle(newDeck());
    const g = room.game;

    // 根据人数决定底牌数量和队伍配置
    const bottomNeed = playerCount === 5 ? CONFIG.BOTTOM_CARDS_5P : CONFIG.BOTTOM_CARDS_6P;
    const friendCount = playerCount === 5 ? 1 : 2; // 5人局：2打3；6人局：3打3
    const cardsPerPlayer = Math.floor((CONFIG.DECK_SIZE - bottomNeed) / playerCount);

    // 进入新局初始化
    g.started = true;
    g.phase = "BID";
    g.actorId = room.players[0].id;
    g.turnId = null;

    g.bid = 0;
    g.bankerId = null;
    g.trumpSuit = null;

    g.friendCalls = [];
    g.friendCount = friendCount;
    g.friendDeclaration = "";
    g.friendMarks = new Set();

    g.bottomNeed = bottomNeed;
    g.bottomCards = [];
    g.bottomPhase = "HIDDEN";

    g.currentTrick = { plays: [] };
    g.table = [];
    g.trickNo = 1;

    // 清分和重置朋友身份
    room.players.forEach(p => {
      p.trickPoints = 0;
      p.isFriend = false;
      p.isRevealed = false;
    });

    // 发牌：每人相同张数
    for (const p of room.players) {
      p.hand = room.deck.splice(0, cardsPerPlayer);
      io.to(p.id).emit("hand:deal", { hand: p.hand });
    }

    // 底牌（背面朝上，服务器保存牌面，前端不公开）
    g.bottomCards = room.deck.splice(0, bottomNeed);
    g.bottomPhase = "HIDDEN";

    io.to(roomId).emit("game:public", snapshot(room));
    sendSuccess(cb);
  });

  // 叫分（简化：>=120 或 0）
  socket.on("bid:place", ({ roomId, bid }, cb) => {
    const room = ensureRoom(roomId);
    if (!room) return sendError(cb, "房间不存在");
    const g = room.game;

    if (!g.started || g.phase !== "BID") return sendError(cb, "不在叫分阶段");
    if (g.actorId !== socket.id) return sendError(cb, "没轮到你叫分");

    bid = Number(bid || 0);
    if (bid !== 0 && bid < CONFIG.MIN_BID) {
      return sendError(cb, `起叫 ${CONFIG.MIN_BID}，或 0 不叫`);
    }

    // 最大叫分胜出（简化）
    if (bid > g.bid) {
      g.bid = bid;
      g.bankerId = socket.id;
    }

    // 下一个叫分人
    const idx = room.players.findIndex(p => p.id === socket.id);
    g.actorId = room.players[(idx + 1) % room.players.length].id;

    // 叫分一圈结束：回到起始玩家
    if (g.actorId === room.players[0].id) {
      if (!g.bankerId) {
        g.bankerId = room.players[0].id;
      }
      g.phase = "SET_TRUMP";
      g.actorId = g.bankerId;
    }

    io.to(roomId).emit("game:public", snapshot(room));
    sendSuccess(cb);
  });

  // 定主（庄家）
  socket.on("trump:set", ({ roomId, suit }, cb) => {
    const room = ensureRoom(roomId);
    if (!room) return sendError(cb, "房间不存在");
    const g = room.game;

    if (!g.started || g.phase !== "SET_TRUMP") return sendError(cb, "不在定主阶段");
    if (g.actorId !== socket.id) return sendError(cb, "只有庄家能定主");

    suit = String(suit || "").toUpperCase();
    if (!["S","H","D","C"].includes(suit)) return sendError(cb, "花色只能 S/H/D/C");

    g.trumpSuit = suit;
    g.phase = "CALL_FRIENDS";
    g.actorId = g.bankerId;

    io.to(roomId).emit("game:public", snapshot(room));
    sendSuccess(cb);
  });

  // 找朋友（庄家）- 新版：只输入声明文字
  socket.on("friends:declare", ({ roomId, declaration }, cb) => {
    const room = ensureRoom(roomId);
    if (!room) return sendError(cb, "房间不存在");
    const g = room.game;

    if (!g.started || g.phase !== "CALL_FRIENDS") return sendError(cb, "不在找朋友阶段");
    if (g.actorId !== socket.id) return sendError(cb, "只有庄家能找朋友");

    // 保存声明文字（显示在公示栏）
    g.friendDeclaration = String(declaration || "未声明").trim();
    g.friendMarks = new Set(); // 重置标记

    // 进入扣底前：庄家收底
    const banker = room.players.find(p => p.id === g.bankerId);
    if (!banker) return sendError(cb, "庄家不存在");

    if (g.bottomPhase === "HIDDEN" && Array.isArray(g.bottomCards) && g.bottomCards.length) {
      banker.hand.push(...g.bottomCards);
      g.bottomCards = [];
      g.bottomPhase = "WITH_BANKER";
      io.to(banker.id).emit("hand:deal", { hand: banker.hand });
    }

    g.phase = "DISCARD_BOTTOM";
    g.actorId = g.bankerId;

    io.to(roomId).emit("game:public", snapshot(room));
    sendSuccess(cb);
  });

  // 标记/取消朋友（游戏过程中随时可调整）
  socket.on("friends:mark", ({ roomId, playerId, isFriend }, cb) => {
    const room = ensureRoom(roomId);
    if (!room) return sendError(cb, "房间不存在");
    const g = room.game;

    if (socket.id !== g.bankerId) return sendError(cb, "只有庄家能标记朋友");

    // ✅ 允许标记自己（1打5战术）
    const targetPlayer = room.players.find(p => p.id === playerId);
    if (!targetPlayer) return sendError(cb, "玩家不存在");

    if (isFriend) {
      g.friendMarks.add(playerId);
    } else {
      g.friendMarks.delete(playerId);
    }

    // 只发送给庄家（其他人看不到标记）
    io.to(socket.id).emit("friends:marks", {
      marks: Array.from(g.friendMarks),
      declaration: g.friendDeclaration
    });

    sendSuccess(cb, { currentMarks: g.friendMarks.size });
  });

  // 扣底（庄家选 N 张放回底牌框，背面朝下）
  socket.on("bottom:discard", ({ roomId, cards }, cb) => {
    const room = ensureRoom(roomId);
    if (!room) return sendError(cb, "房间不存在");
    const g = room.game;

    if (!g.started || g.phase !== "DISCARD_BOTTOM") return sendError(cb, "不在扣底阶段");
    if (g.actorId !== socket.id) return sendError(cb, "只有庄家能扣底");

    const banker = room.players.find(p => p.id === g.bankerId);
    if (!banker) return sendError(cb, "庄家不存在");

    if (!Array.isArray(cards) || cards.length !== g.bottomNeed) {
      return sendError(cb, `需要扣 ${g.bottomNeed} 张`);
    }

    // 校验都在手牌里
    for (const c of cards) {
      if (!banker.hand.includes(c)) return sendError(cb, "扣底牌不在你手牌里");
    }

    // 从手牌移除
    for (const c of cards) {
      const i = banker.hand.indexOf(c);
      if (i >= 0) banker.hand.splice(i, 1);
    }

    // 放回底牌框（背面朝下）
    g.bottomCards = cards.slice();
    g.bottomPhase = "HIDDEN";

    // 刷新庄家手牌
    io.to(banker.id).emit("hand:deal", { hand: banker.hand });

    // 进入出牌阶段：庄家先出
    g.phase = "PLAY";
    g.turnId = g.bankerId;
    g.actorId = null;
    g.currentTrick = { plays: [] };

    io.to(roomId).emit("game:public", snapshot(room));
    sendSuccess(cb);
  });

  // 出牌（支持单张或对子）
  socket.on("move:play", ({ roomId, card, cards }, cb) => {
    const room = ensureRoom(roomId);
    if (!room) return sendError(cb, "房间不存在");

    const g = room.game;
    if (!g.started || g.phase !== "PLAY") return sendError(cb, "不在出牌阶段");
    if (g.turnId !== socket.id) return sendError(cb, "没轮到你");

    const p = room.players.find(x => x.id === socket.id);
    if (!p) return sendError(cb, "你不在房间");

    // ✅ 兼容旧版单张出牌和新版多张出牌
    let cardsToPlay = [];
    if (cards && Array.isArray(cards)) {
      cardsToPlay = cards;
    } else if (card) {
      cardsToPlay = [card];
    } else {
      return sendError(cb, "未指定出牌");
    }

    // 限制最多2张牌
    if (cardsToPlay.length === 0 || cardsToPlay.length > 2) {
      return sendError(cb, "只能出1张或2张牌");
    }

    // 验证所有牌都在手中
    for (const c of cardsToPlay) {
      if (!p.hand.includes(c)) {
        return sendError(cb, `牌 ${c} 不在你的手牌中`);
      }
    }

    // ===== 出牌规则验证 =====
    const currentTrick = g.currentTrick.plays || [];
    const isPairPlay = cardsToPlay.length === 2;

    // ✅ 如果是第一家出牌，验证对子
    if (currentTrick.length === 0) {
      if (isPairPlay && !isPair(cardsToPlay[0], cardsToPlay[1])) {
        return sendError(cb, "两张牌必须是对子（同花色、同点数、不同副本）");
      }
    }

    // ✅ 如果不是第一家，进行跟牌规则验证
    if (currentTrick.length > 0) {
      const firstPlay = currentTrick[0];
      const firstCards = Array.isArray(firstPlay.cards) ? firstPlay.cards : [firstPlay.card];
      const isFirstPair = firstCards.length === 2;

      // ✅ 第一家出对子，其他人也必须出2张牌
      if (isFirstPair && cardsToPlay.length !== 2) {
        return sendError(cb, "第一家出了对子，你必须出2张牌");
      }

      // ✅ 第一家出单张，其他人也必须出单张
      if (!isFirstPair && cardsToPlay.length !== 1) {
        return sendError(cb, "第一家出了单张，你只能出1张牌");
      }

      const firstCard = firstCards[0];
      const { suit: firstSuit } = parseCardId(firstCard);
      const isFirstTrump = isTrumpCard(firstCard, g.trumpSuit);

      // ✅ 收集同花色的牌
      const sameSuitCards = p.hand.filter(c => {
        const { suit: cSuit } = parseCardId(c);
        const isCTrump = isTrumpCard(c, g.trumpSuit);
        if (isFirstTrump) {
          return isCTrump;
        } else {
          return !isCTrump && cSuit === firstSuit;
        }
      });

      // ✅ 收集同花色的对子
      const sameSuitPairs = [];
      for (let i = 0; i < sameSuitCards.length; i++) {
        for (let j = i + 1; j < sameSuitCards.length; j++) {
          if (isPair(sameSuitCards[i], sameSuitCards[j])) {
            sameSuitPairs.push([sameSuitCards[i], sameSuitCards[j]]);
          }
        }
      }

      // ✅ 如果第一家出对子
      if (isFirstPair) {
        // 有同花色对子，必须出对子
        if (sameSuitPairs.length > 0) {
          // ✅ 验证是否为对子
          if (!isPair(cardsToPlay[0], cardsToPlay[1])) {
            return sendError(cb, `你有同花色对子，必须出对子（同花色、同点数、不同副本）！`);
          }

          const myCardsSorted = cardsToPlay.slice().sort();
          const hasValidPair = sameSuitPairs.some(pair => {
            const pairSorted = pair.slice().sort();
            return JSON.stringify(myCardsSorted) === JSON.stringify(pairSorted);
          });

          if (!hasValidPair) {
            return sendError(cb, `你有同花色对子，必须出对子！`);
          }
        }
        // 没有同花色对子，但有同花色单牌
        else if (sameSuitCards.length > 0) {
          // 至少要有1张同花色的牌
          const sameSuitCount = cardsToPlay.filter(c => sameSuitCards.includes(c)).length;
          if (sameSuitCount === 0) {
            return sendError(cb, `你有同花色的牌，必须至少出1张同花色牌！`);
          }

          // 如果有≥2张同花色单牌，必须出2张同花色牌凑数
          if (sameSuitCards.length >= 2) {
            const allFromSameSuit = cardsToPlay.every(c => sameSuitCards.includes(c));
            if (!allFromSameSuit) {
              return sendError(cb, "你有2张以上同花色单牌，必须出2张同花色的牌");
            }
          }
          // 如果只有1张同花色单牌，出这1张 + 任意1张其他牌凑数
          else if (sameSuitCards.length === 1) {
            if (sameSuitCount !== 1) {
              return sendError(cb, "你只有1张同花色牌，必须出这张牌 + 任意1张其他牌凑数");
            }
          }
        }
        // 完全没有该花色，可以垫牌或杀牌（任意2张，不要求是对子）
      }
      // ✅ 如果第一家出单张
      else {
        if (sameSuitCards.length > 0 && !sameSuitCards.includes(cardsToPlay[0])) {
          return sendError(cb, `必须跟花色出牌！`);
        }
      }
    }

    // ✅ 出牌：从手牌中移除
    for (const c of cardsToPlay) {
      const i = p.hand.indexOf(c);
      if (i >= 0) p.hand.splice(i, 1);
    }

    // ✅ 记录出牌（兼容单张和对子）
    if (isPairPlay) {
      g.currentTrick.plays.push({ playerId: p.id, cards: cardsToPlay });
      g.table.push({ trickNo: g.trickNo, playerId: p.id, cards: cardsToPlay });
    } else {
      g.currentTrick.plays.push({ playerId: p.id, card: cardsToPlay[0] });
      g.table.push({ trickNo: g.trickNo, playerId: p.id, card: cardsToPlay[0] });
    }

    // 刷新出牌者的私有手牌
    io.to(p.id).emit("hand:deal", { hand: p.hand });

    // 轮到下一个人
    const idx = room.players.findIndex(x => x.id === p.id);
    g.turnId = room.players[(idx + 1) % room.players.length].id;

    // ===== 一轮结束：所有人出完，判最大，赢家先出 =====
    if (g.currentTrick.plays.length === room.players.length) {
      let best = g.currentTrick.plays[0];

      // ✅ 比较规则：对子 > 凑数 > 垫牌；同样大小的牌，先出者获胜
      for (const play of g.currentTrick.plays.slice(1)) {
        const bestCards = Array.isArray(best.cards) ? best.cards : [best.card];
        const playCards = Array.isArray(play.cards) ? play.cards : [play.card];

        // 判断是否为真正的对子
        const bestIsPair = bestCards.length === 2 && isPair(bestCards[0], bestCards[1]);
        const playIsPair = playCards.length === 2 && isPair(playCards[0], playCards[1]);

        // 规则1：对子优先级 > 凑数
        if (playIsPair && !bestIsPair) {
          best = play;
          continue;
        }
        if (!playIsPair && bestIsPair) {
          continue; // 当前最佳是对子，新的是凑数，保持不变
        }

        // 规则2：都是对子 或 都是凑数 -> 比较最大的那张牌（同样大小时，先出者获胜，不更新best）
        const bestMaxCard = bestCards.reduce((max, c) =>
          compareCard(c, max, g.trumpSuit) ? c : max
        );
        const playMaxCard = playCards.reduce((max, c) =>
          compareCard(c, max, g.trumpSuit) ? c : max
        );

        // ✅ 只有严格大于时才更新（相等时保持先出者获胜）
        const playResult = compareCard(playMaxCard, bestMaxCard, g.trumpSuit);
        const bestResult = compareCard(bestMaxCard, playMaxCard, g.trumpSuit);

        // playMaxCard 严格大于 bestMaxCard（不是相等）
        if (playResult && !bestResult) {
          best = play;
        }
      }

      const winnerId = best.playerId;
      const winner = room.players.find(x => x.id === winnerId);

      // ✅ 计算本轮积分（包括对子的所有牌）
      const allCards = g.currentTrick.plays.flatMap(p =>
        Array.isArray(p.cards) ? p.cards : [p.card]
      );
      const trickPoints = calculatePoints(allCards);
      if (winner) {
        winner.trickPoints += trickPoints;
      }

      g.turnId = winnerId;
      g.trickNo += 1;
      g.currentTrick = { plays: [] };

      // ===== 胜利判定：所有人出完牌 =====
      const allFinished = room.players.every(p => p.hand.length === 0);
      if (allFinished) {
        // ✅ 计算底牌分数并加给最后一墩赢家
        const bottomPoints = calculatePoints(g.bottomCards);

        // ✅ 判断最后一墩是否为对子
        const lastPlayCards = Array.isArray(best.cards) ? best.cards : [best.card];
        const lastTrickWasDouble = lastPlayCards.length === 2;

        // ✅ 判断赢家是否为农民（不是庄家，也不是已揭示的朋友）
        const winnerIsFarmer = winner &&
          winner.id !== g.bankerId &&
          !(winner.isFriend && winner.isRevealed);

        let bottomMultiplier = 1; // 默认不加倍
        if (winnerIsFarmer) {
          // 农民赢最后一墩：底牌×2（对子则×4）
          bottomMultiplier = lastTrickWasDouble
            ? CONFIG.BOTTOM_MULTIPLIER_DOUBLE
            : CONFIG.BOTTOM_MULTIPLIER_NORMAL;
        }

        const bottomPointsAdded = bottomPoints * bottomMultiplier;

        if (winner) {
          winner.trickPoints += bottomPointsAdded;
        }

        // ✅ 保存底牌加成信息（用于结算显示）
        g.bottomPointsAdded = bottomPointsAdded;
        g.lastTrickWasDouble = lastTrickWasDouble;

        g.phase = "SELECT_FRIENDS";
        g.actorId = g.bankerId;

        // 通知庄家选择朋友
        io.to(g.bankerId).emit("friends:needConfirm", {
          players: room.players.filter(p => p.id !== g.bankerId).map(p => ({
            id: p.id,
            name: p.name
          })),
          currentMarks: Array.from(g.friendMarks),
          declaration: g.friendDeclaration
        });

        io.to(room.roomId).emit("game:public", snapshot(room));
        return sendSuccess(cb, { phase: "SELECT_FRIENDS" });
      }
    }

    io.to(room.roomId).emit("game:public", snapshot(room));
    sendSuccess(cb);
  });

  // 确认朋友并结算（游戏结束时）
  socket.on("friends:confirm", ({ roomId, friendIds }, cb) => {
    const room = ensureRoom(roomId);
    if (!room) return sendError(cb, "房间不存在");
    const g = room.game;

    if (g.phase !== "SELECT_FRIENDS") return sendError(cb, "不在选择朋友阶段");
    if (socket.id !== g.bankerId) return sendError(cb, "只有庄家能确认朋友");

    if (!Array.isArray(friendIds)) friendIds = [];

    // ✅ 不限制朋友数量，支持 0-5 人（1打5到6打0）
    if (friendIds.length > room.players.length - 1) {
      return sendError(cb, "朋友数量超过玩家总数");
    }

    // 标记朋友身份
    room.players.forEach(p => {
      p.isFriend = friendIds.includes(p.id);
      p.isRevealed = friendIds.includes(p.id);
    });

    // 进入结算
    endGame(room, g);
    sendSuccess(cb);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const p = room.players.find(x => x.id === socket.id);
      if (p) {
        p.connected = false;
        io.to(room.roomId).emit("room:state", snapshot(room));
      }
    }
  });
});

server.listen(3000, () => {
  console.log("Server running: http://localhost:3000");
});
