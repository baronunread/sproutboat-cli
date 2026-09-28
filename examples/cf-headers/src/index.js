// Adapted from Cloudflare's Set security headers example.
export default {
  fetch() {
    return new Response("Protected page", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'",
      },
    });
  },
};
