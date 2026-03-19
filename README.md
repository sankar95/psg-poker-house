# 🃏 Royal Hold'em Poker

A full-stack Texas Hold'em poker game with real-time multiplayer.  
**Zero npm dependencies** — runs on pure Node.js built-ins.

## Quick Start

```bash
node server.js
```

Then open **http://localhost:3000**

## Features

- ✅ Full Texas Hold'em rules (Pre-flop → Flop → Turn → River)
- ✅ 4 AI opponents with personalities (tight, loose, aggressive, bluffer, balanced)
- ✅ Real WebSocket multiplayer via shareable link
- ✅ Hand evaluator: Royal Flush → High Card
- ✅ Fisher-Yates shuffled 52-card deck
- ✅ Fold / Check / Call / Raise / All-in
- ✅ Rebuy system
- ✅ Keyboard shortcuts: F=Fold, C=Call, K=Check, R=Raise, A=All-in

## Multiplayer

1. Click **Create Room** → share the URL shown
2. Friends open the URL and enter their name → **Join**
3. Host clicks **Start Game**
4. Max 5 human players per table

## Custom Port

```bash
PORT=8080 node server.js
```

## Stack

- **Server**: Node.js `http` + hand-rolled WebSocket (RFC 6455) — no npm
- **Frontend**: Vanilla HTML/CSS/JS with WebSocket client


## Deployment

- Used Render and deployed there
URL - https://psg-poker-house.onrender.com