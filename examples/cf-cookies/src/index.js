// Adapted from Cloudflare's Cookie parsing example.
export default {
  fetch(request) {
    const cookies = (request.headers.get("cookie") || "").split(";");
    for (const cookie of cookies) {
      const equal = cookie.indexOf("=");
      if (equal < 0 || cookie.slice(0, equal).trim() !== "__uid") continue;
      return new Response(cookie.slice(equal + 1).trim());
    }
    return new Response("No cookie with name: __uid");
  },
};
