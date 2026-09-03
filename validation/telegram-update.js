import { z } from 'zod';

const telegramId = z.number().int().safe();
const boundedText = (max) => z.string().max(max);
const user = z.object({
  id: telegramId,
  first_name: boundedText(128).optional(),
  last_name: boundedText(128).optional(),
  username: boundedText(64).optional(),
}).passthrough();
const chat = z.object({ id: telegramId }).passthrough();
const message = z.object({
  message_id: z.number().int().nonnegative(),
  from: user,
  chat,
  text: boundedText(4096).optional(),
}).passthrough();
const callbackQuery = z.object({
  id: boundedText(256).min(1),
  from: user,
  data: boundedText(64).optional(),
  message: message.optional(),
}).passthrough();
const update = z.object({
  update_id: z.number().int().nonnegative(),
  message: message.optional(),
  callback_query: callbackQuery.optional(),
}).passthrough().refine(
  (value) => Boolean(value.message) !== Boolean(value.callback_query),
  { message: 'exactly one supported Telegram update payload is required' },
);

export function parseTelegramUpdate(value) {
  const result = update.safeParse(value);
  return result.success ? result.data : null;
}
