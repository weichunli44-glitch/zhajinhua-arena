const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const waiting = [];
const MAX_PLAYERS = 3;
const START_STACK = 100;
const ANTE = 2;
const CALL_AMOUNT = 2;
const RAISE_AMOUNT = 4;

const SUITS = ["♠", "♥", "♣", "♦"];
const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];

function makeDeck() {
  const d = [];
  for (const suit of SUITS) for (let rank = 2; rank <= 14; rank++) d.push({ suit, rank });
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function evaluate(hand) {
  const vals = hand.map(c => c.rank).sort((a,b) => b-a);
  const flush = hand.every(c => c.suit === hand[0].suit);
  let straight = vals[0] - vals[2] === 2 && new Set(vals).size === 3;
  let high = vals[0];
  if (vals[0] === 14 && vals[1] === 3 && vals[2] === 2) { straight = true; high = 3; }
  const counts = {};
  vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const entries = Object.entries(counts).map(([v,n]) => [Number(v),n]);
  let category, tie;
  if (entries.some(x => x[1] === 3)) { category = 6; tie = [vals[0]]; }
  else if (straight && flush) { category = 5; tie = [high]; }
  else if (flush) { category = 4; tie = vals; }
  else if (straight) { category = 3; tie = [high]; }
  else if (entries.some(x => x[1] === 2)) {
    category = 2;
    const pair = entries.find(x => x[1] === 2)[0];
    const kicker = entries.find(x => x[1] === 1)[0];
    tie = [pair, kicker];
  } else { category = 1; tie = vals; }
  return { category, tie };
}
const HAND_NAMES = ["","单张","对子","顺子","金花","顺金","豹子"];
function compareHands(a,b) {
  const x = evaluate(a), y = evaluate(b);
  if (x.category !== y.category) return x.category - y.category;
  for (let i=0;i<Math.max(x.tie.length,y.tie.length);i++) {
    const diff = (x.tie[i] || 0) - (y.tie[i] || 0);
    if (diff) return diff;
  }
  return 0;
}
function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i=0;i<6;i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}
function cleanName(value) {
  return String(value || "玩家").replace(/[<>\\u0000-\\u001f]/g, "").trim().slice(0,12) || "玩家";
}
function publicState(room) {
  const game = room.game;
  return {
    code: room.code, mode: room.mode, status: game ? game.status : "waiting",
    players: room.players.map(p => ({
      id: p.id, name: p.name, stack: p.stack, folded: p.folded,
      ready: !!p.ready, isYou: false,
      cardCount: p.hand ? p.hand.length : 0,
      cards: game && game.status === "showdown" && !p.folded ? p.hand : null
    })),
    pot: game ? game.pot : 0,
    currentBet: game ? game.currentBet : 0,
    turnId: game ? game.turnId : null,
    round: game ? game.round : 0,
    winnerId: game ? game.winnerId : null,
    message: game ? game.message : "等待玩家加入，满三人后房主可开始。",
    lastResult: game ? game.lastResult : null
  };
}
function emitRoom(room) {
  room.players.forEach(p => {
    const state = publicState(room);
    state.players = state.players.map(x => ({...x, isYou: x.id === p.id}));
    const own = room.game && room.game.status !== "waiting" ? room.game.hands[p.id] : null;
    io.to(p.id).emit("state", { ...state, myCards: own || null });
  });
}
function leaveWaiting(id) {
  const i = waiting.indexOf(id);
  if (i >= 0) waiting.splice(i,1);
}
function removePlayer(socket, reason="玩家离开房间") {
  leaveWaiting(socket.id);
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  socket.data.roomCode = null;
  if (!room) return;
  room.players = room.players.filter(p => p.id !== socket.id);
  socket.leave(roomCode);
  if (!room.players.length) rooms.delete(roomCode);
  else {
    if (room.game && room.game.status === "playing") {
      const remaining = room.players.filter(p => !p.folded);
      if (remaining.length === 1) settle(room, remaining[0], "其他玩家离开，自动获胜。");
      else if (room.game.turnId === socket.id) nextTurn(room);
    }
    if (room.players.length) {
      room.hostId = room.players[0].id;
      room.game = room.game && room.game.status === "playing" ? room.game : null;
      emitRoom(room);
      io.to(roomCode).emit("notice", reason);
    }
  }
}
function joinRoom(socket, room, name) {
  if (room.players.length >= MAX_PLAYERS) return false;
  const player = { id: socket.id, name: cleanName(name), stack: START_STACK, ready: true, folded: false, hand: null, bet: 0 };
  room.players.push(player);
  socket.join(room.code);
  socket.data.roomCode = room.code;
  emitRoom(room);
  return true;
}
function createRoom(socket, name) {
  let c;
  do { c = code(); } while (rooms.has(c));
  const room = { code:c, mode:"friend", hostId:socket.id, players:[], game:null };
  rooms.set(c,room);
  joinRoom(socket,room,name);
  return c;
}
function findPlayer(room,id) { return room.players.find(p => p.id === id); }
function startGame(room, requester) {
  if (requester !== room.hostId) return {error:"只有房主可以开始游戏。"};
  if (room.players.length !== 3) return {error:"需要正好 3 位玩家才能开始。"};
  if (room.game && room.game.status === "playing") return {error:"当前牌局尚未结束。"};
  const deck = makeDeck(), hands = {};
  room.players.forEach(p => {
    p.folded = false; p.bet = ANTE; p.hand = [deck.pop(),deck.pop(),deck.pop()];
    p.stack -= ANTE; hands[p.id] = p.hand;
  });
  room.game = {
    status:"playing", hands, pot:ANTE*3, currentBet:ANTE,
    turnId:room.players[0].id, round:1, winnerId:null,
    message:"新牌局开始。按顺序行动：跟注、加注、弃牌或比牌。",
    lastResult:null, acted:new Set()
  };
  emitRoom(room);
  return {};
}
function activePlayers(room) { return room.players.filter(p => !p.folded); }
function settle(room, winner, message) {
  const g=room.game;
  if (!g) return;
  winner.stack += g.pot;
  g.status="showdown"; g.winnerId=winner.id;
  g.message=`${winner.name} 获胜，赢得 ${g.pot} 筹码。${message || ""}`;
  g.lastResult=room.players.map(p => ({
    id:p.id, name:p.name, folded:p.folded,
    hand:p.folded ? null : p.hand,
    handName:p.folded ? "弃牌" : HAND_NAMES[evaluate(p.hand).category]
  }));
  emitRoom(room);
}
function nextTurn(room) {
  const g=room.game, alive=activePlayers(room);
  if (alive.length===1) return settle(room,alive[0],"其他玩家均已弃牌。");
  const idx=room.players.findIndex(p=>p.id===g.turnId);
  for(let n=1;n<=room.players.length;n++){
    const p=room.players[(idx+n)%room.players.length];
    if(p && !p.folded){g.turnId=p.id;g.round++;emitRoom(room);return;}
  }
}
function charge(room,p,amount) {
  if (p.stack < amount) return false;
  p.stack -= amount; p.bet += amount; room.game.pot += amount; return true;
}
function action(socket, type, targetId) {
  const room=rooms.get(socket.data.roomCode), g=room && room.game;
  if(!room || !g || g.status!=="playing") return socket.emit("errorMsg","当前没有进行中的牌局。");
  if(g.turnId!==socket.id) return socket.emit("errorMsg","还没轮到你行动。");
  const p=findPlayer(room,socket.id);
  if(!p || p.folded) return;
  if(type==="fold"){
    p.folded=true;g.message=`${p.name} 弃牌。`;
  } else if(type==="call"){
    const need=g.currentBet-p.bet;
    if(need>0 && !charge(room,p,need)) return socket.emit("errorMsg","筹码不足，无法跟注。");
    g.message=need>0?`${p.name} 跟注 ${need} 筹码。`:`${p.name} 过牌。`;
  } else if(type==="raise"){
    const need=(g.currentBet-p.bet)+4;
    if(!charge(room,p,need)) return socket.emit("errorMsg","筹码不足，无法加注。");
    g.currentBet=p.bet;g.message=`${p.name} 加注，当前下注提高。`;
  } else if(type==="compare"){
    if(!targetId || targetId===socket.id) return socket.emit("errorMsg","请选择一位对手比牌。");
    const target=findPlayer(room,targetId);
    if(!target || target.folded) return socket.emit("errorMsg","该玩家无法比牌。");
    if(!charge(room,p,4)) return socket.emit("errorMsg","比牌需要 4 筹码。");
    const result=compareHands(p.hand,target.hand);
    if(result>=0){target.folded=true;g.message=`${p.name} 比牌胜过 ${target.name}，对方出局。`;}
    else {p.folded=true;g.message=`${p.name} 比牌输给 ${target.name}，你已出局。`;}
  } else {
    return socket.emit("errorMsg","未知操作。");
  }
  const alive=activePlayers(room);
  if(alive.length===1) return settle(room,alive[0],"牌局结束。");
  g.acted.add(socket.id);
  const allActed=alive.every(x=>g.acted.has(x.id));
  const betsMatched=alive.every(x=>x.bet===g.currentBet);
  if(allActed && betsMatched){
    const ranked=[...alive].sort((a,b)=>compareHands(b.hand,a.hand));
    return settle(room,ranked[0],"本轮行动结束，自动摊牌。");
  }
  if(type==="raise") g.acted=new Set([socket.id]);
  nextTurn(room);
}
io.on("connection", socket => {
  socket.on("createRoom", ({name}={}) => {
    if(socket.data.roomCode) removePlayer(socket);
    const c=createRoom(socket,name);
    socket.emit("joined",{code:c,host:true});
  });
  socket.on("joinRoom", ({code:raw,name}={}) => {
    if(socket.data.roomCode) removePlayer(socket);
    const c=String(raw||"").toUpperCase().trim(), room=rooms.get(c);
    if(!room) return socket.emit("errorMsg","房间不存在，请检查房间号。");
    if(room.game && room.game.status==="playing") return socket.emit("errorMsg","牌局进行中，暂时不能加入。");
    if(!joinRoom(socket,room,name)) return socket.emit("errorMsg","房间已满，最多 3 人。");
    socket.emit("joined",{code:c,host:room.hostId===socket.id});
  });
  socket.on("quickMatch", ({name}={}) => {
    if(socket.data.roomCode) removePlayer(socket);
    let room=waiting.map(c=>rooms.get(c)).find(r=>r && r.players.length<MAX_PLAYERS && (!r.game || r.game.status!=="playing"));
    if(!room){const c=createRoom(socket,name);room=rooms.get(c);room.mode="match";waiting.push(c);}
    else joinRoom(socket,room,name);
    socket.emit("joined",{code:room.code,host:room.hostId===socket.id});
    if(room.players.length===3){leaveWaitingRoom(room.code);emitRoom(room);io.to(room.code).emit("notice","匹配成功！房主可以开始游戏。");}
  });
  socket.on("startGame",()=>{const room=rooms.get(socket.data.roomCode);if(!room)return;const result=startGame(room,socket.id);if(result.error)socket.emit("errorMsg",result.error);});
  socket.on("action",({type,targetId}={})=>action(socket,type,targetId));
  socket.on("leaveRoom",()=>removePlayer(socket,"玩家离开房间。"));
  socket.on("disconnect",()=>removePlayer(socket,"玩家断线离开房间。"));
});
function leaveWaitingRoom(c){const i=waiting.indexOf(c);if(i>=0)waiting.splice(i,1);}
server.listen(PORT,()=>console.log(`炸金花竞技场运行于端口 ${PORT}`));
