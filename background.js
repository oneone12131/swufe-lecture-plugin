/* =====================================================
   SWUFE 讲座自动报名 — 后台 Service Worker
   职责：
   1) Server酱 推送
   2) chrome.alarms 闹钟驱动扫描（后台标签被冻结也能按时触发）
   3) 定时保险检查
   ===================================================== */

const SCAN_ALARM = "scan_cycle";   // 每轮扫描闹钟
const INS_ALARM = "insurance_check"; // 保险检查闹钟（每15分钟）
const SWUFE_URLS = ["https://webvpn.swufe.edu.cn/*", "https://*.swufe.edu.cn/*"];

async function getCfg() {
  const { cfg } = await chrome.storage.local.get("cfg");
  return cfg || {};
}

// ---------- Server酱 推送 ----------
async function pushServerChan(title, desp) {
  const cfg = await getCfg();
  const key = cfg.serverChanKey || "";
  if (!key) {
    console.warn("[SWUFE讲座] 未配置 Server酱 SendKey");
    return { ok: false, err: "no key" };
  }
  try {
    const url = `https://sctapi.ftqq.com/${key}.send`;
    const body = new URLSearchParams({ title: String(title || ""), desp: String(desp || "") });
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    const j = await resp.json().catch(() => null);
    return { ok: !!(j && j.code === 0), data: j };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}

// ---------- 扫描闹钟管理 ----------
async function ensureScanAlarm() {
  await chrome.alarms.clear(SCAN_ALARM).catch(() => {});
  const cfg = await getCfg();
  if (!cfg.enabled) return;
  const period = Math.max(1, Math.min(5, parseFloat(cfg.intervalMin) || 2));
  chrome.alarms.create(SCAN_ALARM, { periodInMinutes: period });
  console.log("[SWUFE讲座] 扫描闹钟已建立，每", period, "分钟触发");
}

// 闹钟触发：唤醒/刷新讲座标签页
async function fireScan() {
  const { lastListUrl } = await chrome.storage.local.get("lastListUrl");
  const tabs = await chrome.tabs.query({ url: SWUFE_URLS }).catch(() => []);
  for (const t of tabs) {
    if (!t.id) continue;
    // 若标签已离开讲座列表页且我们记得列表页地址 → 先导航回去
    if (lastListUrl && t.url && !t.url.startsWith(lastListUrl)) {
      console.log("[SWUFE讲座] 标签不在列表页，导航回:", lastListUrl);
      chrome.tabs.update(t.id, { url: lastListUrl }).catch(() => {});
      continue;
    }
    // 页面活着且已加载 → 直接触发一轮扫描（更快，不动页面）
    const ok = await chrome.tabs.sendMessage(t.id, { type: "CYCLE" }).catch(() => null);
    if (!ok) {
      // 页面被冻结/未加载 → 刷新标签页，加载后内容脚本自动扫描一轮
      console.log("[SWUFE讲座] 页面未响应，刷新标签页唤醒:", t.url);
      chrome.tabs.reload(t.id).catch(() => {});
    }
  }
}

// ---------- 消息监听 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "PUSH") {
    pushServerChan(msg.title, msg.desp).then(sendResponse);
    return true;
  }
  if (msg.type === "CONFIG_UPDATED") {
    ensureScanAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// ---------- 安装/更新时初始化 ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(INS_ALARM, { periodInMinutes: 15 });
  ensureScanAlarm();
});

// ---------- 闹钟统一处理 ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SCAN_ALARM) {
    await fireScan();
  } else if (alarm.name === INS_ALARM) {
    const tabs = await chrome.tabs.query({ url: SWUFE_URLS }).catch(() => []);
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { type: "INSURANCE_CHECK" }).catch(() => {});
    }
  }
});
