const TZ = "Europe/Chisinau";
const DEFAULT_STUDENTS = [
    "Абросимов Сергей",
    "Бальтюкевич Артём",
    "Ботезат Владислав",
    "Володин Глеб",
    "Гуска Александр",
    "Дегтяренко Кирилл",
    "Евдокимов Артём",
    "Жикулин Михаил",
    "Залевский Егор",
    "Исканян Илья",
    "Кориков Денис",
    "Лобачёв Максим",
    "Пержан Игорь",
    "Сардак Алексей",
    "Токаренко Даниил",
    "Триколич Алексей",
    "Федосеев Сергей",
    "Храмов Милан",
    "Чеботарь Богдан"
];
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        try {
            await initDb(env);
            await rememberWebOrigin(env, url.origin);

            if (request.method === "GET" && url.pathname === "/setup") {
                const webhookUrl = `${url.origin}/webhook`;
                const result = await telegram(env, "setWebhook", {
                    url: webhookUrl,
                    allowed_updates: ["message", "callback_query"]
                });
                return textResponse(result.ok
                    ? `Webhook установлен!\n${webhookUrl}`
                    : `Ошибка:\n${JSON.stringify(result)}`);
            }

            if (request.method === "POST" && url.pathname === "/webhook") {
                const update = await request.json();
                await handleUpdate(update, env);
                return new Response("OK");
            }

            if (url.pathname.startsWith("/api/")) {
                return await handleWebApi(request, env, url);
            }

            if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app")) {
                return new Response(WEB_APP_HTML, {
                    headers: {
                        "content-type": "text/html; charset=UTF-8",
                        "cache-control": "no-store"
                    }
                });
            }

            if (request.method === "GET" && url.pathname === "/health") {
                return jsonResponse({ ok: true, service: "Journal 102" });
            }

            return new Response("Not found", { status: 404 });
        } catch (error) {
            console.error(error);
            if (url.pathname.startsWith("/api/")) {
                return jsonResponse({ error: String(error?.message || error) }, 500);
            }
            return textResponse("Worker error", 500);
        }
    }
};

function textResponse(text, status = 200) {
    return new Response(text, {
        status,
        headers: {
            "content-type": "text/plain; charset=UTF-8"
        }
    });
}
async function initDb(env) {
    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1
    )
  `).run();
    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS attendance (
      date TEXT NOT NULL,
      student_id INTEGER NOT NULL,
      status TEXT NOT NULL,

      PRIMARY KEY(
        date,
        student_id
      )
    )
  `).run();
    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS duty (
      date TEXT NOT NULL,
      student_id INTEGER NOT NULL,

      PRIMARY KEY(
        date,
        student_id
      )
    )
  `).run();
    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS states (
      user_id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      data TEXT
    )
  `).run();
    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      last_seen TEXT
    )
  `).run();
    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admins (
      user_id TEXT PRIMARY KEY,
      added_at TEXT NOT NULL
    )
  `).run();
    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS web_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id TEXT UNIQUE,
      login TEXT UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'teacher',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_login TEXT
    )
  `).run();

    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS web_permissions (
      account_id INTEGER NOT NULL,
      permission TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(account_id, permission)
    )
  `).run();

    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS web_sessions (
      session_id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen TEXT
    )
  `).run();

    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    )
  `).run();

    const studentCount = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM students
      `).first();
    if (Number(studentCount?.count || 0) === 0) {
        for (const name of DEFAULT_STUDENTS) {
            await env.DB.prepare(`
        INSERT OR IGNORE INTO students(
          name,
          active
        )
        VALUES(?, 1)
      `)
                .bind(name)
                .run();
        }
    }
}
async function handleUpdate(update, env) {
    try {
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
    catch (error) {
        console.error("Update error:", error);
    }
}
async function rememberUser(env, user) {
    if (!user?.id) {
        return;
    }
    await env.DB.prepare(`
    INSERT INTO users(
      user_id,
      first_name,
      last_name,
      username,
      last_seen
    )

    VALUES(
      ?,
      ?,
      ?,
      ?,
      ?
    )

    ON CONFLICT(user_id)
    DO UPDATE SET

      first_name =
        excluded.first_name,

      last_name =
        excluded.last_name,

      username =
        excluded.username,

      last_seen =
        excluded.last_seen
  `)
        .bind(String(user.id), user.first_name || "", user.last_name || "", user.username || "", new Date()
        .toISOString())
        .run();
}
function isOwner(env, userId) {
    return (String(userId) ===
        String(env.ADMIN_ID));
}
async function isAdmin(env, userId) {
    if (isOwner(env, userId)) {
        return true;
    }
    const row = await env.DB.prepare(`
      SELECT user_id
      FROM admins
      WHERE user_id = ?
    `)
        .bind(String(userId))
        .first();
    return Boolean(row);
}
async function handleMessage(message, env) {
    if (!message.from) {
        return;
    }
    const userId = String(message.from.id);
    const chatId = message.chat.id;
    const text = message.text || "";
    const command = text
        .split(/\s+/)[0]
        .split("@")[0]
        .toLowerCase();
    if (command === "/myid") {
        await sendMessage(env, chatId, `🆔 <b>Ваш Telegram ID</b>

<code>${escapeHtml(userId)}</code>`);
        return;
    }
    const allowed = await isAdmin(env, userId);
    if (!allowed) {
        await sendMessage(env, chatId, `🔒 <b>Доступ к журналу закрыт</b>

Ваш профиль сохранён.

👑 Владелец бота теперь сможет добавить вас в список преподавателей.`);
        return;
    }
    if (command === "/start") {
        await clearState(env, userId);
        await showMainMenu(env, chatId);
        return;
    }
    const state = await env.DB.prepare(`
      SELECT
        action,
        data

      FROM states

      WHERE user_id = ?
    `)
        .bind(userId)
        .first();
    if (state?.action ===
        "await_student" &&
        text &&
        !text.startsWith("/")) {
        const name = cleanName(text);
        if (name.length < 3) {
            await sendMessage(env, chatId, `⚠️ Отправьте фамилию и имя.

Например:

<code>Иванов Иван</code>`);
            return;
        }
        try {
            const existing = await env.DB.prepare(`
          SELECT
            id,
            active

          FROM students

          WHERE name = ?
        `)
                .bind(name)
                .first();
            if (existing &&
                Number(existing.active) === 0) {
                await env.DB.prepare(`
          UPDATE students
          SET active = 1
          WHERE id = ?
        `)
                    .bind(existing.id)
                    .run();
            }
            else if (!existing) {
                await env.DB.prepare(`
          INSERT INTO students(
            name,
            active
          )

          VALUES(
            ?,
            1
          )
        `)
                    .bind(name)
                    .run();
            }
            else {
                throw new Error("Student already exists");
            }
            await clearState(env, userId);
            await sendMessage(env, chatId, `✅ <b>Студент добавлен</b>

👤 ${escapeHtml(name)}`);
            await showStudentsMenu(env, chatId);
        }
        catch {
            await sendMessage(env, chatId, `⚠️ Этот студент уже есть в активном списке.`);
        }
        return;
    }
}
async function handleCallback(q, env) {
    if (!q.from ||
        !q.message) {
        return;
    }
    const userId = String(q.from.id);
    const chatId = q.message.chat.id;
    const messageId = q.message.message_id;
    const data = q.data || "";
    await answerCallback(env, q.id);
    const allowed = await isAdmin(env, userId);
    if (!allowed) {
        await answerCallback(env, q.id, "🔒 Нет доступа");
        return;
    }
    if (data === "main") {
        await clearState(env, userId);
        await showMainMenu(env, chatId, messageId);
        return;
    }
    if (data === "web_dev") {
        await editOrSend(env, chatId, messageId, `🌐 <b>ВЕБ-ВЕРСИЯ</b>

🚧 <b>В разработке</b>

Готовим:
• вход через Telegram;
• резервный вход по логину и паролю;
• права доступа;
• кто в сети;
• журнал и отчёты на сайте.

Сайт будет работать с той же базой, что и бот.`, {
            inline_keyboard: [
                [
                    {
                        text: "⬅️ Главное меню",
                        callback_data: "main"
                    }
                ]
            ]
        });
        return;
    }
    if (data.startsWith("parents_students:")) {
        const month = data.split(":")[1];
        await showParentsStudents(env, chatId, messageId, month);
        return;
    }

    if (data.startsWith("parents_student:")) {
        const parts = data.split(":");
        const month = parts[1];
        const studentId = Number(parts[2]);
        if (month && studentId) {
            await showParentStudentV4(env, chatId, messageId, month, studentId);
        }
        return;
    }

    if (data === "attendance") {
        await showAttendance(env, chatId, messageId, localDate());
        return;
    }
    if (data.startsWith("attendance:")) {
        const date = data.split(":")[1];
        if (isValidDate(date)) {
            await showAttendance(env, chatId, messageId, date);
        }
        return;
    }
    if (data.startsWith("att:")) {
        const parts = data.split(":");
        const date = parts[1];
        const studentId = Number(parts[2]);
        if (!isValidDate(date) ||
            !studentId) {
            return;
        }
        await cycleAttendance(env, date, studentId);
        await showAttendance(env, chatId, messageId, date);
        return;
    }
    if (data.startsWith("allpresent:")) {
        const date = data.split(":")[1];
        if (!isValidDate(date)) {
            return;
        }
        const students = await getActiveStudents(env);
        for (const student of students) {
            await env.DB.prepare(`
        INSERT INTO attendance(
          date,
          student_id,
          status
        )

        VALUES(
          ?,
          ?,
          'present'
        )

        ON CONFLICT(
          date,
          student_id
        )

        DO UPDATE SET
          status = 'present'
      `)
                .bind(date, student.id)
                .run();
        }
        await showAttendance(env, chatId, messageId, date);
        return;
    }
    if (data.startsWith("clear_att:")) {
        const date = data.split(":")[1];
        if (!isValidDate(date)) {
            return;
        }
        await editMessage(env, chatId, messageId, `🛡 <b>Очистить посещаемость?</b>

📅 ${escapeHtml(formatDateLong(date))}

Все отметки за этот день будут удалены.

<b>Это действие требует подтверждения.</b>`, {
            inline_keyboard: [
                [
                    {
                        text: "🗑 Да, очистить",
                        callback_data: `clear_att_yes:${date}`
                    }
                ],
                [
                    {
                        text: "❌ Отмена",
                        callback_data: `attendance:${date}`
                    }
                ]
            ]
        });
        return;
    }
    if (data.startsWith("clear_att_yes:")) {
        const date = data.split(":")[1];
        if (!isValidDate(date)) {
            return;
        }
        await env.DB.prepare(`
      DELETE FROM attendance
      WHERE date = ?
    `)
            .bind(date)
            .run();
        await showAttendance(env, chatId, messageId, date);
        return;
    }
    if (data === "missing") {
        await showMissing(env, chatId, messageId, localDate());
        return;
    }
    if (data.startsWith("missing:")) {
        const date = data.split(":")[1];
        if (isValidDate(date)) {
            await showMissing(env, chatId, messageId, date);
        }
        return;
    }
    if (data === "history") {
        await showHistory(env, chatId, messageId);
        return;
    }
    if (data === "duty") {
        await showDuty(env, chatId, messageId, localDate());
        return;
    }
    if (data === "stats") {
        await showStatsMenu(env, chatId, messageId);
        return;
    }
    if (data === "students") {
        await showStudentsMenu(env, chatId, messageId);
        return;
    }
    if (data === "excel") {
        await showExcelMenu(env, chatId, messageId);
        return;
    }
    if (data === "settings") {
        await showSettings(env, chatId, messageId, userId);
        return;
    }
    if (await handleExtraCallback(data, env, chatId, messageId, userId)) {
        return;
    }
    if (await handlePart5Callback(data, env, chatId, messageId, userId)) {
        return;
    }
    if (await handlePart6Callback(data, env, chatId, messageId, userId)) {
        return;
    }
}
async function showAttendance(env, chatId, messageId, date) {
    const students = await getActiveStudents(env);
    const rows = await env.DB.prepare(`
      SELECT
        student_id,
        status

      FROM attendance

      WHERE date = ?
    `)
        .bind(date)
        .all();
    const statusMap = new Map();
    for (const row of rows.results || []) {
        statusMap.set(Number(row.student_id), row.status);
    }
    let present = 0;
    let absent = 0;
    let late = 0;
    let sick = 0;
    let application = 0;
    let unmarked = 0;
    for (const student of students) {
        const status = statusMap.get(Number(student.id));
        if (status === "present") {
            present++;
        }
        else if (status === "absent") {
            absent++;
        }
        else if (status === "late") {
            late++;
        }
        else if (status === "sick" || status === "excused") {
            sick++;
        }
        else if (status === "application") {
            application++;
        }
        else {
            unmarked++;
        }
    }
    const keyboard = [];
    const previous = previousWorkday(date);
    const next = nextWorkday(date);
    keyboard.push([
        {
            text: `◀️ ${formatDateShort(previous)}`,
            callback_data: `attendance:${previous}`
        },
        {
            text: isToday(date)
                ? `📅 Сегодня ${formatDateShort(date)}`
                : `📅 ${formatDateShort(date)}`,
            callback_data: `attendance:${localDate()}`
        },
        {
            text: `${formatDateShort(next)} ▶️`,
            callback_data: `attendance:${next}`
        }
    ]);
    const tomorrow = nextWorkday(localDate());
    const afterTomorrow = nextWorkday(tomorrow);
    keyboard.push([
        {
            text: `Сегодня ${formatDateShort(localDate())}`,
            callback_data: `attendance:${localDate()}`
        },
        {
            text: `Завтра ${formatDateShort(tomorrow)}`,
            callback_data: `attendance:${tomorrow}`
        }
    ]);
    keyboard.push([
        {
            text: `Послезавтра ${formatDateShort(afterTomorrow)}`,
            callback_data: `attendance:${afterTomorrow}`
        }
    ]);
    for (const student of students) {
        const status = statusMap.get(Number(student.id)) || "none";
        keyboard.push([
            {
                text: `${statusEmoji(status)} ${student.name}`,
                callback_data: `att:${date}:${student.id}`
            }
        ]);
    }
    keyboard.push([
        {
            text: "✅ Все есть",
            callback_data: `allpresent:${date}`
        },
        {
            text: "👀 Кого нет",
            callback_data: `missing:${date}`
        }
    ]);
    keyboard.push([
        {
            text: "🗑 Очистить день",
            callback_data: `clear_att:${date}`
        }
    ]);
    keyboard.push([
        {
            text: "🏠 Главное меню",
            callback_data: "main"
        }
    ]);
    const text = `👥 <b>ПОСЕЩАЕМОСТЬ</b>

📅 <b>${escapeHtml(formatDateLong(date))}</b>

━━━━━━━━━━━━━━

✅ Есть: <b>${present}</b>
❌ Нет: <b>${absent}</b>
⏰ Опоздали: <b>${late}</b>
🤒 Болеет: <b>${sick}</b>
📝 По заявлению: <b>${application}</b>
➖ Не отмечено: <b>${unmarked}</b>

👥 Всего: <b>${students.length}</b>

━━━━━━━━━━━━━━

Нажимайте на студента для смены статуса:

➖ → ✅ → ❌ → ⏰ → 🤒 → 📝 → ➖`;
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: keyboard
    });
}
async function cycleAttendance(env, date, studentId) {
    const current = await env.DB.prepare(`
      SELECT status

      FROM attendance

      WHERE
        date = ?
        AND
        student_id = ?
    `)
        .bind(date, studentId)
        .first();
    const oldStatus = current?.status ||
        "none";
    const nextStatus = {
        none: "present",
        present: "absent",
        absent: "late",
        late: "sick",
        sick: "application",
        application: "none",
        excused: "sick"
    }[oldStatus] ||
        "present";
    if (nextStatus === "none") {
        await env.DB.prepare(`
      DELETE FROM attendance

      WHERE
        date = ?
        AND
        student_id = ?
    `)
            .bind(date, studentId)
            .run();
        return;
    }
    await env.DB.prepare(`
    INSERT INTO attendance(
      date,
      student_id,
      status
    )

    VALUES(
      ?,
      ?,
      ?
    )

    ON CONFLICT(
      date,
      student_id
    )

    DO UPDATE SET
      status =
        excluded.status
  `)
        .bind(date, studentId, nextStatus)
        .run();
}
async function showMissing(env, chatId, messageId, date) {
    const students = await env.DB.prepare(`
      SELECT
        s.id,
        s.name,
        a.status

      FROM students s

      LEFT JOIN attendance a
        ON
          a.student_id = s.id
          AND
          a.date = ?

      WHERE
        s.active = 1

      ORDER BY
        CASE
          WHEN s.name = 'Кориков Денис' THEN 1
          WHEN s.name = 'Гуска Александр' THEN 2
          ELSE 0
        END,
        s.name COLLATE NOCASE
    `)
        .bind(date)
        .all();
    const absent = [];
    const late = [];
    const sick = [];
    const application = [];
    const unmarked = [];
    for (const student of students.results || []) {
        if (student.status ===
            "absent") {
            absent.push(student.name);
        }
        else if (student.status ===
            "late") {
            late.push(student.name);
        }
        else if (student.status === "sick" || student.status === "excused") {
            sick.push(student.name);
        }
        else if (student.status === "application") {
            application.push(student.name);
        }
        else if (!student.status) {
            unmarked.push(student.name);
        }
    }
    const previous = previousWorkday(date);
    const next = nextWorkday(date);
    const keyboard = {
        inline_keyboard: [
            [
                {
                    text: `◀️ ${formatDateShort(previous)}`,
                    callback_data: `missing:${previous}`
                },
                {
                    text: isToday(date)
                        ? "📅 Сегодня"
                        : formatDateShort(date),
                    callback_data: `missing:${localDate()}`
                },
                {
                    text: `${formatDateShort(next)} ▶️`,
                    callback_data: `missing:${next}`
                }
            ],
            [
                {
                    text: "👥 Посещаемость",
                    callback_data: `attendance:${date}`
                }
            ],
            [
                {
                    text: "🏠 Главное меню",
                    callback_data: "main"
                }
            ]
        ]
    };
    let text = `👀 <b>КОГО НЕТ</b>

📅 <b>${escapeHtml(formatDateLong(date))}</b>

━━━━━━━━━━━━━━`;
    text +=
        `\n\n❌ <b>ОТСУТСТВУЮТ — ${absent.length}</b>`;
    if (absent.length) {
        text +=
            "\n" +
                absent
                    .map(name => `• ${escapeHtml(name)}`)
                    .join("\n");
    }
    else {
        text +=
            "\nНикого 🎉";
    }
    text +=
        `\n\n⏰ <b>ОПОЗДАЛИ — ${late.length}</b>`;
    if (late.length) {
        text +=
            "\n" +
                late
                    .map(name => `• ${escapeHtml(name)}`)
                    .join("\n");
    }
    else {
        text +=
            "\nНикого";
    }
    text +=
        `\n\n🤒 <b>БОЛЕЮТ — ${sick.length}</b>`;
    if (sick.length) {
        text += "\n" + sick.map(name => `• ${escapeHtml(name)}`).join("\n");
    }
    else {
        text += "\nНикого";
    }

    text +=
        `\n\n📝 <b>ПО ЗАЯВЛЕНИЮ — ${application.length}</b>`;
    if (application.length) {
        text += "\n" + application.map(name => `• ${escapeHtml(name)}`).join("\n");
    }
    else {
        text += "\nНикого";
    }
    if (unmarked.length) {
        text +=
            `\n\n⚠️ <b>НЕ ОТМЕЧЕНО — ${unmarked.length}</b>`;
        text +=
            "\n" +
                unmarked
                    .map(name => `• ${escapeHtml(name)}`)
                    .join("\n");
    }
    await editOrSend(env, chatId, messageId, text, keyboard);
}
function statusEmoji(status) {
    if (status === "present") {
        return "✅";
    }
    if (status === "absent") {
        return "❌";
    }
    if (status === "late") {
        return "⏰";
    }
    if (status === "sick" || status === "excused") {
        return "🤒";
    }
    if (status === "application") {
        return "📝";
    }
    return "➖";
}
async function getActiveStudents(env) {
    const result = await env.DB.prepare(`
      SELECT
        id,
        name

      FROM students

      WHERE active = 1

      ORDER BY
        CASE
          WHEN name = 'Кориков Денис' THEN 1
          WHEN name = 'Гуска Александр' THEN 2
          ELSE 0
        END,
        name COLLATE NOCASE
    `)
        .all();
    return (result.results || []);
}
async function showHistory(env, chatId, messageId) {
    const result = await env.DB.prepare(`
      SELECT
        a.date,

        SUM(
          CASE
            WHEN a.status = 'present'
            THEN 1 ELSE 0
          END
        ) AS present,

        SUM(
          CASE
            WHEN a.status = 'absent'
            THEN 1 ELSE 0
          END
        ) AS absent,

        SUM(
          CASE
            WHEN a.status = 'late'
            THEN 1 ELSE 0
          END
        ) AS late,

        SUM(
          CASE
            WHEN status IN ('excused', 'sick')
            THEN 1 ELSE 0
          END
        ) AS sick,

        SUM(
          CASE
            WHEN status = 'application'
            THEN 1 ELSE 0
          END
        ) AS application,

        COUNT(*) AS marked

      FROM attendance a

      GROUP BY a.date

      ORDER BY a.date DESC

      LIMIT 20
    `)
        .all();
    const days = result.results || [];
    let text = `📆 <b>ИСТОРИЯ</b>

Последние отмеченные учебные дни.

━━━━━━━━━━━━━━`;
    const keyboard = [];
    if (days.length === 0) {
        text +=
            `\n\nПока история пустая.

После первой переклички здесь появятся дни.`;
    }
    else {
        for (const day of days) {
            const date = day.date;
            text +=
                `\n\n📅 <b>${escapeHtml(formatDateLong(date))}</b>

✅ ${Number(day.present || 0)}
   ❌ ${Number(day.absent || 0)}
   ⏰ ${Number(day.late || 0)}
   🤒 ${Number(day.sick || day.excused || 0)}   📝 ${Number(day.application || 0)}`;
            keyboard.push([
                {
                    text: `📅 ${formatDateShort(date)} • открыть`,
                    callback_data: `history_day:${date}`
                }
            ]);
        }
    }
    keyboard.push([
        {
            text: "🏠 Главное меню",
            callback_data: "main"
        }
    ]);
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: keyboard
    });
}
async function showHistoryDay(env, chatId, messageId, date) {
    const result = await env.DB.prepare(`
      SELECT
        s.name,
        a.status

      FROM students s

      LEFT JOIN attendance a
        ON
          a.student_id = s.id
          AND
          a.date = ?

      WHERE
        s.active = 1

      ORDER BY
        CASE
          WHEN s.name = 'Кориков Денис' THEN 1
          WHEN s.name = 'Гуска Александр' THEN 2
          ELSE 0
        END,
        s.name COLLATE NOCASE
    `)
        .bind(date)
        .all();
    const rows = result.results || [];
    let text = `📋 <b>ИТОГ ДНЯ</b>

📅 <b>${escapeHtml(formatDateLong(date))}</b>

━━━━━━━━━━━━━━`;
    let present = 0;
    let absent = 0;
    let late = 0;
    let excused = 0;
    let unmarked = 0;
    for (const row of rows) {
        const status = row.status || "none";
        if (status === "present") {
            present++;
        }
        else if (status === "absent") {
            absent++;
        }
        else if (status === "late") {
            late++;
        }
        else if (status === "excused") {
            excused++;
        }
        else {
            unmarked++;
        }
    }
    text +=
        `\n\n✅ Есть: <b>${present}</b>
❌ Нет: <b>${absent}</b>
⏰ Опоздали: <b>${late}</b>
🤒 Болеет: <b>${sick}</b>
📝 По заявлению: <b>${application}</b>
➖ Не отмечено: <b>${unmarked}</b>`;
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: [
            [
                {
                    text: "👥 Открыть посещаемость",
                    callback_data: `attendance:${date}`
                }
            ],
            [
                {
                    text: "👀 Кого нет",
                    callback_data: `missing:${date}`
                }
            ],
            [
                {
                    text: "⬅️ История",
                    callback_data: "history"
                },
                {
                    text: "🏠 Меню",
                    callback_data: "main"
                }
            ]
        ]
    });
}
async function showStudentsMenu(env, chatId, messageId = null) {
    const students = await getActiveStudents(env);
    let text = `👨‍🎓 <b>СТУДЕНТЫ ГРУППЫ №102</b>

👥 Всего: <b>${students.length}</b>

Нажмите на студента, чтобы открыть его карточку.`;
    const keyboard = [];
    for (const student of students) {
        keyboard.push([
            {
                text: `👤 ${student.name}`,
                callback_data: `student:${student.id}`
            }
        ]);
    }
    keyboard.push([
        {
            text: "➕ Добавить студента",
            callback_data: "student_add"
        }
    ]);
    keyboard.push([
        {
            text: "🏠 Главное меню",
            callback_data: "main"
        }
    ]);
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: keyboard
    });
}
async function showStudentCard(env, chatId, messageId, studentId) {
    const student = await env.DB.prepare(`
      SELECT
        id,
        name,
        active

      FROM students

      WHERE id = ?
    `)
        .bind(studentId)
        .first();
    if (!student ||
        Number(student.active) !== 1) {
        await editOrSend(env, chatId, messageId, `⚠️ Студент не найден.`, {
            inline_keyboard: [
                [
                    {
                        text: "⬅️ К студентам",
                        callback_data: "students"
                    }
                ]
            ]
        });
        return;
    }
    const stats = await env.DB.prepare(`
      SELECT

        SUM(
          CASE
            WHEN status = 'present'
            THEN 1 ELSE 0
          END
        ) AS present,

        SUM(
          CASE
            WHEN status = 'absent'
            THEN 1 ELSE 0
          END
        ) AS absent,

        SUM(
          CASE
            WHEN status = 'late'
            THEN 1 ELSE 0
          END
        ) AS late,

        SUM(
          CASE
            WHEN status IN ('excused', 'sick')
            THEN 1 ELSE 0
          END
        ) AS sick,

        SUM(
          CASE
            WHEN status = 'application'
            THEN 1 ELSE 0
          END
        ) AS application,

        COUNT(*) AS total

      FROM attendance

      WHERE student_id = ?
    `)
        .bind(studentId)
        .first();
    const duty = await env.DB.prepare(`
      SELECT
        COUNT(*) AS count

      FROM duty

      WHERE student_id = ?
    `)
        .bind(studentId)
        .first();
    const present = Number(stats?.present || 0);
    const absent = Number(stats?.absent || 0);
    const late = Number(stats?.late || 0);
    const excused = Number(stats?.excused || 0);
    const total = Number(stats?.total || 0);
    const counted = present +
        absent +
        late;
    const attendancePercent = counted > 0
        ? Math.round(((present +
            late) /
            counted) * 100)
        : 0;
    const recent = await env.DB.prepare(`
      SELECT
        date,
        status

      FROM attendance

      WHERE student_id = ?

      ORDER BY date DESC

      LIMIT 7
    `)
        .bind(studentId)
        .all();
    let recentText = "";
    for (const row of recent.results || []) {
        recentText +=
            `\n${statusEmoji(row.status)} ${formatDateShort(row.date)}`;
    }
    if (!recentText) {
        recentText =
            "\nПока нет отметок.";
    }
    const text = `👤 <b>${escapeHtml(student.name)}</b>

━━━━━━━━━━━━━━

📊 <b>ОБЩАЯ СТАТИСТИКА</b>

✅ Присутствовал: <b>${present}</b>
❌ Отсутствовал: <b>${absent}</b>
⏰ Опоздал: <b>${late}</b>
🤒 Болеет: <b>${sick}</b>
📝 По заявлению: <b>${application}</b>

📈 Посещаемость: <b>${attendancePercent}%</b>

🧹 Дежурств: <b>${Number(duty?.count || 0)}</b>

📝 Всего отметок: <b>${total}</b>

━━━━━━━━━━━━━━

🕘 <b>ПОСЛЕДНИЕ ОТМЕТКИ</b>
${recentText}`;
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: [
            [
                {
                    text: "❌ Даты пропусков",
                    callback_data: `student_absences:${studentId}`
                }
            ],
            [
                {
                    text: "📊 Статистика",
                    callback_data: `student_stats:${studentId}`
                },
                {
                    text: "🧹 Дежурства",
                    callback_data: `student_duty:${studentId}`
                }
            ],
            [
                {
                    text: "🗑 Удалить",
                    callback_data: `student_delete:${studentId}`
                }
            ],
            [
                {
                    text: "⬅️ Студенты",
                    callback_data: "students"
                },
                {
                    text: "🏠 Меню",
                    callback_data: "main"
                }
            ]
        ]
    });
}
async function showStudentAbsences(env, chatId, messageId, studentId) {
    const student = await env.DB.prepare(`
      SELECT
        name

      FROM students

      WHERE id = ?
    `)
        .bind(studentId)
        .first();
    if (!student) {
        return;
    }
    const result = await env.DB.prepare(`
      SELECT
        date

      FROM attendance

      WHERE
        student_id = ?
        AND
        status = 'absent'

      ORDER BY date DESC

      LIMIT 30
    `)
        .bind(studentId)
        .all();
    const dates = result.results || [];
    let text = `❌ <b>ПРОПУСКИ</b>

👤 ${escapeHtml(student.name)}

━━━━━━━━━━━━━━`;
    if (dates.length === 0) {
        text +=
            `\n\n🎉 Нет отмеченных пропусков.`;
    }
    else {
        for (const row of dates) {
            text +=
                `\n\n❌ ${escapeHtml(formatDateLong(row.date))}`;
        }
    }
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: [
            [
                {
                    text: "⬅️ Карточка студента",
                    callback_data: `student:${studentId}`
                }
            ],
            [
                {
                    text: "🏠 Главное меню",
                    callback_data: "main"
                }
            ]
        ]
    });
}
async function showStudentStats(env, chatId, messageId, studentId) {
    const student = await env.DB.prepare(`
      SELECT name

      FROM students

      WHERE id = ?
    `)
        .bind(studentId)
        .first();
    if (!student) {
        return;
    }
    await editOrSend(env, chatId, messageId, `📊 <b>СТАТИСТИКА</b>

👤 ${escapeHtml(student.name)}

Выберите период 👇`, {
        inline_keyboard: [
            [
                {
                    text: "📅 7 дней",
                    callback_data: `student_period:${studentId}:7`
                },
                {
                    text: "📅 30 дней",
                    callback_data: `student_period:${studentId}:30`
                }
            ],
            [
                {
                    text: "📚 Всё время",
                    callback_data: `student_period:${studentId}:all`
                }
            ],
            [
                {
                    text: "⬅️ Карточка",
                    callback_data: `student:${studentId}`
                }
            ]
        ]
    });
}
async function showStudentDutyHistory(env, chatId, messageId, studentId) {
    const student = await env.DB.prepare(`
      SELECT name

      FROM students

      WHERE id = ?
    `)
        .bind(studentId)
        .first();
    if (!student) {
        return;
    }
    const result = await env.DB.prepare(`
      SELECT date

      FROM duty

      WHERE student_id = ?

      ORDER BY date DESC

      LIMIT 20
    `)
        .bind(studentId)
        .all();
    const rows = result.results || [];
    let text = `🧹 <b>ДЕЖУРСТВА</b>

👤 ${escapeHtml(student.name)}

━━━━━━━━━━━━━━`;
    if (rows.length === 0) {
        text +=
            `\n\nПока не дежурил.`;
    }
    else {
        for (const row of rows) {
            text +=
                `\n\n🧹 ${escapeHtml(formatDateLong(row.date))}`;
        }
    }
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: [
            [
                {
                    text: "⬅️ Карточка",
                    callback_data: `student:${studentId}`
                }
            ],
            [
                {
                    text: "🏠 Главное меню",
                    callback_data: "main"
                }
            ]
        ]
    });
}
async function showDuty(env, chatId, messageId, date) {
    const students = await getActiveStudents(env);
    const dutyResult = await env.DB.prepare(`
      SELECT student_id
      FROM duty
      WHERE date = ?
    `)
        .bind(date)
        .all();
    const selected = new Set((dutyResult.results || [])
        .map(row => Number(row.student_id)));
    const statsResult = await env.DB.prepare(`
      SELECT
        s.id,
        s.name,
        COUNT(d.date) AS duty_count,
        MAX(d.date) AS last_duty

      FROM students s

      LEFT JOIN duty d
        ON d.student_id = s.id

      WHERE s.active = 1

      GROUP BY
        s.id,
        s.name
    `)
        .all();
    const stats = statsResult.results || [];
    stats.sort((a, b) => {
        const aCount = Number(a.duty_count || 0);
        const bCount = Number(b.duty_count || 0);
        if (aCount !== bCount) {
            return (aCount - bCount);
        }
        if (!a.last_duty &&
            b.last_duty) {
            return -1;
        }
        if (a.last_duty &&
            !b.last_duty) {
            return 1;
        }
        if (a.last_duty &&
            b.last_duty) {
            return (String(a.last_duty)
                .localeCompare(String(b.last_duty)));
        }
        return (String(a.name)
            .localeCompare(String(b.name), "ru"));
    });
    const recommended = stats
        .filter(student => !selected.has(Number(student.id)))
        .slice(0, 2);
    let text = `🧹 <b>ДЕЖУРСТВО</b>

📅 <b>${escapeHtml(formatDateLong(date))}</b>

━━━━━━━━━━━━━━`;
    if (selected.size === 0) {
        text +=
            `\n\n👥 Дежурные пока не выбраны.`;
    }
    else {
        text +=
            `\n\n✅ <b>Сегодня дежурят:</b>`;
        for (const student of students) {
            if (selected.has(Number(student.id))) {
                text +=
                    `\n• ${escapeHtml(student.name)}`;
            }
        }
    }
    if (recommended.length) {
        text +=
            `\n\n💡 <b>По очереди следующие:</b>`;
        for (const student of recommended) {
            const count = Number(student.duty_count || 0);
            text +=
                `\n• ${escapeHtml(student.name)} — ${count} деж.`;
        }
    }
    text +=
        `\n\n━━━━━━━━━━━━━━

Нажмите на фамилию, чтобы назначить или снять дежурного.`;
    const keyboard = [];
    const previous = previousWorkday(date);
    const next = nextWorkday(date);
    keyboard.push([
        {
            text: `◀️ ${formatDateShort(previous)}`,
            callback_data: `duty_date:${previous}`
        },
        {
            text: isToday(date)
                ? `📅 Сегодня ${formatDateShort(date)}`
                : `📅 ${formatDateShort(date)}`,
            callback_data: `duty_date:${localDate()}`
        },
        {
            text: `${formatDateShort(next)} ▶️`,
            callback_data: `duty_date:${next}`
        }
    ]);
    if (recommended.length) {
        keyboard.push([
            {
                text: "✨ Назначить следующих",
                callback_data: `duty_recommend:${date}`
            }
        ]);
    }
    for (const student of students) {
        const isSelected = selected.has(Number(student.id));
        keyboard.push([
            {
                text: `${isSelected ? "🧹" : "▫️"} ${student.name}`,
                callback_data: `duty_toggle:${date}:${student.id}`
            }
        ]);
    }
    if (selected.size > 0) {
        keyboard.push([
            {
                text: "🗑 Очистить дежурных",
                callback_data: `duty_clear:${date}`
            }
        ]);
    }
    keyboard.push([
        {
            text: "🏠 Главное меню",
            callback_data: "main"
        }
    ]);
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: keyboard
    });
}
async function toggleDuty(env, date, studentId) {
    const existing = await env.DB.prepare(`
      SELECT student_id

      FROM duty

      WHERE
        date = ?
        AND
        student_id = ?
    `)
        .bind(date, studentId)
        .first();
    if (existing) {
        await env.DB.prepare(`
      DELETE FROM duty

      WHERE
        date = ?
        AND
        student_id = ?
    `)
            .bind(date, studentId)
            .run();
        return;
    }
    await env.DB.prepare(`
    INSERT OR IGNORE INTO duty(
      date,
      student_id
    )

    VALUES(
      ?,
      ?
    )
  `)
        .bind(date, studentId)
        .run();
}
async function assignRecommendedDuty(env, date) {
    const result = await env.DB.prepare(`
      SELECT
        s.id,
        s.name,
        COUNT(d.date) AS duty_count,
        MAX(d.date) AS last_duty

      FROM students s

      LEFT JOIN duty d
        ON d.student_id = s.id

      WHERE s.active = 1

      GROUP BY
        s.id,
        s.name
    `)
        .all();
    const students = result.results || [];
    students.sort((a, b) => {
        const aCount = Number(a.duty_count || 0);
        const bCount = Number(b.duty_count || 0);
        if (aCount !== bCount) {
            return (aCount - bCount);
        }
        if (!a.last_duty &&
            b.last_duty) {
            return -1;
        }
        if (a.last_duty &&
            !b.last_duty) {
            return 1;
        }
        if (a.last_duty &&
            b.last_duty) {
            return (String(a.last_duty)
                .localeCompare(String(b.last_duty)));
        }
        return (String(a.name)
            .localeCompare(String(b.name), "ru"));
    });
    const nextStudents = students.slice(0, 2);
    for (const student of nextStudents) {
        await env.DB.prepare(`
      INSERT OR IGNORE INTO duty(
        date,
        student_id
      )

      VALUES(
        ?,
        ?
      )
    `)
            .bind(date, student.id)
            .run();
    }
}
async function showDutyClearConfirm(env, chatId, messageId, date) {
    await editOrSend(env, chatId, messageId, `🛡 <b>ПОДТВЕРЖДЕНИЕ</b>

📅 ${escapeHtml(formatDateLong(date))}

Удалить всех назначенных дежурных за этот день?

Случайно нажать и потерять данные не получится — нужно подтвердить действие.`, {
        inline_keyboard: [
            [
                {
                    text: "🗑 Да, очистить",
                    callback_data: `duty_clear_yes:${date}`
                }
            ],
            [
                {
                    text: "❌ Отмена",
                    callback_data: `duty_date:${date}`
                }
            ]
        ]
    });
}
async function clearDuty(env, date) {
    await env.DB.prepare(`
    DELETE FROM duty
    WHERE date = ?
  `)
        .bind(date)
        .run();
}
async function showDutyHistory(env, chatId, messageId) {
    const result = await env.DB.prepare(`
      SELECT
        d.date,
        s.name

      FROM duty d

      JOIN students s
        ON s.id = d.student_id

      ORDER BY
        d.date DESC,
        s.name COLLATE NOCASE

      LIMIT 60
    `)
        .all();
    const rows = result.results || [];
    let text = `🧹 <b>ИСТОРИЯ ДЕЖУРСТВ</b>

━━━━━━━━━━━━━━`;
    if (rows.length === 0) {
        text +=
            `\n\nПока нет записей.`;
    }
    else {
        let currentDate = null;
        for (const row of rows) {
            if (row.date !==
                currentDate) {
                currentDate =
                    row.date;
                text +=
                    `\n\n📅 <b>${escapeHtml(formatDateLong(currentDate))}</b>`;
            }
            text +=
                `\n🧹 ${escapeHtml(row.name)}`;
        }
    }
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: [
            [
                {
                    text: "🧹 Сегодня",
                    callback_data: "duty"
                }
            ],
            [
                {
                    text: "🏠 Главное меню",
                    callback_data: "main"
                }
            ]
        ]
    });
}
async function handleExtraCallback(data, env, chatId, messageId, userId) {
    if (data.startsWith("history_day:")) {
        const date = data.split(":")[1];
        if (isValidDate(date)) {
            await showHistoryDay(env, chatId, messageId, date);
        }
        return true;
    }
    if (data.startsWith("student:")) {
        const studentId = Number(data.split(":")[1]);
        if (studentId) {
            await showStudentCard(env, chatId, messageId, studentId);
        }
        return true;
    }
    if (data.startsWith("student_absences:")) {
        const studentId = Number(data.split(":")[1]);
        if (studentId) {
            await showStudentAbsences(env, chatId, messageId, studentId);
        }
        return true;
    }
    if (data.startsWith("student_stats:")) {
        const studentId = Number(data.split(":")[1]);
        if (studentId) {
            await showStudentStats(env, chatId, messageId, studentId);
        }
        return true;
    }
    if (data.startsWith("student_duty:")) {
        const studentId = Number(data.split(":")[1]);
        if (studentId) {
            await showStudentDutyHistory(env, chatId, messageId, studentId);
        }
        return true;
    }
    if (data ===
        "student_add") {
        await setState(env, userId, "await_student");
        await editOrSend(env, chatId, messageId, `➕ <b>ДОБАВЛЕНИЕ СТУДЕНТА</b>

Отправьте фамилию и имя одним сообщением.

Например:

<code>Иванов Иван</code>`, {
            inline_keyboard: [
                [
                    {
                        text: "❌ Отмена",
                        callback_data: "students"
                    }
                ]
            ]
        });
        return true;
    }
    if (data.startsWith("student_delete:")) {
        const studentId = Number(data.split(":")[1]);
        const student = await env.DB.prepare(`
        SELECT name

        FROM students

        WHERE id = ?
      `)
            .bind(studentId)
            .first();
        if (!student) {
            return true;
        }
        await editOrSend(env, chatId, messageId, `🛡 <b>УДАЛЕНИЕ СТУДЕНТА</b>

👤 ${escapeHtml(student.name)}

Убрать студента из активного списка?

История посещаемости и дежурств <b>не будет удалена</b>.`, {
            inline_keyboard: [
                [
                    {
                        text: "🗑 Да, убрать",
                        callback_data: `student_delete_yes:${studentId}`
                    }
                ],
                [
                    {
                        text: "❌ Отмена",
                        callback_data: `student:${studentId}`
                    }
                ]
            ]
        });
        return true;
    }
    if (data.startsWith("student_delete_yes:")) {
        const studentId = Number(data.split(":")[1]);
        if (studentId) {
            await env.DB.prepare(`
        UPDATE students

        SET active = 0

        WHERE id = ?
      `)
                .bind(studentId)
                .run();
        }
        await showStudentsMenu(env, chatId, messageId);
        return true;
    }
    if (data.startsWith("duty_date:")) {
        const date = data.split(":")[1];
        if (isValidDate(date)) {
            await showDuty(env, chatId, messageId, date);
        }
        return true;
    }
    if (data.startsWith("duty_toggle:")) {
        const parts = data.split(":");
        const date = parts[1];
        const studentId = Number(parts[2]);
        if (isValidDate(date) &&
            studentId) {
            await toggleDuty(env, date, studentId);
            await showDuty(env, chatId, messageId, date);
        }
        return true;
    }
    if (data.startsWith("duty_recommend:")) {
        const date = data.split(":")[1];
        if (isValidDate(date)) {
            await assignRecommendedDuty(env, date);
            await showDuty(env, chatId, messageId, date);
        }
        return true;
    }
    if (data.startsWith("duty_clear:")) {
        const date = data.split(":")[1];
        if (isValidDate(date)) {
            await showDutyClearConfirm(env, chatId, messageId, date);
        }
        return true;
    }
    if (data.startsWith("duty_clear_yes:")) {
        const date = data.split(":")[1];
        if (isValidDate(date)) {
            await clearDuty(env, date);
            await showDuty(env, chatId, messageId, date);
        }
        return true;
    }
    if (data ===
        "duty_history") {
        await showDutyHistory(env, chatId, messageId);
        return true;
    }
    return false;
}
async function showStatsMenu(env, chatId, messageId) {
    await editOrSend(env, chatId, messageId, `📊 <b>СТАТИСТИКА ГРУППЫ</b>

Выберите период 👇`, {
        inline_keyboard: [
            [
                {
                    text: "📅 7 дней",
                    callback_data: "stats_period:7"
                },
                {
                    text: "📅 30 дней",
                    callback_data: "stats_period:30"
                }
            ],
            [
                {
                    text: "📚 Всё время",
                    callback_data: "stats_period:all"
                }
            ],
            [
                {
                    text: "🏠 Главное меню",
                    callback_data: "main"
                }
            ]
        ]
    });
}
async function showGroupStats(env, chatId, messageId, period) {
    let where = "";
    let title = "Всё время";
    if (period === "7") {
        const from = shiftDate(localDate(), -6);
        where =
            `AND a.date >= '${from}'`;
        title =
            "Последние 7 дней";
    }
    if (period === "30") {
        const from = shiftDate(localDate(), -29);
        where =
            `AND a.date >= '${from}'`;
        title =
            "Последние 30 дней";
    }
    const result = await env.DB.prepare(`
      SELECT
        s.id,
        s.name,

        SUM(
          CASE
            WHEN a.status = 'present'
            THEN 1 ELSE 0
          END
        ) AS present,

        SUM(
          CASE
            WHEN a.status = 'absent'
            THEN 1 ELSE 0
          END
        ) AS absent,

        SUM(
          CASE
            WHEN a.status = 'late'
            THEN 1 ELSE 0
          END
        ) AS late,

        SUM(
          CASE
            WHEN status IN ('excused', 'sick')
            THEN 1 ELSE 0
          END
        ) AS sick,

        SUM(
          CASE
            WHEN status = 'application'
            THEN 1 ELSE 0
          END
        ) AS application

      FROM students s

      LEFT JOIN attendance a
        ON a.student_id = s.id
        ${where}

      WHERE s.active = 1

      GROUP BY
        s.id,
        s.name

      ORDER BY
        CASE
          WHEN s.name = 'Кориков Денис' THEN 1
          WHEN s.name = 'Гуска Александр' THEN 2
          ELSE 0
        END,
        s.name COLLATE NOCASE
    `)
        .all();
    const students = result.results || [];
    let totalPresent = 0;
    let totalAbsent = 0;
    let totalLate = 0;
    let totalExcused = 0;
    let text = `📊 <b>СТАТИСТИКА ГРУППЫ</b>

📆 <b>${escapeHtml(title)}</b>

━━━━━━━━━━━━━━`;
    for (const student of students) {
        const present = Number(student.present || 0);
        const absent = Number(student.absent || 0);
        const late = Number(student.late || 0);
        const excused = Number(student.excused || 0);
        totalPresent += present;
        totalAbsent += absent;
        totalLate += late;
        totalExcused += excused;
        const counted = present +
            absent +
            late;
        const percent = counted > 0
            ? Math.round(((present +
                late) /
                counted) * 100)
            : 0;
        text +=
            `\n\n👤 <b>${escapeHtml(student.name)}</b>
✅ ${present}  ❌ ${absent}  ⏰ ${late}  🤒 ${excused}
📈 ${percent}%`;
    }
    text +=
        `\n\n━━━━━━━━━━━━━━

📋 <b>ИТОГО ПО ГРУППЕ</b>

✅ Присутствий: <b>${totalPresent}</b>
❌ Пропусков: <b>${totalAbsent}</b>
⏰ Опозданий: <b>${totalLate}</b>
🤒 Болезнь: <b>${totalExcused}</b>`;
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: [
            [
                {
                    text: "📅 7 дней",
                    callback_data: "stats_period:7"
                },
                {
                    text: "📅 30 дней",
                    callback_data: "stats_period:30"
                }
            ],
            [
                {
                    text: "📚 Всё время",
                    callback_data: "stats_period:all"
                }
            ],
            [
                {
                    text: "⬅️ Статистика",
                    callback_data: "stats"
                },
                {
                    text: "🏠 Меню",
                    callback_data: "main"
                }
            ]
        ]
    });
}
async function showStudentPeriodStats(env, chatId, messageId, studentId, period) {
    const student = await env.DB.prepare(`
      SELECT name

      FROM students

      WHERE id = ?
    `)
        .bind(studentId)
        .first();
    if (!student) {
        return;
    }
    let dateCondition = "";
    let title = "Всё время";
    if (period === "7") {
        const from = shiftDate(localDate(), -6);
        dateCondition =
            `AND date >= '${from}'`;
        title =
            "Последние 7 дней";
    }
    if (period === "30") {
        const from = shiftDate(localDate(), -29);
        dateCondition =
            `AND date >= '${from}'`;
        title =
            "Последние 30 дней";
    }
    const stats = await env.DB.prepare(`
      SELECT

        SUM(
          CASE
            WHEN status = 'present'
            THEN 1 ELSE 0
          END
        ) AS present,

        SUM(
          CASE
            WHEN status = 'absent'
            THEN 1 ELSE 0
          END
        ) AS absent,

        SUM(
          CASE
            WHEN status = 'late'
            THEN 1 ELSE 0
          END
        ) AS late,

        SUM(
          CASE
            WHEN status IN ('excused', 'sick')
            THEN 1 ELSE 0
          END
        ) AS sick,

        SUM(
          CASE
            WHEN status = 'application'
            THEN 1 ELSE 0
          END
        ) AS application

      FROM attendance

      WHERE student_id = ?
      ${dateCondition}
    `)
        .bind(studentId)
        .first();
    const present = Number(stats?.present || 0);
    const absent = Number(stats?.absent || 0);
    const late = Number(stats?.late || 0);
    const excused = Number(stats?.excused || 0);
    const counted = present +
        absent +
        late;
    const percent = counted > 0
        ? Math.round(((present +
            late) /
            counted) * 100)
        : 0;
    await editOrSend(env, chatId, messageId, `📊 <b>СТАТИСТИКА СТУДЕНТА</b>

👤 <b>${escapeHtml(student.name)}</b>

📆 ${escapeHtml(title)}

━━━━━━━━━━━━━━

✅ Присутствовал: <b>${present}</b>
❌ Отсутствовал: <b>${absent}</b>
⏰ Опоздал: <b>${late}</b>
🤒 Болеет: <b>${sick}</b>
📝 По заявлению: <b>${application}</b>

📈 Посещаемость: <b>${percent}%</b>`, {
        inline_keyboard: [
            [
                {
                    text: "📅 7 дней",
                    callback_data: `student_period:${studentId}:7`
                },
                {
                    text: "📅 30 дней",
                    callback_data: `student_period:${studentId}:30`
                }
            ],
            [
                {
                    text: "📚 Всё время",
                    callback_data: `student_period:${studentId}:all`
                }
            ],
            [
                {
                    text: "⬅️ Карточка",
                    callback_data: `student:${studentId}`
                }
            ]
        ]
    });
}
async function showSettings(env, chatId, messageId, userId) {
    const admins = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM admins
    `)
        .first();
    const extraAdmins = Number(admins?.count || 0);
    let text = `⚙️ <b>НАСТРОЙКИ</b>

━━━━━━━━━━━━━━

👑 Владелец: <b>1</b>
👨‍🏫 Доп. преподавателей: <b>${extraAdmins}</b>

🔐 Владелец задаётся через ADMIN_ID и не может быть удалён из Telegram.`;
    if (!isOwner(env, userId)) {
        text +=
            `\n\nℹ️ Вы вошли как преподаватель.

Управление доступом доступно только владельцу.`;
    }
    const keyboard = [];
    if (isOwner(env, userId)) {
        keyboard.push([
            {
                text: "👥 Администраторы",
                callback_data: "admins"
            }
        ]);
    }
    keyboard.push([
        {
            text: "🏠 Главное меню",
            callback_data: "main"
        }
    ]);
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: keyboard
    });
}
async function showAdmins(env, chatId, messageId, userId) {
    if (!isOwner(env, userId)) {
        await answerSimple(env, chatId, "🔒 Только владелец может управлять администраторами.");
        return;
    }
    const result = await env.DB.prepare(`
      SELECT
        a.user_id,
        u.first_name,
        u.last_name,
        u.username

      FROM admins a

      LEFT JOIN users u
        ON u.user_id = a.user_id

      ORDER BY
        a.added_at ASC
    `)
        .all();
    const admins = result.results || [];
    let text = `👥 <b>АДМИНИСТРАТОРЫ</b>

👑 <b>Владелец</b>
ID: <code>${escapeHtml(String(env.ADMIN_ID))}</code>

━━━━━━━━━━━━━━`;
    if (admins.length === 0) {
        text +=
            `\n\n👨‍🏫 Дополнительных преподавателей пока нет.`;
    }
    else {
        text +=
            `\n\n👨‍🏫 <b>Преподаватели:</b>`;
        for (const admin of admins) {
            const name = userDisplayName(admin);
            text +=
                `\n\n• ${escapeHtml(name)}
<code>${escapeHtml(String(admin.user_id))}</code>`;
        }
    }
    const keyboard = [];
    keyboard.push([
        {
            text: "➕ Добавить преподавателя",
            callback_data: "admin_add"
        }
    ]);
    for (const admin of admins) {
        keyboard.push([
            {
                text: `🗑 ${userDisplayName(admin)}`,
                callback_data: `admin_delete:${admin.user_id}`
            }
        ]);
    }
    keyboard.push([
        {
            text: "⬅️ Настройки",
            callback_data: "settings"
        }
    ]);
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: keyboard
    });
}
async function showAdminCandidates(env, chatId, messageId, userId) {
    if (!isOwner(env, userId)) {
        return;
    }
    const result = await env.DB.prepare(`
      SELECT
        u.user_id,
        u.first_name,
        u.last_name,
        u.username

      FROM users u

      LEFT JOIN admins a
        ON a.user_id = u.user_id

      WHERE
        a.user_id IS NULL
        AND
        u.user_id != ?

      ORDER BY
        u.last_seen DESC

      LIMIT 20
    `)
        .bind(String(env.ADMIN_ID))
        .all();
    const users = result.results || [];
    let text = `➕ <b>ДОБАВИТЬ ПРЕПОДАВАТЕЛЯ</b>

Попросите преподавателя сначала открыть бота и отправить:

<code>/start</code>

После этого он появится здесь.

━━━━━━━━━━━━━━`;
    const keyboard = [];
    if (users.length === 0) {
        text +=
            `\n\nПока нет пользователей, которых можно добавить.`;
    }
    else {
        text +=
            `\n\nВыберите пользователя 👇`;
        for (const user of users) {
            keyboard.push([
                {
                    text: `➕ ${userDisplayName(user)}`,
                    callback_data: `admin_add_yes:${user.user_id}`
                }
            ]);
        }
    }
    keyboard.push([
        {
            text: "⬅️ Администраторы",
            callback_data: "admins"
        }
    ]);
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: keyboard
    });
}
async function addAdmin(env, targetUserId) {
    if (String(targetUserId) ===
        String(env.ADMIN_ID)) {
        return;
    }
    await env.DB.prepare(`
    INSERT OR IGNORE INTO admins(
      user_id,
      added_at
    )

    VALUES(
      ?,
      ?
    )
  `)
        .bind(String(targetUserId), new Date().toISOString())
        .run();
    try {
        await sendMessage(env, targetUserId, `✅ <b>Доступ открыт</b>

👨‍🏫 Вы добавлены как преподаватель в журнал группы №102.

Отправьте /start, чтобы открыть главное меню.`);
    }
    catch (error) {
        console.log("Admin notification error:", error);
    }
}
async function showAdminDeleteConfirm(env, chatId, messageId, targetUserId) {
    const user = await env.DB.prepare(`
      SELECT
        first_name,
        last_name,
        username

      FROM users

      WHERE user_id = ?
    `)
        .bind(String(targetUserId))
        .first();
    const name = userDisplayName(user || {
        user_id: targetUserId
    });
    await editOrSend(env, chatId, messageId, `🛡 <b>УДАЛИТЬ ДОСТУП?</b>

👨‍🏫 ${escapeHtml(name)}

После подтверждения преподаватель больше не сможет открыть журнал.

История посещаемости, дежурств и студентов не изменится.`, {
        inline_keyboard: [
            [
                {
                    text: "🗑 Да, удалить доступ",
                    callback_data: `admin_delete_yes:${targetUserId}`
                }
            ],
            [
                {
                    text: "❌ Отмена",
                    callback_data: "admins"
                }
            ]
        ]
    });
}
async function deleteAdmin(env, targetUserId) {
    if (String(targetUserId) ===
        String(env.ADMIN_ID)) {
        return;
    }
    await env.DB.prepare(`
    DELETE FROM admins

    WHERE user_id = ?
  `)
        .bind(String(targetUserId))
        .run();
    try {
        await sendMessage(env, targetUserId, `🔒 <b>Доступ к журналу закрыт</b>

Владелец удалил ваш доступ к журналу группы №102.`);
    }
    catch (error) {
        console.log("Admin remove notification error:", error);
    }
}
function userDisplayName(user) {
    if (!user) {
        return "Пользователь";
    }
    const fullName = [
        user.first_name,
        user.last_name
    ]
        .filter(Boolean)
        .join(" ")
        .trim();
    if (fullName) {
        return fullName;
    }
    if (user.username) {
        return ("@" +
            String(user.username));
    }
    if (user.user_id) {
        return ("ID " +
            String(user.user_id));
    }
    return "Пользователь";
}
async function handlePart5Callback(data, env, chatId, messageId, userId) {
    if (data.startsWith("stats_period:")) {
        const period = data.split(":")[1];
        if (["7", "30", "all"]
            .includes(period)) {
            await showGroupStats(env, chatId, messageId, period);
        }
        return true;
    }
    if (data.startsWith("student_period:")) {
        const parts = data.split(":");
        const studentId = Number(parts[1]);
        const period = parts[2];
        if (studentId &&
            ["7", "30", "all"]
                .includes(period)) {
            await showStudentPeriodStats(env, chatId, messageId, studentId, period);
        }
        return true;
    }
    if (data === "admins") {
        if (!isOwner(env, userId)) {
            return true;
        }
        await showAdmins(env, chatId, messageId, userId);
        return true;
    }
    if (data === "admin_add") {
        if (!isOwner(env, userId)) {
            return true;
        }
        await showAdminCandidates(env, chatId, messageId, userId);
        return true;
    }
    if (data.startsWith("admin_add_yes:")) {
        if (!isOwner(env, userId)) {
            return true;
        }
        const targetUserId = data.split(":")[1];
        if (targetUserId) {
            await addAdmin(env, targetUserId);
        }
        await showAdmins(env, chatId, messageId, userId);
        return true;
    }
    if (data.startsWith("admin_delete:")) {
        if (!isOwner(env, userId)) {
            return true;
        }
        const targetUserId = data.split(":")[1];
        if (targetUserId &&
            String(targetUserId) !==
                String(env.ADMIN_ID)) {
            await showAdminDeleteConfirm(env, chatId, messageId, targetUserId);
        }
        return true;
    }
    if (data.startsWith("admin_delete_yes:")) {
        if (!isOwner(env, userId)) {
            return true;
        }
        const targetUserId = data.split(":")[1];
        if (targetUserId) {
            await deleteAdmin(env, targetUserId);
        }
        await showAdmins(env, chatId, messageId, userId);
        return true;
    }
    return false;
}
import * as XLSX from "xlsx";
async function showMainMenu(env, chatId, messageId = null) {
    const date = localDate();
    const students = await getActiveStudents(env);
    const result = await env.DB.prepare(`
      SELECT
        status,
        COUNT(*) AS count

      FROM attendance

      WHERE date = ?

      GROUP BY status
    `)
        .bind(date)
        .all();
    let present = 0;
    let absent = 0;
    let late = 0;
    let excused = 0;
    for (const row of result.results || []) {
        const count = Number(row.count || 0);
        if (row.status === "present") {
            present = count;
        }
        else if (row.status === "absent") {
            absent = count;
        }
        else if (row.status === "late") {
            late = count;
        }
        else if (row.status === "excused") {
            excused = count;
        }
    }
    const marked = present +
        absent +
        late +
        excused;
    const unmarked = Math.max(0, students.length -
        marked);
    const duty = await env.DB.prepare(`
      SELECT COUNT(*) AS count

      FROM duty

      WHERE date = ?
    `)
        .bind(date)
        .first();
    const text = `👨‍🏫 <b>ЖУРНАЛ • ГРУППА №102</b>

📅 <b>${escapeHtml(formatDateLong(date))}</b>

━━━━━━━━━━━━━━

👥 Студентов: <b>${students.length}</b>

✅ Есть: <b>${present}</b>
❌ Нет: <b>${absent}</b>
⏰ Опоздали: <b>${late}</b>
🤒 Болеет: <b>${sick}</b>
📝 По заявлению: <b>${application}</b>

⚠️ Не отмечено: <b>${unmarked}</b>

🧹 Дежурных сегодня: <b>${Number(duty?.count || 0)}</b>

━━━━━━━━━━━━━━

Выберите раздел 👇`;
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: [
            [
                {
                    text: "👥 Посещаемость",
                    callback_data: "attendance"
                },
                {
                    text: "👀 Кого нет",
                    callback_data: "missing"
                }
            ],
            [
                {
                    text: "📆 История",
                    callback_data: "history"
                },
                {
                    text: "🧹 Дежурство",
                    callback_data: "duty"
                }
            ],
            [
                {
                    text: "📊 Статистика",
                    callback_data: "stats"
                },
                {
                    text: "👨‍🎓 Студенты",
                    callback_data: "students"
                }
            ],
            [
                {
                    text: "📤 Excel",
                    callback_data: "excel"
                },
                {
                    text: "⚙️ Настройки",
                    callback_data: "settings"
                }
            ]
        ]
    });
}
async function showExcelMenu(env, chatId, messageId) {
    await editOrSend(env, chatId, messageId, `📤 <b>ОТЧЁТ EXCEL</b>

Выберите период.

Бот создаст настоящий файл <b>.xlsx</b> с двумя листами:

📋 Посещаемость
📊 Сводка по студентам`, {
        inline_keyboard: [
            [
                {
                    text: "📅 7 дней",
                    callback_data: "excel_period:7"
                },
                {
                    text: "📅 30 дней",
                    callback_data: "excel_period:30"
                }
            ],
            [
                {
                    text: "📚 Всё время",
                    callback_data: "excel_period:all"
                }
            ],
            [
                {
                    text: "🏠 Главное меню",
                    callback_data: "main"
                }
            ]
        ]
    });
}
async function createExcelReport(env, period) {
    let fromDate = null;
    let periodName = "Всё время";
    let filePeriod = "all";
    if (period === "7") {
        fromDate =
            shiftDate(localDate(), -6);
        periodName =
            "Последние 7 дней";
        filePeriod =
            "7days";
    }
    if (period === "30") {
        fromDate =
            shiftDate(localDate(), -29);
        periodName =
            "Последние 30 дней";
        filePeriod =
            "30days";
    }
    let attendanceResult;
    if (fromDate) {
        attendanceResult =
            await env.DB.prepare(`
        SELECT
          a.date,
          s.name,
          a.status,

          CASE
            WHEN d.student_id IS NULL
            THEN 0
            ELSE 1
          END AS duty

        FROM attendance a

        JOIN students s
          ON s.id = a.student_id

        LEFT JOIN duty d
          ON
            d.student_id =
              a.student_id
            AND
            d.date =
              a.date

        WHERE
          a.date >= ?

        ORDER BY
          a.date ASC,
          s.name COLLATE NOCASE
      `)
                .bind(fromDate)
                .all();
    }
    else {
        attendanceResult =
            await env.DB.prepare(`
        SELECT
          a.date,
          s.name,
          a.status,

          CASE
            WHEN d.student_id IS NULL
            THEN 0
            ELSE 1
          END AS duty

        FROM attendance a

        JOIN students s
          ON s.id = a.student_id

        LEFT JOIN duty d
          ON
            d.student_id =
              a.student_id
            AND
            d.date =
              a.date

        ORDER BY
          a.date ASC,
          s.name COLLATE NOCASE
      `)
                .all();
    }
    const attendanceRows = [];
    for (const row of attendanceResult.results || []) {
        attendanceRows.push({
            "Дата": row.date,
            "Студент": row.name,
            "Статус": statusText(row.status),
            "Дежурство": Number(row.duty || 0)
                ? "Да"
                : ""
        });
    }
    let statsResult;
    if (fromDate) {
        statsResult =
            await env.DB.prepare(`
        SELECT
          s.id,
          s.name,

          SUM(
            CASE
              WHEN a.status = 'present'
              THEN 1 ELSE 0
            END
          ) AS present,

          SUM(
            CASE
              WHEN a.status = 'absent'
              THEN 1 ELSE 0
            END
          ) AS absent,

          SUM(
            CASE
              WHEN a.status = 'late'
              THEN 1 ELSE 0
            END
          ) AS late,

          SUM(
          CASE
            WHEN status IN ('excused', 'sick')
            THEN 1 ELSE 0
          END
        ) AS sick,

        SUM(
          CASE
            WHEN status = 'application'
            THEN 1 ELSE 0
          END
        ) AS application

        FROM students s

        LEFT JOIN attendance a
          ON
            a.student_id = s.id
            AND
            a.date >= ?

        WHERE
          s.active = 1

        GROUP BY
          s.id,
          s.name

        ORDER BY
          s.name COLLATE NOCASE
      `)
                .bind(fromDate)
                .all();
    }
    else {
        statsResult =
            await env.DB.prepare(`
        SELECT
          s.id,
          s.name,

          SUM(
            CASE
              WHEN a.status = 'present'
              THEN 1 ELSE 0
            END
          ) AS present,

          SUM(
            CASE
              WHEN a.status = 'absent'
              THEN 1 ELSE 0
            END
          ) AS absent,

          SUM(
            CASE
              WHEN a.status = 'late'
              THEN 1 ELSE 0
            END
          ) AS late,

          SUM(
          CASE
            WHEN status IN ('excused', 'sick')
            THEN 1 ELSE 0
          END
        ) AS sick,

        SUM(
          CASE
            WHEN status = 'application'
            THEN 1 ELSE 0
          END
        ) AS application

        FROM students s

        LEFT JOIN attendance a
          ON a.student_id = s.id

        WHERE
          s.active = 1

        GROUP BY
          s.id,
          s.name

        ORDER BY
          s.name COLLATE NOCASE
      `)
                .all();
    }
    const summaryRows = [];
    for (const row of statsResult.results || []) {
        const present = Number(row.present || 0);
        const absent = Number(row.absent || 0);
        const late = Number(row.late || 0);
        const excused = Number(row.excused || 0);
        const counted = present +
            absent +
            late;
        const percent = counted > 0
            ? Math.round(((present +
                late) /
                counted) * 100)
            : 0;
        const dutyResult = fromDate
            ? await env.DB.prepare(`
            SELECT
              COUNT(*) AS count

            FROM duty

            WHERE
              student_id = ?
              AND
              date >= ?
          `)
                .bind(row.id, fromDate)
                .first()
            : await env.DB.prepare(`
            SELECT
              COUNT(*) AS count

            FROM duty

            WHERE
              student_id = ?
          `)
                .bind(row.id)
                .first();
        summaryRows.push({
            "Студент": row.name,
            "Присутствовал": present,
            "Отсутствовал": absent,
            "Опоздал": late,
            "Болеет": excused,
            "Посещаемость %": percent,
            "Дежурств": Number(dutyResult?.count || 0)
        });
    }
    if (attendanceRows.length === 0) {
        attendanceRows.push({
            "Дата": "",
            "Студент": "",
            "Статус": "",
            "Дежурство": ""
        });
    }
    const workbook = XLSX.utils.book_new();
    const attendanceSheet = XLSX.utils.json_to_sheet(attendanceRows);
    const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
    attendanceSheet["!cols"] = [
        { wch: 14 },
        { wch: 32 },
        { wch: 20 },
        { wch: 14 }
    ];
    summarySheet["!cols"] = [
        { wch: 32 },
        { wch: 16 },
        { wch: 16 },
        { wch: 12 },
        { wch: 16 },
        { wch: 18 },
        { wch: 12 }
    ];
    XLSX.utils.book_append_sheet(workbook, attendanceSheet, "Посещаемость");
    XLSX.utils.book_append_sheet(workbook, summarySheet, "Сводка");
    const infoSheet = XLSX.utils.aoa_to_sheet([
        [
            "Журнал",
            "Группа №102"
        ],
        [
            "Период",
            periodName
        ],
        [
            "Дата создания",
            formatDateLong(localDate())
        ]
    ]);
    infoSheet["!cols"] = [
        { wch: 20 },
        { wch: 35 }
    ];
    XLSX.utils.book_append_sheet(workbook, infoSheet, "Информация");
    const buffer = XLSX.write(workbook, {
        type: "array",
        bookType: "xlsx"
    });
    return {
        buffer,
        filename: `journal_102_${localDate()}_${filePeriod}.xlsx`
    };
}
async function sendExcelReport(env, chatId, period) {
    await sendMessage(env, chatId, `⏳ <b>Создаю Excel-отчёт...</b>

Это может занять несколько секунд.`);
    const report = await createExcelReport(env, period);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", `📊 Журнал группы №102\n📅 ${formatDateLong(localDate())}`);
    form.append("document", new Blob([
        report.buffer
    ], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }), report.filename);
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
        method: "POST",
        body: form
    });
    const result = await response.json();
    if (!result.ok) {
        console.error("Excel Telegram error:", result);
        await sendMessage(env, chatId, `❌ Не удалось отправить Excel.

Попробуйте ещё раз.`);
    }
}
async function handlePart6Callback(data, env, chatId, messageId, userId) {
    if (data.startsWith("excel_period:")) {
        const period = data.split(":")[1];
        if (![
            "7",
            "30",
            "all"
        ].includes(period)) {
            return true;
        }
        await sendExcelReport(env, chatId, period);
        await showExcelMenu(env, chatId, messageId);
        return true;
    }
    return false;
}
function statusText(status) {
    if (status === "present") {
        return "Присутствует";
    }
    if (status === "absent") {
        return "Отсутствует";
    }
    if (status === "late") {
        return "Опоздал";
    }
    if (status === "sick" || status === "excused") {
        return "Болеет";
    }
    if (status === "application") {
        return "По заявлению";
    }
    return "Не отмечено";
}
async function setState(env, userId, action, data = "") {
    await env.DB.prepare(`
    INSERT INTO states(
      user_id,
      action,
      data
    )

    VALUES(
      ?,
      ?,
      ?
    )

    ON CONFLICT(user_id)

    DO UPDATE SET

      action =
        excluded.action,

      data =
        excluded.data
  `)
        .bind(String(userId), String(action), String(data || ""))
        .run();
}
async function clearState(env, userId) {
    await env.DB.prepare(`
    DELETE FROM states

    WHERE user_id = ?
  `)
        .bind(String(userId))
        .run();
}
function localDate() {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    })
        .formatToParts(new Date());
    const map = {};
    for (const part of parts) {
        if (part.type !==
            "literal") {
            map[part.type] =
                part.value;
        }
    }
    return (`${map.year}-${map.month}-${map.day}`);
}
function shiftDate(date, days) {
    const base = new Date(`${date}T12:00:00Z`);
    base.setUTCDate(base.getUTCDate() +
        Number(days));
    return [
        base
            .getUTCFullYear(),
        String(base.getUTCMonth() + 1)
            .padStart(2, "0"),
        String(base.getUTCDate())
            .padStart(2, "0")
    ].join("-");
}
function dateWeekday(date) {
    const d = new Date(`${date}T12:00:00Z`);
    return (d.getUTCDay());
}
function nextWorkday(date) {
    let result = shiftDate(date, 1);
    while (dateWeekday(result) === 0 ||
        dateWeekday(result) === 6) {
        result =
            shiftDate(result, 1);
    }
    return result;
}
function previousWorkday(date) {
    let result = shiftDate(date, -1);
    while (dateWeekday(result) === 0 ||
        dateWeekday(result) === 6) {
        result =
            shiftDate(result, -1);
    }
    return result;
}
function isToday(date) {
    return (String(date) ===
        localDate());
}
function isValidDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/
        .test(String(date || ""))) {
        return false;
    }
    const d = new Date(`${date}T12:00:00Z`);
    return (!Number.isNaN(d.getTime()));
}
function formatDateShort(date) {
    const parts = String(date)
        .split("-");
    if (parts.length !== 3) {
        return date;
    }
    return (`${parts[2]}.${parts[1]}`);
}
function formatDateLong(date) {
    if (!isValidDate(date)) {
        return date;
    }
    const d = new Date(`${date}T12:00:00Z`);
    let value = new Intl.DateTimeFormat("ru-RU", {
        timeZone: TZ,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
    })
        .format(d);
    value =
        value.charAt(0)
            .toUpperCase() +
            value.slice(1);
    return value;
}
function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function cleanName(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100);
}
async function telegram(env, method, payload = {}) {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: {
            "content-type": "application/json"
        },
        body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!result.ok) {
        console.error(`Telegram ${method}:`, result);
    }
    return result;
}
async function sendMessage(env, chatId, text, replyMarkup = null) {
    const payload = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
    };
    if (replyMarkup) {
        payload.reply_markup =
            replyMarkup;
    }
    return telegram(env, "sendMessage", payload);
}
async function editMessage(env, chatId, messageId, text, replyMarkup = null) {
    const payload = {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
    };
    if (replyMarkup) {
        payload.reply_markup =
            replyMarkup;
    }
    return telegram(env, "editMessageText", payload);
}
async function editOrSend(env, chatId, messageId, text, replyMarkup = null) {
    if (messageId) {
        const result = await editMessage(env, chatId, messageId, text, replyMarkup);
        if (result?.ok) {
            return result;
        }
    }
    return sendMessage(env, chatId, text, replyMarkup);
}
async function answerCallback(env, callbackQueryId, text = "") {
    return telegram(env, "answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text
    });
}
async function answerSimple(env, chatId, text) {
    return sendMessage(env, chatId, text);
}
async function initLessonAttendance(env) {
    await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS lesson_attendance (
      date TEXT NOT NULL,
      lesson_no INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      status TEXT NOT NULL,

      PRIMARY KEY (
        date,
        lesson_no,
        student_id
      )
    )
  `).run();
}
const originalInitDb = initDb;
initDb = async function (env) {
    await originalInitDb(env);
    await initLessonAttendance(env);
};
function lessonsCountForDate(date) {
    const day = dateWeekday(date);
    const schedule = {
        1: 3,
        2: 4,
        3: 4,
        4: 3,
        5: 4
    };
    return schedule[day] || 4;
}
function pairStatusEmoji(status) {
    const map = {
        present: "✅",
        absent: "❌",
        late: "⏰",
        sick: "🤒",
        application: "📝",
        excused: "🤒",
        left: "🚪",
        none: "➖"
    };
    return map[status] || "➖";
}
async function getPairStatuses(env, date) {
    const result = await env.DB.prepare(`
      SELECT
        lesson_no,
        student_id,
        status

      FROM lesson_attendance

      WHERE date = ?
    `)
        .bind(date)
        .all();
    const map = new Map();
    for (const row of result.results || []) {
        map.set(`${row.student_id}:${row.lesson_no}`, row.status);
    }
    return map;
}
async function showPairsDay(env, chatId, messageId, date) {
    const students = await getActiveStudents(env);
    const lessonCount = lessonsCountForDate(date);
    const statuses = await getPairStatuses(env, date);
    const previous = previousWorkday(date);
    const next = nextWorkday(date);
    let text = `📚 <b>ПОСЕЩАЕМОСТЬ ПО ПАРАМ</b>

📅 <b>${escapeHtml(formatDateLong(date))}</b>

🔢 Пар сегодня: <b>${lessonCount}</b>

━━━━━━━━━━━━━━

Нажмите на студента 👇

✅ был
❌ не был
⏰ опоздал
🤒 болеет
📝 по заявлению
🚪 ушёл
➖ не отмечено`;
    const keyboard = [];
    keyboard.push([
        {
            text: `◀️ ${formatDateShort(previous)}`,
            callback_data: `pairs:${previous}`
        },
        {
            text: isToday(date)
                ? "📅 Сегодня"
                : formatDateShort(date),
            callback_data: `pairs:${localDate()}`
        },
        {
            text: `${formatDateShort(next)} ▶️`,
            callback_data: `pairs:${next}`
        }
    ]);
    for (const student of students) {
        let marks = "";
        for (let lesson = 1; lesson <= lessonCount; lesson++) {
            const status = statuses.get(`${student.id}:${lesson}`) || "none";
            marks +=
                `${lesson}${pairStatusEmoji(status)} `;
        }
        keyboard.push([
            {
                text: `${student.name} • ${marks.trim()}`,
                callback_data: `pair_student:${date}:${student.id}`
            }
        ]);
    }
    keyboard.push([
        {
            text: "👀 Кто был по парам",
            callback_data: `pairs_summary:${date}`
        }
    ]);
    keyboard.push([
        {
            text: "👥 Обычная посещаемость",
            callback_data: `attendance:${date}`
        }
    ]);
    keyboard.push([
        {
            text: "🏠 Главное меню",
            callback_data: "main"
        }
    ]);
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: keyboard
    });
}
async function showPairStudent(env, chatId, messageId, date, studentId) {
    const student = await env.DB.prepare(`
      SELECT name

      FROM students

      WHERE
        id = ?
        AND active = 1
    `)
        .bind(studentId)
        .first();
    if (!student) {
        return;
    }
    const lessonCount = lessonsCountForDate(date);
    const statuses = await getPairStatuses(env, date);
    let text = `👤 <b>${escapeHtml(student.name)}</b>

📅 ${escapeHtml(formatDateLong(date))}

━━━━━━━━━━━━━━

Нажимайте на пару для смены статуса:

➖ → ✅ → ❌ → ⏰ → 🤒 → 📝 → ➖

Если студент ушёл во время определённой пары —
используйте кнопку 🚪 ниже.`;
    const keyboard = [];
    for (let lesson = 1; lesson <= lessonCount; lesson++) {
        const status = statuses.get(`${studentId}:${lesson}`) || "none";
        keyboard.push([
            {
                text: `${lesson}️⃣ пара — ${pairStatusEmoji(status)}`,
                callback_data: `pair_cycle:${date}:${lesson}:${studentId}`
            }
        ]);
    }
    const leaveButtons = [];
    for (let lesson = 1; lesson <= lessonCount; lesson++) {
        leaveButtons.push({
            text: `🚪 ${lesson}`,
            callback_data: `pair_leave:${date}:${lesson}:${studentId}`
        });
        if (leaveButtons.length === 3 ||
            lesson === lessonCount) {
            keyboard.push(leaveButtons.splice(0));
        }
    }
    keyboard.push([
        {
            text: "⬅️ Все студенты",
            callback_data: `pairs:${date}`
        }
    ]);
    keyboard.push([
        {
            text: "👀 Сводка по парам",
            callback_data: `pairs_summary:${date}`
        }
    ]);
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: keyboard
    });
}
async function cyclePairStatus(env, date, lesson, studentId) {
    const current = await env.DB.prepare(`
      SELECT status

      FROM lesson_attendance

      WHERE
        date = ?
        AND lesson_no = ?
        AND student_id = ?
    `)
        .bind(date, lesson, studentId)
        .first();
    const oldStatus = current?.status || "none";
    const next = {
        none: "present",
        present: "absent",
        absent: "late",
        late: "sick",
        sick: "application",
        application: "none",
        excused: "sick",
        left: "none"
    }[oldStatus] || "present";
    if (next === "none") {
        await env.DB.prepare(`
      DELETE FROM lesson_attendance

      WHERE
        date = ?
        AND lesson_no = ?
        AND student_id = ?
    `)
            .bind(date, lesson, studentId)
            .run();
        return;
    }
    await env.DB.prepare(`
    INSERT INTO lesson_attendance(
      date,
      lesson_no,
      student_id,
      status
    )

    VALUES(
      ?,
      ?,
      ?,
      ?
    )

    ON CONFLICT(
      date,
      lesson_no,
      student_id
    )

    DO UPDATE SET
      status = excluded.status
  `)
        .bind(date, lesson, studentId, next)
        .run();
}
async function markStudentLeft(env, date, leaveLesson, studentId) {
    const lessonCount = lessonsCountForDate(date);
    for (let lesson = 1; lesson <= lessonCount; lesson++) {
        let status;
        if (lesson < leaveLesson) {
            status = "present";
        }
        else if (lesson === leaveLesson) {
            status = "left";
        }
        else {
            status = "absent";
        }
        await env.DB.prepare(`
      INSERT INTO lesson_attendance(
        date,
        lesson_no,
        student_id,
        status
      )

      VALUES(
        ?,
        ?,
        ?,
        ?
      )

      ON CONFLICT(
        date,
        lesson_no,
        student_id
      )

      DO UPDATE SET
        status = excluded.status
    `)
            .bind(date, lesson, studentId, status)
            .run();
    }
}
async function showPairsSummary(env, chatId, messageId, date) {
    const students = await getActiveStudents(env);
    const lessonCount = lessonsCountForDate(date);
    const statuses = await getPairStatuses(env, date);
    let text = `👀 <b>КТО БЫЛ ПО ПАРАМ</b>

📅 <b>${escapeHtml(formatDateLong(date))}</b>

━━━━━━━━━━━━━━`;
    for (let lesson = 1; lesson <= lessonCount; lesson++) {
        const present = [];
        const absent = [];
        const late = [];
        const sick = [];
        const application = [];
        const left = [];
        const unmarked = [];
        for (const student of students) {
            const status = statuses.get(`${student.id}:${lesson}`) || "none";
            if (status === "present") {
                present.push(student.name);
            }
            else if (status === "absent") {
                absent.push(student.name);
            }
            else if (status === "late") {
                late.push(student.name);
            }
            else if (status === "sick" || status === "excused") {
                sick.push(student.name);
            }
            else if (status === "application") {
                application.push(student.name);
            }
            else if (status === "left") {
                left.push(student.name);
            }
            else {
                unmarked.push(student.name);
            }
        }
        text +=
            `\n\n<b>${lesson}️⃣ ПАРА</b>

✅ Были: <b>${present.length}</b>`;
        if (absent.length) {
            text +=
                `\n❌ Нет: ${absent
                    .map(escapeHtml)
                    .join(", ")}`;
        }
        if (late.length) {
            text +=
                `\n⏰ Опоздали: ${late
                    .map(escapeHtml)
                    .join(", ")}`;
        }
        if (left.length) {
            text +=
                `\n🚪 Ушли: ${left
                    .map(escapeHtml)
                    .join(", ")}`;
        }
        if (sick.length) {
            text +=
                `\n🤒 Болеют: ${sick.map(escapeHtml).join(", ")}`;
        }
        if (application.length) {
            text +=
                `\n📝 По заявлению: ${application.map(escapeHtml).join(", ")}`;
        }
        if (unmarked.length) {
            text +=
                `\n➖ Не отмечено: <b>${unmarked.length}</b>`;
        }
    }
    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: [
            [
                {
                    text: "⬅️ По парам",
                    callback_data: `pairs:${date}`
                }
            ],
            [
                {
                    text: "🏠 Главное меню",
                    callback_data: "main"
                }
            ]
        ]
    });
}
const oldExtraCallbackPairs = handleExtraCallback;
handleExtraCallback =
    async function (data, env, chatId, messageId, userId) {
        if (data === "pairs") {
            await showPairsDay(env, chatId, messageId, localDate());
            return true;
        }
        if (data.startsWith("pairs:")) {
            const date = data.split(":")[1];
            if (isValidDate(date)) {
                await showPairsDay(env, chatId, messageId, date);
            }
            return true;
        }
        if (data.startsWith("pair_student:")) {
            const parts = data.split(":");
            const date = parts[1];
            const studentId = Number(parts[2]);
            await showPairStudent(env, chatId, messageId, date, studentId);
            return true;
        }
        if (data.startsWith("pair_cycle:")) {
            const parts = data.split(":");
            const date = parts[1];
            const lesson = Number(parts[2]);
            const studentId = Number(parts[3]);
            await cyclePairStatus(env, date, lesson, studentId);
            await showPairStudent(env, chatId, messageId, date, studentId);
            return true;
        }
        if (data.startsWith("pair_leave:")) {
            const parts = data.split(":");
            const date = parts[1];
            const lesson = Number(parts[2]);
            const studentId = Number(parts[3]);
            await markStudentLeft(env, date, lesson, studentId);
            await showPairStudent(env, chatId, messageId, date, studentId);
            return true;
        }
        if (data.startsWith("pairs_summary:")) {
            const date = data.split(":")[1];
            await showPairsSummary(env, chatId, messageId, date);
            return true;
        }
        return oldExtraCallbackPairs(data, env, chatId, messageId, userId);
    };
showMainMenu =
    async function (env, chatId, messageId = null) {
        await editOrSend(env, chatId, messageId, `📚 <b>ЖУРНАЛ ГРУППЫ №102</b>

Выберите раздел 👇`, {
            inline_keyboard: [
                [
                    {
                        text: "📚 По парам",
                        callback_data: "pairs"
                    }
                ],
                [
                    {
                        text: "👥 Посещаемость",
                        callback_data: "attendance"
                    },
                    {
                        text: "👀 Кого нет",
                        callback_data: "missing"
                    }
                ],
                [
                    {
                        text: "📆 История",
                        callback_data: "history"
                    },
                    {
                        text: "🧹 Дежурство",
                        callback_data: "duty"
                    }
                ],
                [
                    {
                        text: "📊 Статистика",
                        callback_data: "stats"
                    },
                    {
                        text: "👨‍🎓 Студенты",
                        callback_data: "students"
                    }
                ],
                [
                    {
                        text: "📤 Excel",
                        callback_data: "excel"
                    },
                    {
                        text: "⚙️ Настройки",
                        callback_data: "settings"
                    }
                ]
            ]
        });
        function parentShortName(name) {
            const parts = String(name || "")
                .trim()
                .split(/\s+/);
            const surname = parts[0] || "";
            const initial = parts[1]
                ? parts[1][0] + "."
                : "";
            return `${surname} ${initial}`.trim();
        }
        function monthTitle(month) {
            const months = [
                "ЯНВАРЬ",
                "ФЕВРАЛЬ",
                "МАРТ",
                "АПРЕЛЬ",
                "МАЙ",
                "ИЮНЬ",
                "ИЮЛЬ",
                "АВГУСТ",
                "СЕНТЯБРЬ",
                "ОКТЯБРЬ",
                "НОЯБРЬ",
                "ДЕКАБРЬ"
            ];
            const [year, m] = month.split("-");
            return `${months[Number(m) - 1]} ${year}`;
        }
        function shiftMonth(month, diff) {
            const [year, m] = month
                .split("-")
                .map(Number);
            const d = new Date(Date.UTC(year, m - 1 + diff, 1));
            return (d.getUTCFullYear() +
                "-" +
                String(d.getUTCMonth() + 1).padStart(2, "0"));
        }
        async function showParentsReport(env, chatId, messageId, month) {
            const rows = await parentsApi(env, month);
            let text = `👨‍👩‍👦 <b>ДЛЯ РОДИТЕЛЕЙ</b>
📊 <b>${monthTitle(month)} • ГРУППА 102</b>
━━━━━━━━━━━━━━

`;
            for (const row of rows) {
                text += `${escapeHtml(parentShortName(row.name))}  📅${row.full_days} ❌${row.absent} 🚪${row.left} ⏰${row.late} 🤒${row.sick} 📝${row.application} ↔️${row.partial_days || 0}
`;
            }
            text += `
━━━━━━━━━━━━━━
📅 полный день отсутствия
❌ пропущено пар
🚪 ушёл раньше
⏰ опоздания
🤒 полных дней болезни
📝 полных дней по заявлению
↔️ частичное посещение`;

            await editOrSend(env, chatId, messageId, text, {
                inline_keyboard: [
                    [
                        {text:"◀️",callback_data:`parents_month:${shiftMonth(month,-1)}`},
                        {text:`📅 ${monthTitle(month)}`,callback_data:"parents_noop"},
                        {text:"▶️",callback_data:`parents_month:${shiftMonth(month,1)}`}
                    ],
                    [{text:"🔎 Подробно по ученику",callback_data:`parents_students:${month}`}],
                    [{text:"🏠 Главное меню",callback_data:"main"}]
                ]
            });
        }
        async function showParentsStudents(env, chatId, messageId, month) {
            const students = await getActiveStudents(env);
            const keyboard = [];
            for (const student of students) {
                keyboard.push([
                    {
                        text: parentShortName(student.name),
                        callback_data: `parents_student:${month}:${student.id}`
                    }
                ]);
            }
            keyboard.push([
                {
                    text: "⬅️ К общей сводке",
                    callback_data: `parents_month:${month}`
                }
            ]);
            await editOrSend(env, chatId, messageId, `👨‍👩‍👦 <b>ПОДРОБНОСТИ</b>

📅 ${monthTitle(month)}

Выберите ученика 👇`, {
                inline_keyboard: keyboard
            });
        }
        async function showParentStudent(env, chatId, messageId, month, studentId) {
            const student = await env.DB.prepare(`SELECT id,name FROM students WHERE id=?`).bind(studentId).first();
            if(!student)return;

            const smart=await smartMonthData(env,month);
            const row=smart.rows.find(x=>Number(x.id)===Number(studentId));
            const days=(row?.days||[]).filter(x=>x.kind!=="present"&&x.kind!=="none");

            let text=`👨‍👩‍👦 <b>ДЛЯ РОДИТЕЛЕЙ</b>

👤 <b>${escapeHtml(student.name)}</b>
📅 ${monthTitle(month)}

━━━━━━━━━━━━━━
📅 Полных дней отсутствия: <b>${row?.full_days||0}</b>
❌ Пропущено пар: <b>${row?.absent||0}</b>
🚪 Уходов раньше: <b>${row?.left||0}</b>
⏰ Опозданий: <b>${row?.late||0}</b>
🤒 Полных дней болезни: <b>${row?.sick||0}</b>
📝 Полных дней по заявлению: <b>${row?.application||0}</b>
↔️ Частичных дней: <b>${row?.partial_days||0}</b>
━━━━━━━━━━━━━━`;

            if(!days.length) text += `\n\n✅ Особых отметок за месяц нет.`;
            else {
                text += `\n\n📅 <b>По дням:</b>`;
                for(const d of days){
                    const dt=d.date.split("-").reverse().slice(0,2).join(".");
                    text += `\n${dt} — ${escapeHtml(d.label)}`;
                }
            }

            await editOrSend(env,chatId,messageId,text,{
                inline_keyboard:[
                    [{text:"⬅️ К ученикам",callback_data:`parents_students:${month}`}],
                    [{text:"📊 Общая сводка",callback_data:`parents_month:${month}`}]
                ]
            });
        }
        const oldExtraCallbackParents = handleExtraCallback;
        handleExtraCallback =
            async function (data, env, chatId, messageId, userId) {
                if (data === "parents") {
                    const month = localDate()
                        .slice(0, 7);
                    await showParentsReport(env, chatId, messageId, month);
                    return true;
                }
                if (data.startsWith("parents_month:")) {
                    const month = data.split(":")[1];
                    await showParentsReport(env, chatId, messageId, month);
                    return true;
                }
                if (data.startsWith("parents_students:")) {
                    const month = data.split(":")[1];
                    await showParentsStudents(env, chatId, messageId, month);
                    return true;
                }
                if (data.startsWith("parents_student:")) {
                    const parts = data.split(":");
                    const month = parts[1];
                    const studentId = Number(parts[2]);
                    await showParentStudent(env, chatId, messageId, month, studentId);
                    return true;
                }
                if (data === "parents_noop") {
                    return true;
                }
                return oldExtraCallbackParents(data, env, chatId, messageId, userId);
            };
        showMainMenu =
            async function (env, chatId, messageId = null) {
                await editOrSend(env, chatId, messageId, `📚 <b>ЖУРНАЛ ГРУППЫ №102</b>

Выберите раздел 👇`, {
                    inline_keyboard: [
                        [
                            {
                                text: "👨‍👩‍👦 ДЛЯ РОДИТЕЛЕЙ",
                                callback_data: "parents"
                            }
                        ],
                        [
                            {
                                text: "📚 По парам",
                                callback_data: "pairs"
                            }
                        ],
                        [
                            {
                                text: "👥 Посещаемость",
                                callback_data: "attendance"
                            },
                            {
                                text: "👀 Кого нет",
                                callback_data: "missing"
                            }
                        ],
                        [
                            {
                                text: "📆 История",
                                callback_data: "history"
                            },
                            {
                                text: "🧹 Дежурство",
                                callback_data: "duty"
                            }
                        ],
                        [
                            {
                                text: "📊 Статистика",
                                callback_data: "stats"
                            },
                            {
                                text: "👨‍🎓 Студенты",
                                callback_data: "students"
                            }
                        ],
                        [
                            {
                                text: "📤 Excel",
                                callback_data: "excel"
                            },
                            {
                                text: "⚙️ Настройки",
                                callback_data: "settings"
                            }
                        ],
                        [
                            {
                                text: "🌐 Веб-версия",
                                web_app: {
                                    url: await getWebAppUrl(env)
                                }
                            }
                        ]
                    ]
                });
            };
        showParentsReport =
            async function (env, chatId, messageId, month) {
                await initLessonAttendance(env);
                const students = await getActiveStudents(env);
                const result = await env.DB.prepare(`
        SELECT
          student_id,

          SUM(
            CASE WHEN status = 'absent'
            THEN 1 ELSE 0 END
          ) AS absent_count,

          SUM(
            CASE WHEN status = 'left'
            THEN 1 ELSE 0 END
          ) AS left_count,

          SUM(
            CASE WHEN status = 'late'
            THEN 1 ELSE 0 END
          ) AS late_count,

          SUM(
          CASE
            WHEN status IN ('excused', 'sick')
            THEN 1 ELSE 0
          END
        ) AS sick,

        SUM(
          CASE
            WHEN status = 'application'
            THEN 1 ELSE 0
          END
        ) AS application_count

        FROM lesson_attendance

        WHERE substr(date, 1, 7) = ?

        GROUP BY student_id
      `)
                    .bind(month)
                    .all();
                const stats = new Map();
                for (const row of result.results || []) {
                    stats.set(Number(row.student_id), row);
                }
                const lines = [];
                for (const student of students) {
                    const row = stats.get(Number(student.id)) || {};
                    const absent = Number(row.absent_count || 0);
                    const left = Number(row.left_count || 0);
                    const late = Number(row.late_count || 0);
                    const sick = Number(row.sick_count || row.excused_count || 0);
                    const application = Number(row.application_count || 0);
                    let name = String(student.name || "").trim().split(/\s+/)[0];
                    if (name.length > 11) {
                        name = name.slice(0, 10) + "…";
                    }
                    name = name.padEnd(12, " ");
                    lines.push(`${name} ${String(absent).padStart(2)} ` +
                        `${String(left).padStart(2)} ` +
                        `${String(late).padStart(2)} ` +
                        `${String(sick).padStart(2)} ` +
                        `${String(application).padStart(2)}`);
                }
                const table = `Фамилия      ❌ 🚪 ⏰ 🤒 📝
──────────────────────────
${lines.join("\n")}
──────────────────────────`;
                const text = `👨‍👩‍👦 <b>ДЛЯ РОДИТЕЛЕЙ</b>
📊 <b>${monthTitle(month)} • ГРУППА 102</b>

<pre>${escapeHtml(table)}</pre>
❌ Пропуски пар
🚪 Ушёл раньше
⏰ Опоздания
🤒 Болеет
📝 По заявлению`;
                await editOrSend(env, chatId, messageId, text, {
                    inline_keyboard: [
                        [
                            {
                                text: "◀️",
                                callback_data: `parents_month:${shiftMonth(month, -1)}`
                            },
                            {
                                text: `📅 ${monthTitle(month)}`,
                                callback_data: "parents_noop"
                            },
                            {
                                text: "▶️",
                                callback_data: `parents_month:${shiftMonth(month, 1)}`
                            }
                        ],
                        [
                            {
                                text: "🔎 Подробно по ученику",
                                callback_data: `parents_students:${month}`
                            }
                        ],
                        [
                            {
                                text: "🏠 Главное меню",
                                callback_data: "main"
                            }
                        ]
                    ]
                });
            };
    };

// =====================================================
// РОДИТЕЛИ v2: ПОЛНЫЕ ДНИ + СКРИН
// =====================================================

async function getParentsMonthStats(env, month) {
    await initLessonAttendance(env);

    const students = await getActiveStudents(env);

    const pairRows = await env.DB.prepare(`
        SELECT
            student_id,
            SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent_count,
            SUM(CASE WHEN status = 'left' THEN 1 ELSE 0 END) AS left_count,
            SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late_count,
            SUM(CASE WHEN status IN ('excused', 'sick') THEN 1 ELSE 0 END) AS sick_count,
            SUM(CASE WHEN status = 'application' THEN 1 ELSE 0 END) AS application_count
        FROM lesson_attendance
        WHERE substr(date, 1, 7) = ?
        GROUP BY student_id
    `).bind(month).all();

    // Полный день считаем только из обычной посещаемости.
    // Если на эту дату уже есть попарные отметки ученика,
    // второй раз тот же день не считаем.
    const dayRows = await env.DB.prepare(`
        SELECT
            a.student_id,
            COUNT(*) AS full_day_count
        FROM attendance a
        WHERE
            substr(a.date, 1, 7) = ?
            AND a.status = 'absent'
        GROUP BY a.student_id
    `).bind(month).all();

    const pairMap = new Map();
    const dayMap = new Map();

    for (const row of pairRows.results || []) {
        pairMap.set(Number(row.student_id), row);
    }

    for (const row of dayRows.results || []) {
        dayMap.set(Number(row.student_id), Number(row.full_day_count || 0));
    }

    return students.map(student => {
        const row = pairMap.get(Number(student.id)) || {};

        return {
            id: Number(student.id),
            name: student.name,
            fullDays: dayMap.get(Number(student.id)) || 0,
            absent: Number(row.absent_count || 0),
            left: Number(row.left_count || 0),
            late: Number(row.late_count || 0),
            sick: Number(row.sick_count || 0),
            application: Number(row.application_count || 0)
        };
    });
}

function parentTable(stats) {
    const lines = stats.map(student => {
        let name = parentShortName(student.name);

        if (name.length > 15) {
            name = name.slice(0, 14) + "…";
        }

        name = name.padEnd(16, " ");

        return (
            `${name}` +
            `${String(student.fullDays).padStart(2)} ` +
            `${String(student.absent).padStart(2)} ` +
            `${String(student.left).padStart(2)} ` +
            `${String(student.late).padStart(2)} ` +
            `${String(student.sick).padStart(2)} ` +
            `${String(student.application).padStart(2)}`
        );
    });

    return `Фамилия          📅 ❌ 🚪 ⏰ 🤒 📝
─────────────────────────────
${lines.join("\n")}
─────────────────────────────`;
}

function parentsTotals(stats) {
    return stats.reduce(
        (sum, s) => {
            sum.fullDays += s.fullDays;
            sum.absent += s.absent;
            sum.left += s.left;
            sum.late += s.late;
            sum.sick += s.sick;
            sum.application += s.application;
            return sum;
        },
        { fullDays: 0, absent: 0, left: 0, late: 0, sick: 0, application: 0 }
    );
}

async function showParentsReportV4(env, chatId, messageId, month) {
    const stats = await getParentsMonthStats(env, month);
    const table = parentTable(stats);
    const totals = parentsTotals(stats);

    const text = `👨‍👩‍👦 <b>ДЛЯ РОДИТЕЛЕЙ</b>
📊 <b>${monthTitle(month)} • ГРУППА 102</b>

<pre>${escapeHtml(table)}</pre>
📅 Пропущен весь день (общая посещаемость)
❌ Пропущены отдельные пары
🚪 Ушёл раньше
⏰ Опоздал
🤒 Болеет
📝 По заявлению

📌 <b>За месяц:</b>
📅 ${totals.fullDays}  ❌ ${totals.absent}  🚪 ${totals.left}  ⏰ ${totals.late}  🤒 ${totals.sick}  📝 ${totals.application}`;

    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: [
            [
                {
                    text: "◀️",
                    callback_data: `parents_month:${shiftMonth(month, -1)}`
                },
                {
                    text: `📅 ${monthTitle(month)}`,
                    callback_data: "parents_noop"
                },
                {
                    text: "▶️",
                    callback_data: `parents_month:${shiftMonth(month, 1)}`
                }
            ],
            [
                {
                    text: "📸 Скрин родителям",
                    callback_data: `parents_shot:${month}`
                }
            ],
            [
                {
                    text: "🔎 Подробно по ученику",
                    callback_data: `parents_students:${month}`
                }
            ],
            [
                {
                    text: "🏠 Главное меню",
                    callback_data: "main"
                }
            ]
        ]
    });
};

async function showParentsScreenshot(env, chatId, messageId, month) {
    const stats = await getParentsMonthStats(env, month);
    const table = parentTable(stats);
    const totals = parentsTotals(stats);

    const text = `👨‍👩‍👦 <b>ПОСЕЩАЕМОСТЬ • ГРУППА 102</b>
📊 <b>${monthTitle(month)}</b>
━━━━━━━━━━━━━━━━━━

<pre>${escapeHtml(table)}</pre>
<b>Обозначения:</b>
📅 — пропущен весь день (общая посещаемость)
❌ — пропущены отдельные пары
🚪 — ушёл раньше
⏰ — опоздал
🤒 — болеет
📝 — по заявлению

<b>Итого за месяц:</b>
📅 ${totals.fullDays}   ❌ ${totals.absent}
🚪 ${totals.left}   ⏰ ${totals.late}   🤒 ${totals.sick}  📝 ${totals.application}`;

    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: [
            [
                {
                    text: "⬅️ К сводке",
                    callback_data: `parents_month:${month}`
                }
            ]
        ]
    });
}

async function showParentStudentV4(env, chatId, messageId, month, studentId) {
    await initLessonAttendance(env);

    const student = await env.DB.prepare(`
        SELECT id, name
        FROM students
        WHERE id = ?
    `).bind(studentId).first();

    if (!student) return;

    const pairResult = await env.DB.prepare(`
        SELECT date, lesson_no, status
        FROM lesson_attendance
        WHERE
            student_id = ?
            AND substr(date, 1, 7) = ?
            AND status IN ('absent', 'left', 'late', 'excused', 'sick', 'application')
        ORDER BY date ASC, lesson_no ASC
    `).bind(studentId, month).all();

    const fullDayResult = await env.DB.prepare(`
        SELECT a.date
        FROM attendance a
        WHERE
            a.student_id = ?
            AND substr(a.date, 1, 7) = ?
            AND a.status = 'absent'
        ORDER BY a.date ASC
    `).bind(studentId, month).all();

    const rows = pairResult.results || [];
    const fullDays = fullDayResult.results || [];

    let absent = 0, left = 0, late = 0, sick = 0, application = 0;

    for (const row of rows) {
        if (row.status === "absent") absent++;
        if (row.status === "left") left++;
        if (row.status === "late") late++;
        if (row.status === "excused" || row.status === "sick") sick++;
        if (row.status === "application") application++;
    }

    let text = `👨‍👩‍👦 <b>ДЛЯ РОДИТЕЛЕЙ</b>

👤 <b>${escapeHtml(student.name)}</b>
📅 ${monthTitle(month)}

━━━━━━━━━━━━━━
📅 Пропущено полных дней: <b>${fullDays.length}</b>
❌ Пропущено пар: <b>${absent}</b>
🚪 Ушёл раньше: <b>${left}</b>
⏰ Опозданий: <b>${late}</b>
🤒 Болеет: <b>${sick}</b>
📝 По заявлению: <b>${application}</b>
━━━━━━━━━━━━━━`;

    if (!fullDays.length && !rows.length) {
        text += `\n\n✅ Нарушений за месяц нет.`;
    } else {
        text += `\n\n📋 <b>Подробности:</b>`;

        const events = [];

        for (const row of fullDays) {
            events.push({
                date: row.date,
                lesson: 0,
                text: `📅 отсутствовал весь день`
            });
        }

        for (const row of rows) {
            let eventText = "";

            if (row.status === "absent") {
                eventText = `❌ не был на ${row.lesson_no}-й паре`;
            } else if (row.status === "left") {
                eventText = `🚪 ушёл с ${row.lesson_no}-й пары`;
            } else if (row.status === "late") {
                eventText = `⏰ опоздал на ${row.lesson_no}-ю пару`;
            } else if (row.status === "excused" || row.status === "sick") {
                eventText = `🤒 болеет, ${row.lesson_no}-я пара`;
            } else if (row.status === "application") {
                eventText = `📝 по заявлению, ${row.lesson_no}-я пара`;
            }

            events.push({
                date: row.date,
                lesson: Number(row.lesson_no || 0),
                text: eventText
            });
        }

        events.sort((a, b) =>
            String(a.date).localeCompare(String(b.date)) ||
            a.lesson - b.lesson
        );

        for (const event of events) {
            const dateText = event.date
                .split("-")
                .reverse()
                .slice(0, 2)
                .join(".");

            text += `\n${dateText} — ${event.text}`;
        }
    }

    await editOrSend(env, chatId, messageId, text, {
        inline_keyboard: [
            [
                {
                    text: "⬅️ К ученикам",
                    callback_data: `parents_students:${month}`
                }
            ],
            [
                {
                    text: "📊 Общая сводка",
                    callback_data: `parents_month:${month}`
                }
            ]
        ]
    });
};

const oldExtraCallbackParentsV2 = handleExtraCallback;

handleExtraCallback = async function(
    data,
    env,
    chatId,
    messageId,
    userId
) {
    if (data.startsWith("parents_shot:")) {
        const month = data.split(":")[1];
        await showParentsScreenshot(env, chatId, messageId, month);
        return true;
    }

    if (data === "parents") {
        await showParentsReportV4(env, chatId, messageId, currentMonth());
        return true;
    }

    if (data.startsWith("parents_month:")) {
        const month = data.split(":")[1];
        await showParentsReportV4(env, chatId, messageId, month);
        return true;
    }

    if (data.startsWith("parents_student:")) {
        const parts = data.split(":");
        const month = parts[1];
        const studentId = Number(parts[2]);
        await showParentStudentV4(env, chatId, messageId, month, studentId);
        return true;
    }

    return oldExtraCallbackParentsV2(
        data,
        env,
        chatId,
        messageId,
        userId
    );
};



const WEB_APP_HTML = "<!doctype html>\n<html lang=\"ru\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#10131a\">\n<title>Журнал группы 102</title>\n<style>\n:root{--bg:#0d1016;--panel:#151a23;--panel2:#1c2330;--text:#f5f7fb;--muted:#9da9bb;--line:#2a3445;--accent:#5b8cff;--good:#39c98a;--bad:#ff5d69;--warn:#ffbe55;--radius:18px}\n*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}\nbutton,input,select,textarea{font:inherit}.hidden{display:none!important}.muted{color:var(--muted)}.small{font-size:12px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}\n#auth{min-height:100vh;display:grid;place-items:center;padding:22px}.auth-card{width:min(440px,100%);background:var(--panel);border:1px solid var(--line);border-radius:26px;padding:24px;box-shadow:0 24px 70px #0008}.brand{display:flex;gap:14px;align-items:center;margin-bottom:22px}.logo{width:58px;height:58px;border-radius:16px;background:linear-gradient(135deg,#315fe9,#71a1ff);display:grid;place-items:center;font-size:30px}.auth-tabs{display:flex;background:var(--panel2);border-radius:14px;padding:4px;margin:16px 0}.auth-tabs button{flex:1;border:0;background:none;color:var(--muted);padding:10px;border-radius:10px}.auth-tabs button.on{background:#2a3445;color:#fff}.field{display:flex;flex-direction:column;gap:7px;margin:12px 0}.field input,.field select,.field textarea{background:#0f141d;color:#fff;border:1px solid var(--line);border-radius:12px;padding:12px}.btn{border:0;border-radius:12px;padding:11px 15px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer}.btn.secondary{background:var(--panel2);border:1px solid var(--line)}.btn.danger{background:#5b2228}.btn.ghost{background:transparent;border:1px solid var(--line)}.btn:disabled{opacity:.45}.code{font-size:38px;letter-spacing:8px;text-align:center;font-weight:900;margin:14px 0}\n#shell{min-height:100vh}.sidebar{position:fixed;inset:0 auto 0 0;width:260px;background:#10151e;border-right:1px solid var(--line);padding:18px 12px;overflow:auto;z-index:20}.side-brand{padding:8px 10px 18px;font-size:20px;font-weight:900}.navbtn{width:100%;display:flex;gap:10px;align-items:center;border:0;background:transparent;color:#c3ccda;padding:11px 12px;border-radius:12px;text-align:left;cursor:pointer;margin:2px 0}.navbtn.on,.navbtn:hover{background:var(--panel2);color:#fff}.main{margin-left:260px;min-height:100vh}.topbar{height:68px;position:sticky;top:0;z-index:10;background:#0d1016e8;backdrop-filter:blur(12px);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;padding:0 22px}.topbar h1{font-size:20px;margin:0}.spacer{flex:1}.search{max-width:320px;width:35%;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:9px 12px;color:#fff}.content{padding:22px;max-width:1500px;margin:auto}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px}.metric{font-size:30px;font-weight:900;margin-top:8px}.section-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}.section-head h2{margin:0;font-size:21px}.section-head .actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:14px}.table{width:100%;border-collapse:collapse;min-width:680px}.table th,.table td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left}.table th{color:var(--muted);font-size:12px;text-transform:uppercase;position:sticky;top:0;background:var(--panel)}.statusbtn{border:1px solid var(--line);background:#0f141d;color:#fff;border-radius:10px;padding:7px 10px;cursor:pointer;white-space:nowrap}.student{display:flex;align-items:center;gap:10px}.avatar{width:34px;height:34px;border-radius:10px;background:#26334a;display:grid;place-items:center;font-weight:800}.pill{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:4px 8px;font-size:12px}.list{display:flex;flex-direction:column;gap:8px}.list-item{display:flex;align-items:center;gap:10px;padding:11px;background:var(--panel2);border-radius:12px}.modal-bg{position:fixed;inset:0;background:#0009;z-index:50;display:grid;place-items:center;padding:18px}.modal{width:min(650px,100%);max-height:90vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:18px}.modal h3{margin-top:0}.status-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.status-grid button{padding:14px 8px}.tabs{display:flex;gap:6px;overflow:auto;margin-bottom:12px}.tabs button{white-space:nowrap}.calendar{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}.day{min-height:90px;background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:8px}.day strong{display:block}.chart{display:flex;align-items:end;gap:5px;height:160px;border-bottom:1px solid var(--line);padding:8px}.bar{flex:1;background:var(--accent);min-width:10px;border-radius:6px 6px 0 0;opacity:.85}.toast{position:fixed;right:18px;bottom:18px;background:#202939;border:1px solid var(--line);padding:12px 16px;border-radius:12px;z-index:80}.mobile-nav{display:none}\n@media(max-width:1000px){.grid{grid-template-columns:repeat(2,1fr)}.sidebar{width:220px}.main{margin-left:220px}}\n@media(max-width:760px){.sidebar{display:none}.main{margin:0}.topbar{height:58px;padding:0 12px}.topbar .search{display:none}.content{padding:12px 12px 86px}.grid{grid-template-columns:1fr 1fr;gap:9px}.card{padding:13px;border-radius:15px}.metric{font-size:25px}.mobile-nav{display:flex;position:fixed;bottom:0;left:0;right:0;background:#10151ef3;border-top:1px solid var(--line);z-index:30;padding:7px 6px max(7px,env(safe-area-inset-bottom));justify-content:space-around}.mobile-nav button{border:0;background:none;color:#aab4c4;font-size:11px;min-width:54px;flex:1;padding:4px 2px}.mobile-nav button b{display:block;font-size:21px}.mobile-nav button.on{color:#fff}.section-head{align-items:flex-start}.section-head .actions{flex-direction:column}.calendar{gap:4px}.day{min-height:72px;padding:5px;font-size:11px}.status-grid{grid-template-columns:1fr 1fr}}\n\n.perm-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}\n.perm-card{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid var(--line);border-radius:14px;background:var(--panel2);cursor:pointer;user-select:none}\n.perm-card.on{border-color:#5b8cff;background:#1e2b44}\n.perm-card input{display:none}\n.perm-icon{font-size:22px;width:28px;text-align:center}\n.perm-text{display:flex;flex-direction:column;gap:2px}\n.perm-text b{font-size:14px}\n.perm-text span{font-size:11px;color:var(--muted)}\n@media(max-width:760px){.perm-grid{grid-template-columns:1fr}}\n\n</style>\n<script src=\"https://telegram.org/js/telegram-web-app.js\"></script>\n</head>\n<body>\n<div id=\"auth\">\n  <div class=\"auth-card\">\n    <div class=\"brand\"><div class=\"logo\">📚</div><div><h2 style=\"margin:0\">Журнал группы 102</h2><div class=\"muted\">Закрытая система преподавателя</div></div></div>\n    <div id=\"tgAuto\" class=\"muted small\">Из Telegram вход выполняется автоматически. При прямом открытии сайта — только логин и пароль.</div>\n    <form id=\"passPane\">\n      <div class=\"field\"><label>Логин</label><input id=\"login\" autocomplete=\"username\"></div>\n      <div class=\"field\"><label>Пароль</label><input id=\"password\" type=\"password\" autocomplete=\"current-password\"></div>\n      <button class=\"btn\" style=\"width:100%\">Войти</button>\n    </form>\n    <div class=\"small muted\" style=\"margin-top:12px\">🔒 Самостоятельной регистрации нет. Доступ создаёт владелец.</div>\n    <div id=\"authMsg\" class=\"small\" style=\"margin-top:12px;color:#ffbe55\"></div>\n  </div>\n</div>\n\n<div id=\"shell\" class=\"hidden\">\n  <aside class=\"sidebar\">\n    <div class=\"side-brand\">📚 Журнал 102</div>\n    <div id=\"sideNav\"></div>\n  </aside>\n  <main class=\"main\">\n    <div class=\"topbar\"><h1 id=\"pageTitle\">Главная</h1><div class=\"spacer\"></div><input class=\"search\" id=\"globalSearch\" placeholder=\"🔎 Поиск\"><button class=\"btn secondary\" id=\"logout\">Выйти</button></div>\n    <div class=\"content\" id=\"content\"></div>\n  </main>\n  <div class=\"mobile-nav\" id=\"mobileNav\"></div>\n</div>\n<div id=\"modalRoot\"></div>\n<script>\n(function(){\nvar state={me:null,page:'dashboard',students:[],date:new Date().toISOString().slice(0,10),month:new Date().toISOString().slice(0,7)};\nvar nav=[\n ['dashboard','🏠','Главная'],['journal','👥','Журнал'],['pairs','📚','По парам'],['students','👤','Студенты'],\n ['calendar','📅','Календарь'],['health','🤒','Болезни и заявления'],['duty','🧹','Дежурство'],\n ['schedule','🗓️','Расписание'],['parents','👨‍👩‍👦','Родителям'],['analytics','📊','Аналитика'],\n ['reports','📄','Отчёты'],['online','🟢','Онлайн'],['users','👥','Пользователи'],\n ['audit','🛡','Журнал действий'],['settings','⚙️','Настройки']\n];\nvar statusOrder=['none','present','absent','late','sick','application','left'];\nvar statusMeta={none:['➖','Не отмечено'],present:['✅','Присутствует'],absent:['❌','Отсутствует'],late:['⏰','Опоздал'],sick:['🤒','Болеет'],application:['📝','По заявлению'],left:['🚪','Ушёл раньше'],excused:['🤒','Болеет']};\nfunction esc(x){return String(x==null?'':x).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]})}\nasync function api(path,opt){opt=opt||{};opt.headers=Object.assign({'content-type':'application/json'},opt.headers||{});var r=await fetch(path,opt);var ct=r.headers.get('content-type')||'';if(r.status===401){showAuth();throw new Error('Нужен вход')}if(!r.ok){var e=ct.includes('json')?await r.json():{error:await r.text()};throw new Error(e.error||'Ошибка')}return ct.includes('json')?r.json():r}\nfunction toast(t){var d=document.createElement('div');d.className='toast';d.textContent=t;document.body.appendChild(d);setTimeout(function(){d.remove()},2200)}\nfunction fmtDate(d){try{return new Date(d+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'})}catch(e){return d}}\nfunction showAuth(){document.getElementById('auth').classList.remove('hidden');document.getElementById('shell').classList.add('hidden')}\nfunction showShell(){document.getElementById('auth').classList.add('hidden');document.getElementById('shell').classList.remove('hidden');renderNav();go('dashboard')}\nfunction renderNav(){var html='';nav.forEach(function(n){if((n[0]==='users'||n[0]==='audit'||n[0]==='settings')&&state.me.role!=='owner')return;html+='<button class=\"navbtn '+(state.page===n[0]?'on':'')+'\" data-p=\"'+n[0]+'\"><span>'+n[1]+'</span>'+n[2]+'</button>'});document.getElementById('sideNav').innerHTML=html;document.querySelectorAll('.navbtn').forEach(function(b){b.onclick=function(){go(b.dataset.p)}});var mobileMain=nav.filter(function(n){return ['dashboard','journal','pairs','students'].includes(n[0])}).map(function(n){return '<button data-p=\"'+n[0]+'\" class=\"'+(state.page===n[0]?'on':'')+'\"><b>'+n[1]+'</b>'+n[2]+'</button>'}).join('');\nvar moreActive=['calendar','health','duty','schedule','parents','analytics','reports','online','users','audit','settings'].includes(state.page);\nmobileMain+='<button id=\"mobileMore\" class=\"'+(moreActive?'on':'')+'\"><b>☰</b>Ещё</button>';\ndocument.getElementById('mobileNav').innerHTML=mobileMain;\ndocument.querySelectorAll('#mobileNav [data-p]').forEach(function(b){b.onclick=function(){go(b.dataset.p)}});\nvar mb=document.getElementById('mobileMore');if(mb)mb.onclick=openMoreMenu}\nasync function go(p){state.page=p;renderNav();var n=nav.find(function(x){return x[0]===p});document.getElementById('pageTitle').textContent=n?n[2]:'';var c=document.getElementById('content');c.innerHTML='<div class=\"card\">Загрузка…</div>';try{var fn=pages[p]||pages.dashboard;await fn(c)}catch(e){c.innerHTML='<div class=\"card\">⚠️ '+esc(e.message)+'</div>'}}\nfunction metric(label,val,sub){return '<div class=\"card\"><div class=\"muted\">'+label+'</div><div class=\"metric\">'+val+'</div><div class=\"small muted\">'+(sub||'')+'</div></div>'}\nasync function loadStudents(){state.students=(await api('/api/students')).students;return state.students}\nfunction studentName(id){var s=state.students.find(function(x){return Number(x.id)===Number(id)});return s?s.name:'#'+id}\nfunction statusButton(st,id,kind,date,lesson){var m=statusMeta[st]||statusMeta.none;return '<button class=\"statusbtn\" data-kind=\"'+kind+'\" data-id=\"'+id+'\" data-status=\"'+st+'\" data-date=\"'+date+'\" '+(lesson?'data-lesson=\"'+lesson+'\"':'')+'>'+m[0]+' '+m[1]+'</button>'}\nfunction bindStatusButtons(){document.querySelectorAll('.statusbtn').forEach(function(b){b.onclick=function(){openStatus(b.dataset.kind,b.dataset.id,b.dataset.date,b.dataset.lesson)}})}\nfunction openStatus(kind,id,date,lesson){var buttons=statusOrder.map(function(st){var m=statusMeta[st];return '<button class=\"btn secondary\" data-st=\"'+st+'\">'+m[0]+' '+m[1]+'</button>'}).join('');modal('<h3>'+esc(studentName(id))+'</h3><div class=\"status-grid\">'+buttons+'</div>');document.querySelectorAll('#modalRoot [data-st]').forEach(function(b){b.onclick=async function(){await api(kind==='pair'?'/api/pairs':'/api/attendance',{method:'POST',body:JSON.stringify({student_id:Number(id),date:date,lesson_no:lesson?Number(lesson):undefined,status:b.dataset.st})});closeModal();toast('Сохранено');go(state.page)}})}\nfunction modal(html){document.getElementById('modalRoot').innerHTML='<div class=\"modal-bg\"><div class=\"modal\">'+html+'<div style=\"margin-top:14px\"><button class=\"btn ghost\" id=\"closeModal\">Закрыть</button></div></div></div>';document.getElementById('closeModal').onclick=closeModal}\nfunction closeModal(){document.getElementById('modalRoot').innerHTML=''}\n\n\nfunction openMoreMenu(){\n  var allowed=nav.filter(function(n){\n    if(['dashboard','journal','pairs','students'].includes(n[0])) return false;\n    if((n[0]==='users'||n[0]==='audit'||n[0]==='settings')&&state.me.role!=='owner') return false;\n    return true;\n  });\n  modal('<h3>☰ Ещё</h3><div class=\"list\">'+allowed.map(function(n){\n    return '<button class=\"list-item\" style=\"width:100%;border:0;color:inherit;text-align:left;cursor:pointer\" data-more=\"'+n[0]+'\"><span style=\"font-size:22px\">'+n[1]+'</span><b>'+n[2]+'</b></button>';\n  }).join('')+'</div>');\n  document.querySelectorAll('[data-more]').forEach(function(b){b.onclick=function(){var p=b.dataset.more;closeModal();go(p)}});\n}\nvar pages={};\npages.dashboard=async function(c){var d=await api('/api/dashboard');c.innerHTML='<div class=\"grid\">'+metric('👥 Учеников',d.students)+metric('❌ Нет сегодня',d.absent)+metric('🤒 Болеют',d.sick)+metric('📝 По заявлению',d.application)+'</div><div class=\"grid\" style=\"margin-top:14px;grid-template-columns:2fr 1fr\"><div class=\"card\"><div class=\"section-head\"><h2>Сегодня</h2></div><div class=\"list\">'+(d.today.map(function(x){return '<div class=\"list-item\"><div>'+x.icon+'</div><div><b>'+esc(x.name)+'</b><div class=\"muted small\">'+esc(x.text)+'</div></div></div>'}).join('')||'<div class=\"muted\">Событий нет</div>')+'</div></div><div class=\"card\"><h2 style=\"margin-top:0\">🧹 Дежурные</h2><div>'+((d.duty||[]).map(function(x){return '<div class=\"pill\" style=\"margin:3px\">'+esc(x.name)+'</div>'}).join('')||'<span class=\"muted\">Не назначены</span>')+'</div></div></div>'}\npages.journal=async function(c){await loadStudents();var d=await api('/api/attendance?date='+state.date);var rows=state.students.map(function(s){var st=d.statuses[String(s.id)]||'none';return '<tr><td><div class=\"student\"><div class=\"avatar\">'+esc(s.name[0])+'</div><b>'+esc(s.name)+'</b></div></td><td>'+statusButton(st,s.id,'day',state.date)+'</td></tr>'}).join('');c.innerHTML='<div class=\"section-head\"><h2>👥 Посещаемость</h2><div class=\"actions\"><input type=\"date\" id=\"journalDate\" value=\"'+state.date+'\"><button class=\"btn secondary\" id=\"allPresent\">✅ Все есть</button></div></div><div class=\"table-wrap\"><table class=\"table\"><thead><tr><th>Ученик</th><th>Статус</th></tr></thead><tbody>'+rows+'</tbody></table></div>';document.getElementById('journalDate').onchange=function(){state.date=this.value;go('journal')};document.getElementById('allPresent').onclick=async function(){await api('/api/attendance/all-present',{method:'POST',body:JSON.stringify({date:state.date})});toast('Все отмечены');go('journal')};bindStatusButtons()}\npages.pairs=async function(c){await loadStudents();var d=await api('/api/pairs?date='+state.date);var lessons=d.lessons||4;var head='<th>Ученик</th>';for(var l=1;l<=lessons;l++)head+='<th>'+l+' пара</th>';var rows=state.students.map(function(s){var t='<tr><td><b>'+esc(s.name)+'</b></td>';for(var l=1;l<=lessons;l++){var st=(d.statuses[String(l)]||{})[String(s.id)]||'none';t+='<td>'+statusButton(st,s.id,'pair',state.date,l)+'</td>'}return t+'</tr>'}).join('');c.innerHTML='<div class=\"section-head\"><h2>📚 По парам</h2><div class=\"actions\"><input type=\"date\" id=\"pairDate\" value=\"'+state.date+'\"></div></div><div class=\"table-wrap\"><table class=\"table\"><thead><tr>'+head+'</tr></thead><tbody>'+rows+'</tbody></table></div>';document.getElementById('pairDate').onchange=function(){state.date=this.value;go('pairs')};bindStatusButtons()}\npages.students=async function(c){await loadStudents();c.innerHTML='<div class=\"section-head\"><h2>👤 Студенты</h2><div class=\"actions\"><button class=\"btn\" id=\"addStudent\">+ Добавить</button></div></div><div class=\"list\">'+state.students.map(function(s){return '<div class=\"list-item\"><div class=\"avatar\">'+esc(s.name[0])+'</div><div style=\"flex:1\"><b>'+esc(s.name)+'</b></div><button class=\"btn secondary\" data-card=\"'+s.id+'\">Карточка</button></div>'}).join('')+'</div>';document.getElementById('addStudent').onclick=function(){modal('<h3>Новый ученик</h3><div class=\"field\"><input id=\"newStudent\" placeholder=\"Фамилия Имя\"></div><button class=\"btn\" id=\"saveStudent\">Добавить</button>');document.getElementById('saveStudent').onclick=async function(){await api('/api/students',{method:'POST',body:JSON.stringify({name:document.getElementById('newStudent').value})});closeModal();toast('Добавлен');go('students')}};document.querySelectorAll('[data-card]').forEach(function(b){b.onclick=async function(){var d=await api('/api/student/'+b.dataset.card);modal('<h3>'+esc(d.student.name)+'</h3><div class=\"grid\">'+metric('Посещаемость',d.attendance_percent+'%')+metric('❌ Пропуски',d.absent)+metric('🤒 Болеет',d.sick)+metric('📝 Заявления',d.application)+'</div><h3>Последние события</h3><div class=\"list\">'+d.events.map(function(e){var sm=statusMeta[e.status]||['',''];var label=e.summary_label||((sm[0]+' '+sm[1]).trim());return '<div class=\"list-item\"><b>'+esc(e.date)+'</b><div class=\"small muted\">'+esc(label)+'</div></div>'}).join('')+'</div>')}})}\npages.calendar=async function(c){var d=await api('/api/calendar?month='+state.month);var first=new Date(state.month+'-01T12:00:00'),start=(first.getDay()+6)%7,days=new Date(first.getFullYear(),first.getMonth()+1,0).getDate(),cells='';for(var i=0;i<start;i++)cells+='<div></div>';for(var x=1;x<=days;x++){var ds=state.month+'-'+String(x).padStart(2,'0'),q=d.days[ds]||{};cells+='<div class=\"day\"><strong>'+x+'</strong><div>❌ '+(q.absent||0)+'</div><div>🤒 '+(q.sick||0)+' · 📝 '+(q.application||0)+'</div><div>↔️ '+(q.partial||0)+' частично</div></div>'}c.innerHTML='<div class=\"section-head\"><h2>📅 Календарь</h2><div class=\"actions\"><input type=\"month\" id=\"calMonth\" value=\"'+state.month+'\"></div></div><div class=\"calendar\">'+cells+'</div>';document.getElementById('calMonth').onchange=function(){state.month=this.value;go('calendar')}}\npages.health=async function(c){var d=await api('/api/health?month='+state.month);c.innerHTML='<div class=\"section-head\"><h2>🤒 Болезни и заявления</h2><div class=\"actions\"><input type=\"month\" id=\"healthMonth\" value=\"'+state.month+'\"></div></div><div class=\"grid\">'+metric('🤒 Болезни',d.sick_total)+metric('📝 Заявления',d.application_total)+'</div><div class=\"card\" style=\"margin-top:14px\"><div class=\"list\">'+d.rows.map(function(x){return '<div class=\"list-item\"><b style=\"flex:1\">'+esc(x.name)+'</b><span class=\"pill\">🤒 '+x.sick+'</span><span class=\"pill\">📝 '+x.application+'</span></div>'}).join('')+'</div></div>';document.getElementById('healthMonth').onchange=function(){state.month=this.value;go('health')}}\npages.duty=async function(c){await loadStudents();var d=await api('/api/duty?date='+state.date);var chosen=new Set((d.students||[]).map(function(x){return Number(x.id)}));c.innerHTML='<div class=\"section-head\"><h2>🧹 Дежурство</h2><div class=\"actions\"><input type=\"date\" id=\"dutyDate\" value=\"'+state.date+'\"></div></div><div class=\"card\"><div class=\"list\">'+state.students.map(function(s){return '<label class=\"list-item\"><input type=\"checkbox\" data-duty=\"'+s.id+'\" '+(chosen.has(Number(s.id))?'checked':'')+'><span>'+esc(s.name)+'</span></label>'}).join('')+'</div><button class=\"btn\" id=\"saveDuty\" style=\"margin-top:12px\">Сохранить</button></div>';document.getElementById('dutyDate').onchange=function(){state.date=this.value;go('duty')};document.getElementById('saveDuty').onclick=async function(){var ids=[].slice.call(document.querySelectorAll('[data-duty]:checked')).map(function(x){return Number(x.dataset.duty)});await api('/api/duty',{method:'POST',body:JSON.stringify({date:state.date,student_ids:ids})});toast('Сохранено')}}\npages.schedule=async function(c){var d=await api('/api/schedule');var days=['Понедельник','Вторник','Среда','Четверг','Пятница'];c.innerHTML='<div class=\"section-head\"><h2>🗓️ Расписание</h2><div class=\"actions\">'+(state.me.role==='owner'?'<button class=\"btn\" id=\"editSchedule\">Редактировать</button>':'')+'</div></div>'+days.map(function(day,i){var arr=d.days[String(i+1)]||[];return '<div class=\"card\" style=\"margin-bottom:10px\"><b>'+day+'</b><div class=\"list\" style=\"margin-top:10px\">'+arr.map(function(x){return '<div class=\"list-item\"><span class=\"pill\">'+x.lesson_no+'</span><div><b>'+esc(x.subject)+'</b><div class=\"small muted\">'+esc(x.time||'')+(x.teacher?' · '+esc(x.teacher):'')+(x.room?' · каб. '+esc(x.room):'')+'</div></div></div>'}).join('')+'</div></div>'}).join('');var eb=document.getElementById('editSchedule');if(eb)eb.onclick=function(){modal('<h3>Редактирование расписания</h3><p class=\"muted\">В этой версии расписание редактируется через таблицу: выберите день и пару, затем сохраните.</p><div class=\"field\"><select id=\"schDay\">'+days.map(function(x,i){return '<option value=\"'+(i+1)+'\">'+x+'</option>'}).join('')+'</select></div><div class=\"field\"><input id=\"schLesson\" type=\"number\" min=\"1\" max=\"8\" placeholder=\"Номер пары\"></div><div class=\"field\"><input id=\"schSubject\" placeholder=\"Предмет\"></div><div class=\"field\"><input id=\"schTime\" placeholder=\"08:30–09:50\"></div><div class=\"field\"><input id=\"schTeacher\" placeholder=\"Преподаватель\"></div><div class=\"field\"><input id=\"schRoom\" placeholder=\"Кабинет\"></div><button class=\"btn\" id=\"saveSch\">Сохранить</button>');document.getElementById('saveSch').onclick=async function(){await api('/api/schedule',{method:'POST',body:JSON.stringify({weekday:Number(document.getElementById('schDay').value),lesson_no:Number(document.getElementById('schLesson').value),subject:document.getElementById('schSubject').value,time:document.getElementById('schTime').value,teacher:document.getElementById('schTeacher').value,room:document.getElementById('schRoom').value})});closeModal();toast('Расписание сохранено');go('schedule')}}}\npages.parents=async function(c){await loadStudents();var d=await api('/api/parents?month='+state.month);var rows=d.rows.map(function(x){return '<tr><td><b>'+esc(x.name)+'</b></td><td>'+x.full_days+'</td><td>'+x.absent+'</td><td>'+x.left+'</td><td>'+x.late+'</td><td>'+x.sick+'</td><td>'+x.application+'</td></tr>'}).join('');c.innerHTML='<div class=\"section-head\"><h2>👨‍👩‍👦 Для родителей</h2><div class=\"actions\"><input type=\"month\" id=\"parentMonth\" value=\"'+state.month+'\"><button class=\"btn secondary\" onclick=\"window.print()\">🖨️ Печать / PDF</button></div></div><div class=\"table-wrap\"><table class=\"table\"><thead><tr><th>Ученик</th><th>📅 День</th><th>❌ Пары</th><th>🚪</th><th>⏰</th><th>🤒</th><th>📝</th></tr></thead><tbody>'+rows+'</tbody></table></div>';document.getElementById('parentMonth').onchange=function(){state.month=this.value;go('parents')}}\npages.analytics=async function(c){var d=await api('/api/stats?month='+state.month);var max=Math.max.apply(null,d.rows.map(function(x){return x.absent+x.sick+x.application}).concat([1]));c.innerHTML='<div class=\"section-head\"><h2>📊 Аналитика</h2><div class=\"actions\"><input type=\"month\" id=\"statMonth\" value=\"'+state.month+'\"></div></div><div class=\"grid\">'+metric('Средняя посещаемость',d.group_percent+'%')+metric('❌ Пропусков',d.total_absent)+metric('🤒 Болезней',d.total_sick)+metric('📝 Заявлений',d.total_application)+metric('↔️ Частичных дней',d.total_partial||0)+'</div><div class=\"card\" style=\"margin-top:14px\"><h3>Нагрузка по ученикам</h3><div class=\"chart\">'+d.rows.map(function(x){var v=x.absent+x.sick+x.application;return '<div class=\"bar\" title=\"'+esc(x.name)+': '+v+'\" style=\"height:'+Math.max(3,Math.round(v/max*100))+'%\"></div>'}).join('')+'</div></div>';document.getElementById('statMonth').onchange=function(){state.month=this.value;go('analytics')}}\npages.reports=async function(c){c.innerHTML='<div class=\"section-head\"><h2>📄 Отчёты и резервные копии</h2></div><div class=\"grid\"><div class=\"card\"><h3>Excel</h3><p class=\"muted\">Полная посещаемость и сводка.</p><a class=\"btn\" style=\"display:inline-block;text-decoration:none\" href=\"/api/report.xlsx?period=all\">Скачать .xlsx</a></div><div class=\"card\"><h3>CSV</h3><p class=\"muted\">Универсальный экспорт данных.</p><a class=\"btn secondary\" style=\"display:inline-block;text-decoration:none\" href=\"/api/export.csv\">Скачать .csv</a></div><div class=\"card\"><h3>Backup JSON</h3><p class=\"muted\">Студенты, посещаемость, пары, дежурства.</p><a class=\"btn secondary\" style=\"display:inline-block;text-decoration:none\" href=\"/api/backup\">Скачать backup</a></div></div>'}\npages.online=async function(c){var d=await api('/api/online');c.innerHTML='<div class=\"section-head\"><h2>🟢 Кто в системе</h2></div><div class=\"list\">'+d.users.map(function(u){return '<div class=\"list-item\"><span>'+(u.online?'🟢':'⚪')+'</span><div><b>'+esc(u.display_name||u.login||u.telegram_user_id)+'</b><div class=\"small muted\">'+esc(u.last_seen||'нет активности')+'</div></div></div>'}).join('')+'</div>'}\npages.users=async function(c){\nvar d=await api('/api/admin/accounts');\nvar perms=[\n ['view_journal','👁️','Просмотр журнала','Можно смотреть журнал и данные'],\n ['edit_attendance','✏️','Посещаемость','Можно менять статусы и пары'],\n ['edit_students','🎓','Ученики','Добавление и изменение учеников'],\n ['edit_duty','🧹','Дежурство','Управление дежурными'],\n ['edit_schedule','📚','Расписание','Изменение расписания'],\n ['reports','📊','Отчёты','Статистика, экспорт и отчёты'],\n ['manage_users','👥','Пользователи','Управление доступами'],\n ['settings','⚙️','Настройки','Изменение системных настроек']\n];\nc.innerHTML='<div class=\"section-head\"><h2>👥 Пользователи и доступ</h2><div class=\"actions\"><button class=\"btn\" id=\"newAccount\">+ Создать пользователя</button></div></div>'+\n'<div class=\"card\" style=\"margin-bottom:12px\"><b>🔒 Закрытая система</b><div class=\"muted small\">Пользователей создаёт только владелец. Самостоятельной регистрации нет.</div></div>'+\n'<div class=\"list\">'+d.accounts.map(function(u){\n return '<div class=\"list-item\"><div style=\"flex:1\"><b>'+esc(u.display_name||u.login||u.telegram_user_id||'Аккаунт')+'</b>'+\n '<div class=\"small muted\">'+esc(u.login||'без логина')+' · '+esc(u.role)+' · '+(Number(u.enabled)?'активен':'отключён')+\n (u.telegram_user_id?' · TG '+esc(u.telegram_user_id):'')+'</div></div>'+\n (u.role!=='owner'?'<button class=\"btn secondary\" data-toggle=\"'+u.id+'\" data-enabled=\"'+Number(u.enabled)+'\">'+(Number(u.enabled)?'Отключить':'Включить')+'</button>':'<span class=\"pill\">👑 Владелец</span>')+\n '</div>';\n}).join('')+'</div>';\n\ndocument.getElementById('newAccount').onclick=function(){\n modal('<h3>Создать пользователя</h3>'+\n '<div class=\"field\"><label>Имя</label><input id=\"accName\" placeholder=\"Например: Классный руководитель\"></div>'+\n '<div class=\"field\"><label>Логин</label><input id=\"accLogin\" autocomplete=\"off\" placeholder=\"teacher102\"><div class=\"small muted\">От 3 символов. Можно латиницу, цифры, . _ -</div></div>'+\n '<div class=\"field\"><label>Пароль</label><div style=\"display:flex;gap:7px\"><input style=\"flex:1\" id=\"accPass\" type=\"text\" autocomplete=\"off\" placeholder=\"Минимум 8 символов\"><button type=\"button\" class=\"btn secondary\" id=\"genPass\">🎲</button></div></div>'+\n '<div class=\"field\"><label>Telegram ID — необязательно</label><input id=\"accTg\" inputmode=\"numeric\" placeholder=\"Для автовхода из Telegram\"></div>'+\n '<div class=\"field\"><label>Роль</label><select id=\"accRole\"><option value=\"teacher\">Преподаватель</option><option value=\"viewer\">Только просмотр</option></select></div>'+\n '<div><b>Права доступа</b><div class=\"small muted\" style=\"margin-top:4px\">Нажми на нужные пункты — выбранные подсвечиваются.</div><div class=\"perm-grid\">'+perms.map(function(p){var checked=['view_journal','edit_attendance','edit_duty','reports'].includes(p[0]);return '<label class=\"perm-card '+(checked?'on':'')+'\"><input type=\"checkbox\" data-perm=\"'+p[0]+'\" '+(checked?'checked':'')+'><span class=\"perm-icon\">'+p[1]+'</span><span class=\"perm-text\"><b>'+p[2]+'</b><span>'+p[3]+'</span></span></label>'}).join('')+'</div></div>'+\n '<div id=\"accError\" class=\"small\" style=\"color:#ffbe55;margin-top:10px\"></div>'+\n '<button class=\"btn\" id=\"saveAcc\" style=\"margin-top:12px;width:100%\">Создать пользователя</button>');\n\n document.querySelectorAll('.perm-card input').forEach(function(ch){\n   ch.onchange=function(){ch.closest('.perm-card').classList.toggle('on',ch.checked)}\n });\n document.getElementById('genPass').onclick=function(){\n   var chars='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';\n   var arr=new Uint32Array(14);crypto.getRandomValues(arr);\n   document.getElementById('accPass').value=Array.from(arr,function(x){return chars[x%chars.length]}).join('');\n };\n\n document.getElementById('saveAcc').onclick=async function(){\n   var btn=this, err=document.getElementById('accError');\n   err.textContent='';\n   var login=document.getElementById('accLogin').value.trim();\n   var password=document.getElementById('accPass').value;\n   var tg=document.getElementById('accTg').value.trim();\n\n   if(!/^[A-Za-z0-9_.-]{3,40}$/.test(login)){\n     err.textContent='⚠️ Логин: минимум 3 символа, латиница/цифры/._-';\n     return;\n   }\n   if(password.length<8){\n     err.textContent='⚠️ Пароль должен быть минимум 8 символов.';\n     return;\n   }\n   if(tg && !/^\\d{5,20}$/.test(tg)){\n     err.textContent='⚠️ Telegram ID должен состоять только из цифр.';\n     return;\n   }\n\n   var ps=[].slice.call(document.querySelectorAll('[data-perm]:checked')).map(function(x){return x.dataset.perm});\n   btn.disabled=true; btn.textContent='Создаю…';\n   try{\n     var r=await api('/api/admin/accounts',{\n       method:'POST',\n       body:JSON.stringify({\n         display_name:document.getElementById('accName').value.trim(),\n         login:login,password:password,telegram_user_id:tg,\n         role:document.getElementById('accRole').value,permissions:ps\n       })\n     });\n     closeModal();\n     await go('users');\n     modal('<h3>✅ Пользователь создан</h3>'+\n       '<p>Передай ему эти данные для входа через браузер:</p>'+\n       '<div class=\"card mono\" style=\"font-size:16px;line-height:1.8\">Логин: <b>'+esc(r.login)+'</b><br>Пароль: <b>'+esc(r.password)+'</b></div>'+\n       '<p class=\"small muted\">Пароль в базе хранится только в виде защищённого хеша.</p>');\n   }catch(e){\n     err.textContent='⚠️ '+e.message;\n     btn.disabled=false; btn.textContent='Создать пользователя';\n   }\n };\n};\n\ndocument.querySelectorAll('[data-toggle]').forEach(function(b){\n b.onclick=async function(){\n   try{\n     await api('/api/admin/accounts/toggle',{method:'POST',body:JSON.stringify({id:Number(b.dataset.toggle),enabled:b.dataset.enabled!=='1'})});\n     toast('Доступ изменён');go('users');\n   }catch(e){toast(e.message)}\n };\n});\n}\npages.audit=async function(c){var d=await api('/api/audit');c.innerHTML='<div class=\"section-head\"><h2>🛡 Журнал действий</h2></div><div class=\"table-wrap\"><table class=\"table\"><thead><tr><th>Время</th><th>Кто</th><th>Действие</th><th>Детали</th></tr></thead><tbody>'+d.rows.map(function(x){return '<tr><td>'+esc(x.created_at)+'</td><td>'+esc(x.actor_user_id||'system')+'</td><td>'+esc(x.action)+'</td><td>'+esc(x.details||'')+'</td></tr>'}).join('')+'</tbody></table></div>'}\npages.settings=async function(c){var d=await api('/api/settings');c.innerHTML='<div class=\"section-head\"><h2>⚙️ Настройки</h2></div><div class=\"card\"><div class=\"field\"><label>Название группы</label><input id=\"groupName\" value=\"'+esc(d.group_name||'Группа 102')+'\"></div><div class=\"field\"><label>Часовой пояс</label><input id=\"tz\" value=\"'+esc(d.timezone||'Europe/Chisinau')+'\"></div><button class=\"btn\" id=\"saveSettings\">Сохранить</button></div>';document.getElementById('saveSettings').onclick=async function(){await api('/api/settings',{method:'POST',body:JSON.stringify({group_name:document.getElementById('groupName').value,timezone:document.getElementById('tz').value})});toast('Настройки сохранены')}}\ndocument.getElementById('logout').onclick=async function(){\n  await api('/api/logout',{method:'POST',body:'{}'});\n  var tg=window.Telegram&&window.Telegram.WebApp;\n  if(tg&&tg.initData){\n    try{tg.close();return}catch(e){}\n  }\n  location.reload();\n};\ndocument.getElementById('passPane').onsubmit=async function(e){e.preventDefault();try{await api('/api/auth/password',{method:'POST',body:JSON.stringify({login:document.getElementById('login').value,password:document.getElementById('password').value})});await boot()}catch(err){document.getElementById('authMsg').textContent=err.message}};\ndocument.getElementById('globalSearch').onkeydown=async function(e){if(e.key!=='Enter')return;var q=this.value.trim();if(!q)return;var d=await api('/api/search?q='+encodeURIComponent(q));modal('<h3>🔎 Поиск</h3><div class=\"list\">'+d.results.map(function(x){return '<div class=\"list-item\"><b>'+esc(x.title)+'</b><span class=\"muted\">'+esc(x.subtitle||'')+'</span></div>'}).join('')+'</div>')};\nasync function boot(){\n  var tg=window.Telegram&&window.Telegram.WebApp;\n\n  // В Telegram всегда сначала подтверждаем initData и создаём/обновляем веб-сессию.\n  // Поэтому после выхода и нового открытия кнопки автовход снова работает.\n  if(tg&&tg.initData){\n    try{\n      tg.ready();\n      tg.expand();\n      await api('/api/auth/telegram',{\n        method:'POST',\n        body:JSON.stringify({initData:tg.initData})\n      });\n      state.me=await api('/api/me');\n      showShell();\n      return;\n    }catch(err){\n      showAuth();\n      document.getElementById('authMsg').textContent=err.message;\n      document.getElementById('tgAuto').textContent='🔒 Автовход Telegram не разрешён для этого аккаунта.';\n      return;\n    }\n  }\n\n  // Обычный браузер: используем сохранённую cookie-сессию, иначе показываем логин/пароль.\n  try{\n    state.me=await api('/api/me');\n    showShell();\n  }catch(e){\n    showAuth();\n    document.getElementById('tgAuto').textContent='Прямой вход: используйте логин и пароль.';\n  }\n}\nboot();\n})();\n</script>\n</body>\n</html>";

async function ensureColumn(env, table, column, sqlType) {
    const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    if (!(info.results || []).some(r => r.name === column)) {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`).run();
    }
}

async function initWebDb(env) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`).run();

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS web_login_codes (
        code TEXT PRIMARY KEY,
        browser_token TEXT NOT NULL,
        telegram_user_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approved_at TEXT
    )`).run();

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS schedule_lessons (
        weekday INTEGER NOT NULL,
        lesson_no INTEGER NOT NULL,
        subject TEXT NOT NULL,
        time TEXT,
        teacher TEXT,
        room TEXT,
        PRIMARY KEY(weekday, lesson_no)
    )`).run();

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS student_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL
    )`).run();

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT,
        created_at TEXT NOT NULL,
        read_at TEXT
    )`).run();

    await ensureColumn(env, "web_accounts", "display_name", "TEXT");
    await ensureColumn(env, "web_accounts", "password_salt", "TEXT");
    await ensureColumn(env, "web_accounts", "permissions_json", "TEXT");

    const ownerId = String(env.ADMIN_ID || "");
    if (ownerId) {
        await env.DB.prepare(`
            INSERT OR IGNORE INTO web_accounts(
                telegram_user_id, role, enabled, created_at, display_name
            ) VALUES(?, 'owner', 1, ?, 'Владелец')
        `).bind(ownerId, new Date().toISOString()).run();
        await env.DB.prepare(`
            UPDATE web_accounts SET role='owner', enabled=1
            WHERE telegram_user_id=?
        `).bind(ownerId).run();
    }

    const scheduleCount = await env.DB.prepare("SELECT COUNT(*) AS c FROM schedule_lessons").first();
    if (Number(scheduleCount?.c || 0) === 0) {
        const rows = [
            [1,1,"Родной (русский) язык","08:30–09:50","Силаева М.К.","107"],
            [1,2,"Математика","10:00–11:20","Савва Т.А.","201"],
            [1,3,"Физика","12:00–13:20","Холошной П.В.","206"],
            [2,1,"Математика","08:30–09:50","Савва Т.А.","201"],
            [2,2,"Иностранный язык","10:00–11:20","","303/29"],
            [2,3,"Физика","12:00–13:20","Холошной П.В.","206"],
            [2,4,"Литература / Официальный язык","13:30–14:50","","32/11/113"],
            [3,1,"Химия","08:30–09:50","Клименко Н.Н.","301"],
            [3,2,"Математика","10:00–11:20","Савва Т.А.","201"],
            [3,3,"НВП / Биология","12:00–13:20","","101/301"],
            [3,4,"Физическая культура","13:30–14:50","Пасисниченко А.И.",""],
            [4,1,"Слесарное дело и технические измерения","08:30–09:50","Мизернюк И.Я.","110"],
            [4,2,"Устройство автотранспортных средств","10:00–11:20","Петренко А.А.","306"],
            [4,3,"Охрана труда","12:00–13:20","Главацкая С.Ю.","307"],
            [5,1,"Математика","08:30–09:50","Савва Т.А.","201"],
            [5,2,"Физика","10:00–11:20","Холошной П.В.","206"],
            [5,3,"Информатика и ИКТ","12:00–13:20","Шандригоз Н.Н.","305"],
            [5,4,"Материаловедение","13:30–14:50","Петренко А.А.","306"]
        ];
        for (const r of rows) {
            await env.DB.prepare(`INSERT OR IGNORE INTO schedule_lessons
                (weekday,lesson_no,subject,time,teacher,room) VALUES(?,?,?,?,?,?)`)
                .bind(...r).run();
        }
    }
}

const initDbBeforeWeb = initDb;
initDb = async function(env) {
    await initDbBeforeWeb(env);
    await initWebDb(env);
};

async function rememberWebOrigin(env, origin) {
    if (!origin || !origin.startsWith("https://")) return;
    await env.DB.prepare(`INSERT INTO app_settings(key,value) VALUES('web_origin',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(origin).run();
}

async function getWebAppUrl(env) {
    const r = await env.DB.prepare(`SELECT value FROM app_settings WHERE key='web_origin'`).first();
    return (r?.value || "https://example.com") + "/app";
}

function jsonResponse(data, status=200, extraHeaders={}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json; charset=UTF-8",
            "cache-control": "no-store",
            ...extraHeaders
        }
    });
}

function cookieValue(request, name) {
    const c = request.headers.get("cookie") || "";
    const m = c.match(new RegExp("(?:^|;\\\\s*)" + name.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&") + "=([^;]+)"));
    return m ? decodeURIComponent(m[1]) : "";
}

function randomHex(bytes=24) {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return [...a].map(x=>x.toString(16).padStart(2,"0")).join("");
}

async function sha256Hex(text) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

async function hashPassword(password, salt) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({
        name:"PBKDF2", salt:new TextEncoder().encode(salt), iterations:100000, hash:"SHA-256"
    }, key, 256);
    return [...new Uint8Array(bits)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

async function createSession(env, accountId) {
    const raw = randomHex(32);
    const hashed = await sha256Hex(raw);
    const now = new Date();
    const exp = new Date(now.getTime()+30*24*3600*1000);
    await env.DB.prepare(`INSERT INTO web_sessions(session_id,account_id,created_at,expires_at,last_seen)
        VALUES(?,?,?,?,?)`).bind(hashed,accountId,now.toISOString(),exp.toISOString(),now.toISOString()).run();
    return { raw, expires: exp };
}

function sessionCookie(raw, expires) {
    return `journal_session=${encodeURIComponent(raw)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires.toUTCString()}`;
}

async function getWebUser(request, env) {
    const raw = cookieValue(request,"journal_session");
    if (!raw) return null;
    const hashed = await sha256Hex(raw);
    const row = await env.DB.prepare(`
        SELECT a.*, s.last_seen, s.expires_at
        FROM web_sessions s
        JOIN web_accounts a ON a.id=s.account_id
        WHERE s.session_id=? AND a.enabled=1 AND s.expires_at>?
    `).bind(hashed,new Date().toISOString()).first();
    if (!row) return null;
    await env.DB.prepare(`UPDATE web_sessions SET last_seen=? WHERE session_id=?`)
        .bind(new Date().toISOString(),hashed).run();
    return row;
}

function parsePermissions(user) {
    try { return JSON.parse(user.permissions_json || "[]"); } catch { return []; }
}

function canWeb(user, perm) {
    if (!user) return false;
    if (user.role === "owner") return true;
    const explicit = parsePermissions(user);
    if (explicit.includes(perm)) return true;
    if (user.role === "viewer") return ["view_journal"].includes(perm);
    const teacher = ["view_journal","edit_attendance","edit_students","edit_duty","edit_schedule","reports"];
    return user.role === "teacher" && teacher.includes(perm);
}

async function requireWeb(request, env, perm="view_journal") {
    const u = await getWebUser(request, env);
    if (!u) throw Object.assign(new Error("AUTH"),{status:401});
    if (!canWeb(u,perm)) throw Object.assign(new Error("Нет права: "+perm),{status:403});
    return u;
}

async function webAudit(env, actor, action, details="") {
    await env.DB.prepare(`INSERT INTO audit_log(actor_user_id,action,details,created_at) VALUES(?,?,?,?)`)
        .bind(String(actor?.telegram_user_id || actor?.login || actor?.id || ""), action, String(details||"").slice(0,1000), new Date().toISOString()).run();
}

async function telegramWebAppUser(initData, env) {
    if (!initData || !env.BOT_TOKEN) return null;
    const p = new URLSearchParams(initData);
    const hash = p.get("hash");
    if (!hash) return null;
    p.delete("hash");
    const check = [...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join("\n");
    const enc = new TextEncoder();
    const secretKeyBase = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", secretKeyBase, enc.encode(env.BOT_TOKEN));
    const secretKey = await crypto.subtle.importKey("raw", secret, {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", secretKey, enc.encode(check));
    const calc = [...new Uint8Array(signature)].map(x=>x.toString(16).padStart(2,"0")).join("");
    if (calc !== hash.toLowerCase()) return null;
    const authDate = Number(p.get("auth_date")||0);
    if (!authDate || Math.abs(Date.now()/1000-authDate)>604800) return null;
    try { return JSON.parse(p.get("user")||"null"); } catch { return null; }
}

async function ensureTelegramAccount(env, tg) {
    const uid = String(tg.id);
    const allowed = await isAdmin(env,uid);
    if (!allowed) return null;
    let a = await env.DB.prepare(`SELECT * FROM web_accounts WHERE telegram_user_id=?`).bind(uid).first();
    if (!a) {
        const role = String(uid)===String(env.ADMIN_ID) ? "owner" : "teacher";
        const name = [tg.first_name,tg.last_name].filter(Boolean).join(" ") || tg.username || uid;
        await env.DB.prepare(`INSERT INTO web_accounts(telegram_user_id,role,enabled,created_at,display_name)
            VALUES(?,?,1,?,?)`).bind(uid,role,new Date().toISOString(),name).run();
        a = await env.DB.prepare(`SELECT * FROM web_accounts WHERE telegram_user_id=?`).bind(uid).first();
    }
    return a;
}

function qdate(v,fallback=localDate()) {
    return /^\d{4}-\d{2}-\d{2}$/.test(v||"") ? v : fallback;
}
function qmonth(v) {
    return /^\d{4}-\d{2}$/.test(v||"") ? v : localDate().slice(0,7);
}

async function orderedStudents(env, activeOnly=true) {
    return (await env.DB.prepare(`
        SELECT id,name,active FROM students
        ${activeOnly?"WHERE active=1":""}
        ORDER BY CASE WHEN name='Кориков Денис' THEN 1 WHEN name='Гуска Александр' THEN 2 ELSE 0 END,
                 name COLLATE NOCASE
    `).all()).results || [];
}


function normAttendanceStatus(status) {
    const s = String(status || "none");
    return s === "excused" ? "sick" : s;
}

function smartDayStatus(dailyStatus, pairRows, lessons) {
    const daily = normAttendanceStatus(dailyStatus);
    const totalLessons = Math.max(1, Number(lessons || 4));
    const byLesson = new Map();

    for (const r of pairRows || []) {
        const n = Number(r.lesson_no);
        if (n >= 1 && n <= totalLessons) {
            const st = normAttendanceStatus(r.status);
            if (st !== "none") byLesson.set(n, st);
        }
    }

    const statuses = [];
    for (let n = 1; n <= totalLessons; n++) statuses.push(byLesson.get(n) || "none");

    const recorded = statuses.filter(x => x !== "none");
    const isPresentLike = st => st === "present" || st === "late";
    const isAwayLike = st => ["absent","sick","application"].includes(st);
    const presentLessons = [];
    const awayLessons = [];
    const lateLessons = [];
    const leftLessons = [];

    statuses.forEach((st, i) => {
        const n = i + 1;
        if (isPresentLike(st)) presentLessons.push(n);
        if (isAwayLike(st)) awayLessons.push(n);
        if (st === "late") lateLessons.push(n);
        if (st === "left") leftLessons.push(n);
    });

    const representative = (kind) => ({
        full_sick:"sick", full_application:"application", full_absent:"absent",
        late:"late", arrived_later:"late", left_early:"left",
        partial_absence:"absent", mixed:"absent", present:"present", none:"none",
        conflict:"absent"
    }[kind] || "none");

    // Если по парам есть хотя бы одно реальное присутствие — дневной "болеет/нет/заявление"
    // больше НЕ может сделать ученика отсутствующим за весь день.
    if (presentLessons.length) {
        const first = Math.min(...presentLessons);
        const last = Math.max(...presentLessons);
        const before = statuses.slice(0, first - 1).some(isAwayLike);
        const after = statuses.slice(last).some(st => isAwayLike(st) || st === "left");
        const middle = statuses.slice(first - 1, last).some(isAwayLike);

        let kind = "present";
        let label = "Присутствовал";

        if (before && after) {
            kind = "partial_absence";
            label = `Частичное посещение: был с ${first}-й по ${last}-ю пару`;
        } else if (before) {
            kind = "arrived_later";
            label = `Пришёл с ${first}-й пары`;
        } else if (after) {
            kind = "left_early";
            label = `Ушёл после ${last}-й пары`;
        } else if (middle) {
            kind = "partial_absence";
            label = "Пропустил часть пар";
        } else if (lateLessons.length) {
            kind = "late";
            label = lateLessons.length === 1
                ? `Опоздал на ${lateLessons[0]}-ю пару`
                : `Опоздания: ${lateLessons.join(", ")} пары`;
        }

        return {
            kind, status:representative(kind), label,
            full_day:false, sick_full:false, absent_full:false, application_full:false,
            present_any:true, first_present:first, last_present:last,
            missed_lessons:awayLessons.length, late_lessons:lateLessons.length,
            left_lessons:leftLessons.length, pair_statuses:statuses
        };
    }

    // Ни на одной отмеченной паре присутствия нет.
    if (recorded.length) {
        const allSame = recorded.every(x => x === recorded[0]);
        const coveredAll = statuses.every(x => x !== "none");
        const sameAsDaily = daily !== "none" && allSame && recorded[0] === daily;
        const fullStatus = allSame && ["sick","application","absent"].includes(recorded[0]) &&
            (coveredAll || sameAsDaily);

        if (fullStatus) {
            const st = recorded[0];
            const kind = st === "sick" ? "full_sick" : st === "application" ? "full_application" : "full_absent";
            const label = st === "sick" ? "Болеет весь день" : st === "application" ? "По заявлению весь день" : "Отсутствует весь день";
            return {
                kind,status:st,label,full_day:true,
                sick_full:st==="sick", absent_full:st==="absent", application_full:st==="application",
                present_any:false, first_present:null,last_present:null,
                missed_lessons:awayLessons.length || totalLessons,
                late_lessons:lateLessons.length,left_lessons:leftLessons.length,pair_statuses:statuses
            };
        }

        // Дневной полный статус допустим только если пары ему не противоречат.
        if (["sick","application","absent"].includes(daily) &&
            recorded.every(st => st === daily || st === "none")) {
            const kind = daily === "sick" ? "full_sick" : daily === "application" ? "full_application" : "full_absent";
            return {
                kind,status:daily,
                label:daily==="sick"?"Болеет весь день":daily==="application"?"По заявлению весь день":"Отсутствует весь день",
                full_day:true,sick_full:daily==="sick",absent_full:daily==="absent",application_full:daily==="application",
                present_any:false,first_present:null,last_present:null,
                missed_lessons:awayLessons.length || totalLessons,
                late_lessons:lateLessons.length,left_lessons:leftLessons.length,pair_statuses:statuses
            };
        }

        return {
            kind:"partial_absence",status:"absent",label:"Частичное отсутствие",
            full_day:false,sick_full:false,absent_full:false,application_full:false,
            present_any:false,first_present:null,last_present:null,
            missed_lessons:awayLessons.length,late_lessons:lateLessons.length,
            left_lessons:leftLessons.length,pair_statuses:statuses
        };
    }

    // Если парных отметок нет — используем дневной статус как итог.
    if (daily === "sick") return {
        kind:"full_sick",status:"sick",label:"Болеет весь день",full_day:true,
        sick_full:true,absent_full:false,application_full:false,present_any:false,
        first_present:null,last_present:null,missed_lessons:totalLessons,late_lessons:0,left_lessons:0,pair_statuses:statuses
    };
    if (daily === "application") return {
        kind:"full_application",status:"application",label:"По заявлению весь день",full_day:true,
        sick_full:false,absent_full:false,application_full:true,present_any:false,
        first_present:null,last_present:null,missed_lessons:totalLessons,late_lessons:0,left_lessons:0,pair_statuses:statuses
    };
    if (daily === "absent") return {
        kind:"full_absent",status:"absent",label:"Отсутствует весь день",full_day:true,
        sick_full:false,absent_full:true,application_full:false,present_any:false,
        first_present:null,last_present:null,missed_lessons:totalLessons,late_lessons:0,left_lessons:0,pair_statuses:statuses
    };
    if (daily === "late") return {
        kind:"late",status:"late",label:"Опоздал",full_day:false,
        sick_full:false,absent_full:false,application_full:false,present_any:true,
        first_present:1,last_present:totalLessons,missed_lessons:0,late_lessons:1,left_lessons:0,pair_statuses:statuses
    };
    if (daily === "left") return {
        kind:"left_early",status:"left",label:"Ушёл раньше",full_day:false,
        sick_full:false,absent_full:false,application_full:false,present_any:true,
        first_present:1,last_present:null,missed_lessons:0,late_lessons:0,left_lessons:1,pair_statuses:statuses
    };
    if (daily === "present") return {
        kind:"present",status:"present",label:"Присутствовал",full_day:false,
        sick_full:false,absent_full:false,application_full:false,present_any:true,
        first_present:1,last_present:totalLessons,missed_lessons:0,late_lessons:0,left_lessons:0,pair_statuses:statuses
    };

    return {
        kind:"none",status:"none",label:"Нет отметки",full_day:false,
        sick_full:false,absent_full:false,application_full:false,present_any:false,
        first_present:null,last_present:null,missed_lessons:0,late_lessons:0,left_lessons:0,pair_statuses:statuses
    };
}

async function smartMonthData(env, month) {
    const students = await orderedStudents(env,true);
    const dailyRows = (await env.DB.prepare(`
        SELECT date,student_id,status FROM attendance
        WHERE substr(date,1,7)=?
    `).bind(month).all()).results || [];
    const pairRows = (await env.DB.prepare(`
        SELECT date,student_id,lesson_no,status FROM lesson_attendance
        WHERE substr(date,1,7)=?
    `).bind(month).all()).results || [];

    const dates = new Set([...dailyRows.map(r=>r.date), ...pairRows.map(r=>r.date)]);
    const dailyMap = new Map(dailyRows.map(r=>[`${r.date}:${r.student_id}`,r.status]));
    const pairMap = new Map();
    for (const r of pairRows) {
        const k = `${r.date}:${r.student_id}`;
        if (!pairMap.has(k)) pairMap.set(k,[]);
        pairMap.get(k).push(r);
    }

    const byStudent = new Map(students.map(st=>[Number(st.id),{
        id:st.id,name:st.name,full_days:0,absent:0,left:0,late:0,sick:0,application:0,
        partial_days:0,present_days:0,total_marked_days:0,days:[]
    }]));

    for (const date of [...dates].sort()) {
        const lessons = lessonsCountForDate(date);
        for (const st of students) {
            const sid = Number(st.id);
            const key = `${date}:${sid}`;
            const daily = dailyMap.get(key) || "none";
            const pairs = pairMap.get(key) || [];
            if (daily === "none" && !pairs.length) continue;

            const summary = smartDayStatus(daily,pairs,lessons);
            const row = byStudent.get(sid);
            row.total_marked_days++;
            if (summary.present_any) row.present_days++;
            if (summary.absent_full) row.full_days++;
            if (summary.sick_full) row.sick++;
            if (summary.application_full) row.application++;
            if (["partial_absence","arrived_later","left_early"].includes(summary.kind)) row.partial_days++;

            // ❌ — именно пропущенные пары. Для полного отсутствия без парных строк считаем все пары дня.
            const explicitAbsent = pairs.filter(r=>normAttendanceStatus(r.status)==="absent").length;
            row.absent += explicitAbsent || (summary.absent_full ? lessons : 0);
            row.late += pairs.filter(r=>normAttendanceStatus(r.status)==="late").length || (summary.kind==="late" ? 1 : 0);
            row.left += pairs.filter(r=>normAttendanceStatus(r.status)==="left").length || (summary.kind==="left_early" ? 1 : 0);
            row.days.push({date,...summary});
        }
    }

    return {students, rows:[...byStudent.values()]};
}

async function dashboardApi(env) {
    const date = localDate();
    const students = await orderedStudents(env,true);
    const dailyRows = (await env.DB.prepare(`SELECT student_id,status FROM attendance WHERE date=?`).bind(date).all()).results || [];
    const pairRows = (await env.DB.prepare(`SELECT student_id,status,lesson_no FROM lesson_attendance WHERE date=?`).bind(date).all()).results || [];
    const duty = (await env.DB.prepare(`SELECT s.id,s.name FROM duty d JOIN students s ON s.id=d.student_id WHERE d.date=?`).bind(date).all()).results || [];

    const dailyMap = new Map(dailyRows.map(r=>[Number(r.student_id),r.status]));
    const pairMap = new Map();
    for (const r of pairRows) {
        const sid=Number(r.student_id);
        if(!pairMap.has(sid)) pairMap.set(sid,[]);
        pairMap.get(sid).push(r);
    }

    const summaries=[];
    for (const st of students) {
        const summary=smartDayStatus(dailyMap.get(Number(st.id))||"none",pairMap.get(Number(st.id))||[],lessonsCountForDate(date));
        summaries.push({id:st.id,name:st.name,...summary});
    }

    const today=summaries
        .filter(x=>!["present","none"].includes(x.kind))
        .map(x=>({
            id:x.id,name:x.name,
            icon:x.status==="sick"?"🤒":x.status==="application"?"📝":x.status==="late"?"⏰":x.status==="left"?"🚪":"❌",
            text:x.label,kind:x.kind,status:x.status
        }));

    return {
        date,
        students:students.length,
        absent:summaries.filter(x=>x.absent_full).length,
        sick:summaries.filter(x=>x.sick_full).length,
        application:summaries.filter(x=>x.application_full).length,
        partial:summaries.filter(x=>["partial_absence","arrived_later","left_early"].includes(x.kind)).length,
        late:summaries.filter(x=>x.kind==="late").length,
        today,duty,summaries
    };
}
async function parentsApi(env, month) {
    const smart = await smartMonthData(env,month);
    return smart.rows.map(r=>({
        id:r.id,name:r.name,full_days:r.full_days,absent:r.absent,left:r.left,late:r.late,
        sick:r.sick,application:r.application,partial_days:r.partial_days,
        attendance_percent:r.total_marked_days ? Math.round(r.present_days/r.total_marked_days*100) : 0
    }));
}
async function handleWebApi(request, env, url) {
    try {
        const path = url.pathname;
        const body = request.method==="GET" ? {} : await request.json().catch(()=>({}));

        if (path==="/api/auth/password" && request.method==="POST") {
            const a=await env.DB.prepare(`SELECT * FROM web_accounts WHERE lower(login)=lower(?) AND enabled=1`).bind(String(body.login||"")).first();
            if(!a||!a.password_hash||!a.password_salt) return jsonResponse({error:"Неверный логин или пароль"},401);
            const h=await hashPassword(String(body.password||""),a.password_salt);
            if(h!==a.password_hash) return jsonResponse({error:"Неверный логин или пароль"},401);
            const ses=await createSession(env,a.id);
            await env.DB.prepare(`UPDATE web_accounts SET last_login=? WHERE id=?`).bind(new Date().toISOString(),a.id).run();
            await webAudit(env,a,"web_login","password");
            return jsonResponse({ok:true},200,{"set-cookie":sessionCookie(ses.raw,ses.expires)});
        }

        if (path==="/api/auth/telegram" && request.method==="POST") {
            const tg=await telegramWebAppUser(body.initData,env);
            if(!tg) return jsonResponse({error:"Не удалось проверить Telegram"},401);
            const a=await ensureTelegramAccount(env,tg);
            if(!a) return jsonResponse({error:"У вас нет доступа к журналу"},403);
            const ses=await createSession(env,a.id);
            await webAudit(env,a,"web_login","telegram_webapp");
            return jsonResponse({ok:true},200,{"set-cookie":sessionCookie(ses.raw,ses.expires)});
        }

        if (path==="/api/logout" && request.method==="POST") {
            const raw=cookieValue(request,"journal_session");
            if(raw){const h=await sha256Hex(raw);await env.DB.prepare(`DELETE FROM web_sessions WHERE session_id=?`).bind(h).run()}
            return jsonResponse({ok:true},200,{"set-cookie":"journal_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"});
        }

        const user=await requireWeb(request,env,"view_journal");

        if (path==="/api/me") return jsonResponse({id:user.id,display_name:user.display_name,login:user.login,role:user.role,telegram_user_id:user.telegram_user_id,permissions:parsePermissions(user)});

        if (path==="/api/dashboard") return jsonResponse(await dashboardApi(env));

        if (path==="/api/students" && request.method==="GET") return jsonResponse({students:await orderedStudents(env,true)});
        if (path==="/api/students" && request.method==="POST") {
            if(!canWeb(user,"edit_students")) return jsonResponse({error:"Нет права"},403);
            const name=String(body.name||"").trim(); if(name.length<3) return jsonResponse({error:"Введите имя"},400);
            await env.DB.prepare(`INSERT INTO students(name,active) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET active=1`).bind(name).run();
            await webAudit(env,user,"student_add",name); return jsonResponse({ok:true});
        }

        if (path.startsWith("/api/student/")) {
            const id = Number(path.split("/").pop());
            const student = await env.DB.prepare(`SELECT * FROM students WHERE id=?`).bind(id).first();
            if (!student) return jsonResponse({error:"Ученик не найден"},404);

            const dailyRows=(await env.DB.prepare(`SELECT date,status FROM attendance WHERE student_id=? ORDER BY date DESC LIMIT 180`).bind(id).all()).results||[];
            const pairRows=(await env.DB.prepare(`SELECT date,status,lesson_no FROM lesson_attendance WHERE student_id=? ORDER BY date DESC,lesson_no ASC LIMIT 500`).bind(id).all()).results||[];
            const dates=[...new Set([...dailyRows.map(r=>r.date),...pairRows.map(r=>r.date)])].sort().reverse();
            const dailyMap=new Map(dailyRows.map(r=>[r.date,r.status]));
            const pairMap=new Map();
            for(const r of pairRows){if(!pairMap.has(r.date))pairMap.set(r.date,[]);pairMap.get(r.date).push(r)}

            const events=[];
            let absent=0,sick=0,application=0,presentDays=0,countedDays=0,partial=0;
            for(const date of dates){
                const pairs=pairMap.get(date)||[];
                const summary=smartDayStatus(dailyMap.get(date)||"none",pairs,lessonsCountForDate(date));
                if(summary.kind==="none")continue;
                countedDays++;
                if(summary.present_any)presentDays++;
                if(summary.absent_full)absent++;
                if(summary.sick_full)sick++;
                if(summary.application_full)application++;
                if(["partial_absence","arrived_later","left_early"].includes(summary.kind))partial++;
                events.push({
                    date,status:summary.status,kind:summary.kind,summary_label:summary.label,
                    source:"summary",lesson_no:null,pair_statuses:summary.pair_statuses,
                    missed_lessons:summary.missed_lessons
                });
            }

            return jsonResponse({
                student,absent,sick,application,partial,
                attendance_percent:countedDays?Math.round(presentDays/countedDays*100):0,
                events:events.slice(0,60)
            });
        }
        if (path==="/api/attendance" && request.method==="GET") {
            const date=qdate(url.searchParams.get("date"));
            const rows=(await env.DB.prepare(`SELECT student_id,status FROM attendance WHERE date=?`).bind(date).all()).results||[];
            return jsonResponse({date,statuses:Object.fromEntries(rows.map(r=>[String(r.student_id),r.status]))});
        }
        if (path==="/api/attendance" && request.method==="POST") {
            if(!canWeb(user,"edit_attendance")) return jsonResponse({error:"Нет права"},403);
            const date=qdate(body.date),sid=Number(body.student_id),st=String(body.status||"none");
            if(st==="none") await env.DB.prepare(`DELETE FROM attendance WHERE date=? AND student_id=?`).bind(date,sid).run();
            else await env.DB.prepare(`INSERT INTO attendance(date,student_id,status) VALUES(?,?,?) ON CONFLICT(date,student_id) DO UPDATE SET status=excluded.status`).bind(date,sid,st).run();
            await webAudit(env,user,"attendance_set",`${date} student=${sid} status=${st}`); return jsonResponse({ok:true});
        }
        if (path==="/api/attendance/all-present" && request.method==="POST") {
            if(!canWeb(user,"edit_attendance")) return jsonResponse({error:"Нет права"},403);
            const date=qdate(body.date); for(const s of await orderedStudents(env,true)){await env.DB.prepare(`INSERT INTO attendance(date,student_id,status) VALUES(?,?,'present') ON CONFLICT(date,student_id) DO UPDATE SET status='present'`).bind(date,s.id).run()}
            await webAudit(env,user,"attendance_all_present",date); return jsonResponse({ok:true});
        }

        if (path==="/api/pairs" && request.method==="GET") {
            const date=qdate(url.searchParams.get("date")),lessons=lessonsCountForDate(date);
            const rows=(await env.DB.prepare(`SELECT lesson_no,student_id,status FROM lesson_attendance WHERE date=?`).bind(date).all()).results||[];
            const statuses={}; for(const r of rows){(statuses[String(r.lesson_no)] ||= {})[String(r.student_id)]=r.status}
            return jsonResponse({date,lessons,statuses});
        }
        if (path==="/api/pairs" && request.method==="POST") {
            if(!canWeb(user,"edit_attendance")) return jsonResponse({error:"Нет права"},403);
            const date=qdate(body.date),lesson=Number(body.lesson_no),sid=Number(body.student_id),st=String(body.status||"none");
            if(st==="none") await env.DB.prepare(`DELETE FROM lesson_attendance WHERE date=? AND lesson_no=? AND student_id=?`).bind(date,lesson,sid).run();
            else await env.DB.prepare(`INSERT INTO lesson_attendance(date,lesson_no,student_id,status) VALUES(?,?,?,?) ON CONFLICT(date,lesson_no,student_id) DO UPDATE SET status=excluded.status`).bind(date,lesson,sid,st).run();
            await webAudit(env,user,"pair_attendance_set",`${date} pair=${lesson} student=${sid} status=${st}`); return jsonResponse({ok:true});
        }

        if (path==="/api/calendar") {
            const month=qmonth(url.searchParams.get("month"));
            const smart=await smartMonthData(env,month);
            const days={};
            for(const st of smart.rows){
                for(const d of st.days){
                    const q=days[d.date] ||= {absent:0,sick:0,application:0,partial:0};
                    if(d.absent_full)q.absent++;
                    if(d.sick_full)q.sick++;
                    if(d.application_full)q.application++;
                    if(["partial_absence","arrived_later","left_early"].includes(d.kind))q.partial++;
                }
            }
            return jsonResponse({month,days});
        }

        if (path==="/api/health") {
            const month=qmonth(url.searchParams.get("month"));
            const smart=await smartMonthData(env,month);
            const rows=smart.rows.map(r=>({id:r.id,name:r.name,sick:r.sick,application:r.application,partial:r.partial_days}));
            return jsonResponse({
                month,rows,
                sick_total:rows.reduce((a,x)=>a+x.sick,0),
                application_total:rows.reduce((a,x)=>a+x.application,0)
            });
        }
        if (path==="/api/duty" && request.method==="GET") {
            const date=qdate(url.searchParams.get("date")); const students=(await env.DB.prepare(`SELECT s.id,s.name FROM duty d JOIN students s ON s.id=d.student_id WHERE d.date=? ORDER BY s.name`).bind(date).all()).results||[];
            return jsonResponse({date,students});
        }
        if (path==="/api/duty" && request.method==="POST") {
            if(!canWeb(user,"edit_duty")) return jsonResponse({error:"Нет права"},403);
            const date=qdate(body.date),ids=Array.isArray(body.student_ids)?body.student_ids.map(Number):[];
            await env.DB.prepare(`DELETE FROM duty WHERE date=?`).bind(date).run();
            for(const id of ids) await env.DB.prepare(`INSERT OR IGNORE INTO duty(date,student_id) VALUES(?,?)`).bind(date,id).run();
            await webAudit(env,user,"duty_set",`${date}: ${ids.join(",")}`); return jsonResponse({ok:true});
        }

        if (path==="/api/schedule" && request.method==="GET") {
            const rows=(await env.DB.prepare(`SELECT * FROM schedule_lessons ORDER BY weekday,lesson_no`).all()).results||[]; const days={};
            for(const r of rows)(days[String(r.weekday)] ||= []).push(r); return jsonResponse({days});
        }
        if (path==="/api/schedule" && request.method==="POST") {
            if(!canWeb(user,"edit_schedule")) return jsonResponse({error:"Нет права"},403);
            await env.DB.prepare(`INSERT INTO schedule_lessons(weekday,lesson_no,subject,time,teacher,room) VALUES(?,?,?,?,?,?)
                ON CONFLICT(weekday,lesson_no) DO UPDATE SET subject=excluded.subject,time=excluded.time,teacher=excluded.teacher,room=excluded.room`)
                .bind(Number(body.weekday),Number(body.lesson_no),String(body.subject||""),String(body.time||""),String(body.teacher||""),String(body.room||"")).run();
            await webAudit(env,user,"schedule_set",`day=${body.weekday} lesson=${body.lesson_no}`); return jsonResponse({ok:true});
        }

        if (path==="/api/parents") return jsonResponse({month:qmonth(url.searchParams.get("month")),rows:await parentsApi(env,qmonth(url.searchParams.get("month")))});

        if (path==="/api/stats") {
            const month=qmonth(url.searchParams.get("month"));
            const smart=await smartMonthData(env,month);
            const detail=smart.rows.map(r=>({
                id:r.id,name:r.name,full_days:r.full_days,absent:r.absent,left:r.left,late:r.late,
                sick:r.sick,application:r.application,partial_days:r.partial_days,
                percent:r.total_marked_days?Math.round(r.present_days/r.total_marked_days*100):0
            }));
            const gp=detail.length?Math.round(detail.reduce((a,x)=>a+x.percent,0)/detail.length):0;
            return jsonResponse({
                month,rows:detail,group_percent:gp,
                total_absent:detail.reduce((a,x)=>a+x.absent,0),
                total_sick:detail.reduce((a,x)=>a+x.sick,0),
                total_application:detail.reduce((a,x)=>a+x.application,0),
                total_partial:detail.reduce((a,x)=>a+x.partial_days,0)
            });
        }
        if (path==="/api/online") {
            const rows=(await env.DB.prepare(`SELECT a.display_name,a.login,a.telegram_user_id,MAX(s.last_seen) last_seen
                FROM web_accounts a LEFT JOIN web_sessions s ON s.account_id=a.id WHERE a.enabled=1 GROUP BY a.id ORDER BY last_seen DESC`).all()).results||[];
            const now=Date.now(); return jsonResponse({users:rows.map(r=>({...r,online:r.last_seen&&(now-new Date(r.last_seen).getTime()<5*60*1000)}))});
        }

        if (path==="/api/admin/accounts" && request.method==="GET") {
            if(user.role!=="owner") return jsonResponse({error:"Только владелец"},403);
            return jsonResponse({accounts:(await env.DB.prepare(`SELECT id,telegram_user_id,login,role,enabled,display_name,last_login,permissions_json FROM web_accounts ORDER BY id`).all()).results||[]});
        }
        if (path==="/api/admin/accounts" && request.method==="POST") {
            if(user.role!=="owner") return jsonResponse({error:"Только владелец"},403);
            await ensureColumn(env, "web_accounts", "display_name", "TEXT");
            await ensureColumn(env, "web_accounts", "password_salt", "TEXT");
            await ensureColumn(env, "web_accounts", "permissions_json", "TEXT");
            const login=String(body.login||"").trim(),pass=String(body.password||""),tg=String(body.telegram_user_id||"").trim()||null;
            if(!/^[A-Za-z0-9_.-]{3,40}$/.test(login)) return jsonResponse({error:"Логин: 3–40 символов, латиница/цифры/._-"},400);
            if(pass.length<8) return jsonResponse({error:"Пароль должен быть минимум 8 символов"},400);
            const exists=await env.DB.prepare(`SELECT id FROM web_accounts WHERE lower(login)=lower(?)`).bind(login).first();
            if(exists) return jsonResponse({error:"Такой логин уже существует"},409);
            if(tg){const te=await env.DB.prepare(`SELECT id FROM web_accounts WHERE telegram_user_id=?`).bind(tg).first();if(te)return jsonResponse({error:"Этот Telegram ID уже привязан"},409)}
            const salt=randomHex(16),hash=await hashPassword(pass,salt);
            await env.DB.prepare(`INSERT INTO web_accounts(telegram_user_id,login,password_hash,password_salt,role,enabled,created_at,display_name,permissions_json)
                VALUES(?,?,?,?,?,1,?,?,?)`).bind(tg,login,hash,salt,String(body.role||"teacher"),new Date().toISOString(),String(body.display_name||""),JSON.stringify(body.permissions||[])).run();
            await webAudit(env,user,"account_create",login); return jsonResponse({ok:true,login,password:pass});
        }

        if (path==="/api/admin/accounts/toggle" && request.method==="POST") {
            if(user.role!=="owner") return jsonResponse({error:"Только владелец"},403);
            const id=Number(body.id), enabled=body.enabled?1:0;
            const target=await env.DB.prepare(`SELECT * FROM web_accounts WHERE id=?`).bind(id).first();
            if(!target) return jsonResponse({error:"Пользователь не найден"},404);
            if(target.role==="owner") return jsonResponse({error:"Владельца отключить нельзя"},400);
            await env.DB.prepare(`UPDATE web_accounts SET enabled=? WHERE id=?`).bind(enabled,id).run();
            if(!enabled) await env.DB.prepare(`DELETE FROM web_sessions WHERE account_id=?`).bind(id).run();
            await webAudit(env,user,enabled?"account_enable":"account_disable",String(id));
            return jsonResponse({ok:true});
        }


        if (path==="/api/admin/accounts/update" && request.method==="POST") {
            if(user.role!=="owner") return jsonResponse({error:"Только владелец"},403);
            const id=Number(body.id);
            const target=await env.DB.prepare(`SELECT * FROM web_accounts WHERE id=?`).bind(id).first();
            if(!target) return jsonResponse({error:"Пользователь не найден"},404);
            const displayName=String(body.display_name??target.display_name??"").trim();
            const role=target.role==="owner" ? "owner" : (["teacher","viewer"].includes(String(body.role))?String(body.role):target.role);
            const tg=String(body.telegram_user_id??target.telegram_user_id??"").trim()||null;
            const perms=Array.isArray(body.permissions)?body.permissions:JSON.parse(target.permissions_json||"[]");
            if(tg && String(tg)!==String(target.telegram_user_id||"")){
                const te=await env.DB.prepare(`SELECT id FROM web_accounts WHERE telegram_user_id=? AND id<>?`).bind(tg,id).first();
                if(te)return jsonResponse({error:"Этот Telegram ID уже привязан"},409);
            }
            await env.DB.prepare(`UPDATE web_accounts SET display_name=?,role=?,telegram_user_id=?,permissions_json=? WHERE id=?`)
                .bind(displayName,role,tg,JSON.stringify(perms),id).run();
            await webAudit(env,user,"account_update",String(id));
            return jsonResponse({ok:true});
        }

        if (path==="/api/admin/accounts/password" && request.method==="POST") {
            if(user.role!=="owner") return jsonResponse({error:"Только владелец"},403);
            const id=Number(body.id), pass=String(body.password||"");
            if(pass.length<8)return jsonResponse({error:"Пароль должен быть минимум 8 символов"},400);
            const target=await env.DB.prepare(`SELECT id FROM web_accounts WHERE id=?`).bind(id).first();
            if(!target)return jsonResponse({error:"Пользователь не найден"},404);
            const salt=randomHex(16),hash=await hashPassword(pass,salt);
            await env.DB.prepare(`UPDATE web_accounts SET password_salt=?,password_hash=? WHERE id=?`).bind(salt,hash,id).run();
            await env.DB.prepare(`DELETE FROM web_sessions WHERE account_id=?`).bind(id).run();
            await webAudit(env,user,"account_password",String(id));
            return jsonResponse({ok:true});
        }

        if (path==="/api/admin/accounts/delete" && request.method==="POST") {
            if(user.role!=="owner") return jsonResponse({error:"Только владелец"},403);
            const id=Number(body.id);
            const target=await env.DB.prepare(`SELECT * FROM web_accounts WHERE id=?`).bind(id).first();
            if(!target)return jsonResponse({error:"Пользователь не найден"},404);
            if(target.role==="owner")return jsonResponse({error:"Владельца удалить нельзя"},400);
            await env.DB.prepare(`DELETE FROM web_sessions WHERE account_id=?`).bind(id).run();
            try{await env.DB.prepare(`DELETE FROM web_permissions WHERE account_id=?`).bind(id).run();}catch(_){}
            await env.DB.prepare(`DELETE FROM web_accounts WHERE id=?`).bind(id).run();
            await webAudit(env,user,"account_delete",String(id));
            return jsonResponse({ok:true});
        }

        if (path==="/api/audit") {
            if(user.role!=="owner") return jsonResponse({error:"Только владелец"},403);
            return jsonResponse({rows:(await env.DB.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 300`).all()).results||[]});
        }

        if (path==="/api/settings" && request.method==="GET") {
            const rows=(await env.DB.prepare(`SELECT key,value FROM app_settings WHERE key IN ('group_name','timezone')`).all()).results||[];
            return jsonResponse(Object.fromEntries(rows.map(r=>[r.key,r.value])));
        }
        if (path==="/api/settings" && request.method==="POST") {
            if(!canWeb(user,"settings")) return jsonResponse({error:"Нет права"},403);
            for(const k of ["group_name","timezone"]) if(body[k]!=null) await env.DB.prepare(`INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(k,String(body[k])).run();
            await webAudit(env,user,"settings_update",JSON.stringify(body)); return jsonResponse({ok:true});
        }

        if (path==="/api/search") {
            const q="%"+String(url.searchParams.get("q")||"").slice(0,60)+"%";
            const students=(await env.DB.prepare(`SELECT id,name FROM students WHERE name LIKE ? ORDER BY name LIMIT 20`).bind(q).all()).results||[];
            const audit=user.role==="owner"?(await env.DB.prepare(`SELECT id,action,details FROM audit_log WHERE action LIKE ? OR details LIKE ? ORDER BY id DESC LIMIT 20`).bind(q,q).all()).results||[]:[];
            return jsonResponse({results:[...students.map(x=>({title:x.name,subtitle:"Ученик"})),...audit.map(x=>({title:x.action,subtitle:x.details}))]});
        }

        if (path==="/api/export.csv") {
            if(!canWeb(user,"reports")) return jsonResponse({error:"Нет права"},403);
            const rows=(await env.DB.prepare(`SELECT la.date,la.lesson_no,s.name,la.status FROM lesson_attendance la JOIN students s ON s.id=la.student_id ORDER BY la.date,la.lesson_no,s.name`).all()).results||[];
            const csv="date;lesson;student;status\n"+rows.map(r=>[r.date,r.lesson_no,r.name,r.status].map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(";")).join("\n");
            return new Response("\ufeff"+csv,{headers:{"content-type":"text/csv; charset=UTF-8","content-disposition":"attachment; filename=journal102.csv"}});
        }

        if (path==="/api/backup") {
            if(!canWeb(user,"reports")) return jsonResponse({error:"Нет права"},403);
            const tables=["students","attendance","lesson_attendance","duty","schedule_lessons"];
            const data={created_at:new Date().toISOString(),tables:{}};
            for(const t of tables)data.tables[t]=(await env.DB.prepare(`SELECT * FROM ${t}`).all()).results||[];
            return new Response(JSON.stringify(data,null,2),{headers:{"content-type":"application/json; charset=UTF-8","content-disposition":"attachment; filename=journal102_backup.json"}});
        }

        if (path==="/api/report.xlsx") {
            if(!canWeb(user,"reports")) return jsonResponse({error:"Нет права"},403);
            const period=url.searchParams.get("period")||"all"; const r=await createExcelReport(env,period);
            return new Response(r.buffer,{headers:{"content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","content-disposition":`attachment; filename="${r.filename}"`}});
        }

        return jsonResponse({error:"API route not found"},404);
    } catch(e) {
        if(e?.status) return jsonResponse({error:e.message==="AUTH"?"Нужен вход":e.message},e.status);
        console.error("Web API:",e); return jsonResponse({error:String(e?.message||e)},500);
    }
}
