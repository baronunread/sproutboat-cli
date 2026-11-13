import { dispatch } from "../fixtures/app.js";
// Plain Porffor's native handler accepts a compile-time listener port.
export default {
  port: 18082,
  async fetch(request) {
    const body = request.method === "POST" ? await request.text() : "";
    return dispatch(request, body, "http://127.0.0.1:18081");
  },
};
