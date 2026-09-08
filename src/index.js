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

      return new Response("Teacher Journal Bot is running! 📚", {
        headers: {
          "content-type": "text/plain; charset=UTF-8"
        }
      });

    } catch (e) {
      console.error(e);
      return new Response("Worker error", { status: 500 });
    }
  }
};


// =====================================================
// DATABASE
// =====================================================

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

  await seedStudents(env);
}


async function seedStudents(env) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM students"
  ).first();

  if (Number(row?.count || 0) > 0) {
    return;
  }

  for (const name of DEFAULT_STUDENTS) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO students(name) VALUES(?)"
    ).bind(name).run();
  }
}


// =====================================================
// UPDATE
// =====================================================

async function handleUpdate(update, env) {
  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  if (update.message) {
    await handleMessage(update.message, env);
  }
}


// =====================================================
// ACCESS
// =====================================================

function isAdmin(env, userId) {
  return String(userId) === String(env.ADMIN_ID);
}


async function deny(env, chatId) {
  await sendMessage(
    env,
    chatId,
    `🔒 <b>Доступ закрыт</b>

Этот журнал предназначен только для преподавателя.`
  );
}


// =====================================================
// MESSAGES
// =====================================================

async function handleMessage(message, env) {
  if (!message.from) return;

  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const text = message.text || "";

  const command = text
    .split(/\s+/)[0]
    .split("@")[0]
    .toLowerCase();


  // ---------------- MY ID ----------------

  if (command === "/myid") {
    await sendMessage(
      env,
      chatId,
      `🆔 <b>Ваш Telegram ID</b>

<code>${escapeHtml(userId)}</code>`
    );
    return;
  }


  // ---------------- ACCESS ----------------

  if (!isAdmin(env, userId)) {
    await deny(env, chatId);
    return;
  }


  // ---------------- START ----------------

  if (command === "/start") {
    await clearState(env, userId);
    await showMainMenu(env, chatId);
    return;
  }


  // ---------------- ADD STUDENT STATE ----------------

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
        `⚠️ Имя слишком короткое.

Отправьте фамилию и имя, например:

<code>Иванов Иван</code>`
      );
      return;
    }

    try {
      await env.DB.prepare(
        "INSERT INTO students(name) VALUES(?)"
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
        `⚠️ Такой студент уже есть в списке.`
      );
    }

    return;
  }
}


// =====================================================
// CALLBACKS
// =====================================================

async function handleCallback(q, env) {
  if (!q.from || !q.message) return;

  const userId = String(q.from.id);
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const data = q.data || "";

  await answerCallback(env, q.id);

  if (!isAdmin(env, userId)) {
    await deny(env, chatId);
    return;
  }


  // ===================================================
  // MAIN
  // ===================================================

  if (data === "main") {
    await clearState(env, userId);
    await showMainMenu(env, chatId, messageId);
    return;
  }


  // ===================================================
  // ATTENDANCE
  // ===================================================

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
    const date = data.slice("attendance:date:".length);

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
    const date = data.slice("attendance:allpresent:".length);

    const students = await getStudents(env);

    for (const student of students) {
      await env.DB.prepare(`
        INSERT INTO attendance(date, student_id, status)
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
    const date = data.slice("attendance:clear:".length);

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


  // ===================================================
  // DUTY
  // ===================================================

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
    const date = data.slice("duty:date:".length);

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
    const date = data.slice("duty:clear:".length);

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


  // ===================================================
  // STATISTICS
  // ===================================================

  if (data === "stats") {
    await showStatsStudents(
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


  if (data === "stats:group") {
    await showGroupStats(
      env,
      chatId,
      messageId
    );
    return;
  }


  // ===================================================
  // STUDENTS
  // ===================================================

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

    const student = await getStudent(env, studentId);

    if (!student) return;

    await editMessage(
      env,
      chatId,
      messageId,
      `⚠️ <b>УДАЛИТЬ СТУДЕНТА?</b>

👤 ${escapeHtml(student.name)}

История посещаемости останется в базе, но студент исчезнет из активного списка.`,
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
      `✅ <b>Студент удалён из активного списка</b>`,
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


  // ===================================================
  // INFO
  // ===================================================

  if (data === "help") {
    await showHelp(
      env,
      chatId,
      messageId
    );
  }
}


// =====================================================
// MAIN MENU
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

  const total = Number(studentCount?.count || 0);
  const markedCount = Number(marked?.count || 0);
  const dutyCount = Number(duty?.count || 0);

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
// ATTENDANCE
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

  const buttons = students.map(student => {
    const status = statuses.get(student.id);

    return [
      {
        text:
          `${statusIcon(status)} ${student.name}`,
        callback_data:
          `attendance:toggle:${student.id}:${date}`
      }
    ];
  });

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

Нажимайте на студента для смены статуса:

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
    DO UPDATE SET
      status = excluded.status
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
// DUTY
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

  const buttons = students.map(student => [
    {
      text:
        `${selected.has(student.id) ? "🧹" : "➖"} ${student.name}`,
      callback_data:
        `duty:toggle:${student.id}:${date}`
    }
  ]);

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

Нажмите на фамилию, чтобы назначить или снять дежурство.`,
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
// STATISTICS
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
        callb
