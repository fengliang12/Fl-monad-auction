const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SERVER_WALLET = process.env.SERVER_WALLET;
const RPC_URL = process.env.RPC_URL;
const PRICES = {
  AI_ANALYSIS: process.env.PRICE_AI_ANALYSIS || "0.001",
  PREDICTION: process.env.PRICE_PREDICTION || "0.002",
};

const provider = new ethers.JsonRpcProvider(RPC_URL);
const verifiedPayments = new Map();
let CONTRACT_ADDRESS = null;
try {
  const p = path.resolve(__dirname, "config/deployed.json");
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    CONTRACT_ADDRESS = j?.contractAddress || null;
  }
} catch {}

const CONTRACT_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "auctionId", type: "uint256" }],
    name: "getAuction",
    outputs: [
      { internalType: "address", name: "seller", type: "address" },
      { internalType: "uint256", name: "startPrice", type: "uint256" },
      { internalType: "uint256", name: "highestBid", type: "uint256" },
      { internalType: "address", name: "highestBidder", type: "address" },
      { internalType: "uint256", name: "endTime", type: "uint256" },
      { internalType: "bool", name: "ended", type: "bool" },
      { internalType: "string", name: "itemName", type: "string" },
      { internalType: "bool", name: "claimed", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
];
function getDeployedAddress() {
  try {
    const p = path.resolve(__dirname, "config/deployed.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      return j?.contractAddress || null;
    }
  } catch {}
  return CONTRACT_ADDRESS || null;
}

/**
 * 验证支付是否有效
 * @param {*} txHash
 * @param {*} expectedAmount
 * @param {*} recipient
 * @returns
 */
async function verifyPayment(txHash, expectedAmount, recipient) {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return false;
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return false;
    const actualAmount = ethers.formatEther(tx.value);
    const expected = parseFloat(expectedAmount);
    const actual = parseFloat(actualAmount);
    if (actual < expected * 0.99) return false;
    if (!tx.to || tx.to.toLowerCase() !== recipient.toLowerCase()) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 检查支付是否有效
 * @param {*} price
 * @returns
 */
function requirePayment(price) {
  return async (req, res, next) => {
    if (process.env.DEV_SKIP_PAYMENT === "true") return next();
    const paymentProof = req.headers["x-payment-proof"];
    if (!paymentProof) {
      return res.status(402).json({
        error: "Payment Required",
        message: "This API requires payment to access",
        payment: {
          amount: price,
          currency: "MON",
          recipient: SERVER_WALLET,
          protocol: "x402",
        },
      });
    }
    if (verifiedPayments.has(paymentProof)) return next();
    const isValid = await verifyPayment(paymentProof, price, SERVER_WALLET);
    if (!isValid) {
      return res.status(402).json({
        error: "Invalid Payment",
        message: "Payment verification failed",
        payment: {
          amount: price,
          currency: "MON",
          recipient: SERVER_WALLET,
          protocol: "x402",
        },
      });
    }
    verifiedPayments.set(paymentProof, {
      timestamp: Date.now(),
      amount: price,
    });
    next();
  };
}

/**
 * 分析
 */
app.get(
  "/api/auction/:id/analysis",
  requirePayment(PRICES.AI_ANALYSIS),
  async (req, res) => {
    const { id } = req.params;
    try {
      const addr = getDeployedAddress();
      if (!addr)
        return res.status(500).json({ error: "Contract not configured" });
      const auctionContract = new ethers.Contract(addr, CONTRACT_ABI, provider);
      try {
        const code = await provider.getCode(addr);
        if (!code || code === "0x") {
          return res
            .status(500)
            .json({ error: "Contract not deployed on current RPC" });
        }
      } catch (_) {}
      const r = await auctionContract.getAuction(BigInt(id));
      const startPrice = Number(ethers.formatEther(r[1]));
      const highestBid = Number(ethers.formatEther(r[2]));
      const endTimeSec = Number(r[4]);
      const ended = !!r[5];
      const itemName = String(r[6] || "");
      const currentPrice = highestBid > 0 ? highestBid : startPrice;
      const nowSec = Math.floor(Date.now() / 1000);
      const timeLeftSec = Math.max(0, endTimeSec - nowSec);
      const priceGain =
        startPrice > 0 ? (currentPrice - startPrice) / startPrice : 0;
      const urgency = ended
        ? 0
        : timeLeftSec < 300
        ? 1
        : timeLeftSec < 1800
        ? 0.6
        : 0.3;
      const trend = priceGain > 0.05 ? "increasing" : "stable";
      const delta = randomFloat(currentPrice * 0.5, currentPrice * 1.0, 6);
      const predictedPrice = Number((currentPrice + delta).toFixed(6));
      const suggestedBid = Number(
        (currentPrice * (1 + 0.01 + 0.02 * urgency)).toFixed(6)
      );
      const confidence = Number(
        Math.max(
          0.65,
          Math.min(
            0.93,
            0.7 +
              (priceGain > 0 ? Math.min(priceGain, 0.5) * 0.3 : 0) -
              (timeLeftSec < 60 ? 0.05 : 0)
          )
        ).toFixed(6)
      );
      const reason = `拍卖品「${
        itemName || "未知物品"
      }」当前价 ${currentPrice.toFixed(6)} MON，起拍价 ${startPrice.toFixed(
        6
      )} MON，剩余时间 ${formatTime(timeLeftSec)}。${
        trend === "increasing"
          ? "出价活跃，建议小幅抬价以提高成交概率。"
          : "价格平稳，仍有博弈空间，可谨慎加价。"
      }`;
      res.json({
        auctionId: id,
        trend,
        currentPrice,
        predictedPrice,
        suggestedBid,
        confidence,
        reason,
        timestamp: new Date().toISOString(),
        provider: "Monad Auction Analytics",
        protocol: "x402",
      });
    } catch (e) {
      res.status(500).json({ error: e?.message || "analysis_failed" });
    }
  }
);

/**
 * 预测
 */
app.get(
  "/api/auction/:id/prediction",
  requirePayment(PRICES.PREDICTION),
  async (req, res) => {
    const { id } = req.params;
    try {
      const addr = getDeployedAddress();
      if (!addr)
        return res.status(500).json({ error: "Contract not configured" });
      const auctionContract = new ethers.Contract(addr, CONTRACT_ABI, provider);
      try {
        const code = await provider.getCode(addr);
        if (!code || code === "0x") {
          return res
            .status(500)
            .json({ error: "Contract not deployed on current RPC" });
        }
      } catch (_) {}
      const r = await auctionContract.getAuction(BigInt(id));
      const startPrice = Number(ethers.formatEther(r[1]));
      const highestBid = Number(ethers.formatEther(r[2]));
      const endTimeSec = Number(r[4]);
      const currentPrice = highestBid > 0 ? highestBid : startPrice;
      const nowSec = Math.floor(Date.now() / 1000);
      const timeLeftSec = Math.max(0, endTimeSec - nowSec);
      const urgency = timeLeftSec < 300 ? 1 : timeLeftSec < 1800 ? 0.6 : 0.3;
      const gen = () => {
        const delta = randomFloat(currentPrice * 0.5, currentPrice * 1.0, 6);
        return Number((currentPrice + delta).toFixed(6));
      };
      const p1 = gen();
      const p2 = gen();
      const p3 = gen();
      res.json({
        auctionId: id,
        predictions: [
          { time: "1小时后", price: p1 },
          { time: "2小时后", price: p2 },
          { time: "3小时后", price: p3 },
        ],
        confidence: Number(
          Math.max(0.65, Math.min(0.92, 0.72 + 0.05 * urgency))
        ).toFixed(6),
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ error: e?.message || "prediction_failed" });
    }
  }
);

/**
 * 健康检查
 */
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    protocol: "x402",
    serverWallet: SERVER_WALLET,
    prices: PRICES,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`x402 server listening on ${PORT}`);
});

function formatTime(sec) {
  if (sec <= 0) return "已结束";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}小时${m}分钟`;
  if (m > 0) return `${m}分钟${s}秒`;
  return `${s}秒`;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max, decimals = 2) {
  const val = Math.random() * (max - min) + min;
  return Number(val.toFixed(decimals));
}
