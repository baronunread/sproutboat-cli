// One app of the fleet: every dot in the Fleet section is a deployment of this file under its own name.
// It keeps nothing and calls nothing, so what the page measures is the platform: start, answer, sleep.

// #region fleet
// `served` lives in this process. When the platform stops an idle app
// the process is gone, so the next request finds served === 0 again:
// `cold: true` means "this request started me".
let served = 0;

export default {
  async fetch(request): Promise<Response> {
    const cold = served === 0;
    served++;
    return Response.json(
      { app: new URL(request.url).hostname, cold, served },
      {
        headers: {
          "cache-control": "no-store",
          // The page calls each app from the visitor's browser.
          "access-control-allow-origin": "*",
          "timing-allow-origin": "*",
        },
      },
    );
  },
} satisfies ExportedHandler<Env>;
// #endregion
