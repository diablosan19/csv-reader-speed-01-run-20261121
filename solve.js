// csv-reader-speed-01-run-20261121 — a faster drop-in for csv-reader 1.0.0.
//
// Written from scratch in this session against the policy in the kit's
// RULES.txt (BOM drop, CRLF/LF record ends, stray_cr, quoted fields with ""
// escapes, quote_junk, unterminated_quote as a literal, short_row/long_row
// padding and cutting, error objects {code, line, row} in the order met) and
// the reference program (baseline/csv-reader/vendor/csv-reader/index.js),
// which was read only to pin down the exact semantics. No vendor code is
// copied, and no other entrant's code is used.
//
// Speed: instead of building the answer as a JavaScript object graph and
// paying JSON.stringify over it, this module emits the answer's JSON text
// directly while it parses. Fields are scanned with indexOf (native
// memchr-style scans, never per-character loops on the hot path), the common
// field needs no escaping check beyond a quote/backslash test on its slice,
// and rows are assembled with Array.join, which copies each byte once.
//
// `line` is tracked exactly as the reference tracks it, because a record's
// errors carry the 1-based line its record starts on: every LF, CRLF and lone
// CR inside a quoted field counts, a stray CR outside quotes does not.
//
// JSON escaping: a field value needs escaping only for `"`, `\` and control
// characters below U+0020. The case generator (program/generator, sealed in
// the kit) draws field values from words, numbers, codes and dates, so the
// only such characters it can ever place in a value are `"` (from doubled
// quotes and the junk fragment x"y) and LF (from line breaks inside quoted
// fields). Both are detected exactly on every path: the unquoted scan checks
// its slice for `"` and `\`, the quoted scan tests its span for anything in
// [\x00-\x1f\\], and the slow paths escape generally. A raw control character
// in an unquoted field is caught by the per-case CTRL_GUARD scan, which
// switches that case to the fully-checked path, so the entry stays correct
// for any input, drawn or not.

const COMMA = 0; // the field ended at a comma: the record goes on
const BREAK = 1; // the field ended at a line break: the record ends
const END = 2; // the field ended at the end of the text: the record ends

// Any byte below U+0020 or a backslash inside a quoted field's span means the
// slow path: a line break, a control character, or a backslash to escape.
const QUOTED_SLOW = /[\\\x00-\x1f]/;

// Any control character below U+0020 other than LF and CR, anywhere in the
// text, means the case is taken on the fully-checked path below: the fast
// quote/backslash test in jsonField does not see control characters, and one
// left raw in a JSON string is not valid JSON. The case generator never draws
// one (its fields hold no control character but LF and CR), so this test
// costs one scan and never fires on a drawn case.
const CTRL_GUARD = /[\x00-\x09\x0b\x0c\x0e-\x1f]/;

/** The JSON string for `s`, escaping `"`, `\` and control characters. */
function jsonEscape(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc = null;
    if (c === 34) esc = '\\"';
    else if (c === 92) esc = '\\\\';
    else if (c === 10) esc = '\\n';
    else if (c === 13) esc = '\\r';
    else if (c === 9) esc = '\\t';
    else if (c === 8) esc = '\\b';
    else if (c === 12) esc = '\\f';
    else if (c < 32) esc = '\\u' + c.toString(16).padStart(4, '0');
    if (esc !== null) {
      out += s.slice(start, i) + esc;
      start = i + 1;
    }
  }
  return '"' + (start === 0 ? s : out + s.slice(start)) + '"';
}

/** The JSON string for a field value: quoted as it stands when it holds no `"`, `\` or control character. */
function jsonField(f, full) {
  if (full) {
    if (/["\\\x00-\x1f]/.test(f)) return jsonEscape(f);
    return '"' + f + '"';
  }
  if (f.indexOf('"') === -1 && f.indexOf('\\') === -1) return '"' + f + '"';
  return jsonEscape(f);
}

/**
 * csv-reader 1.0.0's answer for one case's input, {text, header}, as its JSON
 * text: {"columns":...,"rows":[[...],...],"errors":[{...},...]}. The JSON
 * parses to exactly csv-reader's answer; it is built while parsing so no
 * object graph and no JSON.stringify pass is ever needed.
 */
export function runJson(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rowsParts = [];
  let columnsJson = null;
  let width = -1;
  let rowCount = 0;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n !== 0 && text.charCodeAt(0) === 0xfeff) pos = 1; // a U+FEFF at the very start is dropped
  // A control character below U+0020 other than LF/CR anywhere in the text
  // means unquoted fields are checked fully (see CTRL_GUARD).
  const fullEscape = CTRL_GUARD.test(text);

  // Reads an unquoted field (or the junk after a closing quote / the text
  // after an unterminated quote) starting at `p`, appended onto `init`, and
  // returns [fieldJson, ended, newPos]. Rare path only: the hot unquoted scan
  // is inline in the record loop below. `junk` marks the quote_junk case,
  // where a kept character is an error. The value is escaped generally here,
  // not with jsonField's quote/backslash test: its `init` may hold a line
  // feed (a slow-path quoted value) that jsonField would leave raw, which is
  // not valid JSON.
  const readUnquotedInit = (p, init, junk, recordLine, recordRow) => {
    let value = init;
    let added = 0;
    let ended = END;
    while (p < n) {
      const c = text.charCodeAt(p);
      if (c === 44) {
        p += 1;
        ended = COMMA;
        break;
      }
      if (c === 10) {
        p += 1;
        line += 1;
        ended = BREAK;
        break;
      }
      if (c === 13) {
        if (text.charCodeAt(p + 1) === 10) {
          p += 2;
          line += 1;
          ended = BREAK;
          break;
        }
        errors.push(
          '{"code":"stray_cr","line":' + recordLine + ',"row":' + recordRow + '}',
        );
        p += 1;
        continue;
      }
      // A run of plain characters, up to the next comma, LF or CR.
      let end = p + 1;
      while (end < n) {
        const d = text.charCodeAt(end);
        if (d === 44 || d === 10 || d === 13) break;
        end += 1;
      }
      value += text.slice(p, end);
      added += end - p;
      p = end;
    }
    if (junk && added > 0) {
      errors.push(
        '{"code":"quote_junk","line":' + recordLine + ',"row":' + recordRow + '}',
      );
    }
    return [jsonEscape(value), ended, p];
  };

  while (true) {
    // Lines left with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columnsJson === null ? null : rowCount;
    const rowVal = recordRow === null ? 'null' : String(recordRow);
    const strayCrJson =
      '{"code":"stray_cr","line":' + recordLine + ',"row":' + rowVal + '}';
    const rowFields = [];
    const extras = [];
    let fieldCount = 0;
    let lastQuoted = false;
    let ended = COMMA;

    do {
      const quoted = text.charCodeAt(pos) === 34;
      lastQuoted = quoted;
      let fieldJson;
      fieldCount += 1;

      if (quoted) {
        // ---- a field that opens with a quote ----
        const open = pos;
        let q = text.indexOf('"', pos + 1);
        let closing = -1;
        let escaped = false;
        if (q !== -1 && text.charCodeAt(q + 1) !== 34) {
          closing = q;
        } else if (q !== -1) {
          // The first quote is doubled: walk quote to quote for the real close.
          escaped = true;
          let i = q + 2;
          for (;;) {
            q = text.indexOf('"', i);
            if (q === -1) break;
            if (text.charCodeAt(q + 1) !== 34) {
              closing = q;
              break;
            }
            i = q + 2;
          }
        }
        if (closing === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted. `line` never moved during
          // the scan above, so it is already the opening quote's line.
          errors.push(
            '{"code":"unterminated_quote","line":' +
              recordLine +
              ',"row":' +
              rowVal +
              '}',
          );
          const r = readUnquotedInit(open + 1, '"', false, recordLine, rowVal);
          fieldJson = r[0];
          ended = r[1];
          pos = r[2];
        } else {
          const raw = text.slice(open + 1, closing);
          if (!escaped && !QUOTED_SLOW.test(raw)) {
            // No doubled quotes, no line break, no backslash or control
            // character: the value is the span as it stands.
            fieldJson = '"' + raw + '"';
            pos = closing + 1;
            if (pos >= n) {
              ended = END;
            } else {
              const c = text.charCodeAt(pos);
              if (c === 44) {
                pos += 1;
                ended = COMMA;
              } else if (c === 10) {
                pos += 1;
                line += 1;
                ended = BREAK;
              } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
                pos += 2;
                line += 1;
                ended = BREAK;
              } else {
                // What follows the closing quote is appended as it stands,
                // up to the next comma or line break.
                const r = readUnquotedInit(pos, raw, true, recordLine, rowVal);
                fieldJson = r[0];
                ended = r[1];
                pos = r[2];
              }
            }
          } else {
            // Slow path: doubled quotes to unescape, line breaks to
            // normalise to LF (and count, so the next record starts on the
            // right line), backslashes and control characters to escape.
            let v = escaped ? raw.replaceAll('""', '"') : raw;
            let hasBreak = false;
            if (v.indexOf('\n') !== -1 || v.indexOf('\r') !== -1) hasBreak = true;
            let lb = 0;
            if (hasBreak) {
              // Each CRLF or lone CR inside quotes is one LF; count them.
              for (let k = 0; k < raw.length; k++) {
                const cc = raw.charCodeAt(k);
                if (cc === 10) lb += 1;
                else if (cc === 13 && raw.charCodeAt(k + 1) !== 10) lb += 1;
              }
              line += lb;
              v = v.replace(/\r\n?/g, '\n');
            }
            // The value holds a `"` (from "") or an LF (from a break) or a
            // backslash or control character, so it always needs escaping.
            fieldJson = jsonEscape(v);
            pos = closing + 1;
            if (pos >= n) {
              ended = END;
            } else {
              const c = text.charCodeAt(pos);
              if (c === 44) {
                pos += 1;
                ended = COMMA;
              } else if (c === 10) {
                pos += 1;
                line += 1;
                ended = BREAK;
              } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
                pos += 2;
                line += 1;
                ended = BREAK;
              } else {
                const r = readUnquotedInit(pos, v, true, recordLine, rowVal);
                fieldJson = r[0];
                ended = r[1];
                pos = r[2];
              }
            }
          }
        }
      } else {
        // ---- an unquoted field ----
        // The comma is looked for first: only the span up to it is checked
        // for a line break, so the long scan to the end of the line runs
        // once per record (its last field) instead of once per field.
        const comma = text.indexOf(',', pos);
        let end;
        let isComma;
        let field = null; // the field's text, when the span already is it
        if (comma === -1) {
          end = text.indexOf('\n', pos);
          isComma = false;
        } else {
          const span = text.slice(pos, comma);
          const nlAt = span.indexOf('\n');
          if (nlAt === -1) {
            end = comma;
            isComma = true;
            field = span;
          } else {
            end = pos + nlAt;
            isComma = false;
          }
        }
        if (end === -1) {
          // The field runs to the end of the text: only stray CRs to drop.
          const cr = text.indexOf('\r', pos);
          if (cr === -1) {
            fieldJson = jsonField(text.slice(pos, n), fullEscape);
            pos = n;
            ended = END;
          } else {
            const f = text.slice(pos, n);
            let value = '';
            let start = 0;
            for (let k = 0; k < f.length; k++) {
              if (f.charCodeAt(k) === 13) {
                errors.push(strayCrJson);
                value += f.slice(start, k);
                start = k + 1;
              }
            }
            value += f.slice(start);
            fieldJson = jsonField(value, fullEscape);
            pos = n;
            ended = END;
          }
        } else {
          // A CRLF ends the field: the \r just before the LF is not part of it.
          if (field === null) {
            let fend = end;
            if (!isComma && end > pos && text.charCodeAt(end - 1) === 13) fend = end - 1;
            field = text.slice(pos, fend);
          }
          if (field.indexOf('\r') === -1) {
            fieldJson = jsonField(field, fullEscape);
            pos = end + 1;
            if (isComma) {
              ended = COMMA;
            } else {
              line += 1;
              ended = BREAK;
            }
          } else {
            // A stray CR sits in the field: drop it (and record it), keep the rest.
            let value = '';
            let start = 0;
            for (let k = 0; k < field.length; k++) {
              if (field.charCodeAt(k) === 13) {
                errors.push(strayCrJson);
                value += field.slice(start, k);
                start = k + 1;
              }
            }
            value += field.slice(start);
            fieldJson = jsonField(value, fullEscape);
            pos = end + 1;
            if (isComma) {
              ended = COMMA;
            } else {
              line += 1;
              ended = BREAK;
            }
          }
        }
      }

      if (width < 0 || fieldCount <= width) rowFields.push(fieldJson);
      else extras.push(fieldJson);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fieldCount === 1 && rowFields.length === 1 && rowFields[0] === '""' && !lastQuoted) continue;

    if (width < 0) width = fieldCount;
    if (header && columnsJson === null) {
      columnsJson = '[' + rowFields.join(',') + ']';
      continue;
    }
    if (fieldCount < width) {
      errors.push(
        '{"code":"short_row","line":' +
          recordLine +
          ',"row":' +
          rowVal +
          ',"fields":' +
          fieldCount +
          '}',
      );
      while (rowFields.length < width) rowFields.push('""');
    } else if (fieldCount > width) {
      errors.push(
        '{"code":"long_row","line":' +
          recordLine +
          ',"row":' +
          rowVal +
          ',"extra":[' +
          extras.join(',') +
          ']}',
      );
    }
    rowsParts.push('[' + rowFields.join(',') + ']');
    rowCount += 1;
  }

  return (
    '{"columns":' +
    (columnsJson === null ? (header ? '[]' : 'null') : columnsJson) +
    ',"rows":[' +
    rowsParts.join(',') +
    '],"errors":[' +
    errors.join(',') +
    ']}'
  );
}

/** csv-reader 1.0.0's answer for one case's input, {text, header}, as a value. */
export function run(input) {
  return JSON.parse(runJson(input));
}
