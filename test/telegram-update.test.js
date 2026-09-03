import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTelegramUpdate } from '../validation/telegram-update.js';

test('Telegram message update accepts bounded identifiers and text', () => {
  const parsed = parseTelegramUpdate({
    update_id: 10,
    message: {
      message_id: 20,
      from: { id: 30, first_name: 'Student' },
      chat: { id: 30 },
      text: '/start code',
    },
  });
  assert.equal(parsed.message.text, '/start code');
});

test('Telegram callback update requires a supported bounded shape', () => {
  const parsed = parseTelegramUpdate({
    update_id: 11,
    callback_query: {
      id: 'callback',
      from: { id: 31 },
      data: 'trial',
      message: { message_id: 21, from: { id: 31 }, chat: { id: 31 }, text: 'menu' },
    },
  });
  assert.equal(parsed.callback_query.data, 'trial');
  assert.equal(parseTelegramUpdate({ update_id: 12 }), null);
  assert.equal(parseTelegramUpdate({
    update_id: 13,
    callback_query: { id: 'x', from: { id: 31 }, data: 'x'.repeat(65) },
  }), null);
});

test('Telegram update rejects unsafe numbers and oversized names', () => {
  assert.equal(parseTelegramUpdate({
    update_id: 14,
    message: {
      message_id: 1,
      from: { id: Number.MAX_VALUE, first_name: 'Student' },
      chat: { id: 1 },
      text: '/start',
    },
  }), null);
  assert.equal(parseTelegramUpdate({
    update_id: 15,
    message: {
      message_id: 1,
      from: { id: 1, first_name: 'x'.repeat(129) },
      chat: { id: 1 },
      text: '/start',
    },
  }), null);
});
