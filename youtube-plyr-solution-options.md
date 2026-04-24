# YouTube + Plyr 接入方案说明

## 背景

当前讨论的目标不是“让白板主页面直接变成 YouTube 播放页”，而是在尽量不破坏现有白板链路的前提下，为客户提供可落地的 YouTube + Plyr 能力。

这里有两个前提需要先说明：

1. 白板主链路仍然应优先保持稳定。
2. YouTube 属于第三方平台媒体源，播放结果会受到其自身平台策略、登录态、代理出口和风控策略影响。

截至 2026-04-24，这次联调已经确认：

- 当前 `plyr-cdn` 已经可以作为独立 HTTPS 页面部署。
- `Whiteboard-iOS Example` 已经具备一条可运行的 `EmbeddedPage + plyr-cdn` 参考接入链路。
- YouTube 在某些代理 / VPN / 出口 IP 下会触发登录校验；切换代理后可恢复。

因此，本文档重点回答的是：

- 方案一和方案二分别是什么
- 各自适合什么场景
- 当前代码里已经落下了哪些实现
- 已知风险在哪里

---

## 两种方案

本文中的方案定义固定如下：

### 方案一

`EmbeddedPage + plyr-cdn`

即：

- 白板里仍然插入一个 app
- app 类型为 `EmbeddedPage`
- `EmbeddedPage` 内部加载独立部署的 `plyr-cdn` 页面
- `plyr-cdn` 页面内部再用 `Plyr + YouTube iframe API` 播放 YouTube

这条链路可以简化理解为：

`Whiteboard WebView -> EmbeddedPage iframe -> plyr-cdn -> YouTube iframe`

### 方案二

`独立 WKWebView + Plyr`

即：

- 不再依赖白板中的 `EmbeddedPage` 课件容器承载播放器
- 业务方在客户端自己打开一个独立的 `WKWebView`
- 在这个独立 WebView 中加载 Plyr 页面
- 与白板的同步逻辑由业务方自己管理

这条链路可以简化理解为：

`Native WKWebView -> your plyr page -> YouTube iframe`

---

## 当前代码状态

### `plyr-cdn` 当前已落盘能力

当前 `plyr-cdn` 已经具备以下能力：

- 页面入口声明了 `referrer` 策略  
  文件：`plyr-cdn/index.html`

- `YouTube` 配置支持显式透传：
  - `youtubeOrigin`
  - `youtubeWidgetReferrer`  
  文件：
  - `plyr-cdn/src/types.ts`
  - `plyr-cdn/src/state.ts`
  - `plyr-cdn/src/controller.ts`

- 自定义控制条的 `play / mute` 已从 `click` 改为 `pointerup`  
  文件：`plyr-cdn/src/controller.ts`

- YouTube layout fix teardown 通道已存在  
  文件：`plyr-cdn/src/controller.ts`

也就是说，`plyr-cdn` 现在不只是一个“静态播放器页”，它已经开始承载：

- 嵌入身份透传
- Apple 端交互兼容
- iOS 偏移修复的配合能力

### `Whiteboard-iOS Example` 当前接法

`Whiteboard-iOS Example` 当前已经有一条方案一参考实现：

- 本地注册 `EmbeddedPage` JS，而不是继续依赖远端 CDN 注册  
  文件：
  - `Whiteboard-iOS/Example/Whiteboard/WhiteRoomViewController.m`
  - `Whiteboard-iOS/Example/Whiteboard/WhiteCustomAppViewController.m`

- 本地 `EmbeddedPage` iframe 已补齐：
  - `sandbox`
  - `allow`
  - `referrerPolicy`  
  文件：`Whiteboard-iOS/Example/Whiteboard/embedPage.iife.js`

- 白板 bridge 页已经补充 `meta referrer`  
  文件：`Whiteboard-iOS/Whiteboard/Resource/index.html`

- 在 YouTube 场景下，iOS Example 会显式把播放器身份透传为：
  - `youtubeOrigin = https://<bundle-id>`
  - `youtubeWidgetReferrer = https://<bundle-id>`  
  文件：
  - `Whiteboard-iOS/Example/Whiteboard/WhiteRoomViewController.m`
  - `Whiteboard-iOS/Example/Whiteboard/WhiteCustomAppViewController.m`

因此，`Whiteboard-iOS Example` 现在已经不是“纯概念验证”，而是方案一在 iOS 上的参考实现。

---

## 方案一：EmbeddedPage + plyr-cdn

### 方案说明

方案一的目标是：

- 不改动白板主链路
- 继续复用白板 app / EmbeddedPage 体系
- 把 YouTube 播放能力隔离在独立部署的 HTTPS Plyr 页面中

这条方案的核心结构是：

1. 白板创建 `EmbeddedPage` app
2. `EmbeddedPage` 的 `attributes.src` 指向独立部署的 `plyr-cdn` 页面
3. `store.state` 承载播放器同步状态
4. `plyr-cdn` 页面内部通过 `Plyr + YouTube iframe API` 播放

推荐的状态结构至少包括：

```ts
type EmbeddedPlyrStore = {
  src: string;
  provider?: "youtube" | "vimeo";
  type: string;
  poster: string;
  youtubeOrigin?: string;
  youtubeWidgetReferrer?: string;
  useCustomControls: boolean;
  volume: number;
  muted: boolean;
  playTimeState: [false, number] | [true, number, number];
  syncVolume: boolean;
  syncMuted: boolean;
  customControlsTitle: string;
  allowBackgroundPlayback: boolean;
  keepPlayerStateInSync: boolean;
};
```

其中：

- `src / provider / type` 属于媒体源信息
- `playTimeState / volume / muted` 属于同步状态
- `youtubeOrigin / youtubeWidgetReferrer` 属于 YouTube 身份透传信息

### 优点

- 最贴近现有白板 app 体系
- 可继续使用 `EmbeddedPage` 的同步模型
- 白板内联动成本相对较低
- `Whiteboard-iOS Example` 已有可运行参考实现
- Web 侧和 iOS 侧更容易统一行为

### 风险与注意事项

- 存在多层 iframe 嵌套
- YouTube 在 WebView / 嵌套 iframe 场景下更容易触发风控
- 这条链路里变量较多：
  - 宿主页协议
  - iframe sandbox
  - referrerPolicy
  - origin
  - widget_referrer
  - 代理出口
  - 登录态

也就是说，方案一的主要成本不一定是“开发成本”，更多是“联调复杂度和环境敏感性”。

### 当前已做的兼容动作

为了让方案一在 iOS 上更稳定，当前已经做了这些补丁：

- `EmbeddedPage` iframe 补齐 `sandbox / allow / referrerPolicy`
- bridge 页补 `meta referrer`
- `plyr-cdn` 支持显式透传 `youtubeOrigin / youtubeWidgetReferrer`
- iOS Example 在 YouTube 场景下用 `bundle id` 形式透传 App identity
- `plyr-cdn` 自定义控件改成 `pointerup`

因此，方案一当前并不是“裸奔接入”，而是已经带有一层专门为 iOS / WebView 场景做的加固。

### 适用场景

- 客户希望尽量复用白板现有 app 能力
- 客户希望播放器仍然在白板内工作
- 客户可以接受在代理、设备、系统版本、YouTube 风控之间做更多验证

---

## 方案二：独立 WKWebView + Plyr

### 方案说明

方案二的目标不是“绕过 YouTube 风控”，而是：

- 缩短链路
- 提高容器可控性
- 为业务方自己实现同步协议提供空间

这条方案中：

- 业务侧自己打开一个独立的 `WKWebView`
- 直接加载自己的 Plyr 页面
- 与白板之间的同步不再依赖 `EmbeddedPage` 的 `store.state`
- 而是由业务方自己定义 JS bridge / Native 协议

和方案一相比，最大的变化是：

- 不再依赖白板里的 `EmbeddedPage` iframe 承载播放器
- 宿主从“白板 app 容器”变成“你自己的原生 WebView 容器”

### 优点

- 容器更可控
- 链路更短
- 更适合业务方做独立同步
- 更适合精细控制：
  - `play / pause / seek / currentTime`
  - WebView 生命周期
  - 播放器窗口开关
  - JS 注入与桥接

### 风险与注意事项

- 同步能力需要业务方自己做
- 不能直接复用 `EmbeddedPage` 的现成同步模型
- 原生层要自己维护播放器页面的生命周期
- 和白板之间的联动协议、窗口管理、恢复策略都需要业务方承担

另外要明确：

- 方案二解决的是“容器可控性”和“同步能力”
- 它不天然解决 YouTube 的平台风控

也就是说，如果某条代理出口会被 YouTube 判为高风险，方案二也仍然可能失败，因为这类问题并不由嵌入层单独决定。

### 适用场景

- 客户更关注长期可维护性
- 客户需要对播放器内部状态做独立同步
- 客户能够接受额外的原生和桥接开发工作

---

## iOS 偏移问题说明

本次联调中，iOS 侧还排查到一个和 YouTube iframe 渲染有关的问题：  
某些场景下，YouTube 内部 `<video>` 的尺寸和位置会发生异常，表现为：

- 视频本身已经开始播放或可交互
- 但 `<video>` 实际渲染位置和 `.html5-video-player` 容器不一致
- 看起来像“画面偏移”或“位置错误”

为此，`Whiteboard-iOS` 当前加入了一段专门的修正脚本：

- 方法：`installYouTubeIframeLayoutFixScript`
- 文件：`Whiteboard-iOS/Whiteboard/Classes/Displayer/WhiteBoardView.m`

这段脚本的工作方式大致是：

1. 只在 YouTube embed 页面中启用
2. 观察：
   - `player` 容器尺寸
   - `video` 元数据
   - `resize`
   - DOM 变化
3. 计算期望的视频显示区域
4. 当检测到实际视频位置和期望值偏差过大时，主动修正：
   - `width`
   - `height`
   - `left`
   - `top`

同时，`plyr-cdn` 侧也已经配合增加了 teardown 通道：

- `notifyYouTubeLayoutFixTeardown`
- 文件：`plyr-cdn/src/controller.ts`

它的作用是：

- 当播放器被销毁或页面切换时，通知 YouTube 内页上的 layout fix 停止工作
- 避免旧的观察器和定时器继续残留

### 这段修复脚本的定位

需要强调：

- `installYouTubeIframeLayoutFixScript` 解决的是“iOS / WKWebView 下 YouTube 画面偏移”
- 它不解决：
  - 登录校验
  - BotGuard
  - 代理出口风控
  - 媒体源不可达

所以在排障上，它属于：

- 画面布局问题修复

而不是：

- 身份问题修复

---

## 已确认风险：代理 / VPN / 出口 IP

本次联调已经确认一个非常关键的风险：

- 在某些代理 / VPN / 出口 IP 下，YouTube 会要求先登录账号
- 这个现象不仅出现在 `Whiteboard-iOS + EmbeddedPage + plyr-cdn`
- 在 Safari 中直接打开同一个 YouTube 分享链接，也可能出现同样问题
- 切换代理后可恢复正常播放

这说明：

- 问题首先是 YouTube 对网络出口的风控
- 其次才是 WebView 或嵌入参数问题

因此要明确一个边界：

- `widget_referrer`
- `origin`
- `referrerPolicy`
- `sandbox`

这些调整有帮助，但都不能保证绕过第三方平台风控。

### 排障优先级建议

遇到 YouTube 无法播放时，建议按以下顺序排查：

1. 先验证网络环境
   - 是否开了代理 / VPN
   - 是否使用高风险出口 IP
   - 是否切换网络后恢复
2. 再验证 YouTube 本身
   - Safari 是否能直接打开同一视频
   - 是否要求登录
3. 再看嵌入参数
   - `origin`
   - `widget_referrer`
   - `referrerPolicy`
4. 最后再看播放器代码或白板容器问题

### 对产品方案的影响

这意味着：

- `mp4 / m3u8 / mp3 / webm` 仍然是可控媒体源
- `YouTube` 始终属于第三方平台媒体源
- 第三方平台策略、地区、出口 IP、匿名访问风控，都可能让“同一套代码、不同网络环境”出现不同结果

因此：

- 方案一更适合做“白板内联动”
- 方案二更适合做“业务方自己掌控同步”
- 但两者都要接受 YouTube 本身的网络和风控风险

---

## 两种方案的对比

| 对比项 | 方案一：EmbeddedPage + plyr-cdn | 方案二：独立 WKWebView + Plyr |
| --- | --- | --- |
| 简单接入 | 高 | 低 |
| 白板内联动便利性 | 高 | 低 |
| 定制能力 | 中 | 高 |
| 天然同步支持 | 高 | 低 |
| 播放器链路稳定性 | 中 | 高 |
| 链路复杂度 | 高 | 低 |
| 快速验证效率 | 高 | 低 |

补充说明：

- `代理 / VPN / 出口 IP` 风险不应作为两种方案的主要差异项。
- 当前验证结果表明，Safari 里直接打开同一 YouTube 分享链接，在同一代理出口下也可能要求登录。
- 因此这类风险对两种方案都成立，本质上属于 YouTube 平台对网络出口的风控，而不是某一方案独有的问题。

---

## 建议

如果客户目标是：

### 1. 尽快上线、尽量少改白板

优先走方案一：

- `EmbeddedPage + plyr-cdn`
- 继续复用现有白板 app 模型
- 在业务和联调上接受多层 iframe 与环境敏感性

### 2. 长期做独立播放器同步

优先规划方案二：

- 自己掌控 `WKWebView`
- 自己定义 JS bridge
- 把同步协议掌握在业务方手里

但无论哪条方案，都建议接受同一个现实：

- YouTube 不是稳定可控的第一方媒体源
- 对代理、网络出口、登录态和平台策略都敏感

---

## 结论

最终可以这样理解：

- 方案一解决的是“尽量复用白板体系，在白板内嵌播放”
- 方案二解决的是“把播放器控制权拿回来，方便业务方独立同步”
- `installYouTubeIframeLayoutFixScript` 解决的是“iOS 上的画面偏移问题”
- 代理 / VPN / 出口 IP 风险则是两种方案都必须面对的外部风险

因此，建议客户根据目标来选：

- 如果先要跑通业务演示和白板内联动，选方案一
- 如果最终目标是播放器内部状态完全可控，选方案二

但不管选哪条路，都应把“代理出口导致 YouTube 登录校验”视为一个明确的接入风险写入评估。
