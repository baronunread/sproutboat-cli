import { IttyRouter } from "itty-router";
const router = IttyRouter();
router.get("/hello/:name", ({ params }) => new Response("Hello " + params.name));
router.post("/echo", async (request) => new Response(await request.text()));
router.all("*", () => new Response("missing", { status: 404 }));
export default {
  fetch(request) {
    return router.fetch(request);
  },
};
