// ============================================================================
// popup.js —— 弹窗界面逻辑（module，可直接 import lib.js 复用纯函数）
// ============================================================================

import {
  BUILTIN_MIRRORS,
  gitInsteadOf,
  gitInsteadOfRemove,
  isDirect,
  pickBest,
} from "./lib.js";

const $ = (id) => document.getElementById(id);

async function send(type, payload) {
  const res = await chrome.runtime.sendMessage({ type, payload });
  if (res && res.error) throw new Error(res.error);
  return res ? res.data : null;
}

const fmtMs = (ms) => (ms == null ? "—" : `${Math.round(ms)}ms`);
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString("zh-CN", { hour12: false }) : "—");

/** 线路表 <-> 文本框 */
function mirrorsToText(mirrors) {
  return mirrors
    .map((m) => `${m.name}|${m.template}|${m.web === false ? 0 : 1}|${m.git === false ? 0 : 1}`)
    .join("\n");
}

function textToMirrors(text) {
  const out = [];
  const used = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [name, template, web, git] = line.split("|").map((s) => (s ?? "").trim());
    if (!template) continue;

    let id = template === "{url}" ? "direct" : (name || template).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    while (used.has(id)) id += "-";
    used.add(id);

    out.push({
      id,
      name: name || template,
      template,
      web: web !== "0" && web !== "false",
      git: git !== "0" && git !== "false",
    });
  }
  return out;
}

function cellClass(r) {
  if (!r) return "bad";
  return r.ok ? "ok" : "bad";
}

function cellText(r) {
  if (!r) return "—";
  if (r.ok) return `${r.ms}ms`;
  return r.error === "content-not-git" ? "非git" : r.status ? `HTTP ${r.status}` : (r.error || "失败");
}

// ---------------------------------------------------------------- 渲染
async function render() {
  const cfg = await send("state");
  if (!cfg) return;

  $("enabled").checked = !!cfg.enabled;
  $("autoSwitch").checked = !!cfg.autoSwitch;
  $("preferDirect").checked = !!cfg.preferDirect;
  $("proxyWebPages").checked = !!cfg.proxyWebPages;
  $("timeoutMs").value = cfg.timeoutMs;
  $("intervalMinutes").value = cfg.intervalMinutes;
  $("failThreshold").value = cfg.failThreshold;
  $("webProbe").value = cfg.webProbe;
  $("gitProbe").value = cfg.gitProbe;
  $("mirrors").value = mirrorsToText(cfg.mirrors || BUILTIN_MIRRORS);

  const active = (cfg.mirrors || []).find((m) => m.id === cfg.activeId) || null;
  const activeResult = (cfg.results || []).find((r) => r.id === cfg.activeId) || null;

  $("activeName").textContent = cfg.enabled ? (active ? active.name : "未选出（全部不可用）") : "已停用";
  $("activeMs").textContent = activeResult && activeResult.web ? fmtMs(activeResult.web.ms) : "—";
  $("ruleCount").textContent = `${cfg.ruleCount || 0} 条${cfg.proxyWebPages ? "（含网页）" : ""}`;
  $("lastProbe").textContent = fmtTime(cfg.lastProbeAt);
  $("ruleError").textContent = cfg.ruleError || "";

  // 线路表
  const rows = $("rows");
  rows.textContent = "";
  for (const r of cfg.results || []) {
    const row = document.createElement("div");
    row.className = "row";

    const name = document.createElement("div");
    name.className = "name" + (r.id === cfg.activeId ? " is-active" : "");
    name.textContent = r.name;
    name.title = r.template;

    const web = document.createElement("div");
    web.className = "ms " + cellClass(r.web);
    web.textContent = r.webCapable === false ? "—" : cellText(r.web);

    const git = document.createElement("div");
    git.className = "ms " + cellClass(r.git);
    git.textContent = r.gitCapable === false ? "—" : cellText(r.git);

    const btn = document.createElement("button");
    btn.textContent = r.id === cfg.activeId ? "已用" : "选用";
    btn.disabled = r.id === cfg.activeId || !r.web || !r.web.ok;
    btn.onclick = async () => {
      await send("switchTo", { id: r.id });
      render();
    };

    row.append(name, web, git, btn);
    rows.append(row);
  }

  // git 建议
  const gitBest = pickBest(cfg.results || [], "git", { preferDirect: cfg.preferDirect });
  $("gitBest").textContent = gitBest ? `${gitBest.name}（${fmtMs(gitBest.git.ms)}）` : "没有可用线路";
  const gitMirror = gitBest ? (cfg.mirrors || []).find((m) => m.id === gitBest.id) : null;
  $("gitCmd").textContent = gitMirror ? gitInsteadOf(gitMirror) : "—";
  $("gitCmd").dataset.cmd = gitMirror ? gitInsteadOf(gitMirror) : "";
  $("copyRemove").dataset.cmd = gitInsteadOfRemove();

  // 日志
  const log = $("log");
  log.textContent = "";
  for (const e of cfg.log || []) {
    const d = document.createElement("div");
    d.textContent = `${fmtTime(e.at)}  ${e.text}`;
    log.append(d);
  }
}

// ---------------------------------------------------------------- 事件
$("enabled").onchange = async (e) => {
  await send("set", { enabled: e.target.checked });
  render();
};

$("probe").onclick = async () => {
  const btn = $("probe");
  btn.disabled = true;
  btn.textContent = "探测中…";
  try {
    await send("probe");
  } finally {
    btn.disabled = false;
    btn.textContent = "重新探测";
    render();
  }
};

$("saveAdv").onclick = async () => {
  const mirrors = textToMirrors($("mirrors").value);
  await send("set", {
    autoSwitch: $("autoSwitch").checked,
    preferDirect: $("preferDirect").checked,
    proxyWebPages: $("proxyWebPages").checked,
    timeoutMs: Math.max(1000, Number($("timeoutMs").value) || 8000),
    intervalMinutes: Math.max(1, Number($("intervalMinutes").value) || 5),
    failThreshold: Math.max(1, Number($("failThreshold").value) || 3),
    webProbe: $("webProbe").value.trim(),
    gitProbe: $("gitProbe").value.trim(),
    ...(mirrors.length ? { mirrors, activeId: "" } : {}),
  });
  render();
};

$("restoreBuiltin").onclick = async () => {
  await send("set", { mirrors: BUILTIN_MIRRORS, activeId: "" });
  render();
};

$("resetLog").onclick = async () => {
  await send("resetLog", {});
  render();
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;   // 复制失败不提示：命令本身在界面上可见可手选
  }
}

$("copyGit").onclick = async () => {
  await copyText($("gitCmd").dataset.cmd || "");
  const b = $("copyGit");
  b.textContent = "已复制";
  setTimeout(() => (b.textContent = "复制 git 配置"), 1200);
};

$("copyRemove").onclick = async () => {
  await copyText($("copyRemove").dataset.cmd || "");
  const b = $("copyRemove");
  b.textContent = "已复制";
  setTimeout(() => (b.textContent = "复制撤销命令"), 1200);
};

render();
