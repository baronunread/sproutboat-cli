import qs from "qs";
export default {
  fetch() {
    return Response.json({
      parsed: qs.parse("a[b]=c&list[]=1&list[]=2"),
      encoded: qs.stringify({ a: { b: "c" }, list: ["1", "2"] }),
    });
  },
};
