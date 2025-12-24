const socket = io({
  transports: ["websocket"], // 本地/远程都稳
});

let myId = "";
let currentRoomId = "";
let ready = false;

let myHand = [];
let lastSnap = null;

// ✅ 出牌选择（支持多选）
let playSelection = [];

// ✅ 随机名字生成 =====
function generateRandomName() {
  const adjectives = [
    "勇敢的", "聪明的", "幸运的", "快乐的", "神秘的",
    "强大的", "优雅的", "冷静的", "热情的", "睿智的",
    "灵巧的", "无畏的", "温柔的", "机智的", "坚定的",
    "活泼的", "沉着的", "敏捷的", "果断的", "慷慨的"
  ];

  const nouns = [
    "狮子", "老虎", "猎豹", "雄鹰", "巨龙",
    "猎人", "战士", "法师", "骑士", "游侠",
    "剑客", "智者", "勇士", "冒险家", "探险者",
    "高手", "大师", "天才", "英雄", "传奇"
  ];

  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 100);

  return `${adj}${noun}${num}`;
}

// ✅ 手牌排序缓存
let sortedHandCache = null;
let lastHandHash = "";

// ✅ 朋友标记（庄家视角）
let friendMarks = new Set();

// 扣底模式
let discardMode = false;
let discardPick = [];

// 自动弹窗防抖
let autoDone = {
  trump: false,
  friends: false,
};

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  $("log").textContent = msg + "\n" + $("log").textContent;
};

// ===== 模态对话框（替代 prompt） =====
function showModal(title, placeholder, defaultValue = "") {
  return new Promise((resolve) => {
    const modal = $("modal");
    const input = $("modalInput");
    const titleEl = $("modalTitle");
    const confirmBtn = $("modalConfirm");
    const cancelBtn = $("modalCancel");

    titleEl.textContent = title;
    input.placeholder = placeholder;
    input.value = defaultValue;
    modal.style.display = "flex";
    input.focus();
    input.select();

    const cleanup = () => {
      modal.style.display = "none";
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      input.onkeydown = null;
    };

    confirmBtn.onclick = () => {
      const value = input.value.trim();
      cleanup();
      resolve(value || null);
    };

    cancelBtn.onclick = () => {
      cleanup();
      resolve(null);
    };

    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        confirmBtn.click();
      } else if (e.key === "Escape") {
        cancelBtn.click();
      }
    };
  });
}

// ===== 错误提示弹窗（只有确认按钮） =====
function showError(title, message) {
  return new Promise((resolve) => {
    const modal = $("modal");
    const input = $("modalInput");
    const titleEl = $("modalTitle");
    const confirmBtn = $("modalConfirm");
    const cancelBtn = $("modalCancel");

    titleEl.textContent = title;
    input.style.display = "none"; // 隐藏输入框
    cancelBtn.style.display = "none"; // 隐藏取消按钮

    // 用输入框的位置显示错误消息
    const msgDiv = document.createElement("div");
    msgDiv.id = "errorMessage";
    msgDiv.style.cssText = "padding: 12px; margin-bottom: 16px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; color: #856404; line-height: 1.5;";
    msgDiv.textContent = message;
    input.parentNode.insertBefore(msgDiv, input);

    modal.style.display = "flex";
    confirmBtn.focus();

    const cleanup = () => {
      modal.style.display = "none";
      input.style.display = "block";
      cancelBtn.style.display = "block";
      const msgEl = document.getElementById("errorMessage");
      if (msgEl) msgEl.remove();
      confirmBtn.onclick = null;
    };

    confirmBtn.onclick = () => {
      cleanup();
      resolve();
    };
  });
}

socket.on("connect", () => {
  myId = socket.id;

  // ✅ 页面加载时设置随机名字
  if (!$("name").value || $("name").value === "player") {
    $("name").value = generateRandomName();
  }
});

// --- 花色/阶段中文 ---
function suitIcon(s){
  const m = { S:"♠", H:"♥", D:"♦", C:"♣" };
  return m[s] || s || "-";
}
function isRedSuit(s){ return s === "H" || s === "D"; }

function phaseCN(phase){
  const m = {
    LOBBY: "等待准备",
    BID: "叫分中",
    SET_TRUMP: "定主中",
    CALL_FRIENDS: "找朋友中",
    DISCARD_BOTTOM: "扣底中",
    PLAY: "出牌中",
    OVER: "本局结束",
  };
  return m[phase] || phase || "-";
}

// 解析 cardId：H-10-2 / J-BJ-1
function parseCardId(cardId){
  const [suit, rank, copy] = String(cardId).split("-");
  return { suit, rank, copy };
}

// 判断两张牌是否是对子
function isPair(card1, card2){
  const c1 = parseCardId(card1);
  const c2 = parseCardId(card2);
  return c1.suit === c2.suit && c1.rank === c2.rank && c1.copy !== c2.copy;
}

// 点数映射（用于排序）
function rankValForSort(rank){
  // 3..10, JQK, A
  if (rank === "A") return 14;
  if (rank === "K") return 13;
  if (rank === "Q") return 12;
  if (rank === "J") return 11;
  return Number(rank); // 2..10
}

// ===== 手牌排序（花色分组 + 2/王单独放右侧） =====
// 规则：
// 1) 先按花色分组（♠ ♥ ♦ ♣），组内从小到大（3..A）
// 2) 如果已定主，将主花色的副牌单独分组放在最右
// 3) 再放 "副2"（非主花色2）
// 4) 再放 "主2"（主花色2）
// 5) 再放 小王、大王（都在最右）
function sortHandWithGroups(hand){
  const g = lastSnap?.game || {};
  const trump = g.trumpSuit || null;

  // 调整花色顺序：黑桃、红心、方片、梅花
  const suitOrder = { S:1, H:2, D:3, C:4 };

  const normalCards = [];    // 非主花色的普通牌
  const trumpNormalCards = []; // 主花色的普通牌（非2）
  const twosVice = [];        // 副2
  const twosMain = [];        // 主2
  const jokersSmall = [];     // 小王
  const jokersBig = [];       // 大王

  for (const cid of (hand || [])) {
    const c = parseCardId(cid);

    // 大小王
    if (c.suit === "J") {
      if (c.rank === "BJ") jokersBig.push(cid);
      else jokersSmall.push(cid);
      continue;
    }

    // 2
    if (c.rank === "2") {
      if (trump && c.suit === trump) twosMain.push(cid);
      else twosVice.push(cid);
      continue;
    }

    // 普通牌：如果已定主，区分主花色和非主花色
    if (trump && c.suit === trump) {
      trumpNormalCards.push(cid);
    } else {
      normalCards.push(cid);
    }
  }

  // 非主花色普通牌：按花色 -> 点数从小到大 -> copy
  normalCards.sort((a,b)=>{
    const A = parseCardId(a), B = parseCardId(b);
    const sa = suitOrder[A.suit] ?? 99;
    const sb = suitOrder[B.suit] ?? 99;
    if (sa !== sb) return sa - sb;
    const ra = rankValForSort(A.rank), rb = rankValForSort(B.rank);
    if (ra !== rb) return ra - rb;
    return Number(A.copy||0) - Number(B.copy||0);
  });

  // 主花色普通牌：按点数从小到大 -> copy
  trumpNormalCards.sort((a,b)=>{
    const A = parseCardId(a), B = parseCardId(b);
    const ra = rankValForSort(A.rank), rb = rankValForSort(B.rank);
    if (ra !== rb) return ra - rb;
    return Number(A.copy||0) - Number(B.copy||0);
  });

  // 2：副2按花色 -> copy；主2按 copy
  const bySuitCopy = (a,b)=>{
    const A = parseCardId(a), B = parseCardId(b);
    const sa = suitOrder[A.suit] ?? 99;
    const sb = suitOrder[B.suit] ?? 99;
    if (sa !== sb) return sa - sb;
    return Number(A.copy||0) - Number(B.copy||0);
  };
  twosVice.sort(bySuitCopy);
  twosMain.sort(bySuitCopy);

  // 王：先小后大；每组按 copy
  const byCopy = (a,b)=> Number(parseCardId(a).copy||0) - Number(parseCardId(b).copy||0);
  jokersSmall.sort(byCopy);
  jokersBig.sort(byCopy);

  return {
    sorted: [...normalCards, ...trumpNormalCards, ...twosVice, ...twosMain, ...jokersSmall, ...jokersBig],
    groups: { normalCards, trumpNormalCards, twosVice, twosMain, jokersSmall, jokersBig }
  };
}

// ===== 牌面显示（UI） =====

// 2~10 国标点位布局（简化版）：按格子摆放
function renderPipsHTML(suit, rank, redClass){
  const suitChar = suitIcon(suit);
  const n = Number(rank);
  const map = {
    2:[2,8],
    3:[2,5,8],
    4:[1,3,7,9],
    5:[1,3,5,7,9],
    6:[1,3,4,6,7,9],
    7:[1,3,4,5,6,7,9],
    8:[1,2,3,4,6,7,8,9],
    9:[1,2,3,4,5,6,7,8,9],
    10:[1,2,3,4,4.5,5.5,6,7,8,9], // 10 做一点“加密”
  };
  const pos = map[n] || [5];
  const cells = [];

  // 3x3 网格（1..9）+ 10 特例（4.5/5.5）
  for (const p of pos) {
    if (p === 4.5) { cells.push(`<div class="${redClass}" style="grid-column:2;grid-row:2;transform:translateY(-12px)">${suitChar}</div>`); continue; }
    if (p === 5.5) { cells.push(`<div class="${redClass}" style="grid-column:2;grid-row:2;transform:translateY(12px)">${suitChar}</div>`); continue; }
    const idx = Math.floor(p);
    const r = Math.floor((idx-1)/3)+1;
    const c = ((idx-1)%3)+1;
    const flip = (idx >= 7) ? "transform:rotate(180deg);" : "";
    cells.push(`<div class="${redClass}" style="grid-column:${c};grid-row:${r};${flip}">${suitChar}</div>`);
  }

  return `<div class="cardPips">${cells.join("")}</div>`;
}

// 手牌大牌：去掉 2-10 角标花色；JQK 中间只字母
function cardFaceHTML(cardId){
  const c = parseCardId(cardId);

  // Joker
  if (c.suit === "J") {
    const name = c.rank === "BJ" ? "大王" : "小王";
    return `
      <div class="cardCorner tl">
        <div class="cardJoker">${name}</div>
      </div>
      <div class="cardSuitBig">🃏</div>
      <div class="cardCorner br">
        <div class="cardJoker">${name}</div>
      </div>
    `;
  }

  const suit = suitIcon(c.suit);
  const redClass = isRedSuit(c.suit) ? "cardRed" : "cardBlack";
  const rank = c.rank;

  const isPip = /^[2-9]$/.test(rank) || rank === "10";
  const isFace = ["J","Q","K"].includes(rank);

  // 2~10：角标只留数字（不显示小花色）
  if (isPip) {
    return `
      <div class="cardCorner tl ${redClass}"><div>${rank}</div></div>
      ${renderPipsHTML(c.suit, rank, redClass)}
      <div class="cardCorner br ${redClass}"><div>${rank}</div></div>
    `;
  }

  // J/Q/K：中间只显示粗体字母
  if (isFace) {
    return `
      <div class="cardCorner tl ${redClass}">
        <div>${rank}</div>
        <div>${suit}</div>
      </div>
      <div class="cardFaceLetter ${redClass}">${rank}</div>
      <div class="cardCorner br ${redClass}">
        <div>${rank}</div>
        <div>${suit}</div>
      </div>
    `;
  }

  // A：角标带花色，中间大花色
  return `
    <div class="cardCorner tl ${redClass}">
      <div>${rank}</div>
      <div>${suit}</div>
    </div>

    <div class="cardSuitBig ${redClass}">${suit}</div>

    <div class="cardCorner br ${redClass}">
      <div>${rank}</div>
      <div>${suit}</div>
    </div>
  `;
}

// 桌面小牌（用于出牌区/底牌翻面）
function cardMiniHTML(cardId){
  const c = parseCardId(cardId);

  if (c.suit === "J") {
    const name = c.rank === "BJ" ? "大王" : "小王";
    const jokerClass = c.rank === "SJ" ? "cardMini smallJoker" : "cardMini"; // ✅ 小王添加灰色样式
    return `
      <div class="${jokerClass}">
        <div class="cardCorner tl"><div>${name}</div></div>
        <div class="cardSuitBig">🃏</div>
        <div class="cardCorner br"><div>${name}</div></div>
      </div>
    `;
  }

  const suit = suitIcon(c.suit);
  const redClass = isRedSuit(c.suit) ? "cardRed" : "cardBlack";
  const rank = c.rank;

  const isPip = /^[2-9]$/.test(rank) || rank === "10";
  const isFace = ["J","Q","K"].includes(rank);

  if (isPip) {
    return `
      <div class="cardMini">
        <div class="cardCorner tl ${redClass}"><div>${rank}</div></div>
        <div class="cardSuitBig ${redClass}">${suit}</div>
        <div class="cardCorner br ${redClass}"><div>${rank}</div></div>
      </div>
    `;
  }

  if (isFace) {
    return `
      <div class="cardMini">
        <div class="cardCorner tl ${redClass}"><div>${rank}</div><div>${suit}</div></div>
        <div class="cardMiniLetter ${redClass}">${rank}</div>
        <div class="cardCorner br ${redClass}"><div>${rank}</div><div>${suit}</div></div>
      </div>
    `;
  }

  // A
  return `
    <div class="cardMini">
      <div class="cardCorner tl ${redClass}"><div>${rank}</div><div>${suit}</div></div>
      <div class="cardSuitBig ${redClass}">${suit}</div>
      <div class="cardCorner br ${redClass}"><div>${rank}</div><div>${suit}</div></div>
    </div>
  `;
}

function nameOf(id) {
  if (!lastSnap) return id;
  const p = lastSnap.players.find(x => x.id === id);
  return p ? p.name : id;
}

function activeIdFromSnap(snap){
  const g = snap?.game;
  if (!g) return null;

  if (g.phase === "PLAY") return g.turnId;
  if (["BID","SET_TRUMP","CALL_FRIENDS","DISCARD_BOTTOM"].includes(g.phase)) return g.actorId;
  return null;
}

// ===== 花色转换：支持中文输入 =====
function parseTrumpSuit(input) {
  if (!input) return null;
  const s = String(input).trim().toUpperCase();

  // 支持中文输入
  const chineseMap = {
    "黑桃": "S",
    "红桃": "H", "红心": "H",
    "方片": "D", "方块": "D",
    "梅花": "C", "草花": "C"
  };

  if (chineseMap[input.trim()]) {
    return chineseMap[input.trim()];
  }

  // 支持英文缩写
  if (["S", "H", "D", "C"].includes(s)) {
    return s;
  }

  return null;
}

// ===== UI：中心盘/右上公示栏/底牌框 =====

function updateHudAndPhase(){
  if (!lastSnap) return;
  const g = lastSnap.game || {};
  const phaseTextCN = phaseCN(g.phase);

  // 中心圆盘
  if ($("phaseText")) $("phaseText").textContent = phaseTextCN;
  if ($("actorText")) $("actorText").textContent = (activeIdFromSnap(lastSnap) ? nameOf(activeIdFromSnap(lastSnap)) : "-");

  // ✅ 顶部横栏公告栏
  if ($("topPhase")) $("topPhase").textContent = phaseTextCN;
  if ($("topBid")) $("topBid").textContent = g.bid > 0 ? `${g.bid} 分` : "-"; // ✅ 显示叫分
  if ($("topTrump")) $("topTrump").textContent = g.trumpSuit ? suitIcon(g.trumpSuit) : "-";
  if ($("topFriends")) $("topFriends").textContent = g.friendDeclaration || "-";

  // 底牌状态
  const b = lastSnap.bottom || {};
  const state = b.state || g.bottomState || "BOX";
  const bottomPhase = b.phase || g.bottomPhase || "HIDDEN";
  const faceUp = bottomPhase === "REVEALED"; // ✅ 根据 bottomPhase 判断是否翻面
  let bottomTxt = "背面(6)";
  if (state === "TAKEN") bottomTxt = "庄家已收底";
  if (faceUp) bottomTxt = "已翻面(6)"; // ✅ 简化判断
  if ($("topBottom")) $("topBottom").textContent = bottomTxt;

  // 可能自动弹窗（只对庄家）
  maybeAutoPrompts();
}

function renderBottomBox(snap){
  const box = $("bottomCards");
  const st = $("bottomState");
  const bottomBoxEl = $("bottomBox");
  if (!box || !snap) return;

  const b = snap.bottom || {};
  const g = snap.game || {};
  const cap = b.capacity ?? g.bottomNeed ?? 6;
  const state = b.state || g.bottomState || "BOX";
  const bottomPhase = b.phase || g.bottomPhase || "HIDDEN";
  const faceUp = bottomPhase === "REVEALED"; // ✅ 根据 bottomPhase 判断是否翻面
  const cards = b.cards || null;
  const phase = g.phase || "LOBBY";

  // ✅ 只在扣底阶段和游戏结束时显示底牌框
  const shouldShow = phase === "DISCARD_BOTTOM" || phase === "OVER" || phase === "SELECT_FRIENDS";
  if (bottomBoxEl) {
    bottomBoxEl.style.display = shouldShow ? "block" : "none";
  }

  if (!shouldShow) return;

  if (st) {
    if (state === "TAKEN") st.textContent = "（已收底）";
    else if (faceUp) st.textContent = "（已翻面）";
    else st.textContent = "（背面）";
  }

  box.innerHTML = "";

  // 收底阶段：显示空槽
  if (state === "TAKEN") {
    for (let i=0;i<cap;i++){
      const d = document.createElement("div");
      d.className = "cardMini";
      d.style.background = "rgba(255,255,255,.10)";
      d.style.border = "1px dashed rgba(255,255,255,.35)";
      box.appendChild(d);
    }
    return;
  }

  // 在盒子里
  if (faceUp && Array.isArray(cards) && cards.length) {
    for (const cid of cards) {
      box.insertAdjacentHTML("beforeend", cardMiniHTML(cid));
    }
    // 不足补槽
    for (let i=cards.length;i<cap;i++){
      const d = document.createElement("div");
      d.className = "cardMini";
      d.style.background = "rgba(255,255,255,.10)";
      d.style.border = "1px dashed rgba(255,255,255,.35)";
      box.appendChild(d);
    }
  } else {
    // 背面朝上：固定 6 张背面
    for (let i=0;i<cap;i++){
      const d = document.createElement("div");
      d.className = "cardMini cardBack";
      box.appendChild(d);
    }
  }
}

// 自动弹窗：定主/找朋友（优化：使用模态框）
async function maybeAutoPrompts(){
  if (!lastSnap) return;
  const g = lastSnap.game || {};
  if (g.actorId !== myId) return;

  // 定主弹窗（一次）
  if (g.phase === "SET_TRUMP" && !autoDone.trump) {
    autoDone.trump = true;
    setTimeout(async () => {
      const s = await showModal(
        "你是庄家：定主花色",
        "输入：黑桃/红桃/方片/梅花，或 S/H/D/C",
        "红桃"
      );
      if (s === null) return;

      const suit = parseTrumpSuit(s);
      if (!suit) {
        await showError("定主失败", "花色格式错误，请输入 黑桃/红桃/方片/梅花 或 S/H/D/C");
        autoDone.trump = false; // 允许重试
        return;
      }

      socket.emit("trump:set", { roomId: currentRoomId, suit }, async (res) => {
        if (!res?.ok) {
          await showError("定主失败", res?.error || "未知错误");
        } else {
          log("定主成功：" + suit);
        }
      });
    }, 120);
  }

  // 找朋友弹窗（一次）- 新版：只输入声明文字
  if (g.phase === "CALL_FRIENDS" && !autoDone.friends) {
    autoDone.friends = true;
    setTimeout(async () => {
      const s = await showModal(
        "你是庄家：声明朋友",
        "例：两个红桃A / 第一个出5分的 / 打黑桃10的人",
        "两个红桃A"
      );
      if (s === null) return;
      socket.emit("friends:declare", { roomId: currentRoomId, declaration: s }, async (res) => {
        if (!res?.ok) {
          await showError("声明朋友失败", res?.error || "未知错误");
        } else {
          log("声明朋友成功：" + s + " -> 进入扣底");
        }
      });
    }, 120);
  }

  // 进入大厅时重置
  if (g.phase === "LOBBY") {
    autoDone.trump = false;
    autoDone.friends = false;
  }
}

// ===== 判断当前出牌区谁最大（用于高亮红框） =====
function determineCurrentWinner(currentTrick, trumpSuit) {
  if (!currentTrick || currentTrick.length === 0) return null;

  let best = currentTrick[0];

  // 复制服务器端的比较逻辑
  for (const play of currentTrick.slice(1)) {
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
      continue;
    }

    // 规则2：都是对子 或 都是凑数 -> 比较最大的那张牌（同样大小时，先出者获胜）
    const bestMaxCard = bestCards.reduce((max, c) =>
      compareCards(c, max, trumpSuit) ? c : max
    );
    const playMaxCard = playCards.reduce((max, c) =>
      compareCards(c, max, trumpSuit) ? c : max
    );

    // 只有严格大于时才更新（相等时保持先出者获胜）
    const playResult = compareCards(playMaxCard, bestMaxCard, trumpSuit);
    const bestResult = compareCards(bestMaxCard, playMaxCard, trumpSuit);

    if (playResult && !bestResult) {
      best = play;
    }
  }

  return best.playerId;
}

// ===== 客户端牌比较函数（复制服务器逻辑） =====
function compareCards(a, b, trumpSuit) {
  const A = parseCardId(a);
  const B = parseCardId(b);

  const isTrumpA = A.suit === "J" || A.rank === "2" || (trumpSuit && A.suit === trumpSuit);
  const isTrumpB = B.suit === "J" || B.rank === "2" || (trumpSuit && B.suit === trumpSuit);

  // 主牌 > 副牌
  if (isTrumpA && !isTrumpB) return true;
  if (!isTrumpA && isTrumpB) return false;

  // 都是主牌：按优先级比较
  if (isTrumpA && isTrumpB) {
    const isJokerA = A.suit === "J";
    const isJokerB = B.suit === "J";
    const is2A = A.rank === "2";
    const is2B = B.rank === "2";

    // 王之间比较
    if (isJokerA && isJokerB) return rankValForSort(A.rank) > rankValForSort(B.rank);
    if (isJokerA) return true;
    if (isJokerB) return false;

    // 2之间比较：主花色的2 > 其他2
    if (is2A && is2B) {
      const isMainTrump2A = trumpSuit && A.suit === trumpSuit;
      const isMainTrump2B = trumpSuit && B.suit === trumpSuit;
      if (isMainTrump2A && !isMainTrump2B) return true;
      if (!isMainTrump2A && isMainTrump2B) return false;
      // 同等级的2，认为相等（不比较copy）
      return false;
    }
    if (is2A) return true;
    if (is2B) return false;

    // 其他主牌按点数比较
    if (A.rank !== B.rank) return rankValForSort(A.rank) > rankValForSort(B.rank);
    return false; // 同点数认为相等
  }

  // 都是副牌：同花色比点数，不同花色无法比较
  if (A.suit === B.suit) {
    if (A.rank !== B.rank) return rankValForSort(A.rank) > rankValForSort(B.rank);
    return false; // 同点数认为相等
  }

  return false;
}

// ===== 手牌渲染（优化：添加排序缓存 + 支持出牌多选） =====
function renderHand() {
  const box = $("hand");
  box.innerHTML = "";

  const canPlay =
    lastSnap &&
    lastSnap.game.phase === "PLAY" &&
    lastSnap.game.turnId === myId;

  const canDiscard =
    lastSnap &&
    lastSnap.game.phase === "DISCARD_BOTTOM" &&
    lastSnap.game.actorId === myId;

  // ✅ 自动进入扣底选牌模式
  if (canDiscard && !discardMode) {
    discardMode = true;
    discardPick = [];
    playSelection = []; // 清空出牌选择
    const need = lastSnap.game.bottomNeed || 6;
    log(`进入扣底阶段：请从手牌中选择 ${need} 张，然后点击【确认扣底】提交`);
  }

  // ✅ 出牌阶段：清空扣底选择和出牌选择
  if (canPlay && discardMode) {
    discardMode = false;
    discardPick = [];
    playSelection = []; // 清空出牌选择
  }

  // ✅ 清理 playSelection 中不在手牌里的牌（防止手牌更新后残留旧卡牌ID）
  playSelection = playSelection.filter(cid => myHand.includes(cid));

  // ✅ 使用缓存：只有手牌变化时才重新排序
  const currentHash = myHand.join(",") + "|" + (lastSnap?.game?.trumpSuit || "");
  if (currentHash !== lastHandHash) {
    sortedHandCache = sortHandWithGroups(myHand);
    lastHandHash = currentHash;
  }
  const { sorted } = sortedHandCache;

  // 分组视觉间隔：花色变化/进入主花色区/进入2区/进入王区时插入分隔
  let lastSuit = null;
  let lastGroupType = null; // 'NORMAL', 'TRUMP_NORMAL', 'VICE2', 'MAIN2', 'JOKER'

  for (const cardId of sorted) {
    const c = parseCardId(cardId);
    const trump = lastSnap?.game?.trumpSuit || null;

    // 判断当前牌的分组类型
    let currentGroupType = 'NORMAL';
    if (c.suit === "J") {
      currentGroupType = 'JOKER';
    } else if (c.rank === "2") {
      currentGroupType = (trump && c.suit === trump) ? 'MAIN2' : 'VICE2';
    } else if (trump && c.suit === trump) {
      currentGroupType = 'TRUMP_NORMAL'; // 主花色普通牌
    }

    // 判断是否需要插入分隔线
    let needSeparator = false;

    if (lastGroupType === null) {
      // 第一张牌，不需要分隔线
      needSeparator = false;
    } else if (lastGroupType !== currentGroupType) {
      // 分组类型变化，需要分隔线
      needSeparator = true;
    } else if (currentGroupType === 'NORMAL' && lastSuit !== c.suit) {
      // 同为普通牌（非主花色），但花色变化，需要分隔线
      needSeparator = true;
    }

    if (needSeparator) {
      const sep = document.createElement("span");
      sep.className = "handSep";
      box.appendChild(sep);
    }

    lastSuit = c.suit;
    lastGroupType = currentGroupType;

    const btn = document.createElement("button");
    btn.className = "cardBtn";
    btn.innerHTML = cardFaceHTML(cardId);

    // ✅ 扣底模式高亮
    if (discardPick.includes(cardId)) btn.classList.add("selected");

    // ✅ 出牌模式高亮
    if (playSelection.includes(cardId)) btn.classList.add("selected");

    btn.onclick = async () => {
      if (!currentRoomId) {
        await showError("操作失败", "请先加入房间");
        return;
      }

      // ✅ 扣底选择
      if (discardMode && canDiscard) {
        if (discardPick.includes(cardId)) discardPick = discardPick.filter(x => x !== cardId);
        else discardPick.push(cardId);

        renderHand();
        log(`扣底选择：${discardPick.join(" , ")}`);
        return;
      }

      // ✅ 出牌选择（支持多选）
      if (!canPlay) {
        await showError("无法出牌", "现在不能出牌（未到你的回合，或不在出牌阶段）");
        return;
      }

      // 切换选择状态
      if (playSelection.includes(cardId)) {
        // 取消选择
        playSelection = playSelection.filter(x => x !== cardId);
      } else {
        // 添加选择
        if (playSelection.length === 0) {
          // 第一张牌：直接添加
          playSelection.push(cardId);
        } else if (playSelection.length === 1) {
          // 第二张牌：智能提示但允许选择
          const firstCard = parseCardId(playSelection[0]);
          const secondCard = parseCardId(cardId);

          // 判断是否为对子
          const isPairMatch = firstCard.suit === secondCard.suit &&
                              firstCard.rank === secondCard.rank &&
                              firstCard.copy !== secondCard.copy;

          // 如果不是对子，给出友好提示（但仍允许选择）
          if (!isPairMatch) {
            const suitMatch = firstCard.suit === secondCard.suit;
            if (suitMatch) {
              log(`⚠️ 注意：这两张牌不是对子，但可以用于凑数或垫牌`);
            } else {
              log(`⚠️ 注意：这两张牌花色不同，可能用于垫牌`);
            }
          }

          playSelection.push(cardId);
        } else {
          // 已经选了2张，不应该到这里
          playSelection = playSelection.slice(0, 2);
          await showError("选牌提示", "最多只能选择2张牌");
          renderHand();
          return;
        }
      }

      renderHand();

      // ✅ 如果选了1张或2张，显示提示
      if (playSelection.length === 1) {
        log(`已选择 1 张牌：${playSelection[0]}，再次点击可取消，或继续选择相同的牌组成对子`);
      } else if (playSelection.length === 2) {
        const firstCard = parseCardId(playSelection[0]);
        const secondCard = parseCardId(playSelection[1]);
        const isPair = firstCard.suit === secondCard.suit &&
                      firstCard.rank === secondCard.rank &&
                      firstCard.copy !== secondCard.copy;
        if (isPair) {
          log(`✅ 已选择对子：${playSelection.join(" + ")}，点击【确认出牌】提交`);
        } else {
          log(`已选择 2 张牌：${playSelection.join(" + ")}，点击【确认出牌】提交（非对子）`);
        }
      }
    };

    box.appendChild(btn);
  }

  // ✅ 添加确认出牌按钮（出牌阶段显示）
  if (canPlay && playSelection.length > 0) {
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btnConfirmPlay";
    confirmBtn.textContent = `✓ 确认出牌 (${playSelection.length}张)`;
    confirmBtn.onclick = async () => {
      if (playSelection.length === 0) {
        await showError("出牌失败", "请先选择要出的牌");
        return;
      }

      // 发送出牌请求
      socket.emit("move:play", { roomId: currentRoomId, cards: playSelection }, async (res) => {
        if (!res?.ok) {
          await showError("出牌失败", res?.error || "未知错误");
        } else {
          playSelection = []; // 清空选择
          renderHand();
        }
      });
    };
    box.appendChild(confirmBtn);
  }
}

// ===== 桌面：座位+出牌区+中心指针 =====
function renderTable(snap){
  const box = $("tablePlayers");
  const playLayer = $("playSlots");
  if (!box || !playLayer || !snap) return;

  const players = snap.players || [];
  const n = Math.max(players.length, 1);

  const myIndex = players.findIndex(p => p.id === myId);
  const offset = myIndex >= 0 ? myIndex : 0;

  // 用桌子真实大小（适配新尺寸）
  const core = $("tableCore");
  const W = core?.clientWidth || 1200;
  const H = core?.clientHeight || 650;
  const cx = W / 2, cy = H / 2;

  // 调整半径：座位在桌子外围，出牌区在桌子内部
  const seatRX = W * 0.48;  // 座位半径更大，在桌子外
  const seatRY = H * 0.52;
  const playRX = W * 0.30;  // 出牌区半径，在桌子内
  const playRY = H * 0.30;

  const activeId = activeIdFromSnap(snap);

  // 累积出牌（不消失）
  const allPlays = snap.game?.table || [];
  const playsByPlayer = new Map();
  for (const it of (allPlays || [])) {
    const pid = it.playerId || it.pid || it.id;
    const cards = it.cards || (it.card ? [it.card] : null);
    if (!pid || !cards) continue;
    if (!playsByPlayer.has(pid)) playsByPlayer.set(pid, []);
    playsByPlayer.get(pid).push(...cards);
  }

  box.innerHTML = "";
  playLayer.innerHTML = "";

  players.forEach((p, idx) => {
    const rel = (idx - offset + n) % n;

    // ✅ 自己固定在下端：从 +90° 开始；顺时针：减角度
    // ✅ 为了让指针指向“边中点”，6人时做半格偏移
    const edgeShift = (n === 6) ? 0.5 : 0;
    const angle = Math.PI/2 - (2*Math.PI*(rel + edgeShift))/n;

    const sx = cx + seatRX * Math.cos(angle);
    const sy = cy + seatRY * Math.sin(angle);

    const px = cx + playRX * Math.cos(angle);
    const py = cy + playRY * Math.sin(angle);

    // seat
    const seat = document.createElement("div");
    seat.className = "seat";
    seat.style.left = `${sx}px`;
    seat.style.top  = `${sy}px`;

    if (p.ready) seat.classList.add("ready");
    if (snap.game?.bankerId && p.id === snap.game.bankerId) seat.classList.add("banker");
    if (activeId && p.id === activeId) seat.classList.add("active");

    const firstChar = (p.name || "?").slice(0,1);

    // ✅ 庄家视角：添加标记朋友按钮
    const isBanker = snap.game?.bankerId === myId;
    const canMark = isBanker && (snap.game?.phase === "PLAY" || snap.game?.phase === "DISCARD_BOTTOM");
    const isMarked = friendMarks.has(p.id);

    seat.innerHTML = `
      <div class="avatar">${firstChar}</div>
      <div class="namePlate">${p.name || p.id}${p.isFriend && p.isRevealed ? ' 🤝' : ''}</div>
      <div class="meta">手牌：${p.cardsLeft ?? 0} 张</div>
      ${canMark ? `<button class="btnMarkFriend ${isMarked ? 'marked' : ''}" data-player-id="${p.id}">
        ${isMarked ? '✓ 朋友' : '标记朋友'}
      </button>` : ''}
    `;

    // 绑定标记按钮事件
    if (canMark) {
      const markBtn = seat.querySelector(".btnMarkFriend");
      if (markBtn) {
        markBtn.onclick = async (e) => {
          e.stopPropagation();
          const playerId = markBtn.dataset.playerId;
          const newState = !friendMarks.has(playerId);

          socket.emit("friends:mark", {
            roomId: currentRoomId,
            playerId,
            isFriend: newState
          }, async (res) => {
            if (res?.ok) {
              if (newState) friendMarks.add(playerId);
              else friendMarks.delete(playerId);
              renderTable(lastSnap); // 重新渲染更新按钮状态
              log(`${newState ? '标记' : '取消标记'} ${p.name} 为朋友`);
            } else {
              await showError("标记失败", res?.error || "未知错误");
            }
          });
        };
      }
    }

    box.appendChild(seat);

    // play slot（每人面前）- 分为历史和当前两部分
    const slot = document.createElement("div");
    slot.className = "playSlot";
    slot.style.left = `${px}px`;
    slot.style.top  = `${py}px`;

    const allCards = playsByPlayer.get(p.id) || [];
    const currentTrick = snap.game?.currentTrick?.plays || [];
    const currentPlay = currentTrick.find(play => play.playerId === p.id);
    const currentCards = currentPlay
      ? (currentPlay.cards || (currentPlay.card ? [currentPlay.card] : []))
      : [];

    // 历史牌：所有牌 - 当前牌
    const historyCards = allCards.filter(c => !currentCards.includes(c));

    // ✅ 判断当前出牌区谁最大（高亮红框）
    const isCurrentWinner = currentTrick.length > 0 && determineCurrentWinner(currentTrick, snap.game?.trumpSuit) === p.id;

    slot.innerHTML = `
      <div class="slotTitle">出牌区</div>
      ${historyCards.length > 0 ? `
        <button class="playSlotHistoryBtn" data-player-id="${p.id}" data-player-name="${p.name || p.id}">
          📜 历史 (${historyCards.length}张)
        </button>
      ` : ''}
      <div class="playSlotCurrent ${isCurrentWinner ? 'currentWinner' : ''}">
        ${currentCards.length
          ? currentCards.map(cid => cardMiniHTML(cid)).join("")
          : `<div style="opacity:.55;font-size:10px;">当前</div>`}
      </div>
    `;

    playLayer.appendChild(slot);

    // ✅ 绑定历史出牌按钮点击事件 - 弹出新窗口
    if (historyCards.length > 0) {
      const historyBtn = slot.querySelector(".playSlotHistoryBtn");
      if (historyBtn) {
        historyBtn.onclick = (e) => {
          e.stopPropagation();
          const playerName = historyBtn.dataset.playerName;
          showHistoryModal(playerName, historyCards);
        };
      }
    }
  });

  // 指针旋转：指向当前操作的人（没有则归零）
  updateDialToActive(snap, players, offset);

  // ✅ 更新领头花色指示器
  updateLeadSuitIndicator(snap);
}

function updateDialToActive(snap, players, offset){
  const dial = $("centerDial");
  const arrow = $("centerArrow");
  if (!dial || !arrow) return;

  const activeId = activeIdFromSnap(snap);
  if (!activeId) {
    arrow.style.transform = `translate(0,-50%) rotate(0deg)`;
    return;
  }

  const n = Math.max(players.length, 1);
  const idx = players.findIndex(p => p.id === activeId);
  if (idx < 0) return;

  const rel = (idx - offset + n) % n;
  const edgeShift = (n === 6) ? 0.5 : 0;
  const angleRad = Math.PI/2 - (2*Math.PI*(rel + edgeShift))/n;
  const deg = angleRad * 180 / Math.PI;

  arrow.style.transform = `translate(0,-50%) rotate(${deg}deg)`;
}

// ===== 更新领头花色指示器 =====
function updateLeadSuitIndicator(snap) {
  const indicator = $("leadSuitIndicator");
  if (!indicator || !snap) return;

  const g = snap.game || {};
  const currentTrick = g.currentTrick?.plays || [];

  // 只在出牌阶段且有人出牌时显示
  if (g.phase === "PLAY" && currentTrick.length > 0) {
    const firstPlay = currentTrick[0];
    // ✅ 兼容单张和对子：优先取 cards[0]，否则取 card
    const firstCard = firstPlay.cards ? firstPlay.cards[0] : firstPlay.card;

    if (!firstCard) {
      indicator.style.display = "none";
      return;
    }

    const c = parseCardId(firstCard);
    const isTrump = c.suit === "J" || c.rank === "2" || (g.trumpSuit && c.suit === g.trumpSuit);

    if (isTrump) {
      indicator.innerHTML = `<span style="color:#ffd60a;">本轮领头：主牌</span>`;
    } else {
      const suit = suitIcon(c.suit);
      const redClass = isRedSuit(c.suit) ? "color:#ff3b30;" : "color:#fff;";
      indicator.innerHTML = `本轮领头：<span style="${redClass}">${suit}</span>`;
    }
    indicator.style.display = "block";
  } else {
    indicator.style.display = "none";
  }
}

// ===== 渲染积分榜 =====
function renderScoreBoard(snap) {
  const board = $("scoreBoard");
  if (!board || !snap) return;

  const players = snap.players || [];
  if (players.length === 0) {
    board.innerHTML = "";
    return;
  }

  const g = snap.game || {};
  const bankerId = g.bankerId;

  // 按总分排序（从高到低）
  const sorted = [...players].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

  // 找出第一名和最后一名的总分
  const maxScore = sorted[0]?.totalScore || 0;
  const minScore = sorted[sorted.length - 1]?.totalScore || 0;

  let html = '<div class="scoreBoardTitle">积分榜</div>';

  for (const p of sorted) {
    const isFirst = p.totalScore === maxScore && maxScore !== minScore;
    const isLast = p.totalScore === minScore && maxScore !== minScore;
    const isBanker = p.id === bankerId;
    const isFriend = p.isFriend && p.isRevealed;

    let itemClass = "scoreItem";
    if (isBanker) itemClass += " banker";
    if (isFriend) itemClass += " friend";

    let nameClass = "playerName";
    if (isFirst) nameClass += " first";
    if (isLast) nameClass += " last";

    html += `
      <div class="${itemClass}">
        <div class="${nameClass}">${p.name || p.id}</div>
        <div class="scores">
          <div>
            <div class="scoreLabel">本局</div>
            <div class="scoreValue">${p.trickPoints ?? 0}</div>
          </div>
          <div>
            <div class="scoreLabel">总分</div>
            <div class="scoreValue">${p.totalScore ?? 0}</div>
          </div>
        </div>
      </div>
    `;
  }

  board.innerHTML = html;
}

// ===== 按钮 =====
$("btnCreate").onclick = () => {
  socket.emit("room:create", { name: $("name").value || "player" }, (res) => {
    if (res?.ok) {
      $("roomId").value = res.roomId;
      log("创建房间成功，房间号：" + res.roomId);
    } else {
      log("创建房间失败");
    }
  });
};

$("btnJoin").onclick = async () => {
  const roomId = $("roomId").value.trim();
  const name = $("name").value.trim() || "player";

  if (!roomId) {
    await showError("加入失败", "请输入房间号");
    return;
  }

  socket.emit("room:join", { roomId, name }, async (res) => {
    if (!res?.ok) {
      await showError("加入失败", res?.error || "未知错误");
    } else {
      currentRoomId = roomId;
      log("加入房间成功：" + roomId);
    }
  });
};

$("btnReady").onclick = async () => {
  if (!currentRoomId) {
    await showError("操作失败", "请先加入房间");
    return;
  }
  ready = !ready;
  socket.emit("room:ready", { roomId: currentRoomId, ready }, async (res) => {
    if (!res?.ok) {
      await showError("准备失败", res?.error || "未知错误");
    } else {
      log(ready ? "已准备" : "已取消准备");
    }
  });
};

$("btnStart").onclick = async () => {
  if (!currentRoomId) {
    await showError("操作失败", "请先加入房间");
    return;
  }
  // 重置自动弹窗
  autoDone.trump = false;
  autoDone.friends = false;

  socket.emit("game:start", { roomId: currentRoomId }, async (res) => {
    if (!res?.ok) {
      await showError("开始失败", res?.error || "未知错误");
    } else {
      log("开始游戏成功（进入叫分）");
    }
  });
};

// 叫分：输入 120 起叫，0 表示不叫（优化：使用模态框）
$("btnBid").onclick = async () => {
  if (!lastSnap) return;
  if (lastSnap.game.phase !== "BID") {
    await showError("叫分失败", "现在不在叫分阶段");
    return;
  }
  if (lastSnap.game.actorId !== myId) {
    await showError("叫分失败", "没轮到你叫分");
    return;
  }

  const s = await showModal("输入叫分", "120起叫，0=不叫", "0");
  if (s === null) return;
  const bid = Number(s);

  socket.emit("bid:place", { roomId: currentRoomId, bid }, async (res) => {
    if (!res?.ok) {
      await showError("叫分失败", res?.error || "未知错误");
    } else {
      log("叫分提交成功：" + bid);
    }
  });
};

// 手动定主（备用：也会自动弹窗）（优化：使用模态框 + 中文输入）
$("btnTrump").onclick = async () => {
  if (!lastSnap) return;
  if (lastSnap.game.phase !== "SET_TRUMP") {
    await showError("定主失败", "现在不在定主阶段");
    return;
  }
  if (lastSnap.game.actorId !== myId) {
    await showError("定主失败", "只有庄家能定主");
    return;
  }

  const s = await showModal(
    "输入主花色",
    "黑桃/红桃/方片/梅花 或 S/H/D/C",
    "红桃"
  );
  if (s === null) return;

  const suit = parseTrumpSuit(s);
  if (!suit) {
    await showError("定主失败", "花色格式错误，请输入 黑桃/红桃/方片/梅花 或 S/H/D/C");
    return;
  }

  socket.emit("trump:set", { roomId: currentRoomId, suit }, async (res) => {
    if (!res?.ok) {
      await showError("定主失败", res?.error || "未知错误");
    } else {
      log("定主成功：" + suit);
    }
  });
};

// 手动找朋友（备用：也会自动弹窗）- 新版：声明朋友
$("btnFriends").onclick = async () => {
  if (!lastSnap) return;
  if (lastSnap.game.phase !== "CALL_FRIENDS") {
    await showError("声明失败", "现在不在找朋友阶段");
    return;
  }
  if (lastSnap.game.actorId !== myId) {
    await showError("声明失败", "只有庄家能找朋友");
    return;
  }

  const s = await showModal(
    "声明朋友",
    "例：两个红桃A / 第一个出5分的",
    "两个红桃A"
  );
  if (s === null) return;

  socket.emit("friends:declare", { roomId: currentRoomId, declaration: s }, async (res) => {
    if (!res?.ok) {
      await showError("声明朋友失败", res?.error || "未知错误");
    } else {
      log("声明朋友成功：" + s);
    }
  });
};

// 确认扣底：选满 N 张后点一次提交
$("btnDiscard").onclick = async () => {
  if (!lastSnap) return;
  if (lastSnap.game.phase !== "DISCARD_BOTTOM") {
    await showError("扣底失败", "现在不在扣底阶段");
    return;
  }
  if (lastSnap.game.actorId !== myId) {
    await showError("扣底失败", "只有庄家能扣底");
    return;
  }

  const need = lastSnap.game.bottomNeed || 6;

  if (discardPick.length !== need) {
    await showError("扣底失败", `需要扣 ${need} 张，你当前选了 ${discardPick.length} 张`);
    return;
  }

  socket.emit("bottom:discard", { roomId: currentRoomId, cards: discardPick }, async (res) => {
    if (!res?.ok) {
      await showError("扣底失败", res?.error || "未知错误");
    } else {
      log("扣底成功，进入出牌阶段（庄家先出；历史出牌不消失）");
      discardMode = false;
      discardPick = [];
      renderHand();
    }
  });
};

// ===== 同步 =====
socket.on("room:state", (snap) => {
  lastSnap = snap;
  $("public").textContent = JSON.stringify(snap, null, 2);
  updateHudAndPhase();
  renderTable(snap);
  renderBottomBox(snap);
  renderScoreBoard(snap);
});

socket.on("game:public", (snap) => {
  lastSnap = snap;
  $("public").textContent = JSON.stringify(snap, null, 2);
  updateHudAndPhase();
  renderHand();
  renderTable(snap);
  renderBottomBox(snap);
  renderScoreBoard(snap);
});

socket.on("hand:deal", ({ hand }) => {
  myHand = hand || [];
  renderHand();
});

socket.on("game:over", (msg) => {
  // 显示结算弹窗
  showGameOverModal(msg);

  // 同时记录到日志
  const bankerNames = (msg.bankerTeam || []).map(p => p.name).join(", ");
  let result = `\n========== 本局结束 ==========\n`;
  result += `庄家方：${bankerNames}\n`;
  result += `叫分：${msg.bid} 分\n`;
  result += `庄家方得分：${msg.bankerPoints} 分\n`;
  result += `底分加成：${msg.bottomPointsAdded} 分\n`;
  result += `结果：${msg.success ? "✅ 庄家方完成" : "❌ 庄家方失败"}\n`;
  result += `最后一墩赢家：${nameOf(msg.lastTrickWinnerId)}\n`;
  result += `\n--- 最终积分 ---\n`;
  (msg.finalScores || []).forEach(s => {
    result += `${s.name}: 本局 ${s.trickPoints} 分，累计 ${s.totalScore} 分\n`;
  });
  result += `============================\n`;

  // 检查是否有人达到胜利条件（±1000分）
  const winners = (msg.finalScores || []).filter(s => s.totalScore >= 1000 || s.totalScore <= -1000);
  if (winners.length > 0) {
    result += `\n🎉🎉🎉 游戏结束！ 🎉🎉🎉\n`;
    winners.forEach(w => {
      if (w.totalScore >= 1000) {
        result += `🏆 ${w.name} 获胜！总分：${w.totalScore}\n`;
      } else {
        result += `💔 ${w.name} 失败！总分：${w.totalScore}\n`;
      }
    });
  }

  log(result);
});

// ===== 显示结算弹窗 =====
function showGameOverModal(msg) {
  const modal = $("gameOverModal");

  // 基本信息
  $("settleBid").textContent = `${msg.bid} 分`;

  // 主牌花色
  const trumpSuit = lastSnap?.game?.trumpSuit;
  $("settleTrump").textContent = trumpSuit ? suitIcon(trumpSuit) : "-";

  // 底牌分数
  $("settleBottomPoints").textContent = `${msg.bottomPoints || 0} 分`;

  // 底牌倍数（根据服务器逻辑推断）
  const multiplier = msg.bottomPointsAdded / (msg.bottomPoints || 1);
  let multiplierText = "×1（庄家赢）";
  if (multiplier === 2) {
    multiplierText = "×2（农民单张赢）";
  } else if (multiplier === 4) {
    multiplierText = "×4（农民对子赢）";
  }
  $("settleBottomMultiplier").textContent = multiplierText;

  // 结果
  const resultEl = $("settleResult");
  resultEl.textContent = msg.success ? "✅ 庄家方完成" : "❌ 庄家方失败";
  resultEl.className = `settlementResult ${msg.success ? "success" : "failure"}`;

  // 队伍得分
  $("bankerTeamScore").textContent = `${msg.bankerPoints} 分`;
  const bankerNames = (msg.bankerTeam || []).map(p => p.name).join("、");
  $("bankerMembers").textContent = bankerNames;

  $("farmerTeamScore").textContent = `${msg.farmerPoints} 分`;
  const farmerNames = (msg.finalScores || [])
    .filter(s => !msg.bankerTeam.some(b => b.id === s.id))
    .map(s => s.name)
    .join("、");
  $("farmerMembers").textContent = farmerNames;

  // 个人得分
  const playerScoresList = $("playerScoresList");
  playerScoresList.innerHTML = "";

  (msg.finalScores || []).forEach(s => {
    const isBanker = msg.bankerTeam.some(b => b.id === s.id && b.id === lastSnap?.game?.bankerId);
    const isFriend = msg.bankerTeam.some(b => b.id === s.id && b.id !== lastSnap?.game?.bankerId);

    const item = document.createElement("div");
    item.className = `playerScoreItem ${isBanker ? "isBanker" : ""} ${isFriend ? "isFriend" : ""}`;
    item.innerHTML = `
      <div class="playerScoreName">${s.name}${isBanker ? " 👑" : ""}${isFriend ? " 🤝" : ""}</div>
      <div class="playerScoreValue">
        <span class="playerScoreLabel">本局得分</span>
        <span class="playerScoreNumber">${s.trickPoints}</span>
      </div>
      <div class="playerScoreValue">
        <span class="playerScoreLabel">累计总分</span>
        <span class="playerScoreNumber">${s.totalScore}</span>
      </div>
    `;
    playerScoresList.appendChild(item);
  });

  // 最后一墩赢家
  $("lastTrickWinner").textContent = nameOf(msg.lastTrickWinnerId);

  // 显示弹窗
  modal.style.display = "flex";
}

// 关闭结算弹窗
$("btnCloseGameOver").onclick = () => {
  $("gameOverModal").style.display = "none";
};

// ===== 新增：朋友相关事件 =====

// 服务器通知庄家选择朋友
socket.on("friends:needConfirm", (data) => {
  const modal = $("friendConfirmModal");
  const declText = $("friendDeclText");
  const checkboxes = $("playerCheckboxes");

  declText.textContent = data.declaration || "未声明";
  checkboxes.innerHTML = "";

  // 渲染玩家复选框
  data.players.forEach(p => {
    const isMarked = data.currentMarks.includes(p.id);
    const div = document.createElement("div");
    div.className = "checkboxItem";
    div.innerHTML = `
      <label>
        <input type="checkbox" value="${p.id}" ${isMarked ? 'checked' : ''} />
        <span>${p.name}</span>
      </label>
    `;
    checkboxes.appendChild(div);
  });

  modal.style.display = "flex";

  // 确认按钮
  $("btnConfirmFriends").onclick = async () => {
    const checked = Array.from(checkboxes.querySelectorAll("input[type=checkbox]:checked"));
    const friendIds = checked.map(cb => cb.value);

    socket.emit("friends:confirm", { roomId: currentRoomId, friendIds }, async (res) => {
      if (res?.ok) {
        modal.style.display = "none";
        log(`已确认朋友：${friendIds.length}人`);
      } else {
        await showError("确认失败", res?.error || "未知错误");
      }
    });
  };
});

// 服务器返回庄家的标记状态（仅庄家可见）
socket.on("friends:marks", (data) => {
  friendMarks = new Set(data.marks || []);
  if (lastSnap) renderTable(lastSnap);
});

// ===== 显示历史出牌弹窗 =====
function showHistoryModal(playerName, historyCards) {
  const modal = $("historyModal");
  const title = $("historyModalTitle");
  const content = $("historyModalContent");

  title.textContent = `${playerName} 的历史出牌 (${historyCards.length}张)`;
  content.innerHTML = historyCards.map(cid => cardMiniHTML(cid)).join("");

  modal.style.display = "flex";
}

// ===== 游戏规则按钮 =====
$("btnRules").onclick = () => {
  const modal = $("rulesModal");
  modal.style.display = "flex";
};

$("btnCloseRules").onclick = () => {
  const modal = $("rulesModal");
  modal.style.display = "none";
};

// 关闭历史出牌弹窗
$("btnCloseHistory").onclick = () => {
  $("historyModal").style.display = "none";
};

// 点击弹窗外部关闭
$("rulesModal").onclick = (e) => {
  if (e.target === $("rulesModal")) {
    $("rulesModal").style.display = "none";
  }
};

$("historyModal").onclick = (e) => {
  if (e.target === $("historyModal")) {
    $("historyModal").style.display = "none";
  }
};

