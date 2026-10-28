/* SWUFE 讲座自动报名 — 弹窗脚本 */
const $ = s => document.querySelector(s);

const FIELDS = [
  ["enabled", "checkbox"],
  ["dryRun", "checkbox"],
  ["campus", "text"],
  ["lectureForm", "text"],
  ["titleKeywords", "csv"],
  ["categoryKeywords", "csv"],
  ["hostKeywords", "csv"],
  ["intervalMin", "number"],
  ["serverChanKey", "text"],
  ["insEnabled", "checkboxIns"],
  ["confirmWindowHours", "number"],
  ["autoCancelHoursBeforeStart", "number"]
];

function toCsv(v) { return Array.isArray(v) ? v.join(",") : (v || ""); }
function fromCsv(s) { return String(s || "").split(/[,，]/).map(x => x.trim()).filter(Boolean); }

// 两校区节次表（与 content.js 保持一致）
const PERIODS = {
  "柳林": [
    ["08:30", "09:15"], ["09:25", "10:10"], ["10:20", "11:05"], ["11:15", "12:00"],
    ["13:00", "13:45"], ["13:55", "14:40"], ["14:50", "15:35"], ["15:45", "16:30"], ["16:40", "17:25"],
    ["18:30", "19:15"], ["19:25", "20:10"], ["20:20", "21:05"]
  ],
  "光华": [
    ["08:30", "09:15"], ["09:25", "10:10"], ["10:20", "11:05"], ["11:15", "12:00"],
    ["14:00", "14:45"], ["14:55", "15:40"], ["15:50", "16:35"], ["16:45", "17:30"],
    ["19:00", "19:45"], ["19:55", "20:40"], ["20:50", "21:35"]
  ]
};
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
let occState = {}; // { 周几(1..7): Set(节次) }

async function load() {
  const { cfg } = await chrome.storage.local.get("cfg");
  const c = cfg || {};
  $("#enabled").checked = !!c.enabled;
  $("#dryRun").checked = !!c.dryRun;
  $("#campus").value = c.campus || "";
  $("#lectureForm").value = c.lectureForm || "";
  $("#titleKeywords").value = toCsv(c.titleKeywords);
  $("#categoryKeywords").value = toCsv(c.categoryKeywords);
  $("#hostKeywords").value = toCsv(c.hostKeywords);
  $("#intervalMin").value = c.intervalMin || 2;
  $("#serverChanKey").value = c.serverChanKey || "";
  $("#insEnabled").checked = !!(c.insurance && c.insurance.enabled);
  $("#confirmWindowHours").value = (c.insurance && c.insurance.confirmWindowHours) || 2;
  $("#autoCancelHoursBeforeStart").value = (c.insurance && c.insurance.autoCancelHoursBeforeStart) || 3;
  // 课表
  const sc = c.schedule || {};
  $("#myCampus").value = sc.myCampus || "柳林";
  $("#scheduleEnabled").checked = sc.enabled !== false;
  occState = {};
  for (const [wd, arr] of Object.entries(sc.occupied || {})) {
    occState[wd] = new Set(arr.map(Number));
  }
  renderGrid();
}

function renderGrid() {
  const campus = $("#myCampus").value;
  const periods = PERIODS[campus] || [];
  const grid = $("#scheduleGrid");
  grid.innerHTML = "";
  // 表头
  let html = '<div class="ghead glabel">节次</div>' +
    WEEKDAYS.map(d => `<div class="ghead">周${d}</div>`).join("");
  // 行
  periods.forEach((p, idx) => {
    const n = String(idx + 1).padStart(2, "0");
    html += `<div class="gcell glabel"><b>${n}</b><span class="t">${p[0]}-${p[1]}</span></div>`;
    WEEKDAYS.forEach((d, di) => {
      const wd = String(di + 1);
      const on = occState[wd] && occState[wd].has(idx + 1);
      html += `<div class="gcell ${on ? "on" : ""}" data-w="${wd}" data-p="${idx + 1}"></div>`;
    });
  });
  grid.innerHTML = html;
  grid.querySelectorAll(".gcell[data-w]").forEach(c => {
    c.addEventListener("click", () => {
      const w = c.dataset.w, p = +c.dataset.p;
      occState[w] = occState[w] || new Set();
      if (occState[w].has(p)) occState[w].delete(p); else occState[w].add(p);
      c.classList.toggle("on");
      save();
    });
  });
}

async function save() {
  const schedule = {
    enabled: $("#scheduleEnabled").checked,
    myCampus: $("#myCampus").value,
    occupied: {}
  };
  for (const [wd, set] of Object.entries(occState)) {
    const arr = [...set].sort((a, b) => a - b);
    if (arr.length) schedule.occupied[wd] = arr;
  }
  const cfg = {
    enabled: $("#enabled").checked,
    dryRun: $("#dryRun").checked,
    campus: $("#campus").value.trim(),
    lectureForm: $("#lectureForm").value.trim(),
    titleKeywords: fromCsv($("#titleKeywords").value),
    categoryKeywords: fromCsv($("#categoryKeywords").value),
    hostKeywords: fromCsv($("#hostKeywords").value),
    intervalMin: parseFloat($("#intervalMin").value) || 2,
    serverChanKey: $("#serverChanKey").value.trim(),
    refreshMode: "reload",
    schedule,
    insurance: {
      enabled: $("#insEnabled").checked,
      confirmWindowHours: parseInt($("#confirmWindowHours").value) || 2,
      autoCancelHoursBeforeStart: parseInt($("#autoCancelHoursBeforeStart").value) || 3
    }
  };
  await chrome.storage.local.set({ cfg });
  chrome.runtime.sendMessage({ type: "CONFIG_UPDATED" }).catch(() => {}); // 通知后台重建扫描闹钟
  $("#saveTip").textContent = "已保存 ✓";
  setTimeout(() => { $("#saveTip").textContent = ""; }, 2000);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(type, extra) {
  const tab = await activeTab();
  if (!tab || !tab.id) { return { err: "无活动标签页" }; }
  return chrome.tabs.sendMessage(tab.id, { type, ...extra }).catch(e => ({ err: String(e) }));
}

async function renderPending() {
  const { pending } = await chrome.storage.local.get("pending");
  const list = $("#pendingList");
  list.innerHTML = "";
  const arr = pending || [];
  if (!arr.length) { list.innerHTML = "<div class='empty'>暂无待确认报名</div>"; return; }
  for (const p of arr.slice().reverse()) {
    const d = document.createElement("div");
    d.className = "item";
    const status = { pending: "⏳待确认", confirmed: "✅已确认", cancelled: "🚫已取消", expired: "⚠️需手动" }[p.status] || p.status;
    d.innerHTML = `
      <div><b>${p.title}</b> <span class="tag">${status}</span></div>
      <div class="sub">${p.time || ""} · ${p.location || ""}</div>
      <div class="btnrow small">
        <button class="btn ok" data-k="${p.key}" data-a="confirm">确认参加</button>
        <button class="btn danger" data-k="${p.key}" data-a="cancel">取消报名</button>
      </div>`;
    list.appendChild(d);
  }
  list.querySelectorAll("button[data-a]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.k, act = btn.dataset.a;
      const { pending: pd } = await chrome.storage.local.get("pending");
      const p = (pd || []).find(x => x.key === key);
      if (!p) return;
      if (act === "confirm") {
        p.status = "confirmed";
        await chrome.storage.local.set({ pending: pd });
        renderPending();
      } else {
        const r = await sendToTab("CANCEL", { key });
        if (!r || r.err) { alert("请在讲座页面上执行取消，插件当前未连接该页面"); return; }
        p.status = "cancelled";
        await chrome.storage.local.set({ pending: pd });
        renderPending();
      }
    });
  });
}

async function renderLogs() {
  const state = await sendToTab("GET_STATE");
  if (state && state.logs && state.logs.length) {
    $("#logs").textContent = state.logs.slice(-60).join("\n");
  } else {
    $("#logs").textContent = "（日志来自讲座页面内容脚本；请打开讲座页面后查看）";
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await load();
  await renderPending();
  await renderLogs();
  chrome.runtime.sendMessage({ type: "CONFIG_UPDATED" }).catch(() => {}); // 确保扫描闹钟存在

  $("#save").addEventListener("click", async () => { await save(); await renderLogs(); });

  // 课表：切换校区时按该校区节次时间重画网格
  $("#myCampus").addEventListener("change", () => { renderGrid(); });

  // ③ 自动保存：任何输入变化即写入存储，切换页面/关弹窗后再开也不会丢
  let _autosaveTimer;
  document.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("input", () => {
      clearTimeout(_autosaveTimer);
      _autosaveTimer = setTimeout(() => { save(); }, 400);
    });
  });

  // ② 按 Enter：空框则把默认提示(placeholder)填入，然后保存
  document.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!inp.value.trim() && inp.placeholder) inp.value = inp.placeholder;
      save();
    });
  });
  $("#scanNow").addEventListener("click", async () => {
    const r = await sendToTab("CYCLE");
    $("#saveTip").textContent = r && !r.err ? "已触发扫描，见页面日志" : "未连接讲座页面，请先打开讲座页";
  });
  // 重置已报名记录：清掉脏数据（之前误判/已取消的），让插件可以重新尝试
  $("#resetReg").addEventListener("click", async () => {
    if (!confirm("确定清除所有“已报名/待确认”记录？\n\n用于清掉误判留下的脏数据。清除后，插件会重新尝试报名符合条件的讲座。")) return;
    await chrome.storage.local.set({ registered: [], pending: [] });
    await renderPending();
    $("#saveTip").textContent = "已重置报名记录 ✓ 可再次“立即扫描一次”";
  });
  $("#testPush").addEventListener("click", async () => {
    await save();
    const r = await chrome.runtime.sendMessage({ type: "PUSH", title: "测试消息", desp: "来自 SWUFE讲座插件的测试推送。" }).catch(e => ({ err: String(e) }));
    if (r && r.err) { alert("推送失败：" + r.err + "；请确认 SendKey 已正确填写。"); }
    else { $("#saveTip").textContent = "推送已发出，请查看微信"; }
  });
});
