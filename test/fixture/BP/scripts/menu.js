import { ActionFormData } from "@minecraft/server-ui";

// 用户自己封装的菜单类，方法名和 server-ui 的 title() 撞名
export class Menu {
  constructor() { this.form = new ActionFormData(); this.t = ""; }
  title(t) { this.t = "§l" + t; return this; }
  open(player) {
    this.form.title(this.t);
    this.form.button("返回");
    return this.form.show(player);
  }
}
