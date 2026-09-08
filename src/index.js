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

      // ===============================================
      // УСТАНОВКА WEBHOOK
      // ===============================================

      if (
        request.method === "GET" &&
        url.pathname === "/setup"
      ) {
        const webhookUrl =
          `${url.origin}/webhook`;

        const result =
          await telegram(
            env,
            "setWebhook",
            {
              url: webhookUrl,
              allowed_updates: [
                "message",
                "callback_query"
              ]
            }
          );

        return textResponse(
          result.ok
            ? `Webhook установлен!\n${webhookUrl}`
            : `Ошибка:\n${JSON.stringify(result)}`
        );
      }

      // ===============================================
      // TELEGRAM WEBHOOK
      // ===============================================

      if (
        request.method === "POST" &&
        url.pathname === "/webhook"
      ) {
        const update =
          await request.json();

        await handleUpdate(
          update,
          env
        );

        return new Response("OK");
      }

      return textResponse(
        "Teacher Journal Bot v2 is running! 📚"
      );

    } catch (error) {
      console.error(error);

      return textResponse(
        "Worker error",
        500
      );
    }
  }
};


function textResponse(
  text,
  status = 200
) {
  return new Response(
    text,
    {
      status,

      headers: {
        "content-type":
          "text/plain; charset=UTF-8"
      }
    }
  );
}


// =====================================================
// БАЗА ДАННЫХ
// =====================================================

async function initDb(env) {

  // ---------------- STUDENTS ----------------

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1
    )
  `).run();


  // ---------------- ATTENDANCE ----------------

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


  // ---------------- DUTY ----------------

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


  // ---------------- STATES ----------------

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS states (
      user_id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      data TEXT
    )
  `).run();


  // ---------------- USERS ----------------

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      last_seen TEXT
    )
  `).run();


  // ---------------- ADMINS ----------------

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admins (
      user_id TEXT PRIMARY KEY,
      added_at TEXT NOT NULL
    )
  `).run();


  // ===============================================
  // ПЕРВОНАЧАЛЬНЫЙ СПИСОК ГРУППЫ
  // ===============================================

  const studentCount =
    await env.DB.prepare(
      `
      SELECT COUNT(*) AS count
      FROM students
      `
    ).first();

  if (
    Number(
      studentCount?.count || 0
    ) === 0
  ) {
    for (
      const name
      of DEFAULT_STUDENTS
    ) {
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


// =====================================================
// ОБРАБОТКА TELEGRAM UPDATE
// =====================================================

async function handleUpdate(
  update,
  env
) {
  try {

    if (update.callback_query) {

      await rememberUser(
        env,
        update.callback_query.from
      );

      await handleCallback(
        update.callback_query,
        env
      );

      return;
    }


    if (update.message) {

      await rememberUser(
        env,
        update.message.from
      );

      await handleMessage(
        update.message,
        env
      );
    }

  } catch (error) {
    console.error(
      "Update error:",
      error
    );
  }
}


// =====================================================
// СОХРАНЕНИЕ ПОЛЬЗОВАТЕЛЕЙ
// =====================================================

async function rememberUser(
  env,
  user
) {
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
    .bind(
      String(user.id),

      user.first_name || "",

      user.last_name || "",

      user.username || "",

      new Date()
        .toISOString()
    )
    .run();
}


// =====================================================
// ДОСТУП
// =====================================================

function isOwner(
  env,
  userId
) {
  return (
    String(userId) ===
    String(env.ADMIN_ID)
  );
}


async function isAdmin(
  env,
  userId
) {

  // Владелец всегда имеет доступ
  if (
    isOwner(
      env,
      userId
    )
  ) {
    return true;
  }


  // Проверяем дополнительных админов
  const row =
    await env.DB.prepare(`
      SELECT user_id
      FROM admins
      WHERE user_id = ?
    `)
      .bind(
        String(userId)
      )
      .first();

  return Boolean(row);
}


// =====================================================
// ОБЫЧНЫЕ СООБЩЕНИЯ
// =====================================================

async function handleMessage(
  message,
  env
) {
  if (!message.from) {
    return;
  }

  const userId =
    String(
      message.from.id
    );

  const chatId =
    message.chat.id;

  const text =
    message.text || "";

  const command =
    text
      .split(/\s+/)[0]
      .split("@")[0]
      .toLowerCase();


  // ===============================================
  // /myid
  // ===============================================

  if (
    command === "/myid"
  ) {
    await sendMessage(
      env,
      chatId,
      `🆔 <b>Ваш Telegram ID</b>

<code>${escapeHtml(userId)}</code>`
    );

    return;
  }


  // ===============================================
  // ПРОВЕРКА ДОСТУПА
  // ===============================================

  const allowed =
    await isAdmin(
      env,
      userId
    );


  if (!allowed) {

    await sendMessage(
      env,
      chatId,
      `🔒 <b>Доступ к журналу закрыт</b>

Ваш профиль сохранён.

👑 Владелец бота теперь сможет добавить вас в список преподавателей.`
    );

    return;
  }


  // ===============================================
  // /start
  // ===============================================

  if (
    command === "/start"
  ) {
    await clearState(
      env,
      userId
    );

    await showMainMenu(
      env,
      chatId
    );

    return;
  }


  // ===============================================
  // ТЕКУЩЕЕ СОСТОЯНИЕ
  // ===============================================

  const state =
    await env.DB.prepare(`
      SELECT
        action,
        data

      FROM states

      WHERE user_id = ?
    `)
      .bind(userId)
      .first();


  // ===============================================
  // ДОБАВЛЕНИЕ СТУДЕНТА
  // ===============================================

  if (
    state?.action ===
      "await_student" &&

    text &&

    !text.startsWith("/")
  ) {

    const name =
      cleanName(text);


    if (
      name.length < 3
    ) {
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

      const existing =
        await env.DB.prepare(`
          SELECT
            id,
            active

          FROM students

          WHERE name = ?
        `)
          .bind(name)
          .first();


      // Если студент был удалён —
      // возвращаем его обратно

      if (
        existing &&
        Number(existing.active) === 0
      ) {

        await env.DB.prepare(`
          UPDATE students
          SET active = 1
          WHERE id = ?
        `)
          .bind(
            existing.id
          )
          .run();

      } else if (!existing) {

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

      } else {

        throw new Error(
          "Student already exists"
        );
      }


      await clearState(
        env,
        userId
      );


      await sendMessage(
        env,
        chatId,
        `✅ <b>Студент добавлен</b>

👤 ${escapeHtml(name)}`
      );


      await showStudentsMenu(
        env,
        chatId
      );

    } catch {

      await sendMessage(
        env,
        chatId,
        `⚠️ Этот студент уже есть в активном списке.`
      );
    }

    return;
  }
}
// =====================================================
// CALLBACK-КНОПКИ
// =====================================================

async function handleCallback(
  q,
  env
) {
  if (
    !q.from ||
    !q.message
  ) {
    return;
  }

  const userId =
    String(q.from.id);

  const chatId =
    q.message.chat.id;

  const messageId =
    q.message.message_id;

  const data =
    q.data || "";


  // Убираем "часики" на кнопке Telegram
  await answerCallback(
    env,
    q.id
  );


  // ===================================================
  // ПРОВЕРКА ДОСТУПА
  // ===================================================

  const allowed =
    await isAdmin(
      env,
      userId
    );


  if (!allowed) {

    await answerCallback(
      env,
      q.id,
      "🔒 Нет доступа"
    );

    return;
  }


  // ===================================================
  // ГЛАВНОЕ МЕНЮ
  // ===================================================

  if (
    data === "main"
  ) {

    await clearState(
      env,
      userId
    );

    await showMainMenu(
      env,
      chatId,
      messageId
    );

    return;
  }


  // ===================================================
  // ПОСЕЩАЕМОСТЬ — СЕГОДНЯ
  // ===================================================

  if (
    data === "attendance"
  ) {

    await showAttendance(
      env,
      chatId,
      messageId,
      localDate()
    );

    return;
  }


  // ===================================================
  // ПОСЕЩАЕМОСТЬ — КОНКРЕТНАЯ ДАТА
  // ===================================================

  if (
    data.startsWith(
      "attendance:"
    )
  ) {

    const date =
      data.split(":")[1];

    if (
      isValidDate(
        date
      )
    ) {
      await showAttendance(
        env,
        chatId,
        messageId,
        date
      );
    }

    return;
  }


  // ===================================================
  // ИЗМЕНЕНИЕ СТАТУСА СТУДЕНТА
  // ===================================================

  if (
    data.startsWith(
      "att:"
    )
  ) {

    const parts =
      data.split(":");

    const date =
      parts[1];

    const studentId =
      Number(parts[2]);


    if (
      !isValidDate(date) ||
      !studentId
    ) {
      return;
    }


    await cycleAttendance(
      env,
      date,
      studentId
    );


    await showAttendance(
      env,
      chatId,
      messageId,
      date
    );

    return;
  }


  // ===================================================
  // ВСЕ ПРИСУТСТВУЮТ
  // ===================================================

  if (
    data.startsWith(
      "allpresent:"
    )
  ) {

    const date =
      data.split(":")[1];


    if (
      !isValidDate(date)
    ) {
      return;
    }


    const students =
      await getActiveStudents(
        env
      );


    for (
      const student
      of students
    ) {

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
        .bind(
          date,
          student.id
        )
        .run();
    }


    await showAttendance(
      env,
      chatId,
      messageId,
      date
    );

    return;
  }


  // ===================================================
  // ЗАПРОС НА ОЧИСТКУ ДНЯ
  // ===================================================

  if (
    data.startsWith(
      "clear_att:"
    )
  ) {

    const date =
      data.split(":")[1];


    if (
      !isValidDate(date)
    ) {
      return;
    }


    await editMessage(
      env,
      chatId,
      messageId,

      `🛡 <b>Очистить посещаемость?</b>

📅 ${escapeHtml(
        formatDateLong(date)
      )}

Все отметки за этот день будут удалены.

<b>Это действие требует подтверждения.</b>`,

      {
        inline_keyboard: [

          [
            {
              text:
                "🗑 Да, очистить",

              callback_data:
                `clear_att_yes:${date}`
            }
          ],

          [
            {
              text:
                "❌ Отмена",

              callback_data:
                `attendance:${date}`
            }
          ]

        ]
      }
    );

    return;
  }


  // ===================================================
  // ПОДТВЕРЖДЁННАЯ ОЧИСТКА
  // ===================================================

  if (
    data.startsWith(
      "clear_att_yes:"
    )
  ) {

    const date =
      data.split(":")[1];


    if (
      !isValidDate(date)
    ) {
      return;
    }


    await env.DB.prepare(`
      DELETE FROM attendance
      WHERE date = ?
    `)
      .bind(date)
      .run();


    await showAttendance(
      env,
      chatId,
      messageId,
      date
    );

    return;
  }


  // ===================================================
  // КОГО НЕТ — СЕГОДНЯ
  // ===================================================

  if (
    data === "missing"
  ) {

    await showMissing(
      env,
      chatId,
      messageId,
      localDate()
    );

    return;
  }


  // ===================================================
  // КОГО НЕТ — ДРУГАЯ ДАТА
  // ===================================================

  if (
    data.startsWith(
      "missing:"
    )
  ) {

    const date =
      data.split(":")[1];


    if (
      isValidDate(date)
    ) {
      await showMissing(
        env,
        chatId,
        messageId,
        date
      );
    }

    return;
  }


  // ===================================================
  // ОСТАЛЬНЫЕ РАЗДЕЛЫ
  // Они будут обработаны в следующих частях
  // ===================================================

  if (
    data === "history"
  ) {

    await showHistory(
      env,
      chatId,
      messageId
    );

    return;
  }


  if (
    data === "duty"
  ) {

    await showDuty(
      env,
      chatId,
      messageId,
      localDate()
    );

    return;
  }


  if (
    data === "stats"
  ) {

    await showStatsMenu(
      env,
      chatId,
      messageId
    );

    return;
  }


  if (
    data === "students"
  ) {

    await showStudentsMenu(
      env,
      chatId,
      messageId
    );

    return;
  }


  if (
    data === "excel"
  ) {

    await showExcelMenu(
      env,
      chatId,
      messageId
    );

    return;
  }


  if (
    data === "settings"
  ) {

    await showSettings(
      env,
      chatId,
      messageId,
      userId
    );

    return;
  }
  // ДОПОЛНИТЕЛЬНЫЕ CALLBACK-МАРШРУТЫ

  if (
    await handleExtraCallback(
      data,
      env,
      chatId,
      messageId,
      userId
    )
  ) {
    return;
  }

  if (
    await handlePart5Callback(
      data,
      env,
      chatId,
      messageId,
      userId
    )
  ) {
    return;
  }

  if (
    await handlePart6Callback(
      data,
      env,
      chatId,
      messageId,
      userId
    )
  ) {
    return;
  }}


// =====================================================
// ПОСЕЩАЕМОСТЬ
// =====================================================

async function showAttendance(
  env,
  chatId,
  messageId,
  date
) {

  const students =
    await getActiveStudents(
      env
    );


  const rows =
    await env.DB.prepare(`
      SELECT
        student_id,
        status

      FROM attendance

      WHERE date = ?
    `)
      .bind(date)
      .all();


  const statusMap =
    new Map();


  for (
    const row
    of rows.results || []
  ) {

    statusMap.set(
      Number(row.student_id),
      row.status
    );
  }


  let present = 0;
  let absent = 0;
  let late = 0;
  let excused = 0;
  let unmarked = 0;


  for (
    const student
    of students
  ) {

    const status =
      statusMap.get(
        Number(student.id)
      );


    if (
      status === "present"
    ) {
      present++;
    }

    else if (
      status === "absent"
    ) {
      absent++;
    }

    else if (
      status === "late"
    ) {
      late++;
    }

    else if (
      status === "excused"
    ) {
      excused++;
    }

    else {
      unmarked++;
    }
  }


  const keyboard = [];


  // ===================================================
  // ДАТЫ
  // ===================================================

  const previous =
    previousWorkday(date);

  const next =
    nextWorkday(date);


  keyboard.push([
    {
      text:
        `◀️ ${formatDateShort(
          previous
        )}`,

      callback_data:
        `attendance:${previous}`
    },

    {
      text:
        isToday(date)
          ? `📅 Сегодня ${formatDateShort(date)}`
          : `📅 ${formatDateShort(date)}`,

      callback_data:
        `attendance:${localDate()}`
    },

    {
      text:
        `${formatDateShort(
          next
        )} ▶️`,

      callback_data:
        `attendance:${next}`
    }
  ]);


  // ===================================================
  // БЫСТРЫЕ ДАТЫ
  // ===================================================

  const tomorrow =
    nextWorkday(
      localDate()
    );

  const afterTomorrow =
    nextWorkday(
      tomorrow
    );


  keyboard.push([
    {
      text:
        `Сегодня ${formatDateShort(
          localDate()
        )}`,

      callback_data:
        `attendance:${localDate()}`
    },

    {
      text:
        `Завтра ${formatDateShort(
          tomorrow
        )}`,

      callback_data:
        `attendance:${tomorrow}`
    }
  ]);


  keyboard.push([
    {
      text:
        `Послезавтра ${formatDateShort(
          afterTomorrow
        )}`,

      callback_data:
        `attendance:${afterTomorrow}`
    }
  ]);


  // ===================================================
  // КНОПКИ СТУДЕНТОВ
  // ===================================================

  for (
    const student
    of students
  ) {

    const status =
      statusMap.get(
        Number(student.id)
      ) || "none";


    keyboard.push([
      {
        text:
          `${statusEmoji(status)} ${student.name}`,

        callback_data:
          `att:${date}:${student.id}`
      }
    ]);
  }


  // ===================================================
  // БЫСТРЫЕ ДЕЙСТВИЯ
  // ===================================================

  keyboard.push([
    {
      text:
        "✅ Все есть",

      callback_data:
        `allpresent:${date}`
    },

    {
      text:
        "👀 Кого нет",

      callback_data:
        `missing:${date}`
    }
  ]);


  keyboard.push([
    {
      text:
        "🗑 Очистить день",

      callback_data:
        `clear_att:${date}`
    }
  ]);


  keyboard.push([
    {
      text:
        "🏠 Главное меню",

      callback_data:
        "main"
    }
  ]);


  const text =
`👥 <b>ПОСЕЩАЕМОСТЬ</b>

📅 <b>${escapeHtml(
  formatDateLong(date)
)}</b>

━━━━━━━━━━━━━━

✅ Есть: <b>${present}</b>
❌ Нет: <b>${absent}</b>
⏰ Опоздали: <b>${late}</b>
🏥 Уважительно: <b>${excused}</b>
➖ Не отмечено: <b>${unmarked}</b>

👥 Всего: <b>${students.length}</b>

━━━━━━━━━━━━━━

Нажимайте на студента для смены статуса:

➖ → ✅ → ❌ → ⏰ → 🏥 → ➖`;


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard:
        keyboard
    }
  );
}


// =====================================================
// СМЕНА СТАТУСА
// =====================================================

async function cycleAttendance(
  env,
  date,
  studentId
) {

  const current =
    await env.DB.prepare(`
      SELECT status

      FROM attendance

      WHERE
        date = ?
        AND
        student_id = ?
    `)
      .bind(
        date,
        studentId
      )
      .first();


  const oldStatus =
    current?.status ||
    "none";


  const nextStatus =
    {
      none:
        "present",

      present:
        "absent",

      absent:
        "late",

      late:
        "excused",

      excused:
        "none"
    }[oldStatus] ||
    "present";


  // Если вернулись на ➖ —
  // удаляем запись полностью

  if (
    nextStatus === "none"
  ) {

    await env.DB.prepare(`
      DELETE FROM attendance

      WHERE
        date = ?
        AND
        student_id = ?
    `)
      .bind(
        date,
        studentId
      )
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
    .bind(
      date,
      studentId,
      nextStatus
    )
    .run();
}


// =====================================================
// КОГО НЕТ
// =====================================================

async function showMissing(
  env,
  chatId,
  messageId,
  date
) {

  const students =
    await env.DB.prepare(`
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
        s.name COLLATE NOCASE
    `)
      .bind(date)
      .all();


  const absent = [];
  const late = [];
  const excused = [];
  const unmarked = [];


  for (
    const student
    of students.results || []
  ) {

    if (
      student.status ===
      "absent"
    ) {

      absent.push(
        student.name
      );
    }

    else if (
      student.status ===
      "late"
    ) {

      late.push(
        student.name
      );
    }

    else if (
      student.status ===
      "excused"
    ) {

      excused.push(
        student.name
      );
    }

    else if (
      !student.status
    ) {

      unmarked.push(
        student.name
      );
    }
  }


  const previous =
    previousWorkday(date);

  const next =
    nextWorkday(date);


  const keyboard = {

    inline_keyboard: [

      [
        {
          text:
            `◀️ ${formatDateShort(
              previous
            )}`,

          callback_data:
            `missing:${previous}`
        },

        {
          text:
            isToday(date)
              ? "📅 Сегодня"
              : formatDateShort(date),

          callback_data:
            `missing:${localDate()}`
        },

        {
          text:
            `${formatDateShort(
              next
            )} ▶️`,

          callback_data:
            `missing:${next}`
        }
      ],

      [
        {
          text:
            "👥 Посещаемость",

          callback_data:
            `attendance:${date}`
        }
      ],

      [
        {
          text:
            "🏠 Главное меню",

          callback_data:
            "main"
        }
      ]

    ]
  };


  let text =
`👀 <b>КОГО НЕТ</b>

📅 <b>${escapeHtml(
  formatDateLong(date)
)}</b>

━━━━━━━━━━━━━━`;


  text +=
    `\n\n❌ <b>ОТСУТСТВУЮТ — ${absent.length}</b>`;


  if (
    absent.length
  ) {

    text +=
      "\n" +
      absent
        .map(
          name =>
            `• ${escapeHtml(name)}`
        )
        .join("\n");

  } else {

    text +=
      "\nНикого 🎉";
  }


  text +=
    `\n\n⏰ <b>ОПОЗДАЛИ — ${late.length}</b>`;


  if (
    late.length
  ) {

    text +=
      "\n" +
      late
        .map(
          name =>
            `• ${escapeHtml(name)}`
        )
        .join("\n");

  } else {

    text +=
      "\nНикого";
  }


  text +=
    `\n\n🏥 <b>УВАЖИТЕЛЬНО — ${excused.length}</b>`;


  if (
    excused.length
  ) {

    text +=
      "\n" +
      excused
        .map(
          name =>
            `• ${escapeHtml(name)}`
        )
        .join("\n");

  } else {

    text +=
      "\nНикого";
  }


  if (
    unmarked.length
  ) {

    text +=
      `\n\n⚠️ <b>НЕ ОТМЕЧЕНО — ${unmarked.length}</b>`;

    text +=
      "\n" +
      unmarked
        .map(
          name =>
            `• ${escapeHtml(name)}`
        )
        .join("\n");
  }


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    keyboard
  );
}


// =====================================================
// СТАТУСЫ ПОСЕЩАЕМОСТИ
// =====================================================

function statusEmoji(
  status
) {

  if (
    status === "present"
  ) {
    return "✅";
  }


  if (
    status === "absent"
  ) {
    return "❌";
  }


  if (
    status === "late"
  ) {
    return "⏰";
  }


  if (
    status === "excused"
  ) {
    return "🏥";
  }


  return "➖";
}


// =====================================================
// ПОЛУЧИТЬ АКТИВНЫХ СТУДЕНТОВ
// =====================================================

async function getActiveStudents(
  env
) {

  const result =
    await env.DB.prepare(`
      SELECT
        id,
        name

      FROM students

      WHERE active = 1

      ORDER BY
        name COLLATE NOCASE
    `)
      .all();


  return (
    result.results || []
  );
}
// =====================================================
// ИСТОРИЯ ПОСЕЩАЕМОСТИ
// =====================================================

async function showHistory(
  env,
  chatId,
  messageId
) {

  const result =
    await env.DB.prepare(`
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
            WHEN a.status = 'excused'
            THEN 1 ELSE 0
          END
        ) AS excused,

        COUNT(*) AS marked

      FROM attendance a

      GROUP BY a.date

      ORDER BY a.date DESC

      LIMIT 20
    `)
      .all();


  const days =
    result.results || [];


  let text =
`📆 <b>ИСТОРИЯ</b>

Последние отмеченные учебные дни.

━━━━━━━━━━━━━━`;


  const keyboard = [];


  if (
    days.length === 0
  ) {

    text +=
      `\n\nПока история пустая.

После первой переклички здесь появятся дни.`;

  } else {

    for (
      const day
      of days
    ) {

      const date =
        day.date;


      text +=
`\n\n📅 <b>${escapeHtml(
  formatDateLong(date)
)}</b>

✅ ${Number(day.present || 0)}
   ❌ ${Number(day.absent || 0)}
   ⏰ ${Number(day.late || 0)}
   🏥 ${Number(day.excused || 0)}`;


      keyboard.push([
        {
          text:
            `📅 ${formatDateShort(date)} • открыть`,

          callback_data:
            `history_day:${date}`
        }
      ]);
    }
  }


  keyboard.push([
    {
      text:
        "🏠 Главное меню",

      callback_data:
        "main"
    }
  ]);


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard:
        keyboard
    }
  );
}


// =====================================================
// КОНКРЕТНЫЙ ДЕНЬ ИЗ ИСТОРИИ
// =====================================================

async function showHistoryDay(
  env,
  chatId,
  messageId,
  date
) {

  const result =
    await env.DB.prepare(`
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
        s.name COLLATE NOCASE
    `)
      .bind(date)
      .all();


  const rows =
    result.results || [];


  let text =
`📋 <b>ИТОГ ДНЯ</b>

📅 <b>${escapeHtml(
  formatDateLong(date)
)}</b>

━━━━━━━━━━━━━━`;


  let present = 0;
  let absent = 0;
  let late = 0;
  let excused = 0;
  let unmarked = 0;


  for (
    const row
    of rows
  ) {

    const status =
      row.status || "none";


    if (
      status === "present"
    ) {
      present++;
    }

    else if (
      status === "absent"
    ) {
      absent++;
    }

    else if (
      status === "late"
    ) {
      late++;
    }

    else if (
      status === "excused"
    ) {
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
🏥 Уважительно: <b>${excused}</b>
➖ Не отмечено: <b>${unmarked}</b>`;


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [

        [
          {
            text:
              "👥 Открыть посещаемость",

            callback_data:
              `attendance:${date}`
          }
        ],

        [
          {
            text:
              "👀 Кого нет",

            callback_data:
              `missing:${date}`
          }
        ],

        [
          {
            text:
              "⬅️ История",

            callback_data:
              "history"
          },

          {
            text:
              "🏠 Меню",

            callback_data:
              "main"
          }
        ]

      ]
    }
  );
}


// =====================================================
// СПИСОК СТУДЕНТОВ
// =====================================================

async function showStudentsMenu(
  env,
  chatId,
  messageId = null
) {

  const students =
    await getActiveStudents(
      env
    );


  let text =
`👨‍🎓 <b>СТУДЕНТЫ ГРУППЫ №102</b>

👥 Всего: <b>${students.length}</b>

Нажмите на студента, чтобы открыть его карточку.`;


  const keyboard = [];


  for (
    const student
    of students
  ) {

    keyboard.push([
      {
        text:
          `👤 ${student.name}`,

        callback_data:
          `student:${student.id}`
      }
    ]);
  }


  keyboard.push([
    {
      text:
        "➕ Добавить студента",

      callback_data:
        "student_add"
    }
  ]);


  keyboard.push([
    {
      text:
        "🏠 Главное меню",

      callback_data:
        "main"
    }
  ]);


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard:
        keyboard
    }
  );
}


// =====================================================
// КАРТОЧКА СТУДЕНТА
// =====================================================

async function showStudentCard(
  env,
  chatId,
  messageId,
  studentId
) {

  const student =
    await env.DB.prepare(`
      SELECT
        id,
        name,
        active

      FROM students

      WHERE id = ?
    `)
      .bind(studentId)
      .first();


  if (
    !student ||
    Number(student.active) !== 1
  ) {

    await editOrSend(
      env,
      chatId,
      messageId,

      `⚠️ Студент не найден.`,

      {
        inline_keyboard: [
          [
            {
              text:
                "⬅️ К студентам",

              callback_data:
                "students"
            }
          ]
        ]
      }
    );

    return;
  }


  const stats =
    await env.DB.prepare(`
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
            WHEN status = 'excused'
            THEN 1 ELSE 0
          END
        ) AS excused,

        COUNT(*) AS total

      FROM attendance

      WHERE student_id = ?
    `)
      .bind(studentId)
      .first();


  const duty =
    await env.DB.prepare(`
      SELECT
        COUNT(*) AS count

      FROM duty

      WHERE student_id = ?
    `)
      .bind(studentId)
      .first();


  const present =
    Number(
      stats?.present || 0
    );

  const absent =
    Number(
      stats?.absent || 0
    );

  const late =
    Number(
      stats?.late || 0
    );

  const excused =
    Number(
      stats?.excused || 0
    );

  const total =
    Number(
      stats?.total || 0
    );


  // Уважительная причина не портит
  // процент посещаемости.
  const counted =
    present +
    absent +
    late;


  const attendancePercent =
    counted > 0
      ? Math.round(
          (
            (
              present +
              late
            ) /
            counted
          ) * 100
        )
      : 0;


  const recent =
    await env.DB.prepare(`
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


  let recentText =
    "";


  for (
    const row
    of recent.results || []
  ) {

    recentText +=
      `\n${statusEmoji(row.status)} ${formatDateShort(row.date)}`;
  }


  if (
    !recentText
  ) {

    recentText =
      "\nПока нет отметок.";
  }


  const text =
`👤 <b>${escapeHtml(
  student.name
)}</b>

━━━━━━━━━━━━━━

📊 <b>ОБЩАЯ СТАТИСТИКА</b>

✅ Присутствовал: <b>${present}</b>
❌ Отсутствовал: <b>${absent}</b>
⏰ Опоздал: <b>${late}</b>
🏥 Уважительно: <b>${excused}</b>

📈 Посещаемость: <b>${attendancePercent}%</b>

🧹 Дежурств: <b>${Number(
  duty?.count || 0
)}</b>

📝 Всего отметок: <b>${total}</b>

━━━━━━━━━━━━━━

🕘 <b>ПОСЛЕДНИЕ ОТМЕТКИ</b>
${recentText}`;


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [

        [
          {
            text:
              "❌ Даты пропусков",

            callback_data:
              `student_absences:${studentId}`
          }
        ],

        [
          {
            text:
              "📊 Статистика",

            callback_data:
              `student_stats:${studentId}`
          },

          {
            text:
              "🧹 Дежурства",

            callback_data:
              `student_duty:${studentId}`
          }
        ],

        [
          {
            text:
              "🗑 Удалить",

            callback_data:
              `student_delete:${studentId}`
          }
        ],

        [
          {
            text:
              "⬅️ Студенты",

            callback_data:
              "students"
          },

          {
            text:
              "🏠 Меню",

            callback_data:
              "main"
          }
        ]

      ]
    }
  );
}


// =====================================================
// ДАТЫ ПРОПУСКОВ СТУДЕНТА
// =====================================================

async function showStudentAbsences(
  env,
  chatId,
  messageId,
  studentId
) {

  const student =
    await env.DB.prepare(`
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


  const result =
    await env.DB.prepare(`
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


  const dates =
    result.results || [];


  let text =
`❌ <b>ПРОПУСКИ</b>

👤 ${escapeHtml(
  student.name
)}

━━━━━━━━━━━━━━`;


  if (
    dates.length === 0
  ) {

    text +=
      `\n\n🎉 Нет отмеченных пропусков.`;

  } else {

    for (
      const row
      of dates
    ) {

      text +=
        `\n\n❌ ${escapeHtml(
          formatDateLong(row.date)
        )}`;
    }
  }


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [

        [
          {
            text:
              "⬅️ Карточка студента",

            callback_data:
              `student:${studentId}`
          }
        ],

        [
          {
            text:
              "🏠 Главное меню",

            callback_data:
              "main"
          }
        ]

      ]
    }
  );
}


// =====================================================
// СТАТИСТИКА ОДНОГО СТУДЕНТА
// =====================================================

async function showStudentStats(
  env,
  chatId,
  messageId,
  studentId
) {

  const student =
    await env.DB.prepare(`
      SELECT name

      FROM students

      WHERE id = ?
    `)
      .bind(studentId)
      .first();


  if (!student) {
    return;
  }


  await editOrSend(
    env,
    chatId,
    messageId,

`📊 <b>СТАТИСТИКА</b>

👤 ${escapeHtml(
  student.name
)}

Выберите период 👇`,

    {
      inline_keyboard: [

        [
          {
            text:
              "📅 7 дней",

            callback_data:
              `student_period:${studentId}:7`
          },

          {
            text:
              "📅 30 дней",

            callback_data:
              `student_period:${studentId}:30`
          }
        ],

        [
          {
            text:
              "📚 Всё время",

            callback_data:
              `student_period:${studentId}:all`
          }
        ],

        [
          {
            text:
              "⬅️ Карточка",

            callback_data:
              `student:${studentId}`
          }
        ]

      ]
    }
  );
}


// =====================================================
// ДЕЖУРСТВА КОНКРЕТНОГО СТУДЕНТА
// =====================================================

async function showStudentDutyHistory(
  env,
  chatId,
  messageId,
  studentId
) {

  const student =
    await env.DB.prepare(`
      SELECT name

      FROM students

      WHERE id = ?
    `)
      .bind(studentId)
      .first();


  if (!student) {
    return;
  }


  const result =
    await env.DB.prepare(`
      SELECT date

      FROM duty

      WHERE student_id = ?

      ORDER BY date DESC

      LIMIT 20
    `)
      .bind(studentId)
      .all();


  const rows =
    result.results || [];


  let text =
`🧹 <b>ДЕЖУРСТВА</b>

👤 ${escapeHtml(
  student.name
)}

━━━━━━━━━━━━━━`;


  if (
    rows.length === 0
  ) {

    text +=
      `\n\nПока не дежурил.`;

  } else {

    for (
      const row
      of rows
    ) {

      text +=
        `\n\n🧹 ${escapeHtml(
          formatDateLong(row.date)
        )}`;
    }
  }


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [

        [
          {
            text:
              "⬅️ Карточка",

            callback_data:
              `student:${studentId}`
          }
        ],

        [
          {
            text:
              "🏠 Главное меню",

            callback_data:
              "main"
          }
        ]

      ]
    }
  );
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

  const students =
    await getActiveStudents(env);


  const dutyResult =
    await env.DB.prepare(`
      SELECT student_id
      FROM duty
      WHERE date = ?
    `)
      .bind(date)
      .all();


  const selected =
    new Set(
      (dutyResult.results || [])
        .map(
          row =>
            Number(row.student_id)
        )
    );


  // ---------------------------------------------------
// Считаем количество дежурств каждого студента
// и дату последнего дежурства
// ---------------------------------------------------

  const statsResult =
    await env.DB.prepare(`
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


  const stats =
    statsResult.results || [];


  // ---------------------------------------------------
// Сортировка для очереди:
//
// 1. Кто вообще не дежурил
// 2. У кого меньше дежурств
// 3. Кто дежурил раньше
// ---------------------------------------------------

  stats.sort(
    (a, b) => {

      const aCount =
        Number(a.duty_count || 0);

      const bCount =
        Number(b.duty_count || 0);


      if (
        aCount !== bCount
      ) {

        return (
          aCount - bCount
        );
      }


      if (
        !a.last_duty &&
        b.last_duty
      ) {
        return -1;
      }


      if (
        a.last_duty &&
        !b.last_duty
      ) {
        return 1;
      }


      if (
        a.last_duty &&
        b.last_duty
      ) {

        return (
          String(a.last_duty)
            .localeCompare(
              String(b.last_duty)
            )
        );
      }


      return (
        String(a.name)
          .localeCompare(
            String(b.name),
            "ru"
          )
      );
    }
  );


  const recommended =
    stats
      .filter(
        student =>
          !selected.has(
            Number(student.id)
          )
      )
      .slice(0, 2);


  let text =
`🧹 <b>ДЕЖУРСТВО</b>

📅 <b>${escapeHtml(
  formatDateLong(date)
)}</b>

━━━━━━━━━━━━━━`;


  if (
    selected.size === 0
  ) {

    text +=
      `\n\n👥 Дежурные пока не выбраны.`;

  } else {

    text +=
      `\n\n✅ <b>Сегодня дежурят:</b>`;


    for (
      const student
      of students
    ) {

      if (
        selected.has(
          Number(student.id)
        )
      ) {

        text +=
          `\n• ${escapeHtml(
            student.name
          )}`;
      }
    }
  }


  // ---------------------------------------------------
// Рекомендация по очереди
// ---------------------------------------------------

  if (
    recommended.length
  ) {

    text +=
      `\n\n💡 <b>По очереди следующие:</b>`;


    for (
      const student
      of recommended
    ) {

      const count =
        Number(
          student.duty_count || 0
        );


      text +=
        `\n• ${escapeHtml(
          student.name
        )} — ${count} деж.`;
    }
  }


  text +=
`\n\n━━━━━━━━━━━━━━

Нажмите на фамилию, чтобы назначить или снять дежурного.`;


  const keyboard = [];


  // ===================================================
// НАВИГАЦИЯ ПО ДАТАМ
// ===================================================

  const previous =
    previousWorkday(date);

  const next =
    nextWorkday(date);


  keyboard.push([
    {
      text:
        `◀️ ${formatDateShort(
          previous
        )}`,

      callback_data:
        `duty_date:${previous}`
    },

    {
      text:
        isToday(date)
          ? `📅 Сегодня ${formatDateShort(date)}`
          : `📅 ${formatDateShort(date)}`,

      callback_data:
        `duty_date:${localDate()}`
    },

    {
      text:
        `${formatDateShort(
          next
        )} ▶️`,

      callback_data:
        `duty_date:${next}`
    }
  ]);


  // ===================================================
// БЫСТРО НАЗНАЧИТЬ РЕКОМЕНДОВАННЫХ
// ===================================================

  if (
    recommended.length
  ) {

    keyboard.push([
      {
        text:
          "✨ Назначить следующих",

        callback_data:
          `duty_recommend:${date}`
      }
    ]);
  }


  // ===================================================
// СПИСОК СТУДЕНТОВ
// ===================================================

  for (
    const student
    of students
  ) {

    const isSelected =
      selected.has(
        Number(student.id)
      );


    keyboard.push([
      {
        text:
          `${isSelected ? "🧹" : "▫️"} ${student.name}`,

        callback_data:
          `duty_toggle:${date}:${student.id}`
      }
    ]);
  }


  // ===================================================
// ОЧИСТКА
// ===================================================

  if (
    selected.size > 0
  ) {

    keyboard.push([
      {
        text:
          "🗑 Очистить дежурных",

        callback_data:
          `duty_clear:${date}`
      }
    ]);
  }


  keyboard.push([
    {
      text:
        "🏠 Главное меню",

      callback_data:
        "main"
    }
  ]);


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard:
        keyboard
    }
  );
}


// =====================================================
// ПЕРЕКЛЮЧЕНИЕ ДЕЖУРНОГО
// =====================================================

async function toggleDuty(
  env,
  date,
  studentId
) {

  const existing =
    await env.DB.prepare(`
      SELECT student_id

      FROM duty

      WHERE
        date = ?
        AND
        student_id = ?
    `)
      .bind(
        date,
        studentId
      )
      .first();


  if (existing) {

    await env.DB.prepare(`
      DELETE FROM duty

      WHERE
        date = ?
        AND
        student_id = ?
    `)
      .bind(
        date,
        studentId
      )
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
    .bind(
      date,
      studentId
    )
    .run();
}


// =====================================================
// АВТОМАТИЧЕСКИ НАЗНАЧИТЬ СЛЕДУЮЩИХ
// =====================================================

async function assignRecommendedDuty(
  env,
  date
) {

  const result =
    await env.DB.prepare(`
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


  const students =
    result.results || [];


  students.sort(
    (a, b) => {

      const aCount =
        Number(
          a.duty_count || 0
        );

      const bCount =
        Number(
          b.duty_count || 0
        );


      if (
        aCount !== bCount
      ) {

        return (
          aCount - bCount
        );
      }


      if (
        !a.last_duty &&
        b.last_duty
      ) {
        return -1;
      }


      if (
        a.last_duty &&
        !b.last_duty
      ) {
        return 1;
      }


      if (
        a.last_duty &&
        b.last_duty
      ) {

        return (
          String(a.last_duty)
            .localeCompare(
              String(b.last_duty)
            )
        );
      }


      return (
        String(a.name)
          .localeCompare(
            String(b.name),
            "ru"
          )
      );
    }
  );


  // По умолчанию назначаем двух человек
  const nextStudents =
    students.slice(0, 2);


  for (
    const student
    of nextStudents
  ) {

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
      .bind(
        date,
        student.id
      )
      .run();
  }
}


// =====================================================
// ПОДТВЕРЖДЕНИЕ ОЧИСТКИ ДЕЖУРНЫХ
// =====================================================

async function showDutyClearConfirm(
  env,
  chatId,
  messageId,
  date
) {

  await editOrSend(
    env,
    chatId,
    messageId,

`🛡 <b>ПОДТВЕРЖДЕНИЕ</b>

📅 ${escapeHtml(
  formatDateLong(date)
)}

Удалить всех назначенных дежурных за этот день?

Случайно нажать и потерять данные не получится — нужно подтвердить действие.`,

    {
      inline_keyboard: [

        [
          {
            text:
              "🗑 Да, очистить",

            callback_data:
              `duty_clear_yes:${date}`
          }
        ],

        [
          {
            text:
              "❌ Отмена",

            callback_data:
              `duty_date:${date}`
          }
        ]

      ]
    }
  );
}


// =====================================================
// ОЧИСТИТЬ ДЕЖУРСТВО ЗА ДЕНЬ
// =====================================================

async function clearDuty(
  env,
  date
) {

  await env.DB.prepare(`
    DELETE FROM duty
    WHERE date = ?
  `)
    .bind(date)
    .run();
}


// =====================================================
// ИСТОРИЯ ДЕЖУРСТВ
// =====================================================

async function showDutyHistory(
  env,
  chatId,
  messageId
) {

  const result =
    await env.DB.prepare(`
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


  const rows =
    result.results || [];


  let text =
`🧹 <b>ИСТОРИЯ ДЕЖУРСТВ</b>

━━━━━━━━━━━━━━`;


  if (
    rows.length === 0
  ) {

    text +=
      `\n\nПока нет записей.`;

  } else {

    let currentDate =
      null;


    for (
      const row
      of rows
    ) {

      if (
        row.date !==
        currentDate
      ) {

        currentDate =
          row.date;


        text +=
          `\n\n📅 <b>${escapeHtml(
            formatDateLong(
              currentDate
            )
          )}</b>`;
      }


      text +=
        `\n🧹 ${escapeHtml(
          row.name
        )}`;
    }
  }


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [

        [
          {
            text:
              "🧹 Сегодня",

            callback_data:
              "duty"
          }
        ],

        [
          {
            text:
              "🏠 Главное меню",

            callback_data:
              "main"
          }
        ]

      ]
    }
  );
}


// =====================================================
// CALLBACK-МАРШРУТЫ ИЗ ЧАСТЕЙ 3 И 4
//
// Эта функция будет вызвана из общего callback-router
// в финальной части.
// =====================================================

async function handleExtraCallback(
  data,
  env,
  chatId,
  messageId,
  userId
) {

  // ===================================================
// ИСТОРИЯ — ДЕНЬ
// ===================================================

  if (
    data.startsWith(
      "history_day:"
    )
  ) {

    const date =
      data.split(":")[1];


    if (
      isValidDate(date)
    ) {

      await showHistoryDay(
        env,
        chatId,
        messageId,
        date
      );
    }

    return true;
  }


  // ===================================================
// КАРТОЧКА СТУДЕНТА
// ===================================================

  if (
    data.startsWith(
      "student:"
    )
  ) {

    const studentId =
      Number(
        data.split(":")[1]
      );


    if (studentId) {

      await showStudentCard(
        env,
        chatId,
        messageId,
        studentId
      );
    }

    return true;
  }


  // ===================================================
// ПРОПУСКИ СТУДЕНТА
// ===================================================

  if (
    data.startsWith(
      "student_absences:"
    )
  ) {

    const studentId =
      Number(
        data.split(":")[1]
      );


    if (studentId) {

      await showStudentAbsences(
        env,
        chatId,
        messageId,
        studentId
      );
    }

    return true;
  }


  // ===================================================
// СТАТИСТИКА СТУДЕНТА
// ===================================================

  if (
    data.startsWith(
      "student_stats:"
    )
  ) {

    const studentId =
      Number(
        data.split(":")[1]
      );


    if (studentId) {

      await showStudentStats(
        env,
        chatId,
        messageId,
        studentId
      );
    }

    return true;
  }


  // ===================================================
// ИСТОРИЯ ДЕЖУРСТВ СТУДЕНТА
// ===================================================

  if (
    data.startsWith(
      "student_duty:"
    )
  ) {

    const studentId =
      Number(
        data.split(":")[1]
      );


    if (studentId) {

      await showStudentDutyHistory(
        env,
        chatId,
        messageId,
        studentId
      );
    }

    return true;
  }


  // ===================================================
// ДОБАВИТЬ СТУДЕНТА
// ===================================================

  if (
    data ===
    "student_add"
  ) {

    await setState(
      env,
      userId,
      "await_student"
    );


    await editOrSend(
      env,
      chatId,
      messageId,

`➕ <b>ДОБАВЛЕНИЕ СТУДЕНТА</b>

Отправьте фамилию и имя одним сообщением.

Например:

<code>Иванов Иван</code>`,

      {
        inline_keyboard: [

          [
            {
              text:
                "❌ Отмена",

              callback_data:
                "students"
            }
          ]

        ]
      }
    );

    return true;
  }


  // ===================================================
// УДАЛЕНИЕ СТУДЕНТА — ПОДТВЕРЖДЕНИЕ
// ===================================================

  if (
    data.startsWith(
      "student_delete:"
    )
  ) {

    const studentId =
      Number(
        data.split(":")[1]
      );


    const student =
      await env.DB.prepare(`
        SELECT name

        FROM students

        WHERE id = ?
      `)
        .bind(studentId)
        .first();


    if (!student) {
      return true;
    }


    await editOrSend(
      env,
      chatId,
      messageId,

`🛡 <b>УДАЛЕНИЕ СТУДЕНТА</b>

👤 ${escapeHtml(
  student.name
)}

Убрать студента из активного списка?

История посещаемости и дежурств <b>не будет удалена</b>.`,

      {
        inline_keyboard: [

          [
            {
              text:
                "🗑 Да, убрать",

              callback_data:
                `student_delete_yes:${studentId}`
            }
          ],

          [
            {
              text:
                "❌ Отмена",

              callback_data:
                `student:${studentId}`
            }
          ]

        ]
      }
    );

    return true;
  }


  // ===================================================
// УДАЛЕНИЕ СТУДЕНТА — ПОДТВЕРЖДЕНО
// ===================================================

  if (
    data.startsWith(
      "student_delete_yes:"
    )
  ) {

    const studentId =
      Number(
        data.split(":")[1]
      );


    if (studentId) {

      // Не удаляем историю.
      // Просто скрываем студента из активной группы.

      await env.DB.prepare(`
        UPDATE students

        SET active = 0

        WHERE id = ?
      `)
        .bind(studentId)
        .run();
    }


    await showStudentsMenu(
      env,
      chatId,
      messageId
    );

    return true;
  }


  // ===================================================
// ДЕЖУРСТВО — ДАТА
// ===================================================

  if (
    data.startsWith(
      "duty_date:"
    )
  ) {

    const date =
      data.split(":")[1];


    if (
      isValidDate(date)
    ) {

      await showDuty(
        env,
        chatId,
        messageId,
        date
      );
    }

    return true;
  }


  // ===================================================
// НАЗНАЧИТЬ / СНЯТЬ ДЕЖУРНОГО
// ===================================================

  if (
    data.startsWith(
      "duty_toggle:"
    )
  ) {

    const parts =
      data.split(":");

    const date =
      parts[1];

    const studentId =
      Number(parts[2]);


    if (
      isValidDate(date) &&
      studentId
    ) {

      await toggleDuty(
        env,
        date,
        studentId
      );


      await showDuty(
        env,
        chatId,
        messageId,
        date
      );
    }

    return true;
  }


  // ===================================================
// АВТОВЫБОР ПО ОЧЕРЕДИ
// ===================================================

  if (
    data.startsWith(
      "duty_recommend:"
    )
  ) {

    const date =
      data.split(":")[1];


    if (
      isValidDate(date)
    ) {

      await assignRecommendedDuty(
        env,
        date
      );


      await showDuty(
        env,
        chatId,
        messageId,
        date
      );
    }

    return true;
  }


  // ===================================================
// ОЧИСТКА ДЕЖУРНЫХ
// ===================================================

  if (
    data.startsWith(
      "duty_clear:"
    )
  ) {

    const date =
      data.split(":")[1];


    if (
      isValidDate(date)
    ) {

      await showDutyClearConfirm(
        env,
        chatId,
        messageId,
        date
      );
    }

    return true;
  }


  // ===================================================
// ПОДТВЕРЖДЁННАЯ ОЧИСТКА
// ===================================================

  if (
    data.startsWith(
      "duty_clear_yes:"
    )
  ) {

    const date =
      data.split(":")[1];


    if (
      isValidDate(date)
    ) {

      await clearDuty(
        env,
        date
      );


      await showDuty(
        env,
        chatId,
        messageId,
        date
      );
    }

    return true;
  }


  // ===================================================
// ИСТОРИЯ ДЕЖУРСТВ
// ===================================================

  if (
    data ===
    "duty_history"
  ) {

    await showDutyHistory(
      env,
      chatId,
      messageId
    );

    return true;
  }


  return false;
        }
// =====================================================
// МЕНЮ СТАТИСТИКИ
// =====================================================

async function showStatsMenu(
  env,
  chatId,
  messageId
) {

  await editOrSend(
    env,
    chatId,
    messageId,

`📊 <b>СТАТИСТИКА ГРУППЫ</b>

Выберите период 👇`,

    {
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
    }
  );
}


// =====================================================
// СТАТИСТИКА ГРУППЫ ЗА ПЕРИОД
// =====================================================

async function showGroupStats(
  env,
  chatId,
  messageId,
  period
) {

  let where = "";
  let title = "Всё время";


  if (period === "7") {

    const from =
      shiftDate(
        localDate(),
        -6
      );

    where =
      `AND a.date >= '${from}'`;

    title =
      "Последние 7 дней";
  }


  if (period === "30") {

    const from =
      shiftDate(
        localDate(),
        -29
      );

    where =
      `AND a.date >= '${from}'`;

    title =
      "Последние 30 дней";
  }


  const result =
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
            WHEN a.status = 'excused'
            THEN 1 ELSE 0
          END
        ) AS excused

      FROM students s

      LEFT JOIN attendance a
        ON a.student_id = s.id
        ${where}

      WHERE s.active = 1

      GROUP BY
        s.id,
        s.name

      ORDER BY
        s.name COLLATE NOCASE
    `)
      .all();


  const students =
    result.results || [];


  let totalPresent = 0;
  let totalAbsent = 0;
  let totalLate = 0;
  let totalExcused = 0;


  let text =
`📊 <b>СТАТИСТИКА ГРУППЫ</b>

📆 <b>${escapeHtml(title)}</b>

━━━━━━━━━━━━━━`;


  for (
    const student
    of students
  ) {

    const present =
      Number(
        student.present || 0
      );

    const absent =
      Number(
        student.absent || 0
      );

    const late =
      Number(
        student.late || 0
      );

    const excused =
      Number(
        student.excused || 0
      );


    totalPresent += present;
    totalAbsent += absent;
    totalLate += late;
    totalExcused += excused;


    const counted =
      present +
      absent +
      late;


    const percent =
      counted > 0
        ? Math.round(
            (
              (
                present +
                late
              ) /
              counted
            ) * 100
          )
        : 0;


    text +=
`\n\n👤 <b>${escapeHtml(
  student.name
)}</b>
✅ ${present}  ❌ ${absent}  ⏰ ${late}  🏥 ${excused}
📈 ${percent}%`;
  }


  text +=
`\n\n━━━━━━━━━━━━━━

📋 <b>ИТОГО ПО ГРУППЕ</b>

✅ Присутствий: <b>${totalPresent}</b>
❌ Пропусков: <b>${totalAbsent}</b>
⏰ Опозданий: <b>${totalLate}</b>
🏥 Уважительных: <b>${totalExcused}</b>`;


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
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
    }
  );
}


// =====================================================
// СТАТИСТИКА КОНКРЕТНОГО СТУДЕНТА ЗА ПЕРИОД
// =====================================================

async function showStudentPeriodStats(
  env,
  chatId,
  messageId,
  studentId,
  period
) {

  const student =
    await env.DB.prepare(`
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

    const from =
      shiftDate(
        localDate(),
        -6
      );

    dateCondition =
      `AND date >= '${from}'`;

    title =
      "Последние 7 дней";
  }


  if (period === "30") {

    const from =
      shiftDate(
        localDate(),
        -29
      );

    dateCondition =
      `AND date >= '${from}'`;

    title =
      "Последние 30 дней";
  }


  const stats =
    await env.DB.prepare(`
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
            WHEN status = 'excused'
            THEN 1 ELSE 0
          END
        ) AS excused

      FROM attendance

      WHERE student_id = ?
      ${dateCondition}
    `)
      .bind(studentId)
      .first();


  const present =
    Number(
      stats?.present || 0
    );

  const absent =
    Number(
      stats?.absent || 0
    );

  const late =
    Number(
      stats?.late || 0
    );

  const excused =
    Number(
      stats?.excused || 0
    );


  const counted =
    present +
    absent +
    late;


  const percent =
    counted > 0
      ? Math.round(
          (
            (
              present +
              late
            ) /
            counted
          ) * 100
        )
      : 0;


  await editOrSend(
    env,
    chatId,
    messageId,

`📊 <b>СТАТИСТИКА СТУДЕНТА</b>

👤 <b>${escapeHtml(
  student.name
)}</b>

📆 ${escapeHtml(title)}

━━━━━━━━━━━━━━

✅ Присутствовал: <b>${present}</b>
❌ Отсутствовал: <b>${absent}</b>
⏰ Опоздал: <b>${late}</b>
🏥 Уважительно: <b>${excused}</b>

📈 Посещаемость: <b>${percent}%</b>`,

    {
      inline_keyboard: [

        [
          {
            text: "📅 7 дней",
            callback_data:
              `student_period:${studentId}:7`
          },

          {
            text: "📅 30 дней",
            callback_data:
              `student_period:${studentId}:30`
          }
        ],

        [
          {
            text: "📚 Всё время",
            callback_data:
              `student_period:${studentId}:all`
          }
        ],

        [
          {
            text: "⬅️ Карточка",
            callback_data:
              `student:${studentId}`
          }
        ]

      ]
    }
  );
}


// =====================================================
// НАСТРОЙКИ
// =====================================================

async function showSettings(
  env,
  chatId,
  messageId,
  userId
) {

  const admins =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM admins
    `)
      .first();


  const extraAdmins =
    Number(
      admins?.count || 0
    );


  let text =
`⚙️ <b>НАСТРОЙКИ</b>

━━━━━━━━━━━━━━

👑 Владелец: <b>1</b>
👨‍🏫 Доп. преподавателей: <b>${extraAdmins}</b>

🔐 Владелец задаётся через ADMIN_ID и не может быть удалён из Telegram.`;


  if (
    !isOwner(
      env,
      userId
    )
  ) {

    text +=
`\n\nℹ️ Вы вошли как преподаватель.

Управление доступом доступно только владельцу.`;
  }


  const keyboard = [];


  if (
    isOwner(
      env,
      userId
    )
  ) {

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


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard:
        keyboard
    }
  );
}


// =====================================================
// СПИСОК АДМИНИСТРАТОРОВ
// =====================================================

async function showAdmins(
  env,
  chatId,
  messageId,
  userId
) {

  if (
    !isOwner(
      env,
      userId
    )
  ) {

    await answerSimple(
      env,
      chatId,
      "🔒 Только владелец может управлять администраторами."
    );

    return;
  }


  const result =
    await env.DB.prepare(`
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


  const admins =
    result.results || [];


  let text =
`👥 <b>АДМИНИСТРАТОРЫ</b>

👑 <b>Владелец</b>
ID: <code>${escapeHtml(
  String(env.ADMIN_ID)
)}</code>

━━━━━━━━━━━━━━`;


  if (
    admins.length === 0
  ) {

    text +=
`\n\n👨‍🏫 Дополнительных преподавателей пока нет.`;

  } else {

    text +=
      `\n\n👨‍🏫 <b>Преподаватели:</b>`;


    for (
      const admin
      of admins
    ) {

      const name =
        userDisplayName(
          admin
        );


      text +=
`\n\n• ${escapeHtml(name)}
<code>${escapeHtml(
  String(admin.user_id)
)}</code>`;
    }
  }


  const keyboard = [];


  keyboard.push([
    {
      text: "➕ Добавить преподавателя",
      callback_data: "admin_add"
    }
  ]);


  for (
    const admin
    of admins
  ) {

    keyboard.push([
      {
        text:
          `🗑 ${userDisplayName(
            admin
          )}`,

        callback_data:
          `admin_delete:${admin.user_id}`
      }
    ]);
  }


  keyboard.push([
    {
      text: "⬅️ Настройки",
      callback_data: "settings"
    }
  ]);


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard:
        keyboard
    }
  );
}


// =====================================================
// ВЫБОР ПОЛЬЗОВАТЕЛЯ ДЛЯ ДОБАВЛЕНИЯ
// =====================================================

async function showAdminCandidates(
  env,
  chatId,
  messageId,
  userId
) {

  if (
    !isOwner(
      env,
      userId
    )
  ) {
    return;
  }


  const result =
    await env.DB.prepare(`
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
      .bind(
        String(env.ADMIN_ID)
      )
      .all();


  const users =
    result.results || [];


  let text =
`➕ <b>ДОБАВИТЬ ПРЕПОДАВАТЕЛЯ</b>

Попросите преподавателя сначала открыть бота и отправить:

<code>/start</code>

После этого он появится здесь.

━━━━━━━━━━━━━━`;


  const keyboard = [];


  if (
    users.length === 0
  ) {

    text +=
`\n\nПока нет пользователей, которых можно добавить.`;

  } else {

    text +=
`\n\nВыберите пользователя 👇`;


    for (
      const user
      of users
    ) {

      keyboard.push([
        {
          text:
            `➕ ${userDisplayName(
              user
            )}`,

          callback_data:
            `admin_add_yes:${user.user_id}`
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


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard:
        keyboard
    }
  );
}


// =====================================================
// ДОБАВИТЬ АДМИНА
// =====================================================

async function addAdmin(
  env,
  targetUserId
) {

  if (
    String(targetUserId) ===
    String(env.ADMIN_ID)
  ) {
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
    .bind(
      String(targetUserId),
      new Date().toISOString()
    )
    .run();


  // Сообщаем преподавателю
  try {

    await sendMessage(
      env,
      targetUserId,

`✅ <b>Доступ открыт</b>

👨‍🏫 Вы добавлены как преподаватель в журнал группы №102.

Отправьте /start, чтобы открыть главное меню.`
    );

  } catch (error) {

    console.log(
      "Admin notification error:",
      error
    );
  }
}


// =====================================================
// ПОДТВЕРЖДЕНИЕ УДАЛЕНИЯ АДМИНА
// =====================================================

async function showAdminDeleteConfirm(
  env,
  chatId,
  messageId,
  targetUserId
) {

  const user =
    await env.DB.prepare(`
      SELECT
        first_name,
        last_name,
        username

      FROM users

      WHERE user_id = ?
    `)
      .bind(
        String(targetUserId)
      )
      .first();


  const name =
    userDisplayName(
      user || {
        user_id:
          targetUserId
      }
    );


  await editOrSend(
    env,
    chatId,
    messageId,

`🛡 <b>УДАЛИТЬ ДОСТУП?</b>

👨‍🏫 ${escapeHtml(name)}

После подтверждения преподаватель больше не сможет открыть журнал.

История посещаемости, дежурств и студентов не изменится.`,

    {
      inline_keyboard: [

        [
          {
            text: "🗑 Да, удалить доступ",
            callback_data:
              `admin_delete_yes:${targetUserId}`
          }
        ],

        [
          {
            text: "❌ Отмена",
            callback_data: "admins"
          }
        ]

      ]
    }
  );
}


// =====================================================
// УДАЛИТЬ АДМИНА
// =====================================================

async function deleteAdmin(
  env,
  targetUserId
) {

  // ADMIN_ID удалить невозможно
  if (
    String(targetUserId) ===
    String(env.ADMIN_ID)
  ) {
    return;
  }


  await env.DB.prepare(`
    DELETE FROM admins

    WHERE user_id = ?
  `)
    .bind(
      String(targetUserId)
    )
    .run();


  try {

    await sendMessage(
      env,
      targetUserId,

`🔒 <b>Доступ к журналу закрыт</b>

Владелец удалил ваш доступ к журналу группы №102.`
    );

  } catch (error) {

    console.log(
      "Admin remove notification error:",
      error
    );
  }
}


// =====================================================
// ИМЯ TELEGRAM-ПОЛЬЗОВАТЕЛЯ
// =====================================================

function userDisplayName(
  user
) {

  if (!user) {
    return "Пользователь";
  }


  const fullName =
    [
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

    return (
      "@" +
      String(
        user.username
      )
    );
  }


  if (user.user_id) {

    return (
      "ID " +
      String(
        user.user_id
      )
    );
  }


  return "Пользователь";
}


// =====================================================
// CALLBACK-МАРШРУТЫ ЧАСТИ 5
// =====================================================

async function handlePart5Callback(
  data,
  env,
  chatId,
  messageId,
  userId
) {

  // ---------------------------------------------------
// СТАТИСТИКА ГРУППЫ
// ---------------------------------------------------

  if (
    data.startsWith(
      "stats_period:"
    )
  ) {

    const period =
      data.split(":")[1];


    if (
      ["7", "30", "all"]
        .includes(period)
    ) {

      await showGroupStats(
        env,
        chatId,
        messageId,
        period
      );
    }

    return true;
  }


  // ---------------------------------------------------
// СТАТИСТИКА СТУДЕНТА
// ---------------------------------------------------

  if (
    data.startsWith(
      "student_period:"
    )
  ) {

    const parts =
      data.split(":");

    const studentId =
      Number(parts[1]);

    const period =
      parts[2];


    if (
      studentId &&
      ["7", "30", "all"]
        .includes(period)
    ) {

      await showStudentPeriodStats(
        env,
        chatId,
        messageId,
        studentId,
        period
      );
    }

    return true;
  }


  // ---------------------------------------------------
// АДМИНЫ
// ---------------------------------------------------

  if (
    data === "admins"
  ) {

    if (
      !isOwner(
        env,
        userId
      )
    ) {
      return true;
    }


    await showAdmins(
      env,
      chatId,
      messageId,
      userId
    );

    return true;
  }


  // ---------------------------------------------------
// ДОБАВЛЕНИЕ АДМИНА
// ---------------------------------------------------

  if (
    data === "admin_add"
  ) {

    if (
      !isOwner(
        env,
        userId
      )
    ) {
      return true;
    }


    await showAdminCandidates(
      env,
      chatId,
      messageId,
      userId
    );

    return true;
  }


  // ---------------------------------------------------
// ПОДТВЕРЖДЕНИЕ ДОБАВЛЕНИЯ
// ---------------------------------------------------

  if (
    data.startsWith(
      "admin_add_yes:"
    )
  ) {

    if (
      !isOwner(
        env,
        userId
      )
    ) {
      return true;
    }


    const targetUserId =
      data.split(":")[1];


    if (targetUserId) {

      await addAdmin(
        env,
        targetUserId
      );
    }


    await showAdmins(
      env,
      chatId,
      messageId,
      userId
    );

    return true;
  }


  // ---------------------------------------------------
// ЗАПРОС НА УДАЛЕНИЕ АДМИНА
// ---------------------------------------------------

  if (
    data.startsWith(
      "admin_delete:"
    )
  ) {

    if (
      !isOwner(
        env,
        userId
      )
    ) {
      return true;
    }


    const targetUserId =
      data.split(":")[1];


    if (
      targetUserId &&
      String(targetUserId) !==
      String(env.ADMIN_ID)
    ) {

      await showAdminDeleteConfirm(
        env,
        chatId,
        messageId,
        targetUserId
      );
    }

    return true;
  }


  // ---------------------------------------------------
// УДАЛЕНИЕ АДМИНА ПОДТВЕРЖДЕНО
// ---------------------------------------------------

  if (
    data.startsWith(
      "admin_delete_yes:"
    )
  ) {

    if (
      !isOwner(
        env,
        userId
      )
    ) {
      return true;
    }


    const targetUserId =
      data.split(":")[1];


    if (targetUserId) {

      await deleteAdmin(
        env,
        targetUserId
      );
    }


    await showAdmins(
      env,
      chatId,
      messageId,
      userId
    );

    return true;
  }


  return false;
                }
// =====================================================
// XLSX
// =====================================================

import * as XLSX from "xlsx";


// =====================================================
// ГЛАВНОЕ МЕНЮ
// =====================================================

async function showMainMenu(
  env,
  chatId,
  messageId = null
) {

  const date =
    localDate();


  const students =
    await getActiveStudents(
      env
    );


  const result =
    await env.DB.prepare(`
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


  for (
    const row
    of result.results || []
  ) {

    const count =
      Number(
        row.count || 0
      );


    if (
      row.status === "present"
    ) {
      present = count;
    }

    else if (
      row.status === "absent"
    ) {
      absent = count;
    }

    else if (
      row.status === "late"
    ) {
      late = count;
    }

    else if (
      row.status === "excused"
    ) {
      excused = count;
    }
  }


  const marked =
    present +
    absent +
    late +
    excused;


  const unmarked =
    Math.max(
      0,
      students.length -
      marked
    );


  const duty =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count

      FROM duty

      WHERE date = ?
    `)
      .bind(date)
      .first();


  const text =
`👨‍🏫 <b>ЖУРНАЛ • ГРУППА №102</b>

📅 <b>${escapeHtml(
  formatDateLong(date)
)}</b>

━━━━━━━━━━━━━━

👥 Студентов: <b>${students.length}</b>

✅ Есть: <b>${present}</b>
❌ Нет: <b>${absent}</b>
⏰ Опоздали: <b>${late}</b>
🏥 Уважительно: <b>${excused}</b>

⚠️ Не отмечено: <b>${unmarked}</b>

🧹 Дежурных сегодня: <b>${Number(
  duty?.count || 0
)}</b>

━━━━━━━━━━━━━━

Выберите раздел 👇`;


  await editOrSend(
    env,
    chatId,
    messageId,
    text,
    {
      inline_keyboard: [

        [
          {
            text:
              "👥 Посещаемость",

            callback_data:
              "attendance"
          },

          {
            text:
              "👀 Кого нет",

            callback_data:
              "missing"
          }
        ],

        [
          {
            text:
              "📆 История",

            callback_data:
              "history"
          },

          {
            text:
              "🧹 Дежурство",

            callback_data:
              "duty"
          }
        ],

        [
          {
            text:
              "📊 Статистика",

            callback_data:
              "stats"
          },

          {
            text:
              "👨‍🎓 Студенты",

            callback_data:
              "students"
          }
        ],

        [
          {
            text:
              "📤 Excel",

            callback_data:
              "excel"
          },

          {
            text:
              "⚙️ Настройки",

            callback_data:
              "settings"
          }
        ]

      ]
    }
  );
}


// =====================================================
// EXCEL — ВЫБОР ПЕРИОДА
// =====================================================

async function showExcelMenu(
  env,
  chatId,
  messageId
) {

  await editOrSend(
    env,
    chatId,
    messageId,

`📤 <b>ОТЧЁТ EXCEL</b>

Выберите период.

Бот создаст настоящий файл <b>.xlsx</b> с двумя листами:

📋 Посещаемость
📊 Сводка по студентам`,

    {
      inline_keyboard: [

        [
          {
            text:
              "📅 7 дней",

            callback_data:
              "excel_period:7"
          },

          {
            text:
              "📅 30 дней",

            callback_data:
              "excel_period:30"
          }
        ],

        [
          {
            text:
              "📚 Всё время",

            callback_data:
              "excel_period:all"
          }
        ],

        [
          {
            text:
              "🏠 Главное меню",

            callback_data:
              "main"
          }
        ]

      ]
    }
  );
}


// =====================================================
// СОЗДАНИЕ EXCEL
// =====================================================

async function createExcelReport(
  env,
  period
) {

  let fromDate =
    null;

  let periodName =
    "Всё время";

  let filePeriod =
    "all";


  if (
    period === "7"
  ) {

    fromDate =
      shiftDate(
        localDate(),
        -6
      );

    periodName =
      "Последние 7 дней";

    filePeriod =
      "7days";
  }


  if (
    period === "30"
  ) {

    fromDate =
      shiftDate(
        localDate(),
        -29
      );

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
        .bind(
          fromDate
        )
        .all();

  } else {

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


  const attendanceRows =
    [];


  for (
    const row
    of attendanceResult.results || []
  ) {

    attendanceRows.push({
      "Дата":
        row.date,

      "Студент":
        row.name,

      "Статус":
        statusText(
          row.status
        ),

      "Дежурство":
        Number(
          row.duty || 0
        )
          ? "Да"
          : ""
    });
  }


  // ===================================================
  // СВОДНАЯ СТАТИСТИКА
  // ===================================================

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
              WHEN a.status = 'excused'
              THEN 1 ELSE 0
            END
          ) AS excused

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
        .bind(
          fromDate
        )
        .all();

  } else {

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
              WHEN a.status = 'excused'
              THEN 1 ELSE 0
            END
          ) AS excused

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


  const summaryRows =
    [];


  for (
    const row
    of statsResult.results || []
  ) {

    const present =
      Number(
        row.present || 0
      );

    const absent =
      Number(
        row.absent || 0
      );

    const late =
      Number(
        row.late || 0
      );

    const excused =
      Number(
        row.excused || 0
      );


    const counted =
      present +
      absent +
      late;


    const percent =
      counted > 0
        ? Math.round(
            (
              (
                present +
                late
              ) /
              counted
            ) * 100
          )
        : 0;


    const dutyResult =
      fromDate

        ? await env.DB.prepare(`
            SELECT
              COUNT(*) AS count

            FROM duty

            WHERE
              student_id = ?
              AND
              date >= ?
          `)
            .bind(
              row.id,
              fromDate
            )
            .first()

        : await env.DB.prepare(`
            SELECT
              COUNT(*) AS count

            FROM duty

            WHERE
              student_id = ?
          `)
            .bind(
              row.id
            )
            .first();


    summaryRows.push({
      "Студент":
        row.name,

      "Присутствовал":
        present,

      "Отсутствовал":
        absent,

      "Опоздал":
        late,

      "Уважительно":
        excused,

      "Посещаемость %":
        percent,

      "Дежурств":
        Number(
          dutyResult?.count || 0
        )
    });
  }


  // Если посещаемости пока нет,
  // Excel всё равно должен иметь заголовки

  if (
    attendanceRows.length === 0
  ) {

    attendanceRows.push({
      "Дата": "",
      "Студент": "",
      "Статус": "",
      "Дежурство": ""
    });
  }


  const workbook =
    XLSX.utils.book_new();


  const attendanceSheet =
    XLSX.utils.json_to_sheet(
      attendanceRows
    );


  const summarySheet =
    XLSX.utils.json_to_sheet(
      summaryRows
    );


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


  XLSX.utils.book_append_sheet(
    workbook,
    attendanceSheet,
    "Посещаемость"
  );


  XLSX.utils.book_append_sheet(
    workbook,
    summarySheet,
    "Сводка"
  );


  const infoSheet =
    XLSX.utils.aoa_to_sheet([
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
        formatDateLong(
          localDate()
        )
      ]
    ]);


  infoSheet["!cols"] = [
    { wch: 20 },
    { wch: 35 }
  ];


  XLSX.utils.book_append_sheet(
    workbook,
    infoSheet,
    "Информация"
  );


  const buffer =
    XLSX.write(
      workbook,
      {
        type: "array",
        bookType: "xlsx"
      }
    );


  return {
    buffer,

    filename:
      `journal_102_${localDate()}_${filePeriod}.xlsx`
  };
}


// =====================================================
// ОТПРАВКА EXCEL В TELEGRAM
// =====================================================

async function sendExcelReport(
  env,
  chatId,
  period
) {

  await sendMessage(
    env,
    chatId,

`⏳ <b>Создаю Excel-отчёт...</b>

Это может занять несколько секунд.`
  );


  const report =
    await createExcelReport(
      env,
      period
    );


  const form =
    new FormData();


  form.append(
    "chat_id",
    String(chatId)
  );


  form.append(
    "caption",
    `📊 Журнал группы №102\n📅 ${formatDateLong(
      localDate()
    )}`
  );


  form.append(
    "document",

    new Blob(
      [
        report.buffer
      ],

      {
        type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      }
    ),

    report.filename
  );


  const response =
    await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`,
      {
        method:
          "POST",

        body:
          form
      }
    );


  const result =
    await response.json();


  if (
    !result.ok
  ) {

    console.error(
      "Excel Telegram error:",
      result
    );


    await sendMessage(
      env,
      chatId,

`❌ Не удалось отправить Excel.

Попробуйте ещё раз.`
    );
  }
}


// =====================================================
// CALLBACK — ЧАСТЬ 6
// =====================================================

async function handlePart6Callback(
  data,
  env,
  chatId,
  messageId,
  userId
) {

  if (
    data.startsWith(
      "excel_period:"
    )
  ) {

    const period =
      data.split(":")[1];


    if (
      ![
        "7",
        "30",
        "all"
      ].includes(period)
    ) {

      return true;
    }


    await sendExcelReport(
      env,
      chatId,
      period
    );


    await showExcelMenu(
      env,
      chatId,
      messageId
    );


    return true;
  }


  return false;
}


// =====================================================
// СТАТУС ТЕКСТОМ
// =====================================================

function statusText(
  status
) {

  if (
    status === "present"
  ) {
    return "Присутствует";
  }


  if (
    status === "absent"
  ) {
    return "Отсутствует";
  }


  if (
    status === "late"
  ) {
    return "Опоздал";
  }


  if (
    status === "excused"
  ) {
    return "Уважительная причина";
  }


  return "Не отмечено";
}


// =====================================================
// STATE
// =====================================================

async function setState(
  env,
  userId,
  action,
  data = ""
) {

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
    .bind(
      String(userId),
      String(action),
      String(data || "")
    )
    .run();
}


async function clearState(
  env,
  userId
) {

  await env.DB.prepare(`
    DELETE FROM states

    WHERE user_id = ?
  `)
    .bind(
      String(userId)
    )
    .run();
}


// =====================================================
// ДАТЫ
// =====================================================

function localDate() {

  const parts =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone:
          TZ,

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit"
      }
    )
      .formatToParts(
        new Date()
      );


  const map = {};


  for (
    const part
    of parts
  ) {

    if (
      part.type !==
      "literal"
    ) {

      map[
        part.type
      ] =
        part.value;
    }
  }


  return (
    `${map.year}-${map.month}-${map.day}`
  );
}


function shiftDate(
  date,
  days
) {

  const base =
    new Date(
      `${date}T12:00:00Z`
    );


  base.setUTCDate(
    base.getUTCDate() +
    Number(days)
  );


  return [
    base
      .getUTCFullYear(),

    String(
      base.getUTCMonth() + 1
    )
      .padStart(
        2,
        "0"
      ),

    String(
      base.getUTCDate()
    )
      .padStart(
        2,
        "0"
      )
  ].join("-");
}


function dateWeekday(
  date
) {

  const d =
    new Date(
      `${date}T12:00:00Z`
    );


  return (
    d.getUTCDay()
  );
}


function nextWorkday(
  date
) {

  let result =
    shiftDate(
      date,
      1
    );


  while (
    dateWeekday(result) === 0 ||
    dateWeekday(result) === 6
  ) {

    result =
      shiftDate(
        result,
        1
      );
  }


  return result;
}


function previousWorkday(
  date
) {

  let result =
    shiftDate(
      date,
      -1
    );


  while (
    dateWeekday(result) === 0 ||
    dateWeekday(result) === 6
  ) {

    result =
      shiftDate(
        result,
        -1
      );
  }


  return result;
}


function isToday(
  date
) {

  return (
    String(date) ===
    localDate()
  );
}


function isValidDate(
  date
) {

  if (
    !/^\d{4}-\d{2}-\d{2}$/
      .test(
        String(date || "")
      )
  ) {

    return false;
  }


  const d =
    new Date(
      `${date}T12:00:00Z`
    );


  return (
    !Number.isNaN(
      d.getTime()
    )
  );
}


function formatDateShort(
  date
) {

  const parts =
    String(date)
      .split("-");


  if (
    parts.length !== 3
  ) {

    return date;
  }


  return (
    `${parts[2]}.${parts[1]}`
  );
}


function formatDateLong(
  date
) {

  if (
    !isValidDate(date)
  ) {

    return date;
  }


  const d =
    new Date(
      `${date}T12:00:00Z`
    );


  let value =
    new Intl.DateTimeFormat(
      "ru-RU",
      {
        timeZone:
          TZ,

        weekday:
          "long",

        day:
          "numeric",

        month:
          "long",

        year:
          "numeric"
      }
    )
      .format(d);


  value =
    value.charAt(0)
      .toUpperCase() +
    value.slice(1);


  return value;
}


// =====================================================
// ТЕКСТ
// =====================================================

function escapeHtml(
  value
) {

  return String(
    value ?? ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    );
}


function cleanName(
  value
) {

  return String(
    value || ""
  )
    .replace(
      /\s+/g,
      " "
    )
    .trim()
    .slice(
      0,
      100
    );
}


// =====================================================
// TELEGRAM API
// =====================================================

async function telegram(
  env,
  method,
  payload = {}
) {

  const response =
    await fetch(
      `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
      {
        method:
          "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );


  const result =
    await response.json();


  if (
    !result.ok
  ) {

    console.error(
      `Telegram ${method}:`,
      result
    );
  }


  return result;
}


// =====================================================
// ОТПРАВКА СООБЩЕНИЯ
// =====================================================

async function sendMessage(
  env,
  chatId,
  text,
  replyMarkup = null
) {

  const payload = {
    chat_id:
      chatId,

    text,

    parse_mode:
      "HTML",

    disable_web_page_preview:
      true
  };


  if (replyMarkup) {

    payload.reply_markup =
      replyMarkup;
  }


  return telegram(
    env,
    "sendMessage",
    payload
  );
}


// =====================================================
// РЕДАКТИРОВАНИЕ СООБЩЕНИЯ
// =====================================================

async function editMessage(
  env,
  chatId,
  messageId,
  text,
  replyMarkup = null
) {

  const payload = {

    chat_id:
      chatId,

    message_id:
      messageId,

    text,

    parse_mode:
      "HTML",

    disable_web_page_preview:
      true
  };


  if (replyMarkup) {

    payload.reply_markup =
      replyMarkup;
  }


  return telegram(
    env,
    "editMessageText",
    payload
  );
}
