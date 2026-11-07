// 生成测试用 .mcstructure：告示牌、命令方块、箱子（带命名物品）、NPC
// 用法：node test/make-structure.js 输出路径
const fs = require('fs');
const { NS } = require('./load');
const { T, NbtString, writeAll } = NS.NBT;
const S = (n, s) => ({ t: T.STRING, n, v: new NbtString(s, null) });
const I = (n, v) => ({ t: T.INT, n, v });
const B = (n, v) => ({ t: T.BYTE, n, v });
const C = (n, v) => ({ t: T.COMPOUND, n, v });
const L = (n, et, items) => ({ t: T.LIST, n, v: { et, items } });
const signSide = (text) => [S('FilteredText', ''), B('HideGlowOutline', 0), B('IgnoreLighting', 0), B('PersistFormatting', 1), I('SignTextColor', -16777216), S('Text', text), S('TextOwner', '')];
const sign = [C('BackText', signSide('Welcome to the village')), I('BlockEntityVersion', 0), C('FrontText', signSide('欢迎来到村庄\n请勿破坏')), B('IsWaxed', 0), S('id', 'Sign'), I('x', 0), I('y', 0), I('z', 0)];
const cmd = [S('Command', '/title @a actionbar 结构中的命令方块'), S('CustomName', ''), S('id', 'CommandBlock'), I('x', 1), I('y', 0), I('z', 0)];
const chest = [S('CustomName', '村长的箱子'), S('id', 'Chest'), I('x', 2), I('y', 0), I('z', 0),
  L('Items', T.COMPOUND, [[B('Count', 1), S('Name', 'minecraft:diamond_sword'), B('Slot', 0), C('tag', [C('display', [S('Name', '村长的剑'), L('Lore', T.STRING, [new NbtString('传家之宝', null)])])])]])];
const npc = [S('identifier', 'minecraft:npc'), S('CustomName', 'NPC'), S('RawtextName', '村长'), S('InterativeText', '你好，旅行者！'),
  S('Actions', JSON.stringify([{ button_name: '告别', data: [{ cmd_line: '/title @initiator title 再见', cmd_ver: 55 }], mode: 0, text: '/title @initiator title 再见\n', type: 1 }], null, 3).replace(/": /g, '" : ') + '\n'),
  L('Pos', T.FLOAT, [0.5, 1, 0.5]), { t: T.LONG, n: 'UniqueID', v: -12345n }];
const blockState = (name) => [S('name', name), C('states', []), I('version', 18168865)];
const root = [
  I('format_version', 1),
  L('size', T.INT, [3, 2, 1]),
  C('structure', [
    L('block_indices', T.LIST, [{ et: T.INT, items: [0, 4, 1, 4, 2, 4] }, { et: T.INT, items: [-1, -1, -1, -1, -1, -1] }]),
    L('entities', T.COMPOUND, [npc]),
    C('palette', [C('default', [
      L('block_palette', T.COMPOUND, [blockState('minecraft:standing_sign'), blockState('minecraft:command_block'), blockState('minecraft:chest'), blockState('minecraft:stone'), blockState('minecraft:air')]),
      C('block_position_data', [C('0', [C('block_entity_data', sign)]), C('2', [C('block_entity_data', cmd)]), C('4', [C('block_entity_data', chest)])]),
    ])]),
  ]),
  L('structure_world_origin', T.INT, [0, 0, 0]),
];
fs.writeFileSync(process.argv[2], writeAll([{ t: T.COMPOUND, n: '', v: root }]));
