# 栈主的附加包汉化工具

提取 Minecraft 基岩版附加包中**玩家可见**的文本，替换为翻译键，生成可多语种翻译的 `.lang` 文件。纯前端运行，直接打开 `index.html` 即可使用。

## 目录结构

```
index.html / style.css / app.js   界面、zip 读写
src/util.js       文本判定、键名、lang 读写、宽松 JSON 解析
src/context.js    分配键、去重、记录报告、生成 rawtext
src/commands.js   title / tellraw / titleraw 命令改写
src/json.js       物品、方块、实体、对话、动画、UI、manifest 处理器
src/script.js     基于 AST 的脚本提取 + 运行时翻译
src/pipeline.js   主流程（识别包 → 处理 → 写 lang），不依赖 DOM
vendor/acorn.js   JS 解析器（MIT）
test/             测试附加包 + 端到端测试（node test/run-tests.js）
```

## 第一步：修正的问题

| 问题 | 原来 | 现在 |
|---|---|---|
| JSON UI 文本 | 写成 `{"rawtext":[...]}`，UI 不认，界面坏掉 | 写纯键名（UI 标签会自动翻译） |
| UI 误提取 | `$flag` 这类表单标记变量、`§t§j` 格式码会被翻译，破坏 `visible` 判断 | 预扫描所有 UI 文件，出现在表达式/绑定中的变量不动；只翻译真正当作 `text` 使用的变量 |
| UI 漏提取 | 少于 3 个字的文本（“确定”“返回”）、含括号/加号的文本被跳过 | 按“是否含文字”判断，中文短词也能提取 |
| 翻译写在哪 | 只写 `zh_CN.lang`；纯行为包附加包的文本直接丢失 | 写入源语言 + `en_US`（游戏回退语言）+ 所选目标语言；没有资源包时自动新建一个（行为包里的 lang 只对包名生效） |
| 包名 | 所有包共用第一个 manifest 的 `pack.name` | 每个包写到自己的 `texts/` |
| 键冲突 | 不读已有 lang，新键可能和已有键同名而被跳过，显示成别的文字 | 先读所有已有键；值相同则复用，另一种文字（如 en_US 的 “Altar” 对应 “祭坛”）视为译文复用键 |
| 战利品 `set_name` / `set_lore` | 改成键名 → 游戏直接显示键名 | 游戏不翻译自定义物品名，改为只列入“无法本地化”报告 |
| `minecraft:nameable.name` | 当作显示文本处理（该组件没有此字段，`name_filter` 是匹配条件） | 不处理 |
| `minecraft:boss.name` | 改成与实体名相同的键，可能覆盖实体名 | 不改，列入报告 |
| 实体 `interact` | 只支持旧的数组格式，忽略 `component_groups` | 支持 `{interactions:[…]}` 新格式和组件组；交易表 `economy_trade_table` 也处理 |
| 命令 | 正则只认 `@a` 形式的目标；`tag @s add title` 也可能被误判；tellraw 中带转义引号的文本漏掉 | 真正解析命令：支持 `execute … run`、带嵌套方括号的选择器、引号玩家名；tellraw 用 JSON 解析，保留 `score`/`selector`/`with` |
| mcfunction | 改写后丢失缩进和 CRLF | 原样保留 |
| 多行文本 | 写成 `\n`（lang 值不能含换行，游戏是否识别 `\n` 不确定） | 默认拆成多个键，中间用 `{"text":"\n"}` 连接 |
| 格式码 | `§l§a欢迎` 整段进 lang | 首尾格式码留在 rawtext 里，译者只看到正文 |
| 未提取 | 方块 `crafting_table.table_name`、物品 `interact_button`、动画控制器的命令、没有名称的物品/方块/实体 | 均已处理；无名称的生成英文占位名（按 ID 推测） |
| JSON 解析 | 尾逗号直接失败 | 支持注释、尾逗号、BOM |

## 第二步：复杂脚本

用 acorn 把脚本解析成语法树后处理，替代原来的正则：

**静态改写**——以下 API 的参数会被改写成 `RawMessage`：
`form.title/body/button/button1/button2/label/header/toggle/slider/dropdown/textField`（含 `tooltip`、下拉选项数组、输入框占位文字）、`sendMessage`、`setActionBar`、`setTitle`（含 `subtitle`）、`updateSubtitle`、`runCommand(Async)`。支持：

- 字面量、模板字符串 `` `你好，${name}！` ``、字符串拼接 `"欢迎 " + name` → `translate` + `with`（lang 中是 `%1$s`，译者可以调整语序）
- 三元表达式的每个分支
- 脚本里手写的 `{rawtext:[{text:"…"}]}`
- `runCommand` 中的 `title` / `tellraw`，包括模板字符串拼出来的命令

**运行时翻译**——参数是变量、对象属性、函数返回值时（例如 `form.button(item.name)`，`item` 来自另一个文件的商品表），静态分析无法确定内容。这时：

1. 把整个附加包脚本里“像玩家文本”的字符串、模板句式都登记到映射表；
2. 显示位置包一层 `__i18n.M(x)`，运行时按原文查表，转换成 `RawMessage`；句式用正则匹配，动态部分本身也会再查表翻译（例如“购买成功：钻石剑 ×1”里的“钻石剑”）；
3. 原数据仍是字符串，`===` 比较、拼接等逻辑不受影响。

测试中对比了原脚本与改写后脚本在模拟 `@minecraft/server` 下的全部输出，用生成的 lang 渲染后逐条一致。

**为避免误改**：如果脚本里自己定义了与上述 API 同名的方法（例如封装了一个 `Menu.title()`），无法确认类型的同名调用不会被改写，并在日志中提示；能确认是 `new ActionFormData()` 链式调用、`const f = new …FormData()` 变量或 `this.form = new …FormData()` 的调用仍会处理。

## 无法本地化的内容

以下位置游戏只接受纯文本，工具只会列入报告（界面和 `untranslatable.csv`）：`say` / `tell` / `me` 命令、计分板显示名、`nameTag`、战利品表 `set_name` / `set_lore`、脚本 `setLore`、Boss 血条名称、标题画面闪烁文字。

## 已知限制

- 混淆后（字符串被编码）的脚本无法提取。
- 官方文档没有说明以下字段是否支持翻译键，需在游戏中确认：`minecraft:interact_button`（按支持处理）、`minecraft:boss.name` 和战利品 `set_name` / `set_lore`（按不支持处理，保持原样）。
- 关闭“多行文本拆成多个键”时会写成 `\n`，请在游戏中确认显示正常。

## 输出

- **转换后文件**：`<原名>_i18n.mcaddon`（单个 .mcpack 输入且无需新建资源包时保持 .mcpack）
- **翻译表**：`strings.csv`（Excel 可直接打开）、`untranslatable.csv`、`source_<语言>.lang`、处理日志

## 测试

```
node test/run-tests.js
```
需要本地 Node 18+；`test/load.js` 中 acorn 从 `vendor/` 加载。
