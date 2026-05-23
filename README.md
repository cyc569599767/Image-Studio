# Image Studio

> 一个开源的图像生成 / 编辑桌面客户端 ·
> 两种 API 形态可选(**SSE 流式保活** 兼容 Cloudflare 524/504 · 或标准 **Images API**)·
> Wails(Go + React/TS)

![license](https://img.shields.io/badge/license-MIT-7c3aed)
![go](https://img.shields.io/badge/go-%3E%3D1.25-00ADD8)
![react](https://img.shields.io/badge/react-18-61DAFB)
![wails](https://img.shields.io/badge/wails-v2-DF0000)
![platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-lightgrey)

---

<p align="center">
  <img src="./docs/screenshot.png" alt="Image Studio 主界面" width="880">
  <br />
  <sub>左侧:控制面板(模式 / prompt / 风格 / 比例 / 质量) · 中:画板 + 工具栏 + 状态栏 · 右:历史记录</sub>
</p>

> **v0.1.2** 重塑了整套 UI:Tailwind v4 + lucide-react 图标,字体 HarmonyOS Sans SC Medium + JetBrains Mono;每日一言条幅、动态画板棋盘格、白底黑线条新图标;输出目录拆分 `/images/` + `/log/`;Responses API 加「不优化提示词」开关让模型逐字使用你的 prompt。
>
> **v0.1.3** 新功能:比例与质量都加 **Auto** 档让上游决定;高级参数加 **输出图片格式**(PNG / JPEG / WebP);画笔/橡皮/自由画笔 **逐点跟手**(修了 react-konva 数组引用 bug);**旋转 / 翻转 / 裁剪改为就地编辑**,不再每点一次就刷一条历史。底栏数据改为 `今日已生图 / 总生图`。
>
> **v0.1.5** 起前端主题层按平台抽象:macOS 保留现有 Apple 风格;Windows 新增独立 Fluent 风格 token 与控件外观;Android 手机 / Pad 使用独立 Material 3 前端。主逻辑不改,通过平台检测或构建模式切换原生主题。

---

## 为什么写这个

大多数 OpenAI 兼容中转站把图像生成接口架在 Cloudflare 后面,而 image-2 / gpt-image 这种模型推理需要 30~120 秒。一旦超过 CF 的 100s 默认网关超时,连接被切断 → 客户端收到 524/504 → 整张图作废。

常见后果:你点了「生成」,等 100 秒,然后看到 `Cloudflare Error code 524 · A timeout occurred`,再等几分钟再试,大概率重复。

**核心解法:用 `/v1/responses` + SSE 流式协议**(Responses API 模式):
- 模型边推理边发心跳事件(`response.in_progress` / `image_generation_call.generating` / `partial_image` ...),保持 TCP 连接活跃,CF 看到流量就不会断
- 即使真的被掐了,本地有 3 次自动重试 + 15 秒 backoff
- 收到 `partial_image_b64` 也会兜底保存,作为「半成品」给你看效果

**对于不支持 Responses API 的中转站**(或 key 只绑了标准 image 分组的情况),也支持原生 Images API 模式:
- POST `/v1/images/generations`(文生图,JSON)+ `/v1/images/edits`(图生图,multipart 上传)
- 一次性 JSON 响应,无 SSE 保活;长推理 CF 524 风险更高,但兼容性最广
- 同样有 3 次自动重试

两种模式可在「🔧 上游配置」里切换,使用同一套 UI 和文件落地逻辑。

最初是个 Python CLI 脚本(`generate_gptcodex_image.py`),后来重写为 Go,再封装成 Wails 桌面应用,补全了画板、蒙版、多参考图、撤销重做、历史对比、多标签页等图像编辑器该有的能力。

---

## 核心亮点

| | |
|---|---|
| 🛡 **SSE 流式保活**(Responses API) | 用 `/v1/responses` 接口,以 Server-Sent Events 持续从上游接收事件,Cloudflare/Nginx 网关看到持续流量不会判定为空闲超时 —— **CF 524 推荐这个** |
| 🔀 **双 API 形态** | 一个 toggle 在 Responses API(SSE 保活,需 gpt-5.5 分组)和 Images API(标准 `/v1/images/generations` + `/v1/images/edits`,可用 image-2 分组)间切换 |
| 🔁 **自动重试 + 部分结果回退** | 识别 Cloudflare 524/504、JSON `status` 5xx、`retryable=true` 自动重试 3 次;Responses 模式下 final result 没拿到时用最后的 `partial_image_b64` 兜底 |
| 📦 **大 base64 单行缓冲** | `partial_image_b64` 单行可超 4MB,自定义 8MB scanner buffer,不会被 Go bufio 默认的 64KB 截断 |
| 🔌 **双 transport** | 默认 net/http 直连;遇到 TLS 指纹 / 代理问题可一键切到子进程 `curl`(`--http1.1 --ssl-no-revoke`) |
| ⏹ **真正可取消** | `context.Context` 端到端,包括 `exec.CommandContext` 给 curl,「取消」按钮能立刻中断 in-flight 请求 |
| 🖼 **完整图像编辑器** | Konva 画布、蒙版+橡皮、4 种标注、旋转/翻转/裁剪(就地编辑不污染历史)、历史对比 |
| 🧩 **多标签 workspace** | 浏览器风的多 tab,每个独立 prompt/参数/源图;切换不丢现场 |
| 🔧 **首次启动引导** | apiKey / baseURL 缺失时自动弹「上游配置」窗口,5 字段一次填完(API 形态、BASE_URL、API Key、文本模型、图像模型) |
| ✏️ **不优化提示词开关** | Responses API 默认让文本模型把你的 prompt 重写一遍。勾上后顶层加 instructions 让模型逐字使用,适合已经精修过的 prompt |
| 🪟 **首次启动配置 + 详情抽屉** | 生成成功后的 toast 带「查看详情」按钮,弹出右抽屉显示图片预览 + 全部参数 + 原/优化版 prompt + 文件路径,可一键复制 / 用作下次 prompt |
| 🎨 **现代 UI**(v0.1.2) | Tailwind v4 + Apple 风格的浅深色语义 + lucide-react 图标;HarmonyOS Sans SC Medium 中文字体 + JetBrains Mono 等宽数字;暗色启动无白闪 |
| 💾 **100% 本地数据** | 无遥测、无云端账户、无内购;API key、历史、生成图都在你的机器上 |

---

## 安装

### 方式 1:下载预编译版本(推荐)

到 [Releases](https://github.com/RoseKhlifa/Image-Studio/releases) 页面下载对应平台的预编译版本(均内嵌 HarmonyOS Sans SC Regular + Medium + JetBrains Mono):

| 平台 | 产物 | 大小 | 首次启动 |
|---|---|---|---|
| **Windows x64** | `image-studio-windows-amd64.exe` | ~29 MB | 双击运行;需 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)(Win10+ 大部分已预装) |
| **macOS** (universal) | `image-studio-macos-universal.zip` | ~32 MB | 解压后 `xattr -dr com.apple.quarantine image-studio.app` 去 Gatekeeper 隔离,或右键 → 打开 |
| **Linux x64** | `image-studio-linux-amd64.tar.gz` | ~16 MB | `tar -xzf` 解压 → `chmod +x image-studio` → 运行;需 `libgtk-3-0 libwebkit2gtk-4.1-0`(桌面 Ubuntu 22.04+ / 24.04 默认装好) |
| **Android Pad 前端包** | `image-studio-android-pad-frontend.tar.gz` | 前端静态资源 | 供 Android 平板壳层集成,使用 Material 3 自适应大屏布局 |

> Wails v2 不支持跨平台编译,以上三个产物分别在各自原生平台上 build。代码本身跨平台,有问题欢迎 issue。

### 方式 2:从源码构建

```bash
# 环境要求
#  - Go >= 1.25
#  - Node >= 20
#  - Wails CLI v2:  go install github.com/wailsapp/wails/v2/cmd/wails@latest

git clone https://github.com/RoseKhlifa/Image-Studio.git
cd Image-Studio/image-studio

# 开发模式(Vite 热重载 + DevTools)
wails dev

# 生产构建,输出到 build/bin/image-studio.exe (~29MB,内嵌字体 + Tailwind 资源)
wails build
```

前端主题也支持单独按平台预览/构建,方便你在不切系统的情况下检查原生主题:

```bash
cd image-studio/frontend

# 默认:按当前运行平台自动识别
npm run dev

# 强制预览某个平台主题
npm run dev:macos
npm run dev:windows
npm run dev:linux
npm run dev:android
npm run dev:android-pad

# 强制按某个平台主题打包前端静态资源
npm run build:macos
npm run build:windows
npm run build:linux
npm run build:android
npm run build:android-pad
```

这些命令只切换主题层(`VITE_TARGET_PLATFORM`),不会修改业务逻辑和数据流。
默认的 `npm run dev` / `npm run build` 现在也会按宿主平台自动选择 `macos` / `windows` / `linux` 主题模式,所以 `wails dev` 和 `wails build` 不需要额外参数就会编译出对应客户端的原生主题。

### 多端原生主题

- **macOS**:保留现有 Apple 风格,使用 SF 系排版、较大圆角、玻璃态工具栏
- **Windows**:单独的 Fluent 风格主题,使用 Segoe 系排版、较紧凑控件、较小圆角、Mica 风格分层表面
- **Linux / 其他**:走通用主题分支,避免强行伪装成某个平台
- **Android 手机**:`android` 目标使用 Material 3 紧凑布局,底部导航切换 参数 / 画布 / 历史,保存优先走 Android 壳层 bridge,缺失时回退系统分享/下载
- **Android Pad**:`android-pad` 目标使用 Material 3 大屏布局,navigation rail + 三栏自适应,保留 Android 运行时语义和保存差异

运行时前端会自动给根节点注入 `data-platform` / `data-target-platform` / `data-ui-family`,CSS token 和组件壳层按这些属性切换,因此平台主题和 Android 手机/Pad 布局可以继续扩展,而不需要动生成、画布、历史等主逻辑。

macOS 直接 `wails build`(产物 `image-studio.app`,通用二进制 Apple Silicon + Intel)。Linux 需要先装 `libgtk-3-dev libwebkit2gtk-4.1-dev`(Ubuntu 24.04 / 桌面 Debian 同款)然后 `wails build -tags webkit2_41`;22.04 系是 `libwebkit2gtk-4.0-dev`,直接 `wails build` 不加 tag。

---

## 快速上手

首次启动会自动弹出**「上游配置」窗口**(也可以从左侧「🔧 上游配置」按钮随时呼起):

1. **API 形态** —— 二选一:
   - **Responses API**(CF 超时推荐):SSE 保活,长推理稳;**key 要绑「拥有 gpt-5.5 模型的分组」**
   - **Images API**:标准 `/v1/images/generations` + `/v1/images/edits`,**key 用标准 image-2 分组**即可
2. **上游 BASE_URL** —— 你自己的中转站地址(应用不内置任何默认上游)
3. **API Key** —— `sk-...`,绑定到上面对应的分组
4. **文本模型 ID** —— 仅 Responses API 需要,默认 `gpt-5.5`,可留空
5. **图像模型 ID** —— 默认 `gpt-image-2`,可留空。两种 API 形态都会用到
6. (可选)点 **「🔌 测试连接」** 验证一下

填好保存后:

7. 选模式(📝 文生图 / 🖼 图生图),输入 prompt(下方可选模板/历史),选风格 / 比例 / 质量
8. 如果你已经精修过 prompt 不想被模型再优化一遍,勾上 prompt 输入框下的 **「不优化提示词」**(仅 Responses API 模式有效)
9. 按 `⌘ + Enter`(macOS) / `Ctrl + Enter`(Windows/Linux) 或点击 **「生成」**
10. 生成成功后右上角 toast 会带「查看详情」按钮,弹出右抽屉显示全部参数 + 原/优化版 prompt + 文件路径

图生图流程:
- 拖入本地图片到窗口 / `⌘V`(macOS) 或 `Ctrl+V` 粘贴 / 「+ 添加图片」按钮 → 累积参考图列表
- 切到「图生图」模式 → 写修改要求 → 生成

---

## API 形态 · 分组怎么选

> 本应用 **不内置任何默认上游**,首次启动会弹「上游配置」让你自己填。

### Responses API 模式(默认,CF 超时推荐)

调用的是上游 `/v1/responses`,通过模型内置的 `image_generation` 工具触发图像生成,SSE 流式接收。

- ✅ Key 绑定到**拥有 `gpt-5.5` 模型的分组**(中转站后台通常叫「余额分组」或「套餐分组」)
- ❌ **不要**选「image-2 分组」 —— 那是直接 image API 的分组,不包含 gpt-5.5,会返回 401/403 或 `model not found`
- 兼容性:任何提供 Responses API + `image_generation` 工具的中转站

### Images API 模式(兼容广)

调用的是标准 `/v1/images/generations`(文生图,JSON)和 `/v1/images/edits`(图生图,multipart 上传)。

- ✅ Key 用标准的 **image-2 / image API 分组**即可,**不需要 gpt-5.5 权限**
- 适合 key 只绑了 image 分组、或上游不支持 Responses API 的中转站
- 缺点:没有 SSE 保活,长推理 CF 524 风险更高

### 共用约束

- **不兼容**只提供 `/v1/chat/completions` 的中转站(本应用不发 chat completions 请求)
- 设置 → 「🔧 上游配置」可随时切换形态、改 BASE_URL / 模型 ID

---

## 完整功能

### 生成
- 文生图 / 图生图(支持多张参考图,可拖动重排顺序)
- 输入图源:文件对话框 / 拖拽窗口 / `⌘V`(macOS) 或 `Ctrl+V` 粘贴 / 从历史复用 / 双击历史项
- 参数:**Auto + 5 种比例**(1:1 / 2:3 / 3:2 / 16:9 / 9:16)· **Auto + 3 档质量**(1K/2K/4K)· **输出格式**(PNG/JPEG/WebP)· seed · negative prompt · 5 种风格 chip
- **不优化提示词** 开关:Responses API 模式下勾上后顶层加 instructions 让模型逐字使用 prompt
- **双 API 形态**:Responses API(SSE 保活)/ Images API(标准 generations + edits)随时切换
- 上游可配:BASE_URL、文本模型 ID、图像模型 ID、传输通道(native/curl)
- prompt 历史(自动去重,cap 50)+ 8 个内置模板(写实/二次元/水彩/像素等)

### 画板(Konva)
- 缩放(鼠标滚轮以指针为中心)/ 拖动 / 双击 fit ↔ 100%
- **蒙版**:画笔 + 橡皮,大小滑块,实时半透明叠加
- **标注**:矩形 / 箭头 / 自由画笔 / 文字,8 色,选中后 Delete 删除
- **图变换**(后端 Go image 库):旋转 90°/-90°、水平/竖直翻转、矩形选区裁出 —— 就地编辑当前画布图、**不创建新历史条目**,「另存为」拿到最新版本
- **历史对比**:Shift+点击进入,左右分屏 + 中间可拖动 split bar
- 全屏 `⌃⌘F`(macOS) / `F11`(Windows/Linux),隐藏左右栏专注画板

### 历史
- IndexedDB 持久化(浏览器存储,无服务器)
- 搜索 prompt / 筛选 mode / 筛选日期(今天/本周/全部)
- **右键菜单**:复制 prompt / 复制本地路径 / 查看 raw 响应 / 设为源图 / 用作对比 / **以此参数重新生成** / **应用参数(不生成)**
- JSON 导入 / 导出(跨设备迁移)

### 工作流
- **多 workspace 标签页**:每个独立 prompt / 参数 / 源图 / 当前图;macOS 下 `⌘N` 新建、`⌘W` 关闭,Windows/Linux 下 `Ctrl+N` / `Ctrl+W`
- 切换 tab 自动按 prompt 前 18 字命名
- 撤销 / 重做统一 timeline:蒙版笔触、标注、清空都在栈里
- `⌘C` / `⌘V`(macOS) 或 `Ctrl+C` / `Ctrl+V`(Windows/Linux) 复制当前图到剪贴板 / 粘贴
- 错误 banner 可关闭 + 「↻ 重试上次请求」
- **Toast** 通知(成功 / 错误 / 警告)+ **系统通知**(窗口失焦时生成完成弹 Windows toast)
- 进度估算(基于最近 5 次耗时滚动平均)

### 设置
- **🔧 上游配置**:首次启动自动弹出 / 之后可手动呼起;5 字段集中管理(API 形态 / BASE_URL / API Key / 文本模型 ID / 图像模型 ID),含 API Key 显示切换 + 内嵌测试连接按钮
- 主题:深色 / 浅色
- 字号:小 / 中 / 大
- 网络通道:auto / native / curl(应对 TLS 指纹 / 代理问题;curl 模式不再把 API Key 暴露到命令行参数)
- 参数预设保存(尺寸 + 质量 + 输出格式 + 风格,常用配置一键应用)
- 历史导入 / 导出 JSON
- 清除 API Key / 清空历史
- 关于:版本号、MIT 协议链接、GitHub 仓库 / Issues 一键跳转
- **字体**:UI 用 HarmonyOS Sans SC(中文)+ JetBrains Mono(英文 / 数字 / 等宽),已嵌入 exe 免下载

---

## 键盘快捷键

| 快捷键 | 功能 |
|---|---|
| `⌘` + `Enter`(macOS) / `Ctrl` + `Enter`(Windows/Linux) | 提交生成(textarea 内也能用) |
| `⌘N` / `⌘W`(macOS) · `Ctrl` + `N` / `Ctrl` + `W`(Windows/Linux) | 新建 / 关闭 workspace 标签 |
| `⌘Z` / `⇧⌘Z`(macOS) · `Ctrl` + `Z` / `Ctrl` + `Shift` + `Z` / `Ctrl` + `Y`(Windows/Linux) | 撤销 / 重做 |
| `⌘C`(macOS) / `Ctrl` + `C`(Windows/Linux) | 复制当前画板图到剪贴板 |
| `⌘V`(macOS) / `Ctrl` + `V`(Windows/Linux) | 粘贴剪贴板图到画板(进入图生图) |
| `1` / `2` / `3` | 切换 拖动 / 蒙版 / 标注 工具 |
| `空格` | 按住临时切到拖动 |
| `F` | 重置视图(适配窗口) |
| `双击画板` | fit ↔ 100% 切换 |
| `⌃⌘F`(macOS) / `F11`(Windows/Linux) | 全屏模式 |
| `[` / `]` | 笔刷大小 −/+ 5 |
| `Esc` | 取消生成 → 退出对比 → 清除选中 → 关闭错误 |
| `Delete` | 删除选中的标注 |
| `Shift` + 点击历史 | 设为对比图 B |
| `双击` 历史 | 作为源图 |
| `右键` 历史 | 上下文菜单 |

---

## 数据存储位置

| 类型 | 位置 |
|---|---|
| API Key | 系统安全存储(Keychain / Credential Manager / Secret Service) |
| 上游配置(API 形态、BASE_URL、模型 ID、传输通道) | `localStorage` |
| 历史记录元数据 | 本地 IndexedDB |
| 生成的 PNG | 桌面端在输出目录下的 `images/`(命名形如 `image-generate-<slug>-<ts>.png`);Android 端由壳层保存到 MediaStore/Pictures,无壳层时走浏览器下载或系统分享 |
| 拖入 / 变换的图 | 系统 config 目录下的 `image-studio/imports/`(内部 scratch,与输出目录解耦) |
| 原始上游响应(排错用) | 输出目录下的 `log/`:Responses 模式 `sse-response-*.txt`;Images 模式 `images-response-*.json`(v0.1.2 起从 `images/` 拆出,避免污染图片浏览) |
| 用户偏好(主题、字号、预设、prompt 历史) | `localStorage` |

**输出目录默认值(v0.1.4 起按平台区分)**:

| 平台 | 默认输出目录 |
|---|---|
| Windows | `%APPDATA%\image-studio\` |
| macOS | `~/Pictures/Image Studio/` |
| Linux | `~/Pictures/Image Studio/` |
| Android 手机 | 系统下载 / 分享面板 / 壳层 MediaStore |
| Android Pad | 应用图片目录 / MediaStore Pictures |

> 之所以不沿用 macOS / Linux 的 `~/Library/Application Support/` 或 `~/.config/`:这两个目录默认被 Finder / 文件管理器隐藏,点「打开输出目录」相当于黑盒 —— 既看不到也没法直接管理图片。改走 `Pictures` 目录后,生成的 PNG 在系统图库里立即可见。设置 →「输出目录 / 修改」可以随时换到自己想要的路径。

Android 保存逻辑与桌面端不同:前端会优先调用壳层注入的 `window.AndroidImageStudio.saveImage(imageB64, suggestedName)` / `openOutputDir()` / `exportHistory()`;如果壳层未注入这些方法,手机版和 Pad 版会回退到 Web Share API 或下载链接,不会弹桌面式 `SaveFileDialog`。

数据完全不出本地;唯一的外部网络请求是向你配置的上游 BASE_URL 发起的生成请求本身。

---

## 故障排除

### 一直 524 / 504

- 上游网关超时在很多中转站很常见。本应用自动重试 3 次,如果都失败:
  - **如果当前是 Images API 模式,优先切到 Responses API** —— SSE 保活就是为此设计的(前提是你的 key 有 gpt-5.5 分组权限)
  - 检查 key 是否过期 / 余额 / 是否绑对了分组(见上方 [API 形态 · 分组怎么选](#api-形态--分组怎么选))
  - 设置 → 网络通道 改成 `curl`,有时能绕过原生 HTTP 的 TLS 指纹问题;此模式已改为通过私有配置文件传 header,不会把 API Key 放进进程参数
  - 历史项 右键 → **查看 raw 响应**,看上游具体返回了什么(原始 SSE / JSON 全文)

### `model not found` / 401 / 403

- **Responses 模式**:Key 没有 `gpt-5.5` 模型权限。换分组,或在 🔧 上游配置 里把图像模型 ID 改成你 key 实际支持的
- **Images 模式**:把图像模型 ID 改成中转站列表里有的(常见:`gpt-image-1` / `gpt-image-2` / `dall-e-3`),或换一个有这些模型权限的分组

### 多参考图 / 蒙版 / seed 没生效

这些字段在 payload 里都正确发送,**但上游是否真正使用取决于中转站和模型实现**。两种 API 形态的字段映射:

- Responses 模式:`mask` / `seed` / `negative_prompt` 作为 `image_generation` 工具参数
- Images Edits 模式:`mask` 作为单独的 multipart file,`seed` / `negative_prompt` 作为 form 字段

不同模型 / 中转站对这些字段的支持程度不一。Images 模式下多张参考图的支持取决于 relay —— 标准 OpenAI 接口只接受一张 `image`,本应用第二张及之后用 `image[]` 兼容字段发送(可能被忽略)。

完整 FAQ 请见应用内「上游区右上角的 ❓ FAQ」入口。

---

## 项目结构

```
.
├── go-cli/                       # 独立 Go CLI(可单独跑,共享 pkg/client)
│   ├── pkg/client/               # 核心
│   │   ├── client.go             # 重试编排 + Responses/Images 形态分发
│   │   ├── payload.go            # Responses API payload 构建
│   │   ├── sse.go                # SSE 行解析 + image 提取
│   │   ├── images_api.go         # Images API(generations + edits multipart)
│   │   ├── retry.go              # 524/504 识别 + 错误归因
│   │   ├── http_native.go        # net/http + 8MB scanner buffer
│   │   ├── http_curl.go          # curl 子进程 fallback
│   │   └── types.go              # Options / APIMode / SizeOptions 等
│   ├── internal/{promptui,fsio}/ # 终端交互 + 文件 IO
│   └── cmd/gptcodex-image/main.go
├── image-studio/                 # Wails 桌面应用
│   ├── backend/                  # Go bindings(按职责分文件)
│   │   ├── service.go            # Service + 生命周期 + Generate/Edit/Cancel + apiMode 分发
│   │   ├── types.go              # JSON-bound structs(含 APIMode 字段)
│   │   ├── dialogs.go            # 文件对话框 / URL 跳转 / 历史导入导出
│   │   ├── imports.go            # 拖拽/粘贴 import + 文件名 sanitize
│   │   ├── imageops.go           # 旋转 / 翻转 / 裁剪(Go image 库)
│   │   ├── paths.go              # 目录解析 + 文件名构造
│   │   └── open.go               # 跨平台 OS 打开
│   ├── frontend/src/             # React + TS · Tailwind v4 + lucide-react
│   │   ├── components/
│   │   │   ├── layout/           # AppHeader / HitokotoStrip(每日一言) / WorkspaceBar / FooterBar
│   │   │   ├── panel/            # ControlPanel / SettingsPanel / PromptPopover / FAQModal / UpstreamConfigModal
│   │   │   ├── canvas/           # CanvasStage / Toolbar / SourceStrip / StatusBar / EmptyState(棋盘格滚动)
│   │   │   ├── history/          # HistoryRail / RawResponseModal
│   │   │   └── common/           # Modal / ToastContainer / ContextMenu
│   │   ├── state/                # zustand store
│   │   ├── styles/               # index.css(Tailwind v4 入口 + @font-face)+ _canvas.css(画板动画)
│   │   ├── assets/fonts/         # HarmonyOS Sans SC Regular/Medium + JetBrains Mono(嵌入 exe)
│   │   ├── lib/                  # localStorage / idb-keyval 工具
│   │   └── types/                # 领域类型
│   ├── build/                    # Wails 资源:appicon.png(白底黑线条)+ windows/icon.ico
│   └── build/bin/                # 生产 .exe 输出
└── go.work                       # Go workspace(backend replace ../go-cli)
```

---

## 致谢

- [**linux.do**](https://linux.do/) —— 感谢 L 站及其社区为项目开发与交流提供的支持与启发。

灵感来自实际使用中频繁被中转站 524 截断的痛苦经历。

---

## License

[MIT](./LICENSE) © 2026

---

[![Star History Chart](https://api.star-history.com/svg?repos=RoseKhlifa/Image-Studio&type=Date)](https://star-history.com/#RoseKhlifa/Image-Studio&Date)
