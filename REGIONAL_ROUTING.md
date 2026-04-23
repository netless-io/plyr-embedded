# Plyr CDN 多区域部署方案

## 背景

当前 `plyr-cdn` 已经作为独立播放器页面部署，通过 `EmbeddedPage` 接入白板，并在页面内部使用 `@netless/app-embedded-page-sdk` 同步播放器状态。

现状有一个明确限制：

- `EmbeddedPage` 当前只有一个同步入口 URL，即 `attributes.src`
- `app-embedded-page` 在 setup 阶段直接把该 URL 赋值给 `iframe.src`
- 这意味着同一个 app 实例里，所有端默认都会加载同一个页面地址

当前代码锚点：

- `app-embedded-page/src/index.ts`
  - `Attributes.src` 定义：`/Users/hongqiuer/work/netless-app/packages/app-embedded-page/src/index.ts`
  - `iframe.src = attrs.src`：`/Users/hongqiuer/work/netless-app/packages/app-embedded-page/src/index.ts`
- `fastboard-demo` 当前 `Embedded Plyr` 接法：
  - `/Users/hongqiuer/work/fastboard-demo/src/behaviors/fastboard.ts`
- `plyr-cdn` 当前的播放器同步状态仍然放在 `store.state`
  - `/Users/hongqiuer/work/plyr-cdn/README.md`

因此，多区域部署的核心问题不是播放器同步状态，而是如何让 `src` 这个单一入口 URL 具备区域路由能力。

## 目标

目标是让业务侧继续只传一个稳定入口 URL，但根据访问方所在区域，最终加载不同的区域页面，例如：

- 中国客户访问中国节点
- 亚洲客户访问新加坡节点
- 美洲客户访问美国节点

同时保持：

- `EmbeddedPage` 模型不变
- `store.state` 结构不变
- iOS / Web / fastboard-demo 接入方式尽量稳定

## 结论

只保留以下两个方案：

1. 首选：单一域名 + GeoDNS / GTM / CDN 调度
2. 次选：单一 bootstrap URL，再由入口页跳转到区域页

推荐顺序：

- 正式方案优先落地方案 A
- 如果短期内基础设施侧还没有条件完成全球调度，则先落地方案 B
- 方案 B 的业务接口可以直接设计成与方案 A 一致，后续平滑切换

---

## 统一接入约定

无论使用方案 A 还是方案 B，建议业务侧统一通过一个 helper 生成 `EmbeddedPage` 的 `attributes`：

```ts
type EmbeddedPlyrRouteConfig = {
  version: string;
  tenant?: string;
  env?: "prod" | "staging";
  regionHint?: "auto" | "cn" | "sg" | "us";
  channel?: string;
};

type EmbeddedPlyrLaunchArgs = {
  title: string;
  entryUrl: string;
  route: EmbeddedPlyrRouteConfig;
  data: EmbeddedPlyrStore;
};

function createEmbeddedPlyrAttributes(args: EmbeddedPlyrLaunchArgs) {
  const url = new URL(args.entryUrl);
  url.searchParams.set("v", args.route.version);
  if (args.route.tenant) url.searchParams.set("tenant", args.route.tenant);
  if (args.route.env) url.searchParams.set("env", args.route.env);
  if (args.route.regionHint) url.searchParams.set("region", args.route.regionHint);
  if (args.route.channel) url.searchParams.set("channel", args.route.channel);

  return {
    src: url.toString(),
    store: {
      state: args.data,
    },
  };
}
```

建议固定支持以下 query 参数：

- `v`: 必填，播放器版本号或构建号
- `tenant`: 可选，租户标识
- `env`: 可选，环境标识
- `region`: 可选，仅调试或人工覆盖区域
- `channel`: 可选，灰度发布渠道

建议原则：

- 路由参数只放在入口 URL 上
- 播放器同步状态继续只放在 `store.state`
- 不要把路由逻辑塞进 `store.state`

---

## 方案 A：单一域名 + GeoDNS / GTM / CDN 调度

### 核心思路

白板中始终只同步一个固定业务域名，例如：

```text
https://plyr.example.com/index.html?v=2026.04.23&tenant=acme&env=prod
```

该域名背后通过 GeoDNS、GTM 或 CDN 的流量调度能力，把请求路由到不同区域源站或节点：

- 中国 -> 中国节点
- 亚洲 -> 新加坡节点
- 美洲 -> 美国节点
- 未命中 -> default 节点

区域真实资源可部署为：

```text
https://cn-origin.example.com/plyr/2026.04.23/index.html
https://sg-origin.example.com/plyr/2026.04.23/index.html
https://us-origin.example.com/plyr/2026.04.23/index.html
```

### 优点

- 不需要修改 `EmbeddedPage`
- 白板侧始终只有一个 `src`
- iOS / Web / fastboard-demo 接入保持一致
- 运维边界清晰
- 后续升级或回滚只调整调度层和区域源站

### 缺点

- 依赖 DNS / GTM / CDN 的基础设施能力
- 区域策略、健康检查、容灾切换需要运维体系支撑
- 中国节点部署还需要单独评估网络和合规条件

### 推荐实施方式

建议最小配置为：

- 一个稳定业务域名：`plyr.example.com`
- 三个区域池：`cn` / `sg` / `us`
- 每个池部署同一版本目录
- 每个池配置健康检查
- default 区域必须存在
- 只允许“同版本跨区域 fallback”

### 配置对象草案

```ts
type RegionalPool = {
  region: "cn" | "sg" | "us";
  origin: string;
  healthCheckUrl: string;
  priority: number;
};

type GeoRoutingRule = {
  match: "country" | "region";
  value: string;
  primaryRegion: "cn" | "sg" | "us";
  failoverRegions?: Array<"cn" | "sg" | "us">;
};

type GeoRoutingConfig = {
  hostname: string;
  defaultRegion: "sg" | "us";
  pools: RegionalPool[];
  rules: GeoRoutingRule[];
};
```

### 落地建议

- 第一阶段按大区切，不要一开始切得过细
- 中国单独走 `cn`
- 亚洲非中国先走 `sg`
- 美洲走 `us`
- 其他区域先跟 `sg` 或 `us`
- 所有区域节点必须部署同一版构建

### 适用时机

适合：

- 已经有 DNS / GTM / CDN 调度能力
- 想让白板侧完全不感知区域差异
- 想把问题尽量留在基础设施层解决

这是推荐的正式方案。

---

## 方案 B：单一 bootstrap URL，再由入口页跳转到区域页

### 核心思路

白板里仍然只同步一个固定入口 URL，但这个 URL 不直接是最终播放器页，而是一个 bootstrap 页，例如：

```text
https://embed.example.com/plyr/bootstrap.html?v=2026.04.23&tenant=acme&env=prod
```

bootstrap 页负责：

1. 解析 query 参数
2. 调用 resolver API 或本地规则
3. 得到最终区域页面地址
4. `location.replace(...)` 跳转到对应区域页

区域最终播放器页例如：

```text
https://cn-cdn.example.com/plyr/2026.04.23/index.html
https://sg-cdn.example.com/plyr/2026.04.23/index.html
https://us-cdn.example.com/plyr/2026.04.23/index.html
```

### 优点

- 不需要修改 `EmbeddedPage`
- 不依赖完整的 GeoDNS / GTM 能力，也能先落地
- 业务侧仍然只传一个 URL
- 后续可平滑切换到方案 A

### 缺点

- 多一次入口跳转或一次 resolver 请求
- bootstrap 自身需要高可用
- resolver 失败时需要良好的 fallback

### 推荐实施方式

优先级建议：

1. 如果入口网关支持，优先在边缘直接做 302/307 跳转
2. 如果没有边缘能力，就用 `bootstrap.html + /resolve API`

### resolver API 草案

请求：

```http
GET /plyr/resolve?v=2026.04.23&tenant=acme&env=prod&region=auto
```

响应：

```json
{
  "version": "2026.04.23",
  "region": "sg",
  "url": "https://sg-cdn.example.com/plyr/2026.04.23/index.html",
  "expiresInMs": 300000,
  "traceId": "a1b2c3"
}
```

### 接口对象草案

```ts
type BootstrapResolveRequest = {
  version: string;
  tenant?: string;
  env?: "prod" | "staging";
  regionHint?: "auto" | "cn" | "sg" | "us";
  channel?: string;
};

type BootstrapResolveResponse = {
  version: string;
  region: "cn" | "sg" | "us";
  url: string;
  expiresInMs: number;
  traceId?: string;
};
```

### bootstrap 页面逻辑草案

```ts
const params = new URLSearchParams(location.search);
const version = params.get("v") || "latest";
const tenant = params.get("tenant") || "";
const env = params.get("env") || "prod";
const regionHint = params.get("region") || "auto";
const channel = params.get("channel") || "";

const resolveUrl = new URL("/plyr/resolve", location.origin);
resolveUrl.searchParams.set("v", version);
resolveUrl.searchParams.set("tenant", tenant);
resolveUrl.searchParams.set("env", env);
resolveUrl.searchParams.set("region", regionHint);
if (channel) resolveUrl.searchParams.set("channel", channel);

const result = await fetch(resolveUrl.toString(), {
  credentials: "omit",
}).then(r => r.json());

location.replace(result.url + location.search + location.hash);
```

### 安全与稳定性建议

- bootstrap 页只允许跳转到白名单域名
- resolver API 尽量与 bootstrap 同域，减少 CORS 问题
- bootstrap 响应建议 `no-store` 或短 TTL
- 区域静态资源建议强缓存
- resolver 失败时必须有 fallback URL

### 适用时机

适合：

- 当前没有成熟的 GeoDNS / GTM / CDN 调度能力
- 需要快速上线
- 希望将来可以平滑升级到方案 A

这是推荐的过渡方案。

---

## 两种方案的关系

建议把方案 B 设计成方案 A 的前置阶段：

- 业务侧入口参数模型一致
- `store.state` 模型一致
- 版本号管理一致
- 区域部署目录一致

后续从方案 B 切换到方案 A 时，只需要把 `entryUrl` 从 bootstrap 页换成全局业务域名，不需要改白板业务层和播放器同步层。

---

## 推荐落地顺序

### 第一阶段

先规范统一业务接口：

- 统一 `entryUrl`
- 统一 `v / tenant / env / region / channel`
- 保持 `store.state` 不动

### 第二阶段

如果基础设施已准备好，直接落方案 A：

- 业务域名
- 区域池
- 健康检查
- fallback 规则

### 第三阶段

如果基础设施暂未准备好，则先落方案 B：

- bootstrap 页
- resolver API
- 区域静态资源目录

### 第四阶段

将方案 B 平滑升级到方案 A：

- 白板接入 helper 不变
- 只替换入口 URL

---

## 明确建议

最终建议如下：

- 正式生产方案：优先使用方案 A
- 短期过渡方案：使用方案 B
- 业务侧始终只传一个入口 URL
- 路由参数只通过 URL query 传递
- `store.state` 仅保留播放器业务同步状态

一句话概括：

- 方案 A：入口域名不变，由基础设施层决定访问哪个区域
- 方案 B：入口 URL 不变，由 bootstrap 页决定跳去哪个区域

---

## 风险提示

需要注意：

- 区域化 CDN 只能解决播放器页面本身的就近访问
- 如果媒体源是 YouTube，中国节点即使能加载播放器页，也不代表 YouTube 一定可播
- 这属于媒体源可达性问题，不属于 `EmbeddedPage` 或 `plyr-cdn` 区域路由问题

另外还要注意：

- 版本必须固定，不要让中国、新加坡、美国长期跑不同构建版本
- 所有区域节点都要有 fallback 策略
- resolver 或调度规则要有 traceId 或日志字段，方便排障

---

## 本项目建议后续动作

建议在 `plyr-cdn` 中补充：

1. 一个统一的 `entryUrl` 生成 helper
2. 版本号约定
3. 若采用方案 B，则新增：
   - `bootstrap.html`
   - resolver API 文档
4. 若采用方案 A，则补充一份：
   - 域名 / GTM / CDN 配置清单

