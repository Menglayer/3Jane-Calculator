// JANE Yield Calculator – MengLayer Simplified
// per-dollar 固定：USD3=0.01, LP=0.014, YT=0.01
// YT：名义本金 = 本金 / YT价格，ROI = (JANE价值 - 本金) / 本金

"use strict";

// ====== 1. Pendle: USD3 市场 / YT 地址 ======
const USD3_MARKET = "0xeaac9b0b4f25cc63255198a3920fcf7752509586".toLowerCase();
const USD3_YT     = "0x8751e87931f084e5e83725110329cf7b27170f89".toLowerCase();

const NETWORK_IDS = {
  ethereum:  "1",
  arbitrum:  "42161",
  base:      "8453",
  mantle:    "5000",
  berachain: "80094",
  hyperevm:  "999"
};

const NETWORK_PATH = {
  ethereum:  "/1",
  arbitrum:  "/42161",
  base:      "/8453",
  mantle:    "/5000",
  berachain: "/80094",
  hyperevm:  "/999"
};

const TRY_NETWORKS = ["ethereum", "arbitrum", "base", "mantle", "berachain", "hyperevm"];

// YT 状态
const ytState = {
  network: "ethereum",
  expiry: null,
  impliedApy: NaN,
  syPriceUsd: 1
};

// 计算得到的 YT 价格 & 杠杆
let ytPrice    = 0;  // USD
let ytLeverage = 1;  // ≈ 1 / ytPrice

// ====== 2. 每种池子的 per-dollar 速率 ======
const PER_DOLLAR_RATE = {
  usd3: 0.01,   // USD3
  lp:   0.014,  // LP
  yt:   0.01    // YT（再乘杠杆）
};

// ====== 3. DOM 元素 ======
const tgeDateInput   = document.getElementById("tge-date");
const fdvInput       = document.getElementById("fdv");
const ttsInput       = document.getElementById("tts");
const poolTypeInput  = document.getElementById("pool-type");
const tvlInput       = document.getElementById("pool-tvl");
const depositInput   = document.getElementById("my-deposit");

const janePriceEl    = document.getElementById("jane-price");
const daysToTgeEl    = document.getElementById("days-to-tge");
const poolDailyEl    = document.getElementById("pool-daily");
const perDollarEl    = document.getElementById("per-dollar");
const myJaneDayEl    = document.getElementById("my-jane-day");
const myUsdDayEl     = document.getElementById("my-usd-day");
const apyEl          = document.getElementById("apy");
const roiTgeEl       = document.getElementById("roi-tge");

const megaDayUsdEl   = document.getElementById("mega-day-usd");
const megaTotalUsdEl = document.getElementById("mega-total-usd");
const megaApyEl      = document.getElementById("mega-apy");
const megaRoiEl      = document.getElementById("mega-roi");

// YT 展示卡片
const ytPriceView    = document.getElementById("yt-price-view");
const ytLevView      = document.getElementById("yt-lev-view");

// 默认 TGE = 2026-01-26
(function initDefaultDate() {
  if (tgeDateInput) tgeDateInput.value = "2026-01-26";
})();

// ====== 4. 工具函数 ======
function parseNumber(el) {
  if (!el) return 0;
  const v = parseFloat(String(el.value || "").replace(/,/g, ""));
  return isFinite(v) ? v : 0;
}

function formatNumber(value, decimals = 2) {
  if (!isFinite(value)) return "-";
  return value.toLocaleString(undefined, {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals
  });
}

function formatPercent(value, decimals = 2) {
  if (!isFinite(value)) return "-";
  return (
    value.toLocaleString(undefined, {
      maximumFractionDigits: decimals,
      minimumFractionDigits: decimals
    }) + "%"
  );
}

// ====== 5. Pendle API Helper（简化版） ======
const _memCache = new Map();
const _now      = () => Date.now();
const _key      = (kind, ident) => `${kind}:${ident}`;

function cacheGet(kind, ident, ttlMs) {
  const k = _key(kind, ident);
  try {
    const raw = sessionStorage.getItem(k);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && obj.ts && _now() - obj.ts < ttlMs) return obj.data;
    }
  } catch (e) {}
  if (_memCache.has(k)) {
    const { ts, data } = _memCache.get(k);
    if (_now() - ts < ttlMs) return data;
  }
  return null;
}

function cacheSet(kind, ident, data) {
  const k = _key(kind, ident);
  const v = { ts: _now(), data };
  _memCache.set(k, v);
  try {
    sessionStorage.setItem(k, JSON.stringify(v));
  } catch (e) {}
  return data;
}

function parseExpiry(raw) {
  if (raw == null) return new Date(NaN);
  if (typeof raw === "number") {
    return new Date(raw > 1e12 ? raw : raw * 1000);
  }
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return new Date(n > 1e12 ? n : n * 1000);
  }
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)
    ? s.replace(" ", "T")
    : s;
  return new Date(iso);
}

function fetchWithTimeout(url, params = {}, timeoutMs = 12000) {
  const u = new URL(url);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(u.toString(), {
    signal: ctrl.signal,
    mode: "cors",
    referrerPolicy: "no-referrer"
  }).finally(() => clearTimeout(t));
}

async function fetchJSON(url, params = {}) {
  const r = await fetchWithTimeout(url, params);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function getAssetsAll(networkName) {
  const key = networkName.toLowerCase();
  const cached = cacheGet("assetsAll", key, 120000);
  if (cached) return cached;

  const path = NETWORK_PATH[key];
  if (!path) throw new Error("Unknown network: " + networkName);

  const data = await fetchJSON(
    "https://api-v2.pendle.finance/core/v3" + path + "/assets/all"
  );
  return cacheSet("assetsAll", key, data);
}

async function getMarketData(networkName, marketAddr) {
  const netKey  = networkName.toLowerCase();
  const chainId = NETWORK_IDS[netKey];
  if (!chainId) throw new Error("Unknown network: " + networkName);

  const cacheK = (netKey + ":" + marketAddr).toLowerCase();
  const cached = cacheGet("marketData", cacheK, 120000);
  if (cached) return cached;

  const tries = [
    `https://api-v2.pendle.finance/core/v4/${chainId}/markets/${marketAddr}/data`,
    `https://api-v2.pendle.finance/core/v3/${chainId}/markets/${marketAddr}/data`,
    `https://api-v2.pendle.finance/core/v2/${chainId}/markets/${marketAddr}/data`
  ];

  for (const u of tries) {
    try {
      const j = await fetchJSON(u);
      if (j) return cacheSet("marketData", cacheK, j);
    } catch (e) {}
  }
  return null;
}

async function resolveYtNetworkAndExpiry(ytAddr) {
  const target = (ytAddr || "").toLowerCase();
  for (const net of TRY_NETWORKS) {
    try {
      const assets = await getAssetsAll(net);
      const arr = Array.isArray(assets)
        ? assets
        : Array.isArray(assets?.assets)
        ? assets.assets
        : [];
      const hit = arr.find(
        (a) =>
          a &&
          String(a.address).toLowerCase() === target &&
          Array.isArray(a.tags) &&
          a.tags.includes("YT")
      );
      if (hit) {
        ytState.network = net;
        ytState.expiry  = hit.expiry ? parseExpiry(hit.expiry) : new Date(NaN);
        return;
      }
    } catch (e) {}
  }
  ytState.network = "ethereum";
  ytState.expiry  = new Date(NaN);
}

async function updateYtPriceFromPendle() {
  try {
    await resolveYtNetworkAndExpiry(USD3_YT);

    const md = await getMarketData(ytState.network, USD3_MARKET);
    if (!md) throw new Error("no market data");

    const dig = (obj, path) =>
      path.reduce(
        (x, k) => (x && x[k] != null ? x[k] : null),
        obj || {}
      );

    let implied =
      Number(md?.impliedApy) ||
      Number(md?.market?.impliedApy) ||
      Number(dig(md, ["result", "impliedApy"]));

    let syUsd =
      Number(md?.syPriceUsd) ||
      Number(md?.market?.syPriceUsd) ||
      Number(md?.underlyingPriceUsd) ||
      Number(dig(md, ["result", "syPriceUsd"])) ||
      1;

    if (!(implied > 0)) implied = 0.05;
    ytState.impliedApy = implied;
    ytState.syPriceUsd = syUsd;

    const now = new Date();
    let mat =
      ytState.expiry instanceof Date && !isNaN(ytState.expiry)
        ? ytState.expiry
        : new Date(now.getTime() + 365 * 24 * 3600 * 1000);

    let yearsToMat = (mat - now) / (365 * 24 * 3600 * 1000);
    if (!isFinite(yearsToMat) || yearsToMat <= 0) yearsToMat = 0.0001;

    const ptAsset = 1 / Math.pow(1 + implied, yearsToMat);
    let ytAsset   = Math.max(0, 1 - ptAsset);
    if (ytAsset < 1e-9) ytAsset = 1e-9;

    const priceUsd = ytAsset * syUsd;

    ytPrice    = priceUsd;
    ytLeverage = ytPrice > 0 ? 1 / ytPrice : 1;

    console.log(
      "[JANE] YT price from Pendle:",
      ytPrice,
      "USD; leverage ≈",
      ytLeverage
    );

    recalc();
  } catch (e) {
    console.warn("updateYtPriceFromPendle error:", e);
    recalc();
  }
}

// ====== 6. 核心计算 ======
function recalc() {
  const fdv       = parseNumber(fdvInput);
  const tts       = parseNumber(ttsInput);
  const poolType  = poolTypeInput.value;  // 'usd3' | 'lp' | 'yt'
  const tvl       = parseNumber(tvlInput);
  const myDeposit = parseNumber(depositInput);

  // JANE 价格
  let janePrice = 0;
  if (fdv > 0 && tts > 0) {
    janePrice = fdv / tts;
  }

  // 距 TGE 天数
  let daysToTge = 0;
  if (tgeDateInput.value) {
    const today = new Date();
    const tge   = new Date(tgeDateInput.value + "T00:00:00");
    const diff  = tge.getTime() - today.getTime();
    daysToTge   = diff > 0 ? diff / (1000 * 60 * 60 * 24) : 0;
  }

  // 顶部显示
  janePriceEl.textContent =
    janePrice > 0 ? "$" + formatNumber(janePrice, 5) : "-";
  daysToTgeEl.textContent =
    daysToTge > 0 ? formatNumber(daysToTge, 1) + " days" : "0";

  // YT 价格 & 杠杆展示
  if (ytPriceView) {
    ytPriceView.textContent =
      ytPrice > 0 ? "$" + formatNumber(ytPrice, 6) : "-";
  }
  if (ytLevView) {
    ytLevView.textContent =
      ytPrice > 0 ? formatNumber(ytLeverage, 2) + "x" : "-";
  }

  // 当前池 per-dollar 速率
  const perDollarRate = PER_DOLLAR_RATE[poolType] || 0.01;
  perDollarEl.textContent =
    formatNumber(perDollarRate, 5) + " JANE / $notional / day";

  if (tvl <= 0 || myDeposit <= 0) {
    poolDailyEl.textContent = "-";
    myJaneDayEl.textContent = "-";
    myUsdDayEl.textContent  = "-";
    apyEl.textContent       = "-";
    roiTgeEl.textContent    = "-";

    megaDayUsdEl.textContent   = "$0";
    megaTotalUsdEl.textContent = "$0";
    megaApyEl.textContent      = "0%";
    megaRoiEl.textContent      = "0%";
    return;
  }

  // 池子的每日排放：TVL × per-dollar-rate
  const dailyEmission = perDollarRate * tvl;

  // 名义本金
  let notional = myDeposit;
  if (poolType === "yt" && ytPrice > 0) {
    notional = myDeposit * ytLeverage; // = deposit / price
  }
  // LP 这版不再拆 SY，直接全算（要拆再说）

  const myJanePerDay = perDollarRate * notional;
  const myUsdPerDay  = myJanePerDay * janePrice;

  const apy =
    myUsdPerDay > 0 && myDeposit > 0
      ? (myUsdPerDay * 365 * 100) / myDeposit
      : 0;

  const totalJaneUntilTge = myJanePerDay * daysToTge;
  const totalUsdUntilTge  = totalJaneUntilTge * janePrice;

  let roiPct = 0;
  if (totalUsdUntilTge > 0 && myDeposit > 0) {
    const grossRoi = totalUsdUntilTge / myDeposit;
    if (poolType === "yt") {
      roiPct = (grossRoi - 1) * 100; // YT：减本金
    } else {
      roiPct = grossRoi * 100;       // USD3 / LP：不减本金
    }
  }

  // 小卡片
  poolDailyEl.textContent =
    formatNumber(dailyEmission, 0) + " JANE / day";
  myJaneDayEl.textContent =
    formatNumber(myJanePerDay, 2) + " JANE / day";
  myUsdDayEl.textContent =
    "$" + formatNumber(myUsdPerDay, 2) + " / day";
  apyEl.textContent    = formatPercent(apy, 2);
  roiTgeEl.textContent = formatPercent(roiPct, 1);

  // 大字块
  megaDayUsdEl.textContent   = "$" + formatNumber(myUsdPerDay, 2);
  megaTotalUsdEl.textContent = "$" + formatNumber(totalUsdUntilTge, 2);
  megaApyEl.textContent      = formatPercent(apy, 1);
  megaRoiEl.textContent      = formatPercent(roiPct, 1);
}

// ====== 7. 事件绑定 & 初始化 ======
[
  tgeDateInput,
  fdvInput,
  ttsInput,
  poolTypeInput,
  tvlInput,
  depositInput
].forEach((el) => {
  if (!el) return;
  el.addEventListener("input", recalc);
  el.addEventListener("change", recalc);
});

// 点击 YT 价格 → 手动输入
if (ytPriceView) {
  ytPriceView.style.cursor = "pointer";
  ytPriceView.title = "点击可手动输入 YT 价格（USD）";
  ytPriceView.addEventListener("click", () => {
    const cur = ytPrice > 0 ? ytPrice : "";
    const s = prompt("手动输入 YT 单价 (USD)：", cur);
    if (s == null) return;
    const v = parseFloat(String(s).trim());
    if (isFinite(v) && v > 0) {
      ytPrice    = v;
      ytLeverage = 1 / v;
      recalc();
    }
  });
}

// 初始计算 + 拉取 YT 价格
recalc();
updateYtPriceFromPendle();
