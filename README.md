# XRPL Trading Bot — Explained Like a Playground Game

## 1) Introduction
- Think of XRP as the playground’s main marble. It needs no sticker (no issuer).
- Issued coins (like NZD) are marbles with a sticker showing who printed them (the issuer’s r-address). The bot trades these marbles for you.
- The bot watches the playground trades (order books), then can buy or sell marbles automatically. You can keep it in pretend mode (paper) or let it trade for real.

## 2) What you need
- Node.js 20+ and npm (the tools to run the bot).
- A `.env` file: a secret note that holds your keys and settings. Never show it to anyone.

## 3) Setup (step by step)
1. Clone the bot:
   ```bash
   git clone https://github.com/yourname/xrpl-trading-bot.git
   cd xrpl-trading-bot
   ```
2. Install everything (one time, at the root):
   ```bash
   npm install
   ```
3. Make your secret `.env` file (copy from example if you have one) and fill it:
   ```env
   XRPL_WSS_URL=wss://s.altnet.rippletest.net:51233   # testnet server
   XRPL_NETWORK=testnet                              # use "mainnet" for real XRP world
   XRPL_SEED=put_your_secret_seed_here               # never share this
   TRADE_BASE_CURRENCY=XRP
   TRADE_QUOTE_CURRENCY=NZD
   TRADE_ISSUER=rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe    # issuer for NZD on testnet
   PAPER_TRADING=true                                # "pretend" mode (no real trades)
   ```
   - For **mainnet**, change `XRPL_NETWORK=mainnet`, pick a mainnet WebSocket URL, and set a real issuer for your issued coin.

## 4) How to run the bot
- Start both bot (backend) and dashboard (frontend) together:
  ```bash
  npm run dev
  ```
  - Frontend opens at http://localhost:3000 (your dashboard playground).
  - Backend connects to XRPL and watches the books.
- Build everything for production:
  ```bash
  npm run build
  npm start
  ```
- Paper mode vs real:
  - `PAPER_TRADING=true` → pretend trades only; nothing is sent to XRPL.
  - `PAPER_TRADING=false` → real offers/payments are sent. Be sure you know what you’re doing.

## 5) How the bot trades (playground story)
- The bot looks at two buckets: one for what it gives (`taker_pays`) and one for what it gets (`taker_gets`).
- If it pays XRP, it uses the string "XRP". If it pays/gets a stickered marble (like NZD), it uses `{ currency: 'NZD', issuer: 'r...address' }`.
- Order book = a line of kids shouting prices. The bot listens and decides to buy or sell automatically if the deal looks good.

## 6) Tips & safety
- Never share your XRPL_SEED. It is the key to your marbles.
- Always start on **testnet**. It’s the pretend playground.
- Switch to **mainnet** only when you understand what every setting does and you’re okay trading real marbles.

## 7) Troubleshooting (in kid words)
- "Invalid parameters" → Something in the message was wrong. Check that XRP has no issuer and issued coins have a real issuer r-address.
- "Issued currency requires a valid classic issuer address" → You forgot the sticker or wrote it wrong. Set `TRADE_ISSUER` to a real r-address.
- If stuck, flip back to paper mode (`PAPER_TRADING=true`) and testnet while you fix things.
# xrpl-trading-bot
