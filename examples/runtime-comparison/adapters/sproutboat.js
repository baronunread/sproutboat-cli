import { dispatch } from "../fixtures/app.js";
export default {
  async fetch(request) {
    const body = request.method === "POST" ? await request.text() : "";
    return dispatch(request, body, env.BENCH_UPSTREAM);
  },
};
