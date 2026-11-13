export type Case = {
  name: string;
  group: string;
  code: string;
  expected: unknown;
  body?: string;
  status?: number;
  async?: boolean;
};
const units = (s: string) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
export const cases: Case[] = [
  ...[200, 201, 400, 401, 404, 405, 413, 418, 422, 425, 429, 500, 501, 502, 503, 507].map((status) => ({
    name: `status-${status}`,
    group: "HTTP status serialization",
    code: `return new Response('ok',{status:${status}});`,
    expected: "ok",
    status,
  })),
  {
    name: "host-capabilities",
    group: "Host API surface",
    code: `return {urlSearchParams:typeof URLSearchParams,cryptoSubtle:typeof crypto.subtle,clientFetch:typeof fetch,responseJson:typeof Response.json,readableStream:typeof ReadableStream,abortController:typeof AbortController,structuredClone:typeof structuredClone,process:typeof process};`,
    expected: {
      urlSearchParams: "function",
      cryptoSubtle: "object",
      clientFetch: "function",
      responseJson: "function",
      readableStream: "function",
      abortController: "function",
      structuredClone: "function",
      process: "object",
    },
  },
  { name: "url-query", group: "URL", code: `return new URL(request.url).searchParams.get('q');`, expected: "caffè 🚤" },
  { name: "response-json", group: "Response", code: `return Response.json({ok:true});`, expected: { ok: true } },
  {
    name: "request-text",
    group: "Ingress UTF-8",
    code: `const text=request.text();const codes=[];for(let i=0;i<text.length;i++)codes.push(text.charCodeAt(i));return {length:text.length,codes};`,
    body: "caffè-🚤",
    expected: { length: "caffè-🚤".length, codes: units("caffè-🚤") },
  },
  {
    name: "request-json",
    group: "Ingress UTF-8",
    code: `const value=request.json();const codes=[];for(let i=0;i<value.id.length;i++)codes.push(value.id.charCodeAt(i));return {length:value.id.length,codes};`,
    body: '{"id":"caffè-🚤"}',
    expected: { length: "caffè-🚤".length, codes: units("caffè-🚤") },
  },
  {
    name: "body-shape",
    group: "Request streaming",
    code: `return {bodyType:typeof request.body,getReader:typeof request.body.getReader,textThen:typeof request.text().then};`,
    body: "hello",
    expected: { bodyType: "object", getReader: "function", textThen: "function" },
  },
  {
    name: "encoder-bmp",
    group: "TextEncoder",
    code: `return Array.from(new TextEncoder().encode('caffè'));`,
    expected: Array.from(new TextEncoder().encode("caffè")),
  },
  {
    name: "encoder-astral",
    group: "TextEncoder",
    code: `return Array.from(new TextEncoder().encode('🚤'));`,
    expected: Array.from(new TextEncoder().encode("🚤")),
  },
  {
    name: "encoder-lone",
    group: "TextEncoder",
    code: `return Array.from(new TextEncoder().encode(String.fromCharCode(55296)));`,
    expected: [239, 191, 189],
  },
  {
    name: "encodeinto-short",
    group: "TextEncoder",
    code: `const dest=new Uint8Array(3);const result=new TextEncoder().encodeInto('🚤',dest);return {read:result.read,written:result.written,bytes:Array.from(dest)};`,
    expected: { read: 0, written: 0, bytes: [0, 0, 0] },
  },
  {
    name: "decoder-astral",
    group: "TextDecoder",
    code: `const text=new TextDecoder().decode(new Uint8Array([240,159,154,164]));const codes=[];for(let i=0;i<text.length;i++)codes.push(text.charCodeAt(i));return {length:text.length,codes};`,
    expected: { length: 2, codes: units("🚤") },
  },
  {
    name: "decoder-malformed",
    group: "TextDecoder",
    code: `const text=new TextDecoder().decode(new Uint8Array([255]));return {length:text.length,code:text.charCodeAt(0)};`,
    expected: { length: 1, code: 65533 },
  },
  {
    name: "json-unicode",
    group: "JSON",
    code: `const text=JSON.parse('{"id":"\\ud83d\\udea4"}').id;return {length:text.length,first:text.charCodeAt(0),second:text.charCodeAt(1)};`,
    expected: { length: 2, first: 55357, second: 56996 },
  },
  {
    name: "json-key",
    group: "JSON",
    code: `const value=JSON.parse('{"caff\\u00e8":42}');return value['caffè'];`,
    expected: 42,
  },
  {
    name: "json-quoted-key",
    group: "JSON",
    code: `const value={};value['a"b']=1;return new Response(JSON.stringify(value));`,
    expected: '{"a\\"b":1}',
  },
  {
    name: "json-lone",
    group: "JSON",
    code: `return new Response(JSON.stringify(String.fromCharCode(55296)));`,
    expected: '"\\ud800"',
  },
  {
    name: "json-trailing",
    group: "JSON",
    code: `let rejected=false;try{JSON.parse('{"x":1} garbage');}catch{rejected=true;}return rejected;`,
    expected: true,
  },
  {
    name: "proxy-traps",
    group: "Language semantics",
    code: `const target={x:1};let calls=0;const p=new Proxy(target,{get(t,k){calls++;return 2;}});return {value:p.x,calls};`,
    expected: { value: 2, calls: 1 },
  },
  {
    name: "typedarray-arraylike",
    group: "Language semantics",
    code: `return Array.from(Uint8Array.from({0:7,1:8,length:2}));`,
    expected: [7, 8],
  },
  {
    name: "closure",
    group: "Language semantics",
    code: `function make(x){return ()=>++x;}const f=make(4);return [f(),f()];`,
    expected: [5, 6],
  },
  {
    name: "date-offset",
    group: "Language semantics",
    code: `return Date.parse('2026-09-01T12:00:00+02:00');`,
    expected: Date.parse("2026-09-01T12:00:00+02:00"),
  },
  { name: "response-astral", group: "Response UTF-8", code: `return new Response('🚤');`, expected: "🚤" },
  {
    name: "async-direct",
    group: "Promise settlement",
    async: true,
    code: `return new Response('ok');`,
    expected: "ok",
  },
  {
    name: "async-return-inner",
    group: "Promise settlement",
    async: true,
    code: `return innerResponse();`,
    expected: "ok",
  },
  {
    name: "async-await-inner",
    group: "Promise settlement",
    async: true,
    code: `return await innerResponse();`,
    expected: "ok",
  },
  {
    name: "async-throw-inner",
    group: "Promise settlement",
    async: true,
    code: `return innerThrow();`,
    expected: "native fetch promise rejected",
    status: 500,
  },
  {
    name: "async-catch-await",
    group: "Promise settlement",
    async: true,
    code: `try{await innerThrow();}catch{return new Response('caught');}return new Response('uncaught');`,
    expected: "caught",
  },
  {
    name: "async-crypto",
    group: "Web Crypto",
    async: true,
    code: `await crypto.subtle.digest('SHA-256',new Uint8Array([1]));return new Response('ok');`,
    expected: "ok",
  },
  {
    name: "async-fetch",
    group: "Outbound HTTP",
    async: true,
    code: `const r=await fetch('http://127.0.0.1:18081/health');return new Response(await r.text());`,
    expected: "ok",
  },
];
