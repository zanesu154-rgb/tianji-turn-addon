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
| UI 显示键名 | — | 显示文字的标签若为 `"localize": false`（含通过 `@模板` 继承、通过 `$变量` 传入模板的情况），键会被原样显示 → 自动改为 `true` |
| UI 误提取 | `$flag` 这类表单标记变量、`§t§j` 格式码、`|TOKEN|` 标记、单个字母（如关闭按钮 "X"）会被翻译，破坏 `visible` 判断 | 预扫描所有 UI 文件，出现在表达式/绑定中的变量不动；只翻译真正当作 `text` 使用的变量 |
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

**脚本自带的多语言表**——很多附加包在脚本里自己维护了多语言，例如：

```js
const DIALOGUE_DATA = [{ "s": "Light is ...", "v": "Ánh sáng là ...", "d": false }, ...];
const LANG = { en_US: { welcome: "Welcome" }, zh_CN: { welcome: "欢迎" } };
```

同一句话的各语言版本会合并为**同一个键**：英文写入 `en_US.lang`，越南文写入 `vi_VN.lang`（自动加入 `languages.json`），不会变成两条互不相干的键；运行时无论脚本选了哪种语言的原文，都会查到这个键，最终按玩家客户端语言显示。识别规则：

- 键名是语言代码（`en`、`zh_CN`、`vi`、`ja`…）的对象，或按语言代码分组的字典：自动合并
- 对象数组里语言不同的平行字段：字段名很短（如 `s` / `v`）时自动合并；字段名像 `name` / `desc` 时只提示不合并（可能只是语言不同的两段内容）
- 不同文件用相同字段名（都是 `s` / `v`）但语言不同：按每个文件、每个数组分别判断语言（支持中日韩俄泰越及英、西、法、德、葡、意、印尼、荷、土、波兰语），判断不出时参考文件名（`dialogue_es.js`）
- 选项“脚本自带翻译字段”可手动指定（`s=en_US, v=vi_VN`），按文件指定（`dialogue_es.js:v=es_ES`），或填 `off` 关闭

**玩家输入匹配**（聊天关键词、正则）不会被修改：`patterns` / `keywords` / `triggers` 等字段、`[/正则/, "内部标记"]` 形式的归一化表、`.test()` / `.replace()` 的参数都视为程序逻辑而不是显示文本。玩家的输入不经过 lang，所以让新语言的玩家也能触发关键词，需要作者在正则里加上该语言的说法；回答文本则正常提取翻译。工具会把这些匹配规则导出到翻译表的 `input_aliases.csv`：每行一个内部标记或回答，列出现有说法（从正则里拆出）、已支持和缺少的语言（自动判断），并为每种目标语言留出 `add_<语言>` 列，补完后交给作者加进正则即可。


**为避免误改**：如果脚本里自己定义了与上述 API 同名的方法（例如封装了一个 `Menu.title()`），无法确认类型的同名调用不会被改写，并在日志中提示；能确认是 `new ActionFormData()` 链式调用、`const f = new …FormData()` 变量或 `this.form = new …FormData()` 的调用仍会处理。

## 世界存档与结构文件（网页“世界存档”标签页）

上传 `.mcworld` / `.mctemplate`（手机无法导出存档时可导出为模板）或 `.mcstructure`。存档会读取 LevelDB 数据库（`db/`），其中用结构方块保存的结构也一并处理：

| 内容 | 处理 |
|---|---|
| 告示牌、悬挂告示牌（正反面） | 文本改为 `{"rawtext":[{"translate":…}]}` |
| 命令方块、命令方块矿车 | `title` / `titleraw` / `tellraw` 改为翻译键 |
| NPC | 名字、正文、按钮名改为翻译键；按钮命令中的 title/tellraw 同样处理 |
| `say` / `tell`、容器名、物品名与描述、成书、实体名字标签 | 游戏只按纯文本显示，列入“无法本地化”报告 |

写回方式：不改动任何 `.ldb`，只在当前日志（`db/*.log`）末尾追加一条写入记录（与游戏自己的写入方式相同），写完后重新打开数据库逐条校验。翻译放在存档内新建的 `resource_packs/world_texts/`，并登记到 `world_resource_packs.json`，打开存档自动加载。

已在游戏内实测：告示牌、悬挂告示牌、命令方块、NPC 的翻译键均正常显示。

### NBT 编辑器

游戏不支持翻译键的文本（容器名、物品名、成书、名字标签、say 命令、世界名等）可以在页面下方的 NBT 编辑器中直接修改，修改会在下载时一起写回存档：

- **需人工翻译**：列出所有这类文本，逐条原位修改；“导出待翻译表”得到 `untranslatable.csv`，在 `translation` 列填写译文后“导入翻译表”批量写回（`ref` 列是文本在存档中的位置，请勿修改）
- **搜索**：按键名或内容查找（如 `CustomName`、`LevelName`、某段文字），结果可直接编辑
- **浏览全部**：方块实体 / 实体 / 结构 / level.dat 的完整 NBT 树，按需展开；字符串和数字可编辑，数字会按类型校验范围

内容很多时：
- “需人工翻译”可按类别（方块名称、物品名、成书、名字标签、命令）筛选、按关键词过滤、只看未修改，分页显示
- “搜索”可以把全部结果（不限显示的 300 条）导出成表格，在 `translation` 列填写新值后导入；例如搜索 `CustomName` 一次改完所有名字

### 结构文件 .mcstructure

- 单独上传：下载得到 zip，内含改好的 `.mcstructure` 和翻译资源包 `<名字>_texts.mcpack`（使用该结构的世界需启用）
- 附加包行为包里的 `structures/*.mcstructure`：随附加包一起转换，翻译写进附加包的资源包
- 存档里用结构方块保存的结构（`structuretemplate_…`）：随存档一起转换
- 结构中的翻译键以 `structure.<结构名>.` 开头，避免不同结构的内部坐标冲突

## 无法本地化的内容

以下位置游戏只接受纯文本，工具只会列入报告（界面和 `untranslatable.csv`）：`say` / `tell` / `me` 命令、计分板显示名、`nameTag`、战利品表 `set_name` / `set_lore`、脚本 `setLore`、Boss 血条名称、标题画面闪烁文字。

## 已知限制

- 混淆后（字符串被编码）的脚本无法提取。
- 官方文档没有说明以下字段是否支持翻译键，需在游戏中确认：`minecraft:interact_button`（按支持处理）、`minecraft:boss.name` 和战利品 `set_name` / `set_lore`（按不支持处理，保持原样）。
- 关闭“多行文本拆成多个键”时会写成 `\n`，请在游戏中确认显示正常。

## 输出

- **转换后文件**：`<原名>_i18n.mcaddon`（单个 .mcpack 输入且无需新建资源包时保持 .mcpack）
- **翻译表**：`strings.csv`（Excel 可直接打开）、`untranslatable.csv`、`input_aliases.csv`（有聊天关键词匹配时）、`source_<语言>.lang`、处理日志

## 测试

```
node test/run-tests.js
```
需要本地 Node 18+；`test/load.js` 中 acorn 从 `vendor/` 加载。
