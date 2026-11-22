# LFMC 历史会话索引

这是「天际翻译插件修正」那一份 Claude 导出档案的检索索引。产品在这份档案里先后叫过天际翻译插件、`tianji-turn-addon`、栈主的附加包汉化工具、Localizator for MCBE。下面统称 LFMC。

原始档案不在这个仓库里。它在私有仓库 `zanesu154-rgb/BUG-Test-addon-world` 的 `The History(Important)/12_天际翻译插件修正.md`，提交 `0261ab9b0228c0a6b3849ec02d0e9b2af9424be3`。本目录不复制那份档案，也不改它。

## 先看哪一份

- 档案是否完整：[integrity-report.md](integrity-report.md)
- 索引里每个文件是什么、以后怎么查：[index-scheme.md](index-scheme.md)
- 机器可读的计数和校验：`manifest.json`

## 不要把历史回复当成现行规则

档案里的助手正文、思考摘要、工具输出，都是 2026-11-07 到 2026-11-21（台北时间）当时的说法。用户后来否定过不少结论。查到一条历史说法时，先看它的 `channel` / `epistemic` 字段，再对照当前源码和测试。用户说「测过、正常」只证明那一次，不自动成为现在的规格。

## 怎么查，而不把整份档案读进上下文

档案有 224,122 行、约 988 万字符。用索引定位，再按行号取一小段。

```bash
python3 knowledge/history/lookup.py --topic missed_text
python3 knowledge/history/lookup.py --errors
python3 knowledge/history/lookup.py --archive /path/to/12_天际翻译插件修正.md --message 80
```

`lookup.py` 默认拒绝一次打印超过 400 行，并把超长行截短。需要整行时加 `--full-lines`，并且仍然用 `--message` 或 `--lines` 把范围收窄。

重建索引（只写本目录，不写档案）：

```bash
python3 knowledge/history/build_index.py --archive /path/to/12_天际翻译插件修正.md --out knowledge/history
```
