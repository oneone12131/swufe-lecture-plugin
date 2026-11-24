/* =====================================================
   SWUFE 讲座自动报名 — 后台 Service Worker
   职责：
   1) Server酱 推送
   2) chrome.alarms 闹钟驱动扫描（后台标签被冻结也能按时触发）
   3) 每日固定时间汇总次日讲座并提醒
   ===================================================== */

const SCAN_ALARM = "scan_cycle";
const REMIND_ALARM = "remind_daily";
const KEY_BOOK = "booked";
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
    const ok = await chrome.tabs.sendMessage(t.id, { type: "CYCLE" }).catch(() => null);
    if (!ok) {
      // 页面冻结/未加载 → 刷新标签页唤醒
      console.log("[SWUFE讲座] 页面未响应，刷新标签页唤醒:", t.url);
      chrome.tabs.reload(t.id).catch(() => {});
      continue;
    }
    if (ok.stale) {
      // 内容脚本检测到会话失效提示 → 刷新重登
      console.log("[SWUFE讲座] 检测到失效提示，刷新标签页重登:", t.url);
      chrome.tabs.reload(t.id).catch(() => {});
      continue;
    }
    // 不在列表页、也不在登录页时，才导航回列表页（避免打断登录流程）
    if (!ok.login && lastListUrl && t.url && !t.url.startsWith(lastListUrl)) {
      console.log("[SWUFE讲座] 标签不在列表页，导航回:", lastListUrl);
      chrome.tabs.update(t.id, { url: lastListUrl }).catch(() => {});
    }
  }
}

// ---------- 每日次日讲座提醒 ----------
function nextOccurrence(hhmm) {
  const [h, m] = String(hhmm || "23:00").split(":").map(Number);
  const d = new Date();
  d.setHours(isNaN(h) ? 23 : h, isNaN(m) ? 0 : m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

async function ensureRemindAlarm() {
  await chrome.alarms.clear(REMIND_ALARM).catch(() => {});
  const cfg = await getCfg();
  if (!cfg.enabled || !cfg.serverChanKey) return;
  chrome.alarms.create(REMIND_ALARM, { when: nextOccurrence(cfg.remindTime) });
  console.log("[SWUFE讲座] 提醒闹钟已建立，每日", cfg.remindTime || "23:00");
}

async function fireRemind() {
  const { booked } = await chrome.storage.local.get(KEY_BOOK);
  const arr = booked || [];
  const now = new Date();
  const tom = new Date(now);
  tom.setDate(now.getDate() + 1);
  const dayStart = new Date(tom.getFullYear(), tom.getMonth(), tom.getDate(), 0, 0, 0).getTime();
  const dayEnd = new Date(tom.getFullYear(), tom.getMonth(), tom.getDate(), 23, 59, 59).getTime();
  const list = arr.filter(b => b.startTs && b.startTs >= dayStart && b.startTs <= dayEnd);
  if (list.length) {
    const desp = list.map((b, i) => `${i + 1}. ${b.title}\n时间：${b.time}\n地点：${b.location || "未知"}`).join("\n\n");
    await pushServerChan(`📋 明日讲座提醒（${list.length} 场）`, `${desp}\n\n系统链接：https://webvpn.swufe.edu.cn/`);
  }
  await ensureRemindAlarm(); // 排到第二天同一时间
}

// ---------- 消息监听 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "PUSH") {
    pushServerChan(msg.title, msg.desp).then(sendResponse);
    return true;
  }
  if (msg.type === "CONFIG_UPDATED") {
    ensureScanAlarm().then(ensureRemindAlarm).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// ---------- 安装/更新时初始化 ----------
chrome.runtime.onInstalled.addListener(() => {
  ensureScanAlarm();
  ensureRemindAlarm();
});

// ---------- 闹钟统一处理 ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SCAN_ALARM) {
    await fireScan();
  } else if (alarm.name === REMIND_ALARM) {
    await fireRemind();
  }
});
