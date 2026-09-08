export default {
  async fetch(request, env) {
    return new Response("Teacher Journal Bot is running! 📚", {
      headers: {
        "content-type": "text/plain; charset=UTF-8"
      }
    });
  }
};
