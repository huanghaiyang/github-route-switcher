// ============================================================================
// background.js —— Service Worker（MV3, type: module）
//
// 干三件事：
//   1. 并发探测所有线路（网页能力 + git 能力分开测），按延迟排序；
//   2. 把"当前线路"编译成 declarativeNetRequest 动态规则，自动接管
//      raw / release / archive / gist 这些下载类请求；
//   3. 失败自动换线：定时重探 + 监听真实请求的网络错误，超阈值就切下一条。
//
// 为什么用动态规则而不是静态规则：线路是探测出来的，随时会变，
// 静态规则得重新打包插件，动态规则 updateDynamicRules 一次调用就能换。
// ============================================================================

import {
  BUILTIN_MIRRORS,
  DEFAULT_WEB_PROBE,
  DEFAULT_GIT_PROBE,
  buildUrl,
  buildGitProbeUrl,
  buildRules,
  pickBest,
} from "./lib.js";

const DEFAULTS = {
  enabled: true,
  autoSwitch: true,
  proxyWebPages: false,     // 连 github.com 网页/API 也接管（默认关，镜像返回的 HTML 相对路径会指向 github.com，容易把页面搞坏）
  preferDirect: true,       // 直连不慢太多就用直连：少一个第三方中转
  webProbe: DEFAULT_WEB_PROBE,
  gitProbe: DEFAULT_GIT_PROBE,
  timeoutMs: 8000,
  intervalMinutes: 5,
  failThreshold: 3,         // 连续失败几次就换线
  activeId: "",
  mirrors: BUILTIN_MIRRORS,
  results: [],
  lastProbeAt: 0,
  lastSwitch: null,
  ruleError: "",
  ruleCount: 0,
  log: [],
};

// ---------------------------------------------------------------- 配置读写
async function loadConfig() {
  const got = await chrome.storage.local.get(null);
  const cfg = { ...DEFAULTS, ...got };
  if (!Array.isArray(cfg.mirrors) || cfg.mirrors.length === 0) cfg.mirrors = BUILTIN_MIRRORS;
  return cfg;
}

async function saveConfig(patch) {
  await chrome.storage.local.set(patch);
}

async function logEvent(text) {
  const { log = [] } = await chrome.storage.local.get("log");
  log.unshift({ at: Date.now(), text });
  await saveConfig({ log: log.slice(0, 50) });
}

// ---------------------------------------------------------------- 单个请求探测
/** 用一次真实请求量延迟；读完整 body 是为了顺带确认"内容不是空的/不是错误页" */
async function timedFetch(url, timeoutMs) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
    });
    const body = await res.text();
    return {
      ok: res.ok && body.length > 0,
      ms: Math.round(performance.now() - t0),
      status: res.status,
      bytes: body.length,
    };
  } catch (e) {
    return {
      ok: false,
      ms: Math.round(performance.now() - t0),
      status: 0,
      error: String((e && e.name) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** git 能力探测：git smart-HTTP 握手，返回体里带 "git-upload-pack" 才算通 */
async function probeGit(mirror, cfg) {
  const r = await timedFetch(buildGitProbeUrl(mirror, cfg.gitProbe), cfg.timeoutMs);
  if (r.ok && r.bytes < 4096) {
    // 握手响应很小；内容必须像 git 的 advertisement
    r.ok = false;
    r.error = "content-not-git";
  }
  return r;
}

async function probeMirror(mirror, cfg) {
  const out = {
    id: mirror.id,
    name: mirror.name,
    template: mirror.template,
    webCapable: mirror.web !== false,
    gitCapable: mirror.git !== false,
    web: null,
    git: null,
  };
  const jobs = [];
  if (out.webCapable) jobs.push(timedFetch(buildUrl(mirror, cfg.webProbe), cfg.timeoutMs).then((r) => (out.web = r)));
  if (out.gitCapable) jobs.push(probeGit(mirror, cfg).then((r) => (out.git = r)));
  await Promise.all(jobs);
  if (out.web) out.msWeb = out.web.ok ? out.web.ms : null;
  if (out.git) out.msGit = out.git.ok ? out.git.ms : null;
  return out;
}

/** 并发探测全部线路（并发是关键：串行的话一条挂掉的线路要等满超时） */
async function probeAll(cfg, reason = "manual") {
  const started = Date.now();
  const results = await Promise.all(cfg.mirrors.map((m) => probeMirror(m, cfg)));
  await saveConfig({ results, lastProbeAt: Date.now() });
  const webOk = results.filter((r) => r.web && r.web.ok).length;
  const gitOk = results.filter((r) => r.git && r.git.ok).length;
  await logEvent(
    `探测完成（${reason}）：网页可用 ${webOk}/${results.filter((r) => r.webCapable).length}，` +
      `git 可用 ${gitOk}/${results.filter((r) => r.gitCapable).length}，耗时 ${Date.now() - started}ms`
  );
  return results;
}

// ---------------------------------------------------------------- DNR 规则接管
async function clearRules() {
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  if (old.length === 0) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map((r) => r.id),
    addRules: [],
  });
}

/** 把当前线路编译成动态规则。失败时退回"不接管"，绝不留下半套规则 */
async function applyRules(cfg) {
  const mirror = cfg.mirrors.find((m) => m.id === cfg.activeId) || null;
  let addRules = [];
  let ruleError = "";

  if (cfg.enabled && mirror) {
    try {
      addRules = buildRules(mirror, { proxyWebPages: cfg.proxyWebPages });
    } catch (e) {
      ruleError = `规则生成失败：${String(e)}`;
    }
  }

  try {
    const old = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: old.map((r) => r.id),
      addRules,
    });
  } catch (e) {
    ruleError = `规则下发失败：${String(e)}（已退回直连）`;
    await clearRules();
    addRules = [];
  }

  await saveConfig({ ruleError, ruleCount: addRules.length });
  return { ruleCount: addRules.length, ruleError };
}

// ---------------------------------------------------------------- 自动选线 / 换线
async function refreshAndApply(cfg, reason = "manual") {
  const results = await probeAll(cfg, reason);

  const bestWeb = pickBest(results, "web", { preferDirect: cfg.preferDirect });
  const current = results.find((r) => r.id === cfg.activeId);
  const currentUsable = current && current.web && current.web.ok;

  let activeId = cfg.activeId;
  if (!activeId || !currentUsable) {
    activeId = bestWeb ? bestWeb.id : "";
    if (activeId && activeId !== cfg.activeId) {
      await saveConfig({
        activeId,
        lastSwitch: { at: Date.now(), to: activeId, reason: currentUsable ? reason : `${reason}（原线路不可用）` },
      });
      await logEvent(`切换线路 -> ${bestWeb.name}（${bestWeb.web.ms}ms）`);
    }
  }

  const nextCfg = { ...cfg, activeId, results };
  const applied = await applyRules(nextCfg);
  return { ...nextCfg, ...applied };
}

/** 把当前线路换成另一条（换线要排除它自己） */
async function rotate(cfg, reason) {
  const best = pickBest(cfg.results, "web", { preferDirect: cfg.preferDirect, exclude: [cfg.activeId] });
  if (!best) {
    await logEvent(`需要换线（${reason}），但没有其他可用线路`);
    return cfg;
  }
  await saveConfig({ activeId: best.id, lastSwitch: { at: Date.now(), to: best.id, reason } });
  await logEvent(`自动换线 -> ${best.name}（${reason}）`);
  const next = { ...cfg, activeId: best.id };
  await applyRules(next);
  return next;
}

// 失败计数：只在"当前线路的真实请求出错"时累加
let failCount = 0;

function hostOf(template) {
  const m = /^https?:\/\/([^/]+)/.exec(template || "");
  return m ? m[1] : "";
}

async function onRequestError(details) {
  const cfg = await loadConfig();
  if (!cfg.enabled || !cfg.autoSwitch || !cfg.activeId) return;
  const mirror = cfg.mirrors.find((m) => m.id === cfg.activeId);
  if (!mirror) return;

  const host = hostOf(mirror.template);
  let urlHost = "";
  try {
    urlHost = new URL(details.url).host;
  } catch {
    return;
  }
  if (!host || urlHost !== host) return;

  failCount += 1;
  await logEvent(`请求失败（${details.error || "unknown"}）：${details.url.slice(0, 120)} [${failCount}/${cfg.failThreshold}]`);
  if (failCount >= cfg.failThreshold) {
    failCount = 0;
    await rotate(cfg, `${cfg.failThreshold} 次请求失败`);
  }
}

// ---------------------------------------------------------------- 事件接线
chrome.runtime.onInstalled.addListener(() => {
  init("安装/更新");
});
chrome.runtime.onStartup.addListener(() => {
  init("浏览器启动");
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "probe") return;
  const cfg = await loadConfig();
  if (!cfg.enabled) return;
  await refreshAndApply(cfg, "定时重探");
});

// MV3 里 webRequest 只能"观察"不能拦截，用来做失败统计正好
chrome.webRequest.onErrorOccurred.addListener(onRequestError, { urls: ["<all_urls>"] });

async function init(reason) {
  const cfg = await loadConfig();
  chrome.alarms.create("probe", { periodInMinutes: Math.max(1, cfg.intervalMinutes) });
  await refreshAndApply(cfg, reason);
}

// ---------------------------------------------------------------- 与弹窗通信
const handlers = {
  async state() {
    return loadConfig();
  },
  async probe() {
    const cfg = await loadConfig();
    return refreshAndApply(cfg, "手动探测");
  },
  async set(patch) {
    await saveConfig(patch);
    let cfg = await loadConfig();
    // 线路表/开关变了要重算规则；开了接管还要立刻探一轮
    if ("activeId" in patch || "enabled" in patch || "proxyWebPages" in patch) {
      await applyRules(cfg);
    }
    if ("enabled" in patch && patch.enabled) {
      cfg = await refreshAndApply(cfg, "启用后重探");
    }
    if ("mirrors" in patch) {
      chrome.alarms.create("probe", { periodInMinutes: Math.max(1, cfg.intervalMinutes) });
      cfg = await refreshAndApply(cfg, "线路表变更");
    }
    if ("intervalMinutes" in patch) {
      chrome.alarms.create("probe", { periodInMinutes: Math.max(1, cfg.intervalMinutes) });
    }
    return cfg;
  },
  async switchTo(payload) {
    // 弹窗传的是 {id}，也兼容直接传字符串
    const id = typeof payload === "string" ? payload : payload && payload.id;
    if (!id) return loadConfig();
    const cfg = await loadConfig();
    await saveConfig({ activeId: id, lastSwitch: { at: Date.now(), to: id, reason: "手动选择" } });
    await logEvent(`手动切换 -> ${id}`);
    const next = { ...cfg, activeId: id };
    await applyRules(next);
    return loadConfig();
  },
  async resetLog() {
    await saveConfig({ log: [] });
    return loadConfig();
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) {
    sendResponse({ error: `unknown message: ${msg && msg.type}` });
    return false;
  }
  Promise.resolve(fn(msg.payload ?? msg))
    .then((data) => sendResponse({ data }))
    .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;   // 异步回复
});
