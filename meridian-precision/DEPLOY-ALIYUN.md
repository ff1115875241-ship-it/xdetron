# DEPLOY-ALIYUN.md · 把这个站部署到阿里云（www.xdetron.com）

> 本站是**纯静态站点**：无后端、无数据库、无构建步骤。部署 = 把文件原样放到
> 能通过 HTTP 访问的地方。推荐**方案 A（OSS 静态托管）**：最便宜、最稳、
> 不用维护服务器；量起来后再挂 CDN。

---

## 部署前必读：ICP 备案

**中国大陆的服务器/OSC 存储绑定域名，必须先完成 ICP 备案。** 未备案的域名
解析到大陆节点会被阻断。备案是免费的，走阿里云 ICP 备案系统，通常需要
7–20 个工作日，需要：营业执照、法人身份证、域名证书、服务器/托管服务。

- 备案主体：无锡艾得创科技有限公司
- 域名：xdetron.com（确认已在阿里云或原注册商完成实名认证）
- **备案期间网站不能上线**，所以：先提交备案，备案审核期间用方案 B 的
  香港节点临时预览，备案通过后再切回大陆节点正式上线。

---

## 方案 A（推荐）：OSS 静态网站托管 + CDN

### 1. 上传文件

把 `meridian-precision/` 目录下的全部内容（**不包含 `.shots/`**）上传到
OSS Bucket（例如 `xdetron-web`，地域选靠近主要客户的市场——外贸站可选
华东2上海 或 中国香港）：

```bash
# 安装 ossutil 后
ossutil cp -rf meridian-precision/ oss://xdetron-web/ --include "*" --exclude ".shots/*"
```

需要上传的关键文件清单：

```
index.html  equipment.html  privacy.html  robots.txt  sitemap.xml
styles/  (3 个 css)
scripts/ (5 个 js)
vendor/  (occt-import-js.js + occt-import-js.wasm  ← 必须上传，STEP 报价靠它)
```

### 2. 开启静态网站托管

Bucket → 基础设置 → 静态页面：
- 默认首页：`index.html`
- 默认 404 页：`index.html`（单页站这样最省事，错误也落到首页）

### 3. 绑定域名 + HTTPS

1. Bucket → 域名管理 → 绑定自定义域名 `www.xdetron.com`，勾选「添加 CNAME 记录」
2. DNS 解析：添加 `CNAME  www  →  xdetron-web.oss-cn-xxx.aliyuncs.com`
3. 同时加一条 301：根域名 `xdetron.com` → `https://www.xdetron.com`
   （ canonical、sitemap、JSON-LD 里写的都是 www，保持一致）
4. 证书：阿里云「数字证书管理服务」申请免费 DV 证书（每年 20 张免费额度），
   签发后在 CDN / OSS 域名管理里开启 HTTPS 强制跳转

### 4. 挂 CDN（可选但建议）

- 源站填 OSS 内网 Endpoint（流量费省一半以上）
- 缓存规则：`styles/*`、`scripts/*`、`vendor/*` → 缓存 30 天；
  HTML → 缓存 10 分钟或遵循源站 no-cache
- **注意**：`vendor/occt-import-js.wasm` 有 7.6 MB，务必确保 CDN 对它生效缓存，
  否则客户首次用 STEP 报价会慢
- MIME 类型确认：`.wasm` 必须是 `application/wasm`（OSS 控制台 → 文件属性 →
  手动设置 Content-Type），否则浏览器会拒绝编译内核

### 5. 部署后 3 分钟验收

```
https://www.xdetron.com/                    首页正常，无混合内容警告
https://www.xdetron.com/equipment.html      设备页正常
https://www.xdetron.com/sitemap.xml         XML 可读
拖入一个 .stp 文件                           内核加载一次后出价（见下）
提交询盘（RFQ_ENDPOINT 还为空时）            F12 控制台能看到 payload
```

STEP 报价验收标准：拖入 STEP → 显示「正在加载几何内核」→ 几秒后出现
外形尺寸/体积/价格。若直接进了「工程师核价」队列并提示「内核加载失败」，
八成是 `.wasm` 的 MIME 不对或 vendor 文件没传上去。

> **本地预览**：直接双击 `index.html`（file://）也能用 STEP 报价——站点
> 内置了 base64 内核兜底（`vendor/occt-wasm-b64.js`，仅 file:// 时加载，
> 首次需数秒解码 10MB）。若想要更快的本地体验，仍可在站点目录跑
> `python -m http.server 8080` 走正常 .wasm 通道。部署到 OSS/ECS 后经
> http(s) 访问自动使用 .wasm，base64 文件不会被加载（可不上传）。

---

## 方案 B：ECS + Nginx（适合已有服务器）

```nginx
server {
    listen 443 ssl http2;
    server_name www.xdetron.com;
    root /var/www/xdetron;
    index index.html;

    # 7.6 MB 的 WASM 内核要长缓存
    location /vendor/    { add_header Cache-Control "public, max-age=2592000, immutable"; }
    location ~* \.(css|js|png|svg|ico)$ { add_header Cache-Control "public, max-age=604800"; }
    location / { try_files $uri $uri/ =404; }

    # 正确的 wasm MIME（新版 nginx 自带，老版本需手动加）
    types { application/wasm wasm; }

    gzip on;  gzip_types text/css application/javascript application/json image/svg+xml;
    # 注意：wasm 不建议 gzip（本身就是二进制，收益小）
}
```

上传：`scp -r meridian-precision/* root@ecs:/var/www/xdetron/`（排除 `.shots/`）。

---

## 上线后还要做的两件事

1. **接询盘表单**（现在 `RFQ_ENDPOINT` 为空，询盘不会送达任何人！）：
   编辑 `scripts/quote-flow.js` 和 `equipment.html` 顶部的 `RFQ_ENDPOINT`，
   填入 Formspree / Web3Forms / 飞书表单 webhook 任一即可，payload 是 JSON。
   **这是上线前最后一个必做项。**
2. **站长平台**：把 `https://www.xdetron.com/sitemap.xml` 提交到 Google
   Search Console 和必应站长工具（外贸客户用 Google/必应，不提交等于隐身）。
