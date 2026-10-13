// ============================================================================
// selftest.mjs —— 纯逻辑单测（node selftest.mjs）
//
// 复刻 DNR 的替换语义来验证生成的正则"真的能匹配、替换出来的地址真的对"：
//   DNR:  \0 = 整个匹配, \1..\9 = 捕获组
//   JS :  $&  = 整个匹配, $1..$9  = 捕获组
// 只测纯函数，不需要 chrome.*，也不需要浏览器。
// ============================================================================

import {
  BUILTIN_MIRRORS,
  buildUrl,
  buildGitProbeUrl,
  buildRules,
  gitInsteadOf,
  gitInsteadOfRemove,
  pickBest,
  isDirect,
} from "./lib.js";

let pass = 0;
let fail = 0;

function ok(cond, label, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ""}`);
  }
}

function eq(got, want, label) {
  ok(got === want, label, `got : ${got}\n      want: ${want}`);
}

const byId = (id) => BUILTIN_MIRRORS.find((m) => m.id === id);

/** DNR 替换串 -> JS 替换串 */
function toJsReplacement(sub) {
  let out = "";
  for (let i = 0; i < sub.length; i++) {
    const ch = sub[i];
    const next = sub[i + 1] || "";
    if (ch === "\\" && /[0-9]/.test(next)) {
      out += next === "0" ? "$&" : "$" + next;
      i++;
    } else {
      out += ch === "$" ? "$$" : ch;
    }
  }
  return out;
}

/** 按 DNR 语义跑一次重定向 */
function redirect(rule, url) {
  const re = new RegExp(rule.condition.regexFilter);
  if (!re.test(url)) return null;
  return url.replace(re, toJsReplacement(rule.action.redirect.regexSubstitution));
}

const RAW = "https://raw.githubusercontent.com/ZeroPowerZero/spells-design/main/.gitignore";
const RAW_HOSTPATH = "raw.githubusercontent.com/ZeroPowerZero/spells-design/main/.gitignore";
const REL = "https://github.com/godotengine/godot/releases/download/4.5/x.zip";
const ARCHIVE = "https://codeload.github.com/godotengine/godot/tar.gz/refs/heads/master";
const PAGE = "https://github.com/godotengine/godot";
const API = "https://api.github.com/repos/godotengine/godot";

console.log("=== 1. buildUrl：三种线路形态 ===");
eq(buildUrl(byId("direct"), RAW), RAW, "直连：原样返回");
eq(buildUrl(byId("ghproxy.net"), RAW), `https://ghproxy.net/${RAW}`, "{url} 前缀式：拼完整地址");
eq(buildUrl(byId("gitclone"), RAW), `https://gitclone.com/${RAW_HOSTPATH}`, "{urlNoScheme} 前缀式：去掉协议头再拼");
eq(
  buildUrl(byId("gitclone"), "https://github.com/a/b"),
  "https://gitclone.com/github.com/a/b",
  "{urlNoScheme} 不会被 {url} 规则误伤（替换顺序）"
);
ok(isDirect(byId("direct")), "isDirect 识别直连线路");
ok(!isDirect(byId("ghproxy.net")), "isDirect 不误判镜像线路");

console.log("=== 2. buildGitProbeUrl：git smart-HTTP 握手 ===");
eq(
  buildGitProbeUrl(byId("ghproxy.net")),
  "https://ghproxy.net/https://github.com/ZeroPowerZero/spells-design.git/info/refs?service=git-upload-pack",
  "{url} 线路的握手地址"
);
eq(
  buildGitProbeUrl(byId("gitclone")),
  "https://gitclone.com/github.com/ZeroPowerZero/spells-design.git/info/refs?service=git-upload-pack",
  "{urlNoScheme} 线路的握手地址"
);

console.log("=== 3. buildRules：条数 / id / 正则 ===");
eq(buildRules(byId("direct")).length, 0, "直连线路不生成任何规则（=不接管）");
const rulesDefault = buildRules(byId("ghproxy.net"));
eq(rulesDefault.length, 5, "默认接管 5 类 URL（raw/release/archive/gist/github下载路径）");
eq(buildRules(byId("ghproxy.net"), { proxyWebPages: true }).length, 7, "开网页接管后变 7 条");
eq(new Set(rulesDefault.map((r) => r.id)).size, rulesDefault.length, "规则 id 互不重复");
ok(rulesDefault.every((r) => Number.isInteger(r.id) && r.id > 0), "规则 id 都是正整数（DNR 要求）");
ok(rulesDefault.every((r) => r.action.type === "redirect"), "动作为 redirect");

console.log("=== 4. 用真实 URL 跑一遍重定向（{url} 前缀式）===");
const ghRules = rulesDefault;
eq(redirect(ghRules[0], RAW), `https://ghproxy.net/${RAW}`, "raw 原始文件被正确前缀");
eq(redirect(ghRules[3], "https://gist.githubusercontent.com/u/1/raw/x.txt"), "https://ghproxy.net/https://gist.githubusercontent.com/u/1/raw/x.txt", "gist 原始文件");
eq(
  ghRules.map((r) => redirect(r, REL)).find(Boolean),
  `https://ghproxy.net/${REL}`,
  "release 下载链接被接管"
);
eq(
  ghRules.map((r) => redirect(r, ARCHIVE)).find(Boolean),
  `https://ghproxy.net/${ARCHIVE}`,
  "codeload 归档被接管"
);
eq(
  ghRules.map((r) => redirect(r, "https://objects.githubusercontent.com/github-production-release-asset/x")).find(Boolean),
  "https://ghproxy.net/https://objects.githubusercontent.com/github-production-release-asset/x",
  "objects 资源被接管"
);

console.log("=== 5. 不该接管的必须放过（否则会把网页搞坏）===");
ok(ghRules.every((r) => redirect(r, PAGE) === null), "github.com 仓库主页：不接管");
ok(ghRules.every((r) => redirect(r, API) === null), "GitHub API：不接管");
ok(ghRules.every((r) => redirect(r, "https://example.com/a") === null), "无关站点：不接管");
const webRules = buildRules(byId("ghproxy.net"), { proxyWebPages: true });
ok(webRules.some((r) => redirect(r, PAGE) !== null), "开了网页接管后，github.com 主页才被接管");
ok(webRules.some((r) => redirect(r, API) !== null), "开了网页接管后，API 才被接管");

console.log("=== 6. {urlNoScheme} 线路的重定向 ===");
const gcRules = buildRules(byId("gitclone"));
eq(gcRules.length, 5, "gitclone 也生成 5 条");
eq(redirect(gcRules[0], RAW), `https://gitclone.com/${RAW_HOSTPATH}`, "raw 走 gitclone：去掉协议头");
ok(gcRules.every((r) => r.condition.regexFilter.includes("(")), "该形态的正则必须带捕获组（替换用 \\1）");
ok(gcRules.every((r) => r.action.redirect.regexSubstitution.includes("\\1")), "替换串使用 \\1");

console.log("=== 7. gitInsteadOf：终端用的配置 ===");
eq(
  gitInsteadOf(byId("ghproxy.net")),
  'git config --global url."https://ghproxy.net/https://github.com/".insteadOf "https://github.com/"',
  "{url} 线路的 insteadOf"
);
eq(
  gitInsteadOf(byId("gitclone")),
  'git config --global url."https://gitclone.com/github.com/".insteadOf "https://github.com/"',
  "{urlNoScheme} 线路的 insteadOf"
);
eq(gitInsteadOf(byId("direct")), "", "直连线路不需要 insteadOf");
ok(gitInsteadOfRemove().startsWith("git config --global --remove-section"), "撤销命令可用");

console.log("=== 8. pickBest：选线策略 ===");
const mk = (id, msWeb, msGit, web = true, git = true) => ({
  id,
  name: id,
  webCapable: web,
  gitCapable: git,
  web: msWeb === null ? { ok: false, ms: 9999 } : { ok: true, ms: msWeb },
  git: msGit === null ? { ok: false, ms: 9999 } : { ok: true, ms: msGit },
});

const results = [
  mk("direct", 900, 950),
  mk("ghproxy.net", 300, 320),
  mk("ghfast.top", null, null),
  mk("gitclone", null, 280, false, true),
];
eq(pickBest(results, "web").id, "ghproxy.net", "网页选最快的（ghfast 挂了、gitclone 不支持网页）");
eq(pickBest(results, "web", { preferDirect: false }).id, "ghproxy.net", "关掉直连偏好：仍选最快镜像");
eq(pickBest(results, "git").id, "gitclone", "git 选最快的（gitclone 280ms 最快）");
eq(pickBest(results, "web", { preferDirect: true, directBiasMs: 1000 }).id, "direct", "直连在偏置范围内时优先直连");
eq(pickBest(results, "web", { exclude: ["ghproxy.net"] }).id, "direct", "排除最快镜像后回退到直连");
eq(
  pickBest([mk("direct", 900, 900), mk("ghproxy.net", 300, 300)], "web", { exclude: ["ghproxy.net", "direct"] }),
  null,
  "把所有可用线路都排除后才返回 null"
);
eq(pickBest([mk("direct", null, null), mk("ghproxy.net", null, null)], "web"), null, "全挂时返回 null");

console.log("=== 9. 内置线路表自身合法 ===");
ok(BUILTIN_MIRRORS.length >= 8, `内置线路数量合理（${BUILTIN_MIRRORS.length} 条）`);
ok(new Set(BUILTIN_MIRRORS.map((m) => m.id)).size === BUILTIN_MIRRORS.length, "线路 id 不重复");
ok(
  BUILTIN_MIRRORS.every((m) => m.template.includes("{url}") || m.template.includes("{urlNoScheme}")),
  "每条线路都带占位符"
);
// 注意：直连按设计"不生成规则/不需要 insteadOf"，所以这里只查镜像类线路
const webMirrors = BUILTIN_MIRRORS.filter((m) => m.web !== false && !isDirect(m));
ok(
  webMirrors.every((m) => buildRules(m).length === 5),
  `所有镜像类线路都能生成 5 条规则（${webMirrors.length} 条）`
);
const gitMirrors = BUILTIN_MIRRORS.filter((m) => m.git !== false && !isDirect(m));
ok(
  gitMirrors.every((m) => gitInsteadOf(m).startsWith("git config")),
  `所有镜像类线路都能生成 insteadOf（${gitMirrors.length} 条）`
);
ok(isDirect(BUILTIN_MIRRORS.find((m) => m.id === "direct")), "线路表里保留了直连对照组");

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
