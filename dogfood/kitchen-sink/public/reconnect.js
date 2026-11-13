// The chat's reconnect rules, apart from the page so they can be tested (worker.test.ts loads this file
// in a process with no DOM). A plain script: it sets globalThis.SBReconnect (window, in a page), which app.js reads.
(function () {
  "use strict";

  var FIRST = 500; // the shortest wait, ms
  var CEILING = 30000; // the longest, ms
  var STABLE = 10000; // a connection open this long counts as a good one: the backoff starts over

  // How long to wait before attempt number `attempt` (0 for the first retry), in ms. Exponential with full
  // jitter: the ceiling doubles from 1 s up to 30 s and the wait is anywhere between FIRST and that ceiling,
  // so a room's worth of pages that lost the same server do not come back in step. `random` is a number
  // from 0 up to 1 (Math.random in the page).
  function delay(attempt, random) {
    var ceiling = Math.min(CEILING, 1000 * Math.pow(2, Math.max(0, attempt)));
    return Math.round(FIRST + random * (ceiling - FIRST));
  }

  // Does a close that followed an open socket mean "the room does not want you back"? The room says so with
  // 1008 (policy), 4008 (too many refused frames: a Durable Object may close with 3000 to 4999) or another
  // application code, and the protocol codes 1002, 1003, 1007, 1009 and 1010 mean this page sent something
  // the room cannot take. Anything else (1000, 1001 going away, 1005, 1006 dropped, 1011, 1012, 1013) is a
  // connection that was lost, and the page goes back.
  function isFinal(code) {
    return (
      code === 1002 ||
      code === 1003 ||
      code === 1007 ||
      code === 1008 ||
      code === 1009 ||
      code === 1010 ||
      (code >= 3000 && code <= 4999)
    );
  }

  // What a plain GET of /api/chat says about a socket that never opened. 503 is the room refusing (full):
  // do not go back. 429 is a rate limit or the five connections an address may hold, both of which pass:
  // wait at least `retryAfter` seconds. Anything else (no answer, 426 "expected an upgrade") is the network
  // or the server being away: ordinary backoff.
  function afterRefusal(status, retryAfter) {
    if (status === 503) return { retry: false, minWait: 0 };
    if (status === 429) return { retry: true, minWait: Math.max(0, Number(retryAfter) || 0) * 1000 };
    return { retry: true, minWait: 0 };
  }

  globalThis.SBReconnect = {
    FIRST: FIRST,
    CEILING: CEILING,
    STABLE: STABLE,
    delay: delay,
    isFinal: isFinal,
    afterRefusal: afterRefusal,
  };
})();
