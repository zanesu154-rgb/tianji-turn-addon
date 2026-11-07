// 生成一个最小的测试存档（不含任何个人信息）：本地玩家背包里有成书、书与笔和命名物品，末影箱的潜影盒里也有一本书
// 用法：node test/make-world.js 输出目录
const fs = require('fs'), path = require('path');
const { NS } = require('./load');
const { T, NbtString, writeAll } = NS.NBT;
const S = (n, s) => ({ t: T.STRING, n, v: new NbtString(s, null) });
const I = (n, v) => ({ t: T.INT, n, v });
const B = (n, v) => ({ t: T.BYTE, n, v });
const C = (n, v) => ({ t: T.COMPOUND, n, v });
const L = (n, et, items) => ({ t: T.LIST, n, v: { et, items } });
const book = (slot, title, page) => [B('Count', 1), S('Name', 'minecraft:written_book'), B('Slot', slot),
  C('tag', [S('author', 'Tester'), S('title', title), L('pages', T.COMPOUND, [[S('photoname', ''), S('text', page)]])])];
const named = (slot, id, name) => [B('Count', 1), S('Name', id), B('Slot', slot), C('tag', [C('display', [S('Name', name)])])];
const shulker = (slot, inner) => [B('Count', 1), S('Name', 'minecraft:shulker_box'), B('Slot', slot), C('tag', [L('Items', T.COMPOUND, inner)])];
const player = [
  S('identifier', 'minecraft:player'),
  L('Inventory', T.COMPOUND, [book(0, '冒险日志', '第一天：我来到了这片大陆。'), named(1, 'minecraft:iron_sword', '勇者之剑'),
    [B('Count', 1), S('Name', 'minecraft:writable_book'), B('Slot', 2), C('tag', [L('pages', T.COMPOUND, [[S('photoname', ''), S('text', '草稿：还没写完。')]])])]]),
  L('EnderChestInventory', T.COMPOUND, [shulker(0, [book(0, '秘密笔记', '宝藏在出生点下面。')])]),
  L('Armor', T.COMPOUND, [named(0, 'minecraft:iron_helmet', '守卫头盔')]),
  L('Pos', T.FLOAT, [0.5, 64, 0.5]),
];
const lectern = [C('book', [B('Count', 1), I('Damage', 0), S('Name', 'minecraft:written_book'), B('WasPickedUp', 0),
  C('tag', [S('author', 'Tester'), I('generation', 0), S('title', '讲台之书'), L('pages', T.COMPOUND, [[S('photoname', ''), S('text', '讲台上的第一页。')], [S('photoname', ''), S('text', '讲台上的第二页。')]])])]),
  B('hasBook', 1), S('id', 'Lectern'), B('isMovable', 1), I('page', 0), I('totalPages', 2), I('x', 3), I('y', 64), I('z', 2)];
const sign = [C('FrontText', [S('Text', '欢迎'), S('TextOwner', '')]), C('BackText', [S('Text', ''), S('TextOwner', '')]), S('id', 'Sign'), I('x', 1), I('y', 64), I('z', 2)];

// ---- LevelDB：CURRENT + MANIFEST（一条 VersionEdit）+ 日志（一条 WriteBatch）----
const varint = (arr, v) => { while (v >= 0x80) { arr.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } arr.push(v); };
const edit = [];
const cmp = Buffer.from('leveldb.BytewiseComparator');
edit.push(1); varint(edit, cmp.length); edit.push(...cmp);
edit.push(2); varint(edit, 2);   // log_number
edit.push(3); varint(edit, 3);   // next_file_number
edit.push(4); varint(edit, 0);   // last_sequence
const logRecord = (payload) => {
  const crc = NS.LevelDB.maskCrc(NS.LevelDB.crc32c(payload, NS.LevelDB.crc32c(Uint8Array.of(1))));
  return Buffer.concat([Buffer.from([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24, payload.length & 0xff, payload.length >>> 8, 1]), Buffer.from(payload)]);
};
const chunkKey = (x, z, tag) => { const b = Buffer.alloc(9); b.writeInt32LE(x, 0); b.writeInt32LE(z, 4); b[8] = tag; return b; };
const puts = [
  { key: Buffer.from('~local_player'), value: writeAll([{ t: T.COMPOUND, n: '', v: player }]) },
  { key: chunkKey(0, 0, 49), value: writeAll([{ t: T.COMPOUND, n: '', v: sign }, { t: T.COMPOUND, n: '', v: lectern }]) },
];
const batch = [1, 0, 0, 0, 0, 0, 0, 0, puts.length, 0, 0, 0];   // 序列号 1
for (const p of puts) { batch.push(1); varint(batch, p.key.length); batch.push(...p.key); varint(batch, p.value.length); batch.push(...p.value); }

const out = process.argv[2];
fs.mkdirSync(path.join(out, 'db'), { recursive: true });
fs.writeFileSync(path.join(out, 'db', 'CURRENT'), 'MANIFEST-000001\n');
fs.writeFileSync(path.join(out, 'db', 'MANIFEST-000001'), logRecord(Uint8Array.from(edit)));
fs.writeFileSync(path.join(out, 'db', '000002.log'), logRecord(Uint8Array.from(batch)));
const body = writeAll([{ t: T.COMPOUND, n: '', v: [S('LevelName', '测试世界'), I('StorageVersion', 10)] }]);
const head = Buffer.alloc(8); head.writeInt32LE(10, 0); head.writeInt32LE(body.length, 4);
fs.writeFileSync(path.join(out, 'level.dat'), Buffer.concat([head, Buffer.from(body)]));
fs.writeFileSync(path.join(out, 'levelname.txt'), '测试世界');
fs.writeFileSync(path.join(out, 'world_resource_packs.json'), '[]');
