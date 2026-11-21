# 更新日志

按日期列出，每天写当天最后的版本号（网页页脚可看到当前版本）。版本号格式为“日期-序号”。

[English](CHANGELOG_en.md)

## 2026.11.21-90（2026-11-21）

### 改进

- 低版本 `setLore` 不能用翻译键时，日志提示可用“固定写入简体中文” ([#138](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/138))

### 修复

- 写回 JSON 时 `1.0`、`0.0` 这类小数变成了整数，实体的 float 属性定义被游戏判为无效，后面的属性跟着失效（脚本报 “Property … does not exist”） ([#144](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/144))
- 作者把 `·` `→` 等换成 ASCII 后显示的句式文字、前面带序号的标题（如“01  Unstable Sneeze - Practice 1”）找不到译文 ([#143](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/143))
- 整页正文里一个句式把相邻几行吞进参数，显示串行；界面先把 `—` `·` `→` 换成 ASCII 再显示的文字找不到译文；代码截取升级说明冒号前半段再显示（“适用于：…”）时没有译文 ([#142](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/142))
- 脚本把标题、多段说明和结尾拼成一整页显示时找不到译文（如能力手册的“关于你的能力”“操作”页）；全大写标题、“标签: 数值”、用 `->` 代替 `→` 的文字也能找到了 ([#141](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/141))
- 自定义界面里通过 property_bag 显示的悬停文字（如饰品栏的“Face Slot”）没有列出来；现在列进需人工翻译 ([#140](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/140))
- 包作者自己用翻译键拼的消息（`{translate, with:["Wall"]}`），参数里的文字没翻译 ([#139](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/139))
- 消息里直接显示的槽位等 ID（`Slot: ${slot}`）没法翻译；现在登记成可翻译的词，判断用的 ID 不受影响 ([#139](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/139))
- `title … actionbar` 文字里的 `@s` 等选择器被当成文字写进 lang，游戏里不再显示玩家名 ([#138](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/138))
- 界面用 `$变量` 比较容器标题（如 `$temp_container_title = '…'`）时没识别，固定写入中文后自定义饰品栏界面失效 ([#138](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/138))
- 脚本用标题把数据发给自定义 HUD（界面按前缀判断、按字符位置截取）时被改成翻译键，界面读不出数据 ([#137](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/137))

## 2026.11.19-82（2026-11-19）

### 改进

- 资源包和行为包都有语言文件时，以资源包的为准（游戏显示文字只读资源包） ([#134](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/134))

### 修复

- 脚本里用 `%键名` 引用语言文件的消息（如 `§7%stats.total:`）被当成文字提取，写进 lang 后变成 `%%`，引用失效 ([#136](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/136))
- manifest.json 末尾多写了一个 `}` 时整个包被跳过（游戏能正常读取）；manifest 读不出来时日志会提示 ([#135](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/135))
- manifest 里直接写了包名 / 简介，lang 里又另有 pack.name 时，改以 manifest 为准，删掉原来的那一行 ([#134](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/134))
- 存档里改了物品自定义名称后，命令里按名字找掉落物的 `@e[type=item,name=…]` 没跟着改，导致地图逻辑失效 ([#133](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/133))

## 2026.11.18-78（2026-11-18）

### 新功能

- 新增更新日志；点网页页脚的版本号可以打开 ([#127](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/127))

### 改进

- 把缺失的键补全到其他语言文件时，带上英文文件里的分节注释和行尾说明，按原顺序排列 ([#132](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/132))
- 访问计数改用 Vercount（沿用不蒜子的数字）；服务没响应时显示 --，不再整块消失 ([#125](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/125))

### 修复

- 只用 `\r` 换行的 .mcfunction 文件导致存档自带包处理失败（Cannot read properties of null） ([#131](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/131))
- 命令里用下划线连起来的显示文字（如 “Spawnpoint_Save”）没有提取 ([#130](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/130))
- 只有标点的句子（“???”“...”）没有提取，各语言里显示不了对应的写法 ([#129](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/129))
- 书页超出字数限制时，存档处理报错“t is not a function” ([#126](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/126))
- 加网站图标，控制台不再报 favicon.ico 404 ([#124](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/124))

## 2026.11.17-70（2026-11-17）

### 新功能

- 英、日、韩、俄界面的工具名改为 Localizator for MCBE ([#119](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/119))
- GitHub 加了中英双语的 Bug 反馈模板 ([#121](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/121))

### 改进

- 注意事项、无法本地化的原因、编辑器类别和位置说明都按界面语言显示 ([#122](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/122))
- 计分板显示名单独成类，默认隐藏 ([#117](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/117))

### 修复

- 存档里改了实体名后，summon 命令里的名字参数没跟着改，导致地图逻辑断掉 ([#123](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/123))
- 导入翻译表时，没加引号的多行译文读不回来 ([#118](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/118))
- 勾了“只看未修改”时，导出的翻译表仍包含已改过的条目 ([#120](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/120))

## 2026.11.16-64（2026-11-16）

### 新功能

- 原版物品名对照表加入 17 种语言，非英文写的包也能匹配原版名 ([#115](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/115))

### 改进

- 需人工翻译导出时，相同原文合并成一行 ([#113](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/113))
- 调试输出识别更全；改了会坏的 ASCII HUD 字段不再列入需人工翻译 ([#116](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/116))

### 修复

- 先存进常量再 runCommand 的命令被误提取 ([#114](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/114))

## 2026.11.15-60（2026-11-15）

### 修复

- JSZip 改为随网站一起提供，避免网络波动时报“JSZip is not defined” ([#112](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/112))

## 2026.11.14-59（2026-11-14）

### 新功能

- 包作者自己的 localizeText(player, …) 会按玩家语言换成已有译文 ([#111](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/111))

### 改进

- 目标语言里和原文一模一样的句子移到待翻译段 ([#108](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/108))
- 选中标记、括号里斜杠分隔的小词逐段翻译；附魔 ID 对照表 ([#106](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/106), [#107](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/107))
- 对象键名做成的下拉选项也登记翻译 ([#109](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/109))

### 修复

- Molang 表达式、竖线分隔的数据记录、按键枚举被误提取 ([#105](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/105))
- 名称里 %键 引用的新键带冒号，游戏里显示成键名 ([#110](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/110))

## 2026.11.13-51（2026-11-13）

### 新功能

- 需人工翻译里相同原文合并成一行；存档改实体名时同步命令和脚本里按名字找实体的地方 ([#95](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/95), [#99](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/99))
- 战利品表 / 交易表里的成书页面换成翻译键 ([#92](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/92))

### 改进

- 物品 / 实体名复用已有键，不再生成 _1；item.x 与 item.x.name 合并成一个键 ([#96](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/96), [#97](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/97))
- 只放回译文 lang 重新转换时整体对齐上次的键，修复译文错位 ([#103](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/103))
- 换行警告折叠；不能生成的弹射物不再生成占位名 ([#98](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/98))
- 日志加“可能的版本上限” ([#94](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/94))

### 修复

- 库带来的文字（许可证、编译器报错、日志标签等）、命令字符串、只用来拼 ID 的参数被误提取 ([#93](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/93), [#101](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/101), [#102](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/102))
- 界面 text_tts 引用的变量、ID 列表做成的选项漏翻 ([#100](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/100), [#104](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/104))

## 2026.11.12-37（2026-11-12）

### 新功能

- 处理日志按界面语言显示（繁中 / 英 / 日 / 韩 / 俄） ([#84](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/84), [#90](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/90))
- 存档模式：列出 / 删除没启用、重复、无效的包和地图编辑工具；识别同一附加包的旧版本 ([#82](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/82), [#85](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/85), [#86](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/86), [#87](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/87))
- 顶栏加赞助按钮 ([#83](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/83))

### 改进

- lore 写成翻译键后，脚本读回时还原成原文，避免反复追加 ([#78](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/78))
- 命令方块 say / me 转 tellraw 时，发送者名也换成翻译键 ([#81](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/81), [#91](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/91))

### 修复

- 存档二次转换覆盖之前放回的翻译 ([#89](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/89))
- 存档物品 lore 的 (+DATA) 标记、装备栏位名、command 字段里的 function 命令被误提取 ([#80](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/80), [#88](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/88))
- 名字键带说明行时拼名字重复显示 ([#79](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/79))

## 2026.11.11-22（2026-11-11）

### 新功能

- 提取时给出最低可用游戏版本，版本信息附 manifest 版本号 ([#59](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/59), [#60](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/60))
- 内置原版名称对照表；支持把 ID 拼成英文名的脚本函数 ([#64](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/64))
- 再次转换沿用已翻译的 lang；需人工翻译下载后再改也能写回 ([#75](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/75))
- 导入翻译表后标记已修改；放回的 lang 里用不到的旧键自动删除 ([#77](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/77))
- /me 命令转 tellraw；世界名称可在编辑器里修改 ([#69](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/69))
- 展示框 / 荧光展示框里的物品与掉落物也提取 ([#61](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/61))
- “固定写入简体中文”选项（仅简体中文界面）：名字标签等只认纯文字的位置直接写中文 ([#74](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/74))

### 改进

- 翻译表补上包里已有、但目标语言还没译文的键 ([#67](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/67))
- 准星指向的方块名、界面悬停提示、任务界面与奖励物品名等漏翻 ([#72](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/72), [#73](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/73), [#76](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/76))
- RPG 类脚本：显示成 [object Object]、动作栏、物品描述、排版正文的颜色码 ([#62](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/62), [#65](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/65), [#66](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/66))
- 脚本字典条目沿用资源包 lang 里已有的同内容键 ([#63](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/63))

### 修复

- 小地图字形画导致脚本卡死（Watchdog hang） ([#56](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/56))
- 固定长度 ASCII HUD 里的文字被翻译导致显示错乱 ([#57](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/57))
- 语言文件里模板残留的无效条目；%% 写进 lang 时翻倍；隐藏方块名称漏提取 ([#58](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/58), [#68](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/68), [#70](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/70), [#71](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/71))

## 2026.11.10-13（2026-11-10）

### 新功能

- 界面改版：两栏布局、界面多语言、LED 访问计数 ([#50](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/50), [#51](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/51))
- 附加包需人工翻译的文字可在网页上改，或导出翻译表再写回 ([#49](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/49))
- 存档自带的行为包 / 资源包也提取（NPC 对话、函数、脚本） ([#45](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/45))
- 新选项：是否提取创造物品栏里不显示的物品 ([#55](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/55))
- README 改为使用说明，新增英文版与 MIT 许可证 ([#53](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/53))

### 改进

- 按语言分文件的脚本字典自动分离 ([#52](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/52))
- 调试输出、开发备注、内部标识不再提取 ([#54](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/54))

### 修复

- 再次转换已转换的包时重复注入、重复提取；存档二次转换覆盖之前的翻译包 ([#42](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/42), [#44](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/44), [#47](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/47))
- 自定义 NPC 实体的对话、New Recipe 提示漏翻；含 function / return 的英文句子被跳过 ([#43](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/43), [#46](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/46), [#47](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/47))
- 物品描述翻译键实测不支持仍列出；@attributes 键引用被误提取 ([#48](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/48))

## 2026.11.09-10（2026-11-09）

### 新功能

- 多个附加包一起转换时，文字按包写入各自的资源包 ([#39](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/39))
- 附加包里的结构文件可编辑 / 用翻译表导入 ([#40](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/40))
- 转换前选项：是否列出命令方块名称 ([#37](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/37))

### 修复

- 大存档（数千条待翻译）分析后页面卡死 ([#38](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/38))
- 三元分支里的文字、join 拼接的列表、技能面板属性行漏翻 ([#32](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/32), [#33](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/33), [#34](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/34), [#35](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/35))
- 拼出翻译键的模板被误提取 ([#36](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/36))
- 页面文件没加载完整时的报错提示；根目录结构包写回路径 ([#41](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/41))

## 2026.11.08-08（2026-11-08）

### 新功能

- 讲台书标题列入需人工翻译 ([#24](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/24))

### 改进

- 无法本地化报告去掉误报、技术标记和重复行 ([#29](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/29))

### 修复

- 按语言分开登记的脚本翻译字典没分开 ([#28](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/28), [#30](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/30))
- %键 引用、带重音字母的键名、event entity 等命令被当成文字提取 ([#25](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/25), [#26](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/26), [#27](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/27), [#31](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/31))

## 2026.11.07-21（2026-11-07）

### 新功能

- 首个版本：提取附加包里玩家可见的文字，生成多语言 lang ([#1](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/1), [#2](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/2))
- 合并脚本自带的多语言表，各语言译文写入对应 lang；导出玩家输入匹配表 ([#3](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/3), [#4](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/4), [#5](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/5), [#7](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/7), [#8](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/8))
- “世界存档”页面：提取告示牌、命令方块、NPC 文本并生成资源包 ([#9](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/9))
- 存档 NBT 编辑器：人工修改无法翻译的文字，导入导出翻译表，搜索与浏览；支持 .mcstructure 和玩家数据 ([#10](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/10), [#11](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/11), [#12](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/12))
- 成书正文、say / tell、首领血条名转成翻译键；成书超长自动分页 ([#13](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/13), [#14](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/14), [#17](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/17), [#19](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/19))
- 待翻译文本按类别勾选是否提取 ([#18](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/18))

### 修复

- 浏览器缓存导致新旧文件混用 ([#6](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/6))
- UI 标签显示键名、%1$s 与 %s 混用、缩进多行文本和拼进提示的参数漏翻 ([#1](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/1), [#20](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/20), [#21](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/21), [#22](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/22), [#23](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/23))
