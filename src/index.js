export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/setup") {
      const webhookUrl = `${url.origin}/webhook`;

      const result = await telegram(env, "setWebhook", {
        url: webhookUrl,
        allowed_updates: ["message"]
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

      const message = update.message;

      if (message?.text) {
        const command = message.text
          .split(/\s+/)[0]
          .split("@")[0]
          .toLowerCase();

        if (command === "/myid") {
          await telegram(env, "sendMessage", {
            chat_id: message.chat.id,
            text: `🆔 Ваш Telegram ID:\n\n${message.from.id}`
          });
        }

        if (command === "/start") {
          await telegram(env, "sendMessage", {
            chat_id: message.chat.id,
            text: "📚 Журнал преподавателя\n\nБот подключён и работает ✅"
          });
        }
      }

      return new Response("OK");
    }

    return new Response("Teacher Journal Bot is running! 📚", {
      headers: {
        "content-type": "text/plain; charset=UTF-8"
      }
    });
  }
};

async function telegram(env, method, payload) {
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

  return response.json();
}
