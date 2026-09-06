// Cron triggers: scheduled() runs on the expressions in sproutboat.jsonc.
//
//   curl localhost:8080/     # count goes up once a minute, with no traffic

export default {
  fetch() {
    return new Response(
      (env.STATE.get("ticks") || "0") + " ticks, last at " + (env.STATE.get("last") || "never") + "\n",
    );
  },

  scheduled(event) {
    env.STATE.put("ticks", String(Number(env.STATE.get("ticks") || "0") + 1));
    env.STATE.put("last", new Date(event.scheduledTime).toISOString());
  },
};
