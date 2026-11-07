# 注释 title @a title 不要动
title @a title §l游戏开始
  execute as @a[tag=vip,scores={x=1..}] at @s run title @s subtitle VIP 玩家
tellraw @a {"rawtext":[{"text":"倒计时 "},{"score":{"name":"@s","objective":"t"}}]}
scoreboard objectives add kills dummy 击杀数
tag @s add title
title @a times 10 20 10
title "Steve Jobs" actionbar Hello there
say 游戏开始了
