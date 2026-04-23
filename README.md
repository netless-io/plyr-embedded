# plyr-cdn

独立部署到 CDN 的 Plyr 播放器页面，运行在 `http/https` 环境下，通过 `@netless/app-embedded-page-sdk` 与白板内的 `EmbeddedPage` 同步状态。

## 目标

- 最终运行代码位于当前目录，而不是 `netless-app/packages/...`
- 页面可作为静态资源部署到 CDN
- 页面内部使用 `Plyr`
- 页面内部通过 `createEmbeddedApp()` 连接 `EmbeddedPage`
- 保留 `src / provider / type / poster / volume / muted / playTimeState / syncVolume / syncMuted / customControlsTitle / allowBackgroundPlayback / keepPlayerStateInSync` 等关键同步字段

## 本地开发

```bash
cd /Users/hongqiuer/work/plyr-cdn
pnpm install
pnpm dev
```

默认本地地址：

- 开发服务：`http://127.0.0.1:4173/`
- 预览服务：`http://127.0.0.1:4174/`

## 构建静态产物

```bash
cd /Users/hongqiuer/work/plyr-cdn
pnpm build
```

构建产物输出到：

`/Users/hongqiuer/work/plyr-cdn/dist`

`vite.config.ts` 里使用了 `base: "./"`，静态资源会以相对路径输出，便于直接上传到 CDN 任意目录。

## EmbeddedPage 初始化结构

实际初始化请按 `app-embedded-page` 源码行为传入：

```json
{
  "src": "https://cdn.example.com/plyr/index.html",
  "store": {
    "state": {
      "src": "https://www.youtube.com/watch?v=bTqVqk7FSmY",
      "provider": "youtube",
      "type": "",
      "poster": "",
      "useCustomControls": true,
      "volume": 1,
      "muted": false,
      "playTimeState": [true, 1713772800000, 1713772800000],
      "syncVolume": false,
      "syncMuted": false,
      "customControlsTitle": "Embedded Plyr",
      "allowBackgroundPlayback": true,
      "keepPlayerStateInSync": true
    }
  }
}
```

注意：

- 这里必须是 `attrs.store`
- 当前播放器页面实际读写的是主 store `state`
- `EmbeddedPage` 宿主内部的 `mainStoreId` 固定是 `state`
- 不要再用 README 里可能过时的 `attrs.state`
- 为了兼容原 `app-plyr` 配置习惯，页面也接受 `paused`、`currentTime`、`useCustomControls` 这类旧口径；内部会自动折算为 `playTimeState`

如果你不想在业务调用层每次都手写 `store.state` 这层，推荐在业务侧封一个 helper，把 `addApp` 入参保持成：

```ts
{
  src: "<player-page-url>",
  data: { ...播放器字段... }
}
```

然后在 helper 内部再映射成：

```ts
{
  src,
  store: {
    state: data,
  },
}
```

## 与 fastboard-demo 联调

`fastboard-demo` 里新增的调试入口会复用 `EmbeddedPage`，并允许输入播放器页面 URL。开发阶段可直接填写：

`http://127.0.0.1:4173/`

当你把当前目录的构建产物部署到 CDN 后，只需要把同一个入口里的页面 URL 改成 CDN 地址即可。
