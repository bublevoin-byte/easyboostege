// Telegram transport: polling, message and callback handling. Business rules live in services/subscription.js.
export function subscriptionKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🎁 Попробовать бесплатно месяц', callback_data: 'trial' }],
      [{ text: '💳 Оплатить подписку', callback_data: 'pay' }],
    ],
  };
}

export function displayName(from) {
  return ((from.first_name || '') + ' ' + (from.last_name || '')).trim() || from.username || ('id' + from.id);
}

export function createTelegramService({
  token,
  adminId,
  appUrl,
  subscriptions,
  parseUpdate,
  recordDependencyEvent,
  confirmTelegramAuthCode,
  getUserByTelegram,
  createTelegramUser,
  logger = console,
  fetchImpl = fetch,
  schedule = setTimeout,
}) {
  let botUsername = '';

  async function api(method, params) {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
    return response.json();
  }

  async function onMessage(message) {
    if (!message.text) return;
    const chatId = message.chat.id;
    const fromId = message.from.id;
    const name = displayName(message.from);
    if (message.text.startsWith('/start')) {
      const code = message.text.split(' ')[1];
      if (code && await confirmTelegramAuthCode(code, fromId, name)) {
        const existing = await getUserByTelegram(fromId);
        if (!existing?.username) await createTelegramUser(fromId, name);
        const loginUrl = appUrl + '/?login_code=' + encodeURIComponent(code);
        await api('sendMessage', {
          chat_id: chatId,
          text: 'Готово! Вход выполнен ✅\nНажми кнопку, чтобы открыть приложение:',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Открыть Easy Boost', url: loginUrl }],
              [{ text: '🎁 Попробовать бесплатно месяц', callback_data: 'trial' }],
              [{ text: '💳 Оплатить подписку', callback_data: 'pay' }],
            ],
          },
        });
      } else {
        await api('sendMessage', {
          chat_id: chatId,
          text: 'Привет! Это Easy Boost 🎓 — подготовка к ЕГЭ по английскому.\nВыбери, как начать:',
          reply_markup: subscriptionKeyboard(),
        });
      }
      return;
    }
    if (message.text.startsWith('/id')) {
      await api('sendMessage', { chat_id: chatId, text: 'Твой Telegram ID: ' + fromId });
      return;
    }
    await api('sendMessage', { chat_id: chatId, text: 'Меню Easy Boost:', reply_markup: subscriptionKeyboard() });
  }

  async function onCallback(query) {
    const data = query.data || '';
    const fromId = query.from.id;
    const name = displayName(query.from);
    const chatId = query.message && query.message.chat.id;
    const ack = (text) => api('answerCallbackQuery', { callback_query_id: query.id, text: text || '' });

    if (data === 'trial') {
      const trial = await subscriptions.grantTrial(fromId, name);
      if (!trial.granted) {
        await ack('Пробный период уже был использован');
        await api('sendMessage', {
          chat_id: chatId,
          text: 'Пробный месяц уже был активирован раньше. Чтобы продолжить — оформи подписку.',
          reply_markup: { inline_keyboard: [[{ text: '💳 Оплатить подписку', callback_data: 'pay' }]] },
        });
        return;
      }
      await ack('Готово! Месяц активирован');
      await api('sendMessage', {
        chat_id: chatId,
        text: '🎁 Месяц бесплатного доступа активирован до ' + trial.untilText + '!\nОткрой приложение Easy Boost и занимайся 💪',
      });
      return;
    }

    if (data === 'pay') {
      const request = await subscriptions.requestPayment(fromId, name);
      await ack('Заявка отправлена');
      await api('sendMessage', {
        chat_id: chatId,
        text: '💳 Заявка на подписку отправлена. Как только оплату подтвердят, доступ откроется — обычно это быстро. Спасибо!',
      });
      if (!request.notifyAdmin) {
        logger.log('ADMIN_TELEGRAM_ID не задан — заявку на оплату некому отправить');
        return;
      }
      await api('sendMessage', {
        chat_id: adminId,
        text: '💳 Запрос на оплату подписки\n\nПользователь: ' + name + '\nID: ' + fromId,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Активировать', callback_data: 'approve:' + request.id },
            { text: '❌ Отказ', callback_data: 'reject:' + request.id },
          ]],
        },
      });
      return;
    }

    if (data.startsWith('approve:') || data.startsWith('reject:')) {
      const requestId = data.slice(data.indexOf(':') + 1);
      const decision = data.startsWith('approve:') ? 'approved' : 'rejected';
      const result = await subscriptions.resolvePayment(requestId, decision, fromId);
      if (!result.applied) {
        await ack(result.reason === 'forbidden' ? 'Недостаточно прав' : 'Заявка уже обработана');
        return;
      }
      if (decision === 'approved') {
        await ack('Активировано');
        if (query.message) {
          await api('editMessageText', {
            chat_id: chatId,
            message_id: query.message.message_id,
            text: (query.message.text || '') + '\n\n✅ Активировано до ' + result.untilText,
          });
        }
        await api('sendMessage', {
          chat_id: result.telegramId,
          text: '✅ Подписка активирована! Доступ открыт на ' + result.days + ' дней (до ' + result.untilText + ').\nОткрой приложение Easy Boost 🎓',
        });
      } else {
        await ack('Отклонено');
        if (query.message) {
          await api('editMessageText', {
            chat_id: chatId,
            message_id: query.message.message_id,
            text: (query.message.text || '') + '\n\n❌ Отклонено',
          });
        }
        await api('sendMessage', { chat_id: result.telegramId, text: '❌ Платёж не подтверждён. Пожалуйста, обратитесь в поддержку сервиса.' });
      }
      return;
    }
    await ack();
  }

  async function handleUpdates(updates, state) {
    for (const rawUpdate of updates) {
      if (Number.isSafeInteger(rawUpdate?.update_id) && rawUpdate.update_id >= 0) {
        state.offset = Math.max(state.offset, rawUpdate.update_id + 1);
      }
      const update = parseUpdate(rawUpdate);
      if (!update) {
        recordDependencyEvent('telegram', 'error');
        continue;
      }
      try {
        if (update.message) await onMessage(update.message);
        else if (update.callback_query) await onCallback(update.callback_query);
      } catch (error) {
        recordDependencyEvent('telegram', 'error');
        logger.log('Telegram handler error:', error.message);
      }
    }
  }

  async function start() {
    if (!token) {
      logger.log('Telegram: TELEGRAM_BOT_TOKEN не задан — вход через Telegram выключен');
      return false;
    }
    try {
      const me = await api('getMe');
      if (!me.ok) {
        recordDependencyEvent('telegram', 'error');
        logger.log('Telegram getMe error:', me.description);
        return false;
      }
      botUsername = me.result.username;
      recordDependencyEvent('telegram', 'success');
      logger.log('Telegram bot: @' + botUsername);
    } catch (error) {
      recordDependencyEvent('telegram', 'error');
      logger.log('Telegram getMe failed:', error.message);
      return false;
    }

    logger.log('Telegram admin notifications:', adminId ? 'configured' : 'disabled');
    const state = { offset: 0 };
    const poll = async () => {
      try {
        const updates = await api('getUpdates', { offset: state.offset, timeout: 30 });
        if (updates.ok && Array.isArray(updates.result)) await handleUpdates(updates.result, state);
      } catch (error) { /* сеть — попробуем снова */ }
      schedule(poll, 500);
    };
    poll();
    return true;
  }

  return { api, onMessage, onCallback, handleUpdates, start, username: () => botUsername };
}
