/**
 * Telegram-бот — ЗАДЕЛ НА БУДУЩЕЕ.
 *
 * Сейчас (REQUIRE_VERIFICATION=none) бот не нужен и спит.
 * Когда появится токен в .env (TELEGRAM_BOT_TOKEN=...), бот проснется,
 * начнет long polling и будет подтверждать заявки командой: /start <КОД>
 *
 * Флоу подтверждения (будущее):
 *   1. Пользователь регистрируется -> сервер создает pending_registrations с кодом.
 *   2. Пользователь жмет ссылку t.me/<бот>?start=<КОД>.
 *   3. Бот получает /start КОД -> пишет telegram_id в заявку.
 *   4. Фронт (polling register/status) видит confirmed -> финализирует регистрацию.
 */

'use strict';

const { stmts } = require('./db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

/** Подтвердить заявку кодом: привязать telegram_id. Возвращает true/false. */
function confirmPendingByCode(code, telegramId) {
  const row = stmts.getPendingByCode.get(code);
  if (!row) return { ok: false, error: 'Код не найден или истек' };
  if (row.telegram_id) {
    // Уже подтверждено — идемпотентно ок
    return { ok: row.telegram_id === telegramId, error: row.telegram_id === telegramId ? null : 'Код подтвержден другим аккаунтом' };
  }
  stmts.confirmTelegram.run(telegramId, code);
  return { ok: true };
}

/** Обработка апдейта Telegram */
async function handleUpdate(update, send) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // /start <КОД> — подтверждение регистрации
  const m = text.match(/^\/start\s+([A-Za-z0-9-]{6,64})$/);
  if (m) {
    const code = m[1].toUpperCase();
    const result = confirmPendingByCode(code, chatId);
    if (result.ok) {
      await send(chatId, '✓ Принято! Возвращайся на сайт — регистрация сейчас завершится.\nПосле этого бота можно заблокировать, он больше не понадобится.');
    } else {
      await send(chatId, `✗ Не вышло: ${result.error}\nПроверь код на странице регистрации.`);
    }
    return;
  }

  if (text === '/start') {
    await send(chatId, 'Кабан бот. Пришли мне код подтверждения со страницы регистрации: /start КОД');
    return;
  }

  await send(chatId, 'Не понял. Код подтверждения выглядит так: /start XXXXXX-XXXXXX-XXXXXX');
}

/** Отправка сообщения */
async function sendMessage(chatId, text) {
  const resp = await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!resp.ok) console.error('[tgbot] sendMessage failed:', resp.status);
}

/** Long polling цикл */
async function pollLoop(offset = 0) {
  try {
    const resp = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`, {
      agent: undefined,
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = Math.max(offset, update.update_id + 1);
          try {
            await handleUpdate(update, sendMessage);
          } catch (e) {
            console.error('[tgbot] update error:', e.message);
          }
        }
      }
    } else {
      console.error('[tgbot] getUpdates failed:', resp.status);
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch (e) {
    console.error('[tgbot] poll error:', e.message);
    await new Promise((r) => setTimeout(r, 3000));
  }
  return pollLoop(offset);
}

/** Запуск бота. Без токена тихо спит. */
function startBot() {
  if (!BOT_TOKEN) {
    console.log('[tgbot] TELEGRAM_BOT_TOKEN не задан — бот спит (это нормально для REQUIRE_VERIFICATION=none)');
    return;
  }
  console.log('[tgbot] запускаюсь (long polling)...');
  pollLoop().catch((e) => console.error('[tgbot] fatal:', e));
}

module.exports = { startBot, confirmPendingByCode };