# showcase fleet app

The app behind every dot in the showcase's Fleet section. It answers any request with whether that request was the first its process served (`cold`), and nothing else. The showcase deploys it many times under different names; the local preview runs it as a standalone binary, one process per dot (`../fleet-local.ts`).

```sh
sproutboat dev                               # http://localhost:8787
sproutboat build --standalone --target host  # ./dist/showcase-fleet
curl localhost:8787/
# {"app":"localhost","cold":true,"served":1}
```
