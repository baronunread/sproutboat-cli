/**
 * The broker transport: one long-lived loopback connection to the per-deployment
 * binding broker, `[u32 LE length][payload]` frames both ways.
 *
 * This is what a deployed sprout uses, and what `sproutboat dev` and a phase-0
 * standalone binary use. The embedded transport (transport-embedded.js) is the
 * same `__sbCall(reqJson) -> replyJson` contract with SQLite compiled in
 * instead of a broker on the other end — everything above __sbCall is shared.
 */
// SB_BROKER_PORT / SB_BROKER_TOKEN are set by the supervisor next to $PORT.
// If SB_BROKER_PORT is unset the shims below are never installed (compile.ts
// only emits the __sbInstallBindings call when the project declares bindings),
// so a plain sprout is byte-for-byte unchanged.
// ponytail: text values only; still AF_INET loopback, not AF_UNIX. A failed
// exchange reconnects and resends once — a broker crash between "request applied"
// and "reply read" can double-apply a non-idempotent op (queue.send, INSERT);
// the old fresh-connection-per-call path just failed the call there instead.
// Binary values + AF_UNIX = v2.

// oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
Porffor.c`
static int sb_io_all(int fd, unsigned char* buf, size_t len, int writing) {
  size_t done = 0;
  while (done < len) {
    long n = writing ? write(fd, buf + done, len - done) : read(fd, buf + done, len - done);
    if (n <= 0) {
      if (n < 0 && errno == EINTR) continue;
      return -1;
    }
    done += (size_t)n;
  }
  return 0;
}

// One long-lived loopback connection to the broker, reused across every binding
// call. The broker frames each request/reply independently and keeps the socket
// open, so the steady-state per-call cost is just write + read — no socket(),
// connect() handshake or close() each time. -1 = not connected.
static int sb_broker_fd = -1;

static int sb_broker_connect(void) {
  const char* port_s = getenv("SB_BROKER_PORT");
  if (!port_s) return -10;
  signal(SIGPIPE, SIG_IGN); // a dead broker must yield EPIPE, not kill the sprout
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons((unsigned short)atoi(port_s));
  addr.sin_addr.s_addr = htonl(0x7f000001u); // 127.0.0.1
  if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) != 0) { close(fd); return -2; }
  sb_broker_fd = fd;
  return 0;
}

// Send one framed request, read one framed reply, on the persistent fd.
static int sb_broker_exchange(const char* req, size_t req_len, char** resp_out, size_t* resp_len_out) {
  const char* tok = getenv("SB_BROKER_TOKEN");
  size_t tok_len = tok ? strlen(tok) : 0;

  // frame body: token "\n" json
  size_t body_len = tok_len + 1 + req_len;
  unsigned char* frame = (unsigned char*)malloc(4 + body_len);
  if (!frame) return -5;
  frame[0] = (unsigned char)(body_len & 0xff);
  frame[1] = (unsigned char)((body_len >> 8) & 0xff);
  frame[2] = (unsigned char)((body_len >> 16) & 0xff);
  frame[3] = (unsigned char)((body_len >> 24) & 0xff);
  if (tok_len) memcpy(frame + 4, tok, tok_len);
  frame[4 + tok_len] = '\n';
  if (req_len) memcpy(frame + 4 + tok_len + 1, req, req_len);
  int wr = sb_io_all(sb_broker_fd, frame, 4 + body_len, 1);
  free(frame);
  if (wr != 0) return -3;

  unsigned char rhdr[4];
  if (sb_io_all(sb_broker_fd, rhdr, 4, 0) != 0) return -4;
  size_t rlen = (size_t)rhdr[0] | ((size_t)rhdr[1] << 8) | ((size_t)rhdr[2] << 16) | ((size_t)rhdr[3] << 24);

  char* buf = (char*)malloc(rlen ? rlen : 1);
  if (!buf) return -5;
  if (rlen && sb_io_all(sb_broker_fd, (unsigned char*)buf, rlen, 0) != 0) { free(buf); return -6; }

  *resp_out = buf;
  *resp_len_out = rlen;
  return 0;
}

static int sb_broker_roundtrip(const char* req, size_t req_len, char** resp_out, size_t* resp_len_out) {
  *resp_out = NULL;
  *resp_len_out = 0;
  // Two tries: a broker restart (or an idle-closed socket) invalidates the fd,
  // so a failed exchange drops the connection and reconnects once before failing.
  for (int attempt = 0; attempt < 2; attempt++) {
    if (sb_broker_fd < 0) {
      int rc = sb_broker_connect();
      if (rc != 0) return rc;
    }
    int rc = sb_broker_exchange(req, req_len, resp_out, resp_len_out);
    if (rc == 0) return 0;
    close(sb_broker_fd);
    sb_broker_fd = -1;
  }
  return -3;
}
`;

// One request string in, one reply string out. `reqJson` is a parameter, so the
// generated C names it directly in the RawC block below.
// oxlint-disable-next-line no-unused-vars -- `reqJson` is read inside the RawC block below, not by JS.
function __sbCall(reqJson) {
  let res = "";
  // oxlint-disable-next-line no-unused-expressions -- Porffor.c`...` is inline C the compiler consumes, not a JS expression.
  Porffor.c`
    const char* __req; size_t __reqlen; char* __reqowned = 0;
    porf_native_fetch_read_value(reqJson, &__req, &__reqlen, &__reqowned);
    char* __resp = 0; size_t __resplen = 0;
    int __rc = sb_broker_roundtrip(__req, __reqlen, &__resp, &__resplen);
    if (__reqowned) free(__reqowned);
    if (__rc == 0) {
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__resp, __resplen), 195);
      free(__resp);
    } else {
      char __e[40];
      int __n = snprintf(__e, sizeof(__e), "{\"ok\":false,\"error\":\"broker rc %d\"}", __rc);
      res = porf_box((f64)porf_native_fetch_alloc_bytestring(__e, (size_t)__n), 195);
    }
  `;
  return res;
}
