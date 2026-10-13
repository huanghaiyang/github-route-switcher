# GitHub 线路探测 · 自动切换（Chrome 扩展）

国内直连 `github.com` 经常不通。这个扩展做的事就一件：**并发探测一批 GitHub 镜像线路，
自动把浏览器里"下载类"请求切到当前最快且可用的一条；挂掉就自动换下一条。**
顺手还会把**终端里 `git clone` 该怎么办**生成成一条可以直接粘贴的命令。

> 设计思路来自一次真实排查：直连 github.com 超时 → 依次试 `ghfast.top`（挂）→ `ghproxy.net`（通）。
> 人肉试一遍要好几分钟，交给扩展就是一次点击。

---

## 功能

| 功能 | 说明 |
|---|---|
| **并发探测** | 所有线路同时测，不串行（串行的话一条挂掉的要等满超时）|
| **两种能力分开测** | 「网页能力」用一个小 raw 文件测；「git 能力」用 git smart-HTTP 握手地址测。两者不通用——比如 `gitclone.com` 只能用于 git |
| **自动接管** | 用 `declarativeNetRequest` 动态规则重定向 raw / release / archive / gist 这些下载请求 |
| **失败自动换线** | 定时重探 + 监听真实请求的网络错误，连续失败到阈值就切下一条 |
| **优先直连** | 直连只要不比最快镜像慢太多（默认 150ms）就用直连——少一个第三方中转 |
| **生成 git 配置** | 浏览器插件管不到终端，所以把 `git config ... insteadOf ...` 直接生成好给你复制 |

**默认不动 `github.com` 网页和 API**：镜像返回的 HTML 里相对路径仍指向 `github.com`，
接管网页很容易把页面搞坏。要试的话在「高级设置」里有开关（不推荐）。

## 安装

1. 打开 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本文件夹
4. 点工具栏里的扩展图标打开面板

Edge / Brave 等 Chromium 内核浏览器同理。

## 使用

1. 打开面板 → 点 **重新探测**（首次安装会自动探一次）
2. 它会自己选出最快可用线路并接管，列表里点 **选用** 也能手动指定
3. 面板下半部分给你的 `git` 命令，复制后粘贴到终端执行一次即可长期生效：

   ```bash
   git config --global url."https://ghproxy.net/https://github.com/".insteadOf "https://github.com/"
   ```

   撤销用面板里的「复制撤销命令」，或手写 `git config --global --remove-section url."https://github.com/"`。

## 线路表的写法

「高级设置」里每行一条：`名称|模板|web|git`

- `{url}` —— 完整原地址拼在后面（`https://ghproxy.net/https://github.com/...`）
- `{urlNoScheme}` —— 去掉协议头再拼（`https://gitclone.com/github.com/...`）
- 模板直接写 `{url}` 表示**这条是直连**（不接管任何请求，作为对照组）
- `web` / `git` 写 `1`/`0` 表示是否具备该能力

内置 9 条线路（`lib.js` 里的 `BUILTIN_MIRRORS`）。公共镜像的可用性变化很快，
**探测失败是常态**——这正是这个插件存在的意义，别把某条线路当成永久可用。

## 权限说明

| 权限 | 为什么需要 |
|---|---|
| `declarativeNetRequest` | 下发重定向规则（MV3 里唯一能改请求的方式）|
| `webRequest` | 只用来**观察**失败，不做拦截（MV3 不允许扩展拦截）|
| `storage` | 存线路表、探测结果、日志 |
| `alarms` | 定时重探 |
| `<all_urls>` | 探测要访问任意镜像域名；观察失败要知道请求发给了谁 |

## 已知限制（重要）

- **只管浏览器流量**。`git clone` / `npm install` 这类命令行流量扩展管不到——请用生成的那条 `insteadOf` 配置，或走代理。
- **镜像都是第三方**。请求内容和响应内容都会经过它。所以：
  - 默认「优先直连」，能不走第三方就不走；
  - 探测会顺带校验响应体非空、git 握手返回体像不像 git 的 advertisement，
    但这**只能证明"通"，不能证明"没被改"**；
  - 要验证完整性，用内容哈希比对最靠谱（例如 `git hash-object <file>` 与 GitHub API 报的 blob sha 对照）。
- 线路表里的域名会变（今天能用的明天可能挂），所以我内置的只是**起点**，不是保证。

## 开发 / 测试

纯逻辑（模板展开、DNR 规则生成、git 配置生成、选线策略）都放在 `lib.js`，
不引用任何 `chrome.*`，所以能直接用 node 测：

```bash
node selftest.mjs      # 或 npm test
```

测试里有一步是**用真实 URL 跑一遍重定向**（复刻 DNR 的 `\0`/`\1` 替换语义），
确认生成的正则真能匹配、替换出来的地址真对、以及无关站点不被误接管。

文件结构：

```
manifest.json    MV3 清单
lib.js           纯逻辑：线路表 / 模板展开 / DNR 规则 / git 配置 / 选线
background.js    Service Worker：探测、下发规则、失败换线、消息接口
popup.html/css/js  面板界面
selftest.mjs     纯逻辑单测
```

## 调参

| 项 | 默认 | 说明 |
|---|---|---|
| 超时 | 8000ms | 探测单条线路的上限 |
| 重探间隔 | 5 分钟 | 定时重新探测 |
| 失败阈值 | 3 | 连续失败几次就换线 |
| 直连偏好 | 开 | 直连不慢超过 150ms 就用直连 |
| 网页探测目标 | 46 字节的小 raw 文件 | 建议保持"小且稳定" |
| git 探测仓库 | 一个小公开仓库 | 会请求 `<mirror>/<repo>.git/info/refs?service=git-upload-pack` |
