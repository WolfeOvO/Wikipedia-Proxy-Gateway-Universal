# Wikipedia-Proxy-Gateway Universal

基于 Cloudflare Workers 的维基百科无障碍访问网关——**通用化增强版**。

在 [zyhgov/Wikipedia-Proxy-Gateway](https://github.com/zyhgov/Wikipedia-Proxy-Gateway)（MIT，作者杖雍皓）基础上改造，支持**全部语言版本的维基百科 + 全部维基媒体姊妹项目**的站内连续浏览。

## 相对上游的改动

| # | 上游行为 | 本版行为 |
|---|---------|---------|
| 1 | 仅代理 `zh.wikipedia.org`，页面内 `*.wikipedia.org` / `*.wikimedia.org` 链接改写 | 全部语言（en/zh/ja/…）+ 全部姊妹项目（wiktionary、wikibooks、wikiquote、wikisource、wikiversity、wikivoyage、wikidata、wikifunctions、wikimedia/commons/meta、mediawiki、wikimediafoundation） |
| 2 | **只对默认源站 HTML 做链接改写**，经 `/__proxy__/` 取回的页面原样透传 → 英文页点站内链接就"掉回"中文版 | `/proxy/` 路径取回的 HTML 同样经 HTMLRewriter 全量改写，相对链接按当前上游 host 正确解析 |
| 3 | CSS 内 `url()` 不改写（仅内联 style） | CSS 文本 `url()` / `@import` 以 CSS 文件自身 URL 为基准改写 |
| 4 | 无浏览器端 JS 处理 | 注入 fetch / XMLHttpRequest shim，拦截页面 JS 动态构造的维基 URL |
| 5 | `/__proxy__/` 可转发**任意域名**（开放转发） | 仅允许维基媒体旗下域名，其余返回 403 |
| 6 | 公网域名硬编码在代码里 | `PUBLIC_HOST` 环境变量，改 `wrangler.jsonc` 即可部署 |

上游其他机制（边缘缓存分层、Range 支持、5xx 熔断、响应头清洗）均保留。

## 部署（10 分钟，免费额度即可）

### 前置

- 一个 Cloudflare 账号
- 一个已接入 Cloudflare（NS 托管）的域名
- Node.js 18+

### 1. 克隆本仓库

```bash
git clone https://github.com/WolfeOvO/Wikipedia-Proxy-Gateway-Universal.git
cd Wikipedia-Proxy-Gateway-Universal
```

### 2. 登录 wrangler

```bash
npx wrangler login
```

### 3. 改域名

编辑 `wrangler.jsonc`，把两处 `<YOUR_DOMAIN>` 换成你的子域名，例如 `wiki.example.com`：

```jsonc
"routes": [
  { "pattern": "wiki.example.com", "custom_domain": true }
],
"vars": {
  "PUBLIC_HOST": "wiki.example.com"
}
```

> `custom_domain: true` 模式下，`wrangler deploy` 会**自动创建**该子域名的 DNS 记录（前提：根域名 zone 在同一账号），无需手动去面板加。

### 4. 部署

```bash
npx wrangler deploy
```

### 5. 验收

```bash
# 健康检查，应返回 ok
curl https://wiki.example.com/__wiki_proxy_ping

# 端到端：拉一个中文词条
curl -H 'Accept: text/html' https://wiki.example.com/wiki/中国 -o /dev/null -w '%{http_code}\n'
# 应输出 200
```

浏览器打开 `https://wiki.example.com/wiki/Wikipedia:首页`，点右上角 English / any 语言、或任何姊妹项目链接，应停留在你自己的域名下连续浏览。

## 路径说明

| 路径 | 作用 |
|------|------|
| `/wiki/X`、`/w/load.php`、`/static/…`、`/` | 默认源站（`zh.wikipedia.org`）对应路径 |
| `/proxy/{host}/{path}` | 显式代理任意维基媒体 host，如 `/proxy/en.wikipedia.org/wiki/China`、`/proxy/commons.wikimedia.org/...` |
| `/__proxy__/…` | 兼容上游旧链接格式，等价于 `/proxy/` |
| `/__wiki_proxy_ping` | 健康检查，返回 `ok` |

## 已知限制

- 需要**登录**维基的会话（编辑、偏好设置）因 Cookie 域不同而不工作——本网关面向只读浏览场景。
- 少数通过 Service Worker 或 postMessage 加载的资源可能绕过改写。
- 免费版 Worker 单请求 CPU 10ms 限制，超大页面改写偶发超时（实测中文/英文词条页均正常）。

## License

MIT。原版 © 2025 [杖雍皓](https://github.com/zyhgov)；通用化增强 © 2026 [WolfeOvO](https://github.com/WolfeOvO)。
