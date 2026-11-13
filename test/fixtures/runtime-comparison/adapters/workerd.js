import { dispatch } from "../fixtures/app.js";
export default {
  async fetch(request, env) {
    const body = request.method === "POST" ? await request.text() : "";
    return dispatch(request, body, env.BENCH_UPSTREAM);
  },
};
