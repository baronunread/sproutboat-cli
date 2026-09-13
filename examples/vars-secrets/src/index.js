// `vars` are baked into the binary at build time. `secrets` never enter it:
// a standalone binary reads them from the environment instead, lazily - it
// starts fine either way, and only throws the first time a handler actually
// touches one that's missing.
//
//   ./vars-secrets                  # curl localhost:8080/ -> throws, no API_KEY
//   API_KEY=demo-key ./vars-secrets
//   curl localhost:8080/

export default {
  fetch() {
    return new Response(`${env.GREETING}, your key ends in ...${env.API_KEY.slice(-4)}\n`);
  },
};
