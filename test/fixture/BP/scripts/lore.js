import { world } from "@minecraft/server";

// 作者自带的多语言：对象数组的平行字段
const DIALOGUE_DATA = [
	{"s":"Light is electromagnetic radiation visible to the human eye.","v":"Ánh sáng là bức xạ điện từ mà mắt người nhìn thấy được.","d":false},
	{"s":"Torches emit light at level 14 and the sun at level 15.","v":"Đuốc phát sáng ở mức 14 và mặt trời ở mức 15.","d":true},
	{"s":"Water flows downhill when you place it.","v":"Nước chảy xuống dốc khi bạn đặt nó.","d":false}
];

// 按语言代码分组的字典
const LANG = {
  en_US: { welcome: "Welcome to the lab", bye: "See you next time" },
  zh_CN: { welcome: "欢迎来到实验室", bye: "下次见" },
};

// 名称和描述语言不同，但不是互为翻译 —— 不能合并
const ITEMS = [
  { name: "The sword of the king", desc: "一把锋利的剑" },
  { name: "An apple for the brave", desc: "吃了能回血的苹果" },
];

export function lore(player, lang, i) {
  const d = DIALOGUE_DATA[i];
  player.sendMessage(lang === "vi" ? d.v : d.s);
  player.sendMessage(LANG[lang === "zh" ? "zh_CN" : "en_US"].welcome);
  player.sendMessage(ITEMS[0].name + "：" + ITEMS[0].desc);
}
