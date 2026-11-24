/* =====================================================
   SWUFE 讲座自动报名 — 内容脚本 (Content Script)
   运行于 WebVPN 学术讲座列表页

   工作流（每轮）：
   1) 识别当前页面；若会话失效/不在讲座页，按内置路径自动恢复
   2) 点击页面上的「讲座报名」按钮 → 弹出报名表格弹窗
   3) 解析表格每一行（讲座名称/主办单位/讲座形式/时间/地点/类别/操作）
   4) 用你设置的规则过滤，命中且未报过的 → 点「报名」→ 处理确认弹窗
   5) 报名成功 → 记录到已报名清单 → Server酱 推送到微信
   6) 整页刷新或定时，进入下一轮

   说明：页面元素基于"文字"匹配。
   ===================================================== */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: false,               // 总开关
    intervalMin: 2,               // 刷新/扫描间隔（分钟）
    campus: "",                   // 校区过滤："柳林" / "光华" / 空=不限
    lectureForm: "线下",          // 讲座形式："线下"/"线上"/空=不限
    categoryKeywords: [],         // 讲座类别关键词白名单，空=不限
    hostKeywords: [],             // 主办单位关键词白名单，空=不限
    titleKeywords: [],            // 讲座名称关键词白名单，空=不限
    serverChanKey: "",           // Server酱(方糖) SendKey，选填
    dryRun: false,                // true=只扫描不真正报名（调试用）
    refreshMode: "reload",        // "reload"整页刷新 / "reopen"只重开弹窗不刷新
    remindTime: "23:00",          // 每日提醒时间，汇总次日要参加的讲座推送
    // 校区 → 所属教学楼别名（地点有时只写楼名不写校区）
    campusBuildings: {
      "柳林": ["颐德楼", "经世楼", "格致楼", "弘远楼", "通博楼"],
      "光华": ["明德楼"]
    },
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
    }
  };

  const STORAGE_CFG = "cfg";
  const KEY_BOOK = "booked";     // 已报名清单

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
  const norm = s => String(s || "").replace(/\s+/g, "").trim();
  function clickableByText(text) {
    const t = norm(text);
    return $all('button, a, [role="button"], [class*="btn"], [class*="button"], [class*="link"]')
      .find(el => norm(el.innerText).includes(t));
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

  /* ---------------- 页面状态识别 ---------------- */
  function isLoginPage() {
    if (/authserver\/login|\/login(\?|$)/.test(location.href)) return true;
    if ($all('input[type="password"]').length || $all('#password').length) return true;
    const body = document.body ? (document.body.innerText || "") : "";
    return body.includes("账号登录") && (body.includes("验证码登录") || body.includes("扫码登录")) && $all("input").length > 0;
  }
  function passwordInput() {
    return $all('input[type="password"]')[0] || $all('#password')[0] || null;
  }
  function loginButton() {
    const byId = $all('#login_submit').filter(isVisible);
    if (byId[0]) return byId[0];
    const pool = $all('button, a, [role="button"], [class*="btn" i], [class*="button" i], [class*="login" i], div, span');
    return pool.filter(isVisible).find(el => norm(el.innerText) === "登录") || null;
  }
  function isLectureList() {
    const b = clickableByText("讲座报名");
    return !!(b && isVisible(b));
  }

  // 会话失效提示关键词
  const EXPIRE_WORDS = ["登录超时", "会话过期", "会话失效", "登录已失效", "已过期", "重新登录", "请重新登录", "身份失效", "登录状态失效", "超时未操作", "长时间未操作", "静默"];
  function colorIsRed(c) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || "");
    if (!m) return false;
    const r = +m[1], g = +m[2], b = +m[3];
    return r > 150 && g < 110 && b < 110;
  }
  // 弹窗/提示里的红色失效文案 → 判定会话已失效，需要刷新重登
  function expiredAlertPresent() {
    const sel = "[class*='message' i],[class*='toast' i],[class*='dialog' i],[class*='alert' i],[class*='notice' i],[class*='modal' i]";
    return $all(sel).filter(isVisible).some(el => {
      const t = (el.innerText || "").trim();
      if (!t || !EXPIRE_WORDS.some(w => t.includes(w))) return false;
      const red = colorIsRed(getComputedStyle(el).color) ||
        $all("*", el).some(c => colorIsRed(getComputedStyle(c).color) && (c.innerText || "").trim());
      return red || /超时|失效|过期|重新登录/.test(t);
    });
  }

  // 应用中心：找到“学术讲座”卡片，悬停露出绿色「查看」后点击（兜底路径）
  async function openLectureFromAppCenter() {
    const cards = $all('div,li,a,span')
      .filter(el => isVisible(el) && norm(el.innerText) === "学术讲座");
    const card = cards[cards.length - 1];
    if (!card) { log("应用中心未找到「学术讲座」卡片"); return false; }
    for (const t of ["mouseenter", "mouseover"]) {
      card.dispatchEvent(new MouseEvent(t, { bubbles: true }));
    }
    await sleep(350);
    const scope = card.parentElement || card;
    const view = $all('button,a,[role="button"],[class*="btn"]', scope)
      .find(b => /查看/.test(norm(b.innerText)) && isVisible(b));
    if (view) view.click(); else card.click();
    return true;
  }

  // 会话失效 / 不在讲座页时自动恢复：
  // 失效弹窗 → 刷新重登；登录后通常直接回到讲座页；应用中心路径仅作兜底
  async function recoverIfNeeded() {
    // 1) 单处登录提示：踢出以上会话并继续登录（个别情况才出现）
    for (let i = 0; i < 3; i++) {
      const kick = clickableByText("踢出以上会话并继续登录");
      if (kick && isVisible(kick)) { kick.click(); await sleep(1500); } else break;
    }
    // 2) 会话失效红色弹窗 → 刷新页面，WebVPN 会回到登录页
    if (expiredAlertPresent()) {
      log("检测到会话失效提示，刷新页面重新登录");
      location.reload();
      return false;
    }
    // 3) 登录页：密码已由用户/浏览器填好才代为点击；登录后通常直接回到讲座页
    if (isLoginPage()) {
      const pwd = passwordInput();
      if (!pwd || !pwd.value) {
        log("会话已失效：登录需手动完成（插件不保存密码），登录后回到学术讲座页");
        return false;
      }
      let btn = loginButton();
      if (!btn) { log("未找到「登录」按钮，请手动点击登录"); return false; }
      btn.click();
      await sleep(2200);
      if (isLoginPage()) { btn = loginButton(); if (btn) { btn.click(); await sleep(2200); } }
      if (isLoginPage()) { log("登录页未能继续，请手动完成登录"); return false; }
    }
    // 4) 兜底：登录后若仍停留在门户/应用中心，再走 应用中心 → 科研·学术讲座·查看
    if (!isLectureList()) {
      const ac = clickableByText("应用中心");
      if (ac && isVisible(ac)) { ac.click(); await sleep(1200); }
      await openLectureFromAppCenter();
      await sleep(1200);
    }
    return isLectureList();
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
    const headerRow = $all("tr", tbl).find(tr => (tr.innerText || "").includes("讲座名称"));
    const headers = headerRow ? $all("th,td", headerRow).map(c => (c.innerText || "").trim()) : [];
    const colOf = name => { const i = headers.indexOf(name); return i >= 0 ? i : headers.findIndex(h => h.includes(name)); };
    const rows = [];
    for (const tr of $all("tr", tbl)) {
      if ((tr.innerText || "").includes("讲座名称")) continue; // 跳过表头
      const hasRegBtn = $all("button, a, [role=button], [class*=btn]", tr)
        .some(b => norm(b.innerText) === "报名");
      if (!hasRegBtn) continue;
      const tds = $all("td", tr);
      const cells = tds.map(c => norm(c.innerText));
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
  function lectureRange(lec) {
    const st = parseStart(lec.time);
    if (!st) return null;
    const ls = st.getHours() * 60 + st.getMinutes();
    const em = String(lec.time || "").match(/-\s*(?:\d{4}-\d{2}-\d{2}[ ])?(\d{1,2}):(\d{2})/);
    const le = em ? (+em[1] * 60 + +em[2]) : ls + 60;
    return { start: ls, end: le, weekday: String(st.getDay() === 0 ? 7 : st.getDay()) };
  }
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
      if (ps != null && pe != null && rng.start < pe && rng.end > ps) return true;
    }
    return false;
  }
  // 地点命中：含校区名，或含该校区的教学楼别名（如只写"经世楼"也算柳林）
  function campusMatched(lec) {
    if (!cfg.campus) return true;
    const loc = lec.location || "";
    if (loc.includes(cfg.campus)) return true;
    const buildings = (cfg.campusBuildings || {})[cfg.campus] || [];
    return buildings.some(b => loc.includes(b));
  }
  function whyNotMatch(lec) {
    if (!campusMatched(lec)) return "校区不符";
    if (cfg.lectureForm && !(lec.form || "").includes(cfg.lectureForm)) return "讲座形式不符";
    if (cfg.categoryKeywords.length && !cfg.categoryKeywords.some(k => (lec.category || "").includes(k))) return "类别不符";
    if (cfg.hostKeywords.length && !cfg.hostKeywords.some(k => (lec.host || "").includes(k))) return "主办不符";
    if (cfg.titleKeywords.length && !cfg.titleKeywords.some(k => (lec.name || "").includes(k))) return "名称关键词不符";
    if (isScheduleConflict(lec)) return "与课表冲突";
    return null;
  }
  function matches(lec) { return whyNotMatch(lec) === null; }

  /* ---------------- 报名 ---------------- */
  const failCooldownMin = 10;
  const failCooldown = {}; // key -> 上次失败时间戳

  function visibleMsgs() {
    const sel = "[class*='message' i], [class*='toast' i], [class*='dialog' i], [class*='alert' i], [class*='popup' i], [class*='notice' i]";
    return $all(sel).filter(el => isVisible(el));
  }
  function msgText() {
    return visibleMsgs().map(el => norm(el.innerText)).filter(Boolean).join(" | ");
  }
  function closeMsgs() {
    for (const d of visibleMsgs()) {
      const yes = $all("button, a, [role=button], [class*=btn]", d).find(b => /确定|关闭|知道了|确认/.test(norm(b.innerText)) && isVisible(b));
      if (yes) { yes.click(); return; }
    }
  }
  const FAIL_WORDS = ["已满", "无法报名", "报名失败", "失败", "已报满", "人数已满", "名额已满", "没有名额", "名额不足", "已达上限", "已达", "不可报名", "不能报名", "无效", "错误", "已停止", "满了"];
  const SUCCESS_WORDS = ["报名成功", "预约成功", "报名完成", "报名已", "成功"];
  function realButton(cell, text) {
    const candidates = $all("button, a, [role=button], [class*=btn], [onclick]", cell)
      .filter(el => { const t = norm(el.innerText); return t === norm(text) || t.includes(norm(text)); });
    return candidates.find(el => el.tagName === "BUTTON") || candidates[0] || null;
  }
  function rowChanged(lec) {
    const cell = lec.cellsEl && lec.cellsEl[lec.cellsEl.length - 1];
    const t = cell ? (cell.innerText || "") : "";
    return t.includes("已报名") || t.includes("取消");
  }
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
      const dlg = visibleMsgs().find(d => /确认|确定|是否/.test(d.innerText || "") && /报名/.test(d.innerText || ""));
      if (dlg) {
        const yes = $all("button, a, [role=button], [class*=btn]", dlg).find(b => /确认|确定/.test(norm(b.innerText)) && isVisible(b));
        if (yes) { yes.click(); await sleep(200); }
      }
      await sleep(250);
    }
    return saw ? "unknown" : "none";
  }

  async function tryRegister(lec) {
    if (cfg.dryRun) { log("[dryRun] 命中但不报名:", lec.name); return false; }
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

  /* ---------------- 主循环：扫描+报名 ---------------- */
  async function runCycle() {
    await getCfg();
    if (!cfg.enabled) { log("未启用，跳过本轮扫描"); return; }

    const recovered = await recoverIfNeeded();
    if (!recovered) { log("未进入学术讲座列表页，跳过本轮"); return; }
    try { await chrome.storage.local.set({ lastListUrl: location.href.split("#")[0] }); } catch (e) {}

    const opened = await openModal();
    if (!opened) log("报名弹窗未打开（可能暂无报名表格）");
    const rows = parseRows();
    log(`本轮扫描到 ${rows.length} 条讲座`);

    const booked = await getArr(KEY_BOOK);
    let newReg = false;
    for (const lec of rows) {
      if (booked.some(b => b.key === lec.key)) { log("跳过（已报过）:", lec.name); continue; }
      const why = whyNotMatch(lec);
      if (why) { log("跳过（" + why + "）:", lec.name); continue; }
      if (cfg.dryRun) { log("[dryRun] 命中但未报名:", lec.name); continue; }
      const ok = await tryRegister(lec);
      if (ok) {
        const st = parseStart(lec.time);
        booked.push({
          key: lec.key, title: lec.name, time: lec.time, location: lec.location, host: lec.host,
          startTs: st ? st.getTime() : null, bookedAt: Date.now()
        });
        newReg = true;
        await push(
          `✅已报名：${lec.name}`,
          `时间：${lec.time}\n地点：${lec.location || "未知"}\n主办：${lec.host || "未知"}\n\n次日讲座将在 ${cfg.remindTime || "23:00"} 通过微信提醒。\n系统链接：https://webvpn.swufe.edu.cn/`
        );
      }
    }
    if (newReg) await setArr(KEY_BOOK, booked);

    log(`本轮完成，等待后台自动扫描（每 ${cfg.intervalMin} 分钟）`);
  }

  /* ---------------- 消息监听 ---------------- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "CYCLE") { runCycle().then(() => sendResponse({ ok: true, stale: expiredAlertPresent(), login: isLoginPage() })); return true; }
    if (msg.type === "GET_STATE") { sendResponse({ cfg, logs, url: location.href, stale: expiredAlertPresent(), login: isLoginPage() }); }
  });

  /* ---------------- 自动启动 ---------------- */
  (async () => {
    await getCfg();
    await sleep(3500);
    const pageKind = isLoginPage() ? "登录页" : isLectureList() ? "讲座列表页" : "其他页面";
    log("内容脚本已加载：" + pageKind);
    if (cfg.enabled && !window.__swufeStarted) {
      window.__swufeStarted = true;
      log("自动扫描启动");
      runCycle();
    }
  })();
})();
