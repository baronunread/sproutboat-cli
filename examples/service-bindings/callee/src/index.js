// The callee: an ordinary handler, deployed like any other. Nothing here
// knows it's being reached via a service binding rather than the internet -
// that's the point.

export default {
  fetch(request) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") || "there";
    return new Response(`hello, ${name}, from the callee\n`);
  },
};
