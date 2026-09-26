/**
 * Bun's bundler ships full Node-compatible polyfills for node:path,
 * node:url, and node:querystring under `target: "browser"`, but each has
 * exactly one thing wrong with it for a Porffor-compiled handler — found
 * by auditing bundled output against the capability check (source.ts) and,
 * for node:url, by an actual failure through the real Porffor compiler.
 * Auditing the bundle alone was not enough:
 *
 * - node:path's bundled `resolve()` falls back to `process.cwd()`, which
 *   trips the `process.` ban in `../packages/runtime/src/source.ts`.
 * - node:querystring's bundled polyfill pulls in Bun's full Buffer
 *   implementation internally (for percent-decoding), tripping the
 *   `Buffer.` ban.
 * - node:url's bundled `URL`/`URLSearchParams` exports are
 *   `var { URL, URLSearchParams } = globalThis;` — passes every capability
 *   check (no banned pattern in it) but Porffor's compiler rejects it at
 *   parse time as `Identifier 'URL' has already been declared`: Porffor
 *   pre-binds `URL` as a global, and a second top-level declaration of
 *   that exact name is a compile error, confirmed by actually building a
 *   handler through `sproutboat build` rather than just checking the
 *   bundle. `URL`/`URLSearchParams` are already global in a compiled
 *   handler (see `docs/concepts/handler.mdx`), so nothing needs importing
 *   — the fix is a shim that re-exports the globals under aliased local
 *   names instead of declaring anything literally named `URL`.
 *
 * None of these are the capability check being wrong — every case is a
 * real thing (`process.cwd()`, `Buffer`, a name Porffor itself reserves)
 * that doesn't exist the way a compiled handler needs it to, so the shims
 * replace it rather than the check being loosened.
 */
const NODE_PATH_SHIM = `
function assertPath(path) {
  if (typeof path !== "string")
    throw TypeError("Path must be a string. Received " + JSON.stringify(path));
}
function normalizeStringPosix(path, allowAboveRoot) {
  var res = "", lastSegmentLength = 0, lastSlash = -1, dots = 0, code;
  for (var i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (code === 47) break;
    else code = 47;
    if (code === 47) {
      if (lastSlash === i - 1 || dots === 1) {
      } else if (lastSlash !== i - 1 && dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== 46 || res.charCodeAt(res.length - 2) !== 46) {
          if (res.length > 2) {
            var lastSlashIndex = res.lastIndexOf("/");
            if (lastSlashIndex !== res.length - 1) {
              if (lastSlashIndex === -1) res = "", lastSegmentLength = 0;
              else res = res.slice(0, lastSlashIndex), lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
              lastSlash = i, dots = 0;
              continue;
            }
          } else if (res.length === 2 || res.length === 1) {
            res = "", lastSegmentLength = 0, lastSlash = i, dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          if (res.length > 0) res += "/..";
          else res = "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res += "/" + path.slice(lastSlash + 1, i);
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i, dots = 0;
    } else if (code === 46 && dots !== -1) ++dots;
    else dots = -1;
  }
  return res;
}
function _format(sep, pathObject) {
  var dir = pathObject.dir || pathObject.root, base = pathObject.base || (pathObject.name || "") + (pathObject.ext || "");
  if (!dir) return base;
  if (dir === pathObject.root) return dir + base;
  return dir + sep + base;
}
function resolve() {
  // Node falls back to process.cwd() here; a compiled handler has no real
  // filesystem or cwd, so an all-relative resolve() resolves against a
  // fixed virtual root instead.
  var resolvedPath = "", resolvedAbsolute = false, cwd;
  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path;
    if (i >= 0) path = arguments[i];
    else {
      if (cwd === undefined) cwd = "/";
      path = cwd;
    }
    if (assertPath(path), path.length === 0) continue;
    resolvedPath = path + "/" + resolvedPath, resolvedAbsolute = path.charCodeAt(0) === 47;
  }
  if (resolvedPath = normalizeStringPosix(resolvedPath, !resolvedAbsolute), resolvedAbsolute)
    if (resolvedPath.length > 0) return "/" + resolvedPath;
    else return "/";
  else if (resolvedPath.length > 0) return resolvedPath;
  else return ".";
}
function normalize(path) {
  if (assertPath(path), path.length === 0) return ".";
  var isAbsolute = path.charCodeAt(0) === 47, trailingSeparator = path.charCodeAt(path.length - 1) === 47;
  if (path = normalizeStringPosix(path, !isAbsolute), path.length === 0 && !isAbsolute) path = ".";
  if (path.length > 0 && trailingSeparator) path += "/";
  if (isAbsolute) return "/" + path;
  return path;
}
function isAbsolute(path) {
  return assertPath(path), path.length > 0 && path.charCodeAt(0) === 47;
}
function join() {
  if (arguments.length === 0) return ".";
  var joined;
  for (var i = 0; i < arguments.length; ++i) {
    var arg = arguments[i];
    if (assertPath(arg), arg.length > 0)
      if (joined === undefined) joined = arg;
      else joined += "/" + arg;
  }
  if (joined === undefined) return ".";
  return normalize(joined);
}
function relative(from, to) {
  if (assertPath(from), assertPath(to), from === to) return "";
  if (from = resolve(from), to = resolve(to), from === to) return "";
  var fromStart = 1;
  for (; fromStart < from.length; ++fromStart) if (from.charCodeAt(fromStart) !== 47) break;
  var fromEnd = from.length, fromLen = fromEnd - fromStart, toStart = 1;
  for (; toStart < to.length; ++toStart) if (to.charCodeAt(toStart) !== 47) break;
  var toEnd = to.length, toLen = toEnd - toStart, length = fromLen < toLen ? fromLen : toLen, lastCommonSep = -1, i = 0;
  for (; i <= length; ++i) {
    if (i === length) {
      if (toLen > length) {
        if (to.charCodeAt(toStart + i) === 47) return to.slice(toStart + i + 1);
        else if (i === 0) return to.slice(toStart + i);
      } else if (fromLen > length) {
        if (from.charCodeAt(fromStart + i) === 47) lastCommonSep = i;
        else if (i === 0) lastCommonSep = 0;
      }
      break;
    }
    var fromCode = from.charCodeAt(fromStart + i), toCode = to.charCodeAt(toStart + i);
    if (fromCode !== toCode) break;
    else if (fromCode === 47) lastCommonSep = i;
  }
  var out = "";
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i)
    if (i === fromEnd || from.charCodeAt(i) === 47)
      if (out.length === 0) out += "..";
      else out += "/..";
  if (out.length > 0) return out + to.slice(toStart + lastCommonSep);
  else {
    if (toStart += lastCommonSep, to.charCodeAt(toStart) === 47) ++toStart;
    return to.slice(toStart);
  }
}
function dirname(path) {
  if (assertPath(path), path.length === 0) return ".";
  var code = path.charCodeAt(0), hasRoot = code === 47, end = -1, matchedSlash = true;
  for (var i = path.length - 1; i >= 1; --i)
    if (code = path.charCodeAt(i), code === 47) {
      if (!matchedSlash) { end = i; break; }
    } else matchedSlash = false;
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return path.slice(0, end);
}
function basename(path, ext) {
  if (ext !== undefined && typeof ext !== "string") throw TypeError('"ext" argument must be a string');
  assertPath(path);
  var start = 0, end = -1, matchedSlash = true, i;
  if (ext !== undefined && ext.length > 0 && ext.length <= path.length) {
    if (ext.length === path.length && ext === path) return "";
    var extIdx = ext.length - 1, firstNonSlashEnd = -1;
    for (i = path.length - 1; i >= 0; --i) {
      var code = path.charCodeAt(i);
      if (code === 47) {
        if (!matchedSlash) { start = i + 1; break; }
      } else {
        if (firstNonSlashEnd === -1) matchedSlash = false, firstNonSlashEnd = i + 1;
        if (extIdx >= 0)
          if (code === ext.charCodeAt(extIdx)) { if (--extIdx === -1) end = i; }
          else extIdx = -1, end = firstNonSlashEnd;
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  } else {
    for (i = path.length - 1; i >= 0; --i)
      if (path.charCodeAt(i) === 47) {
        if (!matchedSlash) { start = i + 1; break; }
      } else if (end === -1) matchedSlash = false, end = i + 1;
    if (end === -1) return "";
    return path.slice(start, end);
  }
}
function extname(path) {
  assertPath(path);
  var startDot = -1, startPart = 0, end = -1, matchedSlash = true, preDotState = 0;
  for (var i = path.length - 1; i >= 0; --i) {
    var code = path.charCodeAt(i);
    if (code === 47) {
      if (!matchedSlash) { startPart = i + 1; break; }
      continue;
    }
    if (end === -1) matchedSlash = false, end = i + 1;
    if (code === 46) { if (startDot === -1) startDot = i; else if (preDotState !== 1) preDotState = 1; }
    else if (startDot !== -1) preDotState = -1;
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || preDotState === 1 && startDot === end - 1 && startDot === startPart + 1) return "";
  return path.slice(startDot, end);
}
function format(pathObject) {
  if (pathObject === null || typeof pathObject !== "object")
    throw TypeError('The "pathObject" argument must be of type Object. Received type ' + typeof pathObject);
  return _format("/", pathObject);
}
function parse(path) {
  assertPath(path);
  var ret = { root: "", dir: "", base: "", ext: "", name: "" };
  if (path.length === 0) return ret;
  var code = path.charCodeAt(0), isAbsolute2 = code === 47, start;
  if (isAbsolute2) ret.root = "/", start = 1;
  else start = 0;
  var startDot = -1, startPart = 0, end = -1, matchedSlash = true, i = path.length - 1, preDotState = 0;
  for (; i >= start; --i) {
    if (code = path.charCodeAt(i), code === 47) {
      if (!matchedSlash) { startPart = i + 1; break; }
      continue;
    }
    if (end === -1) matchedSlash = false, end = i + 1;
    if (code === 46) { if (startDot === -1) startDot = i; else if (preDotState !== 1) preDotState = 1; }
    else if (startDot !== -1) preDotState = -1;
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || preDotState === 1 && startDot === end - 1 && startDot === startPart + 1) {
    if (end !== -1)
      if (startPart === 0 && isAbsolute2) ret.base = ret.name = path.slice(1, end);
      else ret.base = ret.name = path.slice(startPart, end);
  } else {
    if (startPart === 0 && isAbsolute2) ret.name = path.slice(1, startDot), ret.base = path.slice(1, end);
    else ret.name = path.slice(startPart, startDot), ret.base = path.slice(startPart, end);
    ret.ext = path.slice(startDot, end);
  }
  if (startPart > 0) ret.dir = path.slice(0, startPart - 1);
  else if (isAbsolute2) ret.dir = "/";
  return ret;
}
var sep = "/";
var delimiter = ":";
var path = { resolve, normalize, isAbsolute, join, relative, dirname, basename, extname, format, parse, sep, delimiter };
path.posix = path;
path.win32 = path;
export default path;
export { resolve, normalize, isAbsolute, join, relative, dirname, basename, extname, format, parse, sep, delimiter };
`;

/**
 * node:querystring's bundled polyfill pulls in Bun's full Buffer
 * implementation (used internally for percent-decoding), which the
 * capability check correctly rejects — Buffer isn't something Porffor's
 * compiled output can rely on. This shim implements parse/stringify/
 * escape/unescape (plus the encode/decode aliases Node exports) over
 * plain string ops and encodeURIComponent/decodeURIComponent instead.
 */
const NODE_QUERYSTRING_SHIM = `
function qsUnescape(str) {
  try { return decodeURIComponent(String(str).replace(/\\+/g, " ")); }
  catch { return String(str); }
}
function qsEscape(str) {
  return encodeURIComponent(String(str));
}
function parse(qs, sep, eq, options) {
  sep = sep || "&";
  eq = eq || "=";
  var obj = Object.create(null);
  if (typeof qs !== "string" || qs.length === 0) return obj;
  var decode = (options && options.decodeURIComponent) || qsUnescape;
  var maxKeys = options && typeof options.maxKeys === "number" ? options.maxKeys : 1000;
  var pairs = qs.split(sep);
  var limit = maxKeys > 0 ? Math.min(pairs.length, maxKeys) : pairs.length;
  for (var i = 0; i < limit; i++) {
    var pair = pairs[i];
    var eqIdx = pair.indexOf(eq);
    var key, value;
    if (eqIdx >= 0) { key = pair.slice(0, eqIdx); value = pair.slice(eqIdx + eq.length); }
    else { key = pair; value = ""; }
    key = decode(key);
    value = decode(value);
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (Array.isArray(obj[key])) obj[key].push(value);
      else obj[key] = [obj[key], value];
    } else obj[key] = value;
  }
  return obj;
}
function stringify(obj, sep, eq, options) {
  sep = sep || "&";
  eq = eq || "=";
  obj = obj || {};
  var encode = (options && options.encodeURIComponent) || qsEscape;
  var parts = [];
  for (var key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    var value = obj[key];
    var encodedKey = encode(key);
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) parts.push(encodedKey + eq + encode(value[i]));
    } else {
      parts.push(encodedKey + eq + encode(value));
    }
  }
  return parts.join(sep);
}
export { parse, stringify, qsEscape as escape, qsUnescape as unescape, stringify as encode, parse as decode };
export default { parse, stringify, escape: qsEscape, unescape: qsUnescape, encode: stringify, decode: parse };
`;

/**
 * `URL`/`URLSearchParams` are re-exported under aliased local names
 * (`NodeURL`/`NodeURLSearchParams`) rather than declared as top-level
 * `URL`/`URLSearchParams` — Porffor pre-binds `URL` as a global and
 * rejects a second top-level declaration of that name. legacy
 * parse/format/resolve are hand-written over the WHATWG URL rather than
 * Bun's internal legacy-Url implementation, which isn't something this
 * shim can import from; good enough for the common absolute-URL case,
 * not a byte-for-byte port of Node's edge cases (relative/protocol-less
 * input, unusual schemes).
 */
const NODE_URL_SHIM = `
var NodeURL = globalThis.URL;
var NodeURLSearchParams = globalThis.URLSearchParams;
function urlFormat(urlObject) {
  if (typeof urlObject === "string") return urlObject;
  if (urlObject instanceof NodeURL) return urlObject.href;
  var protocol = urlObject.protocol || "";
  var slashes = urlObject.slashes !== false && !!(urlObject.host || urlObject.hostname);
  var auth = urlObject.auth ? urlObject.auth + "@" : "";
  var host = urlObject.host || ((urlObject.hostname || "") + (urlObject.port ? ":" + urlObject.port : ""));
  var pathname = urlObject.pathname || "";
  var search = urlObject.search || (urlObject.query ? "?" + (typeof urlObject.query === "string" ? urlObject.query : "") : "");
  var hash = urlObject.hash || "";
  return protocol + (slashes ? "//" : "") + auth + host + pathname + search + hash;
}
function legacyFromURL(u) {
  return {
    protocol: u.protocol,
    slashes: true,
    auth: u.username ? u.username + (u.password ? ":" + u.password : "") : null,
    host: u.host,
    port: u.port || null,
    hostname: u.hostname,
    hash: u.hash || null,
    search: u.search || null,
    query: u.search ? u.search.slice(1) : null,
    pathname: u.pathname,
    path: u.pathname + (u.search || ""),
    href: u.href,
  };
}
function urlParse(input) {
  return legacyFromURL(new NodeURL(input));
}
function urlResolve(from, to) {
  return new NodeURL(to, new NodeURL(from)).href;
}
export { NodeURL as URL, NodeURLSearchParams as URLSearchParams, urlFormat as format, urlParse as parse, urlResolve as resolve };
export default { URL: NodeURL, URLSearchParams: NodeURLSearchParams, format: urlFormat, parse: urlParse, resolve: urlResolve };
`;

export const NODE_SHIMS = {
  "node:path": NODE_PATH_SHIM,
  "node:querystring": NODE_QUERYSTRING_SHIM,
  "node:url": NODE_URL_SHIM,
} satisfies Record<string, string>;
