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

      if (request.method === "GET" && url.pathname === "/setup") {
        const webhookUrl = `${url.origin}/webhook`;

        const result = await telegram(env, "setWebhook", {
          url: webhookUrl,
          allowed_updates: ["message", "callback_query"]
        });

        return textResponse(
          result.ok
            ? `Webhook установлен!\n${webhookUrl}`
            : `Ошибка:\n${JSON.stringify(result)}`
        );
      }

      if (request.method === "POST" && url.pathname === "/webhook") {
        const update = await request.json();
        await handleUpdate(update, env);

        return new Response("OK");
      }

      return textResponse("Teacher Journal Bot is running! 📚");
    } catch (error) {
      console.error(error);
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
      PRIMARY KEY(date, student_id)
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS duty (
      date TEXT NOT NULL,
      student_id INTEGER NOT NULL,
      PRIMARY KEY(date, student_id)
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS states (
      user_id TEXT PRIMARY KEY,
      action TEXT NOT NULL
    )
  `).run();

  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM students"
  ).first();

  if (Number(row?.count || 0) === 0) {
    for (const name of DEFAULT_STUDENTS) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO students(name) VALUES(?)"
      ).bind(name).run();
    }
  }
}

async function handleUpdate(update, env) {
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query, env);
    } else if (update.message) {
      await handleMessage(update.message, env);
    }
  } catch (error) {
    console.error("Update error:", error);
  }
}

function isAdmin(env, userId) {
  return String(userId) === String(env.ADMIN_ID);
}

async function handleMessage(message, env) {
  if (!message.from) return;

  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const text = message.text || "";

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

  if (!isAdmin(env, userId)) {
    await sendMessage(
      env,
      chatId,
      `🔒 <b>Доступ закрыт</b>

Этот журнал предназначен только для преподавателя.`
    );
    return;
  }

  if (command === "/start") {
    await clearState(env, userId);
    await showMainMenu(env, chatId);
    return;
  }

  const state = await env.DB.prepare(
    "SELECT action FROM states WHERE user_id = ?"
  ).bind(userId).first();

  if (
    state?.action === "await_student" &&
    text &&
    !text.startsWith("/")
  ) {
    const name = cleanName(text);

    if (name.length < 3) {
      await sendMessage(
        env,
        chatId,
        `⚠️ Отправьте фамилию и имя.

Например:
<code>Иванов Иван</code>`
      );
      return;
    }

    try {
      await env.DB.prepare(
        "INSERT INTO students(name, active) VALUES(?, 1)"
      ).bind(name).run();

      await clearState(env, userId);

      await sendMessage(
        env,
        chatId,
        `✅ <b>Студент добавлен</b>

👤 ${escapeHtml(name)}`
      );

      await showStudentsMenu(env, chatId);
    } catch {
      await sendMessage(
        env,
        chatId,
        "⚠️ Такой студент уже есть в списке."
      );
    }
  }
}

async function handleCallback(q, env) {
  if (!q.from || !q.message) return;

  const userId = String(q.from.id);
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const data = q.data || "";

  await answerCallback(env, q.id);

  if (!isAdmin(env, userId)) {
    await sendMessage(env, chatId, "🔒 Доступ закрыт.");
    return;
  }

  if (data === "main") {
    await clearState(env, userId);
    await showMainMenu(env, chatId, messageId);
    return;
  }

  if (data === "attendance") {
    await showAttendance(
      env,
      chatId,
      messageId,
      todayYMD()
    );
    return;
  }

  if (data.startsWith("attendance:date:")) {
    const date = data.slice(
      "attendance:date:".length
    );

    await showAttendance(
      env,
      chatId,
      messageId,
      date
    );
    return;
  }

  if (data.startsWith("attendance:toggle:")) {
    const parts = data.split(":");
    const studentId = Number(parts[2]);
    const date = parts[3];

    await toggleAttendance(
      env,
      studentId,
      date
    );

    await showAttendance(
      env,
      chatId,
      messageId,
      date
    );
    return;
  }

  if (data.startsWith("attendance:allpresent:")) {
    const date = data.slice(
      "attendance:allpresent:".length
    );

    const students = await getStudents(env);

    for (const student of students) {
      await env.DB.prepare(`
        INSERT INTO attendance(
          date,
          student_id,
          status
        )
        VALUES(?, ?, 'present')

        ON CONFLICT(date, student_id)
        DO UPDATE SET status = 'present'
      `).bind(
        date,
        student.id
      ).run();
    }

    await showAttendance(
      env,
      chatId,
      messageId,
      date
    );
    return;
  }

  if (data.startsWith("attendance:clear:")) {
    const date = data.slice(
      "attendance:clear:".length
    );

    await env.DB.prepare(
      "DELETE FROM attendance WHERE date = ?"
    ).bind(date).run();

    await showAttendance(
      env,
      chatId,
      messageId,
      date
    );
    return;
  }

  if (data === "duty") {
    await showDuty(
      env,
      chatId,
      messageId,
      todayYMD()
    );
    return;
  }

  if (data.startsWith("duty:date:")) {
    const date = data.slice(
      "duty:date:".length
    );

    await showDuty(
      env,
      chatId,
      messageId,
      date
    );
    return;
  }

  if (data.startsWith("duty:toggle:")) {
    const parts = data.split(":");
    const studentId = Number(parts[2]);
    const date = parts[3];

    await toggleDuty(
      env,
      studentId,
      date
    );

    await showDuty(
      env,
      chatId,
      messageId,
      date
    );
    return;
  }

  if (data.startsWith("duty:clear:")) {
    const date = data.slice(
      "duty:clear:".length
    );

    await env.DB.prepare(
      "DELETE FROM duty WHERE date = ?"
    ).bind(date).run();

    await showDuty(
      env,
      chatId,
      messageId,
      date
    );
    return;
  }

  if (data === "stats") {
    await showStatsStudents(
      env,
      chatId,
      messageId
    );
    return;
  }

  if (data === "stats:group") {
    await showGroupStats(
      env,
      chatId,
      messageId
    );
    return;
  }

  if (data.startsWith("stats:student:")) {
    const studentId = Number(
      data.slice("stats:student:".length)
    );

    await showStudentStats(
      env,
      chatId,
      messageId,
      studentId
    );
    return;
  }
    if (data === "students") {
    await clearState(env, userId);

    await showStudentsMenu(
      env,
      chatId,
      messageId
    );
    return;
  }

  if (data === "students:list") {
    await showStudentsList(
      env,
      chatId,
      messageId
    );
    return;
  }

  if (data === "students:add") {
    await env.DB.prepare(`
      INSERT INTO states(user_id, action)
      VALUES(?, 'await_student')

      ON CONFLICT(user_id)
      DO UPDATE SET action = 'await_student'
    `).bind(userId).run();

    await editMessage(
      env,
      chatId,
      messageId,
      `➕ <b>ДОБАВИТЬ СТУДЕНТА</b>
━━━━━━━━━━━━━━

Отправьте фамилию и имя одним сообщением.

<b>Пример:</b>
<code>Иванов Иван</code>`,
      {
        inline_keyboard: [
          [
            {
              text: "❌ Отмена",
              callback_data: "students"
            }
          ]
        ]
      }
    );
    return;
  }

  if (data === "students:delete") {
    await showStudentsDelete(
      env,
      chatId,
      messageId
    );
    return;
  }

  if (data.startsWith("students:delete_ask:")) {
    const studentId = Number(
      data.slice("students:delete_ask:".length)
    );

    const student = await getStudent(
      env,
      studentId
    );

    if (!student) return;

    await editMessage(
      env,
      chatId,
      messageId,
      `⚠️ <b>УДАЛИТЬ СТУДЕНТА?</b>

👤 ${escapeHtml(student.name)}

Студент исчезнет из активного списка.
История посещаемости сохранится.`,
      {
        inline_keyboard: [
          [
            {
              text: "✅ Да, удалить",
              callback_data:
                `students:delete_yes:${studentId}`
            }
          ],
          [
            {
              text: "❌ Отмена",
              callback_data: "students:delete"
            }
          ]
        ]
      }
    );
    return;
  }

  if (data.startsWith("students:delete_yes:")) {
    const studentId = Number(
      data.slice("students:delete_yes:".length)
    );

    await env.DB.prepare(
      "UPDATE students SET active = 0 WHERE id = ?"
    ).bind(studentId).run();

    await editMessage(
      env,
      chatId,
      messageId,
      "✅ <b>Студент удалён из активного списка</b>",
      {
        inline_keyboard: [
          [
            {
              text: "⬅️ К списку",
              callback_data: "students"
            }
          ]
        ]
      }
    );
    return;
  }

  if (data === "help") {
    await showHelp(
      env,
      chatId,
      messageId
    );
    return;
  }
}


// =====================================================
// ГЛАВНОЕ МЕНЮ
// =====================================================

async function showMainMenu(
  env,
  chatId,
  messageId = null
) {
  const today = todayYMD();

  const studentCount = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM students WHERE active = 1"
  ).first();

  const marked = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM attendance WHERE date = ?"
  ).bind(today).first();

  const duty = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM duty WHERE date = ?"
  ).bind(today).first();

  const total =
    Number(studentCount?.count || 0);

  const markedCount =
    Number(marked?.count || 0);

  const dutyCount =
    Number(duty?.count || 0);

  const text =
`👨‍🏫 <b>ЖУРНАЛ ГРУППЫ №102</b>
━━━━━━━━━━━━━━

📅 <b>${prettyDate(today)}</b>

👥 Студентов: <b>${total}</b>
📝 Отмечено сегодня: <b>${markedCount}/${total}</b>
🧹 Дежурных сегодня: <b>${dutyCount}</b>

Выберите раздел 👇`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "👥 Посещаемость",
          callback_data: "attendance"
        }
      ],
      [
        {
          text: "🧹 Дежурство",
          callback_data: "duty"
        }
      ],
      [
        {
          text: "📊 Статистика",
          callback_data: "stats"
        }
      ],
      [
        {
          text: "📋 Список группы",
          callback_data: "students"
        }
      ],
      [
        {
          text: "❓ Помощь",
          callback_data: "help"
        }
      ]
    ]
  };

  if (messageId) {
    await editMessage(
      env,
      chatId,
      messageId,
      text,
      keyboard
    );
  } else {
    await sendMessage(
      env,
      chatId,
      text,
      keyboard
    );
  }
}


// =====================================================
// ПОСЕЩАЕМОСТЬ
// =====================================================

async function showAttendance(
  env,
  chatId,
  messageId,
  date
) {
  const students = await getStudents(env);

  const rows = await env.DB.prepare(
    "SELECT student_id, status FROM attendance WHERE date = ?"
  ).bind(date).all();

  const statuses = new Map();

  for (const row of rows.results || []) {
    statuses.set(
      Number(row.student_id),
      row.status
    );
  }

  let present = 0;
  let absent = 0;
  let late = 0;
  let excused = 0;

  for (const status of statuses.values()) {
    if (status === "present") present++;
    if (status === "absent") absent++;
    if (status === "late") late++;
    if (status === "excused") excused++;
  }

  const buttons = students.map(
    student => [
      {
        text:
          `${statusIcon(
            statuses.get(student.id)
          )} ${student.name}`,

        callback_data:
          `attendance:toggle:${student.id}:${date}`
      }
    ]
  );

  buttons.push([
    {
      text: "✅ Все присутствуют",
      callback_data:
        `attendance:allpresent:${date}`
    }
  ]);

  buttons.push([
    {
      text: "🧹 Очистить отметки",
      callback_data:
        `attendance:clear:${date}`
    }
  ]);

  buttons.push([
    {
      text: "◀️",
      callback_data:
        `attendance:date:${previousSchoolDay(date)}`
    },
    {
      text: "📅 Сегодня",
      callback_data:
        `attendance:date:${todayYMD()}`
    },
    {
      text: "▶️",
      callback_data:
        `attendance:date:${nextSchoolDay(date)}`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Главное меню",
      callback_data: "main"
    }
  ]);

  await editMessage(
    env,
    chatId,
    messageId,
    `👥 <b>ПОСЕЩАЕМОСТЬ</b>
━━━━━━━━━━━━━━

📅 <b>${prettyDate(date)}</b>

✅ Присутствуют: <b>${present}</b>
❌ Отсутствуют: <b>${absent}</b>
⏰ Опоздали: <b>${late}</b>
🏥 Уважительно: <b>${excused}</b>
➖ Не отмечено: <b>${students.length - statuses.size}</b>

Нажимайте на студента:

➖ → ✅ → ❌ → ⏰ → 🏥`,
    {
      inline_keyboard: buttons
    }
  );
}


async function toggleAttendance(
  env,
  studentId,
  date
) {
  const row = await env.DB.prepare(`
    SELECT status
    FROM attendance
    WHERE date = ?
    AND student_id = ?
  `).bind(
    date,
    studentId
  ).first();

  const next = nextStatus(
    row?.status || null
  );

  if (!next) {
    await env.DB.prepare(`
      DELETE FROM attendance
      WHERE date = ?
      AND student_id = ?
    `).bind(
      date,
      studentId
    ).run();

    return;
  }

  await env.DB.prepare(`
    INSERT INTO attendance(
      date,
      student_id,
      status
    )
    VALUES(?, ?, ?)

    ON CONFLICT(date, student_id)
    DO UPDATE SET status = excluded.status
  `).bind(
    date,
    studentId,
    next
  ).run();
}


function nextStatus(status) {
  const order = [
    null,
    "present",
    "absent",
    "late",
    "excused"
  ];

  const index = order.indexOf(status);

  if (index === -1) {
    return "present";
  }

  const nextIndex =
    (index + 1) % order.length;

  return order[nextIndex];
}


function statusIcon(status) {
  switch (status) {
    case "present":
      return "✅";

    case "absent":
      return "❌";

    case "late":
      return "⏰";

    case "excused":
      return "🏥";

    default:
      return "➖";
  }
}


// =====================================================
// ДЕЖУРСТВО
// =====================================================

async function showDuty(
  env,
  chatId,
  messageId,
  date
) {
  const students = await getStudents(env);

  const rows = await env.DB.prepare(
    "SELECT student_id FROM duty WHERE date = ?"
  ).bind(date).all();

  const selected = new Set(
    (rows.results || []).map(
      row => Number(row.student_id)
    )
  );

  const buttons = students.map(
    student => [
      {
        text:
          `${selected.has(student.id) ? "🧹" : "➖"} ${student.name}`,

        callback_data:
          `duty:toggle:${student.id}:${date}`
      }
    ]
  );

  buttons.push([
    {
      text: "🧹 Очистить дежурных",
      callback_data:
        `duty:clear:${date}`
    }
  ]);

  buttons.push([
    {
      text: "◀️",
      callback_data:
        `duty:date:${previousSchoolDay(date)}`
    },
    {
      text: "📅 Сегодня",
      callback_data:
        `duty:date:${todayYMD()}`
    },
    {
      text: "▶️",
      callback_data:
        `duty:date:${nextSchoolDay(date)}`
    }
  ]);

  buttons.push([
    {
      text: "⬅️ Главное меню",
      callback_data: "main"
    }
  ]);

  await editMessage(
    env,
    chatId,
    messageId,
    `🧹 <b>ДЕЖУРСТВО</b>
━━━━━━━━━━━━━━

📅 <b>${prettyDate(date)}</b>

🧹 Выбрано дежурных: <b>${selected.size}</b>

Нажмите на студента, чтобы назначить или снять дежурство.`,
    {
      inline_keyboard: buttons
    }
  );
}


async function toggleDuty(
  env,
  studentId,
  date
) {
  const row = await env.DB.prepare(`
    SELECT student_id
    FROM duty
    WHERE date = ?
    AND student_id = ?
  `).bind(
    date,
    studentId
  ).first();

  if (row) {
    await env.DB.prepare(`
      DELETE FROM duty
      WHERE date = ?
      AND student_id = ?
    `).bind(
      date,
      studentId
    ).run();

    return;
  }

  await env.DB.prepare(`
    INSERT INTO duty(
      date,
      student_id
    )
    VALUES(?, ?)
  `).bind(
    date,
    studentId
  ).run();
      }
// =====================================================
// СТАТИСТИКА
// =====================================================

async function showStatsStudents(
  env,
  chatId,
  messageId
) {
  const students = await getStudents(env);

  const buttons = [
    [
      {
        text: "👥 Общая статистика группы",
        callback_data: "stats:group"
      }
    ]
  ];

  for (const student of students) {
    buttons.push([
      {
        text: `👤 ${student.name}`,
        callback_data:
          `stats:student:${student.id}`
      }
    ]);
  }

  buttons.push([
    {
      text: "⬅️ Главное меню",
      callback_data: "main"
    }
  ]);

  await editMessage(
    env,
    chatId,
    messageId,
    `📊 <b>СТАТИСТИКА</b>
━━━━━━━━━━━━━━

Выберите студента или откройте общую статистику группы.`,
    {
      inline_keyboard: buttons
    }
  );
}


async function showStudentStats(
  env,
  chatId,
  messageId,
  studentId
) {
  const student = await getStudent(
    env,
    studentId
  );

  if (!student) return;

  const rows = await env.DB.prepare(`
    SELECT status, COUNT(*) AS count
    FROM attendance
    WHERE student_id = ?
    GROUP BY status
  `).bind(studentId).all();

  const counts = {
    present: 0,
    absent: 0,
    late: 0,
    excused: 0
  };

  for (const row of rows.results || []) {
    if (counts[row.status] !== undefined) {
      counts[row.status] =
        Number(row.count || 0);
    }
  }

  const dutyRow = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM duty
    WHERE student_id = ?
  `).bind(studentId).first();

  const total =
    counts.present +
    counts.absent +
    counts.late +
    counts.excused;

  const attendanceRate =
    total > 0
      ? Math.round(
          (
            (
              counts.present +
              counts.late
            ) / total
          ) * 100
        )
      : 0;

  await editMessage(
    env,
    chatId,
    messageId,
    `👤 <b>${escapeHtml(student.name)}</b>
━━━━━━━━━━━━━━

📊 <b>СТАТИСТИКА</b>

✅ Присутствовал: <b>${counts.present}</b>
❌ Отсутствовал: <b>${counts.absent}</b>
⏰ Опоздал: <b>${counts.late}</b>
🏥 Уважительно: <b>${counts.excused}</b>

📚 Всего отмеченных дней: <b>${total}</b>
📈 Посещаемость: <b>${attendanceRate}%</b>

🧹 Дежурил: <b>${Number(dutyRow?.count || 0)}</b> раз`,
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ К статистике",
            callback_data: "stats"
          }
        ]
      ]
    }
  );
}


async function showGroupStats(
  env,
  chatId,
  messageId
) {
  const rows = await env.DB.prepare(`
    SELECT status, COUNT(*) AS count
    FROM attendance
    GROUP BY status
  `).all();

  const counts = {
    present: 0,
    absent: 0,
    late: 0,
    excused: 0
  };

  for (const row of rows.results || []) {
    if (counts[row.status] !== undefined) {
      counts[row.status] =
        Number(row.count || 0);
    }
  }

  const dutyRow = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM duty"
  ).first();

  const daysRow = await env.DB.prepare(
    "SELECT COUNT(DISTINCT date) AS count FROM attendance"
  ).first();

  await editMessage(
    env,
    chatId,
    messageId,
    `👥 <b>СТАТИСТИКА ГРУППЫ</b>
━━━━━━━━━━━━━━

✅ Присутствий: <b>${counts.present}</b>
❌ Пропусков: <b>${counts.absent}</b>
⏰ Опозданий: <b>${counts.late}</b>
🏥 Уважительных: <b>${counts.excused}</b>

📅 Дней с отметками: <b>${Number(daysRow?.count || 0)}</b>
🧹 Всего дежурств: <b>${Number(dutyRow?.count || 0)}</b>`,
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ К статистике",
            callback_data: "stats"
          }
        ]
      ]
    }
  );
}


// =====================================================
// СПИСОК ГРУППЫ
// =====================================================

async function showStudentsMenu(
  env,
  chatId,
  messageId = null
) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM students WHERE active = 1"
  ).first();

  const text =
`📋 <b>СПИСОК ГРУППЫ №102</b>
━━━━━━━━━━━━━━

👥 Студентов: <b>${Number(row?.count || 0)}</b>

Здесь можно посмотреть список или изменить состав группы.`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "📋 Показать список",
          callback_data: "students:list"
        }
      ],
      [
        {
          text: "➕ Добавить студента",
          callback_data: "students:add"
        }
      ],
      [
        {
          text: "🗑 Удалить студента",
          callback_data: "students:delete"
        }
      ],
      [
        {
          text: "⬅️ Главное меню",
          callback_data: "main"
        }
      ]
    ]
  };

  if (messageId) {
    await editMessage(
      env,
      chatId,
      messageId,
      text,
      keyboard
    );
  } else {
    await sendMessage(
      env,
      chatId,
      text,
      keyboard
    );
  }
}


async function showStudentsList(
  env,
  chatId,
  messageId
) {
  const students = await getStudents(env);

  let text =
`📋 <b>ГРУППА №102</b>
━━━━━━━━━━━━━━

`;

  students.forEach(
    (student, index) => {
      text +=
        `${index + 1}. ${escapeHtml(student.name)}\n`;
    }
  );

  text +=
    `\n👥 Всего: <b>${students.length}</b>`;

  await editMessage(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ Назад",
            callback_data: "students"
          }
        ]
      ]
    }
  );
}


async function showStudentsDelete(
  env,
  chatId,
  messageId
) {
  const students = await getStudents(env);

  const buttons = students.map(
    student => [
      {
        text: `🗑 ${student.name}`,
        callback_data:
          `students:delete_ask:${student.id}`
      }
    ]
  );

  buttons.push([
    {
      text: "⬅️ Назад",
      callback_data: "students"
    }
  ]);

  await editMessage(
    env,
    chatId,
    messageId,
    `🗑 <b>УДАЛИТЬ СТУДЕНТА</b>
━━━━━━━━━━━━━━

Выберите студента:`,
    {
      inline_keyboard: buttons
    }
  );
}


async function getStudents(env) {
  const rows = await env.DB.prepare(`
    SELECT id, name
    FROM students
    WHERE active = 1
    ORDER BY name COLLATE NOCASE ASC
  `).all();

  return rows.results || [];
}


async function getStudent(
  env,
  studentId
) {
  return env.DB.prepare(`
    SELECT id, name
    FROM students
    WHERE id = ?
  `).bind(studentId).first();
}


// =====================================================
// ПОМОЩЬ
// =====================================================

async function showHelp(
  env,
  chatId,
  messageId
) {
  await editMessage(
    env,
    chatId,
    messageId,
    `❓ <b>КАК ПОЛЬЗОВАТЬСЯ</b>
━━━━━━━━━━━━━━

👥 <b>Посещаемость</b>

➖ не отмечен
✅ присутствует
❌ отсутствует
⏰ опоздал
🏥 уважительная причина

Нажимайте на фамилию студента, чтобы менять статус.

🧹 <b>Дежурство</b>

Можно выбрать одного или нескольких дежурных на нужную дату.

📊 <b>Статистика</b>

Показывает присутствия, пропуски, опоздания, уважительные причины и дежурства.

📋 <b>Список группы</b>

Можно добавлять новых студентов и удалять выбывших.

💾 <b>Все изменения сохраняются автоматически.</b>`,
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ Главное меню",
            callback_data: "main"
          }
        ]
      ]
    }
  );
}
// =====================================================
// ДАТЫ
// =====================================================

function todayYMD() {
  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(
      new Date()
    );

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}


function addDays(
  ymd,
  amount
) {
  const [y, m, d] =
    ymd.split("-").map(Number);

  const date = new Date(
    Date.UTC(
      y,
      m - 1,
      d + amount,
      12
    )
  );

  return date
    .toISOString()
    .slice(0, 10);
}


function weekdayNumber(ymd) {
  const [y, m, d] =
    ymd.split("-").map(Number);

  const date = new Date(
    Date.UTC(
      y,
      m - 1,
      d,
      12
    )
  );

  return (
    date.getUTCDay() + 6
  ) % 7;
}


function isSchoolDay(ymd) {
  return weekdayNumber(ymd) < 5;
}


function previousSchoolDay(date) {
  let result =
    addDays(date, -1);

  while (!isSchoolDay(result)) {
    result =
      addDays(result, -1);
  }

  return result;
}


function nextSchoolDay(date) {
  let result =
    addDays(date, 1);

  while (!isSchoolDay(result)) {
    result =
      addDays(result, 1);
  }

  return result;
}


function prettyDate(date) {
  const [y, m, d] =
    date.split("-").map(Number);

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
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =====================================================

function cleanName(text) {
  return String(text)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 100);
}


function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}


async function clearState(
  env,
  userId
) {
  await env.DB.prepare(
    "DELETE FROM states WHERE user_id = ?"
  ).bind(
    String(userId)
  ).run();
}


// =====================================================
// TELEGRAM API
// =====================================================

async function telegram(
  env,
  method,
  payload
) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",

      headers: {
        "content-type": "application/json"
      },

      body:
        JSON.stringify(payload)
    }
  );

  const data =
    await response.json();

  if (!data.ok) {
    console.error(
      `Telegram ${method}:`,
      JSON.stringify(data)
    );
  }

  return data;
}


async function answerCallback(
  env,
  callbackId
) {
  return telegram(
    env,
    "answerCallbackQuery",
    {
      callback_query_id:
        callbackId
    }
  );
}


async function sendMessage(
  env,
  chatId,
  text,
  keyboard = null
) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };

  if (keyboard) {
    payload.reply_markup =
      keyboard;
  }

  return telegram(
    env,
    "sendMessage",
    payload
  );
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
    payload.reply_markup =
      keyboard;
  }

  const result =
    await telegram(
      env,
      "editMessageText",
      payload
    );

  if (
    !result.ok &&
    !String(
      result.description || ""
    ).includes(
      "message is not modified"
    )
  ) {
    console.error(
      "Edit message failed:",
      result.description
    );
  }

  return result;
  }
