import { initTRPC } from "@trpc/server";
const t = initTRPC.create();
const router = t.router({ hello: t.procedure.query(() => "hello") });
export default {
  async fetch() {
    const caller = router.createCaller({});
    return new Response(await caller.hello());
  },
};
