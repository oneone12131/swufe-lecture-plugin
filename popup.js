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
  ["remindTime", "time"]
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
  $("#remindTime").value = c.remindTime || "23:00";
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
  let html = '<div class="ghead glabel">节次</div>' +
    WEEKDAYS.map(d => `<div class="ghead">周${d}</div>`).join("");
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
    remindTime: $("#remindTime").value || "23:00",
    refreshMode: "reload",
    schedule
  };
  await chrome.storage.local.set({ cfg });
  chrome.runtime.sendMessage({ type: "CONFIG_UPDATED" }).catch(() => {});
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
  await renderLogs();
  chrome.runtime.sendMessage({ type: "CONFIG_UPDATED" }).catch(() => {});

  $("#save").addEventListener("click", async () => { await save(); await renderLogs(); });

  $("#myCampus").addEventListener("change", () => { renderGrid(); });

  // 自动保存：任何输入变化即写入存储，切换页面/关弹窗后再开也不会丢
  let _autosaveTimer;
  document.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("input", () => {
      clearTimeout(_autosaveTimer);
      _autosaveTimer = setTimeout(() => { save(); }, 400);
    });
  });

  // 按 Enter：空框则把默认提示(placeholder)填入，然后保存
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
    if (!confirm("确定清除所有已报名记录？\n\n用于清掉误判留下的脏数据。清除后，插件会重新尝试报名符合条件的讲座。")) return;
    await chrome.storage.local.set({ booked: [] });
    $("#saveTip").textContent = "已重置报名记录 ✓ 可再次“立即扫描一次”";
  });

  $("#testPush").addEventListener("click", async () => {
    await save();
    const r = await chrome.runtime.sendMessage({ type: "PUSH", title: "测试消息", desp: "来自 SWUFE讲座插件的测试推送。" }).catch(e => ({ err: String(e) }));
    if (r && r.err) { alert("推送失败：" + r.err + "；请确认 SendKey 已正确填写，或留空则不推送。"); }
    else { $("#saveTip").textContent = "推送已发出，请查看微信"; }
  });
});
