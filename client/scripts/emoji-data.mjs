// Genera src/emoji-data.json para el selector de emojis a partir de emojibase
// (nombres y palabras clave en español). Solo entran los emojis que dibuja la
// fuente Twemoji incluida (hasta Emoji 15.1). Uso: npm run emoji-data
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const data = JSON.parse(readFileSync(require.resolve('emojibase-data/es/data.json'), 'utf8'));
const messages = JSON.parse(readFileSync(require.resolve('emojibase-data/es/messages.json'), 'utf8'));
const MAX_VERSION = 15.1;
const SKIP_GROUPS = new Set([2]); // «componentes»: tonos de piel y pelo sueltos

// Palabras de trabajo que emojibase no recoge, para encontrar rápido el icono
// de una página, acta o lista
const EXTRA = {
  reunión: '🤝 👥 📅 🗓️ 💬 🗣️ 🧑‍💼 📋',
  acta: '📝 📋 🗒️ ✍️ 📑',
  proyecto: '📁 📂 🚀 📋 🗂️ 🎯 🏗️',
  idea: '💡 🧠 ✨ 🌱',
  tarea: '✅ ☑️ 📝 📌 📋',
  bloqueo: '⛔ 🚧 🛑 🚫 🔒 ⚠️',
  problema: '🐛 ⚠️ 🔥 🚨 ❗',
  error: '🐛 ❌ 🚨',
  documento: '📄 📃 📑 📘 📚',
  planificación: '🗓️ 📅 🗺️ 🧭 📈',
  cliente: '🤝 🧑‍💼 🏢 💼',
  empresa: '🏢 🏛️ 💼',
  datos: '📊 📈 🗄️ 💾 🧮',
  seguimiento: '📋 🔎 📌 🎯',
  diseño: '🎨 ✏️ 📐 🖌️',
  código: '💻 🧑‍💻 ⌨️ 🐙 🤖',
  personal: '🏠 ❤️ 🙂',
  viaje: '✈️ 🧳 🗺️ 🏖️',
  dinero: '💰 💶 💳 🏦',
  salud: '🩺 💊 🏥 ❤️‍🩹',
};
const extraFor = new Map();
for (const [word, list] of Object.entries(EXTRA)) for (const ch of list.split(' ')) extraFor.set(ch, [...(extraFor.get(ch) || []), word]);


const emojis = data
  .filter((e) => e.group !== undefined && !SKIP_GROUPS.has(e.group) && e.version <= MAX_VERSION)
  .sort((a, b) => a.order - b.order)
  .map((e) => {
    const out = { e: e.emoji, n: e.label, g: e.group };
    const extra = extraFor.get(e.emoji) || extraFor.get(e.emoji.replace(/\uFE0F/g, '')) || [];
    const tags = [...new Set([...(e.tags || []), ...extra])].filter((t) => !e.label.includes(t));
    if (tags.length) out.k = tags.join(' ');
    // tonos de piel: solo los de un único tono (5), en el orden claro → oscuro
    const skins = (e.skins || []).filter((s) => !Array.isArray(s.tone) && s.version <= MAX_VERSION);
    if (skins.length === 5) out.s = skins.sort((a, b) => a.tone - b.tone).map((s) => s.emoji);
    return out;
  });

const groups = messages.groups
  .filter((g) => !SKIP_GROUPS.has(g.order))
  .map((g) => ({ id: g.order, name: g.message.charAt(0).toUpperCase() + g.message.slice(1) }));

writeFileSync(new URL('../src/emoji-data.json', import.meta.url), JSON.stringify({ groups, emojis }));
console.log(`${emojis.length} emojis en ${groups.length} categorías`);
