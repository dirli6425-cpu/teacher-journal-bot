const TZ = "Europe/Chisinau";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      await initDb(env);

      if (url.pathname === "/app" || url.pathname === "/app/" || url.pathname === "/app/manifest.webmanifest" || url.pathname === "/app/sw.js" || url.pathname === "/app/icon.svg" || url.pathname === "/app/icon-192.png" || url.pathname === "/app/icon-512.png" || url.pathname.startsWith("/api/app/")) {
        try {
          return await handleAppHttp(request, env, url);
        } catch (e) {
          console.error("App API error:", e);
          if (url.pathname.startsWith("/api/app/")) {
            return appJson({ error: "Ошибка сервера: " + String(e && e.message ? e.message : e) }, 500);
          }
          throw e;
        }
      }

      if (request.method === "GET" && url.pathname === "/setup") {
        const webhookUrl = `${url.origin}/webhook`;

        const result = await tg(env, "setWebhook", {
          url: webhookUrl,
          allowed_updates: ["message", "callback_query"]
        });

        return new Response(
          result.ok
            ? `Webhook установлен!\n${webhookUrl}`
            : `Ошибка:\n${JSON.stringify(result)}`,
          {
            headers: {
              "content-type": "text/plain; charset=UTF-8"
            }
          }
        );
      }

      if (request.method === "POST" && url.pathname === "/webhook") {
        const update = await request.json();

        try {
          await handleUpdate(update, env);
        } catch (e) {
          console.error("Update error:", e);
        }

        return new Response("OK");
      }

      if (request.method === "GET" && url.pathname === "/cron-status") {
        const groupId = await getSetting(env, "group_chat_id");
        return new Response(JSON.stringify({
          ok: true,
          timezone: TZ,
          localTime: localTime(new Date()),
          today: todayYMD(),
          groupBound: Boolean(groupId)
        }), {
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      }

      return new Response("Telegram schedule bot is running!", {
        headers: {
          "content-type": "text/plain; charset=UTF-8"
        }
      });
    } catch (e) {
      console.error(e);
      return new Response("Worker error", { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMorningCard(env, event.scheduledTime));
  }
};


// =====================================================
// DATABASE
// =====================================================

async function initDb(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS schedules (
      date TEXT PRIMARY KEY,
      text TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS states (
      user_id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      date TEXT
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      username TEXT
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admins (
      user_id TEXT PRIMARY KEY
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS sent_cards (
      date TEXT PRIMARY KEY,
      sent_at TEXT
    )
  `).run();


  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS app_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `).run();

  // Presence/activity columns for the web app. Safe migration for existing D1 databases.
  try { await env.DB.prepare("ALTER TABLE app_users ADD COLUMN last_login_at TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE app_users ADD COLUMN last_seen_at TEXT").run(); } catch {}

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS app_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    )
  `).run();

  // Reliability / history layer for the schedule app.
  try { await env.DB.prepare("ALTER TABLE schedules ADD COLUMN version INTEGER NOT NULL DEFAULT 1").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE schedules ADD COLUMN updated_at TEXT").run(); } catch {}

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS schedule_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      old_text TEXT,
      new_text TEXT,
      user_id INTEGER,
      action TEXT NOT NULL DEFAULT 'save',
      created_at TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS schedule_drafts (
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id,date)
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS delivery_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      date TEXT,
      status TEXT NOT NULL,
      details TEXT,
      message_id TEXT,
      created_at TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS cron_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_date TEXT,
      run_at TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS warnings (
      user_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS bot_group_messages (
      chat_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY(chat_id, message_id)
    )
  `).run();

  // Safety: the very first app account is the permanent primary owner.
  // This also repairs an accidental self-demotion on the next request.
  await ensureAppOwner(env);
}

async function ensureAppOwner(env) {
  let ownerId = Number(await getSetting(env, "app_owner_user_id") || 0);
  let owner = ownerId ? await env.DB.prepare("SELECT id FROM app_users WHERE id=?").bind(ownerId).first() : null;

  if (!owner) {
    owner = await env.DB.prepare("SELECT id FROM app_users ORDER BY id ASC LIMIT 1").first();
    if (!owner) return 0;
    ownerId = Number(owner.id);
    await setSetting(env, "app_owner_user_id", String(ownerId));
  }

  await env.DB.prepare("UPDATE app_users SET role='owner', enabled=1 WHERE id=?").bind(ownerId).run();
  return ownerId;
}


async function cleanupOld(env) {
  const today = todayYMD();

  await env.DB.prepare(
    "DELETE FROM schedules WHERE date < ?"
  ).bind(today).run();

  await env.DB.prepare(
    "DELETE FROM sent_cards WHERE date < ?"
  ).bind(today).run();
}


// =====================================================
// USERS / ADMINS
// =====================================================

async function rememberUser(env, user) {
  if (!user) return;

  await env.DB.prepare(`
    INSERT INTO users(
      user_id,
      first_name,
      last_name,
      username
    )
    VALUES(?, ?, ?, ?)

    ON CONFLICT(user_id)
    DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      username = excluded.username
  `).bind(
    String(user.id),
    user.first_name || "",
    user.last_name || "",
    user.username || ""
  ).run();
}


function isOwner(env, userId) {
  return String(userId) === String(env.ADMIN_ID);
}


async function isAdmin(env, userId) {
  if (isOwner(env, userId)) return true;

  const row = await env.DB.prepare(
    "SELECT user_id FROM admins WHERE user_id = ?"
  ).bind(String(userId)).first();

  return !!row;
}


// =====================================================
// UPDATES
// =====================================================

async function handleUpdate(update, env) {
  await cleanupOld(env);

  if (update.callback_query) {
    await rememberUser(env, update.callback_query.from);
    await handleCallback(update.callback_query, env);
    return;
  }

  if (update.message) {
    await rememberUser(env, update.message.from);
    await handleMessage(update.message, env);
  }
}


// =====================================================
// MESSAGES
// =====================================================

async function handleMessage(message, env) {
  if (!message.from) return;

  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const text = message.text || "";

  const owner = isOwner(env, userId);
  const admin = await isAdmin(env, userId);
  const isPrivate = message.chat.type === "private";

  const command = text
    .split(/\s+/)[0]
    .split("@")[0]
    .toLowerCase();


  if (command === "/myid") {
    await sendMessage(
      env,
      chatId,
      `🆔 <b>Ваш Telegram ID</b>

<code>${escapeHtml(userId)}</code>`
    );
    return;
  }


  if (command === "/chatid") {
    await sendMessage(
      env,
      chatId,
      `💬 <b>ID этого чата</b>

<code>${escapeHtml(String(chatId))}</code>`
    );
    return;
  }


  if (command === "/bindgroup") {
    if (!owner) {
      await sendMessage(
        env,
        chatId,
        "⛔ Эту команду может использовать только главный администратор."
      );
      return;
    }

    if (isPrivate) {
      await sendMessage(
        env,
        chatId,
        `📢 Отправь <code>/bindgroup</code> именно в группе.`
      );
      return;
    }

    await setSetting(env, "group_chat_id", String(chatId));

    await sendMessage(
      env,
      chatId,
      `✅ <b>ГРУППА ПОДКЛЮЧЕНА</b>

🔄 Сюда будут приходить уведомления об изменениях.
🌅 А утром — карточка расписания.`
    );
    return;
  }


  if (command === "/appcode") {
    if (!owner || !isPrivate) {
      await sendMessage(env, chatId, "⛔ Код для первого входа может получить только главный администратор в личных сообщениях.");
      return;
    }

    const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_users").first();
    if (Number(existing?.n || 0) > 0) {
      await sendMessage(env, chatId, "✅ Веб-приложение уже настроено. Новых пользователей создавай внутри приложения в разделе «Доступ».");
      return;
    }

    const code = String(100000 + Math.floor(Math.random() * 900000));
    await setSetting(env, "app_setup_code_hash", await sha256Hex(code));
    await setSetting(env, "app_setup_code_expires", String(Date.now() + 10 * 60 * 1000));
    await sendMessage(env, chatId, `📱 <b>КОД ПОДКЛЮЧЕНИЯ ПРИЛОЖЕНИЯ</b>

<code>${code}</code>

⏳ Действует 10 минут.
Открой адрес Worker с <code>/app</code>, выбери «Первичная настройка» и введи этот код.`);
    return;
  }


  if (command === "/start") {
    if (isPrivate && admin) {
      await clearState(env, userId);
      await showAdminMenu(env, chatId, userId);
    } else if (isPrivate) {
      await sendMessage(
        env,
        chatId,
        `👋 <b>Привет!</b>

📚 Расписание и функции бота доступны в группе.

👉 Открой нашу учебную группу и используй бота там.`
      );
    } else {
      await sendMessage(
        env,
        chatId,
        `👋 <b>Привет!</b>

📚 Для просмотра расписания используй:

/schedule`
      );
    }
    return;
  }


  if (command === "/schedule") {
    await showScheduleMenu(env, chatId);
    return;
  }


  if (command === "/today") {
    const today = todayYMD();

    if (!isSchoolDay(today)) {
      await sendMessage(env, chatId, "🏠 Сегодня выходной.");
      return;
    }

    await sendScheduleAsNewMessage(env, chatId, today);
    return;
  }


  // ===================================================
  // GROUP MODERATION
  // ===================================================

  if (!isPrivate) {
    const boundGroup = await getSetting(env, "group_chat_id");

    if (String(boundGroup || "") === String(chatId)) {
      const linksBlocked =
        (await getSetting(env, "moderation_block_links")) === "1";

      if (
        linksBlocked &&
        !admin &&
        containsExternalLink(message)
      ) {
        await tg(env, "deleteMessage", {
          chat_id: chatId,
          message_id: message.message_id
        });
        return;
      }

      if (
        admin &&
        ["/del", "/mute10", "/mute60", "/mute", "/unmute", "/warn", "/unwarn", "/ban"].includes(command)
      ) {
        await handleModerationCommand(message, env, command);
        return;
      }
    }
  }


  if (
    isPrivate &&
    admin &&
    text &&
    !text.startsWith("/")
  ) {
    const state = await env.DB.prepare(`
      SELECT action, date
      FROM states
      WHERE user_id = ?
    `).bind(userId).first();

    if (state?.action === "await_schedule") {
      const old = await env.DB.prepare(
        "SELECT text FROM schedules WHERE date = ?"
      ).bind(state.date).first();

      const scheduleHtml = telegramTextToHtml(
        text,
        message.entities || []
      );

      await env.DB.prepare(`
        INSERT INTO schedules(date, text)
        VALUES(?, ?)
        ON CONFLICT(date)
        DO UPDATE SET text = excluded.text
      `).bind(
        state.date,
        scheduleHtml
      ).run();

      await clearState(env, userId);

      await sendMessage(
        env,
        chatId,
        old
          ? `✅ <b>Расписание обновлено!</b>\n\n📅 ${prettyDate(state.date)}`
          : `✅ <b>Расписание сохранено!</b>\n\n📅 ${prettyDate(state.date)}`
      );

      if (old && old.text !== scheduleHtml) {
        await notifyScheduleChanged(env, state.date, scheduleHtml);
      }

      await showAdminMenu(env, chatId, userId);
      return;
    }

    if (state?.action === "await_replacement") {
      const old = await env.DB.prepare(
        "SELECT text FROM schedules WHERE date = ?"
      ).bind(state.date).first();

      if (!old) {
        await clearState(env, userId);

        await sendMessage(
          env,
          chatId,
          `⚠️ <b>ЗАМЕНА НЕ СОХРАНЕНА</b>

📅 ${prettyDate(state.date)}

Исходное расписание на этот день уже удалено. Сначала добавь обычное расписание.`,
          adminBackKeyboard()
        );
        return;
      }

      const replacementHtml = telegramTextToHtml(
        text,
        message.entities || []
      );

      if (old.text === replacementHtml) {
        await clearState(env, userId);

        await sendMessage(
          env,
          chatId,
          `ℹ️ <b>ИЗМЕНЕНИЙ НЕТ</b>

📅 ${prettyDate(state.date)}

Ты отправил то же самое расписание, поэтому уведомление в группу не публиковалось.`,
          adminBackKeyboard()
        );
        return;
      }

      await env.DB.prepare(`
        UPDATE schedules
        SET text = ?
        WHERE date = ?
      `).bind(
        replacementHtml,
        state.date
      ).run();

      await clearState(env, userId);

      const notification = await notifyReplacement(
        env,
        state.date,
        replacementHtml
      );

      await sendMessage(
        env,
        chatId,
        `✅ <b>ЗАМЕНА СОХРАНЕНА</b>
━━━━━━━━━━━━━━

📅 <b>${prettyDate(state.date)}</b>

Расписание на этот день обновлено во всех разделах.${notification?.ok
          ? "\n📢 Уведомление отправлено в группу."
          : "\n⚠️ Уведомление в группу не отправлено. Проверь привязку группы через /bindgroup."}`
      );

      await showAdminMenu(env, chatId, userId);
      return;
    }
  }
}


// =====================================================
// CALLBACKS
// =====================================================

async function handleCallback(q, env) {
  if (!q.from || !q.message) return;

  const userId = String(q.from.id);
  const chatId = q.message.chat.id;
  const data = q.data || "";

  const owner = isOwner(env, userId);
  const admin = await isAdmin(env, userId);

  await tg(env, "answerCallbackQuery", {
    callback_query_id: q.id
  });


  if (data.startsWith("schedule:")) {
    const date = data.slice("schedule:".length);

    await showScheduleForDate(
      env,
      chatId,
      q.message.message_id,
      date
    );
    return;
  }


  if (data === "schedule_menu") {
    await showScheduleMenu(
      env,
      chatId,
      q.message.message_id
    );
    return;
  }


  if (!admin) {
    await tg(env, "answerCallbackQuery", {
      callback_query_id: q.id,
      text: "⛔ Нет доступа",
      show_alert: true
    });
    return;
  }


  if (data === "admin_menu") {
    await clearState(env, userId);
    await showAdminMenu(env, chatId, userId);
    return;
  }


  if (data === "admin:add") {
    await showAddDates(env, chatId);
    return;
  }


  if (data.startsWith("admin:add_date:")) {
    const date = data.slice("admin:add_date:".length);

    await env.DB.prepare(`
      INSERT INTO states(user_id, action, date)
      VALUES(?, 'await_schedule', ?)

      ON CONFLICT(user_id)
      DO UPDATE SET
        action = 'await_schedule',
        date = excluded.date
    `).bind(userId, date).run();

    const existing = await env.DB.prepare(
      "SELECT text FROM schedules WHERE date = ?"
    ).bind(date).first();

    await sendMessage(
      env,
      chatId,
      `✏️ <b>${existing ? "ИЗМЕНИТЬ" : "ДОБАВИТЬ"} РАСПИСАНИЕ</b>

📅 <b>${prettyDate(date)}</b>

Отправь расписание одним сообщением.

${existing ? `📌 <b>Сейчас сохранено:</b>\n\n${existing.text}` : ""}`,
      adminBackKeyboard()
    );
    return;
  }


  if (data === "admin:view") {
    await showAdminViewDates(env, chatId);
    return;
  }


  if (data === "admin:replacements") {
    await showReplacementDates(env, chatId);
    return;
  }


  if (data.startsWith("admin:replacement_date:")) {
    const date = data.slice("admin:replacement_date:".length);

    const existing = await env.DB.prepare(
      "SELECT text FROM schedules WHERE date = ?"
    ).bind(date).first();

    if (!existing) {
      await sendMessage(
        env,
        chatId,
        `⚠️ <b>РАСПИСАНИЕ НЕ НАЙДЕНО</b>

📅 ${prettyDate(date)}

Сначала добавь обычное расписание на этот день.`,
        {
          inline_keyboard: [
            [
              {
                text: "🔁 Выбрать другую дату",
                callback_data: "admin:replacements"
              }
            ],
            [
              {
                text: "⬅️ В главное меню",
                callback_data: "admin_menu"
              }
            ]
          ]
        }
      );
      return;
    }

    await env.DB.prepare(`
      INSERT INTO states(user_id, action, date)
      VALUES(?, 'await_replacement', ?)

      ON CONFLICT(user_id)
      DO UPDATE SET
        action = 'await_replacement',
        date = excluded.date
    `).bind(userId, date).run();

    await sendMessage(
      env,
      chatId,
      `🚨 <b>ОФОРМЛЕНИЕ ЗАМЕНЫ</b>
━━━━━━━━━━━━━━

📅 <b>${prettyDate(date)}</b>

📌 <b>Сейчас на этот день стоит:</b>

${existing.text}

━━━━━━━━━━━━━━
✍️ Скопируй расписание выше, измени нужные пары и отправь мне <b>одним сообщением</b>.

После отправки я заменю расписание во всех разделах и опубликую объявление в группе.`,
      {
        inline_keyboard: [
          [
            {
              text: "❌ Отменить замену",
              callback_data: "admin:replacements"
            }
          ],
          [
            {
              text: "⬅️ В главное меню",
              callback_data: "admin_menu"
            }
          ]
        ]
      }
    );
    return;
  }


  if (data.startsWith("admin:view_date:")) {
    const date = data.slice("admin:view_date:".length);

    const row = await env.DB.prepare(
      "SELECT text FROM schedules WHERE date = ?"
    ).bind(date).first();

    if (!row) {
      await sendMessage(
        env,
        chatId,
        `➖ <b>Расписания нет</b>

📅 ${prettyDate(date)}`,
        adminBackKeyboard()
      );
    } else {
      await sendMessage(
        env,
        chatId,
        scheduleText(date, row.text),
        {
          inline_keyboard: [
            [
              {
                text: "✏️ Изменить",
                callback_data: `admin:add_date:${date}`
              }
            ],
            [
              {
                text: "⬅️ Назад",
                callback_data: "admin_menu"
              }
            ]
          ]
        }
      );
    }
    return;
  }


  if (data === "admin:delete") {
    await showDeleteDates(env, chatId);
    return;
  }


  if (data.startsWith("admin:delete_ask:")) {
    const date = data.slice("admin:delete_ask:".length);

    await sendMessage(
      env,
      chatId,
      `⚠️ <b>ПОДТВЕРЖДЕНИЕ УДАЛЕНИЯ</b>

📅 <b>${prettyDate(date)}</b>

Точно удалить расписание?`,
      {
        inline_keyboard: [
          [
            {
              text: "✅ Да, удалить",
              callback_data: `admin:delete_yes:${date}`
            }
          ],
          [
            {
              text: "❌ Отмена",
              callback_data: "admin:delete"
            }
          ]
        ]
      }
    );
    return;
  }


  if (data.startsWith("admin:delete_yes:")) {
    const date = data.slice("admin:delete_yes:".length);

    await env.DB.prepare(
      "DELETE FROM schedules WHERE date = ?"
    ).bind(date).run();

    await sendMessage(
      env,
      chatId,
      `🗑 <b>Расписание удалено</b>

📅 ${prettyDate(date)}`,
      adminBackKeyboard()
    );
    return;
  }


  // ===================================================
  // ADMINS
  // ===================================================

  if (data === "admin:admins") {
    if (!owner) {
      await sendMessage(
        env,
        chatId,
        "⛔ Управлять администраторами может только главный администратор.",
        adminBackKeyboard()
      );
      return;
    }

    await showAdminManagement(env, chatId);
    return;
  }


  if (data === "admins:add") {
    if (!owner) return;
    await showUsersToAdd(env, chatId);
    return;
  }


  if (data.startsWith("admins:add_ask:")) {
    if (!owner) return;

    const targetId = data.slice("admins:add_ask:".length);
    const user = await getUser(env, targetId);

    if (!user) return;

    await sendMessage(
      env,
      chatId,
      `👤 <b>Добавить администратора?</b>

${userDisplay(user)}`,
      {
        inline_keyboard: [
          [
            {
              text: "✅ Добавить",
              callback_data: `admins:add_yes:${targetId}`
            }
          ],
          [
            {
              text: "❌ Отмена",
              callback_data: "admin:admins"
            }
          ]
        ]
      }
    );
    return;
  }


  if (data.startsWith("admins:add_yes:")) {
    if (!owner) return;

    const targetId = data.slice("admins:add_yes:".length);

    await env.DB.prepare(
      "INSERT OR IGNORE INTO admins(user_id) VALUES(?)"
    ).bind(targetId).run();

    const user = await getUser(env, targetId);

    await sendMessage(
      env,
      chatId,
      `✅ <b>Администратор добавлен</b>

${user ? userDisplay(user) : targetId}`
    );

    try {
      await sendMessage(
        env,
        targetId,
        `🎉 <b>ВЫ НАЗНАЧЕНЫ АДМИНИСТРАТОРОМ</b>

Теперь вам доступно управление расписанием.

Нажмите /start, чтобы открыть панель.`
      );
    } catch (e) {
      console.error(e);
    }

    await showAdminManagement(env, chatId);
    return;
  }


  if (data === "admins:list") {
    if (!owner) return;
    await showAdminList(env, chatId);
    return;
  }


  if (data === "admins:remove") {
    if (!owner) return;
    await showAdminsToRemove(env, chatId);
    return;
  }


  if (data.startsWith("admins:remove_ask:")) {
    if (!owner) return;

    const targetId = data.slice("admins:remove_ask:".length);
    const user = await getUser(env, targetId);

    await sendMessage(
      env,
      chatId,
      `⚠️ <b>Удалить администратора?</b>

${user ? userDisplay(user) : targetId}`,
      {
        inline_keyboard: [
          [
            {
              text: "✅ Удалить",
              callback_data: `admins:remove_yes:${targetId}`
            }
          ],
          [
            {
              text: "❌ Отмена",
              callback_data: "admin:admins"
            }
          ]
        ]
      }
    );
    return;
  }


  if (data.startsWith("admins:remove_yes:")) {
    if (!owner) return;

    const targetId = data.slice("admins:remove_yes:".length);

    await env.DB.prepare(
      "DELETE FROM admins WHERE user_id = ?"
    ).bind(targetId).run();

    await sendMessage(env, chatId, "✅ Администратор удалён.");
    await showAdminManagement(env, chatId);
    return;
  }


  // ===================================================
  // GROUP MANAGEMENT
  // ===================================================

  if (data === "group:menu") {
    await showGroupManagement(env, chatId);
    return;
  }

  if (data === "group:cleanup") {
    await showBotCleanup(env, chatId);
    return;
  }

  if (data.startsWith("group:cleanup_ask:")) {
    const amount = data.slice("group:cleanup_ask:".length);

    await sendMessage(
      env,
      chatId,
      `⚠️ <b>Удалить сообщения бота из группы?</b>

${amount === "all" ? "Будут удалены все сохранённые сообщения бота." : `Количество: <b>${escapeHtml(amount)}</b>`}`,
      {
        inline_keyboard: [
          [
            {
              text: "🗑 Да, удалить",
              callback_data: `group:cleanup_yes:${amount}`
            }
          ],
          [
            {
              text: "❌ Отмена",
              callback_data: "group:cleanup"
            }
          ]
        ]
      }
    );
    return;
  }

  if (data.startsWith("group:cleanup_yes:")) {
    const amount = data.slice("group:cleanup_yes:".length);
    const deleted = await cleanupBotGroupMessages(env, amount);

    await sendMessage(
      env,
      chatId,
      `✅ Удалено сообщений бота: <b>${deleted}</b>`,
      groupBackKeyboard()
    );
    return;
  }

  if (data === "group:links") {
    const current =
      (await getSetting(env, "moderation_block_links")) === "1";

    await setSetting(
      env,
      "moderation_block_links",
      current ? "0" : "1"
    );

    await showGroupManagement(env, chatId);
    return;
  }

  if (data === "group:commands") {
    await showModerationHelp(env, chatId);
    return;
  }

  if (data === "group:status") {
    await showGroupStatus(env, chatId);
    return;
  }


  if (data === "admin:help") {
    await sendMessage(
      env,
      chatId,
      `❓ <b>КАК УПРАВЛЯТЬ РАСПИСАНИЕМ</b>

1️⃣ Нажми «➕ Добавить / изменить»

2️⃣ Выбери дату

3️⃣ Отправь расписание одним сообщением

Можно использовать жирный текст, эмодзи, переносы строк, кабинеты и преподавателей.

🚨 <b>Если появились замены:</b>
1️⃣ Нажми «Замены»
2️⃣ Выбери дату
3️⃣ Скопируй показанное расписание, измени его и отправь боту

Бот обновит выбранный день во всех разделах и отправит в группу отдельное объявление «Внимание! Замена». 

📢 Для подключения группы главный админ один раз пишет в группе:

<code>/bindgroup</code>`,
      adminBackKeyboard()
    );
    return;
  }
}


// =====================================================
// ADMIN MENU
// =====================================================

async function showAdminMenu(env, chatId, userId) {
  const today = todayYMD();

  const countRow = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM schedules
    WHERE date >= ?
  `).bind(today).first();

  const count = Number(countRow?.count || 0);
  const missing = await findNearestMissingDay(env);

  let warning = "";

  if (missing) {
    warning =
      `\n\n⚠️ <b>Ближайший день без расписания:</b>\n${dateButtonLabel(missing)}`;
  }

  const buttons = [
    [
      {
        text: "➕ Добавить / изменить",
        callback_data: "admin:add"
      }
    ],
    [
      {
        text: "📚 Посмотреть расписание",
        callback_data: "admin:view"
      }
    ],
    [
      {
        text: "🚨 Замены",
        callback_data: "admin:replacements"
      }
    ],
    [
      {
        text: "🗑 Удалить расписание",
        callback_data: "admin:delete"
      }
    ]
  ];

  if (isOwner(env, userId)) {
    buttons.push([
      {
        text: "👥 Администраторы",
        callback_data: "admin:admins"
      }
    ]);
  }

  buttons.push([
    {
      text: "🛡 Управление группой",
      callback_data: "group:menu"
    }
  ]);

  buttons.push([
    {
      text: "❓ Помощь",
      callback_data: "admin:help"
    }
  ]);

  await sendMessage(
    env,
    chatId,
    `⚙️ <b>ПАНЕЛЬ УПРАВЛЕНИЯ</b>
━━━━━━━━━━━━━━

📚 Расписаний добавлено: <b>${count}</b>${warning}

Выбери действие 👇`,
    {
      inline_keyboard: buttons
    }
  );
}


// =====================================================
// ADD / VIEW / DELETE
// =====================================================

async function showAddDates(env, chatId) {
  const dates = getSchoolDays(10);
  const available = await getAvailableDates(env, dates);

  const nearestMissing = dates.find(date => !available.has(date));

  const buttons = dates.map(date => {
    let icon = "➕";

    if (available.has(date)) {
      icon = "✅";
    } else if (date === nearestMissing) {
      icon = "⚠️";
    }

    return [
      {
        text: `${icon} ${dateButtonLabel(date)}`,
        callback_data: `admin:add_date:${date}`
      }
    ];
  });

  buttons.push([
    {
      text: "⬅️ Назад",
      callback_data: "admin_menu"
    }
  ]);

  await sendMessage(
    env,
    chatId,
    `➕ <b>ДОБАВИТЬ / ИЗМЕНИТЬ</b>

✅ — расписание есть
⚠️ — ближайший пропущенный день
➕ — расписания нет

Выбери дату:`,
    {
      inline_keyboard: buttons
    }
  );
}


async function showAdminViewDates(env, chatId) {
  const dates = getSchoolDays(10);
  const available = await getAvailableDates(env, dates);

  const buttons = dates.map(date => [
    {
      text: `${available.has(date) ? "✅" : "➖"} ${dateButtonLabel(date)}`,
      callback_data: `admin:view_date:${date}`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Назад",
      callback_data: "admin_menu"
    }
  ]);

  await sendMessage(
    env,
    chatId,
    `📚 <b>ПРОСМОТР РАСПИСАНИЯ</b>

✅ — есть
➖ — нет

Выбери день:`,
    {
      inline_keyboard: buttons
    }
  );
}


async function showReplacementDates(env, chatId) {
  const rows = await env.DB.prepare(`
    SELECT date
    FROM schedules
    WHERE date >= ?
    ORDER BY date ASC
    LIMIT 20
  `).bind(todayYMD()).all();

  if (!rows.results?.length) {
    await sendMessage(
      env,
      chatId,
      `🚨 <b>ЗАМЕНЫ</b>
━━━━━━━━━━━━━━

Пока нет будущих расписаний, которые можно изменить.

Сначала добавь обычное расписание через «➕ Добавить / изменить».`,
      adminBackKeyboard()
    );
    return;
  }

  const buttons = rows.results.map(row => [
    {
      text: `✏️ ${dateButtonLabel(row.date)}`,
      callback_data: `admin:replacement_date:${row.date}`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Назад",
      callback_data: "admin_menu"
    }
  ]);

  await sendMessage(
    env,
    chatId,
    `🚨 <b>ЗАМЕНЫ В РАСПИСАНИИ</b>
━━━━━━━━━━━━━━

Выбери день, на который появилась замена.

Бот покажет текущее расписание — скопируй его, измени нужные пары и отправь обратно одним сообщением.`,
    {
      inline_keyboard: buttons
    }
  );
}


async function showDeleteDates(env, chatId) {
  const rows = await env.DB.prepare(`
    SELECT date
    FROM schedules
    WHERE date >= ?
    ORDER BY date ASC
    LIMIT 30
  `).bind(todayYMD()).all();

  if (!rows.results?.length) {
    await sendMessage(
      env,
      chatId,
      `🗑 <b>УДАЛЕНИЕ</b>

Нет расписаний для удаления.`,
      adminBackKeyboard()
    );
    return;
  }

  const buttons = rows.results.map(row => [
    {
      text: `🗑 ${dateButtonLabel(row.date)}`,
      callback_data: `admin:delete_ask:${row.date}`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Назад",
      callback_data: "admin_menu"
    }
  ]);

  await sendMessage(
    env,
    chatId,
    `🗑 <b>УДАЛИТЬ РАСПИСАНИЕ</b>

Выбери день:`,
    {
      inline_keyboard: buttons
    }
  );
}


// =====================================================
// ADMIN MANAGEMENT
// =====================================================

async function showAdminManagement(env, chatId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM admins"
  ).first();

  const count = Number(row?.count || 0);

  await sendMessage(
    env,
    chatId,
    `👥 <b>УПРАВЛЕНИЕ АДМИНАМИ</b>
━━━━━━━━━━━━━━

👑 Главный администратор
👤 Дополнительных админов: <b>${count}</b>

Что сделать?`,
    {
      inline_keyboard: [
        [
          {
            text: "➕ Добавить администратора",
            callback_data: "admins:add"
          }
        ],
        [
          {
            text: "📋 Список администраторов",
            callback_data: "admins:list"
          }
        ],
        [
          {
            text: "➖ Удалить администратора",
            callback_data: "admins:remove"
          }
        ],
        [
          {
            text: "⬅️ Назад",
            callback_data: "admin_menu"
          }
        ]
      ]
    }
  );
}


async function showUsersToAdd(env, chatId) {
  const rows = await env.DB.prepare(`
    SELECT *
    FROM users
    WHERE user_id != ?
    AND user_id NOT IN (
      SELECT user_id FROM admins
    )
    ORDER BY first_name ASC
    LIMIT 30
  `).bind(String(env.ADMIN_ID)).all();

  if (!rows.results?.length) {
    await sendMessage(
      env,
      chatId,
      `👤 <b>Некого добавлять</b>

Пользователь должен сначала один раз написать боту /start.`,
      backToAdminsKeyboard()
    );
    return;
  }

  const buttons = rows.results.map(user => [
    {
      text: `👤 ${userButtonName(user)}`,
      callback_data: `admins:add_ask:${user.user_id}`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Назад",
      callback_data: "admin:admins"
    }
  ]);

  await sendMessage(
    env,
    chatId,
    `➕ <b>ДОБАВИТЬ АДМИНИСТРАТОРА</b>

Выбери пользователя:`,
    {
      inline_keyboard: buttons
    }
  );
}


async function showAdminList(env, chatId) {
  const rows = await env.DB.prepare(`
    SELECT users.*
    FROM admins
    LEFT JOIN users
    ON users.user_id = admins.user_id
    ORDER BY users.first_name ASC
  `).all();

  let text = `📋 <b>АДМИНИСТРАТОРЫ</b>
━━━━━━━━━━━━━━

👑 Главный администратор`;

  if (rows.results?.length) {
    for (const user of rows.results) {
      text += `\n\n👤 ${userDisplay(user)}`;
    }
  } else {
    text += "\n\nДополнительных администраторов пока нет.";
  }

  await sendMessage(
    env,
    chatId,
    text,
    backToAdminsKeyboard()
  );
}


async function showAdminsToRemove(env, chatId) {
  const rows = await env.DB.prepare(`
    SELECT users.*
    FROM admins
    LEFT JOIN users
    ON users.user_id = admins.user_id
    ORDER BY users.first_name ASC
  `).all();

  if (!rows.results?.length) {
    await sendMessage(
      env,
      chatId,
      "➖ Дополнительных администраторов пока нет.",
      backToAdminsKeyboard()
    );
    return;
  }

  const buttons = rows.results.map(user => [
    {
      text: `➖ ${userButtonName(user)}`,
      callback_data: `admins:remove_ask:${user.user_id}`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Назад",
      callback_data: "admin:admins"
    }
  ]);

  await sendMessage(
    env,
    chatId,
    `➖ <b>УДАЛИТЬ АДМИНИСТРАТОРА</b>

Выбери пользователя:`,
    {
      inline_keyboard: buttons
    }
  );
}


async function getUser(env, userId) {
  return env.DB.prepare(
    "SELECT * FROM users WHERE user_id = ?"
  ).bind(String(userId)).first();
}


function userButtonName(user) {
  const name =
    [user.first_name, user.last_name]
      .filter(Boolean)
      .join(" ") ||
    (user.username ? `@${user.username}` : String(user.user_id));

  return user.username
    ? `${name} · @${user.username}`.slice(0, 55)
    : name.slice(0, 55);
}


function userDisplay(user) {
  if (!user) return "Неизвестный пользователь";

  const name =
    [user.first_name, user.last_name]
      .filter(Boolean)
      .join(" ") ||
    "Без имени";

  return user.username
    ? `<b>${escapeHtml(name)}</b>\n🔗 @${escapeHtml(user.username)}`
    : `<b>${escapeHtml(name)}</b>`;
}



// =====================================================
// GROUP MANAGEMENT
// =====================================================

async function showGroupManagement(env, chatId) {
  const groupId = await getSetting(env, "group_chat_id");
  const linksBlocked =
    (await getSetting(env, "moderation_block_links")) === "1";

  await sendMessage(
    env,
    chatId,
    `🛡 <b>УПРАВЛЕНИЕ ГРУППОЙ</b>
━━━━━━━━━━━━━━

📢 Группа: ${groupId ? "<b>подключена</b>" : "<b>не подключена</b>"}
🔗 Удаление ссылок: <b>${linksBlocked ? "ВКЛ ✅" : "ВЫКЛ ❌"}</b>

Здесь можно чистить сообщения самого бота и настраивать модерацию.

Для действий над участником команда отправляется <b>ответом на его сообщение</b> в группе.`,
    {
      inline_keyboard: [
        [
          {
            text: "🧹 Сообщения бота",
            callback_data: "group:cleanup"
          }
        ],
        [
          {
            text: `${linksBlocked ? "🔗 Ссылки: ВКЛ ✅" : "🔗 Ссылки: ВЫКЛ ❌"}`,
            callback_data: "group:links"
          }
        ],
        [
          {
            text: "👮 Команды модерации",
            callback_data: "group:commands"
          }
        ],
        [
          {
            text: "📊 Статус группы",
            callback_data: "group:status"
          }
        ],
        [
          {
            text: "⬅️ Назад",
            callback_data: "admin_menu"
          }
        ]
      ]
    }
  );
}


async function showBotCleanup(env, chatId) {
  await sendMessage(
    env,
    chatId,
    `🧹 <b>СООБЩЕНИЯ БОТА</b>
━━━━━━━━━━━━━━

Выбери, сколько последних сообщений <b>самого бота</b> удалить из подключённой группы.

⚠️ Telegram может не позволить удалить слишком старые сообщения.`,
    {
      inline_keyboard: [
        [
          { text: "🗑 Последние 10", callback_data: "group:cleanup_ask:10" },
          { text: "🗑 Последние 25", callback_data: "group:cleanup_ask:25" }
        ],
        [
          { text: "🧨 Все сохранённые", callback_data: "group:cleanup_ask:all" }
        ],
        [
          { text: "⬅️ Назад", callback_data: "group:menu" }
        ]
      ]
    }
  );
}


async function showModerationHelp(env, chatId) {
  await sendMessage(
    env,
    chatId,
    `👮 <b>МОДЕРАЦИЯ УЧАСТНИКОВ</b>
━━━━━━━━━━━━━━

В группе <b>ответь на сообщение участника</b> одной из команд:

<code>/del</code> — удалить сообщение
<code>/mute10</code> — мут на 10 минут
<code>/mute60</code> — мут на 1 час
<code>/mute</code> — мут на 24 часа
<code>/unmute</code> — снять мут
<code>/warn</code> — выдать предупреждение
<code>/unwarn</code> — снять одно предупреждение
<code>/ban</code> — заблокировать участника

⚠️ Для удаления чужих сообщений, мута и бана бот должен быть администратором группы с соответствующими правами.`,
    groupBackKeyboard()
  );
}


async function showGroupStatus(env, chatId) {
  const groupId = await getSetting(env, "group_chat_id");
  const linksBlocked =
    (await getSetting(env, "moderation_block_links")) === "1";

  let botStatus = "не проверено";

  if (groupId) {
    const me = await tg(env, "getMe", {});

    if (me.ok) {
      const member = await tg(env, "getChatMember", {
        chat_id: groupId,
        user_id: me.result.id
      });

      if (member.ok) {
        botStatus = member.result.status || "unknown";
      }
    }
  }

  await sendMessage(
    env,
    chatId,
    `📊 <b>СТАТУС ГРУППЫ</b>
━━━━━━━━━━━━━━

📢 ID группы:
<code>${escapeHtml(groupId || "не подключена")}</code>

🤖 Статус бота: <b>${escapeHtml(botStatus)}</b>
🔗 Автоудаление ссылок: <b>${linksBlocked ? "включено" : "выключено"}</b>`,
    groupBackKeyboard()
  );
}


function groupBackKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "⬅️ К управлению группой",
          callback_data: "group:menu"
        }
      ]
    ]
  };
}


function containsExternalLink(message) {
  const text = `${message.text || ""}\n${message.caption || ""}`;

  if (/(https?:\/\/|www\.|t\.me\/|telegram\.me\/)/i.test(text)) {
    return true;
  }

  const entities = [
    ...(message.entities || []),
    ...(message.caption_entities || [])
  ];

  return entities.some(entity =>
    ["url", "text_link"].includes(entity.type)
  );
}


async function handleModerationCommand(message, env, command) {
  const chatId = message.chat.id;
  const reply = message.reply_to_message;

  if (!reply?.from) {
    await sendMessage(
      env,
      chatId,
      "↩️ Используй эту команду <b>ответом на сообщение участника</b>."
    );
    return;
  }

  const targetId = String(reply.from.id);

  if (isOwner(env, targetId) || await isAdmin(env, targetId)) {
    await sendMessage(env, chatId, "🛡 Нельзя применить это действие к администратору бота.");
    return;
  }

  if (command === "/del") {
    await tg(env, "deleteMessage", {
      chat_id: chatId,
      message_id: reply.message_id
    });

    await tg(env, "deleteMessage", {
      chat_id: chatId,
      message_id: message.message_id
    });
    return;
  }

  if (command === "/warn" || command === "/unwarn") {
    const delta = command === "/warn" ? 1 : -1;

    await env.DB.prepare(`
      INSERT INTO warnings(user_id, count)
      VALUES(?, ?)
      ON CONFLICT(user_id)
      DO UPDATE SET count = MAX(0, warnings.count + ?)
    `).bind(targetId, delta > 0 ? 1 : 0, delta).run();

    const row = await env.DB.prepare(
      "SELECT count FROM warnings WHERE user_id = ?"
    ).bind(targetId).first();

    await sendMessage(
      env,
      chatId,
      `${command === "/warn" ? "⚠️ Предупреждение выдано" : "✅ Предупреждение снято"}.\n\nВсего: <b>${Number(row?.count || 0)}</b>`
    );
    return;
  }

  if (command === "/ban") {
    const result = await tg(env, "banChatMember", {
      chat_id: chatId,
      user_id: targetId
    });

    if (result.ok) {
      await sendMessage(env, chatId, "🚫 Участник заблокирован.");
    }
    return;
  }

  const permissions = {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true,
    can_change_info: false,
    can_invite_users: true,
    can_pin_messages: false,
    can_manage_topics: false
  };

  if (command === "/unmute") {
    const result = await tg(env, "restrictChatMember", {
      chat_id: chatId,
      user_id: targetId,
      permissions
    });

    if (result.ok) {
      await sendMessage(env, chatId, "🔊 Мут снят.");
    }
    return;
  }

  let seconds = 24 * 60 * 60;
  let label = "24 часа";

  if (command === "/mute10") {
    seconds = 10 * 60;
    label = "10 минут";
  } else if (command === "/mute60") {
    seconds = 60 * 60;
    label = "1 час";
  }

  const mutedPermissions = {
    can_send_messages: false,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    can_change_info: false,
    can_invite_users: false,
    can_pin_messages: false,
    can_manage_topics: false
  };

  const result = await tg(env, "restrictChatMember", {
    chat_id: chatId,
    user_id: targetId,
    permissions: mutedPermissions,
    until_date: Math.floor(Date.now() / 1000) + seconds
  });

  if (result.ok) {
    await sendMessage(env, chatId, `🔇 Участник получил мут на <b>${label}</b>.`);
  }
}


async function cleanupBotGroupMessages(env, amount) {
  const groupId = await getSetting(env, "group_chat_id");
  if (!groupId) return 0;

  let sql = `
    SELECT message_id
    FROM bot_group_messages
    WHERE chat_id = ?
    ORDER BY message_id DESC
  `;

  const limit = amount === "all" ? null : Math.max(1, Number(amount) || 10);

  if (limit) {
    sql += ` LIMIT ${limit}`;
  }

  const rows = await env.DB.prepare(sql).bind(String(groupId)).all();
  let deleted = 0;

  for (const row of rows.results || []) {
    const result = await tg(env, "deleteMessage", {
      chat_id: groupId,
      message_id: row.message_id
    });

    if (result.ok) deleted++;

    await env.DB.prepare(`
      DELETE FROM bot_group_messages
      WHERE chat_id = ? AND message_id = ?
    `).bind(String(groupId), row.message_id).run();
  }

  return deleted;
}


// =====================================================
// USER SCHEDULE
// =====================================================

async function showScheduleMenu(env, chatId, messageId = null) {
  const dates = getSchoolDays(7);
  const available = await getAvailableDates(env, dates);

  const buttons = dates.map(date => [
    {
      text: `${available.has(date) ? "✅" : "➖"} ${dateButtonLabel(date)}`,
      callback_data: `schedule:${date}`
    }
  ]);

  const text = `📚 <b>РАСПИСАНИЕ</b>
━━━━━━━━━━━━━━

✅ — расписание добавлено
➖ — расписания пока нет

📅 <b>Выберите день:</b>`;

  if (messageId) {
    await editMessage(
      env,
      chatId,
      messageId,
      text,
      { inline_keyboard: buttons }
    );
  } else {
    await sendMessage(
      env,
      chatId,
      text,
      { inline_keyboard: buttons }
    );
  }
}


async function showScheduleForDate(env, chatId, messageId, date) {
  const row = await env.DB.prepare(
    "SELECT text FROM schedules WHERE date = ?"
  ).bind(date).first();

  const text = row
    ? scheduleText(date, row.text)
    : `📚 <b>РАСПИСАНИЕ</b>
━━━━━━━━━━━━━━
📅 <b>${prettyDate(date)}</b>
━━━━━━━━━━━━━━

➖ Расписание на этот день пока не добавлено.`;

  await editMessage(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ К выбору дня",
            callback_data: "schedule_menu"
          }
        ]
      ]
    }
  );
}


async function sendScheduleAsNewMessage(env, chatId, date) {
  const row = await env.DB.prepare(
    "SELECT text FROM schedules WHERE date = ?"
  ).bind(date).first();

  if (!row) {
    await sendMessage(
      env,
      chatId,
      `📅 <b>${prettyDate(date)}</b>

➖ Расписание пока не добавлено.`
    );
    return;
  }

  await sendMessage(
    env,
    chatId,
    scheduleText(date, row.text)
  );
}


function scheduleText(date, body) {
  return `📚 <b>РАСПИСАНИЕ</b>
━━━━━━━━━━━━━━
📅 <b>${prettyDate(date)}</b>
━━━━━━━━━━━━━━

${body}`;
}


// =====================================================
// NOTIFICATIONS
// =====================================================

async function notifyScheduleChanged(env, date, body) {
  const groupId = await getSetting(env, "group_chat_id");
  const cfg = await getBotAppSettings(env);

  if (!groupId) return;

  return sendMessage(
    env,
    groupId,
    `<b>${escapeHtml(cfg.changeTitle)}</b>
━━━━━━━━━━━━━━

📅 <b>${prettyDate(date)}</b>

⚠️ Обратите внимание: расписание изменилось.

${body}`
  );
}


async function notifyReplacement(env, date, body) {
  const groupId = await getSetting(env, "group_chat_id");
  const cfg = await getBotAppSettings(env);

  if (!groupId) return null;

  return sendMessage(
    env,
    groupId,
    `<b>${escapeHtml(cfg.replacementTitle)}</b>
━━━━━━━━━━━━━━

📅 <b>${prettyDate(date)}</b>

⚠️ На этот день изменилось расписание.

📚 <b>АКТУАЛЬНОЕ РАСПИСАНИЕ:</b>

${body}

━━━━━━━━━━━━━━
Пожалуйста, проверьте изменения и не опаздывайте.`
  );
}


// =====================================================
// MORNING CARD
// =====================================================

async function runMorningCard(env, scheduledTime) {
  await initDb(env);
  await cleanupOld(env);

  const now = new Date(scheduledTime || Date.now());
  const cronIso = new Date().toISOString();
  const cronToday = ymdInTimezone(now);
  let cronStatus = "checked", cronDetails = "Проверка выполнена";

  const cfg = await getBotAppSettings(env);
  if (!cfg.morningEnabled) {
    await logCronRun(env, cronToday, cronStatus, "Утренняя карточка выключена");
    return;
  }

  const today = ymdInTimezone(now);
  if (!isSchoolDay(today)) { await logCronRun(env, today, "skip", "Выходной день"); return; }

  const lt = localTime(now);
  const nowMinutes = hhmmToMinutes(lt);
  const targetMinutes = hhmmToMinutes(cfg.morningTime);
  if (nowMinutes < targetMinutes || nowMinutes > targetMinutes + cfg.retryMinutes) { await logCronRun(env, today, "skip", `Вне окна отправки: ${lt}`); return; }

  const sent = await env.DB.prepare("SELECT date FROM sent_cards WHERE date = ?").bind(today).first();
  if (sent) { await logCronRun(env, today, "ok", "Карточка уже была отправлена"); return; }

  const groupId = await getSetting(env, "group_chat_id");
  if (!groupId) { await logCronRun(env, today, "error", "Не задан Telegram Chat ID"); await logDelivery(env,"morning",today,"error","Не задан Telegram Chat ID"); return; }

  const row = await env.DB.prepare("SELECT text FROM schedules WHERE date = ?").bind(today).first();
  if (!row) { await logCronRun(env, today, "wait", "Расписание на сегодня ещё не заполнено"); return; }

  const stats = extractScheduleStats(stripHtml(row.text));
  let info = "";
  if (cfg.showMorningStats) {
    if (stats.lessons) info += `\n📚 Пар сегодня: <b>${stats.lessons}</b>`;
    if (stats.first) info += `\n🕐 Первая: <b>${stats.first}</b>`;
    if (stats.last) info += `\n🏁 Последнее время: <b>${stats.last}</b>`;
  }
  const footer = cfg.cardFooter ? `\n\n━━━━━━━━━━━━━━\n${escapeHtml(cfg.cardFooter)}` : "";
  const result = await sendMessage(env, groupId, `<b>${escapeHtml(cfg.morningTitle)}</b>
━━━━━━━━━━━━━━

📅 <b>${prettyDate(today)}</b>${info}

━━━━━━━━━━━━━━
📚 <b>РАСПИСАНИЕ НА СЕГОДНЯ</b>

${row.text}${footer}`);

  if (result?.ok) {
    await env.DB.prepare("INSERT OR REPLACE INTO sent_cards(date, sent_at) VALUES(?, ?)").bind(today, new Date().toISOString()).run();
    await logDelivery(env,"morning",today,"ok","Утренняя карточка доставлена",String(result.result?.message_id || ""));
    await logCronRun(env, today, "sent", "Утренняя карточка отправлена");
  } else {
    await logDelivery(env,"morning",today,"error",String(result?.description || "Telegram API error"));
    await logCronRun(env, today, "error",String(result?.description || "Telegram API error"));
  }
}

async function logDelivery(env,kind,date,status,details="",messageId=""){
  try{await env.DB.prepare("INSERT INTO delivery_log(kind,date,status,details,message_id,created_at) VALUES(?,?,?,?,?,?)").bind(String(kind),date||null,String(status),String(details||"").slice(0,800),String(messageId||""),new Date().toISOString()).run();}catch{}
}
async function logCronRun(env,date,status,details=""){
  try{await env.DB.prepare("INSERT INTO cron_runs(local_date,run_at,status,details) VALUES(?,?,?,?)").bind(date||null,new Date().toISOString(),String(status),String(details||"").slice(0,800)).run();
  await env.DB.prepare("DELETE FROM cron_runs WHERE id NOT IN (SELECT id FROM cron_runs ORDER BY id DESC LIMIT 120)").run();}catch{}
}


function hhmmToMinutes(v) {
  const m = String(v || "00:00").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return Math.max(0, Math.min(1439, Number(m[1]) * 60 + Number(m[2])));
}


function extractScheduleStats(text) {
  const timeRegex = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/;

  const lessonLines = text
    .split("\n")
    .map(x => x.trim())
    .filter(line => timeRegex.test(line));

  const allTimes =
    text.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g) || [];

  const sorted = [...allTimes].sort(
    (a, b) => minutes(a) - minutes(b)
  );

  return {
    lessons: lessonLines.length,
    first: sorted[0] || null,
    last: sorted[sorted.length - 1] || null
  };
}


function minutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}


function stripHtml(text) {
  return String(text).replace(/<[^>]*>/g, "");
}



// =====================================================
// SCHEDULE WEB APP / PWA
// =====================================================

const APP_ROLES = {
  viewer: { label: "Только просмотр", edit: false, users: false, settings: false, full: false },
  editor: { label: "Редактор", edit: true, users: false, settings: false, full: false },
  admin: { label: "Администратор", edit: true, users: true, settings: false, full: false },
  owner: { label: "Полный доступ", edit: true, users: true, settings: true, full: true }
};

async function handleAppHttp(request, env, url) {
  const path = url.pathname;

  if (path === "/app") {
    return Response.redirect(url.origin + "/app/", 302);
  }
  if (path === "/app/") {
    return new Response(appHtml(), { headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" } });
  }
  if (path === "/app/manifest.webmanifest") {
    return new Response(JSON.stringify({
      name: "Расписание 102",
      short_name: "Расписание",
      id: "/app/",
      start_url: "/app/",
      scope: "/app/",
      display: "standalone",
      background_color: "#090b14",
      theme_color: "#7c3aed",
      icons: [
        { src: "/app/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: "/app/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
      ]
    }), { headers: { "content-type": "application/manifest+json; charset=UTF-8", "cache-control": "public, max-age=3600" } });
  }
  if (path === "/app/icon.svg") {
    return new Response(appIconSvg(), { headers: { "content-type": "image/svg+xml; charset=UTF-8", "cache-control": "public, max-age=86400" } });
  }
  if (path === "/app/icon-192.png") {
    return base64PngResponse("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");
  }
  if (path === "/app/icon-512.png") {
    return base64PngResponse("iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAAi5UlEQVR42u3dd5hV5Z3A8d/AwAwDSBGQJjIK2BWMWAArFqzYxY7Gioqim3VjS7LWaIyIDQN2MYZYYgHdRI2VbkGNBQsgiBSRMhRngJn9Y9d9kqhZgXlvmfv5/Ofz4Dlzzz3nvN/z3nPvKWrcvHNNAAAFpZ5NAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAADIAcU2Ad9n5GXTbASoQ06/ppuNwD8oaty8c43NYJAHxAECAAM+IAgQABjwAUGAAMCgD4gBBAAGfUAMIAAw8ANCAAGAQR8QAwgADPyAEEAAYOAHhADZ4aeADf4AzmNmAHDAAJgNEAAU7MB/9Z2He0OgDrn8nCeEAALA4G+gB7IbBiJAABj4MzzwG/CBXAoCISAADP4G/R90161PrdW/P+v8Q+1c2BfzKAZEQHYU2wR1c/B3pQ/U5nkkZQyMvGyaCBAABn6DPlCIMfDtuVEICACDv4EfyPEYSBUCIkAAGPwN/EABhoAIEAAGfwM/UKAhIAIEgMHfwA8UaAiIgLQ8CyDhwG/wBwo5BHLxXIoZAFf9AGYDzABg8AfIh9kAzADU6cHfwA+YDTATYAZALQM4vyEA6vLVv4MDEAGZOd/iI4CcGPwN/EAhRsD6fCTgowAzAAZ/gAKdDTATIAAM/gAiAAFg8AcQAQiAOrizAzgvIgDy7OrfTg5Q++dHswACwOAPIAIQAAZ/ABHA9/E7ADm+M2fbwF5/9DdDHu+L9407Om/Pm7X1ICEEQNau/p2wgFw5pvM1CNb2fO1Hgv5/RY2bd66xGdIN/vlw9Z/rg/6ux5Ws1b8f//tKOy32xToyO7A+swAiwAxA1uTy4O9KH/j780CuxoCPAtJxE2Ciq/9cHfwH9vqjwR/Iq3PDup5P3RBoBgBX/MBanisK4V4BMwDU+at/gz+Q7+cNswACwOC/lgewwR+oK+cQESAAcNUPOJ8gAFz9O1iBQjmvmAWoPW4CzPJOmQ8H6A0v7pzV1/XEcW/n1d9L3ZVv++K/7z0xyTkm2zcI+mqgAMipq/+6NPgbQKFu+OdjubaCYGCvP+bltwT8QqAAqHNX/7Ux+Bv0obCCYH1jINsRYBZg/bkHIM+t7+B/w4s7G/yhQGNgfY999xsJgDpjXab/8/VJfwZ+IN/PBety/nUzoAAo6Kt/Az9QW+cFswACwNW/wR8QAWYBBAC5Nvib8gdSnivMBAiAgpFPn/0b+IG6fN7I13uxBEAOyKfpoLWtbIM/kKkIyKdZAB8DCIC8YvAHRAACIItMNwE4LwuAPJcv00Cu/gGzAIV5/hcAGPwB5xUEQLZkY5ppbWraQQrkQgRkYxbAxwACAAAQAD+srn3+4+ofcJ4p7HFAACSS69P/ALnExwACAFUOON8gAAAAAZAl+fC5j+l/IN/lw3msUO8DMAPwI+Xy50qm4wDnnfw4XwsAAEAAAAACgPD5P+B8hgDgX/D5P+D8gwAAAATAD1nbr3y4oxQgv6ztebsQvwpoBgAAzAAAAAIAABAAAEDdUGwTkOsOP6O7jYB9EcwAAAACAAAQAACAAAAABAAAIAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAA8K8U2wRQN3Xs0C622rJblJdvHOWdO0V5506x0UatoqysUTQuK4uyskZRWloalZWVsWLFylixYmUsX7EiFixYGNNnfB7Tp8+K6TNnxQcffBwzZs4q6G1Zv3692KRTx9h44w7RaeP20bFj++jQvm20aNEsWrZoHs2bN4sNmjaJhiUNo2GDBtGwYcOIiKisrIzKqqqorKyKioplsWDBwljw1cJYsGBhzPx8dkz7+LP4+OPp8cWcuVFTU2OnRQAAa2/DDVtE3736RO9ePaP3rj2jU6cOP+r/KytrFGVljf7vv7fcomvsvtsu//Bv5nw5L8aNmxyvj58SL/71tfhy7vw6ux2bNm0S3bffOnbosW1ssXmX2GLzzaJrl/L/G9TXxt9v27YbtY6uXcq/999VVCyLKW+8ExMmvhHjJ74RU96YGqtXr7FTIwDIf0VFRdG1S3ns1LN77NSzR+zUs0dsWt4p2fradNiuILZrg+Li2HffPWLAMf1jn713i+Li+knW077dRnHUkQfHUUceHNXV1fHyKxPikdF/irHP/TUqKyvzehu2b7dR9O69U/Tedcf4yQ7bRbeum0ZRUVHGo2OvPXvFXnv2ioiIRYuXxNhnX4innvlzvPraRDGAACB/lJSURI/uW//vYN89eu7YPVo0b2bD1JJGjUrjp6ceF+eePTA23LBFRtddr169/xusliytiN+NfCiG/+7BqKhYlhfbrrS0JHbvs0vsu89usVufXZKG6Lpq0bxZnHDcEXHCcUfEF3Pmxt33/j4eGvVYLF6y1M6PACC3tG69YfTcsXvs1LN77NyzR2y77ZbRsEEDG6aWNWzQIE468agYMviMaNOmVdb/nmYbNI2fXXROnH7qcTHs9nvi7nt/H998k3szAi1bNo+DDugb+++3Z+zeZ5coLS3Jm/e8Q/u2ceVlQ+Lfhpwdw0c8GLfefk8sX77CwYAAIPOKioqiW9dN/246v3uUd+5kwyS2zdZbxB3Dro0ttuiSe1esLZrHLy6/KE4+8ag4d/BlMeWNqTkRJwce0DcOO7Rf7NZn52Qfj2RKWVmjuOiCM+PE446Ia64fFr//w58cFAgA0iotLYke3bf5h+n85s02sGEypH79enH+uafFzy4eFA2Kc/uQLe/cKZ5+4v647Y574sab7oyqVauy9rdc/Z+XxLFHH1rn9oc2bVrFLb/9zzig395x4cVXxtdfL3aQIABI4/KfXxhnnn6CDZEFTZs2iftG3hy79dk5r4LlgvNPjz69d4oTTjnPAJVIv/32jFdeeDwGnj4kJ2ZcyD9+CAhyVLu2beLpJ+7Lq8H/7/1kh+1i7FMPxSabdPRmJpwNeHz0yOi33542BgIA6oKuXcpj7NMPxVZbdsvr17Fpead49qmHYputt/CmJlJaWhL3jhwaRx5+oI2BAIB81naj1vGHh4dHh/Zt68TradWqZfxh1J1mAhKqX79eDBt6dd7OFiEAoOA1bdokHhl1Z3Ts0K5Ova7WrTeMP4waHi1bNvcmJ9KguDjuG3lzdNmss42BAIB8u4q7b+TNeT/t/0M2Le8UDz9w+zr9pC4/PiDvuPW6vP/KIwIACsqQwWfW+SncHXpsG5f9fLA3O6Hu228dQy4404ZAAEC+DIwXXXhWQbzWs8846TsPG6J2DT73tGjfbiMbAgEAuaysrFHceVvhTNsWFRXFrUOv9myIhEpKSuLiIWfbEPxLfggIsuyiC87MyE8pV1QsizHPvhAvvzI+3n3vw1iwYGFULFsWjcvKomXLFrHN1ptH7149o/8h+yd/wFC7tm3i55ecH//+86vz5n2aMXNWTJz0Vnzw4Sfx0bRPYubM2bG0YlksXrw0aqqro1Gj0mjdesPYeOMOsd22W8YuO+8Qu/XeKUpKsvPcgeOOPSxuvOmOmDtvgYMMAQC5pmOHdnHWGScmXcc331TGrXfcE3cMv/97HyKzZGlFLFlaEdNnfB5Pj/lLXPnLG+PUgcfGxUPOTvqTzycef2SMvOfhmPbxZzn53lRXV8err02MMc++EH99eVzMnDn7X/77VRXLYmnFsvj0s5nx0svjYthtd0fjxmVx1BEHx6CzT8748zKKi+vHMUcfGsNuu9uBxvfyEQBk0aX/MTjpFeLMmbOj38EnxI033fmjnyBXtWpV3DXioei7/zHx3t8+TDpAXXn5kJx7Tz79bGZcfd0t0aPnfnH0cWfFfQ+M/n8H/x+yfPmKuP/B0dFnj8Piyl/emPEnJQ44pr+DDAFA9s2YOSv++OjT8bNLrord+x4R4ye8UdDbY9tttkj6622zZ8+J/keeGu9/MG2d/v9Zs+bE4Uf9NP72/kfJ/sb99tkjeu26Y068H5MmvxUnn3ZB9Nr9f66av5w7v9aWvWr16hg+4sHY94AB6xwT66LLZp39LgA/HOE2ASlUrVoV7777QUyc/FZMnjI1Jk1+KxYsWPgP/6ampqagt9E5Z50SRUVFabZ/VVWccMr5MefLeeu1nCVLK+KEk8+Ll154LNnHAYPOPiXGjZ+StffhtXGT4trrb83IA3U+mvZp9DvkhHjysXujW9dNM/L6evfaKT75dIaTEgKANL7+enFMfuN/BvpJk9+Kt6e+H5WVlTbMD2jTplUcesh+yZZ/3Q23xQcfflwry5rz5by49Irr445h1yb5W/fZe7fovMnGMWPmrIy+B+++92Fcfd3Q+OtL4zK63oULF8XRA86MF/5rdLRq1TL5+vr07hn3PzjaQYcAYP3V1NTEJ5/OiEl/d3XvCmPtDDz5mGjYoEGSZc+ePSdGjBxVq8t87PExcfYZJ8V2225Z639vvXr14vTTjo/Lf/HrjA3Av7zqphj96NNZm4X6cu78GDT40hj98PDk69pi8y4OOAQA62blypUxYeKb/3t1/3ZMnvJ2LFq8xIZZ14OuuH6ccuLRyZY/7PZ7omrVqlqPvpuHjYh7R/w2yd983LH945rrb4mVK79JGq4Pjnosrr52aCxesjTr+8FLL4+LJ5/+r+h/yP5J11PeeeOoV69eVFdXO/gQAKyda64fZiPUol679ozWrTdMFGvfxGNPjE2y7D//+aX46quvk0xbN23aJPru3SeeGfN8kr/9o2mfxgUXXRlvvvVuTu0Lv7l5eBx68H7J7gWJiGjYsGG0b7dRzP7iSwcf/8C3ACDDDjl432TLfu7PL0VFxbIky161enX86ann0m2Xg2r/nojq6uq483cPxD79BuTc4B8R8dFHn2bk5kNPYUQAQLYPuHr14sD99062/L88/3LSv//5F19Ntux9++5Wq08KnDFjVhx21Gnxi1/9JqdvSB3z7IvJ19G4cZmDDwEA2bTzTj2STf/X1NTEiy+9nvTvf33clGSDaZMmjWOvPXatteXdNPSumDDxzZzfJyZOSv83Ni4TAAgAyKo99+iVbNmffjYzvv56cdK/v7KyMt5978O83D65KhM/hbymeo2DDwEAWZ0B6Nkj2bIz9Rn3G2+mW8/OO/UouH2iomJZsvs2vrVk8VIHHwIAsqVBcXHs0GPbZMuf+s77GXkd77z3QbJlb7Vlt2jatEnB7RvLV6xMuvxc+NojAgAK1vbbbx2lpeke/PPxJ9Mz8jo+SbieevXqRc8dty+4faO4fv2ky19kBgABANnT8ydpB7ZPMhQAqUOj547dC27f2GCDdLMeCxcuikWLFjsAEQCQLVtske4nWatWrYov5szNyOtYtmz5dx7sVKvbqdtmBbVftGzZvFa//vjP3p76NwcfAgCyqWuX8mTLnvvl/Iz+rn1tPir3n3VJuJ1y0XbbbpV0+W9Nfc/BhwCAbNos4XPZM3X1n4kAKC/vFPXrF86pKfU9D5Mmv+3gQwBAtrRq1TJaNG+WbgZg3oKMvp65c+clW3bDBg1ik04dC2bfOOTAdD8NvXDhonjt9YkOQAQAZO3qf9NNki7/668XZfT1fL1oSeLt1bkg9outtuyW9N6Qp575c6xe7UeAEACQNW03apN0+Zl+PPPixAHQtm3rgtgvzht0atLlP/r4GAcfAgCyKcUjdP9hQM5wAKQOjlYbtqzz+8Rmm24Shx3aL9ny33jznZg85W0HHwIAsinVA4C+tXTpsoy+niVLK/J6e+WC66+5NIqL0/0A0HU33ObAQwBA1mcAEl/Rrlz5TUZfzzffpF1f6hmTbDvqyINjj913Tbb8CRPfjFdeneDAQwBA1mcAWtW1AKhMu73q8AzApuWd4oZrL0u2/Orq6vjlVTc56BAAkAuaNGmcOABWZvT1pA6Ouvr8+rKyRnH3725Kuj+MuPvhjD0ZEgEA/D9KShomXX5l1arMzgBUpp0BKC0pqXP7QP369WLE8Btj6602T7aODz78OK65/hYHHAIAckXK33qPiFizJrPf9a5eU512eyUOpkwrKiqKG667Ivbtu3uydaxYsTJOP+vfkn88gwAAcmgGoLq6OqOvJ3VwNGzYoI4N/pfFSSccmWwdNTU1MWjwpRl7JDR1Q7FNAPk/A7B69eoMB0Da4ChpWDdmAOrVqxc3Xn9F0sE/IuK6G26Nsc++4EBDAECuaVCc9lDL4IMAIyKiuiZtADSoAzMAZWWNYvjtv45+++2ZdD0PPPRoDB020kGGAIBctCrxFXqmn55Xv179tNsrwzc11raN2rSOUQ/cFtttu2XS9Tz73ItxyaVXO8BYJ+4BgAyoqqpKPCBnOAASB0dl4u2V0lZbdovnxoxKPvi/8uqEOHPQJck/jkEAAOszoFWmHdDq1a+f0ddTP/H6qvJ0BmCvPXvFM3+6Pzq0b5t0PeMnvBEnnTo4Kivd8Y8AgMKeAcj0RwCpA6Ay/2YATjnx6Bh1/+3Jf/Rp4qS34oRTzsv4rz9S97gHADIxA5D4ira0tDSjr6e0tCTx9sqfACgqKopfXD4kBp09MPm6xo2fEseffG6sWLHSQYUAgHywfNnypMtv1CizAVDWqFHa7bV8RV68r6WlJXHnrdfFQQfuk3xdr7w6IU46dbArfwQA5JMFX32deECuWzMAC75amPPvaevWG8aD990aO3TfJvm6xj77Qpw56JLkHyVRWNwDABnw1cK0AdAo8RX5d9eXNji+ShxM62vzbpvFc0+Pysjg/8joJ+OnZ11s8EcAQF7OACxIe0XbrNkGGX09zZtvkNfba33s1mfnGPPUg7Hxxu2Tr+uOu+6PCy660lf9SMJHAJCJGYDEV7Qtmmc2AFq0aJ52ey3MzRmA4wccHjf++ooM/LJjTfziV7+J4SMedPAgACCfzZ03P+0VeYtmmQ2A5mnXN2/egpx6/4qKiuLSS86PC84/Pfm6qlativMvuCyeePI5Bw4CAPLdZ9M/T7r8DVu0yOjradky7QzAp5/NzJn3rqSkJG4delUcdmi/5OtatHhJDPzphTF+whsOGgQA1AXz538VS5ZWRLMNmiZZfvv2G2X09bRvl259q1avjhkzZ+XE+9ayZfN48N5h0XPH7snXNX3G53HciYOSxyJ8y02AkCGfJHxWe7t2mQ2Atm3bpBsIp38eq1evyfr71WWzzvHcM6MyMvhPmPhm9Dv4RIM/AgDqoo8TBkCb1q2iuDhzzwNIOQOQMpR+rF677hhjn34oOm+ycfJ1PfrYM3HUsWfEokWLHSQIAKiLPvzwk2TLrl+/XmzSqWNGXkebNq2iadMm6bbTtE+z+j4dfdQhMfr3d0XzDHy18sab7oxBgy+NqlWrHCBknHsAIEMmvzE16fK7dinPyM1zXTcrT7udprydtffoZxefEz+76Jzk66mqqooLLroyHntirAMDMwBQ102d+rekj2/t0qU8I68j5Xqqq6tj8uTMB0DDBg3ijmHXZmTwX7RocRx57BkGfwQAFIqqVavirbf/lmz53bffOiOvo/v2WyVb9ocffRJLK5Zl9H1p0bxZ/PGR38VRRx6cfF2ffDoj9j/ohJg46S0HBAIACsmEiW8mW/YOPbbNyGtIuZ6U2+f7lHfuFGOffih23eUnydf1+vjJceAhJ+bMVxxBAEAGvfzK+GTL7tihXdK78yMimm3QNLp13SzZ8l9KuH3+2U49e8SzTz8Um226SfJ1PTL6yThmwFmxeMlSBwECAApyBmDSG0mfC9B37z5J//699uwd9eunOW0sX74i/vrSuIy8D4f37xePjx6R/BcNa2pq4rpf3xqDh1wRq1avdgAgAKBQrVlTHWOfezHZ8vftu3vSv3/fvrslW/ZfXngl6U2S3xoy+IwYfvuvo2HDhknXU1lZGWcNuiRuHjbCjo8AACKeGft8smXvvXefZFe1jRuXxYEH9E23XcY8n3S7Nygujlt++5/x80vOj6KioqTrWrhwURx+9Onxp6c80AcBAPyv116fmOxjgIYNGsSAo/snWfbh/ftF48ZlSZa9bNnyeP7FV5Nt82YbNI1HHh4exx17WPL3d9rHn8X+Bx8fUxL/7gMIAMgzq1eviQdGPZps+YPOPiUaNSqt9avnC85L9yjcR0Y/GStWrEyy7E6dOsSYpx6M3XrvlPy9ffW1iXHQoSfF559/YUdHAADfde99f0h2U1ibNq3ivHNOrdVlnnbqgNhkkzQ/NVxTUxMj73k4ybJ36LFtPPf0qOjWddPk7+lDDz8ex55wdixZWmEHRwAA32/e/AXx9DN/Sbb8Cy84I7bfrnZ+sKdrl/K47D8uSPa3vvDX15I8Be+Qg/aNPz16T7Rq1TLpe1lTUxNXXTs0LvrZL3PiKYbwY3kWAGTJnXfdH4f375fkhrQGxcXx4H23xkH9T4pZs+as12zCqAdui9LSkmTb4Y4770+y3F9deXHSv/tbRUVFccWlF8YVl16Ys/va0opl0WWLXg46BABrb/4X7xT833v4UT+N18dPrrXlTX3n/XjiyefiiMMOSLIN2m7UOp587N449fQhMfWd99f6/+/WddO4/55bkj4S9/kXX43Xxk1ygEEW+AgAsujq626JqqqqZMvv2KFdjHnygfj5JedHkyaNf9T/U1JSEoPP+2n815iHk/5K3po11fGrq35rJwAzAFB4Zs+eEyPufjjOPWdgsnU0bNgwhgw+I8447fh4Zuzz8dLL4+Ld9z6M+fO/imXLl0dZWVm02rBlbLP15rH7bjvHoYfsHy2aN0v+2kf9/vH4aNqndgIQAFCYbhp6Vxx84D7J7rL/VpMmjWPAMf1jwDH9s/6a581fENdcP8ybD1nkIwDIsmXLlsegwZfGmjXVBfF6a2pq4vwLr4hFixZ780EAQGGbPOXtuHnY7writY64++F46eVx3nQQAEBExG+H3lWr3zLIRW9P/Vtcde1QbzYIAOBbq1eviYGnXRgffvhJnXx9M2bOiuNPPjcjT/wDBADklSVLK2LAiefEnC/n1anXtXDhojj2+HOSPQQJEACQ9+Z8OS+OPf7s+HLu/Doz+A848ZyYPuNzby4IAOBf+Wjap3HgISfGRx/l9/fkZ8ycFQceetI6/RIhIACgIH0xZ24cfNjJeXtj4FtvvxcHHnqSK38QAMDaWrK0Io4ecGbc8Js7kj0+uLZVV1fH7XfeF4ccPtBn/iAAgHW1evWa+M3Nw//nI4Ec/+ncmTNnR/8jT41fXf3bpM84AAQAFIyp77wfffc/Nq745Q2xYMHCnPrbFi1eEtdcPyx273tETJz0ljcLBABQm6qqquKuEQ9Fz14HxtXX3RJff704q3/P0oplcdPQu6LnLgfELbeOjJUrv/EmQZ7wMCDIQytWrIxht90dw+96IPbbb48YcEz/2HvPPlFcXD/5uqurq+O11yfFI6OfjGfGPh/ffOOHfUAAUGe16bCdjZCLMwKrVsUzY56PZ8Y8H61bbxh99+oTvXv1jN677hgdO7avtfXMnbcgxo2fEuPGT47nX3g1L36oaIed+9lBQABA3bdgwcJ4ZPST8cjoJyMiomPH9rHNVt2ivHOnKC/vFOWdN442bVpF47KyKCtrFGVljaK0tCSqqlbF8uUrYsWKlbFixcqYv+CrmD5jVkyf8XnMmDk7PvhgWnw23Vf5QAAAeWH27Dkxe/YcGwL4Xm4CBAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAEAAAgAAAAAQAACAAAIK8V2wRk2xMj3rYRKDiHn9HdRsAMAAZ/sO+DAMAJEBwDIABw4gPHAggAAEAAAAACAAAQAACAAAAABAAACAAAQAAAAAIAABAAAIAAgLXkSWjgWEAA4MQHjgEQADgBgn0fUiu2CXAiBDADAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIADWxenXdFurf3/5OU/YUwDyyNqet9d2XBAAAIAAAAAEAAAgAAAAAQAACIBcl6vfBPj3vSd6cwDnnzw4XwuAHJHrX/m4b9zR9k6gTsj181khfgXQDAAAmAEAAAQA3+E+AIDcPu/4/F8A/CjuAwAo7PNYoX7+bwYAAAQAP4aPAYBCZ/pfAJABPgYAnL8QAAnUpc9/zAIAzjOFef4XABlimgnAeVkAkNzaTKOZBQBy4erf9L8AyAt1bRpIBADOK4V13hcAGZTp6aa1rWkRAGRr8M/01b/pfwEAAAiAtbMu00FmAQBX//l39W/6XwDkJREAGPwRAAU4C5CJgxggH84brv4FgFmAH3kwCwEg1bnC1b8AKEjZmAVY14NNBAC1fX7IxuDvzn8BUOvyaXpIBACFOPgXwvldAJgFSHqwCwEgH88Frv5rR1Hj5p1rbIbvGnnZtHX6/66+8/CM/60De/1xvZdxw4s7e9PBFX/OX/2v6+Dv6v+7im2C/HffuKPXOwL+/mQgBsCgn4uDP2YAzAIknAkwOwAG/Fwd/F39CwARkKUQAApbNq/6Df61z02ADlIA5xUBQG3VY7bvUnWwAnXlfOLqXwDknVyIACEA5PM5xFf+BEBezgLkys4rAoB8PG+sz/nT1b8AyIkIUPKAc4XztQAoQLk0hSUEgHw4N5j6T8/XANfSun4tMCK7Xw38V3xtEAp30K9rF02u/gWACBADQB4N+gZ/ASACBAFQQAO+wT97PAsgSzt5vkSA+wWAXB/8WTduAsxSbdrZAWrnfOjqXwCIAACDPwJABAAY/PkhbgKsJetzU+C38unmQIBsXvgY/M0A1JmZALMBgMHf4C8AHBwAzm8k5SOAWlYbHwV8y0cCgIHf1b8ZgDxRmzunWgYM/gZ/MwAFPBNgNgAo5IHf4C8ACj4ERADgqh8BYDYAwFU/AqDQIkAIAHV14Df4CwARIASAAhv4Df4CQAQIAaDABn6DvwAQAmIAKKBB38AvAESAGAAKaNA3+AsAEZBBYgDIhUHf4C8AyFIICAIgGwO+gV8AkEMRIAzAQG/wFwAIAQADvwBACAAY+OsiTwN00AA4j5kBwGwAgIFfACAEAAz8AgAxAGDQFwAIAcDAjwBADAAGfQQAYgAw6CMAEASAAR8BgCAADPgIAMQBYJBHAAAASfkpYAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAADIQf8NT/wsnBGqPwsAAAAASUVORK5CYII=");
  }
  if (path === "/app/sw.js") {
    return new Response(`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>e.respondWith(fetch(e.request)));`, { headers: { "content-type": "application/javascript; charset=UTF-8", "cache-control": "no-cache", "service-worker-allowed": "/app/" } });
  }

  const body = request.method === "GET" ? {} : await request.json().catch(() => ({}));

  if (path === "/api/app/status" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_users").first();
    return appJson({ ok: true, configured: Number(row?.n || 0) > 0, morningTime: "06:15" });
  }

  if (path === "/api/app/bootstrap" && request.method === "POST") {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_users").first();
    if (Number(row?.n || 0) > 0) return appJson({ error: "Приложение уже настроено" }, 409);
    const code = String(body.code || "").trim();
    const storedHash = await getSetting(env, "app_setup_code_hash");
    const expires = Number(await getSetting(env, "app_setup_code_expires") || 0);
    if (!storedHash || Date.now() > expires || await sha256Hex(code) !== storedHash) return appJson({ error: "Неверный или просроченный код" }, 403);
    const username = normalizeAppUsername(body.username);
    const displayName = String(body.display_name || "Администратор").trim().slice(0, 60) || "Администратор";
    const password = String(body.password || "");
    if (!username || password.length < 8) return appJson({ error: "Логин: 3–30 символов, пароль: минимум 8" }, 400);
    const salt = randomToken(16), hash = await hashAppPassword(password, salt);
    await env.DB.prepare(`INSERT INTO app_users(username,display_name,password_hash,salt,role,enabled,created_at) VALUES(?,?,?,?, 'owner',1,?)`).bind(username, displayName, hash, salt, new Date().toISOString()).run();
    await ensureAppOwner(env);
    await setSetting(env, "app_setup_code_hash", "");
    await setSetting(env, "app_setup_code_expires", "0");
    return appJson({ ok: true });
  }

  if (path === "/api/app/login" && request.method === "POST") {
    const username = normalizeAppUsername(body.username), password = String(body.password || "");
    const u = await env.DB.prepare("SELECT * FROM app_users WHERE username=?").bind(username).first();
    if (!u || !u.enabled || await hashAppPassword(password, u.salt) !== u.password_hash) return appJson({ error: "Неверный логин или пароль" }, 401);
    const token = randomToken(32), expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await env.DB.prepare("INSERT INTO app_sessions(token,user_id,expires_at) VALUES(?,?,?)").bind(token, u.id, expires.toISOString()).run();
    const nowIso = new Date().toISOString();
    await env.DB.prepare("UPDATE app_users SET last_login_at=?, last_seen_at=? WHERE id=?").bind(nowIso, nowIso, u.id).run();
    await appAudit(env, u.id, "login", "Вход в приложение");
    return appJson({ ok: true }, 200, { "set-cookie": `schedule_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
  }

  if (path === "/api/app/logout" && request.method === "POST") {
    const token = appCookie(request, "schedule_session");
    if (token) await env.DB.prepare("DELETE FROM app_sessions WHERE token=?").bind(token).run();
    return appJson({ ok: true }, 200, { "set-cookie": "schedule_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  }

  const me = await appCurrentUser(request, env);
  if (!me) return appJson({ error: "Требуется вход" }, 401);
  const role = APP_ROLES[me.role] || APP_ROLES.viewer;

  if (path === "/api/app/me" && request.method === "GET") return appJson({ ok: true, user: appPublicUser(me), permissions: role });

  if (path === "/api/app/ping" && request.method === "POST") {
    await env.DB.prepare("UPDATE app_users SET last_seen_at=? WHERE id=?").bind(new Date().toISOString(), me.id).run();
    return appJson({ ok:true });
  }

  if (path === "/api/app/schedule" && request.method === "GET") {
    const date = appDate(url.searchParams.get("date") || todayYMD());
    const row = await env.DB.prepare("SELECT text,version,updated_at FROM schedules WHERE date=?").bind(date).first();
    const draft = await env.DB.prepare("SELECT text,updated_at FROM schedule_drafts WHERE user_id=? AND date=?").bind(me.id,date).first();
    return appJson({ ok: true, date, text: row?.text || "", lessons: row ? parseScheduleLessons(row.text) : [], version:Number(row?.version||0), updatedAt:row?.updated_at||null, draft:draft?{text:draft.text,lessons:parseScheduleLessons(draft.text),updatedAt:draft.updated_at}:null });
  }

  if (path === "/api/app/week" && request.method === "GET") {
    const from = appDate(url.searchParams.get("from") || todayYMD()), to = addDays(from, 13);
    const rows = (await env.DB.prepare("SELECT date,text FROM schedules WHERE date>=? AND date<=? ORDER BY date").bind(from, to).all()).results || [];
    return appJson({ ok: true, rows: rows.map(r => ({ date:r.date, lessons:parseScheduleLessons(r.text), text:r.text })) });
  }

  if (path === "/api/app/schedule" && request.method === "PUT") {
    if (!role.edit) return appJson({ error: "Нет права редактирования" }, 403);
    const date = appDate(body.date), old = await env.DB.prepare("SELECT text,version FROM schedules WHERE date=?").bind(date).first();
    const cfg = await getBotAppSettings(env);
    const lessons = Array.isArray(body.lessons) ? body.lessons.slice(0, cfg.maxLessons) : [];
    const rawMode = Boolean(body.rawMode);
    const text = rawMode ? sanitizeScheduleHtml(String(body.text || "")) : (lessons.length ? buildScheduleHtml(lessons) : sanitizeScheduleHtml(String(body.text || "")));
    if (!text.trim()) return appJson({ error: "Расписание пустое" }, 400);
    const baseVersion = Number(body.baseVersion || 0);
    if (old && baseVersion && Number(old.version||1) !== baseVersion) return appJson({ error:"Расписание уже изменил другой пользователь. Обнови день и проверь изменения.", conflict:true, currentVersion:Number(old.version||1), currentText:old.text },409);
    const nowIso=new Date().toISOString(), nextVersion=old?Number(old.version||1)+1:1;
    await env.DB.prepare(`INSERT INTO schedules(date,text,version,updated_at) VALUES(?,?,?,?) ON CONFLICT(date) DO UPDATE SET text=excluded.text,version=excluded.version,updated_at=excluded.updated_at`).bind(date, text, nextVersion, nowIso).run();
    if (!old || old.text !== text) await env.DB.prepare("INSERT INTO schedule_history(date,old_text,new_text,user_id,action,created_at) VALUES(?,?,?,?,?,?)").bind(date,old?.text||"",text,me.id,"save",nowIso).run();
    await env.DB.prepare("DELETE FROM schedule_drafts WHERE user_id=? AND date=?").bind(me.id,date).run();
    let delivery=null;
    if (body.replacement) { delivery=await notifyReplacement(env, date, text); await logDelivery(env,"replacement",date,delivery?.ok?"ok":"error",delivery?.ok?"Замена отправлена":String(delivery?.description||"Ошибка Telegram"),String(delivery?.result?.message_id||"")); }
    else if (body.notify && (!old || old.text !== text)) { delivery=await notifyScheduleChanged(env, date, text); await logDelivery(env,"change",date,delivery?.ok?"ok":"error",delivery?.ok?"Изменение отправлено":String(delivery?.description||"Ошибка Telegram"),String(delivery?.result?.message_id||"")); }
    await appAudit(env, me.id, "schedule_save", `${date}${body.notify ? " notify" : ""}${body.replacement ? " replacement" : ""}`);
    return appJson({ ok:true, date, text, version:nextVersion, lessons:parseScheduleLessons(text), delivery:delivery?Boolean(delivery.ok):null });
  }

  if (path === "/api/app/schedule" && request.method === "DELETE") {
    if (!role.edit) return appJson({ error: "Нет права редактирования" }, 403);
    const date = appDate(url.searchParams.get("date"));
    const old=await env.DB.prepare("SELECT text FROM schedules WHERE date=?").bind(date).first();
    if(old) await env.DB.prepare("INSERT INTO schedule_history(date,old_text,new_text,user_id,action,created_at) VALUES(?,?,?,?,?,?)").bind(date,old.text,"",me.id,"delete",new Date().toISOString()).run();
    await env.DB.prepare("DELETE FROM schedules WHERE date=?").bind(date).run();
    await env.DB.prepare("DELETE FROM sent_cards WHERE date=?").bind(date).run();
    await appAudit(env, me.id, "schedule_delete", date);
    return appJson({ ok:true });
  }

  if (path === "/api/app/draft" && request.method === "PUT") {
    if (!role.edit) return appJson({error:"Нет права редактирования"},403);
    const date=appDate(body.date),cfg=await getBotAppSettings(env),lessons=Array.isArray(body.lessons)?body.lessons.slice(0,cfg.maxLessons):[];
    const text=body.rawMode?sanitizeScheduleHtml(String(body.text||"")):(lessons.length?buildScheduleHtml(lessons):sanitizeScheduleHtml(String(body.text||"")));
    if(!text.trim()){await env.DB.prepare("DELETE FROM schedule_drafts WHERE user_id=? AND date=?").bind(me.id,date).run();return appJson({ok:true,deleted:true});}
    const now=new Date().toISOString();await env.DB.prepare(`INSERT INTO schedule_drafts(user_id,date,text,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,date) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at`).bind(me.id,date,text,now).run();
    return appJson({ok:true,updatedAt:now});
  }

  if (path === "/api/app/draft" && request.method === "DELETE") {
    const date=appDate(url.searchParams.get("date"));await env.DB.prepare("DELETE FROM schedule_drafts WHERE user_id=? AND date=?").bind(me.id,date).run();return appJson({ok:true});
  }

  if (path === "/api/app/history" && request.method === "GET") {
    const date=url.searchParams.get("date")?appDate(url.searchParams.get("date")):null;
    const rows=date?(await env.DB.prepare(`SELECT h.*,u.display_name FROM schedule_history h LEFT JOIN app_users u ON u.id=h.user_id WHERE h.date=? ORDER BY h.id DESC LIMIT 50`).bind(date).all()).results:(await env.DB.prepare(`SELECT h.*,u.display_name FROM schedule_history h LEFT JOIN app_users u ON u.id=h.user_id ORDER BY h.id DESC LIMIT 80`).all()).results;
    return appJson({ok:true,rows:rows||[]});
  }

  if (path === "/api/app/history/rollback" && request.method === "POST") {
    if(!role.edit)return appJson({error:"Нет права редактирования"},403);const id=Number(body.id);
    const h=await env.DB.prepare("SELECT * FROM schedule_history WHERE id=?").bind(id).first();if(!h)return appJson({error:"Версия не найдена"},404);
    const current=await env.DB.prepare("SELECT text,version FROM schedules WHERE date=?").bind(h.date).first(),target=String(h.old_text||"");const now=new Date().toISOString();
    if(target){const v=Number(current?.version||0)+1;await env.DB.prepare(`INSERT INTO schedules(date,text,version,updated_at) VALUES(?,?,?,?) ON CONFLICT(date) DO UPDATE SET text=excluded.text,version=excluded.version,updated_at=excluded.updated_at`).bind(h.date,target,v,now).run();}
    else await env.DB.prepare("DELETE FROM schedules WHERE date=?").bind(h.date).run();
    await env.DB.prepare("INSERT INTO schedule_history(date,old_text,new_text,user_id,action,created_at) VALUES(?,?,?,?,?,?)").bind(h.date,current?.text||"",target,me.id,"rollback",now).run();
    await appAudit(env,me.id,"schedule_rollback",`${h.date} history=${id}`);return appJson({ok:true,date:h.date});
  }

  if (path === "/api/app/backup" && request.method === "GET") {
    if(!role.settings)return appJson({error:"Резервные копии доступны владельцу"},403);
    const schedules=(await env.DB.prepare("SELECT date,text,version,updated_at FROM schedules ORDER BY date").all()).results||[];const cfg=await getBotAppSettings(env);
    return appJson({ok:true,backup:{format:"schedule102-backup-v1",createdAt:new Date().toISOString(),schedules,settings:cfg}});
  }

  if (path === "/api/app/backup" && request.method === "POST") {
    if(!role.settings)return appJson({error:"Восстановление доступно владельцу"},403);const b=body.backup||body;if(b.format!=="schedule102-backup-v1"||!Array.isArray(b.schedules))return appJson({error:"Неверный файл резервной копии"},400);
    let n=0;for(const r of b.schedules.slice(0,500)){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date||"")))continue;const text=sanitizeScheduleHtml(String(r.text||""));if(!text)continue;await env.DB.prepare(`INSERT INTO schedules(date,text,version,updated_at) VALUES(?,?,?,?) ON CONFLICT(date) DO UPDATE SET text=excluded.text,version=excluded.version,updated_at=excluded.updated_at`).bind(r.date,text,Number(r.version||1),new Date().toISOString()).run();n++;}
    await appAudit(env,me.id,"backup_restore",String(n));return appJson({ok:true,restored:n});
  }

  if (path === "/api/app/system" && request.method === "GET") {
    const latestCron=await env.DB.prepare("SELECT * FROM cron_runs ORDER BY id DESC LIMIT 1").first();const deliveries=(await env.DB.prepare("SELECT * FROM delivery_log ORDER BY id DESC LIMIT 12").all()).results||[];const histories=(await env.DB.prepare(`SELECT h.id,h.date,h.action,h.created_at,u.display_name FROM schedule_history h LEFT JOIN app_users u ON u.id=h.user_id ORDER BY h.id DESC LIMIT 8`).all()).results||[];
    const scheduleCount=Number((await env.DB.prepare("SELECT COUNT(*) n FROM schedules").first())?.n||0),draftCount=Number((await env.DB.prepare("SELECT COUNT(*) n FROM schedule_drafts").first())?.n||0);
    return appJson({ok:true,db:true,latestCron,deliveries,histories,scheduleCount,draftCount,now:new Date().toISOString()});
  }

  if (path === "/api/app/users" && request.method === "GET") {
    if (!role.users) return appJson({ error: "Нет доступа" }, 403);
    const ownerId = await ensureAppOwner(env);
    const rows = (await env.DB.prepare("SELECT id,username,display_name,role,enabled,created_at,last_login_at,last_seen_at FROM app_users ORDER BY id").all()).results || [];
    const onlineAfter = Date.now() - 105000;
    const users = rows.map(u => ({...u, primary_owner:Number(u.id)===Number(ownerId), online:Boolean(u.enabled && u.last_seen_at && Date.parse(u.last_seen_at)>=onlineAfter)}));
    return appJson({ ok:true, primaryOwnerId: ownerId, onlineCount:users.filter(u=>u.online).length, users });
  }

  if (path === "/api/app/users" && request.method === "POST") {
    if (!role.users) return appJson({ error: "Нет доступа" }, 403);
    const username = normalizeAppUsername(body.username), password = String(body.password || ""), newRole = String(body.role || "viewer");
    if (!username || password.length < 8 || !APP_ROLES[newRole]) return appJson({ error: "Проверь логин, пароль и роль" }, 400);
    if (newRole === "owner" && me.role !== "owner") return appJson({ error: "Только владелец может создать полный доступ" }, 403);
    const salt = randomToken(16), hash = await hashAppPassword(password, salt);
    try {
      await env.DB.prepare("INSERT INTO app_users(username,display_name,password_hash,salt,role,enabled,created_at) VALUES(?,?,?,?,?,1,?)").bind(username, String(body.display_name||username).trim().slice(0,60), hash, salt, newRole, new Date().toISOString()).run();
    } catch { return appJson({ error:"Такой логин уже существует" },409); }
    await appAudit(env, me.id, "user_create", `${username}:${newRole}`);
    return appJson({ ok:true });
  }

  if (path === "/api/app/users" && request.method === "PATCH") {
    if (!role.users) return appJson({ error: "Нет доступа" }, 403);
    const id = Number(body.id), target = await env.DB.prepare("SELECT * FROM app_users WHERE id=?").bind(id).first();
    if (!target) return appJson({ error:"Пользователь не найден" },404);
    const ownerId = await ensureAppOwner(env);
    if (target.role === "owner" && me.role !== "owner") return appJson({ error:"Нельзя менять владельца" },403);
    const newRole = APP_ROLES[String(body.role)] ? String(body.role) : target.role;
    if (newRole === "owner" && me.role !== "owner") return appJson({ error:"Только владелец может дать полный доступ" },403);
    if (Number(id) === Number(ownerId) && (newRole !== "owner" || body.enabled === false)) {
      return appJson({ error:"Главный аккаунт нельзя понизить или отключить" },403);
    }
    const enabled = Number(id) === Number(ownerId) ? 1 : (body.enabled === undefined ? Number(target.enabled) : (body.enabled ? 1 : 0));
    const display = String(body.display_name ?? target.display_name).trim().slice(0,60) || target.display_name;
    await env.DB.prepare("UPDATE app_users SET display_name=?,role=?,enabled=? WHERE id=?").bind(display,newRole,enabled,id).run();
    if (body.password) {
      const pass=String(body.password); if(pass.length<8)return appJson({error:"Пароль минимум 8 символов"},400);
      const salt=randomToken(16),hash=await hashAppPassword(pass,salt); await env.DB.prepare("UPDATE app_users SET password_hash=?,salt=? WHERE id=?").bind(hash,salt,id).run();
    }
    await appAudit(env, me.id, "user_update", String(id));
    return appJson({ok:true});
  }

  if (path === "/api/app/users" && request.method === "DELETE") {
    if (!role.users) return appJson({ error: "Нет доступа" }, 403);
    const id=Number(url.searchParams.get("id")), target=await env.DB.prepare("SELECT * FROM app_users WHERE id=?").bind(id).first();
    if(!target)return appJson({error:"Пользователь не найден"},404);
    const ownerId = await ensureAppOwner(env);
    if(Number(id)===Number(ownerId) || target.role==="owner")return appJson({error:"Главный аккаунт удалить нельзя"},403);
    await env.DB.prepare("DELETE FROM app_sessions WHERE user_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM app_users WHERE id=?").bind(id).run();
    await appAudit(env, me.id, "user_delete", String(id));
    return appJson({ok:true});
  }

  if (path === "/api/app/settings" && request.method === "GET") {
    const cfg = await getBotAppSettings(env);
    const groupId = role.settings ? await getSetting(env, "group_chat_id") : "";
    return appJson({ ok: true, settings: cfg, groupChatId: groupId || "", timezone: TZ });
  }

  if (path === "/api/app/settings" && request.method === "PATCH") {
    if (!role.settings) return appJson({ error: "Настройки доступны только владельцу" }, 403);
    const current = await getBotAppSettings(env);
    const next = normalizeBotAppSettings({ ...current, ...(body.settings || {}) });
    await saveBotAppSettings(env, next);
    if (body.groupChatId !== undefined) {
      const gid = String(body.groupChatId || "").trim();
      if (gid && !/^-?\d{5,20}$/.test(gid)) return appJson({ error: "Некорректный Telegram Chat ID" }, 400);
      await setSetting(env, "group_chat_id", gid);
    }
    await appAudit(env, me.id, "bot_settings", JSON.stringify(next));
    return appJson({ ok: true, settings: next });
  }

  if (path === "/api/app/actions/resend-morning" && request.method === "POST") {
    if (!role.settings) return appJson({ error: "Нет доступа" }, 403);
    const date = appDate(body.date || todayYMD());
    await env.DB.prepare("DELETE FROM sent_cards WHERE date=?").bind(date).run();
    await appAudit(env, me.id, "morning_unlock", date);
    return appJson({ ok: true });
  }

  if (path === "/api/app/actions/test-message" && request.method === "POST") {
    if (!role.settings) return appJson({ error: "Нет доступа" }, 403);
    const groupId = await getSetting(env, "group_chat_id");
    if (!groupId) return appJson({ error: "Telegram-группа не привязана" }, 400);
    const r = await sendMessage(env, groupId, "✅ <b>Тест панели расписания</b>\n\nСвязь с Telegram работает.");
    if (!r?.ok) return appJson({ error: "Telegram не принял сообщение" }, 502);
    return appJson({ ok: true });
  }

  if (path === "/api/app/dashboard" && request.method === "GET") {
    const today=todayYMD(), groupId=await getSetting(env,"group_chat_id"), sent=await env.DB.prepare("SELECT sent_at FROM sent_cards WHERE date=?").bind(today).first();
    const row=await env.DB.prepare("SELECT text FROM schedules WHERE date=?").bind(today).first();
    const cfg=await getBotAppSettings(env);
    const latestCron=await env.DB.prepare("SELECT status,details,run_at FROM cron_runs ORDER BY id DESC LIMIT 1").first();const since7=new Date(Date.now()-7*86400000).toISOString(),sinceOnline=new Date(Date.now()-3*60000).toISOString();const failed=Number((await env.DB.prepare("SELECT COUNT(*) n FROM delivery_log WHERE status='error' AND created_at>?").bind(since7).first())?.n||0);const online=Number((await env.DB.prepare("SELECT COUNT(*) n FROM app_users WHERE enabled=1 AND last_seen_at>=?").bind(sinceOnline).first())?.n||0);
    return appJson({ok:true,today,groupBound:Boolean(groupId),morningTime:cfg.morningTime,morningEnabled:cfg.morningEnabled,retryMinutes:cfg.retryMinutes,sentAt:sent?.sent_at||null,lessons:row?parseScheduleLessons(row.text):[],latestCron,failedDeliveries:failed,online});
  }

  return appJson({ error: "Не найдено" }, 404);
}

function appJson(data, status=200, extra={}) { return new Response(JSON.stringify(data), { status, headers: { "content-type":"application/json; charset=UTF-8", "cache-control":"no-store", ...extra } }); }
function appCookie(request,name){const c=request.headers.get("cookie")||"";for(const part of c.split(";")){const [k,...v]=part.trim().split("=");if(k===name)return decodeURIComponent(v.join("="));}return null;}
async function appCurrentUser(request,env){const token=appCookie(request,"schedule_session");if(!token)return null;const row=await env.DB.prepare(`SELECT u.* FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.enabled=1`).bind(token,new Date().toISOString()).first();return row||null;}
function appPublicUser(u){return {id:u.id,username:u.username,display_name:u.display_name,role:u.role,enabled:Boolean(u.enabled),last_login_at:u.last_login_at||null,last_seen_at:u.last_seen_at||null};}
function normalizeAppUsername(v){const x=String(v||"").trim().toLowerCase();return /^[a-z0-9_.-]{3,30}$/.test(x)?x:"";}
function appDate(v){const x=String(v||"");if(!/^\d{4}-\d{2}-\d{2}$/.test(x))throw new Error("bad date");return x;}
function randomToken(bytes=24){const a=new Uint8Array(bytes);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,"0")).join("");}
async function sha256Hex(v){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(v)));return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,"0")).join("");}
async function hashAppPassword(password,salt){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);const bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:new TextEncoder().encode(salt),iterations:12000},key,256);return Array.from(new Uint8Array(bits),x=>x.toString(16).padStart(2,"0")).join("");}
async function appAudit(env,userId,action,details=""){await env.DB.prepare("INSERT INTO app_audit(user_id,action,details,created_at) VALUES(?,?,?,?)").bind(userId,action,details,new Date().toISOString()).run();}
function sanitizeScheduleHtml(t){return String(t||"").replace(/<script[\s\S]*?<\/script>/gi,"").trim();}
function buildScheduleHtml(lessons){return lessons.slice(0,8).map((x,i)=>{const n=Number(x.lesson_no)||i+1;const nums=["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣"];const subject=escapeHtml(String(x.subject||"Без названия").trim());const time=escapeHtml(String(x.time||"").trim());const teacher=escapeHtml(String(x.teacher||"").trim());const room=escapeHtml(String(x.room||"").trim());return `${nums[n-1]||n+"."} <b>${subject}</b>${time?`\n⏰ ${time}`:""}${teacher?`\n👨‍🏫 ${teacher}`:""}${room?`\n📍 ${/^каб/i.test(room)?room:"Кабинет "+room}`:""}`;}).join("\n\n");}
function parseScheduleLessons(html){const t=stripHtml(String(html||"")).replace(/\r/g,"");const blocks=t.split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);const out=[];for(const block of blocks){const lines=block.split("\n").map(x=>x.trim()).filter(Boolean);let m=lines[0]?.match(/^(1️⃣|2️⃣|3️⃣|4️⃣|5️⃣|6️⃣|7️⃣|8️⃣|\d+[.)]?)[\s]*(.*)$/);if(!m)continue;const map={"1️⃣":1,"2️⃣":2,"3️⃣":3,"4️⃣":4,"5️⃣":5,"6️⃣":6,"7️⃣":7,"8️⃣":8};let n=map[m[1]]||parseInt(m[1],10)||out.length+1;let subject=m[2]||"";let time="",teacher="",room="";for(const line of lines.slice(1)){if(line.startsWith("⏰"))time=line.replace(/^⏰\s*/,"");else if(/^👨‍🏫|^👩‍🏫/.test(line))teacher=line.replace(/^(👨‍🏫|👩‍🏫)\s*/,"");else if(line.startsWith("📍"))room=line.replace(/^📍\s*/,"").replace(/^Кабинет\s*/i,"").replace(/^Каб\.\s*/i,"");}out.push({lesson_no:n,subject,time,teacher,room});}return out.sort((a,b)=>a.lesson_no-b.lesson_no);}

const BOT_APP_DEFAULTS = {
  morningEnabled: true,
  morningTime: "06:15",
  retryMinutes: 90,
  showMorningStats: true,
  autoNotifyChanges: false,
  confirmNotifications: true,
  maxLessons: 8,
  morningTitle: "☀️ ДОБРОЕ УТРО!",
  changeTitle: "🔄 РАСПИСАНИЕ ОБНОВЛЕНО",
  replacementTitle: "🚨 ВНИМАНИЕ! ЗАМЕНА 🚨",
  cardFooter: "☕ Хорошего дня!"
};
function normalizeBotAppSettings(v={}){
  let time=/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(v.morningTime||""))?String(v.morningTime):BOT_APP_DEFAULTS.morningTime;
  const tm=hhmmToMinutes(time); if(tm<300||tm>540) time=BOT_APP_DEFAULTS.morningTime;
  return {
    morningEnabled:v.morningEnabled!==false,
    morningTime:time,
    retryMinutes:Math.max(15,Math.min(120,Number(v.retryMinutes)||90)),
    showMorningStats:v.showMorningStats!==false,
    autoNotifyChanges:Boolean(v.autoNotifyChanges),
    confirmNotifications:v.confirmNotifications!==false,
    maxLessons:Math.max(4,Math.min(12,Number(v.maxLessons)||8)),
    morningTitle:String(v.morningTitle||BOT_APP_DEFAULTS.morningTitle).trim().slice(0,80)||BOT_APP_DEFAULTS.morningTitle,
    changeTitle:String(v.changeTitle||BOT_APP_DEFAULTS.changeTitle).trim().slice(0,80)||BOT_APP_DEFAULTS.changeTitle,
    replacementTitle:String(v.replacementTitle||BOT_APP_DEFAULTS.replacementTitle).trim().slice(0,80)||BOT_APP_DEFAULTS.replacementTitle,
    cardFooter:String(v.cardFooter||"").trim().slice(0,300)
  };
}
async function getBotAppSettings(env){
  const raw=await getSetting(env,"app_bot_settings");
  if(!raw)return {...BOT_APP_DEFAULTS};
  try{return normalizeBotAppSettings({...BOT_APP_DEFAULTS,...JSON.parse(raw)});}catch{return {...BOT_APP_DEFAULTS};}
}
async function saveBotAppSettings(env,cfg){await setSetting(env,"app_bot_settings",JSON.stringify(normalizeBotAppSettings(cfg)));}

function base64PngResponse(b64){
  const bin=atob(b64),bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  return new Response(bytes,{headers:{"content-type":"image/png","cache-control":"public, max-age=86400"}});
}

function appIconSvg(){return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8b5cf6"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs><rect width="512" height="512" rx="120" fill="#0b1020"/><rect x="62" y="58" width="388" height="396" rx="72" fill="url(#g)" opacity=".2"/><path d="M140 116h232a34 34 0 0 1 34 34v250H106V150a34 34 0 0 1 34-34Z" fill="#151a2d" stroke="#a78bfa" stroke-width="12"/><text x="256" y="295" text-anchor="middle" font-size="150" font-family="Arial,sans-serif" font-weight="800" fill="#fff">102</text><path d="M154 352h204" stroke="#c4b5fd" stroke-width="14" stroke-linecap="round"/></svg>`;}

function appHtml(){return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"><meta name="theme-color" content="#17122b"><link rel="manifest" href="/app/manifest.webmanifest"><link rel="icon" href="/app/icon.svg"><link rel="apple-touch-icon" href="/app/icon-192.png"><title>Расписание 102</title><style>
:root{color-scheme:dark;--bg:#080910;--panel:#11131d;--panel2:#171a28;--line:#2a3042;--txt:#f7f7fb;--muted:#9aa2b8;--accent:#8b5cf6;--accent2:#6366f1;--green:#22c55e;--red:#ef4444;--shadow:0 20px 70px #0008;--safe:env(safe-area-inset-bottom,0px)}*{box-sizing:border-box;min-width:0}html,body{margin:0;width:100%;max-width:100%;overflow-x:hidden;background:var(--bg);overscroll-behavior-x:none}body{font:15px Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:var(--txt);min-height:100dvh;background:radial-gradient(circle at 8% -5%,#4c1d9542,transparent 34%),radial-gradient(circle at 100% 4%,#312e8138,transparent 29%),var(--bg)}button,input,select,textarea{font:inherit}.hidden{display:none!important}.wrap{width:min(1180px,100%);margin:0 auto;padding:clamp(14px,2.8vw,28px) clamp(12px,2.2vw,20px) calc(98px + var(--safe))}.glass{background:#11131eea;border:1px solid #2b3043;border-radius:24px;box-shadow:var(--shadow);backdrop-filter:blur(18px)}.auth{width:min(460px,100%);margin:7vh auto;padding:clamp(22px,5vw,32px)}.brand{display:flex;gap:13px;align-items:center}.brand img{width:50px;height:50px;flex:none}.brand h1{margin:0;font-size:clamp(20px,5vw,25px)}.muted{color:var(--muted)}h2,h3{margin:0}.field{display:grid;gap:7px;margin:13px 0}.field label,.label{color:#bac1d4;font-size:12px;font-weight:650}.input,select,textarea{width:100%;border:1px solid #30374b;background:#0c0f18;color:white;padding:12px 13px;border-radius:13px;outline:none}.input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px #8b5cf624}textarea{resize:vertical;min-height:120px}.btn{border:0;border-radius:13px;padding:11px 15px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:750;cursor:pointer;white-space:nowrap}.btn.secondary{background:#1b2030;border:1px solid #343b51}.btn.ghost{background:transparent;border:1px solid #343b51}.btn.danger{background:#3b171d;color:#fecaca;border:1px solid #7f1d1d}.btn:disabled{opacity:.45;cursor:not-allowed}.iconbtn{width:42px;height:42px;padding:0;display:grid;place-items:center;flex:none}.iconbtn svg,.nav svg{width:21px;height:21px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.error{color:#fca5a5;margin-top:10px}.install-btn{display:flex;align-items:center;justify-content:center;gap:9px;background:linear-gradient(135deg,#16a34a,#0d9488);box-shadow:0 10px 30px #0d948833}.install-btn svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.install-hint{text-align:center;color:var(--muted);font-size:12px;line-height:1.45;margin:7px 8px 2px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;gap:12px}.user-chip{display:flex;align-items:center;gap:9px;background:#131725;border:1px solid var(--line);padding:7px 10px;border-radius:15px;max-width:46%}.user-chip>div:last-child{overflow:hidden}.user-chip b,.user-chip .muted{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.avatar{width:34px;height:34px;border-radius:11px;background:linear-gradient(135deg,var(--accent),#4338ca);display:grid;place-items:center;font-weight:800;flex:none}.layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:18px}.nav{padding:10px;height:max-content;position:sticky;top:18px}.nav button{width:100%;display:flex;gap:11px;align-items:center;border:0;background:transparent;color:#aeb6ca;padding:12px;border-radius:13px;cursor:pointer}.nav button.on{background:#8b5cf621;color:#fff}.content{width:100%;min-width:0}.hero,.card{padding:clamp(16px,3vw,22px);margin-bottom:14px}.hero{background:linear-gradient(135deg,#1a1730,#101522);border:1px solid #38305f}.hero-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px;margin-top:16px}.metric{background:#0d111c;border:1px solid #2b3145;padding:14px;border-radius:16px}.metric b{display:block;font-size:21px;margin-top:4px;overflow-wrap:anywhere}.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin-bottom:13px}.toolbar.end{justify-content:flex-end}.datebox{flex:0 1 190px}.card-title{display:flex;align-items:center;gap:10px;justify-content:space-between;margin-bottom:12px}.lesson{display:grid;grid-template-columns:48px minmax(140px,1.45fr) minmax(120px,.9fr) minmax(140px,1fr) minmax(90px,.65fr) auto;gap:9px;align-items:end;padding:13px 0;border-bottom:1px solid #252b3d}.lesson:last-child{border-bottom:0}.num{width:43px;height:43px;border-radius:14px;background:#8b5cf61c;border:1px solid #6d5dfc55;display:grid;place-items:center;font-weight:850}.lesson .field{margin:0}.lesson-actions{display:flex;gap:6px;align-items:center}.switch{display:flex;gap:8px;align-items:center;background:#0d1019;border:1px solid #2c3348;padding:10px 12px;border-radius:13px}.switch input{accent-color:var(--accent);flex:none}.seg{display:flex;background:#0d1019;border:1px solid #2c3348;border-radius:14px;padding:4px;gap:4px}.seg button{border:0;background:transparent;color:#aab2c7;padding:8px 12px;border-radius:10px;cursor:pointer}.seg button.on{background:#292240;color:white}.quickbar{display:flex;gap:8px;flex-wrap:wrap}.quickbar .btn{padding:9px 11px}.notice{padding:12px 14px;border-radius:14px;background:#171528;border:1px solid #3b3163;color:#d8d4ff}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.setting-card{padding:16px;background:#0d111b;border:1px solid #292f42;border-radius:17px}.setting-card h3{font-size:16px;margin-bottom:5px}.presence-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}.presence-card{background:#0d111b;border:1px solid #292f42;border-radius:17px;padding:14px}.presence-card b{display:block;font-size:22px;margin-top:3px}.user-row{display:grid;grid-template-columns:minmax(190px,1.25fr) minmax(180px,1fr) 180px 120px auto;gap:11px;align-items:center;padding:14px;margin:9px 0;background:#0d111b;border:1px solid #292f42;border-radius:18px}.user-identity{display:flex;align-items:center;gap:11px}.user-avatar{width:42px;height:42px;border-radius:14px;background:linear-gradient(135deg,#7c3aed,#4338ca);display:grid;place-items:center;font-weight:850;flex:none}.presence-line{display:flex;align-items:center;gap:7px;margin-top:4px;font-size:12px}.presence-dot{width:9px;height:9px;border-radius:50%;background:#64748b;box-shadow:0 0 0 3px #64748b20;flex:none}.presence-dot.online{background:#22c55e;box-shadow:0 0 0 4px #22c55e20,0 0 14px #22c55e80}.presence-dot.recent{background:#f59e0b;box-shadow:0 0 0 4px #f59e0b18}.activity-meta{display:grid;gap:3px;font-size:12px;color:var(--muted)}.activity-meta strong{color:#dce2f2;font-weight:650}.toast{position:fixed;left:50%;bottom:calc(78px + var(--safe));transform:translateX(-50%);max-width:calc(100vw - 24px);background:#171c2d;border:1px solid #39425f;padding:11px 15px;border-radius:14px;box-shadow:var(--shadow);z-index:40;text-align:center}.rawbox{margin-top:12px}.statusdot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--green);margin-right:6px}.subject-input-wrap{display:grid;grid-template-columns:minmax(0,1fr) 42px;gap:7px}.subject-pick-btn{width:42px;height:42px;padding:0;display:grid;place-items:center;border-radius:13px}.subject-pick-btn svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.sheet-backdrop{position:fixed;inset:0;background:#03040aaa;backdrop-filter:blur(7px);z-index:80;opacity:0;transition:opacity .18s ease}.sheet-backdrop.show{opacity:1}.subject-sheet{position:fixed;left:50%;bottom:0;transform:translate(-50%,105%);width:min(720px,100%);max-height:min(82dvh,760px);z-index:81;background:linear-gradient(180deg,#171a28,#0e111b);border:1px solid #343b54;border-bottom:0;border-radius:26px 26px 0 0;box-shadow:0 -24px 80px #000a;transition:transform .24s cubic-bezier(.2,.8,.2,1);display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom,0px)}.subject-sheet.show{transform:translate(-50%,0)}.sheet-handle{width:46px;height:5px;border-radius:999px;background:#475069;margin:9px auto 7px}.sheet-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 17px 12px}.sheet-head h3{font-size:19px}.sheet-close{width:38px;height:38px;padding:0;border-radius:12px}.sheet-search{padding:0 17px 12px}.subject-list{overflow:auto;padding:0 12px 18px;overscroll-behavior:contain}.subject-option{width:100%;display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:center;gap:11px;text-align:left;background:#101521;border:1px solid #293149;color:#fff;padding:11px;border-radius:17px;margin:7px 0;cursor:pointer}.subject-option:active{transform:scale(.992)}.subject-icon{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(135deg,#8b5cf62e,#4f46e52e);border:1px solid #8b5cf64a;font-size:20px}.subject-copy b{display:block;font-size:14px;line-height:1.25}.subject-copy small{display:block;color:var(--muted);margin-top:4px;line-height:1.25}.subject-arrow{color:#8992aa;font-size:22px;padding-right:3px}.subject-custom{margin:9px 5px 2px;width:calc(100% - 10px)}.variant-title{padding:3px 5px 8px;color:var(--muted);font-size:12px}.subject-current{font-size:12px;color:#c4b5fd;margin-top:2px}.lesson .subj[readonly]{cursor:pointer;background:#101522}.lesson .subj[readonly]:hover{border-color:#6d5dfc88}@media(max-width:560px){.subject-sheet{border-radius:24px 24px 0 0;max-height:86dvh}.sheet-head{padding-left:14px;padding-right:14px}.sheet-search{padding-left:14px;padding-right:14px}.subject-list{padding-left:9px;padding-right:9px}.subject-option{grid-template-columns:40px minmax(0,1fr) auto}.subject-icon{width:40px;height:40px}.subject-input-wrap{grid-template-columns:minmax(0,1fr) 42px}}.sticky-save{position:sticky;bottom:90px;z-index:6;padding-top:8px;background:linear-gradient(transparent,var(--bg) 45%)}
@media(max-width:920px){.layout{display:block}.nav{position:fixed;left:10px;right:10px;bottom:calc(8px + var(--safe));top:auto;z-index:30;display:grid;grid-template-columns:repeat(5,1fr);padding:7px;border-radius:20px}.nav button{display:grid;place-items:center;gap:3px;padding:7px 3px;font-size:10px}.nav svg{width:22px;height:22px}.hero-grid{grid-template-columns:1fr 1fr}.lesson{grid-template-columns:46px minmax(0,1fr) minmax(0,1fr)}.lesson .subject{grid-column:2/4}.lesson-actions{grid-column:2/4}.settings-grid{grid-template-columns:1fr}.presence-summary{grid-template-columns:1fr 1fr 1fr}.user-row{grid-template-columns:1fr 1fr}.user-row .actions{grid-column:1/-1}.top .brand .muted{display:none}}
@media(max-width:560px){.wrap{padding:12px 10px calc(94px + var(--safe))}.glass{border-radius:20px}.top{align-items:flex-start}.top .brand img{width:42px;height:42px}.top .brand h1{font-size:18px}.user-chip{max-width:48%;padding:6px 8px}.user-chip .avatar{width:30px;height:30px}.hero-grid{grid-template-columns:1fr}.toolbar .grow{flex:1 0 100%}.datebox{flex:1 1 145px}.lesson{grid-template-columns:42px minmax(0,1fr)}.lesson .subject,.lesson .field,.lesson-actions{grid-column:2}.lesson .num{grid-row:1/6}.lesson-actions{justify-content:flex-start}.settings-grid{grid-template-columns:1fr}.presence-summary{grid-template-columns:1fr}.user-row{grid-template-columns:1fr}.user-row>*{width:100%}.nav span{font-size:9px}.btn{padding:10px 12px}.seg{width:100%}.seg button{flex:1}.quickbar{display:grid;grid-template-columns:1fr 1fr}.quickbar .btn{width:100%}}
</style></head><body><div class="wrap"><section id="auth" class="auth glass"><div class="brand"><img src="/app/icon.svg"><div><h1>Расписание 102</h1><div class="muted">Управление без Telegram</div></div></div><div id="loginBox"><div class="field"><label>Логин</label><input id="login" class="input" autocomplete="username"></div><div class="field"><label>Пароль</label><input id="pass" class="input" type="password" autocomplete="current-password"></div><button class="btn" id="loginBtn" style="width:100%">Войти</button><button class="btn install-btn" id="installApp" style="width:100%;margin-top:9px"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/></svg><span>Установить приложение</span></button><div id="installHint" class="install-hint">Установи один раз — дальше входи как в обычное приложение.</div></div><div id="authErr" class="error"></div></section>
<section id="app" class="hidden"><div class="top"><div class="brand"><img src="/app/icon.svg"><div><h1>Расписание 102</h1><div class="muted">Панель управления</div></div></div><div class="user-chip"><div class="avatar" id="avatar">A</div><div><b id="userName">...</b><div class="muted" id="userRole"></div></div></div></div><div class="layout"><nav class="nav glass"><button data-page="home" class="on" aria-label="Главная"><svg viewBox="0 0 24 24"><path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg><span>Главная</span></button><button data-page="schedule" aria-label="Расписание"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></svg><span>Расписание</span></button><button data-page="users" id="usersNav" aria-label="Доступ"><svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg><span>Доступ</span></button><button data-page="settings" id="settingsNav" aria-label="Настройки"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06-2.83 2.83-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.4 1v.1h-4v-.1a1.65 1.65 0 0 0-.4-1 1.65 1.65 0 0 0-1-.6 1.65 1.65 0 0 0-1.82.33l-.06.06-2.83-2.83.06-.06A1.65 1.65 0 0 0 3.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1-.4h-.1v-4H2a1.65 1.65 0 0 0 1-.4 1.65 1.65 0 0 0 .6-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06 2.83-2.83.06.06A1.65 1.65 0 0 0 8 3.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .4-1h4a1.65 1.65 0 0 0 .4 1 1.65 1.65 0 0 0 1 .6 1.65 1.65 0 0 0 1.82-.33l.06-.06 2.83 2.83-.06.06A1.65 1.65 0 0 0 19.4 8c.14.37.36.7.65.98.28.29.62.51 1 .65h.1v4h-.1a1.65 1.65 0 0 0-1 .4c-.29.28-.51.62-.65.97z"/></svg><span>Настройки</span></button><button data-page="about" aria-label="Система"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg><span>Система</span></button></nav><main class="content" id="content"></main></div></section></div><div id="toast" class="toast hidden"></div><script>
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let deferredInstallPrompt=null;
const isStandalone=()=>window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;const b=$('#installApp');if(b)b.classList.remove('hidden')});
window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;const b=$('#installApp'),h=$('#installHint');if(b)b.classList.add('hidden');if(h)h.textContent='Приложение установлено ✓'});
const api=async(path,opt={})=>{const r=await fetch(path,{headers:{'content-type':'application/json'},...opt});const txt=await r.text();let d;try{d=txt?JSON.parse(txt):{}}catch{throw Error('Ошибка сервера: '+txt.slice(0,160))}if(!r.ok)throw Error(d.error||'Ошибка '+r.status);return d};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let ME=null,PERM={},currentDate=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Chisinau'}),clipDay=null,APPSET={maxLessons:8,autoNotifyChanges:false,confirmNotifications:true};
const fmt=d=>new Date(d+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'}),weekday=d=>new Date(d+'T12:00:00').toLocaleDateString('ru-RU',{weekday:'long'}),roleName=r=>({viewer:'Только просмотр',editor:'Редактор',admin:'Администратор',owner:'Полный доступ'})[r]||r;
function toast(t){const e=$('#toast');e.textContent=t;e.classList.remove('hidden');clearTimeout(window._tt);window._tt=setTimeout(()=>e.classList.add('hidden'),2500)}
function shiftSchool(d,delta){let x=new Date(d+'T12:00:00');do{x.setDate(x.getDate()+delta)}while([0,6].includes(x.getDay()));return x.toLocaleDateString('en-CA')}
function iconBtn(label,cls,svg){return '<button class="btn secondary iconbtn '+cls+'" title="'+label+'" aria-label="'+label+'">'+svg+'</button>'}
const SVG={up:'<svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg>',down:'<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',copy:'<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',trash:'<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg>'};
const BELL_TIMES=['08:30 – 09:50','10:00 – 11:20','11:40 – 13:00','13:10 – 14:30','14:40 – 16:00'];
const SUBJECTS=[
 {name:'Родной (русский) язык',icon:'А',variants:[{teacher:'Силаева М.К.',room:'107'}]},
 {name:'Математика',icon:'∑',variants:[{teacher:'Савва Т.А.',room:'201'}]},
 {name:'Физика',icon:'⚛',variants:[{teacher:'Холошной П.В.',room:'206'}]},
 {name:'Иностранный язык (англ./нем.)',icon:'Aa',variants:[{teacher:'Селевина И.М.',room:'303',label:'Английский язык'},{teacher:'Кириченко О.А.',room:'29',label:'Немецкий язык'}]},
 {name:'Литература',icon:'📖',variants:[{teacher:'Еремеева В.В.',room:'32'}]},
 {name:'Официальный язык (укр./молд.)',icon:'М',variants:[{teacher:'Капшук И.В.',room:'11',label:'Украинский язык'},{teacher:'Поян А.Н.',room:'113',label:'Молдавский язык'}]},
 {name:'Химия',icon:'⚗',variants:[{teacher:'Клименко Н.Н.',room:'301'}]},
 {name:'НВП',icon:'★',variants:[{teacher:'Филозофенко М.К.',room:'101'}]},
 {name:'Биология',icon:'🌿',variants:[{teacher:'Клименко Н.Н.',room:'301'}]},
 {name:'Физическая культура',icon:'⚽',variants:[{teacher:'Пасисниченко А.И.',room:''}]},
 {name:'МДК 02.03-В Слесарное дело и технические измерения',icon:'🔧',variants:[{teacher:'Мизернюк И.Я.',room:'110'}]},
 {name:'МДК 01.01 Устройство автотранспортных средств',icon:'🚗',variants:[{teacher:'Петренко А.А.',room:'306'}]},
 {name:'Охрана труда',icon:'🦺',variants:[{teacher:'Главацкая С.Ю.',room:'307'}]},
 {name:'Информатика и ИКТ',icon:'💻',variants:[{teacher:'Шандригоз Н.Н.',room:'305'}]},
 {name:'Материаловедение',icon:'◇',variants:[{teacher:'Петренко А.А.',room:'306'}]}
];

function initials(n){return String(n||'?').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase()||'?'}
function timeAgo(iso){if(!iso)return 'никогда';const t=Date.parse(iso);if(!Number.isFinite(t))return 'никогда';const sec=Math.max(0,Math.floor((Date.now()-t)/1000));if(sec<90)return 'только что';if(sec<3600)return Math.floor(sec/60)+' мин. назад';if(sec<86400)return Math.floor(sec/3600)+' ч. назад';if(sec<172800)return 'вчера';return new Date(t).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'})}
function fullDateTime(iso){if(!iso)return 'Никогда';const t=Date.parse(iso);if(!Number.isFinite(t))return 'Никогда';return new Date(t).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}
let presenceTimer=null;
function startPresence(){if(presenceTimer)clearInterval(presenceTimer);const beat=()=>api('/api/app/ping',{method:'POST',body:'{}'}).catch(()=>{});beat();presenceTimer=setInterval(beat,60000);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')beat()},{passive:true})}
async function boot(){try{const m=await api('/api/app/me');ME=m.user;PERM=m.permissions;$('#auth').classList.add('hidden');$('#app').classList.remove('hidden');$('#userName').textContent=ME.display_name;$('#userRole').textContent=roleName(ME.role);$('#avatar').textContent=(ME.display_name||'A').slice(0,1).toUpperCase();if(!PERM.users)$('#usersNav').classList.add('hidden');if(!PERM.settings)$('#settingsNav').classList.add('hidden');startPresence();page('home')}catch{}}
$('#loginBtn').onclick=async()=>{try{await api('/api/app/login',{method:'POST',body:JSON.stringify({username:$('#login').value,password:$('#pass').value})});location.reload()}catch(e){$('#authErr').textContent=e.message}};
const installBtn=$('#installApp'),installHint=$('#installHint');
async function preparePwa(){
  if(!('serviceWorker' in navigator))return false;
  try{
    const reg=await navigator.serviceWorker.register('/app/sw.js',{scope:'/app/'});
    await navigator.serviceWorker.ready;
    return !!navigator.serviceWorker.controller;
  }catch(e){console.warn('SW:',e);return false}
}
if(isStandalone()){installBtn.classList.add('hidden');installHint.textContent='Приложение уже установлено ✓'}
installBtn.onclick=async()=>{
  if(isStandalone())return;
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    const choice=await deferredInstallPrompt.userChoice;
    if(choice&&choice.outcome==='accepted'){installBtn.classList.add('hidden');installHint.textContent='Установка началась ✓'}
    deferredInstallPrompt=null;
    return;
  }
  const ua=navigator.userAgent||'';
  if(/iPad|iPhone|iPod/.test(ua)){alert('На iPhone: открой эту страницу в Safari → «Поделиться» → «На экран Домой» → «Добавить».');return}
  installBtn.disabled=true;installHint.textContent='Подготавливаю установку…';
  const controlled=await preparePwa();
  installBtn.disabled=false;
  if(!controlled){
    if(!sessionStorage.getItem('pwaPrepared')){
      sessionStorage.setItem('pwaPrepared','1');
      installHint.textContent='Готово. Перезапускаю страницу для установки…';
      setTimeout(()=>location.replace('/app/'),350);
      return;
    }
  }
  await new Promise(r=>setTimeout(r,500));
  if(deferredInstallPrompt){installBtn.click();return}
  installHint.textContent='Chrome пока не показал окно. Нажми ⋮ → «Установить приложение». Если такого пункта нет — обнови страницу один раз.';
};
$$('[data-page]').forEach(b=>b.onclick=()=>page(b.dataset.page));async function page(name){$$('[data-page]').forEach(b=>b.classList.toggle('on',b.dataset.page===name));if(name==='home')return home();if(name==='schedule')return schedule();if(name==='users')return users();if(name==='settings')return settings();if(name==='about')return about()}
async function home(){const d=await api('/api/app/dashboard');const cron=d.latestCron;$('#content').innerHTML='<section class="hero glass"><div class="muted">Сегодня · '+esc(fmt(d.today))+'</div><h2 style="font-size:clamp(24px,6vw,30px);margin-top:4px">Центр управления</h2><div class="sysgrid"><div class="syscard"><span class="muted">Бот</span><b><span class="statusdot"></span>Работает</b></div><div class="syscard"><span class="muted">Telegram</span><b>'+(d.groupBound?'Подключён':'Не настроен')+'</b></div><div class="syscard"><span class="muted">Сейчас онлайн</span><b>'+d.online+'</b></div><div class="syscard"><span class="muted">Ошибки доставки · 7 дней</span><b>'+d.failedDeliveries+'</b></div></div><div class="hero-grid"><div class="metric"><span class="muted">Утренняя карточка</span><b>'+(d.morningEnabled?esc(d.morningTime):'Выкл.')+'</b><small class="muted">повторы '+d.retryMinutes+' мин.</small></div><div class="metric"><span class="muted">Сегодня</span><b>'+(d.sentAt?'Отправлена ✓':'Ожидает')+'</b><small class="muted">'+(d.sentAt?new Date(d.sentAt).toLocaleString('ru-RU'):'ещё не отправлялась')+'</small></div><div class="metric"><span class="muted">Последний Cron</span><b>'+(cron?esc(cron.status):'Нет данных')+'</b><small class="muted">'+(cron?esc(cron.details||''):'')+'</small></div></div></section><section class="card glass"><div class="toolbar"><h3 style="flex:1">Сегодняшнее расписание</h3><button class="btn secondary" id="openToday">Открыть редактор</button></div>'+(d.lessons.length?d.lessons.map(x=>'<div style="padding:11px 0;border-bottom:1px solid #252b3d"><b>'+x.lesson_no+'. '+esc(x.subject)+'</b><div class="muted">'+[x.time,x.teacher,x.room&&'Каб. '+x.room].filter(Boolean).map(esc).join(' · ')+'</div></div>').join(''):'<p class="muted">На сегодня расписание не заполнено.</p>')+'</section>';$('#openToday').onclick=()=>{currentDate=d.today;page('schedule')}}
async function schedule(){const d=await api('/api/app/schedule?date='+currentDate);let lessons=(d.lessons||[]).map(x=>({...x})),raw=d.text||'',mode='visual',baseVersion=Number(d.version||0),draft=d.draft||null,draftTimer=null;try{const sd=await api('/api/app/settings');APPSET=sd.settings||APPSET}catch{}const renderPage=()=>{$('#content').innerHTML='<section class="card glass"><div class="toolbar"><button class="btn secondary iconbtn" id="prev" aria-label="Предыдущий день">←</button><div class="datebox"><input id="date" class="input" type="date" value="'+currentDate+'"></div><button class="btn secondary iconbtn" id="next" aria-label="Следующий день">→</button><button class="btn secondary" id="today">Сегодня</button></div><div class="muted">'+esc(weekday(currentDate)+' · '+fmt(currentDate))+'</div></section><section class="card glass">'+(draft?'<div class="draftbar"><b>Есть черновик</b><span class="muted">'+esc(timeAgo(draft.updatedAt))+'</span><button class="btn secondary" id="loadDraft">Восстановить</button><button class="btn secondary" id="dropDraft">Удалить</button></div>':'')+'<div class="card-title"><div><h3>Расписание</h3><div class="muted" style="margin-top:4px">Редактируй как удобно — всё сохраняется в бота</div></div><div class="seg"><button id="visualMode" class="on">Пары</button><button id="rawMode">Текст</button></div></div>'+(PERM.edit?'<div class="quickbar"><button class="btn secondary" id="add">+ Пара</button><button class="btn secondary" id="copyDay">Копировать день</button><button class="btn secondary" id="pasteDay" '+(!clipDay?'disabled':'')+'>Вставить</button><button class="btn secondary" id="stdTimes">Заполнить время</button><button class="btn secondary" id="historyBtn">История</button></div>':'')+'<div id="visualBox"></div><div id="rawBox" class="rawbox hidden"><div class="notice">Продвинутый режим: можно написать карточку вручную. Telegram HTML поддерживается.</div><textarea id="rawText" class="input" style="margin-top:10px" '+(!PERM.edit?'disabled':'')+'>'+esc(raw)+'</textarea></div>'+(PERM.edit?'<div class="sticky-save"><div class="toolbar" style="margin-top:14px"><label class="switch"><input type="checkbox" id="notify" '+(APPSET.autoNotifyChanges?'checked':'')+'> Сообщить группе</label><label class="switch"><input type="checkbox" id="replacement"> Это замена</label><div style="flex:1"></div><button class="btn danger" id="deleteDay">Удалить день</button><button class="btn" id="save">Сохранить</button></div></div>':'')+'</section>';bind()};
function drawLessons(){const box=$('#visualBox');box.innerHTML=lessons.length?lessons.map((x,i)=>'<div class="lesson" data-i="'+i+'"><div class="num">'+(i+1)+'</div><div class="field subject"><label>Предмет</label><div class="subject-input-wrap"><input class="input subj" value="'+esc(x.subject||'')+'" placeholder="Нажми, чтобы выбрать" readonly '+(!PERM.edit?'disabled':'')+'><button class="btn secondary subject-pick-btn" type="button" aria-label="Выбрать предмет" '+(!PERM.edit?'disabled':'')+'><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button></div></div><div class="field"><label>Время</label><input class="input time" value="'+esc(x.time||'')+'" placeholder="08:30 – 09:50" '+(!PERM.edit?'disabled':'')+'></div><div class="field"><label>Преподаватель</label><input class="input teacher" value="'+esc(x.teacher||'')+'" placeholder="Можно изменить вручную" '+(!PERM.edit?'disabled':'')+'></div><div class="field"><label>Кабинет</label><input class="input room" value="'+esc(x.room||'')+'" placeholder="Можно изменить вручную" '+(!PERM.edit?'disabled':'')+'></div>'+(PERM.edit?'<div class="lesson-actions">'+iconBtn('Выше','up',SVG.up)+iconBtn('Ниже','down',SVG.down)+iconBtn('Дублировать','dup',SVG.copy)+iconBtn('Удалить','remove',SVG.trash)+'</div>':'')+'</div>').join(''):'<p class="muted" style="padding:18px 0">Пар пока нет.</p>';if(PERM.edit)$$('.lesson').forEach(el=>{const i=+el.dataset.i;const pick=()=>{syncFields();openSubjectSheet(i)};el.querySelector('.subj').onclick=pick;el.querySelector('.subject-pick-btn').onclick=pick;el.querySelector('.remove').onclick=()=>{lessons.splice(i,1);drawLessons()};el.querySelector('.dup').onclick=()=>{if(lessons.length>=APPSET.maxLessons)return toast('Максимум '+APPSET.maxLessons+' пар');lessons.splice(i+1,0,{...lessons[i],time:BELL_TIMES[i+1]||lessons[i].time||''});drawLessons()};el.querySelector('.up').onclick=()=>{syncFields();if(i){const t1=lessons[i-1].time,t2=lessons[i].time;[lessons[i-1],lessons[i]]=[lessons[i],lessons[i-1]];lessons[i-1].time=t1;lessons[i].time=t2;drawLessons()}};el.querySelector('.down').onclick=()=>{syncFields();if(i<lessons.length-1){const t1=lessons[i].time,t2=lessons[i+1].time;[lessons[i+1],lessons[i]]=[lessons[i],lessons[i+1]];lessons[i].time=t1;lessons[i+1].time=t2;drawLessons()}}})}
function closeSubjectSheet(){const sh=$('#subjectSheet'),bd=$('#subjectBackdrop');if(sh)sh.classList.remove('show');if(bd)bd.classList.remove('show');setTimeout(()=>{sh?.remove();bd?.remove()},230)}
function openSubjectSheet(index){if(!PERM.edit||!lessons[index])return;closeSubjectSheet();const bd=document.createElement('div');bd.id='subjectBackdrop';bd.className='sheet-backdrop';const sh=document.createElement('section');sh.id='subjectSheet';sh.className='subject-sheet';sh.setAttribute('role','dialog');sh.setAttribute('aria-modal','true');document.body.append(bd,sh);const renderList=(q='')=>{const query=q.trim().toLocaleLowerCase('ru');const list=SUBJECTS.filter(x=>!query||x.name.toLocaleLowerCase('ru').includes(query)||x.variants.some(v=>(v.teacher+' '+v.room+' '+(v.label||'')).toLocaleLowerCase('ru').includes(query)));const custom=q.trim()?'<button class="btn secondary subject-custom" id="useCustom">Использовать «'+esc(q.trim())+'» как свой предмет</button>':'';$('#subjectList').innerHTML=(list.length?list.map((x,si)=>'<button class="subject-option" data-subject="'+esc(x.name)+'"><span class="subject-icon">'+esc(x.icon||'•')+'</span><span class="subject-copy"><b>'+esc(x.name)+'</b><small>'+esc(x.variants.length===1?([x.variants[0].teacher,x.variants[0].room&&'каб. '+x.variants[0].room].filter(Boolean).join(' · ')):(x.variants.length+' варианта преподавателя'))+'</small></span><span class="subject-arrow">›</span></button>').join(''):'<div class="notice">Ничего не найдено. Можно использовать введённое название как свой предмет.</div>')+custom;$$('#subjectList [data-subject]').forEach(b=>b.onclick=()=>{const subj=SUBJECTS.find(x=>x.name===b.dataset.subject);if(!subj)return;if(subj.variants.length===1)return applySubjectVariant(index,subj,subj.variants[0]);renderVariants(index,subj)});const uc=$('#useCustom');if(uc)uc.onclick=()=>{lessons[index].subject=q.trim();if(!lessons[index].time)lessons[index].time=BELL_TIMES[index]||'';closeSubjectSheet();drawLessons();queueDraft()}};sh.innerHTML='<div class="sheet-handle"></div><div class="sheet-head"><div><h3>Выбрать предмет</h3><div class="subject-current">'+(lessons[index].subject?'Сейчас: '+esc(lessons[index].subject):'Пара '+(index+1))+'</div></div><button class="btn secondary sheet-close" aria-label="Закрыть">×</button></div><div class="sheet-search"><input id="subjectSearch" class="input" type="search" placeholder="Поиск предмета, учителя или кабинета…" autocomplete="off"></div><div class="subject-list" id="subjectList"></div>';bd.onclick=closeSubjectSheet;sh.querySelector('.sheet-close').onclick=closeSubjectSheet;const search=$('#subjectSearch');search.oninput=()=>renderList(search.value);renderList('');requestAnimationFrame(()=>{bd.classList.add('show');sh.classList.add('show');setTimeout(()=>search.focus({preventScroll:true}),170)})}
function renderVariants(index,subj){const sh=$('#subjectSheet');if(!sh)return;sh.innerHTML='<div class="sheet-handle"></div><div class="sheet-head"><div><h3>'+esc(subj.name)+'</h3><div class="subject-current">Выбери преподавателя и кабинет</div></div><button class="btn secondary sheet-close" aria-label="Закрыть">×</button></div><div class="subject-list"><div class="variant-title">Если сегодня замена — выбери ближайший вариант, а преподавателя или кабинет потом просто исправь вручную.</div>'+subj.variants.map((v,i)=>'<button class="subject-option" data-variant="'+i+'"><span class="subject-icon">'+(i+1)+'</span><span class="subject-copy"><b>'+esc(v.label||v.teacher)+'</b><small>'+esc(v.teacher)+(v.room?' · кабинет '+esc(v.room):'')+'</small></span><span class="subject-arrow">›</span></button>').join('')+'<button class="btn secondary subject-custom" id="backSubjects">← Назад к предметам</button></div>';sh.querySelector('.sheet-close').onclick=closeSubjectSheet;$$('[data-variant]').forEach(b=>b.onclick=()=>applySubjectVariant(index,subj,subj.variants[+b.dataset.variant]));$('#backSubjects').onclick=()=>openSubjectSheet(index)}
function applySubjectVariant(index,subj,v){if(!lessons[index])return;lessons[index].subject=subj.name;lessons[index].teacher=v.teacher||'';lessons[index].room=v.room||'';if(!lessons[index].time)lessons[index].time=BELL_TIMES[index]||'';closeSubjectSheet();drawLessons();queueDraft();toast('Подставлено: '+subj.name)}
function syncFields(){$$('.lesson').forEach(el=>{const i=+el.dataset.i;if(!lessons[i])return;lessons[i]={lesson_no:i+1,subject:el.querySelector('.subj').value.trim(),time:el.querySelector('.time').value.trim(),teacher:el.querySelector('.teacher').value.trim(),room:el.querySelector('.room').value.trim()}})}
function currentDraftPayload(){syncFields();const arr=lessons.map((x,i)=>({...x,lesson_no:i+1})).filter(x=>x.subject);return {date:currentDate,lessons:arr,text:$('#rawText')?.value||raw,rawMode:mode==='raw'}}
function queueDraft(){if(!PERM.edit)return;clearTimeout(draftTimer);draftTimer=setTimeout(()=>{api('/api/app/draft',{method:'PUT',body:JSON.stringify(currentDraftPayload())}).catch(()=>{})},900)}
async function showHistory(){try{const h=await api('/api/app/history?date='+currentDate),rows=h.rows||[];const box=document.createElement('div');box.className='card glass';box.innerHTML='<div class="toolbar"><h3 style="flex:1">История · '+esc(fmt(currentDate))+'</h3><button class="btn secondary" id="closeHist">Закрыть</button></div>'+(rows.length?rows.map(x=>'<div class="history-row"><b>'+esc(x.action==='rollback'?'Откат':x.action==='delete'?'Удаление':'Изменение')+'</b><div class="muted">'+esc(x.display_name||'Система')+' · '+esc(fullDateTime(x.created_at))+'</div>'+(PERM.edit&&x.old_text?'<button class="btn secondary rollback" data-id="'+x.id+'" style="margin-top:8px">Откатить к состоянию до этого изменения</button>':'')+'</div>').join(''):'<p class="muted">Истории пока нет.</p>');$('#content').prepend(box);box.querySelector('#closeHist').onclick=()=>box.remove();box.querySelectorAll('.rollback').forEach(b=>b.onclick=async()=>{if(!confirm('Откатить расписание? Текущее состояние тоже останется в истории.'))return;try{await api('/api/app/history/rollback',{method:'POST',body:JSON.stringify({id:+b.dataset.id})});toast('Расписание восстановлено');schedule()}catch(e){toast(e.message)}})}catch(e){toast(e.message)}}
function bind(){drawLessons();if(draft){const l=$('#loadDraft'),x=$('#dropDraft');if(l)l.onclick=()=>{lessons=(draft.lessons||[]).map(v=>({...v}));raw=draft.text||raw;draft=null;renderPage();toast('Черновик восстановлен')};if(x)x.onclick=async()=>{await api('/api/app/draft?date='+currentDate,{method:'DELETE'});draft=null;renderPage();toast('Черновик удалён')}}const hb=$('#historyBtn');if(hb)hb.onclick=showHistory;$('#content').oninput=queueDraft;$('#prev').onclick=()=>{currentDate=shiftSchool(currentDate,-1);schedule()};$('#next').onclick=()=>{currentDate=shiftSchool(currentDate,1);schedule()};$('#today').onclick=()=>{currentDate=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Chisinau'});if([0,6].includes(new Date(currentDate+'T12:00:00').getDay()))currentDate=shiftSchool(currentDate,1);schedule()};$('#date').onchange=e=>{let v=e.target.value;if([0,6].includes(new Date(v+'T12:00:00').getDay())){toast('Выходные пропущены');v=shiftSchool(v,1)}currentDate=v;schedule()};$('#visualMode').onclick=()=>{mode='visual';$('#visualMode').classList.add('on');$('#rawMode').classList.remove('on');$('#visualBox').classList.remove('hidden');$('#rawBox').classList.add('hidden')};$('#rawMode').onclick=()=>{mode='raw';$('#rawMode').classList.add('on');$('#visualMode').classList.remove('on');$('#visualBox').classList.add('hidden');$('#rawBox').classList.remove('hidden')};if(PERM.edit){$('#add').onclick=()=>{syncFields();if(lessons.length>=APPSET.maxLessons)return toast('Максимум '+APPSET.maxLessons+' пар');lessons.push({subject:'',time:BELL_TIMES[lessons.length]||'',teacher:'',room:''});drawLessons();setTimeout(()=>openSubjectSheet(lessons.length-1),40)};$('#copyDay').onclick=()=>{syncFields();clipDay=lessons.map(x=>({...x}));toast('День скопирован')};$('#pasteDay').onclick=()=>{if(!clipDay)return;lessons=clipDay.map(x=>({...x}));drawLessons();toast('Расписание вставлено')};$('#stdTimes').onclick=()=>{syncFields();lessons.forEach((x,i)=>{if(BELL_TIMES[i])x.time=BELL_TIMES[i]});drawLessons();queueDraft();toast('Время пар обновлено по расписанию звонков')};$('#save').onclick=async()=>{syncFields();const notify=$('#notify').checked,repl=$('#replacement').checked;if((notify||repl)&&APPSET.confirmNotifications&&!confirm(repl?'Сохранить и отправить в группу карточку ЗАМЕНЫ?':'Сохранить и сообщить группе об изменении?'))return;const arr=lessons.map((x,i)=>({...x,lesson_no:i+1})).filter(x=>x.subject);try{const saved=await api('/api/app/schedule',{method:'PUT',body:JSON.stringify({date:currentDate,lessons:arr,text:$('#rawText').value,rawMode:mode==='raw',notify,replacement:repl,baseVersion})});baseVersion=Number(saved.version||baseVersion);toast(saved.delivery===false?'Сохранено, но Telegram не подтвердил отправку':'Расписание сохранено');schedule()}catch(e){toast(e.message)}};$('#deleteDay').onclick=async()=>{if(!confirm('Удалить расписание на '+fmt(currentDate)+'?'))return;try{await api('/api/app/schedule?date='+currentDate,{method:'DELETE'});toast('Удалено');schedule()}catch(e){toast(e.message)}}}}renderPage()}
async function users(){
 if(!PERM.users)return;
 const d=await api('/api/app/users'),list=d.users||[],online=Number(d.onlineCount||0),enabled=list.filter(u=>u.enabled).length;
 const lastActive=list.filter(u=>u.last_seen_at).sort((a,b)=>Date.parse(b.last_seen_at)-Date.parse(a.last_seen_at))[0];
 $('#content').innerHTML='<section class="card glass"><div class="toolbar"><div style="flex:1"><h3>Пользователи и права</h3><div class="muted" style="margin-top:4px">Доступ, присутствие и история входов</div></div><button class="btn" id="newUser">+ Пользователь</button></div>'+
 '<div class="presence-summary"><div class="presence-card"><span class="muted">Сейчас в сети</span><b><span class="statusdot"></span>'+online+'</b></div><div class="presence-card"><span class="muted">Активных аккаунтов</span><b>'+enabled+'</b></div><div class="presence-card"><span class="muted">Последняя активность</span><b style="font-size:15px">'+(lastActive?esc(lastActive.display_name):'—')+'</b><small class="muted">'+(lastActive?esc(timeAgo(lastActive.last_seen_at)):'ещё не было')+'</small></div></div>'+
 '<div id="userRows">'+list.map(u=>{const last=Date.parse(u.last_seen_at||'');const recent=!u.online&&Number.isFinite(last)&&Date.now()-last<15*60*1000;const status=u.online?'В сети':recent?'Был недавно':'Не в сети';return '<div class="user-row" data-id="'+u.id+'"><div class="user-identity"><div class="user-avatar">'+esc(initials(u.display_name))+'</div><div><input class="input name" value="'+esc(u.display_name)+'"><div class="presence-line"><span class="presence-dot '+(u.online?'online':recent?'recent':'')+'"></span><span>'+status+(u.last_seen_at&&!u.online?' · '+esc(timeAgo(u.last_seen_at)):'')+'</span></div></div></div><div><b>'+esc(u.username)+(u.primary_owner?' · Главный':'')+'</b><div class="muted">'+esc(roleName(u.role))+'</div><div class="activity-meta" style="margin-top:7px"><span>Последний вход: <strong>'+esc(fullDateTime(u.last_login_at))+'</strong></span><span>Активность: <strong>'+esc(u.online?'сейчас':timeAgo(u.last_seen_at))+'</strong></span></div></div><select class="role" '+(u.primary_owner?'disabled':'')+'><option value="viewer" '+(u.role==='viewer'?'selected':'')+'>Только просмотр</option><option value="editor" '+(u.role==='editor'?'selected':'')+'>Редактор</option><option value="admin" '+(u.role==='admin'?'selected':'')+'>Администратор</option>'+(ME.role==='owner'?'<option value="owner" '+(u.role==='owner'?'selected':'')+'>Полный доступ</option>':'')+'</select><label class="switch"><input class="enabled" type="checkbox" '+(u.enabled?'checked':'')+' '+(u.primary_owner?'disabled':'')+'> Активен</label><div class="actions"><button class="btn secondary saveUser">Сохранить</button>'+(!u.primary_owner&&u.role!=='owner'?'<button class="btn danger delUser">Удалить</button>':'')+'</div></div>'}).join('')+'</div></section>';
 $$('.user-row').forEach(el=>{const id=+el.dataset.id;el.querySelector('.saveUser').onclick=async()=>{try{await api('/api/app/users',{method:'PATCH',body:JSON.stringify({id,display_name:el.querySelector('.name').value,role:el.querySelector('.role').value,enabled:el.querySelector('.enabled').checked})});toast('Доступ обновлён');users()}catch(e){toast(e.message)}};const del=el.querySelector('.delUser');if(del)del.onclick=async()=>{if(!confirm('Удалить пользователя?'))return;try{await api('/api/app/users?id='+id,{method:'DELETE'});toast('Пользователь удалён');users()}catch(e){toast(e.message)}}});
 $('#newUser').onclick=()=>{const html='<section class="card glass"><h3>Новый пользователь</h3><div class="settings-grid"><div class="field"><label>Имя</label><input id="nName" class="input"></div><div class="field"><label>Логин</label><input id="nLogin" class="input"></div><div class="field"><label>Пароль</label><input id="nPass" class="input" type="password"></div><div class="field"><label>Права</label><select id="nRole"><option value="viewer">Только просмотр</option><option value="editor">Редактор</option><option value="admin">Администратор</option>'+(ME.role==='owner'?'<option value="owner">Полный доступ</option>':'')+'</select></div></div><div class="actions"><button class="btn" id="createU">Создать</button><button class="btn secondary" id="cancelU">Отмена</button></div></section>';$('#content').insertAdjacentHTML('afterbegin',html);$('#cancelU').onclick=users;$('#createU').onclick=async()=>{try{await api('/api/app/users',{method:'POST',body:JSON.stringify({display_name:$('#nName').value,username:$('#nLogin').value,password:$('#nPass').value,role:$('#nRole').value})});toast('Пользователь создан');users()}catch(e){toast(e.message)}}}
 // While this section is open, refresh presence without forcing the whole app to reload.
 clearTimeout(window._presenceRefresh);window._presenceRefresh=setTimeout(()=>{if(document.querySelector('#userRows'))users().catch(()=>{})},30000);
}
async function settings(){if(!PERM.settings)return;const d=await api('/api/app/settings'),s=d.settings;APPSET=s;$('#content').innerHTML='<section class="card glass"><div class="card-title"><div><h2>Настройки бота</h2><div class="muted">Меняются без Telegram и без правки кода</div></div></div><div class="settings-grid"><div class="setting-card"><h3>Утренняя карточка</h3><label class="switch" style="margin-top:12px"><input id="morningEnabled" type="checkbox" '+(s.morningEnabled?'checked':'')+'> Автоматическая отправка</label><div class="field"><label>Время отправки</label><input id="morningTime" type="time" min="05:00" max="09:00" class="input" value="'+esc(s.morningTime)+'"></div><div class="field"><label>Окно повторных попыток, минут</label><input id="retryMinutes" type="number" min="15" max="120" step="15" class="input" value="'+s.retryMinutes+'"></div><label class="switch"><input id="showMorningStats" type="checkbox" '+(s.showMorningStats?'checked':'')+'> Показывать количество пар и время</label></div><div class="setting-card"><h3>Поведение редактора</h3><label class="switch" style="margin-top:12px"><input id="autoNotifyChanges" type="checkbox" '+(s.autoNotifyChanges?'checked':'')+'> По умолчанию включать «Сообщить группе»</label><label class="switch" style="margin-top:9px"><input id="confirmNotifications" type="checkbox" '+(s.confirmNotifications?'checked':'')+'> Спрашивать подтверждение перед отправкой</label><div class="field"><label>Максимум пар в день</label><input id="maxLessons" type="number" min="4" max="12" class="input" value="'+s.maxLessons+'"></div></div><div class="setting-card"><h3>Тексты карточек</h3><div class="field"><label>Заголовок утром</label><input id="morningTitle" class="input" value="'+esc(s.morningTitle)+'"></div><div class="field"><label>Заголовок изменения</label><input id="changeTitle" class="input" value="'+esc(s.changeTitle)+'"></div><div class="field"><label>Заголовок замены</label><input id="replacementTitle" class="input" value="'+esc(s.replacementTitle)+'"></div><div class="field"><label>Подпись внизу утренней карточки</label><input id="cardFooter" class="input" value="'+esc(s.cardFooter)+'" placeholder="Например: Хорошего дня!"></div></div><div class="setting-card"><h3>Telegram</h3><div class="field"><label>ID группы</label><input id="groupChatId" class="input" value="'+esc(d.groupChatId)+'" placeholder="-100..."></div><div class="muted">Часовой пояс: '+esc(d.timezone)+'</div><div class="actions" style="margin-top:13px"><button class="btn secondary" id="testMsg">Тест в группу</button><button class="btn secondary" id="unlockMorning">Разрешить утреннюю карточку заново</button></div></div></div><div class="toolbar end" style="margin-top:14px"><button class="btn" id="saveSettings">Сохранить настройки</button></div></section>';$('#saveSettings').onclick=async()=>{const settings={morningEnabled:$('#morningEnabled').checked,morningTime:$('#morningTime').value,retryMinutes:+$('#retryMinutes').value,showMorningStats:$('#showMorningStats').checked,autoNotifyChanges:$('#autoNotifyChanges').checked,confirmNotifications:$('#confirmNotifications').checked,maxLessons:+$('#maxLessons').value,morningTitle:$('#morningTitle').value,changeTitle:$('#changeTitle').value,replacementTitle:$('#replacementTitle').value,cardFooter:$('#cardFooter').value};try{const r=await api('/api/app/settings',{method:'PATCH',body:JSON.stringify({settings,groupChatId:$('#groupChatId').value})});APPSET=r.settings;toast('Настройки сохранены')}catch(e){toast(e.message)}};$('#testMsg').onclick=async()=>{try{await api('/api/app/actions/test-message',{method:'POST',body:'{}'});toast('Тестовое сообщение отправлено')}catch(e){toast(e.message)}};$('#unlockMorning').onclick=async()=>{if(!confirm('Разрешить повторную отправку утренней карточки за сегодня?'))return;try{await api('/api/app/actions/resend-morning',{method:'POST',body:JSON.stringify({date:new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Chisinau'})})});toast('Повторная отправка разрешена')}catch(e){toast(e.message)}}}
async function about(){const [d,sys]=await Promise.all([api('/api/app/dashboard'),api('/api/app/system')]);const deliveries=sys.deliveries||[],cron=sys.latestCron;$('#content').innerHTML='<section class="hero glass"><h2>Система и диагностика</h2><p class="muted">Здесь видно, что реально происходит с Worker, Cron и доставкой карточек.</p><div class="sysgrid"><div class="syscard"><span class="muted">D1</span><b><span class="statusdot"></span>Доступна</b></div><div class="syscard"><span class="muted">Расписаний</span><b>'+sys.scheduleCount+'</b></div><div class="syscard"><span class="muted">Черновиков</span><b>'+sys.draftCount+'</b></div><div class="syscard"><span class="muted">Telegram</span><b>'+(d.groupBound?'Подключён':'Нет Chat ID')+'</b></div></div><div class="card" style="margin-top:14px"><h3>Последний запуск Cron</h3>'+(cron?'<div class="logrow"><span class="badge '+esc(cron.status)+'">'+esc(cron.status)+'</span><div><b>'+esc(cron.details||'')+'</b><div class="muted">'+esc(fullDateTime(cron.run_at))+'</div></div></div>':'<p class="muted">Cron ещё не записывался.</p>')+'</div></section><section class="card glass"><div class="toolbar"><h3 style="flex:1">Последние доставки</h3></div>'+(deliveries.length?deliveries.map(x=>'<div class="logrow"><span class="badge '+esc(x.status)+'">'+esc(x.status==='ok'?'OK':'Ошибка')+'</span><div><b>'+esc(x.kind)+' · '+esc(x.date||'')+'</b><div class="muted">'+esc(x.details||'')+'</div></div><span class="muted" style="text-align:right">'+esc(fullDateTime(x.created_at))+'</span></div>').join(''):'<p class="muted">Отправок пока нет.</p>')+'</section>'+(PERM.settings?'<section class="card glass"><h3>Резервная копия</h3><p class="muted">Сохраняет расписания и настройки бота без паролей пользователей.</p><div class="actions"><button class="btn secondary" id="exportBackup">Скачать JSON</button><label class="btn secondary" style="cursor:pointer">Восстановить<input id="importBackup" type="file" accept="application/json" hidden></label></div></section>':'')+'<section class="card glass"><button class="btn danger" id="logout">Выйти</button></section>';if(PERM.settings){$('#exportBackup').onclick=async()=>{try{const b=await api('/api/app/backup');const blob=new Blob([JSON.stringify(b.backup,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='schedule102-backup-'+new Date().toLocaleDateString('en-CA')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}catch(e){toast(e.message)}};$('#importBackup').onchange=async e=>{const f=e.target.files[0];if(!f)return;if(!confirm('Восстановить расписания из этой копии? Совпадающие даты будут заменены.'))return;try{const backup=JSON.parse(await f.text()),r=await api('/api/app/backup',{method:'POST',body:JSON.stringify({backup})});toast('Восстановлено: '+r.restored)}catch(err){toast(err.message)}}}$('#logout').onclick=async()=>{await api('/api/app/logout',{method:'POST'});location.reload()}}
boot();if('serviceWorker' in navigator){navigator.serviceWorker.register('/app/sw.js',{scope:'/app/'}).then(()=>navigator.serviceWorker.ready).catch(()=>{});}
</script></body></html>`;}

// =====================================================
// SETTINGS
// =====================================================

async function setSetting(env, key, value) {
  await env.DB.prepare(`
    INSERT INTO settings(key, value)
    VALUES(?, ?)

    ON CONFLICT(key)
    DO UPDATE SET value = excluded.value
  `).bind(key, value).run();
}


async function getSetting(env, key) {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = ?"
  ).bind(key).first();

  return row?.value || null;
}


// =====================================================
// HELPERS
// =====================================================

async function getAvailableDates(env, dates) {
  if (!dates.length) return new Set();

  const rows = await env.DB.prepare(`
    SELECT date
    FROM schedules
    WHERE date >= ?
    AND date <= ?
  `).bind(
    dates[0],
    dates[dates.length - 1]
  ).all();

  return new Set(
    (rows.results || []).map(row => row.date)
  );
}


async function findNearestMissingDay(env) {
  const dates = getSchoolDays(7);
  const available = await getAvailableDates(env, dates);

  return dates.find(date => !available.has(date)) || null;
}


function adminBackKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "⬅️ Назад",
          callback_data: "admin_menu"
        }
      ]
    ]
  };
}


function backToAdminsKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "⬅️ Назад",
          callback_data: "admin:admins"
        }
      ]
    ]
  };
}


// =====================================================
// DATE
// =====================================================

function ymdInTimezone(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const obj = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      obj[part.type] = part.value;
    }
  }

  return `${obj.year}-${obj.month}-${obj.day}`;
}


function todayYMD() {
  return ymdInTimezone(new Date());
}


function localTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const obj = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      obj[part.type] = part.value;
    }
  }

  return `${obj.hour}:${obj.minute}`;
}


function addDays(ymd, count) {
  const [y, m, d] = ymd.split("-").map(Number);

  const date = new Date(
    Date.UTC(y, m - 1, d + count, 12)
  );

  return date.toISOString().slice(0, 10);
}


function weekdayNumber(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);

  const date = new Date(
    Date.UTC(y, m - 1, d, 12)
  );

  return (date.getUTCDay() + 6) % 7;
}


function isSchoolDay(ymd) {
  return weekdayNumber(ymd) < 5;
}


function getSchoolDays(count) {
  const result = [];
  let date = todayYMD();

  while (result.length < count) {
    if (isSchoolDay(date)) {
      result.push(date);
    }

    date = addDays(date, 1);
  }

  return result;
}


function dateButtonLabel(date) {
  const today = todayYMD();
  const tomorrow = addDays(today, 1);

  if (date === today) {
    return `Сегодня · ${shortDate(date)}`;
  }

  if (date === tomorrow && isSchoolDay(tomorrow)) {
    return `Завтра · ${shortDate(date)}`;
  }

  const weekdays = [
    "Понедельник",
    "Вторник",
    "Среда",
    "Четверг",
    "Пятница",
    "Суббота",
    "Воскресенье"
  ];

  return `${weekdays[weekdayNumber(date)]} · ${shortDate(date)}`;
}


function shortDate(date) {
  const [, m, d] = date.split("-");
  return `${d}.${m}`;
}


function prettyDate(date) {
  const [y, m, d] = date.split("-").map(Number);

  const months = [
    "",
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря"
  ];

  const weekdays = [
    "Понедельник",
    "Вторник",
    "Среда",
    "Четверг",
    "Пятница",
    "Суббота",
    "Воскресенье"
  ];

  return `${weekdays[weekdayNumber(date)]}, ${d} ${months[m]} ${y}`;
}


// =====================================================
// FORMATTING
// =====================================================

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}


function telegramTextToHtml(text, entities) {
  if (!entities?.length) {
    return escapeHtml(text);
  }

  const openings = new Map();
  const closings = new Map();

  for (const entity of entities) {
    const tags = entityTags(entity);

    if (!tags) continue;

    const start = entity.offset;
    const end = entity.offset + entity.length;

    if (!openings.has(start)) openings.set(start, []);
    if (!closings.has(end)) closings.set(end, []);

    openings.get(start).push(tags[0]);
    closings.get(end).unshift(tags[1]);
  }

  let result = "";

  for (let i = 0; i <= text.length; i++) {
    if (closings.has(i)) {
      result += closings.get(i).join("");
    }

    if (openings.has(i)) {
      result += openings.get(i).join("");
    }

    if (i < text.length) {
      result += escapeHtml(text[i]);
    }
  }

  return result;
}


function entityTags(entity) {
  switch (entity.type) {
    case "bold":
      return ["<b>", "</b>"];

    case "italic":
      return ["<i>", "</i>"];

    case "underline":
      return ["<u>", "</u>"];

    case "strikethrough":
      return ["<s>", "</s>"];

    case "spoiler":
      return ["<tg-spoiler>", "</tg-spoiler>"];

    case "code":
      return ["<code>", "</code>"];

    case "pre":
      return ["<pre>", "</pre>"];

    case "text_link":
      return [
        `<a href="${escapeHtml(entity.url || "")}">`,
        "</a>"
      ];

    default:
      return null;
  }
}


// =====================================================
// TELEGRAM
// =====================================================

async function tg(env, method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    console.error(
      `Telegram ${method}:`,
      JSON.stringify(data)
    );
  }

  return data;
}


async function sendMessage(env, chatId, text, keyboard = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };

  if (keyboard) {
    payload.reply_markup = keyboard;
  }

  const result = await tg(env, "sendMessage", payload);

  if (result.ok && result.result?.message_id) {
    try {
      const groupId = await getSetting(env, "group_chat_id");

      if (groupId && String(groupId) === String(chatId)) {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO bot_group_messages(chat_id, message_id, sent_at)
          VALUES(?, ?, ?)
        `).bind(
          String(chatId),
          result.result.message_id,
          new Date().toISOString()
        ).run();
      }
    } catch (e) {
      console.error("Track bot message error:", e);
    }
  }

  return result;
}


async function editMessage(
  env,
  chatId,
  messageId,
  text,
  keyboard = null
) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };

  if (keyboard) {
    payload.reply_markup = keyboard;
  }

  const result = await tg(
    env,
    "editMessageText",
    payload
  );

  if (
    !result.ok &&
    !String(result.description || "").includes(
      "message is not modified"
    )
  ) {
    await sendMessage(
      env,
      chatId,
      text,
      keyboard
    );
  }
}


async function clearState(env, userId) {
  await env.DB.prepare(
    "DELETE FROM states WHERE user_id = ?"
  ).bind(String(userId)).run();
}
