import { world } from "@minecraft/server";
const NORMALIZE = [
  [/\b(?:cuántos jugadores|cuantos jugadores|hay alguien más|hay alguien mas|estoy solo)\b/gi, "how many players"],
  [/\b(?:combien de joueurs|je suis seul)\b/gi, "how many players"],
];
const KNOWLEDGE = [
  { patterns: [/\bwhat was the reformation\b/], keywords: ["reformation", "luther", "protestant", "church"], answers: ["The Protestant Reformation split Western Christianity in the 1500s — Martin Luther's 95 Theses challenged papal authority."] },
  { patterns: [/\bhow many players\b/], keywords: ["players", "online"], answers: ["There are a few players online right now."] },
];
world.beforeEvents.chatSend.subscribe(ev => {
  let msg = ev.message.toLowerCase();
  for (const [re, rep] of NORMALIZE) msg = msg.replace(re, rep);
  const hit = KNOWLEDGE.find(k => k.patterns.some(p => p.test(msg)) || k.keywords.some(w => msg.includes(w)));
  if (hit) ev.sender.sendMessage(hit.answers[0]);
});
