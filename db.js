// Простое файловое хранилище (JSON). Для старта на 1–несколько пользователей.
// Для роста замените на PostgreSQL — интерфейс функций тот же.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'data.json');

let db = { users: {}, progress: {} };
try {
  db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  // файла ещё нет — начнём с пустой базы
}

let saving = false;
function persist() {
  if (saving) return;
  saving = true;
  setTimeout(() => {
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
    saving = false;
  }, 200);
}

export function getUser(username) {
  return db.users[username] || null;
}
export function createUser(username, hash) {
  db.users[username] = { hash, created: Date.now() };
  db.progress[username] = db.progress[username] || {};
  persist();
}
export function getProgress(username) {
  return db.progress[username] || {};
}
export function saveProgress(username, data) {
  db.progress[username] = data;
  persist();
}

// --- Telegram-вход ---
export function getUserByTelegram(tgId) {
  for (const [name, u] of Object.entries(db.users)) {
    if (u.telegram_id === tgId) return { username: name, ...u };
  }
  return null;
}
export function createTelegramUser(tgId, displayName) {
  let base = (displayName || ('tg' + tgId)).replace(/[^A-Za-zА-Яа-я0-9_]+/g, '_').slice(0, 20) || ('tg' + tgId);
  let uname = base, i = 1;
  while (db.users[uname]) uname = base + '_' + (i++);
  db.users[uname] = { telegram_id: tgId, created: Date.now() };
  db.progress[uname] = db.progress[uname] || {};
  persist();
  return uname;
}
