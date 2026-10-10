// Quoting for the values the panel writes into the start scripts it generates
// (routes/server.js generateStartupScripts()): the server name, the Zomboid
// data folder (-cachedir) and the admin password (-adminpassword).
//
// These used to be "sanitized" by deleting every character that is special to
// a shell, so D:\Games (x86)\PZ Data became D:\Games x86\PZ Data and
// P@ss%w0rd!&x$y became P@ssw0rdxy: the game then ran against a different
// folder than the panel, or with a different admin password, and nothing said
// so. A value is now quoted for the script it goes into, so it reaches the
// game exactly as stored, and a value that cannot be quoted safely is refused
// where it is saved and again where the script is generated -- never changed.
//
// What cannot be represented: a double quote (inside a .bat's "..." it ends
// the quote for cmd.exe and has no escape that survives both cmd.exe and the
// Java launcher's argument parsing) and control characters (a line break ends
// the script line; NUL ends a string). Both scripts are generated for every
// platform from the same values, so the rule is the same for both.
const UNQUOTABLE = /[\u0000-\u001f\u007f"]/;

/** null when `value` can go into a start script, else why not. */
export function startScriptValueProblem(value) {
  const text = String(value ?? "");
  if (/[\u0000-\u001f\u007f]/.test(text)) return "control";
  if (text.includes('"')) return "quote";
  return null;
}

function assertQuotable(text, what) {
  if (UNQUOTABLE.test(text)) {
    const error = new Error(
      `${what} contains a double quote or a control character (such as a line break), which a start script cannot carry safely. Remove it and save again.`,
    );
    error.code = "START_SCRIPT_VALUE_UNQUOTABLE";
    throw error;
  }
}

/**
 * `value` as one double-quoted word of a Windows .bat file.
 *  - % is doubled: cmd.exe expands %VAR% even inside quotes.
 *  - A run of backslashes at the end is doubled: the Java launcher splits its
 *    command line with the C runtime's rules, where a backslash before a
 *    double quote escapes it, so "D:\Zomboid Data\" would swallow the closing
 *    quote (and the arguments after it) into the path.
 * Everything else (& | < > ^ ( ) ! and so on) is literal between the quotes;
 * the script turns delayed expansion off so ! is too.
 */
export function quoteForBatch(value, what = "A value") {
  const text = String(value ?? "");
  assertQuotable(text, what);
  // Counted with a loop, not /\\+$/: that pattern is polynomial on a long run
  // of backslashes (CodeQL js/polynomial-redos on #228).
  let end = text.length;
  while (end > 0 && text[end - 1] === "\\") end -= 1;
  const body = text.slice(0, end).replace(/%/g, "%%");
  const trailingBackslashes = text.slice(end);
  return `"${body}${trailingBackslashes}${trailingBackslashes}"`;
}

/**
 * `value` as one single-quoted word of a bash script: nothing between single
 * quotes is special, except the single quote itself, closed and escaped.
 */
export function quoteForShell(value, what = "A value") {
  const text = String(value ?? "");
  assertQuotable(text, what);
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** `value` as text for a comment line: only a plain, harmless subset. */
export function textForScriptComment(value) {
  return String(value ?? "").replace(/[^\p{L}\p{N} _.-]/gu, "_");
}
