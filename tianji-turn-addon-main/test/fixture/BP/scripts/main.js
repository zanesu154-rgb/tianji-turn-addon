import { world, system } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { SHOP_ITEMS, RANKS } from "./data.js";
import { Menu } from "./menu.js";

const PREFIX = "§l§6[天机]§r ";

function getMoney(p) { return p.getDynamicProperty("money") ?? 0; }

export function openShop(player) {
  const form = new ActionFormData()
    .title("§l天机商店")
    .body(`你好，${player.name}！你有 ${getMoney(player)} 金币。`);
  for (const item of SHOP_ITEMS) {
    form.button(item.name, item.icon);
  }
  form.button("关闭");
  return form.show(player).then(res => {
    if (res.canceled) return;
    const item = SHOP_ITEMS[res.selection];
    if (!item) return;
    if (getMoney(player) < item.price) {
      player.sendMessage(PREFIX + "§c金币不足！");
      return;
    }
    player.sendMessage(`§a购买成功：${item.name} ×1`);
    player.runCommand(`give @s ${item.id} 1`);
    player.runCommand(`title @s actionbar 已购买 ${item.name}`);
    player.onScreenDisplay.setTitle("购买成功", { subtitle: "欢迎再来", fadeInDuration: 10 });
  });
}

export function settings(player) {
  return new ModalFormData().title("设置")
    .toggle("开启音效", { defaultValue: true, tooltip: "是否播放音效" })
    .dropdown("难度", ["简单", "普通", "困难"])
    .slider("音量", 0, 100, { valueStep: 1 })
    .textField("昵称", "请输入昵称", { defaultValue: "Steve" })
    .show(player);
}

export function confirm(player) {
  const mf = new MessageFormData();
  mf.title("确认");
  mf.body(RANKS[0].desc);
  mf.button1("是");
  mf.button2("否");
  return mf.show(player);
}

export function menu(player) {
  new Menu().title("自定义菜单").open(player);
}

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn) return;
  const msg = "欢迎 " + player.name + " 加入服务器";
  world.sendMessage(msg);
  player.sendMessage({ rawtext: [{ text: "这是一条 rawtext 消息" }, { translate: "my.existing.key" }] });
  player.runCommand("tellraw @s {\"rawtext\":[{\"text\":\"首次进入\"}]}");
  player.nameTag = "新玩家";
  const tips = ["提示：按住潜行打开菜单", "Tip: sneak to open the menu"];
  player.sendMessage(tips[0]);
  player.sendMessage(tips[1]);
  if (player.hasTag("admin")) player.sendMessage(player.isOp() ? "管理员模式" : "普通模式");
  player.sendMessage("第一行\n第二行");
});

system.runInterval(() => {
  for (const p of world.getAllPlayers()) {
    p.onScreenDisplay.setActionBar("§e金币：" + getMoney(p));
  }
}, 20);

world.beforeEvents.chatSend.subscribe(ev => {
  if (ev.message === "!shop") { ev.cancel = true; system.run(() => openShop(ev.sender)); }
});

const cmds = ["title @a title 服务器即将重启", "say hello"];
export function broadcast() { for (const c of cmds) world.getDimension("overworld").runCommand(c); }
