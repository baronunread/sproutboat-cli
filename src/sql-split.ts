/**
 * Split a SQL script into its statements, the way `d1 execute --file` and a migration need them one by one: at a
 * semicolon that is not inside a quoted string, a quoted identifier, a comment or the body of a trigger. Statements are
 * returned trimmed, without the final semicolon, and empty ones (a stray `;`, a trailing comment) are dropped.
 */
export function splitSql(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0; // BEGIN ... END nesting inside CREATE TRIGGER (and CASE ... END inside it)
  let word = "";
  const flushWord = () => {
    const upper = word.toUpperCase();
    if (
      upper === "BEGIN" &&
      /^\s*CREATE\s+(TEMP(ORARY)?\s+)?TRIGGER\b/i.test(stripComments(current.slice(0, current.length - word.length)))
    )
      depth++;
    else if (upper === "CASE" && depth > 0) depth++;
    else if (upper === "END" && depth > 0) depth--;
    word = "";
  };
  const push = () => {
    if (stripComments(current).trim() !== "") statements.push(current.trim());
    current = "";
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (word && !/[A-Za-z0-9_]/.test(ch)) flushWord();
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      flushWord();
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      for (; j < script.length; j++) {
        if (script[j] === close) {
          if (close !== "]" && script[j + 1] === close) j++; // doubled quote is an escaped quote
          else break;
        }
      }
      current += script.slice(i, j + 1);
      i = j;
    } else if (ch === "-" && script[i + 1] === "-") {
      flushWord();
      const end = script.indexOf("\n", i);
      const stop = end < 0 ? script.length : end;
      current += script.slice(i, stop);
      i = stop - 1;
    } else if (ch === "/" && script[i + 1] === "*") {
      flushWord();
      const end = script.indexOf("*/", i + 2);
      const stop = end < 0 ? script.length : end + 2;
      current += script.slice(i, stop);
      i = stop - 1;
    } else if (ch === ";" && depth === 0) {
      flushWord();
      push();
    } else {
      if (/[A-Za-z0-9_]/.test(ch)) word += ch;
      current += ch;
    }
  }
  flushWord();
  push();
  return statements;
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
