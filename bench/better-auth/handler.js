import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
const database = memoryAdapter({ user: [], session: [], account: [], verification: [] });
const auth = betterAuth({
  database,
  secret: "probe-only-secret-at-least-thirty-two-characters",
  baseURL: "http://localhost:3000",
  emailAndPassword: { enabled: true },
});
export default {
  fetch(request) {
    return auth.handler(request);
  },
};
