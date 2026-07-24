# Artistic Git 视觉设计系统规格（v2 · 重塑版）

> 参照系：**Linear**。目标气质：**大道至简、内敛精致**——不靠装饰，靠排版、层级与节奏取胜。
> 配套可交互预览：`design/preview.html`（file:// 直接打开，零构建零联网）。
> 本文档是 Phase 1–5 实施的基准；落地后回填至 `SEPC.md`「视觉设计系统」一节。

## 1. 设计原则

1. **排版驱动层级**：信息层级通过字号 / 字重 / 三级文本色表达，不以分割线与卡片堆叠制造层级。能不用边框就不用边框。
2. **Hairline 与低阴影**：边框保持 6–10% 存在感的"发丝线"；阴影大而柔、低透明，仅浮层使用。
3. **动效有语义**：进入 = 淡入 + 轻微放大/位移（减速曲线）；退出 = 仅快速淡出；悬停反馈 ≤120ms。动画是用来解释空间关系的，不是装饰。
4. **密度与呼吸**：列表行高 32–36px；分组标题用小字 + 大留白分隔；一切落在 4px 网格上。
5. **色彩克制**：黑白灰为主体，语义色降饱和，仅用于状态指示。全App无品牌渐变（审查模式青色渐变为规格内唯一例外）。

**排外清单**（明确不做）：玻璃拟态滥用、大圆角卡片套卡片、彩色图标、发光效果、弹簧式夸张动效、扫光（shimmer）骨架屏。

## 2. 色彩令牌

冷灰阶（微蓝相，Linear 式）。所有颜色以 HSL 三通道变量存储，与现有 `hsl(var(--token))` 机制一致。

### 2.1 中性阶（浅色主题）

| Token                    | HSL           | 说明                                  |
| ------------------------ | ------------- | ------------------------------------- |
| `--background`           | `220 16% 99%` | 应用底色（微冷白）                    |
| `--card`                 | `0 0% 100%`   | 浮层/对话框（纯白，与底色形成弱层级） |
| `--foreground`           | `224 12% 12%` | 一级文本                              |
| `--foreground-secondary` | `222 8% 42%`  | 二级文本（路径、描述）                |
| `--foreground-tertiary`  | `220 6% 56%`  | 三级文本（时间、提示）                |
| `--secondary`            | `220 12% 96%` | 次按钮底                              |
| `--accent`               | `220 12% 95%` | hover/选中背景                        |
| `--border-subtle`        | `220 10% 93%` | 发丝分隔线（默认）                    |
| `--border`               | `222 10% 88%` | 明确边界（输入框、浮层边缘）          |
| `--ring`                 | `224 10% 26%` | 焦点环                                |

### 2.2 中性阶（深色主题）

| Token                    | HSL           | 说明                 |
| ------------------------ | ------------- | -------------------- |
| `--background`           | `224 14% 8%`  | 应用底色（冷黑）     |
| `--card`                 | `224 12% 10%` | 浮层（微提亮）       |
| `--foreground`           | `216 12% 92%` | 一级文本（不用纯白） |
| `--foreground-secondary` | `218 8% 64%`  | 二级文本             |
| `--foreground-tertiary`  | `220 6% 48%`  | 三级文本             |
| `--secondary`            | `222 10% 14%` | 次按钮底             |
| `--accent`               | `222 10% 16%` | hover/选中背景       |
| `--border-subtle`        | `220 8% 14%`  | 发丝分隔线           |
| `--border`               | `220 8% 19%`  | 明确边界             |
| `--ring`                 | `216 10% 70%` | 焦点环               |

### 2.3 语义色（降饱和；浅色 / 深色）

| Token       | 浅色          | 深色          | 用途      |
| ----------- | ------------- | ------------- | --------- |
| `--success` | `152 46% 38%` | `152 44% 52%` | 成功状态  |
| `--warning` | `36 80% 42%`  | `40 78% 58%`  | 警告      |
| `--danger`  | `0 58% 52%`   | `0 62% 60%`   | 危险/删除 |
| `--sync`    | `24 78% 48%`  | `26 84% 58%`  | 待同步    |
| `--review`  | `188 58% 36%` | `188 56% 48%` | 审查模式  |

规则：语义色只出现在小面积状态元素（圆点、徽标、图标、细进度条）；大面积填充一律中性色。Diff 的增/删行背景使用语义色 8–10% 透明度。

## 3. 排版系统

### 3.1 字体栈

```css
--font-sans:
  "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
  "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
--font-mono:
  ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas,
  monospace;
```

- **Inter Variable（内嵌，SIL OFL 1.1）**：仅子集化 latin + latin-ext（目标 ≤300KB），负责英文、数字、标点。`font-display: swap`。
- **中文锁定系统字体**（已确认决策）：不内嵌任何 CJK 字体，经回落栈渲染。
- 等宽仅用于 commit hash、文件路径、diff（CodeMirror 内）。

### 3.2 字阶（6 级，锁定四参数）

| 级别      | size/leading (px) | weight | tracking | 用途                           |
| --------- | ----------------- | ------ | -------- | ------------------------------ |
| `display` | 24/32             | 560    | -0.022em | 起始页主标题（全App ≤1 处/屏） |
| `title`   | 16/24             | 560    | -0.011em | 对话框/面板标题                |
| `heading` | 14/20             | 560    | -0.006em | 区块标题                       |
| `body`    | 13/20             | 450    | 0        | 正文、列表主行（**默认**）     |
| `label`   | 12/16             | 500    | 0.003em  | 分组标题、表单标签             |
| `caption` | 12/16             | 450    | 0        | 辅助说明（恒配 tertiary 色）   |

落地为语义工具类：`.text-display / .text-title / .text-heading / .text-body / .text-label / .text-caption`。禁止在组件中直接使用裸 `text-xs/text-sm` 表达语义层级（迁移期除外）。

### 3.3 中英混排规则

Inter 无 CJK 字形，中文字符回落系统字体，两者 x-height 与基线存在天然差异。消化手段：

1. 行高统一用固定 px（同上表），不用相对单位，保证混排行高稳定。
2. 同字号下 CJK 视觉略大，因此中西混排行的字重取低档（body 用 450 而非 500+）。
3. 数字与 Latin 片段嵌在中文句中时无需任何标记，字体回落自动完成。
4. 标点压缩（标点挤压）依赖浏览器默认，不引入 `text-spacing-trim` 实验特性。

### 3.4 数字规范

- 一切上下堆叠比较的数字（ahead/behind、提交数、文件大小、行号、时间戳）必须加 `.text-numeric`（已存在：`tabular-nums` + `tnum`）。
- Inter 数字等宽开启后视觉宽度一致，列表右对齐。

## 4. 形状：圆角 / 间距 / 边框 / 阴影

| 项             | 值                                   | 用途                       |
| -------------- | ------------------------------------ | -------------------------- |
| 圆角           | 6px                                  | 按钮、输入框、列表行 hover |
|                | 8px                                  | 面板、卡片、popover        |
|                | 12px                                 | 对话框、大浮层             |
| 间距           | 4px 网格：4/8/12/16/20/24/32         | 全部内外边距               |
| 边框           | `--border-subtle` 1px                | 分隔线（默认）             |
|                | `--border` 1px                       | 输入框、浮层边缘           |
| 阴影 `raised`  | `0 1px 2px hsl(224 20% 10% / 0.05)`  | 轻微抬升（下拉）           |
| 阴影 `overlay` | `0 4px 16px /0.08, 0 1px 3px /0.06`  | 浮层、tooltip              |
| 阴影 `popover` | `0 12px 32px /0.12, 0 2px 8px /0.08` | 对话框、Toast              |

深色主题阴影 alpha 提升至 0.32 / 0.40 / 0.50。内容区域**不使用阴影**（仅浮层）。

## 5. 动效系统

### 5.1 时长与曲线

| Token              | 值                                 | 用途                    |
| ------------------ | ---------------------------------- | ----------------------- |
| `--duration-micro` | 120ms                              | hover、选中、按下反馈   |
| `--duration-fast`  | 180ms                              | popover、tooltip 进入   |
| `--duration-panel` | 240ms                              | 对话框、Toast、面板展开 |
| `--duration-large` | 320ms                              | 全屏覆盖层（冲突/审查） |
| `--ease-standard`  | `cubic-bezier(0.25, 0.1, 0.25, 1)` | 状态变化                |
| `--ease-enter`     | `cubic-bezier(0.16, 1, 0.3, 1)`    | 进入（减速，已有）      |
| `--ease-exit`      | `cubic-bezier(0.4, 0, 1, 1)`       | 退出（加速）            |

### 5.2 模式库（仅这些，禁止发明新动画）

| 模式             | 参数                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| hover 反馈       | background/color 过渡，120ms standard                                  |
| popover 进入     | opacity 0→1 + scale 0.96→1，180ms enter；退出仅 fade 100ms exit        |
| overlay 进入     | opacity + scale 0.98→1 + translateY(4→0)，240ms enter；退出 fade 120ms |
| toast 进入       | translateY(8→0) + fade，240ms enter                                    |
| 面板展开         | grid-template-rows 0fr→1fr，240ms enter + 内容 fade 180ms              |
| 列表首屏 stagger | 每项延迟 ≤24ms，仅前 12 项，仅进入，240ms enter                        |
| 骨架 pulse       | opacity 0.5↔1，1800ms ease-in-out infinite                             |
| 进度条           | 顶部 2px 细条，`--sync` 色，不定态左右滑动 1200ms                      |

`prefers-reduced-motion`：全局降级为 1ms 淡入淡出（现有规则保留）。

## 6. 组件状态矩阵（关键件）

### 6.1 按钮

| 属性          | 值                                                    |
| ------------- | ----------------------------------------------------- |
| 尺寸          | sm 28px / md 32px / lg 36px（高），padding-x 10/12/16 |
| 字级          | `body`，weight 500（主按钮 560）                      |
| 图标间距      | 6px                                                   |
| hover         | 主：亮度 -6%；次/ghost：背景 `--accent`；120ms        |
| pressed       | 亮度再 -4%（不用 scale 缩放）                         |
| disabled      | opacity 40%，无 pointer 事件                          |
| focus-visible | 2px `--ring` outline，offset 2px（沿用现有全局规则）  |

### 6.2 列表行（分支/提交/文件/储藏/最近项目统一规格）

| 属性     | 值                                                              |
| -------- | --------------------------------------------------------------- |
| 行高     | 32px（紧凑）/ 36px（两行文本）                                  |
| 主文本   | `body` 一级色；次文本 `caption` tertiary 色                     |
| hover    | 背景 `--accent`，圆角 6px，120ms                                |
| 选中     | 背景 `--accent` + 左侧 2px `--foreground` 指示条                |
| 行内数字 | `.text-numeric`，右对齐                                         |
| 悬停操作 | 图标按钮淡出/淡入（沿用 hover-action-group 思路，简化渐变遮罩） |

### 6.3 对话框 / Toast / Tooltip

- 对话框：overlay 进入模式；max-width 阶梯 420/560/720；padding 24；标题 `title` 级；footer 按钮右对齐间距 8。
- Toast：底部居中或右下（沿用现状），toast 进入模式，`popover` 阴影。
- Tooltip：`caption` 级，padding 6/8，圆角 6，`overlay` 阴影，300ms 延迟后 180ms 淡入。

## 7. 加载与进度

1. **骨架屏**：形状与真实布局一致（行/块），圆角 4，pulse 模式；用于仓库摘要、分支列表、提交图、diff、本地变更。无 shimmer 扫光。
2. **顶部进度条**：fetch/sync/clone 期间，窗口内容区顶部 2px 细条（`--sync` 色不定态动画）。
3. **Spinner**：仅用于按钮内联忙碌态与预计 <300ms 的等待；页面级等待一律骨架屏。
4. **空态**：居中图标（lucide 20px，tertiary 色）+ `caption` 一行说明 + 可选一个次按钮；不用插画。

## 8. 滚动体验

- 长列表容器顶/底 16px 渐隐 mask（内容接近边缘时提示可滚动）。
- 统一使用 `overlay-scroll-area`（悬浮细滚动条），禁止原生滚动条外露。
- 列表刷新时保持滚动锚定（`overflow-anchor`），防跳动。
- `overscroll-behavior: contain` 于各滚动容器，避免链式滚动穿透。

## 9. 迁移映射（Phase 1–5 实施要点）

| 现有                            | 目标                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/styles.css` 纯灰阶         | 替换为 §2 冷灰阶 + 三级文本色变量（新增 `--foreground-secondary/tertiary`、`--border-subtle`） |
| `--muted-foreground` 单级弱文本 | 迁移到 secondary/tertiary 双级（旧变量保留别名一个迭代，逐步替换）                             |
| `--shadow-floating` 单级阴影    | 替换为 raised/overlay/popover 三级                                                             |
| `--duration-fast/panel` 双时长  | 扩展为 micro/fast/panel/large 四时长 + 三曲线                                                  |
| 裸 `text-xs/sm/base`            | 逐步替换为 §3.2 语义工具类                                                                     |
| 数字场景                        | 普及 `.text-numeric`                                                                           |
| 组件出现无动画                  | 按 §5.2 模式库接入 floating-panel/tooltip/dialog/toast                                         |
| 居中 spinner 加载               | 替换为骨架屏 + 顶部进度条                                                                      |

**铁律**：不改信息架构/流程；保留全部 `data-testid`；`prefers-reduced-motion` 全局降级契约保留（`styles.test.ts` 扩展断言）。
