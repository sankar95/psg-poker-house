'use strict';
const http    = require('http');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

// ═══════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const AI_NAMES = ['Maverick','Viper','Shadow','Ace','Ghost'];
const AI_AVATARS= ['🦊','🐺','🎭','👑','🦁'];
const AI_PERSONALITIES = ['tight','loose','aggressive','balanced','bluffer'];

// ═══════════════════════════════════════════════════════════════
//  UTILITY
// ═══════════════════════════════════════════════════════════════
function randInt(a,b){ return a+Math.floor(Math.random()*(b-a+1)); }
function rand(a,b){ return a+Math.random()*(b-a); }
function genId(n=6){
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:n},()=>c[Math.floor(Math.random()*c.length)]).join('');
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=randInt(0,i);
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function log(...a){ console.log(new Date().toISOString().slice(11,19),...a); }

// ═══════════════════════════════════════════════════════════════
//  DECK & HAND EVALUATION
// ═══════════════════════════════════════════════════════════════
function makeDeck(){
  const d=[];
  for(const s of SUITS) for(const r of RANKS) d.push({rank:r,suit:s});
  return shuffle(d);
}

function combinations(arr,k){
  if(k===0) return [[]];
  if(arr.length<k) return [];
  const [first,...rest]=arr;
  return [
    ...combinations(rest,k-1).map(c=>[first,...c]),
    ...combinations(rest,k)
  ];
}

function rankFive(cards){
  const vals=cards.map(c=>RANK_VAL[c.rank]).sort((a,b)=>b-a);
  const suits=cards.map(c=>c.suit);
  const flush=suits.every(s=>s===suits[0]);
  let straight=vals.every((v,i)=>i===0||vals[i-1]-v===1);
  if(!straight&&vals[0]===14&&vals[1]===5&&vals[2]===4&&vals[3]===3&&vals[4]===2) straight=true;
  const cnt={};
  for(const v of vals) cnt[v]=(cnt[v]||0)+1;
  const freqs=Object.values(cnt).sort((a,b)=>b-a);

  const base = (()=>{
    const hi=vals[0];
    if(flush&&straight&&hi===14&&vals[1]===13) return 9;
    if(flush&&straight) return 8;
    if(freqs[0]===4) return 7;
    if(freqs[0]===3&&freqs[1]===2) return 6;
    if(flush) return 5;
    if(straight) return 4;
    if(freqs[0]===3) return 3;
    if(freqs[0]===2&&freqs[1]===2) return 2;
    if(freqs[0]===2) return 1;
    return 0;
  })();

  const score=base*1e12+vals.reduce((a,v,i)=>a+v*Math.pow(15,4-i),0);
  const names=['High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'];
  return {score,name:names[base],cards};
}

function evalBestHand(cards){
  if(cards.length<2) return {score:0,name:'High Card',cards:[]};
  const combos=combinations(cards,Math.min(5,cards.length));
  let best=null;
  for(const c of combos){
    const r=rankFive(c);
    if(!best||r.score>best.score) best=r;
  }
  return best;
}

function handStrength(holeCards,communityCards){
  const all=[...holeCards,...communityCards];
  if(all.length<2) return 0.3;
  const r=evalBestHand(all);
  const s=r.score;
  if(s>=9e12) return 1.0;
  if(s>=8e12) return 0.97;
  if(s>=7e12) return 0.93;
  if(s>=6e12) return 0.86;
  if(s>=5e12) return 0.76;
  if(s>=4e12) return 0.65;
  if(s>=3e12) return 0.55;
  if(s>=2e12) return 0.45;
  if(s>=1e12) return 0.35;
  const hv=holeCards.map(c=>RANK_VAL[c.rank]);
  return 0.10+(hv.reduce((a,b)=>a+b,0))/(14*2)*0.25;
}

// ═══════════════════════════════════════════════════════════════
//  GAME STATE
// ═══════════════════════════════════════════════════════════════
const rooms = {}; // roomId -> GameRoom

class GameRoom {
  constructor(id, hostName, startChips=5000){
    this.id = id;
    this.startChips = startChips;
    this.players = [];   // all player objects
    this.sockets = {};   // playerId -> ws socket
    this.deck = [];
    this.community = [];
    this.pot = 0;
    this.sidePots = [];
    this.currentRound = 0; // 0=preflop,1=flop,2=turn,3=river
    this.dealerIdx = 0;
    this.currentPlayerIdx = -1;
    this.smallBlind = 25;
    this.bigBlind = 50;
    this.highestBet = 0;
    this.minRaise = 50;
    this.handNum = 0;
    this.phase = 'lobby'; // lobby | playing | showdown
    this.actionResolver = null;
    this.gameLoop = null;
  }

  addPlayer(name, isHuman, socketId=null, avatar='🎩', chips=null){
    const id = this.players.length;
    const p = {
      id, name, isHuman, socketId,
      avatar: avatar,
      personality: AI_PERSONALITIES[Math.floor(Math.random()*AI_PERSONALITIES.length)],
      chips: chips ?? this.startChips,
      holeCards:[], bet:0, totalBetRound:0,
      folded:false, allIn:false, active:true,
      lastAction:'', seatIndex:id
    };
    this.players.push(p);
    return p;
  }

  broadcast(msg, excludeId=-1){
    const data = JSON.stringify(msg);
    for(const [pid, ws] of Object.entries(this.sockets)){
      if(parseInt(pid)===excludeId) continue;
      wsSend(ws, data);
    }
  }

  sendTo(playerId, msg){
    const ws = this.sockets[playerId];
    if(ws) wsSend(ws, JSON.stringify(msg));
  }

  sendState(extra={}){
    for(const p of this.players){
      if(!p.isHuman) continue;
      const ws = this.sockets[p.id];
      if(!ws) continue;
      // Send private hole cards only to the player
      const state = this.serializeFor(p.id);
      wsSend(ws, JSON.stringify({type:'state', ...state, ...extra}));
    }
  }

  serializeFor(viewerId){
    const roundNames=['PRE-FLOP','FLOP','TURN','RIVER'];
    return {
      players: this.players.map(p=>({
        id:p.id, name:p.name, avatar:p.avatar,
        chips:p.chips, bet:p.bet, totalBetRound:p.totalBetRound,
        folded:p.folded, allIn:p.allIn, active:p.active,
        lastAction:p.lastAction, seatIndex:p.seatIndex, isHuman:p.isHuman,
        // Only send hole cards if it's the viewer or showdown
        holeCards: (p.id===viewerId || this.phase==='showdown') ? p.holeCards : (p.holeCards.length ? [{hidden:true},{hidden:true}] : [])
      })),
      community: this.community,
      pot: this.pot,
      dealerIdx: this.dealerIdx,
      currentPlayerIdx: this.currentPlayerIdx,
      round: roundNames[this.currentRound]||'',
      phase: this.phase,
      handNum: this.handNum,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      highestBet: this.highestBet,
      minRaise: this.minRaise,
    };
  }

  getActivePlayers(){
    return this.players.filter(p=>!p.folded&&p.active&&p.chips>=0);
  }

  findNextActive(startIdx){
    let idx=startIdx%this.players.length;
    for(let tries=0;tries<this.players.length;tries++){
      const p=this.players[idx];
      if(p.active&&!p.folded&&!p.allIn) return idx;
      idx=(idx+1)%this.players.length;
    }
    return -1;
  }

  postBlind(idx, amount){
    const p=this.players[idx%this.players.length];
    if(!p||!p.active) return;
    const actual=Math.min(amount,p.chips);
    p.chips-=actual; p.bet+=actual; p.totalBetRound+=actual; this.pot+=actual;
    if(p.chips===0) p.allIn=true;
  }

  async dealNewHand(){
    this.handNum++;
    this.pot=0; this.community=[];
    this.currentRound=0; this.phase='playing';
    this.deck=makeDeck();

    const activePl=this.players.filter(p=>p.chips>0);
    if(activePl.length<2){ this.phase='lobby'; return; }

    for(const p of this.players){
      p.holeCards=[]; p.bet=0; p.totalBetRound=0;
      p.folded=p.chips<=0; p.allIn=false;
      p.active=p.chips>0; p.lastAction='';
    }

    // Rotate dealer to next active
    let tries=0;
    do{ this.dealerIdx=(this.dealerIdx+1)%this.players.length; tries++; }
    while(!this.players[this.dealerIdx].active && tries<this.players.length);

    // Deal 2 hole cards each
    for(let r=0;r<2;r++)
      for(const p of this.players)
        if(p.active) p.holeCards.push(this.deck.pop());

    // Blinds
    const sbIdx=(this.dealerIdx+1)%this.players.length;
    const bbIdx=(sbIdx+1)%this.players.length;
    this.postBlind(sbIdx, this.smallBlind);
    this.postBlind(bbIdx, this.bigBlind);
    this.highestBet=this.bigBlind;
    this.minRaise=this.bigBlind;

    this.sendState({event:'deal'});
    await sleep(600);

    // UTG starts
    const utg=this.findNextActive((bbIdx+1)%this.players.length);
    await this.bettingRound(utg!=-1?utg:(this.dealerIdx+1)%this.players.length);
  }

  async bettingRound(startIdx){
    const active=this.getActivePlayers();
    if(active.length<=1){ await this.showdown(true); return; }

    const canAct=active.filter(p=>!p.allIn);
    if(canAct.length===0){ await this.endRound(); return; }

    // Build action queue
    let toAct=canAct.map(p=>p.id);
    let current=startIdx;
    let safety=0;

    while(toAct.length>0 && safety++<60){
      // Find next player who needs to act
      let found=-1;
      let ci=current;
      for(let t=0;t<this.players.length;t++){
        const p=this.players[ci%this.players.length];
        if(p&&toAct.includes(p.id)){ found=ci%this.players.length; break; }
        ci++;
      }
      if(found===-1) break;
      current=found;

      const p=this.players[current];
      if(!p||p.folded||p.allIn||!p.active){
        toAct=toAct.filter(id=>id!==p?.id);
        current=(current+1)%this.players.length;
        continue;
      }

      this.currentPlayerIdx=current;
      this.sendState({event:'yourturn', activePlayerId:p.id});

      let action, raiseAmt;
      if(p.isHuman){
        // Ask the player
        this.sendTo(p.id,{type:'yourturn', toCall: this.highestBet-p.totalBetRound,
          highestBet:this.highestBet, minRaise:this.minRaise, pot:this.pot, chips:p.chips});
        const result = await this.waitForHumanAction(p);
        action=result.action; raiseAmt=result.amount||0;
      } else {
        await sleep(randInt(700,1600));
        const r=this.aiDecide(p);
        action=r.action; raiseAmt=r.amount||0;
      }

      const raised=this.execAction(p,action,raiseAmt);
      toAct=toAct.filter(id=>id!==p.id);

      if(raised){
        // Re-add all other active non-allIn players
        toAct=[...new Set([...toAct,
          ...this.getActivePlayers().filter(x=>!x.allIn&&x.id!==p.id).map(x=>x.id)
        ])];
      }

      this.sendState({event:'action',lastAction:{playerId:p.id,action,raiseAmt}});

      if(this.getActivePlayers().length<=1){
        await this.showdown(true); return;
      }
      current=(current+1)%this.players.length;
    }

    this.currentPlayerIdx=-1;
    await this.endRound();
  }

  waitForHumanAction(p){
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{
        // Auto-fold on timeout (30s)
        resolve({action:'fold'});
      },30000);
      this.actionResolver={
        playerId:p.id,
        resolve:(data)=>{ clearTimeout(timeout); resolve(data); },
        reject
      };
    });
  }

  execAction(p, action, raiseAmount=0){
    const toCall=Math.max(0,this.highestBet-p.totalBetRound);
    let raised=false;

    if(action==='fold'){
      p.folded=true; p.lastAction='fold';
    } else if(action==='check'){
      p.lastAction='check';
    } else if(action==='call'){
      const amount=Math.min(toCall,p.chips);
      p.chips-=amount; p.bet+=amount; p.totalBetRound+=amount; this.pot+=amount;
      if(p.chips===0){ p.allIn=true; p.lastAction='allin'; }
      else p.lastAction='call';
    } else if(action==='raise'){
      const total=Math.min(raiseAmount,p.chips);
      if(total<=toCall){ // treat as call if not enough
        const amount=Math.min(toCall,p.chips);
        p.chips-=amount; p.bet+=amount; p.totalBetRound+=amount; this.pot+=amount;
        p.lastAction='call';
      } else {
        p.chips-=total; p.bet+=total; p.totalBetRound+=total; this.pot+=total;
        this.minRaise=total-toCall;
        this.highestBet=p.totalBetRound;
        if(p.chips===0){ p.allIn=true; p.lastAction='allin'; }
        else p.lastAction='raise';
        raised=true;
      }
    } else if(action==='allin'){
      const amount=p.chips;
      if(p.totalBetRound+amount>this.highestBet) this.highestBet=p.totalBetRound+amount;
      this.pot+=amount; p.bet+=amount; p.totalBetRound+=amount; p.chips=0;
      p.allIn=true; p.lastAction='allin';
      raised=true;
    }
    return raised;
  }

  aiDecide(p){
    const toCall=Math.max(0,this.highestBet-p.totalBetRound);
    const str=handStrength(p.holeCards,this.community);
    const pers=p.personality;
    const aggrBonus=pers==='aggressive'?0.15:pers==='bluffer'?0.1:pers==='loose'?0.05:0;
    const tightPen=pers==='tight'?0.12:0;
    const effStr=Math.min(1,Math.max(0,str+aggrBonus-tightPen+(Math.random()-.5)*0.18));
    const potOdds=this.pot>0?toCall/(this.pot+toCall+1):0;
    const bluff=Math.random()<(pers==='bluffer'?.22:pers==='aggressive'?.14:pers==='loose'?.09:.05);

    if(effStr>0.82||bluff&&effStr>0.3){
      if(p.chips<=toCall*2||effStr>0.92) return {action:'allin'};
      const raiseSize=Math.floor(this.pot*rand(0.5,1.3));
      const rAmt=Math.min(Math.max(raiseSize,this.minRaise+toCall),p.chips);
      return {action:'raise',amount:rAmt};
    } else if(effStr>0.58){
      if(toCall===0) return {action:'check'};
      if(effStr>potOdds+0.08) return {action:'call'};
      return {action:'fold'};
    } else if(effStr>0.38){
      if(toCall===0) return {action:'check'};
      if(toCall<=this.bigBlind*2&&effStr>potOdds) return {action:'call'};
      return {action:'fold'};
    } else {
      if(toCall===0) return {action:'check'};
      if(toCall<=this.bigBlind&&Math.random()<0.28) return {action:'call'};
      return {action:'fold'};
    }
  }

  async endRound(){
    if(this.getActivePlayers().length<=1){ await this.showdown(true); return; }

    for(const p of this.players){ p.bet=0; p.totalBetRound=0; }
    this.highestBet=0; this.minRaise=this.bigBlind;
    this.currentRound++;

    if(this.currentRound===1){
      this.community.push(this.deck.pop(),this.deck.pop(),this.deck.pop());
    } else if(this.currentRound===2||this.currentRound===3){
      this.community.push(this.deck.pop());
    } else {
      await this.showdown(); return;
    }

    this.sendState({event:'communityReveal'});
    await sleep(700);

    const firstIdx=this.findNextActive((this.dealerIdx+1)%this.players.length);
    if(firstIdx===-1){ await this.showdown(); return; }
    await this.bettingRound(firstIdx);
  }

  async showdown(earlyWin=false){
    this.phase='showdown';
    const active=this.getActivePlayers();

    let winners=[];
    if(active.length===1||earlyWin&&active.length===1){
      winners=[{player:active[0], hand:evalBestHand([...active[0].holeCards,...this.community])}];
    } else {
      let best=null;
      for(const p of active){
        const hand=evalBestHand([...p.holeCards,...this.community]);
        if(!best||hand.score>best.score){ best=hand; winners=[{player:p,hand}]; }
        else if(hand.score===best.score) winners.push({player:p,hand});
      }
    }

    // Split pot
    const share=Math.floor(this.pot/winners.length);
    for(const w of winners) w.player.chips+=share;

    const winData=winners.map(w=>({
      playerId:w.player.id,
      name:w.player.name,
      avatar:w.player.avatar,
      handName:w.hand?w.hand.name:'',
      handCards:w.hand?w.hand.cards:[],
      amount:share,
      holeCards:w.player.holeCards
    }));

    this.sendState({event:'showdown', winners:winData, earlyWin});
    await sleep(3500);

    this.pot=0;
    // Check bustouts
    for(const p of this.players){
      if(!p.isHuman&&p.chips<=0) p.chips=this.startChips; // AI rebuy
    }

    const humanAlive=this.players.filter(p=>p.isHuman&&p.chips>0);
    if(humanAlive.length===0){
      this.broadcast({type:'gameover',reason:'bust'});
      this.phase='lobby';
      return;
    }

    this.phase='playing';
    await sleep(500);
    await this.dealNewHand();
  }
}

// ═══════════════════════════════════════════════════════════════
//  WebSocket IMPLEMENTATION (pure Node built-ins)
// ═══════════════════════════════════════════════════════════════
const clients = new Map(); // ws -> {id, roomId, playerId}

function wsHandshake(req, socket, head){
  const key=req.headers['sec-websocket-key'];
  if(!key){ socket.destroy(); return; }
  const accept=crypto.createHash('sha1')
    .update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'+
    'Upgrade: websocket\r\n'+
    'Connection: Upgrade\r\n'+
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  setupWSSocket(socket, req);
}

function setupWSSocket(socket, req){
  const ws={socket, buffer:Buffer.alloc(0), closed:false};
  clients.set(ws,{});

  socket.on('data', chunk=>{ ws.buffer=Buffer.concat([ws.buffer,chunk]); parseFrames(ws); });
  socket.on('close',()=>{ ws.closed=true; handleDisconnect(ws); clients.delete(ws); });
  socket.on('error',()=>{ ws.closed=true; handleDisconnect(ws); clients.delete(ws); });

  ws.send=(data)=>wsSend(ws,typeof data==='string'?data:JSON.stringify(data));
  handleConnect(ws, req);
}

function parseFrames(ws){
  while(ws.buffer.length>=2){
    const b0=ws.buffer[0], b1=ws.buffer[1];
    const fin=!!(b0&0x80);
    const opcode=b0&0x0f;
    const masked=!!(b1&0x80);
    let payloadLen=b1&0x7f;
    let offset=2;

    if(payloadLen===126){ if(ws.buffer.length<4) return; payloadLen=ws.buffer.readUInt16BE(2); offset=4; }
    else if(payloadLen===127){ if(ws.buffer.length<10) return; payloadLen=ws.buffer.readUInt32BE(6); offset=10; }

    const maskLen=masked?4:0;
    if(ws.buffer.length<offset+maskLen+payloadLen) return;

    const maskBytes=masked?ws.buffer.slice(offset,offset+4):null;
    offset+=maskLen;
    let payload=ws.buffer.slice(offset,offset+payloadLen);
    if(masked){ payload=Buffer.from(payload); for(let i=0;i<payload.length;i++) payload[i]^=maskBytes[i%4]; }
    ws.buffer=ws.buffer.slice(offset+payloadLen);

    if(opcode===8){ ws.socket.destroy(); return; } // close
    if(opcode===9){ wsPong(ws); continue; }        // ping
    if(opcode===1||opcode===2){
      try{ handleMessage(ws,JSON.parse(payload.toString())); }catch(e){}
    }
  }
}

function wsSend(ws,data){
  if(ws.closed||!ws.socket.writable) return;
  const payload=Buffer.from(typeof data==='string'?data:JSON.stringify(data));
  const len=payload.length;
  let header;
  if(len<126){
    header=Buffer.alloc(2);
    header[0]=0x81; header[1]=len;
  } else if(len<65536){
    header=Buffer.alloc(4);
    header[0]=0x81; header[1]=126;
    header.writeUInt16BE(len,2);
  } else {
    header=Buffer.alloc(10);
    header[0]=0x81; header[1]=127;
    header.writeUInt32BE(0,2); header.writeUInt32BE(len,6);
  }
  try{ ws.socket.write(Buffer.concat([header,payload])); }catch(e){}
}

function wsPong(ws){
  try{ ws.socket.write(Buffer.from([0x8a,0x00])); }catch(e){}
}

// ═══════════════════════════════════════════════════════════════
//  MESSAGE HANDLERS
// ═══════════════════════════════════════════════════════════════
function handleConnect(ws, req){}

function handleDisconnect(ws){
  const info=clients.get(ws)||{};
  const room=info.roomId?rooms[info.roomId]:null;
  if(room&&info.playerId!=null){
    const p=room.players[info.playerId];
    if(p){ p.active=false; p.folded=true; }
    room.broadcast({type:'playerleft',playerId:info.playerId,name:p?.name});
    // Resolve their pending action with fold
    if(room.actionResolver&&room.actionResolver.playerId===info.playerId){
      room.actionResolver.resolve({action:'fold'});
      room.actionResolver=null;
    }
  }
}

async function handleMessage(ws, msg){
  const {type}=msg;
  log('MSG',type,msg.roomId||'');

  if(type==='createRoom'){
    const roomId=genId(6);
    const room=new GameRoom(roomId, msg.name, parseInt(msg.chips)||5000);
    rooms[roomId]=room;

    // Add human host
    const p=room.addPlayer(msg.name,true,null,'🎩');
    room.sockets[p.id]=ws;
    clients.set(ws,{roomId,playerId:p.id});

    // Add AI players
    const aiCount=msg.aiCount!=null?parseInt(msg.aiCount):4;
    for(let i=0;i<aiCount;i++){
      room.addPlayer(AI_NAMES[i],false,null,AI_AVATARS[i]);
    }

    ws.send({type:'roomCreated',roomId,playerId:p.id,
      players:room.players.map(p=>({id:p.id,name:p.name,avatar:p.avatar,isHuman:p.isHuman}))
    });
    log(`Room ${roomId} created by ${msg.name}`);

  } else if(type==='joinRoom'){
    const room=rooms[msg.roomId];
    if(!room){ ws.send({type:'error',msg:'Room not found'}); return; }
    if(room.phase==='playing'){ ws.send({type:'error',msg:'Game already in progress'}); return; }
    if(room.players.filter(p=>p.isHuman).length>=5){ ws.send({type:'error',msg:'Table full'}); return; }

    const p=room.addPlayer(msg.name,true,null,'🎩');
    room.sockets[p.id]=ws;
    clients.set(ws,{roomId:room.id,playerId:p.id});

    room.broadcast({type:'playerJoined',name:p.name,avatar:p.avatar,playerId:p.id},p.id);
    ws.send({type:'roomJoined',roomId:room.id,playerId:p.id,
      players:room.players.map(x=>({id:x.id,name:x.name,avatar:x.avatar,isHuman:x.isHuman}))
    });

  } else if(type==='startGame'){
    const info=clients.get(ws)||{};
    const room=rooms[info.roomId];
    if(!room||info.playerId!==0) return; // only host
    room.phase='playing';
    room.broadcast({type:'gameStarted'});
    room.dealNewHand().catch(e=>log('Game error:',e));

  } else if(type==='action'){
    const info=clients.get(ws)||{};
    const room=rooms[info.roomId];
    if(!room) return;
    if(room.actionResolver&&room.actionResolver.playerId===info.playerId){
      room.actionResolver.resolve({action:msg.action,amount:parseInt(msg.amount)||0});
      room.actionResolver=null;
    }

  } else if(type==='rebuy'){
    const info=clients.get(ws)||{};
    const room=rooms[info.roomId];
    if(!room) return;
    const p=room.players[info.playerId];
    if(p){ p.chips=room.startChips; p.active=true; }
    ws.send({type:'rebuyed',chips:p.chips});
    if(room.phase==='lobby') room.dealNewHand().catch(e=>log('err',e));

  } else if(type==='ping'){
    ws.send({type:'pong'});
  }
}

// ═══════════════════════════════════════════════════════════════
//  HTTP SERVER — serve index.html
// ═══════════════════════════════════════════════════════════════
const HTML = fs.readFileSync(path.join(__dirname,'index.html'),'utf8');

const server = http.createServer((req,res)=>{
const path = req.url.split('?')[0];
if(path==='/'||path==='/index.html'){

    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(HTML);
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.on('upgrade',(req,socket,head)=>{
  if(req.headers.upgrade&&req.headers.upgrade.toLowerCase()==='websocket'){
    wsHandshake(req,socket,head);
  } else {
    socket.destroy();
  }
});

// Cleanup stale rooms every 30min
setInterval(()=>{
  const now=Date.now();
  for(const [id,room] of Object.entries(rooms)){
    if(Object.keys(room.sockets).length===0){
      delete rooms[id];
      log(`Cleaned room ${id}`);
    }
  }
},30*60*1000);

server.listen(PORT,()=>log(`🃏 PSG Poker House running at http://localhost:${PORT}`));
