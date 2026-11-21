// csv-reader-speed-01-run-20261121 — a faster drop-in for csv-reader 1.0.0.
//
// Written from scratch against the policy in the kit's RULES.txt (BOM drop,
// CRLF/LF record ends, stray_cr, quoted fields with "" escapes, quote_junk,
// unterminated_quote as a literal, short_row/long_row padding and cutting,
// error objects {code, line, row} in the order met). No vendor code is copied:
// the reference was read only to pin down the exact semantics.
//
// Speed: one pass, indexOf-driven field scanning (native memchr-style scans
// instead of per-character loops), fields built with String.slice instead of
// per-character concatenation, no regex on the hot path. The only per-character
// loops left are the rare paths: stray CRs inside an unquoted field, and a
// quoted field that holds doubled quotes or embedded line breaks.
//
// `line` is tracked exactly as the reference tracks it, because a record's
// errors carry the 1-based line its record starts on: every LF, CRLF and lone
// CR inside a quoted field counts, a stray CR outside quotes does not.

const COMMA = 0; // the field ended at a comma: the record goes on
const BREAK = 1; // the field ended at a line break: the record ends
const END = 2; // the field ended at the end of the text: the record ends

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n !== 0 && text.charCodeAt(0) === 0xfeff) pos = 1; // a U+FEFF at the very start is dropped

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
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended = COMMA;
    let quoted = false;

    do {
      quoted = text.charCodeAt(pos) === 34;
      let value = '';
      // `init` is what an unquoted read appends onto: '' for a plain field, the
      // quoted value for quote_junk, '"' for an unterminated quote re-read.
      let init = '';
      let needUnquoted = !quoted;
      let junk = false;

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
          // after it is read again as unquoted. `line` never moved during the
          // scan above, so it is already the opening quote's line.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          init = '"';
          needUnquoted = true;
        } else {
          // The field's content sits between the quotes.
          const nl = text.indexOf('\n', open + 1);
          const cr = text.indexOf('\r', open + 1);
          const hasBreak = (nl !== -1 && nl < closing) || (cr !== -1 && cr < closing);
          if (!escaped && !hasBreak) {
            value = text.slice(open + 1, closing);
          } else {
            const raw = text.slice(open + 1, closing);
            let v = escaped ? raw.replaceAll('""', '"') : raw;
            if (hasBreak) {
              // Each CRLF or lone CR inside quotes is one LF; count them so
              // the next record starts on the right line.
              v = v.replace(/\r\n?/g, '\n');
              let lb = 0;
              for (let k = 0; k < raw.length; k++) {
                const cc = raw.charCodeAt(k);
                if (cc === 10) lb += 1;
                else if (cc === 13 && raw.charCodeAt(k + 1) !== 10) lb += 1;
              }
              line += lb;
            }
            value = v;
          }
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
              // What follows the closing quote is appended as it stands, up
              // to the next comma or line break.
              init = value;
              junk = true;
              needUnquoted = true;
            }
          }
        }
      }

      if (needUnquoted) {
        // ---- an unquoted field, appended onto `init` ----
        const comma = text.indexOf(',', pos);
        const nl = text.indexOf('\n', pos);
        let end;
        let isComma;
        if (comma === -1 || (nl !== -1 && nl < comma)) {
          end = nl;
          isComma = false;
        } else {
          end = comma;
          isComma = true;
        }
        if (end === -1) {
          const cr = text.indexOf('\r', pos);
          if (cr === -1) {
            value = init + text.slice(pos, n);
            pos = n;
            ended = END;
          } else {
            // Stray CR(s) before the end of the text: walk them.
            const parts = [];
            let cur = pos;
            let i = pos;
            for (;;) {
              if (i >= n) {
                parts.push(text.slice(cur, n));
                pos = n;
                ended = END;
                break;
              }
              const c = text.charCodeAt(i);
              if (c === 44) {
                parts.push(text.slice(cur, i));
                pos = i + 1;
                ended = COMMA;
                break;
              }
              if (c === 10) {
                parts.push(text.slice(cur, i));
                pos = i + 1;
                line += 1;
                ended = BREAK;
                break;
              }
              if (c === 13) {
                if (text.charCodeAt(i + 1) === 10) {
                  parts.push(text.slice(cur, i));
                  pos = i + 2;
                  line += 1;
                  ended = BREAK;
                  break;
                }
                errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                parts.push(text.slice(cur, i));
                i += 1;
                cur = i;
                continue;
              }
              i += 1;
            }
            value = init + parts.join('');
          }
        } else {
          const cr = text.indexOf('\r', pos);
          if (cr === -1 || cr >= end) {
            value = init + text.slice(pos, end);
            pos = end + 1;
            if (isComma) {
              ended = COMMA;
            } else {
              line += 1;
              ended = BREAK;
            }
          } else if (!isComma && cr === end - 1) {
            // CRLF ends the field.
            value = init + text.slice(pos, cr);
            pos = end + 1;
            line += 1;
            ended = BREAK;
          } else {
            // A stray CR sits before the delimiter: walk the field.
            const parts = [];
            let cur = pos;
            let i = pos;
            for (;;) {
              const c = text.charCodeAt(i);
              if (c === 44) {
                parts.push(text.slice(cur, i));
                pos = i + 1;
                ended = COMMA;
                break;
              }
              if (c === 10) {
                parts.push(text.slice(cur, i));
                pos = i + 1;
                line += 1;
                ended = BREAK;
                break;
              }
              if (c === 13) {
                if (text.charCodeAt(i + 1) === 10) {
                  parts.push(text.slice(cur, i));
                  pos = i + 2;
                  line += 1;
                  ended = BREAK;
                  break;
                }
                errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                parts.push(text.slice(cur, i));
                i += 1;
                cur = i;
                continue;
              }
              i += 1;
            }
            value = init + parts.join('');
          }
        }
        if (junk && value.length > init.length) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }

      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
