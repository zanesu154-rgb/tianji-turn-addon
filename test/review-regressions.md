# LFMC 独立复审回归

- `node test/run-tests.js` 运行完整公开套件（含本页分级历史回归）。
- `node test/review-regressions.js` 只运行复审回归。需要 Node、仓库内置 Acorn 以及现有公开夹具。
- `node test/review-regressions.js --acceptance` 额外执行 #168 目标验收，其断言继续强制执行；#184 已合并，当前主线应通过。
- 历史候选可在隔离目录中原样应用，然后复制 `review-regressions.js` 和 `review-regression-tiers.json` 到候选的 `test/` 并执行独立命令。候选出现 FAIL 时以该用例的输出定位行为差异。这个入口无需 AI API、私人样本、联网或游戏客户端。

## 证据映射

| 测试 | 已确认的历史证据 |
| --- | --- |
| #168/#182 fresh、bilingual、zh-only 非目标键稳定性及标题分键 | #182 第一轮整段排除导致非目标键消失。第二轮拆分让 ACHV 和普通 Progress 共用键。第三轮仅中文回填仍移除了原 IDCARD 键。这组公开合成夹具检查有序语言键和值，以及脚本实际使用的普通标题键。 |
| #168/#182 旧键归属、旧格式与标记 | #168 R2 的旧键来源及格式反例，#182 第三轮的跨脚本同文旧键和前导颜色码反例。要求保留标题身份、旧译文，并防止生成第二个 ACHV 标记。 |
| #168 非目标 Modal 构造器遮蔽 | #168 R3 主线对照。普通 `for` 中绑定的同名构造器实际指向 Modal，路由保护启用前后应产生相同的标题。 |
| #168 可见标题与两种旧译文回填 | #168 历史主线整串提取，#184 已修复。独立验收固定文本节点、独立语言键和实际落盘的迁移译文。 |
| #169 尾逗号及注释、调用别名、展开参数、导入别名遮蔽 | #169 R1 / R2 独立审核。Acorn 直接解析完整生成模块，Node 模拟 API 检查可写选项和运行时类型。 |
| #169 导出宿主、返回宿主、返回计算属性访问得到的方法 | #169 R2 / R3 / R4 独立审核。通过 String 专用的接收者复现错误升级。 |
| CV-3A-2 R9 无实际借点的缓存污染 | R9 原始独立探针。在 A→B→B、B→A→B 两种顺序下比较完整短查询 rawtext，无需运行时插桩。 |

复审语境和候选证据见 [#168](https://github.com/zanesu154-rgb/tianji-turn-addon/issues/168)、[#182 评审](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/182#issuecomment-7150135843)、[#182 第二轮](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/182#issuecomment-7150441765) 和 [#169](https://github.com/zanesu154-rgb/tianji-turn-addon/issues/169)。

合成测试允许非目标场景安全回退。完整原包三模式、更多 CV-3A-2 布局和标点历史探针，以及 Minecraft 实机仍需独立验收。本批只纳入已有确证的代表性回归。


## 2026-11-26 分级审批

项目负责人批准按现实代表性、影响范围和历史证据分级，采用逐项清单的 6 / 6 / 3 数量。完整稳定标识、层级及理由见 [登记表](review-regression-tiers.json)。所有原始测试与断言保留，历史失败证据和上文映射继续适用。

两个入口都全量运行历史回归并报告 PASS/FAIL。Mandatory 失败使历史套件退出 1；Compatibility 和 Exploratory 失败仍显示 FAIL 并计入各自 failed 数量，交由工程裁决。框架异常及登记不完整仍退出 1。完整公开套件的其他测试、56 项 ACHV 专项以及 --acceptance 的三项验收继续强制执行。

分级变更仅落实批准的风险治理，不构成对 #169 或其他候选的合并批准。治理 PR 合并后再复审候选。

分级后完整套件计数为 385 项强制检查，加上单列报告的 9 项 Compatibility/Exploratory，共执行原有 394 项检查。私人存档跳过数另列，计数变化不代表删除测试。
