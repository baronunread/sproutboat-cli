export default {
  fetch(request, env, ctx) {
    return new Response(`${env.SITE}:${ctx.waitUntil instanceof Function}`);
  },
};
