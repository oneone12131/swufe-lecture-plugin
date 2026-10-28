/* =====================================================
   SWUFE 讲座自动报名 — 内容脚本 (Content Script)
   运行于 WebVPN 学术讲座列表页

   工作流（每轮）：
   1) 点击页面上的「讲座报名」按钮 → 弹出报名表格弹窗
   2) 解析表格每一行（讲座名称/主办单位/讲座形式/时间/地点/类别/操作）
   3) 用你设置的规则过滤，命中且未报过的 → 点「报名」→ 处理确认弹窗
   4) 报名成功 → Server酱 推送到微信（保险版：附确认/自动取消逻辑）
   5) 整页刷新或定时，进入下一轮

   说明：页面元素基于"文字"匹配，若抓不到请按 README 微调选择器。
   ===================================================== */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: false,               // 总开关
    intervalMin: 2,               // 刷新/扫描间隔（分钟），你要求 1~2 分钟
    campus: "",                   // 校区过滤："柳林" / "光华" / 空=不限
    lectureForm: "线下",          // 讲座形式："线下"/"线上"/空=不限
    categoryKeywords: [],         // 讲座类别关键词白名单，空=不限
    hostKeywords: [],             // 主办单位关键词白名单，空=不限
    titleKeywords: [],            // 讲座名称关键词白名单，空=不限
    serverChanKey: "",            // Server酱(方糖) SendKey
    dryRun: false,                // true=只扫描不真正报名（调试用）
    refreshMode: "reload",        // "reload"整页刷新 / "reopen"只重开弹窗不刷新
    // 两校区节次→起止时间（第X节，1-based）
    periods: {
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
    },
    schedule: {                   // 课表冲突排除
      enabled: true,
      myCampus: "柳林",            // 课表所在校区（决定“节次→时间”换算）
      occupied: {}                 // { "1":[1,2,3], "2":[5,6], ... } 周几(1=周一..7=周日) → 被占用的节次
    },
    insurance: {                  // 保险版
      enabled: true,
      confirmWindowHours: 2,      // 报名后给用户确认的时间（小时）
      autoCancelHoursBeforeStart: 3 // 讲座开始前 N 小时仍未确认 → 自动取消
    }
  };

  const STORAGE_CFG = "cfg";
  const KEY_REG = "registered";   // 已报名 key
  const KEY_PEND = "pending";     // 待确认
  const KEY_LOG = "publishLog";   // 首次发现讲座的时间记录（供后续统计发布规律）

  const logs = [];
  function log(...a) {
    const s = a.map(x => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ");
    console.log("[SWUFE讲座]", s);
    logs.push(new Date().toLocaleTimeString("zh-CN", { hour12: false }) + " " + s);
    if (logs.length > 300) logs.shift();
  }

  const $all = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let cfg = { ...DEFAULTS };
  async function getCfg() {
    const { [STORAGE_CFG]: c } = await chrome.storage.local.get(STORAGE_CFG);
    cfg = { ...DEFAULTS, ...(c || {}) };
    return cfg;
  }
  async function saveCfg() { await chrome.storage.local.set({ [STORAGE_CFG]: cfg }); }
  async function getArr(k) { const o = await chrome.storage.local.get(k); return o[k] || []; }
  async function setArr(k, v) { await chrome.storage.local.set({ [k]: v }); }

  /* ---------------- 元素查找（基于文字） ---------------- */
  function clickableByText(text) {
    return $all('button, a, [role="button"], [class*="btn"], [class*="button"], [class*="link"]')
      .find(el => (el.innerText || "").trim().includes(text));
  }
  function tableWithHeader(label) {
    const tables = $all("table");
    // 优先挑“带报名按钮”的表格（即报名弹窗），避免选中背景列表里也含“讲座名称”的其他表格
    const withBtn = tables.filter(t => (t.innerText || "").includes("报名"));
    const pool = withBtn.length ? withBtn : tables;
    return pool.find(t => (t.innerText || "").includes(label)) || null;
  }
  function isVisible(el) { return !!(el && el.offsetParent !== null); }
  async function waitFor(fn, timeout = 8000, step = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(step); }
    return false;
  }

  /* ---------------- 打开「讲座报名」弹窗 ---------------- */
  async function openModal() {
    const btn = clickableByText("讲座报名");
    if (!btn) { log("未找到「讲座报名」按钮，可能不在讲座列表页"); return false; }
    if (isVisible(btn)) btn.click();
    await sleep(900);
    return waitFor(() => { const t = tableWithHeader("讲座名称"); return t && isVisible(t); }, 6000);
  }

  /* ---------------- 解析报名表格 ---------------- */
  function parseRows() {
    const tbl = tableWithHeader("讲座名称");
    if (!tbl) return [];
    // 表头：找含“讲座名称”的那一行
    const headerRow = $all("tr", tbl).find(tr => (tr.innerText || "").includes("讲座名称"));
    const headers = headerRow ? $all("th,td", headerRow).map(c => (c.innerText || "").trim()) : [];
    const colOf = name => { const i = headers.indexOf(name); return i >= 0 ? i : headers.findIndex(h => h.includes(name)); };
    const rows = [];
    // 只解析“操作”列里有【报名】按钮的行（即可报名的讲座），更稳
    for (const tr of $all("tr", tbl)) {
      if ((tr.innerText || "").includes("讲座名称")) continue; // 跳过表头
      const hasRegBtn = $all("button, a, [role=button], [class*=btn]", tr)
        .some(b => (b.innerText || "").trim() === "报名");
      if (!hasRegBtn) continue;
      const tds = $all("td", tr);
      const cells = tds.map(c => (c.innerText || "").trim());
      if (!cells.length || !cells[0]) continue;
      const g = name => { const i = colOf(name); return i >= 0 ? (cells[i] || "") : ""; };
      rows.push({
        name: g("讲座名称"),
        host: g("讲座主办单位"),
        form: g("讲座形式"),
        time: g("讲座时间"),
        location: g("讲座地点"),
        category: g("讲座类别"),
        key: (g("讲座名称") || "") + "|" + (g("讲座时间") || ""),
        cellsEl: tds
      });
    }
    return rows;
  }

  /* ---------------- 条件匹配 ---------------- */
  function parseStart(timeStr) {
    const m = String(timeStr || "").match(/(\d{4}-\d{2}-\d{2})[ ]?(\d{1,2}):(\d{2})/);
    return m ? new Date(`${m[1]}T${String(m[2]).padStart(2, "0")}:${m[3]}:00`) : null;
  }
  function timeToMin(t) {
    const m = String(t || "").match(/(\d{1,2}):(\d{2})/);
    return m ? (+m[1] * 60 + +m[2]) : null;
  }
  // 解析讲座[开始,结束]的当天分钟数（处理跨天/未给结束的情况）
  function lectureRange(lec) {
    const st = parseStart(lec.time);
    if (!st) return null;
    const ls = st.getHours() * 60 + st.getMinutes();
    const em = String(lec.time || "").match(/-\s*(?:\d{4}-\d{2}-\d{2}[ ])?(\d{1,2}):(\d{2})/);
    const le = em ? (+em[1] * 60 + +em[2]) : ls + 60;
    return { start: ls, end: le, weekday: String(st.getDay() === 0 ? 7 : st.getDay()) };
  }
  // 课表冲突判断：用“我的校区”把被占用节次换算成时间段，再与讲座时间做重叠比较
  function isScheduleConflict(lec) {
    const sc = cfg.schedule;
    if (!sc || !sc.enabled) return false;
    const rng = lectureRange(lec);
    if (!rng) return false;
    const occ = (sc.occupied || {})[rng.weekday] || [];
    if (!occ.length) return false;
    const table = (cfg.periods || {})[sc.myCampus] || [];
    for (const idx of occ) {
      const p = table[idx - 1];
      if (!p) continue;
      const ps = timeToMin(p[0]), pe = timeToMin(p[1]);
      if (ps != null && pe != null && rng.start < pe && rng.end > ps) return true; // 与占用时段重叠
    }
    return false;
  }
  // 返回讲座被哪条规则排除的原因；null=可报名
  function whyNotMatch(lec) {
    if (cfg.campus && !(lec.location || "").includes(cfg.campus)) return "校区不符";
    if (cfg.lectureForm && !(lec.form || "").includes(cfg.lectureForm)) return "讲座形式不符";
    if (cfg.categoryKeywords.length && !cfg.categoryKeywords.some(k => (lec.category || "").includes(k))) return "类别不符";
    if (cfg.hostKeywords.length && !cfg.hostKeywords.some(k => (lec.host || "").includes(k))) return "主办不符";
    if (cfg.titleKeywords.length && !cfg.titleKeywords.some(k => (lec.name || "").includes(k))) return "名称关键词不符";
    if (isScheduleConflict(lec)) return "与课表冲突";
    return null;
  }
  function matches(lec) { return whyNotMatch(lec) === null; }

  /* ---------------- 报名 ---------------- */
  // 已满/失败冷却：避免反复点同一个已满的讲座（分钟）
  const failCooldownMin = 10;
  const failCooldown = {}; // key -> 上次失败时间戳

  function visibleMsgs() {
    const sel = "[class*='message' i], [class*='toast' i], [class*='dialog' i], [class*='alert' i], [class*='popup' i], [class*='notice' i]";
    return $all(sel).filter(el => isVisible(el));
  }
  function msgText() {
    return visibleMsgs().map(el => (el.innerText || "").trim()).filter(Boolean).join(" | ");
  }
  function closeMsgs() {
    for (const d of visibleMsgs()) {
      const yes = $all("button, a, [role=button], [class*=btn]", d).find(b => /确定|关闭|知道了|确认/.test((b.innerText || "").trim()) && isVisible(b));
      if (yes) { yes.click(); return; }
    }
  }
  const FAIL_WORDS = ["已满", "无法报名", "报名失败", "失败", "已报满", "人数已满", "名额已满", "没有名额", "名额不足", "已达上限", "已达", "不可报名", "不能报名", "无效", "错误", "已停止", "满了"];
  const SUCCESS_WORDS = ["报名成功", "预约成功", "报名完成", "报名已", "成功"];
  // 找到单元格里真正的“报名”按钮（优先 button 元素，避免点到内层 span 没反应）
  function realButton(cell, text) {
    const candidates = $all("button, a, [role=button], [class*=btn], [onclick]", cell)
      .filter(el => (el.innerText || "").trim() === text || (el.innerText || "").trim().includes(text));
    return candidates.find(el => el.tagName === "BUTTON") || candidates[0] || null;
  }
  // 检查该行是否已变成“已报名/取消”状态（成功信号）
  function rowChanged(lec) {
    const cell = lec.cellsEl && lec.cellsEl[lec.cellsEl.length - 1];
    const t = cell ? (cell.innerText || "") : "";
    return t.includes("已报名") || t.includes("取消");
  }
  // 等待并判定报名结果：success / fail / unknown(有提示但无法判断) / none(毫无反应)
  async function waitForResult(timeout = 3500) {
    const t0 = Date.now();
    let saw = false;
    while (Date.now() - t0 < timeout) {
      const txt = msgText();
      if (txt) {
        saw = true;
        if (FAIL_WORDS.some(w => txt.includes(w))) return "fail";
        if (SUCCESS_WORDS.some(w => txt.includes(w))) return "success";
      }
      // 若出现“是否确认报名”类弹窗，点“确认/确定”继续
      const dlg = visibleMsgs().find(d => /确认|确定|是否/.test(d.innerText || "") && /报名/.test(d.innerText || ""));
      if (dlg) {
        const yes = $all("button, a, [role=button], [class*=btn]", dlg).find(b => /确认|确定/.test((b.innerText || "").trim()) && isVisible(b));
        if (yes) { yes.click(); await sleep(200); }
      }
      await sleep(250);
    }
    return saw ? "unknown" : "none";
  }

  async function tryRegister(lec) {
    if (cfg.dryRun) { log("[dryRun] 命中但不报名:", lec.name); return false; }
    // 已满冷却：最近失败过的先跳过，避免反复点
    const lastFail = failCooldown[lec.key];
    if (lastFail && Date.now() - lastFail < failCooldownMin * 60 * 1000) {
      log("⏳ 该讲座近期报名失败（已满），冷却中，本轮跳过:", lec.name);
      return false;
    }
    const cell = lec.cellsEl[lec.cellsEl.length - 1];
    const actionBtn = realButton(cell, "报名");
    if (!actionBtn) { log("行内无「报名」按钮: " + lec.name); return false; }
    actionBtn.click();
    log("已点击报名:", lec.name);
    const r = await waitForResult();
    if (r === "success") { log("✅ 报名成功:", lec.name); return true; }
    if (r === "fail") {
      log("❌ 报名失败（已满/无法报名），" + failCooldownMin + " 分钟内不再尝试:", lec.name);
      failCooldown[lec.key] = Date.now();
      closeMsgs();
      return false;
    }
    // unknown / none：只有当该行按钮已变成“已报名/取消”才认为成功
    if (rowChanged(lec)) { log("✅ 报名成功（按钮已变已报名）:", lec.name); return true; }
    log("⚠️ 报名未确认成功（按钮未变化，不计入）:", lec.name);
    closeMsgs();
    return false;
  }

  /* ---------------- Server酱 推送 ---------------- */
  async function push(title, desp) {
    try {
      const r = await chrome.runtime.sendMessage({ type: "PUSH", title, desp });
      log("微信推送:", r && r.ok ? "成功" : (r && (r.err || r.data) ? "失败" : "未配置"));
      return r;
    } catch (e) { log("推送异常:", String(e)); return { ok: false }; }
  }

  /* ---------------- 保险版：按 key 取消 ---------------- */
  async function tryCancelByKey(key) {
    if (!(await openModal())) return false;
    const row = parseRows().find(l => l.key === key);
    if (!row) { log("取消：未在报名表中找到该讲座（可能已不在可取消列表）", key); return false; }
    const cell = row.cellsEl[row.cellsEl.length - 1];
    const btn = $all("button, a, [role=button], [class*=btn]", cell).find(b => (b.innerText || "").trim().includes("取消"));
    if (!btn) return false;
    btn.click();
    await sleep(600);
    const dlg = $all("[class*='dialog' i], [class*='message-box' i], [class*='modal' i]").find(d => isVisible(d));
    if (dlg) {
      const yes = $all("button, a", dlg).find(b => /确认|确定|是/.test((b.innerText || "").trim()) && isVisible(b));
      if (yes) { yes.click(); await sleep(400); }
    }
    log("已执行取消报名:", key);
    return true;
  }

  /* ---------------- 保险检查 ---------------- */
  async function runInsurance() {
    if (!cfg.insurance.enabled) return;
    const pend = await getArr(KEY_PEND);
    const now = Date.now();
    let changed = false;
    for (const p of pend) {
      if (p.status !== "pending") continue;
      const st = parseStart(p.time);
      const startTs = st ? st.getTime() : (p.startTs || now + 86400e3);
      if (now >= startTs) continue; // 已开讲，不再自动取消
      const deadline = Math.min(
        (p.registeredAt || 0) + cfg.insurance.confirmWindowHours * 3600e3,
        startTs - cfg.insurance.autoCancelHoursBeforeStart * 3600e3
      );
      if (now >= deadline) {
        const ok = await tryCancelByKey(p.key);
        p.status = ok ? "cancelled" : "expired";
        changed = true;
        if (ok) push("⚠️已自动取消报名", `${p.title}\n${p.time}\n${p.location || ""}\n\n未在期限内确认参加，已自动取消，避免违约（15天禁报）。\n系统链接：https://webvpn.swufe.edu.cn/`);
        else push("⚠️请手动取消报名", `${p.title}\n${p.time}\n${p.location || ""}\n\n自动取消失败，请到系统「讲座报名」手动取消，避免违约。\n系统链接：https://webvpn.swufe.edu.cn/`);
      }
    }
    if (changed) await setArr(KEY_PEND, pend);
  }

  /* ---------------- 主循环：扫描+报名 ---------------- */
  async function runCycle() {
    await getCfg();
    if (!cfg.enabled) { log("未启用，跳过本轮扫描"); return; }
    if (!clickableByText("讲座报名")) {
      log("不在讲座列表页，跳过本轮（请保持 WebVPN 学术讲座列表页打开）");
      return;
    }
    // 记住列表页地址，后台闹钟发现标签离开时能自动导航回来
    try { await chrome.storage.local.set({ lastListUrl: location.href.split("#")[0] }); } catch (e) {}

    const opened = await openModal();
    if (!opened) log("报名弹窗未打开（可能暂无报名表格）");
    const rows = parseRows();
    log(`本轮扫描到 ${rows.length} 条讲座`);

    // 记录首次发现时间（供后续统计"公布是否有规律"）
    const seen = await getArr(KEY_LOG);
    const nowIso = new Date().toISOString();
    for (const r of rows) if (!seen.find(s => s.key === r.key)) seen.push({ key: r.key, name: r.name, firstSeenAt: nowIso });
    if (seen.length > 3000) seen.splice(0, seen.length - 3000);
    await setArr(KEY_LOG, seen);

    const registered = await getArr(KEY_REG);
    const pend = await getArr(KEY_PEND);
    let newReg = false;
    for (const lec of rows) {
      if (registered.includes(lec.key)) { log("跳过（已报过/需重置）:", lec.name); continue; }
      const why = whyNotMatch(lec);
      if (why) { log("跳过（" + why + "）:", lec.name); continue; }
      if (cfg.dryRun) { log("[dryRun] 命中但未报名:", lec.name); continue; }
      const ok = await tryRegister(lec);
      if (ok) {
        registered.push(lec.key);
        const st = parseStart(lec.time);
        pend.push({ key: lec.key, title: lec.name, time: lec.time, location: lec.location, registeredAt: Date.now(), startTs: st ? st.getTime() : null, status: "pending" });
        newReg = true;
        await push(
          `✅已报名：${lec.name}`,
          `时间：${lec.time}\n地点：${lec.location || "未知"}\n主办：${lec.host || "未知"}\n\n请确认能否参加：\n· 能参加 → 无需操作\n· 不能参加 → 打开下方链接到系统「讲座报名」取消，或在插件弹窗点“取消报名”\n\n系统链接：https://webvpn.swufe.edu.cn/\n\n若 ${cfg.insurance.confirmWindowHours} 小时内未确认，将在讲座开始前 ${cfg.insurance.autoCancelHoursBeforeStart} 小时自动取消，避免违约。`
        );
      }
    }
    if (newReg) { await setArr(KEY_REG, registered); await setArr(KEY_PEND, pend); }

    await runInsurance();

    // 后台闹钟每 intervalMin 分钟自动触发下一轮（标签被冻结也会唤醒），这里不再自刷新
    log(`本轮完成，等待后台自动扫描（每 ${cfg.intervalMin} 分钟）`);
  }

  /* ---------------- 消息监听 ---------------- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "CYCLE") { runCycle().then(() => sendResponse({ ok: true })); return true; }
    if (msg.type === "INSURANCE_CHECK") { runInsurance().then(() => sendResponse({ ok: true })); return true; }
    if (msg.type === "CANCEL") { tryCancelByKey(msg.key).then(ok => sendResponse({ ok })); return true; }
    if (msg.type === "GET_STATE") { sendResponse({ cfg, logs, url: location.href }); }
  });

  /* ---------------- 自动启动 ---------------- */
  (async () => {
    await getCfg();
    await sleep(3500); // 给 WebVPN 页面加载一点时间
    if (cfg.enabled && !window.__swufeStarted) {
      window.__swufeStarted = true;
      log("自动扫描启动");
      runCycle();
    }
  })();
})();
