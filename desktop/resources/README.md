# 品牌资源（app icon）

pith 的应用图标:「脉络 / 橘络」分叉网(设计稿 LogoMark variant 6)，红 on 黑
(`#ff5247` on `#0e0e10`)，圆角方块 tile。1:1 来自 `design/pith-wiki-logo`。

| 文件 | 用途 |
|---|---|
| `icon.svg` | 矢量母版(完整纤维网)。改图标改这里，其余从它重出。 |
| `icon.png` | 1024 栅格(透明圆角)。**运行时 dock 图标**(`main/index.ts` 的 `app.dock.setIcon`)。 |
| `icon.icns` | macOS 打包图标。小尺寸(≤32)用简化版 variant 7、大尺寸用完整版(按设计稿尺寸规范)。 |

渲染层 favicon 用简化版:`../src/renderer/favicon.svg`。
应用内 React 组件见 `../src/renderer/src/Logo.tsx`(`LogoMark` / `LogoLockup`)。

## dock 图标怎么生效

- **dev(未打包，`npm run dev` / `npx electron .`)**:dock 默认是 Electron 图标，
  必须运行时 `app.dock.setIcon(icon.png)` 才会变 —— 已在 `src/main/index.ts` 接好。
  **改完图标要重启 app**(重建 main + 重新启动)才看得到。
- **打包**:目前仓库**未配置 electron 打包**。接 electron-builder 时:
  ```jsonc
  // package.json 或 electron-builder 配置
  "build": {
    "mac":   { "icon": "resources/icon.icns" },
    "win":   { "icon": "resources/icon.png" },
    "linux": { "icon": "resources/icon.png" },
    "extraResources": ["resources/icon.png"]   // 让运行时 process.resourcesPath 也能找到
  }
  ```

## 从母版重新生成(改了 icon.svg 后)

`icon.svg` 是**满幅**矢量母版(圆角方块顶到边)。栅格化时按 **macOS 图标网格**留白:
圆角方块只占画布约 **80.5%**(1024 → 824 内容 + 透明边距),否则 dock 里会显得比别的 app
大一圈。圆角比 22.5% 已与 Apple 一致。

```bash
cd desktop/resources
# 主 PNG（dock setIcon + 打包）：缩到 80.5% 居中、四周透明留白
pad() { inner=$(awk "BEGIN{printf \"%d\", $1*0.805}");
  magick -background none -density 1100 "$2" -resize ${inner}x${inner} \
    -background none -gravity center -extent ${1}x${1} "$3"; }
pad 1024 icon.svg icon.png
# icns：小尺寸(≤32)用 favicon.svg(简化版)、大尺寸用 icon.svg，全部同样留白，
# 切 16/32/64/128/256/512/1024 档 → iconutil -c icns icon.iconset -o icon.icns
```

> 注意：flatten 过的 SVG（无 `rotate(a cx cy)`）才能被 ImageMagick 正确栅格化——
> magick 的 SVG 引擎不处理绕点旋转，几何已在 `icon.svg`/`favicon.svg` 里拍平成绝对坐标。
