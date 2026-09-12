/**
 * Wikipedia-Proxy-Gateway Universal（worker.js）
 *
 * 基于杖雍皓《Wikipedia-Proxy-Gateway》(MIT) 的通用化增强版：
 *   上游项目：https://github.com/zyhgov/Wikipedia-Proxy-Gateway
 *
 * 相对上游的改动（详见 README）：
 *   1. 全语言维基百科 + 全部维基媒体姊妹项目（wiktionary / wikibooks / wikiquote /
 *      wikisource / wikiversity / wikivoyage / wikidata / wikifunctions /
 *      wikimedia(commons,meta…) / mediawiki / wikimediafoundation）站内直接浏览，
 *      不再"掉回"中文版。
 *   2. 修复：经 /proxy/ 取回的 HTML 也做 HTMLRewriter 全量改写（上游只改写默认源站
 *      路径），相对链接按"当前上游 host"正确解析。
 *   3. 新增：CSS 文件 url() / @import 改写（上游只改 style 属性）。
 *   4. 新增：注入 fetch / XMLHttpRequest shim，拦截 JS 动态构造的维基 URL
 *      （mw wgServer、api 调用等）。
 *   5. 安全：/proxy/ 仅允许维基媒体旗下域名，关闭通用开放转发。
 *   6. 公网域名改为环境变量 PUBLIC_HOST，fork 后改 wrangler.jsonc 即可部署。
 *
 * License: MIT — Copyright (c) 2025 杖雍皓（原版）/ 2026 WolfeOvO（通用化增强）
 */

const DEFAULT_ORIGIN = 'zh.wikipedia.org';
const PROXY_PREFIX = '/proxy/';
const LEGACY_PREFIX = '/__proxy__/'; // 兼容上游旧链接
const PING_PATH = '/__wiki_proxy_ping';

let PUBLIC_HOST = 'wikimirror.wolfe.cc.cd';

// 维基媒体旗下全部站点后缀（所有语言版本 + 全部姊妹项目）
const WIKI_SUFFIXES = [
  'wikipedia.org', 'wiktionary.org', 'wikibooks.org', 'wikiquote.org',
  'wikisource.org', 'wikiversity.org', 'wikivoyage.org', 'wikidata.org',
  'wikifunctions.org', 'wikimedia.org', 'mediawiki.org', 'wikimediafoundation.org',
];
const WIKI_HOST_RE = new RegExp(
  '(^|\\.)(' + WIKI_SUFFIXES.map(s => s.replace(/\./g, '\\.')).join('|') + ')$'
);

const TTL_HTML = 60 * 5;                  // 改写后 HTML 缓存 5 分钟
const TTL_ASSET_SHORT = 60 * 60 * 12;     // CSS/JS 等短缓存 12 小时
const TTL_ASSET_LONG = 60 * 60 * 24 * 30; // 图片/字体/媒体长缓存 30 天

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);



export default {
  async fetch(request, env, ctx) {
    PUBLIC_HOST = (env && env.PUBLIC_HOST) || 'wikimirror.wolfe.cc.cd';
    try {
      if (!ALLOWED_METHODS.has(request.method)) {
        return new Response('Method Not Allowed', { status: 405 });
      }
      const url = new URL(request.url);

      if (url.pathname === PING_PATH) {
        return new Response('ok', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }

      // /proxy/{host}/{path...}（兼容上游旧前缀 /__proxy__/）
      const prefix = url.pathname.startsWith(PROXY_PREFIX) ? PROXY_PREFIX
        : url.pathname.startsWith(LEGACY_PREFIX) ? LEGACY_PREFIX : null;

      if (prefix) {
        const parts = url.pathname.slice(prefix.length).split('/').filter(Boolean);
        if (parts.length === 0) {
          return errorPage('缺少目标 host。用法：/proxy/{host}/{path}');
        }
        const host = parts[0].toLowerCase();
        if (!/^[a-z0-9.-]+$/i.test(host) || !isWikimediaHost(host)) {
          return notAllowedPage(host);
        }
        const subPath = '/' + parts.slice(1).join('/');
        return await handleProxied(request, url, host, subPath, ctx);
      }

      // 其余路径一律视为默认源站（zh.wikipedia.org）的路径：
      //   /wiki/X、/w/load.php、/static/...、/ 等全部照常工作
      return await handleProxied(request, url, DEFAULT_ORIGIN, url.pathname, ctx);
    } catch (err) {
      return errorPage('Unexpected server error: ' + (err && err.message ? err.message : String(err)));
    }
  },
};

/* -------------------- 核心代理处理 -------------------- */

async function handleProxied(request, url, host, subPath, ctx) {
  const cache = caches.default;
  const isGet = request.method === 'GET';
  const likelyAsset = isLikelyAsset(subPath);
  const target = 'https://' + host + subPath + (url.search || '');

  const upstreamHeaders = prepareForwardHeaders(request.headers, host);

  /* ---- 桌面版/移动版判定 ----
   * 上游根据 User-Agent 和 useformat cookie 决定给桌面版（Vector）还是移动版（Minerva）。
   * 而 Cloudflare 缓存不按 User-Agent 区分（忽略 Vary: User-Agent），如果缓存键只用纯 URL，
   * 谁先来谁的版本就被全站所有人拿到——这正是"电脑也显示移动端视图"的根因。
   * 因此这里把 desktop/mobile 分类结果编进 HTML 缓存键，并对响应声明 Vary。 */
  const ua = request.headers.get('user-agent') || '';
  const cookie = request.headers.get('cookie') || '';
  // 上游种 useformat cookie 的域是 .wikipedia.org，在我们域名下种不进浏览器；
  // 因此 URL 参数 ?useformat= 也参与判定（移动版页面里的 桌面版视图 链接自带该参数）
  const queryForced = url.searchParams.get('useformat');
  let forced = null;
  if (queryForced === 'desktop' || queryForced === 'mobile') {
    forced = queryForced;
  } else {
    const um = cookie.match(/(?:^|;\s*)useformat=(desktop|mobile)/);
    if (um) forced = um[1];
  }
  const isMobileUA = /android|iphone|ipod|blackberry|iemobile|opera m(?:obi|ini)|windows phone|mobile safari|kindle|silk|midp|micromessenger|wechat|crios/i.test(ua);
  const variant = forced || (isMobileUA ? 'mobile' : 'desktop');
  // 除 useformat（只影响桌面/移动版本，已编入缓存键）外还有别的 cookie（如登录态）时绝不共享缓存
  const hasSessionCookie = cookie.split(';').map(c => c.trim()).filter(Boolean)
    .some(c => !/^useformat=(desktop|mobile)$/.test(c));
  const anonymous = !hasSessionCookie;

  // HTML：按"我们这边的 URL + UA 版本"做边缘缓存（仅匿名用户；登录用户完全不缓存）
  const htmlKey = new Request(request.url + (request.url.includes('?') ? '&' : '?') + '__uav=' + variant, { method: 'GET' });
  if (isGet && !likelyAsset && anonymous) {
    try {
      const hit = await cache.match(htmlKey);
      if (hit) return hit;
    } catch (e) { /* ignore */ }
  }

  // 静态资源：按"上游 URL"做边缘缓存
  const assetKey = new Request(target, { method: 'GET', headers: upstreamHeaders });
  if (isGet && likelyAsset) {
    try {
      const hit = await cache.match(assetKey);
      if (hit) return hit;
    } catch (e) { /* ignore */ }
  }

  const upstreamReq = new Request(target, {
    method: request.method,
    headers: upstreamHeaders,
    body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
    redirect: 'follow',
    // HTML 一律绕过 CF 边缘缓存拉取（cache:'no-store'）：旧版本曾在 CF 缓存层存下
    // 最多 12 小时的"URL 唯一键"HTML（可能是移动版），no-store 立即穿透这些残留条目
    cache: likelyAsset ? undefined : 'no-store',
  });

  let fetched;
  try {
    // 关键：CF 源缓存层（cf.cacheEverything）只按 URL 作键、忽略 UA/Cookie。
    // 若 HTML 也走它，手机用户先到就会把移动版缓存 12h 喂给所有人（"电脑也是移动端"的另一半根因）。
    // 因此仅静态资源启用 cf 源缓存；HTML 只走 Worker 自己的 caches.default（键含 UA 版本）。
    fetched = await fetch(upstreamReq, likelyAsset ? {
      cf: { cacheTtl: TTL_ASSET_LONG, cacheEverything: true },
    } : undefined);
  } catch (err) {
    try {
      fetched = await fetch(target); // 兜底：不带转发头直连
    } catch (err2) {
      return errorPage('无法连接上游 ' + host + '：' + (err2.message || String(err2)));
    }
  }

  const contentType = (fetched.headers.get('content-type') || '').toLowerCase();

  /* ---- HTML：全量改写（本版核心修复：/proxy/ 路径同样改写） ---- */
  if (contentType.includes('text/html') && request.method !== 'HEAD') {
    const rewriter = new HTMLRewriter()
      .on('a', new AttrRewriter('href', host))
      .on('link', new AttrRewriter('href', host))
      .on('script', new AttrRewriter('src', host))
      .on('img', new AttrRewriter('src', host))
      .on('img', new AttrRewriter('srcset', host))
      .on('img', new AttrRewriter('data-src', host))
      .on('img', new AttrRewriter('data-srcset', host))
      .on('source', new AttrRewriter('src', host))
      .on('source', new AttrRewriter('srcset', host))
      .on('video', new AttrRewriter('src', host))
      .on('video', new AttrRewriter('poster', host))
      .on('audio', new AttrRewriter('src', host))
      .on('iframe', new AttrRewriter('src', host))
      .on('form', new AttrRewriter('action', host))
      .on('*', new StyleAttrRewriter(host))
      .on('head', {
        element(el) { el.prepend(shimScript(host), { html: true }); },
      });

    const rewritten = rewriter.transform(fetched);
    const h = stripProblematicHeaders(fetched.headers);
    h.delete('content-length');
    // 桌面/移动两版内容共用同一 URL，而 CF 边缘缓存不按 Vary 区分：
    // HTML 一律标 private 禁止 CF 边缘缓存，只走 Worker 自己的 caches.default（缓存键含 UA 版本）。
    h.set('Vary', 'User-Agent, Cookie');
    h.set('Cache-Control', anonymous ? 'private, max-age=' + TTL_HTML : 'private, no-store');

    const resp = new Response(rewritten.body, {
      status: fetched.status,
      statusText: fetched.statusText,
      headers: h,
    });
    resp.headers.set('X-Wiki-Gateway', 'html-rewritten; host=' + host + '; variant=' + variant);
    if (isGet && fetched.status === 200 && anonymous) {
      ctx.waitUntil(eventualCachePut(cache, htmlKey, resp.clone()));
    }
    return resp;
  }

  /* ---- CSS：url() / @import 改写 ---- */
  if (contentType.includes('text/css') && request.method !== 'HEAD') {
    const cssText = await fetched.text();
    const out = rewriteCss(cssText, target, host);
    const h = stripProblematicHeaders(fetched.headers);
    h.delete('content-length');
    h.set('Content-Type', 'text/css; charset=utf-8');
    h.set('Cache-Control', 'public, max-age=' + TTL_ASSET_SHORT);

    const resp = new Response(out, {
      status: fetched.status,
      statusText: fetched.statusText,
      headers: h,
    });
    resp.headers.set('X-Wiki-Gateway', 'css-rewritten; host=' + host);
    if (isGet && fetched.status === 200) {
      ctx.waitUntil(eventualCachePut(cache, assetKey, resp.clone()));
    }
    return resp;
  }

  /* ---- 其余：原样透传（图片/字体/媒体/JSON/Range 206 等） ---- */
  const cleaned = stripProblematicHeaders(fetched.headers);
  const resp = new Response(fetched.body, {
    status: fetched.status,
    statusText: fetched.statusText,
    headers: cleaned,
  });
  if (fetched.status === 200 && likelyAsset) {
    resp.headers.set('Cache-Control', 'public, max-age=' + TTL_ASSET_LONG);
    if (isGet) ctx.waitUntil(eventualCachePut(cache, assetKey, resp.clone()));
  } else if (fetched.status === 200) {
    resp.headers.set('Cache-Control', 'public, max-age=' + TTL_ASSET_SHORT);
  }
  resp.headers.set('X-Wiki-Gateway', 'passthrough; host=' + host);
  return resp;
}

/* -------------------- URL 改写 -------------------- */

function isWikimediaHost(h) {
  if (!h) return false;
  const host = String(h).toLowerCase();
  if (host === PUBLIC_HOST) return false; // 防自代理死循环
  return WIKI_HOST_RE.test(host);
}

function isLikelyAsset(pathname) {
  return /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|woff2?|ttf|otf|map|mp4|webm|ogg|mp3|wav|flac|m4a|ogv|ogm)(\?.*)?$/i.test(pathname);
}

function isAlreadyProxied(val) {
  if (typeof val !== 'string' || !val) return false;
  if (val.startsWith(PROXY_PREFIX) || val.startsWith(LEGACY_PREFIX)) return true;
  try {
    const u = new URL(val, 'https://' + DEFAULT_ORIGIN);
    return u.hostname === PUBLIC_HOST;
  } catch (e) {
    return false;
  }
}

/**
 * 把任意 URL（相对/绝对/协议相对）改写为 /proxy/{host}/{path} 形式。
 *  - resolveBase：解析相对路径用的基准 URL（CSS 传 CSS 文件自身的上游 URL）
 *  - 非维基媒体的绝对 URL 保持不变（第三方外链不代理）
 *  - 返回"根相对"路径（以 / 开头），对任何公网域名都成立
 */
function makeProxyUrl(orig, baseHost, resolveBase) {
  try {
    if (typeof orig !== 'string') return orig;
    const t = orig.trim();
    if (!t || t.startsWith('#')) return orig; // 页内锚点原样保留
    if (/^(data:|blob:|about:|javascript:|mailto:|tel:|sms:)/i.test(t)) return orig;
    if (t.startsWith(PROXY_PREFIX) || t.startsWith(LEGACY_PREFIX)) return orig;

    let u;
    if (t.startsWith('//')) u = new URL('https:' + t);
    else if (/^https?:\/\//i.test(t)) u = new URL(t);
    else u = new URL(t, resolveBase || ('https://' + baseHost));

    const host = u.hostname.toLowerCase();
    if (!isWikimediaHost(host)) return orig; // 第三方外链不改写
    return PROXY_PREFIX + host + u.pathname + (u.search || '') + (u.hash || '');
  } catch (e) {
    return orig;
  }
}

class AttrRewriter {
  constructor(attrName, baseHost) {
    this.attrName = attrName;
    this.baseHost = baseHost;
  }
  element(el) {
    try {
      const raw = el.getAttribute(this.attrName);
      if (!raw) return;
      if (isAlreadyProxied(raw)) return;

      // srcset / data-srcset："URL 2x, URL2 480w" 多段形式
      if (this.attrName === 'srcset' || this.attrName === 'data-srcset') {
        if (raw.includes('data:')) return; // 含 data: URI 时不做逗号切分，避免改坏
        const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
        const mapped = parts.map(part => {
          const m = part.match(/^(\S+)(\s+\S+)?$/);
          if (!m) return part;
          return makeProxyUrl(m[1], this.baseHost) + (m[2] || '');
        });
        el.setAttribute(this.attrName, mapped.join(', '));
        return;
      }

      const newVal = makeProxyUrl(raw, this.baseHost);
      if (newVal && newVal !== raw) el.setAttribute(this.attrName, newVal);
    } catch (e) { /* 单元素失败不影响整体 */ }
  }
}

class StyleAttrRewriter {
  constructor(baseHost) { this.baseHost = baseHost; }
  element(el) {
    try {
      const styleVal = el.getAttribute('style');
      if (!styleVal) return;
      const newStyle = styleVal.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (m, q, u) => {
        if (/^(data:|blob:|about:|#)/i.test(u.trim())) return m;
        const nu = makeProxyUrl(u, this.baseHost);
        return nu === u ? m : `url(${q}${nu}${q})`;
      });
      if (newStyle !== styleVal) el.setAttribute('style', newStyle);
    } catch (e) { /* ignore */ }
  }
}

/* -------------------- CSS 文本改写 -------------------- */

function rewriteCss(cssText, cssUrl, baseHost) {
  return cssText
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
      const t = u.trim();
      if (!t || /^(data:|blob:|about:|#)/i.test(t)) return m;
      const nu = makeProxyUrl(t, baseHost, cssUrl); // 相对 url 以 CSS 文件自身为基准
      return nu === t ? m : `url(${q}${nu}${q})`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
      const nu = makeProxyUrl(u.trim(), baseHost, cssUrl);
      return nu === u.trim() ? m : `@import ${q}${nu}${q}`;
    });
}

/* -------------------- 浏览器端 JS shim -------------------- */

const SHIM_BODY = `
(function(){
  var C = window.__WIKI_PROXY__;
  if(!C) return;
  var RE = new RegExp(C.re);
  function isWikiHost(h){ return !!h && RE.test(h); }
  function fix(u){
    try{
      if(typeof u !== 'string' || !u) return u;
      if(u.indexOf(C.prefix) === 0 || u.indexOf('__proxy__/') === 0) return u;
      if(u.charAt(0) === '#') return u;
      var abs = null;
      if(u.indexOf('//') === 0) abs = new URL('https:' + u);
      else if(/^(https?:)\\/\\//i.test(u)) abs = new URL(u);
      else if(u.charAt(0) === '/') abs = new URL('https://' + C.origin + u);
      else return u;
      var h = abs.hostname.toLowerCase();
      if(isWikiHost(h)){
        return C.prefix + '/' + h + abs.pathname + abs.search + abs.hash;
      }
      return u;
    }catch(e){ return u; }
  }
  try{
    var of = window.fetch;
    window.fetch = function(input, init){
      try{
        if(typeof input === 'string'){ input = fix(input); }
        else if(input && typeof input.url === 'string'){ input = new Request(fix(input.url), input); }
      }catch(e){}
      return of.call(window, input, init);
    };
  }catch(e){}
  try{
    var oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url){
      arguments[1] = fix(url);
      return oo.apply(this, arguments);
    };
  }catch(e){}
})();
`;

function shimScript(host) {
  const cfg = { prefix: PROXY_PREFIX, origin: host, re: WIKI_HOST_RE.source };
  return '<script>window.__WIKI_PROXY__=' + JSON.stringify(cfg) + ';' + SHIM_BODY + '</script>';
}

/* -------------------- 请求头 / 响应头 -------------------- */

function prepareForwardHeaders(originalHeaders, upstreamHost) {
  const headers = new Headers();
  const drop = new Set([
    'x-forwarded-for', 'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-visitor',
    'cf-worker', 'via', 'connection', 'keep-alive', 'transfer-encoding',
    'upgrade', 'host', 'accept-encoding',
  ]);
  for (const [k, v] of originalHeaders) {
    if (drop.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  if (!headers.has('referer')) headers.set('Referer', 'https://' + upstreamHost + '/');
  if (!headers.has('user-agent')) {
    headers.set('User-Agent', 'Mozilla/5.0 (compatible; wiki-proxy-gateway-universal/1.0)');
  }
  return headers;
}

function stripProblematicHeaders(origHeaders) {
  const headers = new Headers(origHeaders);
  [
    'content-security-policy',
    'content-security-policy-report-only',
    'cross-origin-embedder-policy',
    'cross-origin-opener-policy',
    'cross-origin-resource-policy',
    'x-frame-options',
  ].forEach(h => headers.delete(h));
  return headers;
}

async function eventualCachePut(cache, key, value) {
  try {
    await cache.put(key, value);
  } catch (e) { /* 缓存失败不影响响应 */ }
}

/* -------------------- 错误 / 提示页 -------------------- */

function escapeHtml(s) {
  return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pageShell(title, body) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f7fb}.box{background:#fff;padding:26px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:720px;text-align:center}h1{margin:0 0 12px;color:#c0392b;font-size:20px}p{color:#333;line-height:1.7}code{background:#f0f2f5;padding:2px 6px;border-radius:4px}a{color:#0b74de}</style></head><body><div class="box">' + body + '</div></body></html>';
}

function errorPage(message) {
  return new Response(pageShell('维基代理网关暂时不可用',
    '<h1>维基代理网关暂时不可用</h1><p>' + escapeHtml(message) + '</p>' +
    '<p><a href="javascript:location.reload()">点击重试</a>（多为瞬时网络抖动，重试即可恢复）</p>'), {
    status: 502,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, must-revalidate',
    },
  });
}

function notAllowedPage(host) {
  return new Response(pageShell('仅支持代理维基媒体站点',
    '<h1>仅支持代理维基媒体旗下站点</h1>' +
    '<p>目标 <code>' + escapeHtml(host) + '</code> 不在允许列表中。</p>' +
    '<p>本网关只转发 Wikipedia / Wiktionary / Wikidata / Commons 等维基媒体域名，' +
    '不提供通用代理服务。</p>'), {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
