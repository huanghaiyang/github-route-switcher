// ============================================================================
// lib.js —— 纯逻辑层（不引用任何 chrome.* API，方便用 node 直接单测）
//
// 设计要点：
//   · 线路分两类形态：
//       {url}         前缀式，把完整原地址拼在后面（如 https://ghproxy.net/https://github.com/...）
//       {urlNoScheme} 前缀式，拼的是去掉协议头的地址（如 https://gitclone.com/github.com/...）
//       直连           template === "{url}" 表示不改写（当作"对照组"线路）
//   · 线路分两种能力：
//       web  能否代理浏览器里的 raw / release / archive 下载
//       git  能否用于终端 git clone（用 git 的 smart-HTTP 握手地址探测）
//     两者不通用（例如 gitclone.com 只能用于 git），所以分开探测、分开选。
//   · 只接管"下载/原始文件"类请求；github.com 网页与 API 默认不动，
//     因为镜像返回的 HTML 里相对路径仍指向 github.com，很容易把页面搞坏。
// ============================================================================

/** 探测"网页能力"用的小文件：46 字节、稳定、内容可控 */
export const DEFAULT_WEB_PROBE =
  "https://raw.githubusercontent.com/ZeroPowerZero/spells-design/main/.gitignore";

/** 探测"git 能力"用的仓库：会请求 <mirror>/<repo>.git/info/refs?service=git-upload-pack */
export const DEFAULT_GIT_PROBE = "https://github.com/ZeroPowerZero/spells-design.git";

/**
 * 内置线路。template 里 {url} / {urlNoScheme} 是占位符。
 * 这些公共镜像的可用性会变，所以探测失败是常态——插件的作用就是自动绕开挂掉的那些。
 */
export const BUILTIN_MIRRORS = [
  { id: "direct",       name: "直连 GitHub（对照组）", template: "{url}",                            web: true,  git: true },
  { id: "ghproxy.net",  name: "ghproxy.net",          template: "https://ghproxy.net/{url}",          web: true,  git: true },
  { id: "ghfast.top",   name: "ghfast.top",           template: "https://ghfast.top/{url}",           web: true,  git: true },
  { id: "gh-proxy.com", name: "gh-proxy.com",         template: "https://gh-proxy.com/{url}",         web: true,  git: true },
  { id: "gitmirror",    name: "hub.gitmirror.com",    template: "https://hub.gitmirror.com/{url}",    web: true,  git: true },
  { id: "moeyy",        name: "github.moeyy.xyz",     template: "https://github.moeyy.xyz/{url}",     web: true,  git: true },
  { id: "ghproxy.cc",   name: "ghproxy.cc",           template: "https://ghproxy.cc/{url}",           web: true,  git: true },
  { id: "llkk",         name: "gh.llkk.cc",           template: "https://gh.llkk.cc/{url}",           web: true,  git: true },
  { id: "gitclone",     name: "gitclone.com",         template: "https://gitclone.com/{urlNoScheme}", web: false, git: true },
];

/**
 * 要接管的 URL 形态（写成"协议头之后"的片段，方便同时生成两种正则）。
 * 顺序无所谓，生成的规则 id 会递推。
 */
const TARGET_HOSTPATHS = [
  { label: "raw 原始文件",        hp: "raw\\.githubusercontent\\.com/.*" },
  { label: "release 资源",        hp: "objects\\.githubusercontent\\.com/.*" },
  { label: "ZIP/TAR 归档",        hp: "codeload\\.github\\.com/.*" },
  { label: "gist 原始文件",       hp: "gist\\.githubusercontent\\.com/.*" },
  { label: "github.com 下载路径", hp: "github\\.com/[^/]+/[^/]+/(?:releases/download|releases/latest/download|archive|raw)/.*" },
];

/** 默认**不**接管的两类（容易把网页搞坏），留给"高级"开关 */
const WEB_HOSTPATHS = [
  { label: "github.com 网页", hp: "github\\.com/.*" },
  { label: "GitHub API",      hp: "api\\.github\\.com/.*" },
];

export function isDirect(mirror) {
  return !mirror || !mirror.template || mirror.template === "{url}";
}

/**
 * 把原始地址套进线路模板。
 * 注意先替换 {urlNoScheme}：它的字面量里含有 "{url" 前缀，顺序反了会出岔子。
 */
export function buildUrl(mirror, url) {
  if (isDirect(mirror)) return url;
  return mirror.template
    .replace("{urlNoScheme}", url.replace(/^https?:\/\//, ""))
    .replace("{url}", url);
}

/** git smart-HTTP 握手地址：能拿到 200 + "git-upload-pack" 就说明这条线路可以 clone */
export function buildGitProbeUrl(mirror, repoUrl = DEFAULT_GIT_PROBE) {
  const base = repoUrl.replace(/\/+$/, "");
  return buildUrl(mirror, `${base}/info/refs?service=git-upload-pack`);
}

/**
 * 生成 declarativeNetRequest 动态规则。
 * 直连线路返回空数组（= 不接管任何请求）。
 */
export function buildRules(mirror, { proxyWebPages = false, startId = 1 } = {}) {
  if (isDirect(mirror)) return [];
  const list = proxyWebPages ? [...TARGET_HOSTPATHS, ...WEB_HOSTPATHS] : TARGET_HOSTPATHS;
  const usesNoScheme = mirror.template.includes("{urlNoScheme}");

  // RE2 的替换串用 \0 表示整个匹配、\1.. 表示捕获组
  const substitution = usesNoScheme
    ? mirror.template.replace("{urlNoScheme}", "\\1")
    : mirror.template.replace("{url}", "\\0");

  const rules = [];
  let id = startId;
  for (const { hp } of list) {
    // 两种正则：{url} 用 \0 全匹配；{urlNoScheme} 需要把协议头之后的部分捕获进 \1
    const regexFilter = usesNoScheme ? `^https://(${hp})$` : `^https://${hp}$`;
    rules.push({
      id: id++,
      priority: 1,
      action: { type: "redirect", redirect: { regexSubstitution: substitution } },
      condition: { regexFilter },   // 不限定 resourceTypes = 所有类型都接管（含 main_frame 下载）
    });
  }
  return rules;
}

/** 生成终端里能直接粘贴的 git 配置（浏览器插件管不到 shell，这条才是 clone 的正解） */
export function gitInsteadOf(mirror, prefix = "https://github.com/") {
  if (isDirect(mirror)) return "";
  const base = mirror.template
    .replace("{urlNoScheme}", prefix.replace(/^https?:\/\//, ""))
    .replace("{url}", prefix);
  return `git config --global url."${base}".insteadOf "${prefix}"`;
}

/** 撤销上面那条配置用的命令 */
export function gitInsteadOfRemove(prefix = "https://github.com/") {
  return `git config --global --remove-section url."${prefix}"`;
}

/**
 * 从探测结果里选线路。
 * @param results 形如 [{ id, name, web:{ok,ms}, git:{ok,ms}, ... }]
 * @param kind    "web" | "git"
 * @param opts    preferDirect / directBiasMs
 */
export function pickBest(results, kind, { preferDirect = true, directBiasMs = 150, exclude = [] } = {}) {
  const ok = results.filter(
    (r) => r[kind] && r[kind].ok && !exclude.includes(r.id) && (kind === "git" ? r.gitCapable !== false : r.webCapable !== false)
  );
  if (ok.length === 0) return null;
  ok.sort((a, b) => a[kind].ms - b[kind].ms);

  // 直连只要不慢太多就优先用直连：少一个第三方中转，内容也更可信
  if (preferDirect) {
    const direct = ok.find((r) => r.id === "direct");
    if (direct && direct[kind].ms <= ok[0][kind].ms + directBiasMs) return direct;
  }
  return ok[0];
}
