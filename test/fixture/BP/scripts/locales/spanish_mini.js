const DIALOGUE_DATA = [
	{"s":"Good afternoon, ${name}.","v":"Buenas tardes, ${name}.","d":true},
	{"s":"${targetName} is my only one.","v":"${targetName} es lo único que tengo.","d":true},
	{"s":"Afternoon. What do you need?","v":"Buenas tardes. ¿Qué necesitas?","d":false},
	{"s":"You can ask me anything. I know everything.","v":"Puedes preguntarme lo que sea. Lo sé todo.","d":false},
];
const CURATED_OUTPUT = new Map([["Ouch!", "¡Ay!"], ["That hurt!", "¡Eso dolió!"], ["I'm here.", "Aquí estoy."], ["Run.", "Corre."]]);
CURATED_OUTPUT.set("Moron.", "¡Eres un idiota!");
CURATED_OUTPUT.set("Trash.", "Basura.");
CURATED_OUTPUT.set("Evening. I'm listening.", "Buenas noches. Te escucho.");
const NAMES = Object.freeze({ "end portal": "portal del End", "ocean monument": "monumento oceánico", "ancient city": "ciudad antigua", "nether fortress": "fortaleza del Nether" });
const OUTPUT_RULES = [
	[/^(\d+) out of (\d+) hearts\.$/, (_, a, b) => `${a} de ${b} corazones.`],
	[/^You're at (X .+) in (.+)\.$/, (_, c, d) => `Estás en ${c}, en ${name(d)}.`],
	[/^(.+) left the (.+)\.$/, (_, who, where) => `${who} salió de ${where}.`],
];
const INPUT_TERMS = new Map([["aldea", "village"], ["fortaleza", "stronghold"], ["portal del end", "end portal"]]);
function name(v) { return NAMES[v] || v; }
export function out(s) { return CURATED_OUTPUT.get(s) || s; }
