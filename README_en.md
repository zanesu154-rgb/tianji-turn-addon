# Bedrock Add-on Localization Tool

English · [简体中文](README.md)

Extracts the player-visible text from Minecraft Bedrock **add-ons** and **worlds**, replaces it with translation keys, and generates `.lang` files. Once the lang files are translated, the same add-on or map shows text in each player's game language.

**Use it online:** <https://zanesu154-rgb.github.io/tianji-turn-addon/>

- A pure web tool: everything runs in your browser and **files are never uploaded** to any server
- Works on phones and computers; the interface is available in 简体中文, 繁體中文, English, 日本語, 한국어 and Русский

---

## Quick start

### Translate an add-on

1. Open the page and choose the **Add-on** tab.
2. Upload a `.mcaddon`, `.mcpack` or `.zip` (or drag it onto the page).
3. Wait for the progress bar to finish and check the summary.
4. Click **Download converted file** to get `<name>_i18n.mcaddon`.
5. Click **Download translation sheets**; it contains `source_<lang>.lang` (all original text) and `strings.csv`.
6. Translate the text into the target language, put it in the matching file under the resource pack's `texts/` folder (e.g. `fr_FR.lang`), and import the add-on into the game again.

> ⚠ Always convert the **original** add-on. Converting an already converted add-on does not fix earlier extraction results.

### Translate a world or structure

1. Choose the **World** tab.
2. Upload a `.mcworld`, `.mctemplate` (on mobile you can export a world as a template) or `.mcstructure`.
3. Signs, command blocks, NPCs, written books and more are converted to translation keys automatically. Text where the game does not support keys (container names, item names, etc.) is listed in the editor below, where you can change it to the target language directly.
4. Click **Download converted file**. The world gets its own translation pack, `resource_packs/<world name>_texts/`, which loads automatically; translate its lang files.

> ⚠ Back up your world before processing it.

---

## Options

| Option | Description |
|---|---|
| Source language | The original language of the add-on. Auto-detected by default |
| Lang files to generate | Comma-separated list such as `en_US, zh_CN, ja_JP`. `en_US` (the game's fallback language) and any languages already in the pack are always generated |
| say / tell commands | The game does not translate `say`. By default it is converted to `tellraw` (looks the same, with the `[sender]` prefix); it can also become a screen title, a message above the hotbar, or be left as is |
| Built-in script translation fields | When scripts contain their own translation tables, leave empty to auto-detect. If detection is wrong, specify fields manually (`s=en_US, v=vi_VN`) or per file (`dialogue_es.js:v=es_ES`); `off` disables it |
| Process scripts / Inject runtime translation | Whether to process `scripts/*.js`. Runtime translation handles text stored in variables and data tables; keep it on |
| Fill missing keys from other languages | Copies missing keys from another language so the game never shows raw key names |
| Generate placeholder names | Generates English names from IDs for unnamed items / blocks / entities (skipped for items hidden from the creative inventory) |
| List command block names | Map authors often name command blocks as notes, so these are not listed for manual translation by default |
| Split multi-line text into separate keys | By default one paragraph is one key, with line breaks written as `\n` (confirmed to work in game) |

---

## What gets extracted

### Add-ons

| Location | Content |
|---|---|
| Items, blocks, entities | Names, boss bar names, interact button text, trade tables |
| NPC dialogue (`dialogue/`) | Names, text, buttons |
| Commands in functions, animation controllers and entity events | `title` / `titleraw` / `tellraw`; `say` per the option above |
| JSON UI (`ui/`) | Text shown in the interface; variables used inside expressions are left alone so the UI keeps working |
| Scripts (`scripts/`) | Form titles / buttons / bodies, `sendMessage`, `setActionBar`, `setTitle`, `runCommand` and more; text from variables and data tables is translated at runtime |
| Translation tables inside scripts | All language versions of a sentence share one key; existing translations go to the matching lang files |
| `structures/*.mcstructure` | Same as worlds |
| `manifest.json` | Pack name and description |

### Worlds and structures

| Location | Handling |
|---|---|
| Signs and hanging signs | Front and back text become translation keys |
| Command blocks and command block minecarts | `title` / `tellraw`; `say` per the option above |
| NPCs (including custom NPC entities) | Name, text, buttons |
| Written books (in chests, on lecterns, in player inventories) | Each page becomes a translation key |
| Behavior / resource packs bundled with the world | Processed like add-ons (e.g. dialogue used by `/dialogue`) |
| Container names, item names, item lore, name tags, book titles, world name | The game does not support keys here → edit them manually in the editor |

---

## Text that needs manual translation

Some places only accept plain text, such as `set_name` / `set_lore` in loot tables, `nameTag` in scripts, and item and container names in worlds. They appear in the **editor** below the results:

- **Manual translation**: edit each entry directly. Use the category checkboxes at the top to hide categories; hidden categories are not exported either
- **Export / import sheet**: for many entries, click "Export sheet", fill in the `translation` column in Excel or similar, then "Import sheet" to write everything back. Do not change the `ref` column, which records the location
- **Search / Browse all** (worlds): find and edit any NBT data in the world by key or value, e.g. search `CustomName` to rename everything at once

All edits are written back when you click "Download converted file".

Game limits: written books allow at most 256 characters and 14 lines per page, 50 pages, and 16 characters for the title. The editor shows character counts and splits overlong pages automatically.

---

## Downloads

| Button | Content |
|---|---|
| Download converted file | Add-on: `<name>_i18n.mcaddon` (a single .mcpack stays .mcpack); world: the converted world; single structure: a zip with the structure and its translation pack |
| Download translation sheets | `source_<lang>.lang`: all original text, ready to translate<br>`strings.csv`: every key with its text and location, plus existing translations<br>`untranslatable.csv`: text needing manual translation (fill in and import)<br>`input_aliases.csv`: chat keywords matched by scripts, so authors can add phrases in other languages |
| Download log | Detailed processing log; please attach it when reporting a problem |

---

## FAQ

**The game still shows the original text after translating.**
Make sure the translations are in the matching file under the **resource pack's** `texts/` folder (e.g. `fr_FR.lang`) and the resource pack is enabled. Lang files in behavior packs only affect the pack name and description.

**The game shows a key name such as `item.xxx.name`.**
The current language's lang file is missing that key. Re-convert with "Fill missing keys from other languages" turned on, or add the key to that lang file.

**What are `%1$s`, `§a` and `\n` in the lang files?**
`%1$s` is filled in by the game at runtime (player names, numbers, etc.); keep it — you may move it, but **do not change it to `%s`**. `§a` and similar are color codes. `\n` is a line break.

**The add-on's own language setting no longer works.**
After conversion, text follows the game language, so the add-on's own language option mostly has no effect. The translated content itself is unchanged.

**The page shows an old version or asks me to reload.**
GitHub Pages caches files. Force-reload the page or clear the site's cache. The current version is shown at the bottom of the page.

---

## Known limitations

- Obfuscated scripts (with encoded strings) cannot be extracted
- What players type in chat does not go through lang files; chat keywords can only support other languages if the author adds those phrases to the regex
- The processing log and the reasons in reports are currently in Chinese only
- The visit counter uses the third-party service Busuanzi; it only counts page views and never touches your files, and it is hidden if it fails to load

---

## Running locally and development

Open `index.html` in a browser (an internet connection is needed to load JSZip).

```
node test/run-tests.js   # end-to-end tests, requires Node 18+
```

```
index.html / style.css / app.js   UI, zip reading and writing
src/ui-i18n.js        interface languages
src/util.js           text detection, key names, lang reading and writing
src/context.js        key allocation, deduplication, reports
src/commands.js       command rewriting
src/json.js           items, blocks, entities, dialogue, UI, manifest
src/script.js         scripts (AST-based) + runtime translation
src/pipeline.js       add-on pipeline
src/world/            worlds: NBT, LevelDB, conversion, editor
vendor/acorn.js       JavaScript parser
test/                 test add-on and test scripts
```

## License

Released under the [MIT License](LICENSE).

Third-party components: [acorn](https://github.com/acornjs/acorn) (MIT), [JSZip](https://github.com/Stuk/jszip) (MIT or GPLv3; used here under MIT), [JSON5](https://github.com/json5/json5) (MIT).

Minecraft is a trademark of Mojang Synergies AB. This is an unofficial tool and is not affiliated with Mojang or Microsoft.
