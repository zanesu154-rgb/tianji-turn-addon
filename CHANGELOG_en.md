# Changelog

Grouped by date; each day shows the last version of that day (the current version is in the page footer). Versions look like "date-build".

[简体中文](CHANGELOG.md)

## 2026.11.23-102 (2026-11-23)

### Fixed

- When an arrow or color changes in a Compound V reward line, the runtime checks for a whole-line translation before splitting at the colon. Dynamic stat labels still fall back to label translation.

## 2026.11.23-101 (2026-11-23)

### Fixed

- Compound V stat labels can translate suffixes such as `Depth`, `Distance`, `Ticks`, `Rings`, and `Rise` on their own. Suffix extraction follows the description table used for placeholder replacement and preserves existing language keys.

## 2026.11.23-100 (2026-11-23)

### Fixed

- Opening the Compound V mastery book could trigger the Watchdog while the runtime repeatedly scanned the script dictionary for each button. The runtime now filters dictionary entries by prefix, matches pattern literals in order, and translates only the arguments it uses.

## 2026.11.23-99 (2026-11-23)

### Fixed

- Topics before a colon in upgrade descriptions can now be translated on their own. Scripts register shared topics with their existing language keys, so the upgrade screen can translate them regardless of script load order. ([#163](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/163))

## 2026.11.23-98 (2026-11-23)

### Fixed

- Aligning several thousand plain sentences after putting only the translated lang files back scored word associations in every cell of the band. The browser's main thread ran for minutes and the tab reported that the page was not responding. A long series now aligns by placeholders and length only, and the scan yields back to the page while it works ([#162](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/162))

## 2026.11.23-97 (2026-11-23)

### Fixed

- Converting again with only the translated lang files rechecked every previous key in the same series for every new sentence. A series of several thousand entries stalled the scan on UI and script files. Claims now look only at the nearby index, and a sentence that does not match is still left unmatched ([#161](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/161))

## 2026.11.23-96 (2026-11-23)

### Fixed

- On the adapter learning monitor, `% learned` swallowed the whole row after newlines were turned into spaces, so the translation of "learned" moved in front of the description and the bar no longer sat on its own line. A row that already translates on its own keeps the original line break ([#160](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/160))
- A color code in front of a challenge goal let `with … selected` swallow `- Goal:`, which came out as the ability name first and the goal still in English. The line is matched again with the color code removed, so the goal and `blocks swum underwater` translate separately ([#160](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/160))
- The power archive collapses repeated spaces, so `DOSSIER 01 / ALL POWERS` and `Scroll to browse powers` missed and only the last "powers" was replaced. The same pattern is also stored with the spaces collapsed ([#160](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/160))
- When a dossier page starts in the middle of a paragraph, each sentence is registered on its own. A finished sentence on that line translates; a sentence that continues on the next page stays as written ([#160](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/160))
- Action-bar `ready` and the learning monitor's `LOCKED` / `RETAINED` are registered. A status word after a bar still matches when nothing else on that line is a word ([#160](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/160))
- The action bar cuts a repeated ability name off the front of a message, and `Blink` was cutting into `Blinked`, leaving `ed 5 blocks!`. The ability name now has to end on a word boundary ([#160](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/160))

## 2026.11.23-95 (2026-11-23)

### Fixed

- A handbook page titled with a trailing ` (continued)` no longer matched the original title. The word in parentheses is registered, and the title is matched first ([#159](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/159))
- The power archive wraps text at 62 columns, cutting a sentence in the middle. Consecutive non-blank lines are joined with spaces and matched again ([#159](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/159))
- Adapter progress `0% learned` was dropped after the percent sign moved into the argument, because `learned` looked like it was not a sentence. It is registered now ([#159](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/159))
- A leading `+ ` on the grant button kept `GRANT … to …` from matching. The prefix stays, and the sentence after it is translated ([#159](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/159))

## 2026.11.23-94 (2026-11-23)

### Fixed

- Items hidden from the creative inventory whose names contain color codes (Hulk ability items such as `Hulk · Calm Down`) are still held by the player. Those names are extracted. Technical items with no color code are still skipped ([#158](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/158))
- A prize description followed by ` · 300s` did not match as a whole. The description before that suffix is translated first ([#158](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/158))
- `Lucky Shot - Luck 1` inside a reward line's argument did not match. Translating an argument is no longer blocked by the outer match ([#158](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/158))
- A literal `%` elsewhere in a sentence that has arguments (for example `train 20% → 80%`) is no longer written as `%%`, so a custom form does not draw two percent signs ([#158](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/158))

## 2026.11.22-93 (2026-11-22)

### Fixed

- Identifier fragments with no space, such as `prefix + "_seconds"` and `kind + "Push"`, were registered as patterns (`%1$s_seconds`, `%1$sPush`). Those fragments are no longer registered ([#157](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/157))
- Keys in a move's explanation table (`pull`, `push`) are shown on the number line as `Pull` and `Push`. Those labels are registered, so `Pull: 0.3` can match ([#157](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/157))

## 2026.11.22-92 (2026-11-22)

### Fixed

- A second `- Goal:` pattern that ends with a period cut the objective at that period, so the sentence no longer matched its own pattern and stayed in the original language. The period is tried as part of the argument ([#156](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/156))
- Short patterns such as `%1$s power` and `%1$s unlocked from this power` cut buttons and descriptions in the middle of a word (`About your power`, `Not unlocked from this power`). When the full sentence is registered, that sentence is used ([#156](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/156))
- Unit words after a move's numbers (`health`, `blocks`, `seconds`) stayed in the original language. Those units are registered, so a value like `3 health` can match ([#156](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/156))
- `How long {x} lasts before ending.` is only shown after `{x}` is replaced, so the brace form never matched. The filled-in sentence matches as a pattern, and the word that replaces `{x}` is registered too ([#156](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/156))
- When an upgrade line uses `I → II` instead of digits, the name before the colon is registered too ([#156](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/156))
- `${n}%` became `%%` inside a translation that has arguments, and a custom form drew both percent signs. That one percent sign stays on the argument ([#156](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/156))

## 2026.11.22-91 (2026-11-22)

### Fixed

- When a custom form stores its body and later hands it to a real form, the whole text was registered as one pattern, and a short button label swallowed the following sentence. Each line is now registered on its own, and it still matches after a light background replaces `§8` with `§7` ([#155](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/155))
- A skill action bar that joins a name, an ability, and `§a [READY]` (or `§7 [3s]`) on one line did not match. Those status tokens are registered, and the line is translated piece by piece ([#155](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/155))
- A leading `- Goal:` swallowed the whole objective into a placeholder. A more specific pattern is used, so the objective text is no longer left in the original language ([#155](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/155))
- Personality buttons such as `§aManiac challenges` were skipped because, once the color code was removed, only one lowercase word remained ([#155](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/155))
- When an upgrade line uses `2 to 3` or `25 resource` instead of an arrow, the name before the colon is registered too, so the name after `Applies to:` can match ([#155](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/155))

## 2026.11.21-90 (2026-11-21)

### Improved

- When an older `setLore` cannot use translation keys, the log suggests "Bake Simplified Chinese" ([#138](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/138))

### Fixed

- Writing JSON back turned decimals such as `1.0` and `0.0` into integers, so float entity properties became invalid and later properties went missing (scripts reported "Property … does not exist") ([#144](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/144))
- Pattern text shown after the author replaced `·` `→` etc. with ASCII, and titles with a leading number (e.g. "01  Unstable Sneeze - Practice 1"), were not matched ([#143](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/143))
- On full-page text, one pattern could swallow neighbouring lines into its arguments; text that the UI turns into ASCII (`—` `·` `→`) before showing was not matched; the part before the colon of upgrade descriptions, cut out by code ("Applies to: …"), had no translation ([#142](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/142))
- Pages that scripts build by joining a title, several paragraphs and a footer were not matched to translations (e.g. ability guide pages); all-caps titles, "label: value" lines and `->` used instead of `→` are matched too ([#141](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/141))
- Hover text shown through property_bag in custom UIs (e.g. "Face Slot" in a trinket screen) was not listed; it is now listed for manual translation ([#140](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/140))
- Text arguments in messages the author builds with translation keys (`{translate, with:["Wall"]}`) were not translated ([#139](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/139))
- IDs shown directly in messages (`Slot: ${slot}`) could not be translated; they are now registered as translatable words, IDs used in logic are unaffected ([#139](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/139))
- Selectors such as `@s` in `title … actionbar` text were written into lang as text, so the player name no longer showed ([#138](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/138))
- UI comparisons on `$variables` (e.g. `$temp_container_title = '…'`) were not detected, so baking Chinese broke custom container screens ([#138](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/138))
- Titles used by scripts to send data to a custom HUD (read by prefix and character position) were turned into translation keys, so the UI could not read them ([#137](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/137))

## 2026.11.19-82 (2026-11-19)

### Improved

- When both the resource pack and the behavior pack have lang files, the resource pack wins (the game only reads text from resource packs) ([#134](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/134))

### Fixed

- Script messages that reference lang keys with `%key` (e.g. `§7%stats.total:`) were extracted as text and became `%%` in lang, breaking the reference ([#136](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/136))
- A manifest.json with an extra `}` at the end made the whole pack be skipped (the game reads it fine); the log now warns when a manifest cannot be read ([#135](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/135))
- If the manifest sets the pack name/description directly but the lang files also have pack.name, the manifest now wins and the old line is removed ([#134](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/134))
- Renaming custom item names in a world did not update `@e[type=item,name=…]` in commands, breaking map logic ([#133](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/133))

## 2026.11.18-78 (2026-11-18)

### New

- Added this changelog; click the version number in the page footer to open it ([#127](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/127))

### Improved

- Keys filled into other language files keep the section comments and inline notes from the English file, in the original order ([#132](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/132))
- The visitor counter now uses Vercount (keeps the old Busuanzi numbers); shows -- instead of disappearing when the service is down ([#125](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/125))

### Fixed

- .mcfunction files using only `\r` line breaks made processing a world's packs fail (Cannot read properties of null) ([#131](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/131))
- Display text joined with underscores in commands (e.g. "Spawnpoint_Save") was not extracted ([#130](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/130))
- Punctuation-only messages ("???", "...") were not extracted, so other languages could not use their own form ([#129](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/129))
- Processing a world failed with "t is not a function" when a book page went over the length limit ([#126](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/126))
- Added a site icon; no more favicon.ico 404 in the console ([#124](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/124))

## 2026.11.17-70 (2026-11-17)

### New

- The tool is now called Localizator for MCBE in the English, Japanese, Korean and Russian UI ([#119](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/119))
- Bilingual (Chinese/English) bug report template on GitHub ([#121](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/121))

### Improved

- Notes, "not localizable" reasons, editor categories and locations now follow the UI language ([#122](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/122))
- Scoreboard display names are a separate category, hidden by default ([#117](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/117))

### Fixed

- Renaming an entity in a world did not update the name argument of summon commands, breaking map logic ([#123](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/123))
- Importing a sheet failed for multi-line translations without quotes ([#118](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/118))
- With "only unedited" checked, the exported sheet still contained edited rows ([#120](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/120))

## 2026.11.16-64 (2026-11-16)

### New

- Vanilla name table now covers 17 languages, so add-ons written in other languages match vanilla names ([#115](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/115))

### Improved

- The manual-translation export merges identical source texts into one row ([#113](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/113))
- Better detection of debug output; ASCII HUD fields that would break if edited are no longer listed for manual translation ([#116](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/116))

### Fixed

- Commands stored in a constant before runCommand were extracted as text ([#114](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/114))

## 2026.11.15-60 (2026-11-15)

### Fixed

- JSZip now ships with the site, fixing "JSZip is not defined" on flaky networks ([#112](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/112))

## 2026.11.14-59 (2026-11-14)

### New

- Add-on authors' own localizeText(player, …) now picks the existing translation for the player's language ([#111](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/111))

### Improved

- Lines identical to the source in a target language are moved to the to-translate section ([#108](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/108))
- Words separated by selection marks or slashes are translated piece by piece; enchantment ID table ([#106](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/106), [#107](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/107))
- Dropdown options built from object keys are registered for translation ([#109](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/109))

### Fixed

- Molang expressions, pipe-separated data records and key enums were extracted ([#105](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/105))
- New keys referenced by %key in names contained a colon and showed up as raw keys ([#110](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/110))

## 2026.11.13-51 (2026-11-13)

### New

- Identical source texts merged into one row in manual translation; renaming an entity in a world updates name= selectors and scripts that look it up by name ([#95](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/95), [#99](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/99))
- Written book pages in loot and trade tables become translation keys ([#92](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/92))

### Improved

- Item/entity names reuse existing keys instead of creating _1; item.x and item.x.name share one key ([#96](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/96), [#97](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/97))
- Reconverting with only the translated lang aligns keys with the previous run, fixing shifted translations ([#103](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/103))
- Newline warnings are collapsed; unspawnable projectiles no longer get placeholder names ([#98](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/98))
- The log shows a possible maximum game version ([#94](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/94))

### Fixed

- Library text (licences, compiler errors, log tags…), command strings and ID-only arguments were extracted ([#93](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/93), [#101](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/101), [#102](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/102))
- Variables used by text_tts and options built from ID lists were missed ([#100](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/100), [#104](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/104))

## 2026.11.12-37 (2026-11-12)

### New

- The processing log follows the UI language (Traditional Chinese / English / Japanese / Korean / Russian) ([#84](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/84), [#90](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/90))
- World mode: list/remove unused, duplicate or broken packs and map-editing tools; detects older versions of the same add-on ([#82](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/82), [#85](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/85), [#86](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/86), [#87](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/87))
- Sponsor button in the top bar ([#83](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/83))

### Improved

- Lore written as translation keys is restored when scripts read it back, avoiding repeated appends ([#78](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/78))
- When command-block say/me becomes tellraw, the sender name becomes a translation key too ([#81](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/81), [#91](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/91))

### Fixed

- Converting a world again overwrote translations put back earlier ([#89](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/89))
- (+DATA) lore markers, equipment slot names and function commands in command fields were extracted ([#80](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/80), [#88](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/88))
- Names were shown twice when the name key also had a description line ([#79](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/79))

## 2026.11.11-22 (2026-11-11)

### New

- Shows the minimum game version and the manifest version in the log ([#59](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/59), [#60](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/60))
- Built-in vanilla name table; supports script functions that turn IDs into English names ([#64](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/64))
- Reconverting reuses translated lang files; downloaded manual translations can still be written back after editing ([#75](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/75))
- Imported rows are marked as edited; unused old keys in put-back lang files are removed ([#77](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/77))
- /me commands become tellraw; the world name can be edited ([#69](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/69))
- Items in item frames, glow item frames and dropped items are extracted ([#61](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/61))
- "Bake Simplified Chinese" option (Simplified Chinese UI only) for plain-text-only spots such as name tags ([#74](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/74))

### Improved

- The sheet includes keys that exist in the pack but have no translation yet ([#67](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/67))
- Missed text in crosshair block names, UI hover tips, quest screens and reward item names ([#72](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/72), [#73](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/73), [#76](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/76))
- RPG-style scripts: text showing as [object Object], action bar, item descriptions, colour codes in formatted text ([#62](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/62), [#65](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/65), [#66](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/66))
- Script dictionary entries reuse existing keys with the same text in the resource pack lang ([#63](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/63))

### Fixed

- A minimap drawn with glyphs hung the script (watchdog) ([#56](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/56))
- Text in fixed-length ASCII HUDs was translated and broke the display ([#57](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/57))
- Leftover template entries in lang files; %% doubled in lang; hidden block names missed ([#58](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/58), [#68](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/68), [#70](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/70), [#71](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/71))

## 2026.11.10-13 (2026-11-10)

### New

- Redesign: two-column layout, multilingual UI, LED visitor counter ([#50](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/50), [#51](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/51))
- Manual-translation texts in add-ons can be edited on the page, or exported to a sheet and written back ([#49](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/49))
- Behavior/resource packs inside a world are extracted too (NPC dialogue, functions, scripts) ([#45](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/45))
- Option to extract items hidden from the creative inventory ([#55](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/55))
- README rewritten as a user guide, English version and MIT licence added ([#53](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/53))

### Improved

- Script dictionaries split into one file per language are separated automatically ([#52](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/52))
- Debug output, developer notes and internal IDs are no longer extracted ([#54](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/54))

### Fixed

- Reconverting a converted pack injected and extracted twice; reconverting a world overwrote the earlier translation pack ([#42](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/42), [#44](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/44), [#47](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/47))
- Missing dialogue for custom NPC entities and New Recipe toasts; English sentences containing function/return were skipped ([#43](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/43), [#46](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/46), [#47](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/47))
- Item description keys (unsupported in game) were still listed; @attributes key references were extracted ([#48](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/48))

## 2026.11.09-10 (2026-11-09)

### New

- When converting several add-ons together, text goes to each pack's own resource pack ([#39](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/39))
- Structure files in add-ons can be edited or imported from a sheet ([#40](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/40))
- Option to list command block names before converting ([#37](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/37))

### Fixed

- The page froze after analysing large worlds with thousands of entries ([#38](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/38))
- Text in ternaries, joined lists and skill panel stat lines were missed ([#32](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/32), [#33](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/33), [#34](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/34), [#35](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/35))
- Templates that build translation keys were extracted ([#36](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/36))
- Error message when page files are partially loaded; write-back path for root-level structure packs ([#41](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/41))

## 2026.11.08-08 (2026-11-08)

### New

- Lectern book titles listed for manual translation ([#24](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/24))

### Improved

- The "not localizable" report drops false positives, technical markers and duplicates ([#29](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/29))

### Fixed

- Script dictionaries registered per language were not separated ([#28](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/28), [#30](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/30))
- %key references, keys with accented letters and commands like event entity were extracted as text ([#25](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/25), [#26](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/26), [#27](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/27), [#31](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/31))

## 2026.11.07-21 (2026-11-07)

### New

- First release: extracts player-visible text from add-ons and generates multilingual lang files ([#1](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/1), [#2](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/2))
- Merges built-in script translation tables into each language's lang; exports an input alias table ([#3](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/3), [#4](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/4), [#5](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/5), [#7](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/7), [#8](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/8))
- World page: extracts signs, command blocks and NPC text and generates a resource pack ([#9](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/9))
- World NBT editor: edit untranslatable text, import/export sheets, search and browse; supports .mcstructure and player data ([#10](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/10), [#11](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/11), [#12](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/12))
- Written book text, say/tell and boss bar names become translation keys; long books are split into pages ([#13](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/13), [#14](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/14), [#17](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/17), [#19](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/19))
- Choose which categories to extract ([#18](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/18))

### Fixed

- Browser cache mixing old and new files ([#6](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/6))
- UI labels showing keys, mixed %1$s/%s, indented multi-line text and arguments in messages ([#1](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/1), [#20](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/20), [#21](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/21), [#22](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/22), [#23](https://github.com/zanesu154-rgb/tianji-turn-addon/pull/23))
