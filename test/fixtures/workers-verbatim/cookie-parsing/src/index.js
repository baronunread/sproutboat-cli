import { parseCookie } from "cookie";
export default {
  async fetch(request) {
    // The name of the cookie
    const COOKIE_NAME = "__uid";
    const cookie = parseCookie(request.headers.get("Cookie") || "");
    if (cookie[COOKIE_NAME] != null) {
      // Respond with the cookie value
      return new Response(cookie[COOKIE_NAME]);
    }
    return new Response("No cookie with name: " + COOKIE_NAME);
  },
};
