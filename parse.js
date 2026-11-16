// A fast, dependency-free CommonMark + GFM parser whose parse(markdown) returns
// exactly the HTML that marked 18.1.3 returns with its default options.
// Written from scratch for this entry: own code, own structure, own regexes.
// It renders straight to HTML while lexing blocks; inline parsing runs at the
// end so link reference definitions anywhere in the document apply everywhere.

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const ALNUM = /[\p{L}\p{N}]/u;
const WS = /[ \t\n\r\f\v]/;

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
// Unicode whitespace (what JS \s matches) — the inline flanking rules use
// this, while block parsing uses ASCII isSpace only. Char-code checks avoid
// a regex call per character.
function isUSpace(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  return c === 32 || (c >= 9 && c <= 13) || c === 0x00a0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
// ASCII punctuation fast path (covers the overwhelmingly common case);
// fall back to the Unicode regex for non-ASCII.
const ASCII_PUNCT_SET = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
function isPunct(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT_SET.has(ch);
  return PUNCT.test(ch);
}
const ASCII_ALNUM_SET = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
function isAlnum(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_ALNUM_SET.has(ch);
  return ALNUM.test(ch);
}

// Escape HTML text. encode=true escapes every & < > " '.
// encode=false leaves & alone when it starts a valid entity/char reference.
function esc(s, encode) {
  // Fast path: code text with no escapable characters is already the output.
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      if (!encode) {
        const m = /^&#\d{1,7};|^&#[Xx][A-Fa-f0-9]{1,6};|^&\w+;/.exec(s.slice(i, i + 12));
        if (m) { out += '&'; i++; continue; }
      }
      out += '&amp;'; i++;
    } else if (c === 60) { out += '&lt;'; i++; }
    else if (c === 62) { out += '&gt;'; i++; }
    else if (c === 34) { out += '&quot;'; i++; }
    else if (c === 39) { out += '&#39;'; i++; }
    else { out += s[i]; i++; }
  }
  return out;
}

// Decode numeric character references in inline text (marked's unescape), and
// turn a bare & that does not start a valid reference into &amp;.
function escText(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      const rest = s.slice(i);
      let m = /^&#(\d{1,7});/.exec(rest);
      if (m) { const ch = numRef(m[1], 10); out += ch === '&amp;' ? '&amp;' : esc(ch, true); i += m[0].length; continue; }
      m = /^&#[Xx]([A-Fa-f0-9]{1,6});/.exec(rest);
      if (m) { const ch = numRef(m[1], 16); out += ch === '&amp;' ? '&amp;' : esc(ch, true); i += m[0].length; continue; }
      if (/^&#\d{1,7};|^&#[Xx][A-Fa-f0-9]{1,6};|^&\w+;/.test(rest)) { out += '&'; i++; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === '<') { out += '&lt;'; i++; continue; }
    if (c === '>') { out += '&gt;'; i++; continue; }
    if (c === '"') { out += '&quot;'; i++; continue; }
    if (c === "'") { out += '&#39;'; i++; continue; }
    out += c; i++;
  }
  return out;
}

function numRef(digits, base) {
  const v = parseInt(digits, base);
  if (v === 0 || v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF)) return '\uFFFD';
  if (v === 38) return '&amp;';
  return String.fromCodePoint(v);
}

// encodeURI with %25 put back, null when encoding throws (marked's cleanUrl).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch { return null; }
}

// Normalize a link reference label: trim, collapse whitespace, case-fold.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Unescape backslash-escaped punctuation: \X -> X for punctuation X.
function unescapePunct(s) {
  if (s.indexOf('\\') === -1) return s;
  return s.replace(/\\([\p{P}\p{S}])/gu, '$1');
}

// Expand tabs to spaces with tab stops of 4, starting at column `col`.
function expandTabs(s, col) {
  if (s.indexOf('\t') === -1) return s;
  let out = '';
  let c = col;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') {
      const w = 4 - (c % 4);
      out += '    '.slice(0, w);
      c += w;
    } else { out += ch; c++; }
  }
  return out;
}

// Find the index of the closing bracket matching the [ at `start`, skipping
// backslash escapes and code spans. Returns -1 when there is none.
function findClosingBracket(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') {
      let j = i;
      while (j < src.length && src[j] === '`') j++;
      const run = j - i;
      const close = findCodeClose(src, j, run);
      if (close === -1) return -1;
      i = close - 1;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Given src and the position just after an opening backtick run of length
// `run`, find the index just past the matching closing run (or -1).
function findCodeClose(src, pos, run) {
  let i = pos;
  while (i < src.length) {
    if (src[i] === '`') {
      let j = i;
      while (j < src.length && src[j] === '`') j++;
      if (j - i === run) return j;
      i = j;
    } else i++;
  }
  return -1;
}

// Paren balance with backslash awareness (marked's findClosingBracket for
// parens): returns the index where the count goes negative, -2 when the
// string ends with open parens, else -1.
function parenBalance(s) {
  let t = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') t++;
    else if (s[i] === ')') {
      t--;
      if (t < 0) return i;
    }
  }
  return t > 0 ? -2 : -1;
}

// Strip `count` trailing chars equal to `ch` from a string (marked's L).
function stripTrailing(s, ch) {
  let n = s.length;
  while (n > 0 && s[n - 1] === ch) n--;
  return s.slice(0, n);
}

// Split a table row/header line into cells (marked's splitCells).
function splitCells(line, count) {
  let t = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|') {
      let odd = false;
      for (let p = i - 1; p >= 0 && line[p] === '\\'; p--) odd = !odd;
      t += odd ? '|' : ' |';
    } else t += line[i];
  }
  let cells = t.split(' |');
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Trim trailing blank lines the way marked's `ge` does: if there are more
// than one trailing blank lines, drop them all; otherwise keep as-is.
function trimTrailingBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_RE = new RegExp('^(?:' + BLOCK_TAGS + ')$', 'i');

// ---------- inline parsing ----------

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function isAsciiPunct(ch) {
  return ch.length === 1 && ASCII_PUNCT.indexOf(ch) !== -1;
}
// ASCII alphanumeric by char code — the inner inline loop tests this on
// every character, and a regex .test() per character is measurably slower.
function isAsciiAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// Punctuation for emphasis flanking, excluding '~' (GFM '*' rules treat '~'
// as a word character; '_' rules treat it as punctuation).
function isPunctNoTilde(ch) {
  return ch !== '' && ch !== '~' && PUNCT.test(ch);
}
function isWordNoTilde(ch) {
  return ch !== '' && !isSpace(ch) && !isPunctNoTilde(ch);
}

// Decode numeric character references and bare & (marked's unescape),
// without escaping < > " ' (used for image alt text).
function decodeRefs(s) {
  if (s.indexOf('&') === -1) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] === '&') {
      const rest = s.slice(i);
      let m = /^&#(\d{1,7});/.exec(rest);
      if (m) { out += numRef(m[1], 10); i += m[0].length; continue; }
      m = /^&#[Xx]([A-Fa-f0-9]{1,6});/.exec(rest);
      if (m) { out += numRef(m[1], 16); i += m[0].length; continue; }
      if (/^&#\d{1,7};|^&#[Xx][A-Fa-f0-9]{1,6};|^&\w+;/.test(rest)) { out += '&'; i++; continue; }
      out += '&amp;'; i++; continue;
    }
    out += s[i]; i++;
  }
  return out;
}

// Match an inline HTML tag at position i; returns its end index or -1.
// Covers comments, processing instructions, declarations, CDATA sections,
// opening tags (with attributes) and closing tags.
function matchInlineTag(src, i) {
  if (src[i] !== '<') return -1;
  const n = src.length;
  let j = i + 1;
  if (src.startsWith('<!--', i)) {
    // <!--> and <!---> are complete comments on their own
    if (src[i + 4] === '>') return i + 5;
    if (src[i + 4] === '-' && src[i + 5] === '>') return i + 6;
    const end = src.indexOf('-->', i + 4);
    return end === -1 ? -1 : end + 3;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const end = src.indexOf(']]>', i + 9);
    return end === -1 ? -1 : end + 3;
  }
  if (src.startsWith('<?', i)) {
    const end = src.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  if (src.startsWith('<!', i) && i + 2 < n && /[A-Za-z]/.test(src[i + 2])) {
    const end = src.indexOf('>', i + 2);
    return end === -1 ? -1 : end + 1;
  }
  if (src[j] === '/') {
    j++;
    if (j >= n || !/[A-Za-z]/.test(src[j])) return -1;
    while (j < n && /[A-Za-z0-9-]/.test(src[j])) j++;
    while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
    if (j < n && src[j] === '>') return j + 1;
    return -1;
  }
  if (j >= n || !/[A-Za-z]/.test(src[j])) return -1;
  while (j < n && /[A-Za-z0-9-]/.test(src[j])) j++;
  // attributes
  while (j < n) {
    if (src[j] === '>') return j + 1;
    if (src[j] === '/' && j + 1 < n && src[j + 1] === '>') return j + 2;
    if (src[j] !== ' ' && src[j] !== '\t' && src[j] !== '\n' && src[j] !== '\r') return -1;
    let k = j;
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k++;
    if (k >= n) return -1;
    if (src[k] === '>' || (src[k] === '/' && k + 1 < n && src[k + 1] === '>')) { j = k; continue; }
    if (!/[A-Za-z:_]/.test(src[k])) return -1;
    k++;
    while (k < n && /[\w.:-]/.test(src[k])) k++;
    // optional =value (whitespace allowed around =); if there is no =, j
    // must stay right after the name so the loop top sees the whitespace
    const nameEnd = k;
    let c = k;
    while (c < n && (src[c] === ' ' || src[c] === '\t' || src[c] === '\n' || src[c] === '\r')) c++;
    if (c < n && src[c] === '=') {
      c++;
      while (c < n && (src[c] === ' ' || src[c] === '\t' || src[c] === '\n' || src[c] === '\r')) c++;
      if (c < n && src[c] === '"') {
        c++;
        while (c < n && src[c] !== '"') c++;
        if (c >= n) return -1;
        c++;
      } else if (c < n && src[c] === "'") {
        c++;
        while (c < n && src[c] !== "'") c++;
        if (c >= n) return -1;
        c++;
      } else {
        while (c < n && !/[\s"'=<>`]/.test(src[c])) c++;
        if (c === n) return -1;
      }
      k = c;
    } else {
      k = nameEnd;
    }
    j = k;
  }
  return -1;
}

const EMAIL_LOCAL_SET = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&\'*+/=?^_`{|}~-');
function isEmailLocal(ch) {
  return ch.length === 1 && EMAIL_LOCAL_SET.has(ch);
}

// Match an autolink <scheme:...> or <email> at i; returns {end, text, href} or null.
function matchAutolink(src, i) {
  if (src[i] !== '<') return null;
  const n = src.length;
  let j = i + 1;
  // scheme:
  if (j < n && /[A-Za-z]/.test(src[j])) {
    let k = j;
    while (k < n && /[A-Za-z0-9+.-]/.test(src[k])) k++;
    if (k - j >= 2 && k - j <= 32 && k < n && src[k] === ':') {
      let e = k + 1;
      while (e < n && src[e] !== '>' && !/[\s\x00-\x1f<>]/.test(src[e])) e++;
      if (e < n && src[e] === '>') {
        const text = src.slice(j, e);
        return { end: e + 1, text, href: text };
      }
    }
  }
  // email: local@domain with labels of 1-63 chars ending in alnum
  let k = j;
  while (k < n && isEmailLocal(src[k])) k++;
  if (k > j && k < n && src[k] === '@') {
    let d = k + 1;
    if (d < n && /[A-Za-z0-9]/.test(src[d])) {
      // first label: alnum, then up to 61 more alnum/-, ending in alnum
      let labelEnd = d;
      let m = d + 1;
      while (m < n && /[A-Za-z0-9-]/.test(src[m]) && m - d < 63) m++;
      // backtrack to last alnum
      let e = m - 1;
      while (e > d && !/[A-Za-z0-9]/.test(src[e])) e--;
      if (e >= d && /[A-Za-z0-9]/.test(src[e])) labelEnd = e + 1;
      else labelEnd = -1;
      if (labelEnd !== -1) {
        let dots = 0;
        d = labelEnd;
        while (d < n && src[d] === '.') {
          let s2 = d + 1;
          if (s2 >= n || !/[A-Za-z0-9]/.test(src[s2])) break;
          let m2 = s2 + 1;
          while (m2 < n && /[A-Za-z0-9-]/.test(src[m2]) && m2 - s2 < 63) m2++;
          let e2 = m2 - 1;
          while (e2 > s2 && !/[A-Za-z0-9]/.test(src[e2])) e2--;
          if (e2 < s2 || !/[A-Za-z0-9]/.test(src[e2])) break;
          dots++;
          d = e2 + 1;
        }
        if (dots > 0 && d < n && src[d] === '>' && (d + 1 >= n || !/[-_]/.test(src[d + 1]))) {
          const text = src.slice(j, d);
          return { end: d + 1, text, href: 'mailto:' + text };
        }
      }
    }
  }
  return null;
}

// Scan a bracket group starting at src[i] === '['.
// depth 0 = a link label (code spans allowed), 1 = nested group, 2 = innermost.
// Returns the index just past the closing ']' or -1.
function scanBracket(src, i, depth) {
  let j = i + 1;
  const n = src.length;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`' && depth === 0) {
      let k = j;
      while (k < n && src[k] === '`') k++;
      const run = k - j;
      // marked's label grammar tries the "2+ backticks immediately before ]"
      // alternative before the codespan one: a run before ] is label content
      // and must not swallow the ] by hunting for a far-away closer
      if (run >= 2 && src[k] === ']') { j = k; continue; }
      // otherwise a backtick run, non-backtick content, then a backtick run
      // of ANY length closes it (opener and closer need not match in length)
      let m = k;
      let closed = false;
      while (m < n) {
        if (src[m] === '`') {
          while (m < n && src[m] === '`') m++;
          closed = true;
          break;
        }
        m++;
      }
      if (closed) { j = m; continue; }
      return -1;
    }
    if (c === '[') {
      if (depth >= 2) return -1;
      const inner = scanBracket(src, j, depth + 1);
      if (inner === -1) return -1;
      j = inner;
      continue;
    }
    if (c === ']') return j + 1;
    j++;
  }
  return -1;
}

// Match a link label starting at src[i] === '['; returns {label, end} or null.
function matchLabel(src, i) {
  const end = scanBracket(src, i, 0);
  if (end === -1) return null;
  return { label: src.slice(i + 1, end - 1), end };
}

// Try to match a title ("..." | '...' | (...)) at src[i] (after whitespace
// has been skipped by the caller); returns {title, end} or null.
function matchTitle(src, i) {
  const n = src.length;
  const q = src[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === q) return { title: src.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === ')') return { title: src.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}

// Skip [ \t\n]* from i.
function skipWSNL(src, i) {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
  return i;
}

// Match a reference label (marked's `le`): escapes, chars other than
// [ ] \ and newline, or a newline that is not followed by a blank line.
// Returns {ref, end} (end just past ']') or null.
function matchRef(src, i) {
  if (src[i] !== '[') return null;
  let j = i + 1;
  const n = src.length;
  if (j >= n) return null;
  // not (optional whitespace then ']')
  let k = j;
  while (k < n && isSpace(src[k])) k++;
  if (src[k] === ']') return null;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') return { ref: src.slice(i + 1, j), end: j + 1 };
    if (c === '\n') {
      // allowed only when not followed by a blank line
      let m = j + 1;
      while (m < n && (src[m] === ' ' || src[m] === '\t')) m++;
      if (src[m] === '\n') return null;
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Skip the whitespace allowed before a link title:
// [ \t]+ with at most one following newline, or a single newline.
function skipTitleWS(src, i) {
  if (src[i] === ' ' || src[i] === '\t') {
    let j = i;
    while (src[j] === ' ' || src[j] === '\t') j++;
    if (src[j] === '\n') {
      j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
    }
    return j;
  }
  if (src[i] === '\n') {
    let j = i + 1;
    while (src[j] === ' ' || src[j] === '\t') j++;
    return j;
  }
  return -1;
}

// Try to match the (title)? [ \t\n]* ')' tail after an href ending at `p`.
// Returns {end, title} or null.
function matchLinkTail(src, p) {
  const w = skipTitleWS(src, p);
  if (w !== -1) {
    const t = matchTitle(src, w);
    if (t) {
      const k = skipWSNL(src, t.end);
      if (src[k] === ')') return { end: k + 1, title: t.title };
    }
  }
  const k = skipWSNL(src, p);
  if (src[k] === ')') return { end: k + 1, title: '' };
  return null;
}

// Match an inline link/image at src[i] ('[' or '![').
// Returns {label, href, title, isImage, end} or null.
function matchInlineLink(src, i, st) {
  let isImage = false;
  let j = i;
  if (src[j] === '!') { isImage = true; j++; }
  if (src[j] !== '[') return null;
  const lab = matchLabel(src, j);
  if (!lab) return null;
  const label = lab.label;
  const k = lab.end;
  if (src[k] !== '(') return null;
  const base = isImage ? 5 : 4;
  let p = skipWSNL(src, k + 1);
  let href = '';
  let end = -1;
  let title = '';
  let matched = false;
  if (src[p] === '<') {
    let q = p + 1;
    let ok = false;
    while (q < src.length) {
      if (src[q] === '\\') { q += 2; continue; }
      if (src[q] === '\n' || src[q] === '<' || src[q] === '>') break;
      q++;
    }
    if (q < src.length && src[q] === '>') {
      const tail = matchLinkTail(src, q + 1);
      if (tail) {
        href = src.slice(p, q + 1);
        end = tail.end;
        title = tail.title;
        matched = true;
      }
    }
  }
  if (!matched) {
    let runEnd = p;
    while (runEnd < src.length && src[runEnd] !== ' ' && src[runEnd] !== '\t' && src[runEnd] !== '\n' && src[runEnd].charCodeAt(0) >= 0x20) runEnd++;
    for (let L = runEnd - p; L >= 0; L--) {
      const tail = matchLinkTail(src, p + L);
      if (tail) {
        href = src.slice(p, p + L);
        end = tail.end;
        title = tail.title;
        matched = true;
        break;
      }
    }
  }
  if (!matched) return null;
  let s = href.trim();
  if (s.charAt(0) === '<') {
    if (s.charAt(s.length - 1) !== '>') return null;
    const stripped = stripTrailing(s.slice(0, -1), '\\');
    if ((s.length - stripped.length) % 2 === 0) return null;
  } else {
    const bal = parenBalance(href);
    if (bal === -2) return null;
    if (bal > -1) {
      href = href.slice(0, bal);
      const rawEnd = i + base + label.length + bal;
      const raw = src.slice(i, rawEnd).replace(/[ \t\n]+$/, '');
      end = i + raw.length;
      title = '';
    }
  }
  const rawSoFar = src.slice(i, end);
  const rStripped = stripTrailing(rawSoFar.slice(0, -1), '\\');
  if ((rawSoFar.length - rStripped.length) % 2 === 0) return null;
  if (beBlocked(src, label, j + 1)) return null;
  let h = href.trim();
  if (h.charAt(0) === '<') h = h.slice(1, -1);
  return { label, href: unescapePunct(h), title: title ? unescapePunct(title) : '', isImage, end };
}

// Match a reference link/image at src[i].
// Returns {label, href, title, isImage, end}, {textChar:true} when a
// reference matched structurally but is undefined (consume one char as
// text), or null when nothing matched.
function matchRefLink(src, i, st) {
  let isImage = false;
  let j = i;
  if (src[j] === '!') { isImage = true; j++; }
  if (src[j] !== '[') return null;
  const lab = matchLabel(src, j);
  if (!lab) return null;
  const label = lab.label;
  const k = lab.end;
  if (src[k] === '[') {
    const ref = matchRef(src, k);
    if (ref) {
      const def = st.links[normLabel(ref.ref)];
      if (!def) return { textChar: true };
      if (beBlocked(src, label, j + 1)) return null;
      return { label, href: def.href, title: def.title || '', isImage, end: ref.end };
    }
  }
  const ref2 = matchRef(src, j);
  if (!ref2) return null;
  let end = ref2.end;
  if (src[end] === '[' && src[end + 1] === ']') end += 2;
  const def = st.links[normLabel(ref2.ref)];
  if (!def) return { textChar: true };
  if (beBlocked(src, label, j + 1)) return null;
  return { label, href: def.href, title: def.title || '', isImage, end };
}

// marked's `Be`: a link is blocked when its label holds a '<' that starts a
// tag or autolink reaching past the label's end.
function beBlocked(src, label, labelStart) {
  if (label.indexOf('<') === -1) return false;
  let s = 0;
  const n = label.length;
  while (s < n) {
    const c = label[s];
    if (c === '\\') { s += 2; continue; }
    if (c === '`') {
      let k = s;
      while (k < n && label[k] === '`') k++;
      const run = k - s;
      const close = findCodeClose(label, k, run);
      if (close !== -1) { s = close; continue; }
      s++;
      continue;
    }
    if (c !== '<') { s++; continue; }
    const rest = src.slice(labelStart + s);
    const tagEnd = matchInlineTag(rest, 0);
    const auto = tagEnd === -1 ? matchAutolink(rest, 0) : null;
    const len = tagEnd !== -1 ? tagEnd : (auto ? auto.end : 0);
    if (len > 0) {
      if (len > n - s) return true;
      s += len;
      continue;
    }
    s++;
  }
  return false;
}

// Flanking for a delimiter run with `prev`/`next` neighbours ('' at edges).
// For '*', '~' counts as a word character; for '_' it counts as punctuation.
function flank(ch, prev, next) {
  const pv = prev === '' ? '\n' : prev;
  const nx = next === '' ? '\n' : next;
  let isP, isW;
  if (ch === '_') { isP = isPunct; isW = (c) => c !== '' && !isSpace(c) && !isPunct(c); }
  else { isP = isPunctNoTilde; isW = isWordNoTilde; }
  const leftFlank = !isSpace(nx) && (!isP(nx) || isSpace(pv) || isP(pv));
  const rightFlank = !isSpace(pv) && (!isP(pv) || isSpace(nx) || isP(nx));
  if (ch === '_') return {
    canOpen: leftFlank && (!rightFlank || isP(pv)),
    canClose: rightFlank && (!leftFlank || isP(nx)),
  };
  return { canOpen: leftFlank, canClose: rightFlank };
}

// `punctuation` as used by marked's opener checks: whitespace or punctuation
// (including '~'), but never '*' or '_'.
function isPunctSpaceForD(ch) {
  if (ch === '' || ch === '*' || ch === '_') return false;
  return isUSpace(ch) || isPunct(ch);
}

// Skip a link/image/reference construct starting at src[j] === '[' the way
// marked's emphasis masking does (blockSkip + reflinkSearch). Returns the
// end index or -1.
function skipLinkConstruct(src, j, st) {
  // [...] (...) with a simple label (no nested brackets), one level of
  // nested parens in the destination
  let k = j + 1;
  const n = src.length;
  while (k < n) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '`') {
      let q = k;
      while (q < n && src[q] === '`') q++;
      const close = findCodeClose(src, q, q - k);
      if (close === -1) break;
      k = close;
      continue;
    }
    if (c === '[' || c === ']') break;
    k++;
  }
  if (k < n && src[k] === ']' && src[k + 1] === '(') {
    let p = k + 2;
    let depth = 1;
    while (p < n && depth > 0) {
      const c = src[p];
      if (c === '\\') { p += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      p++;
    }
    if (depth === 0) return p;
  }
  // [label][ref] / [label] with an existing reference
  const lab = matchLabel(src, j);
  if (lab) {
    let e = lab.end;
    if (src[e] === '[') {
      const ref = matchRef(src, e);
      if (ref && st.links[normLabel(ref.ref)]) return ref.end;
    }
    if (st.links[normLabel(lab.label)]) {
      if (src[e] === '[' && src[e + 1] === ']') return e + 2;
      return e;
    }
  }
  return -1;
}

// The alt-1 prefix of marked's delimiter regexes: when the scan starts with
// a strong run of the OTHER delimiter wrapping a single one of this
// delimiter, that whole prefix is skipped. Returns the skip-to index or -1.
function alt1Skip(src, from, ch) {
  const strong = ch === '_' ? '**' : '__';
  const single = ch === '_' ? '_' : '*';
  let i = from;
  while (i < src.length && src[i] !== '*' && src[i] !== '_') i++;
  if (src.slice(i, i + 2) !== strong) return -1;
  let j = i + 2;
  for (;;) {
    while (j < src.length && src[j] !== '*' && src[j] !== '_') j++;
    if (src[j] !== single) return -1;
    let k = j + 1;
    while (k < src.length && src[k] !== '*' && src[k] !== '_') k++;
    if (src.slice(k, k + 2) === strong) return k;
    j++;
    if (j >= src.length) return -1;
  }
}

// Find a closer for an emphasis opener. `from` is the index just past the
// opener run. Returns {end, used} or null.
// ---- marked's emStrong masking (#n + fe + ze) ----
// The closer search for emphasis is bounded by the last possible closer
// index computed on a MASKED copy of the inline source, in which links,
// code spans, HTML tags and escaped punctuation are hidden. A stray
// backtick can make the masking swallow a large region, which suppresses
// emphasis that would otherwise form (e.g. doc-09's _issue table_).
const MASK_ANY_PUNCT = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCK_SKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

function maskInlineSource(src) {
  // fast path: with no backtick, bracket, '<' or backslash there is nothing
  // for either masking regex to change, so the masked source is the source
  if (src.indexOf('`') === -1 && src.indexOf('[') === -1 && src.indexOf('<') === -1 && src.indexOf('\\') === -1) return src;
  let t = src;
  t = t.replace(MASK_ANY_PUNCT, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  t = t.replace(MASK_BLOCK_SKIP, (n) => '[' + 'a'.repeat(Math.max(0, n.length - 2)) + ']');
  return t;
}

// Last index of a run of ch whose preceding char is not whitespace
// (space/tab/newline/CR/FF), in the masked source. -1 when there is none.
function lastPossibleCloser(masked, ch) {
  let last = -1;
  const n = masked.length;
  let s = masked.indexOf(ch);
  while (s !== -1) {
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === ch) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') last = s;
    s = masked.indexOf(ch, i);
  }
  return last;
}

function findEmClose(src, from, ch, k, y, R, o, st, maxCloser, masked) {
  let m = k;
  let f = 0;
  let j = from;
  const n = src.length;
  const alt = alt1Skip(src, from, ch);
  if (alt !== -1) j = alt;
  while (j < n) {
    const c = src[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(src[j + 1])) { j += 2; continue; }
    if (c === '`') {
      let q = j;
      while (q < n && src[q] === '`') q++;
      const close = findCodeClose(src, q, q - j);
      if (close !== -1) { j = close; continue; }
      j = q;
      continue;
    }
    if (c === '[') {
      const skip = skipLinkConstruct(src, j, st);
      if (skip !== -1) { j = skip; continue; }
      j++;
      continue;
    }
    if (c === '<') {
      const tagEnd = matchInlineTag(src, j);
      if (tagEnd !== -1) { j = tagEnd; continue; }
      const auto = matchAutolink(src, j);
      if (auto) { j = auto.end; continue; }
      j++;
      continue;
    }
    if (c !== ch) { j++; continue; }
    let q = j;
    while (q < n && src[q] === ch) q++;
    // a run hidden by the emStrong masking (inside a link / code span /
    // html tag) is not a delimiter at all
    if (masked && masked[j] !== ch) { j = q; continue; }
    // a delimiter run past the last possible closer ends the search
    // (maxCloser -1 means no closer exists at all)
    if (j > maxCloser) return null;
    const b = q - j;
    const prev = j > 0 ? src[j - 1] : '';
    const next = q < n ? src[q] : '';
    const { canOpen, canClose } = flank(ch, prev, next);
    if (!canClose && !canOpen) { j = q; continue; }
    if (!canClose && canOpen) { m += b; j = q; continue; }
    const both = canOpen && canClose;
    if (both || R) {
      if (o && both) return null;
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; j = q; continue; }
    }
    m -= b;
    if (m > 0) { j = q; continue; }
    const used = Math.min(b, b + m + f);
    return { end: j + used, used };
  }
  return null;
}

// Try emphasis (* or _) at src[i]. Returns {end, strong, inner} or null.
// maxCloser is marked's last-possible-closer bound for this delimiter
// (index in the masked source, same length as src); -1 when none exists.
// masked is the masked source (same length as src) for skipping runs that
// lie inside a link / code span / html tag.
function emStrongAt(src, i, st, prevChar, maxCloser, masked) {
  const ch = src[i];
  const n = src.length;
  let j = i;
  while (j < n && src[j] === ch) j++;
  const runLen = j - i;
  const next = j < n ? src[j] : '';
  if (next === '' || isUSpace(next)) return null;
  const nextIsPunct = ch === '*' ? isPunctNoTilde(next) : isPunct(next);
  let nn = prevChar;
  let l = i;
  while (l > 0 && src[l - 1] === ch) l--;
  const p = l > 0 ? src[l - 1] : '';
  if (l < i) nn = p;
  const h = p === '*' || p === '_' || isPunctSpaceForD(p);
  const u = l < i ? h : isPunctSpaceForD(nn);
  if (ch === '_' && next !== '_' && !isUSpace(next) && isAlnum(nn)) return null;
  const d = nextIsPunct;
  if (d && nn !== '' && !u) return null;
  const k = runLen;
  const y = i - l + k;
  const R = p !== '' && !isUSpace(p) && (d || (ch === '*' && !h));
  const o = prevChar === ch;
  // no closer can exist at or after the opener's end
  if (maxCloser !== undefined && maxCloser < i + k) return null;
  const close = findEmClose(src, i + k, ch, k, y, R, o, st, maxCloser === undefined ? n : maxCloser, masked);
  if (!close) return null;
  const raw = src.slice(i, close.end);
  const used = close.used;
  if (Math.min(k, used) % 2 === 1) {
    return { end: close.end, strong: false, inner: raw.slice(1, -1) };
  }
  return { end: close.end, strong: true, inner: raw.slice(2, -2) };
}

// Try strikethrough (~~) at src[i]. Returns {end, inner} or null.
function delAt(src, i, st, prevChar) {
  const n = src.length;
  if (src[i] !== '~') return null;
  let j = i;
  while (j < n && src[j] === '~') j++;
  const runLen = j - i;
  const o = Math.min(runLen, 2);
  const next = i + o < n ? src[i + o] : '';
  if (next === '' || isUSpace(next) || next === '~') return null;
  const nextIsPunct = isPunctNoTilde(next);
  if (nextIsPunct && prevChar !== '' && !isPunctSpaceForD(prevChar)) return null;
  // scan for a closer run of exactly `o` tildes
  let p = o;
  let k = i + o;
  while (k < n) {
    const c = src[k];
    if (c === '\\' && k + 1 < n && isAsciiPunct(src[k + 1])) { k += 2; continue; }
    if (c === '`') {
      let q = k;
      while (q < n && src[q] === '`') q++;
      const close = findCodeClose(src, q, q - k);
      if (close !== -1) { k = close; continue; }
      k = q;
      continue;
    }
    if (c === '[') {
      const skip = skipLinkConstruct(src, k, st);
      if (skip !== -1) { k = skip; continue; }
      k++;
      continue;
    }
    if (c === '<') {
      const tagEnd = matchInlineTag(src, k);
      if (tagEnd !== -1) { k = tagEnd; continue; }
      const auto = matchAutolink(src, k);
      if (auto) { k = auto.end; continue; }
      k++;
      continue;
    }
    if (c !== '~') { k++; continue; }
    let q = k;
    while (q < n && src[q] === '~') q++;
    const b = q - k;
    if (b !== o) { k = q; continue; }
    const prev = k > 0 ? src[k - 1] : '';
    const nxt = q < n ? src[q] : '';
    const { canOpen, canClose } = flank('~', prev, nxt);
    if (!canClose && !canOpen) { k = q; continue; }
    if (!canClose && canOpen) { p += b; k = q; continue; }
    p -= b;
    if (p > 0) { k = q; continue; }
    const used = Math.min(b, b + p);
    const end = k + used;
    const raw = src.slice(i, end);
    return { end, inner: raw.slice(o, -o) };
  }
  return null;
}

// Match a plain email (marked's `It`) at src[i]; returns the end index or -1.
function matchEmailAt(src, i) {
  const n = src.length;
  let j = i;
  while (j < n && isEmailLocal(src[j])) j++;
  if (j === i || j >= n || src[j] !== '@') return -1;
  let d = j + 1;
  if (d >= n || !/[A-Za-z0-9]/.test(src[d])) return -1;
  while (d < n && /[A-Za-z0-9-_]/.test(src[d])) d++;
  let dots = 0;
  while (d < n && src[d] === '.') {
    const s2 = d + 1;
    // a dot not followed by a valid label ends the email (trailing dot)
    if (s2 >= n || !/[A-Za-z0-9]/.test(src[s2])) break;
    let m = s2 + 1;
    while (m < n && /[A-Za-z0-9-_]/.test(src[m])) m++;
    let e = m - 1;
    while (e > s2 && !/[A-Za-z0-9]/.test(src[e])) e--;
    if (e < s2 || !/[A-Za-z0-9]/.test(src[e])) break;
    dots++;
    d = e + 1;
  }
  if (dots === 0) return -1;
  if (d < n && /[\w-]/.test(src[d])) return -1;
  return d;
}

const BACKPEDAL_RE = /^(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![A-Za-z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
function backpedal(url) {
  let cur = url;
  for (;;) {
    const m = BACKPEDAL_RE.exec(cur);
    const next = m ? m[0] : '';
    if (next === cur) return cur;
    cur = next;
  }
}

// Match a GFM extended autolink at src[i]; returns {end, text, href} or null.
function matchUrl(src, i, st) {
  if (st.inLink) return null;
  const rest = src.slice(i);
  // mailto:/xmpp: email (with an optional /resource for xmpp)
  let m = /^(?:mailto:|xmpp:)/.exec(rest);
  if (m) {
    const proto = m[0];
    const eEnd = matchEmailAt(src, i + proto.length);
    if (eEnd !== -1) {
      let end = eEnd;
      if (proto === 'xmpp:') {
        const r = /^\/[A-Za-z0-9@.]+/.exec(src.slice(end));
        if (r) end += r[0].length;
      }
      const text = backpedal(src.slice(i, end));
      return { end: i + text.length, text, href: text };
    }
  }
  // scheme:// or www.
  m = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|^www\./.exec(rest);
  if (m) {
    let j = i + m[0].length;
    // (?:[a-zA-Z0-9-]+\.?)+ then [^\s<]*
    let labels = 0;
    while (j < src.length) {
      let k = j;
      while (k < src.length && /[A-Za-z0-9-]/.test(src[k])) k++;
      if (k === j) break;
      labels++;
      j = k;
      if (src[j] === '.') j++;
    }
    if (labels > 0) {
      let e = j;
      while (e < src.length && src[e] !== ' ' && src[e] !== '\t' && src[e] !== '\n' && src[e] !== '\r' && src[e] !== '<') e++;
      const text = backpedal(src.slice(i, e));
      if (text.length > 0) {
        return { end: i + text.length, text, href: m[0] === 'www.' ? 'http://' + text : text };
      }
    }
  }
  // plain email
  const eEnd = matchEmailAt(src, i);
  if (eEnd !== -1) {
    const text = src.slice(i, eEnd);
    return { end: eEnd, text, href: 'mailto:' + text };
  }
  return null;
}

// Next position that could start an inline construct: any construct opener,
// an email local part followed by '@', a URL/email trigger, or a whitespace
// run ending in two spaces before a newline (a hard break). The inline loop
// jumps straight there with this native scan instead of walking character
// by character. The alternatives are ordered so a single break character
// wins over a longer trigger starting at the same spot.
const BREAK_RE = /[\\<\[!*_`~@]|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@|www\.|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|mailto:|xmpp:|[ \t]* {2}\n/g;

// Render inline markdown to HTML. `st` holds the document state (links,
// inLink which persists across inline calls, inRawBlock which the caller
// resets per inline source). textOnly renders plain text (image alt text).
function inlineHtml(src, st, textOnly) {
  const n = src.length;
  let i = 0;
  let out = '';
  let txt = '';
  let lastWasText = false;
  let lastChar = '';
  const hasParen = src.indexOf(')') !== -1;
  const hasAt = src.indexOf('@') !== -1;
  // Fast path: a source with no inline construct at all renders as escaped
  // text. Excluded: hard breaks (two spaces before a newline), which the
  // main loop would turn into <br>. No '<' means no tags, so st is untouched.
  if (!textOnly && !st.inRawBlock &&
      src.indexOf('\\') === -1 && src.indexOf('<') === -1 && src.indexOf('[') === -1 &&
      src.indexOf('!') === -1 && src.indexOf('*') === -1 && src.indexOf('_') === -1 &&
      src.indexOf('`') === -1 && src.indexOf('~') === -1 && src.indexOf('@') === -1 &&
      src.indexOf('www.') === -1 && src.indexOf('://') === -1 &&
      src.indexOf('mailto:') === -1 && src.indexOf('xmpp:') === -1 &&
      src.indexOf('  \n') === -1) {
    return escText(src);
  }
  // Emphasis closer bounds (marked's ze): last possible closer index for
  // * and _ in the masked source; computed lazily on the first emphasis
  // attempt, so sources whose * / _ never open emphasis skip the scan.
  let boundStar;
  let boundUnd;
  let maskedSrc;
  const ensureMask = () => {
    if (maskedSrc === undefined) {
      maskedSrc = maskInlineSource(src);
      boundStar = lastPossibleCloser(maskedSrc, '*');
      boundUnd = lastPossibleCloser(maskedSrc, '_');
    }
  };
  const flush = () => {
    if (!txt) return;
    if (st.inRawBlock) out += txt;
    else if (textOnly) out += decodeRefs(txt);
    else out += escText(txt);
    txt = '';
  };
  while (i < n) {
    const c = src[i];
    // escape: \ + ASCII punctuation
    if (c === '\\' && i + 1 < n && isAsciiPunct(src[i + 1])) {
      flush();
      out += textOnly ? src[i + 1] : esc(src[i + 1], true);
      i += 2;
      lastWasText = false;
      lastChar = '';
      continue;
    }
    // raw HTML tag
    if (c === '<') {
      const tagEnd = matchInlineTag(src, i);
      if (tagEnd !== -1) {
        flush();
        const tag = src.slice(i, tagEnd);
        if (!st.inLink && /^<a /i.test(tag)) st.inLink = true;
        else if (st.inLink && /^<\/a>/i.test(tag)) st.inLink = false;
        if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = false;
        out += tag;
        i = tagEnd;
        lastWasText = false;
        lastChar = '';
        continue;
      }
      const auto = matchAutolink(src, i);
      if (auto) {
        flush();
        if (textOnly) out += auto.text;
        else {
          const href = cleanUrl(auto.href);
          if (href === null) out += esc(auto.text, true);
          else out += '<a href="' + esc(href, true) + '">' + esc(auto.text, true) + '</a>';
        }
        i = auto.end;
        lastWasText = false;
        lastChar = '';
        continue;
      }
    }
    // inline link / image
    if ((c === '[' || (c === '!' && src[i + 1] === '[')) && hasParen) {
      const lk = matchInlineLink(src, i, st);
      if (lk) {
        const savedInLink = st.inLink;
        const savedEmitted = st.linkEmitted;
        const savedRaw = st.inRawBlock;
        st.inLink = true;
        st.linkEmitted = false;
        const inner = inlineHtml(lk.label, st, textOnly || lk.isImage);
        const nestedLink = st.linkEmitted;
        st.linkEmitted = savedEmitted;
        st.inLink = savedInLink;
        if (!lk.isImage && nestedLink) {
          st.inRawBlock = savedRaw;
          // rejected: fall through to text
        } else {
          flush();
          if (textOnly) {
            out += inner;
          } else if (lk.isImage) {
            const href = cleanUrl(lk.href);
            if (href === null) out += esc(inner, false);
            else {
              let o = '<img src="' + esc(href, false) + '" alt="' + esc(inner, false) + '"';
              if (lk.title) o += ' title="' + esc(lk.title, false) + '"';
              out += o + '>';
            }
          } else {
            const href = cleanUrl(lk.href);
            if (href === null) out += inner;
            else {
              let o = '<a href="' + esc(href, false) + '"';
              if (lk.title) o += ' title="' + esc(lk.title, false) + '"';
              out += o + '>' + inner + '</a>';
            }
          }
          if (!lk.isImage) st.linkEmitted = true;
          i = lk.end;
          lastWasText = false;
          lastChar = '';
          continue;
        }
      }
    }
    // reference link / image
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const lk = matchRefLink(src, i, st);
      if (lk) {
        if (lk.textChar) {
          txt += c;
          i++;
          lastWasText = true;
          lastChar = c;
          continue;
        }
        const savedInLink = st.inLink;
        const savedEmitted = st.linkEmitted;
        const savedRaw = st.inRawBlock;
        st.inLink = true;
        st.linkEmitted = false;
        const inner = inlineHtml(lk.label, st, textOnly || lk.isImage);
        const nestedLink = st.linkEmitted;
        st.linkEmitted = savedEmitted;
        st.inLink = savedInLink;
        if (!lk.isImage && nestedLink) {
          st.inRawBlock = savedRaw;
        } else {
          flush();
          if (textOnly) {
            out += inner;
          } else if (lk.isImage) {
            const href = cleanUrl(lk.href);
            if (href === null) out += esc(inner, false);
            else {
              let o = '<img src="' + esc(href, false) + '" alt="' + esc(inner, false) + '"';
              if (lk.title) o += ' title="' + esc(lk.title, false) + '"';
              out += o + '>';
            }
          } else {
            const href = cleanUrl(lk.href);
            if (href === null) out += inner;
            else {
              let o = '<a href="' + esc(href, false) + '"';
              if (lk.title) o += ' title="' + esc(lk.title, false) + '"';
              out += o + '>' + inner + '</a>';
            }
          }
          if (!lk.isImage) st.linkEmitted = true;
          i = lk.end;
          lastWasText = false;
          lastChar = '';
          continue;
        }
      }
    }
    // emphasis
    if (c === '*' || c === '_') {
      ensureMask();
      const em = emStrongAt(src, i, st, lastWasText ? lastChar : '', c === '*' ? boundStar : boundUnd, maskedSrc);
      if (em) {
        flush();
        const inner = inlineHtml(em.inner, st, textOnly);
        if (textOnly) out += inner;
        else out += em.strong ? '<strong>' + inner + '</strong>' : '<em>' + inner + '</em>';
        i = em.end;
        lastWasText = false;
        lastChar = '';
        continue;
      }
    }
    // code span
    if (c === '`') {
      let q = i;
      while (q < n && src[q] === '`') q++;
      const run = q - i;
      const close = findCodeClose(src, q, run);
      if (close !== -1) {
        flush();
        let text = src.slice(q, close - run).replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ') {
          text = text.slice(1, -1);
        }
        out += textOnly ? text : '<code>' + esc(text, true) + '</code>';
        i = close;
        lastWasText = false;
        lastChar = '';
        continue;
      }
    }
    // hard break: two or more spaces, or a backslash, before a newline
    if (c === ' ' || c === '\\') {
      let q = i;
      let spaces = 0;
      while (q < n && src[q] === ' ') { q++; spaces++; }
      let brEnd = -1;
      if (spaces >= 2 && src[q] === '\n') brEnd = q + 1;
      else if (c === '\\' && src[i + 1] === '\n') brEnd = i + 2;
      if (brEnd !== -1) {
        // (?!\s*$): the rest after the newline must not be all whitespace
        let k = brEnd;
        let allWS = true;
        while (k < n) {
          if (!isUSpace(src[k])) { allWS = false; break; }
          k++;
        }
        if (!allWS) {
          flush();
          out += textOnly ? '' : '<br>';
          i = brEnd;
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          lastWasText = false;
          lastChar = '';
          continue;
        }
      }
    }
    // strikethrough
    if (c === '~') {
      const d = delAt(src, i, st, lastWasText ? lastChar : '');
      if (d) {
        flush();
        out += textOnly ? inlineHtml(d.inner, st, true) : '<del>' + inlineHtml(d.inner, st, textOnly) + '</del>';
        i = d.end;
        lastWasText = false;
        lastChar = '';
        continue;
      }
    }
    // extended autolink
    if (!st.inLink) {
      const u = matchUrl(src, i, st);
      if (u) {
        flush();
        if (textOnly) out += u.text;
        else {
          const href = cleanUrl(u.href);
          if (href === null) out += esc(u.text, true);
          else out += '<a href="' + esc(href, true) + '">' + esc(u.text, true) + '</a>';
        }
        i = u.end;
        lastWasText = false;
        lastChar = '';
        continue;
      }
    }
    // plain text: jump straight to the next position that could start a
    // construct (native regex scan), instead of walking character by
    // character. BREAK_RE is reset right after each exec, so the recursive
    // inlineHtml calls for link labels and emphasis cannot disturb it.
    // A trigger only counts when the old per-character loop would have
    // stopped there: www. needs a start/space/punctuation predecessor,
    // mailto:/xmpp: and an email local part need a non-alphanumeric one
    // (an email-local predecessor means the run loop never stopped there);
    // otherwise the match is plain text and the search resumes past it.
    let end = n;
    let scanFrom = i;
    while (scanFrom < n) {
      BREAK_RE.lastIndex = scanFrom;
      const bm = BREAK_RE.exec(src);
      BREAK_RE.lastIndex = 0;
      if (!bm) break;
      const mi = bm.index;
      const matched = bm[0];
      const prev = mi === 0 ? '' : src[mi - 1];
      if (matched === 'www.') {
        if (!(prev === '' || prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '*' || prev === '_' || prev === '~' || prev === '(')) {
          scanFrom = mi + 1;
          continue;
        }
      } else if (matched === 'mailto:' || matched === 'xmpp:') {
        if (prev !== '' && isAsciiAlnumCode(prev.charCodeAt(0))) {
          scanFrom = mi + 1;
          continue;
        }
      } else if (matched.endsWith('@') && matched.length > 1) {
        // email local part: skip when the predecessor is itself an
        // email-local character (the old loop never stopped there)
        if (prev !== '' && isEmailLocal(prev)) {
          scanFrom = mi + 1;
          continue;
        }
      }
      end = mi;
      break;
    }
    if (end > i) {
      txt += src.slice(i, end);
      lastWasText = true;
      lastChar = src[end - 1];
      i = end;
      continue;
    }
    // A break character at i that the construct checks above did not
    // consume: swallow it as text, the way the old run loop did.
    if (c === '`') {
      // a backtick run here already failed as a code span: whole run is text
      let q = i;
      while (q < n && src[q] === '`') q++;
      txt += src.slice(i, q);
      lastWasText = true;
      lastChar = '`';
      i = q;
    } else if (c === '_') {
      // a '_' run that could open emphasis but has no closer is swallowed
      // one character at a time (each '_' is retried as an opener); a run
      // that cannot open at all is swallowed whole
      let q = i;
      while (q < n && src[q] === '_') q++;
      const next = q < n ? src[q] : '';
      const prev = i === 0 ? '' : src[i - 1];
      if (next !== '' && !isUSpace(next) && !(isAlnum(next) && isAlnum(prev))) {
        txt += '_';
        i++;
      } else {
        txt += src.slice(i, q);
        i = q;
      }
      lastWasText = true;
      lastChar = '_';
    } else if (c === ' ' || c === '\t') {
      // a space run whose hard break failed: whole run is text
      let k = i;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      txt += src.slice(i, k);
      lastWasText = true;
      lastChar = src[k - 1];
      i = k;
    } else {
      // a lone '<', '[', '*', '~', '!', '@', 'w', 'h', 'f', 'm' or
      // backslash: one character as text
      txt += c;
      i++;
      lastWasText = true;
      lastChar = c;
    }
  }
  flush();
  return out;
}

function isWordChar(ch) {
  return ch !== '' && /[A-Za-z0-9_]/.test(ch);
}

// ---------- block parsing ----------

function matchSpace(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const j = s.indexOf('\n', i);
    const hasNL = j !== -1;
    const eol = hasNL ? j : n;
    let k = i;
    while (k < eol && (s[k] === ' ' || s[k] === '\t')) k++;
    if (k !== eol) break;
    i = hasNL ? eol + 1 : n;
  }
  return i;
}

function matchIndentedCode(s) {
  let i = 0;
  const n = s.length;
  let matched = false;
  while (i < n) {
    let k = i;
    let spaces = 0;
    while (spaces < 4 && s[k] === ' ') { k++; spaces++; }
    let ok = false;
    if (spaces === 4) ok = true;
    else if (s[k] === '\t') { ok = true; k++; }
    if (!ok) break;
    let j = s.indexOf('\n', k);
    if (j === -1) j = n;
    if (j === k) break;
    i = j + 1 <= n ? j + 1 : n;
    matched = true;
    while (i < n) {
      const m = s.indexOf('\n', i);
      const hasNL = m !== -1;
      const eol = hasNL ? m : n;
      let q = i;
      while (q < eol && (s[q] === ' ' || s[q] === '\t')) q++;
      if (q !== eol) break;
      i = hasNL ? eol + 1 : n;
      if (!hasNL) break;
    }
  }
  if (!matched) return null;
  const raw = s.slice(0, i);
  let text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  text = trimTrailingBlanks(text);
  return { raw, text };
}

function matchFences(s) {
  let i = 0;
  while (i < 3 && s[i] === ' ') i++;
  const indent = i;
  if (s[i] !== '`' && s[i] !== '~') return null;
  const fenceCh = s[i];
  let f = i;
  while (s[f] === fenceCh) f++;
  const fenceLen = f - i;
  if (fenceLen < 3) return null;
  let eol = s.indexOf('\n', f);
  if (eol === -1) eol = s.length;
  const info = s.slice(f, eol);
  if (fenceCh === '`' && info.indexOf('`') !== -1) return null;
  let pos = eol === s.length ? s.length : eol + 1;
  let contentEnd = s.length;
  let closed = false;
  let closeEnd = s.length;
  let j = pos;
  while (j < s.length) {
    let k = j;
    let sp = 0;
    while (sp < 3 && s[k] === ' ') { k++; sp++; }
    let m = k;
    while (m < s.length && s[m] === fenceCh) m++;
    if (m - k >= fenceLen) {
      let e = m;
      while (e < s.length && s[e] === ' ') e++;
      if (e === s.length || s[e] === '\n') { contentEnd = j; closed = true; closeEnd = e; break; }
    }
    const nl = s.indexOf('\n', j);
    if (nl === -1) break;
    j = nl + 1;
  }
  let content = s.slice(pos, contentEnd);
  if (content.charAt(content.length - 1) === '\n') content = content.slice(0, -1);
  if (fenceCh === '`' && indent > 0) {
    const lines = content.split('\n');
    for (let x = 0; x < lines.length; x++) {
      const m2 = /^\s+/.exec(lines[x]);
      if (m2) lines[x] = lines[x].slice(Math.min(m2[0].length, indent));
    }
    content = lines.join('\n');
  }
  const lang = info.trim() ? unescapePunct(info.trim()) : info;
  // the fence match ends right after the closing fence (and its trailing
  // spaces); the trailing newline is left for the space matcher
  const end = closed ? closeEnd : s.length;
  const raw = s.slice(0, end);
  return { raw, lang, text: content, end };
}

function matchHeading(s) {
  let i = 0;
  while (i < 3 && s[i] === ' ') i++;
  if (s[i] !== '#') return null;
  let j = i;
  while (s[j] === '#') j++;
  const depth = j - i;
  if (depth > 6) return null;
  if (s[j] !== undefined && !isSpace(s[j])) return null;
  let eol = s.indexOf('\n', j);
  if (eol === -1) eol = s.length;
  let text = s.slice(j, eol).trim();
  if (text.charAt(text.length - 1) === '#') {
    const stripped = stripTrailing(text, '#');
    if (stripped === '' || stripped.charAt(stripped.length - 1) === ' ' || stripped.charAt(stripped.length - 1) === '\t') {
      text = stripped.trim();
    }
  }
  let end = eol;
  return { depth, text, raw: s.slice(0, eol), end };
}

function matchHr(s) {
  let i = 0;
  while (i < 3 && s[i] === ' ') i++;
  const ch = s[i];
  if (ch !== '-' && ch !== '_' && ch !== '*') return null;
  let j = i;
  let count = 0;
  while (j < s.length) {
    if (s[j] === ch) { count++; j++; }
    else if (s[j] === ' ' || s[j] === '\t') j++;
    else break;
  }
  if (count < 3) return null;
  if (j < s.length && s[j] !== '\n') return null;
  return { raw: s.slice(0, j), end: j };
}

// Is the line starting at `pos` the start of a block construct that would
// interrupt a paragraph (or a table row)? `line` is the line text.
function isBlockStartLine(line, s, pos) {
  // First non-space char decides which constructs are even possible, so a
  // plain prose line runs no regex at all.
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i >= line.length || i > 3) return false;
  const c = line[i];
  if (c === '-' || c === '_' || c === '*') {
    // hr (the whole line must be hr chars + spaces, like marked's hr regex
    // which requires \n or end after the run)
    if (/^ {0,3}(?:-[ \t]*){3,}[ \t]*$|^ {0,3}(?:_[ \t]*){3,}[ \t]*$|^ {0,3}(?:\*[ \t]*){3,}[ \t]*$/.test(line)) return true;
  }
  if (c === '#') {
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  }
  if (c === '>') {
    if (/^ {0,3}>/.test(line)) return true;
  }
  if (c === '`' || c === '~') {
    if (/^ {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)/.test(line)) return true;
  }
  if (c === '*' || c === '+' || c === '-' || (c >= '0' && c <= '9')) {
    // list (gfm paragraph rule: any bullet, or ordered starting with 1)
    if (/^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/.test(line)) return true;
  }
  if (c === '<') {
    if (isHtmlBlockStart(line)) return true;
  }
  return false;
}

function isHtmlBlockStart(line) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  if (line[i] !== '<') return false;
  const rest = line.slice(i);
  if (/^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|$|\/?>)/i.test(rest)) return true;
  if (/^<(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(rest)) return true;
  if (rest.startsWith('<!--')) return true;
  if (rest.startsWith('<?')) return true;
  if (/^<![A-Za-z]/.test(rest)) return true;
  if (rest.startsWith('<![CDATA[')) return true;
  return false;
}

// Match an opening tag per the HTML-block grammar (Ue condition 7): the
// tag name is not script/pre/style/textarea, attribute values may not span
// lines, and the tag must be followed by spaces/tabs then EOL. Returns the
// end index or -1.
function matchBlockOpenTag(s, i) {
  let j = i + 1;
  if (s[j] === '/') return -1;
  if (!/[a-zA-Z]/.test(s[j] || '')) return -1;
  let k = j;
  while (k < s.length && /[a-zA-Z0-9-]/.test(s[k])) k++;
  const name = s.slice(j, k).toLowerCase();
  if (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea') return -1;
  j = k;
  while (j < s.length && s[j] === ' ') {
    let a = j;
    while (a < s.length && s[a] === ' ') a++;
    if (!/[a-zA-Z:_]/.test(s[a] || '')) break;
    let b = a + 1;
    while (b < s.length && /[\w.:-]/.test(s[b])) b++;
    let c = b;
    while (c < s.length && s[c] === ' ') c++;
    if (s[c] === '=') {
      c++;
      while (c < s.length && s[c] === ' ') c++;
      if (s[c] === '"') {
        const e = s.indexOf('"', c + 1);
        if (e === -1 || s.slice(c + 1, e).indexOf('\n') !== -1) return -1;
        c = e + 1;
      } else if (s[c] === "'") {
        const e = s.indexOf("'", c + 1);
        if (e === -1 || s.slice(c + 1, e).indexOf('\n') !== -1) return -1;
        c = e + 1;
      } else {
        let e = c;
        while (e < s.length && !/[\s"'=<>`]/.test(s[e])) e++;
        if (e === c) return -1;
        c = e;
      }
    }
    j = c;
  }
  let t = j;
  while (t < s.length && s[t] === ' ') t++;
  if (s[t] === '/') t++;
  if (s[t] !== '>') return -1;
  t++;
  let u = t;
  while (u < s.length && (s[u] === ' ' || s[u] === '\t')) u++;
  if (u < s.length && s[u] !== '\n') return -1;
  return t;
}

function matchHtmlBlock(s) {
  let i = 0;
  while (i < 3 && s[i] === ' ') i++;
  if (s[i] !== '<') return null;
  const rest = s.slice(i);
  let end = -1;
  // 1. script/pre/style/textarea
  let m = /^<(script|pre|style|textarea)[\s>]/i.exec(rest);
  if (m) {
    const tag = m[1].toLowerCase();
    const closeRe = new RegExp('</' + tag + '[^\\n]*\\n*', 'i');
    const cm = closeRe.exec(rest.slice(m[0].length));
    if (cm) end = i + m[0].length + cm.index + cm[0].length;
    else end = s.length;
  } else if (rest.startsWith('<!--')) {
    const cm = /<!--(?:-?>|[\s\S]*?(?:-->|$))/.exec(rest);
    const after = rest.slice(cm[0].length);
    const lm = /^[^\n]*(\n+|$)/.exec(after);
    end = i + cm[0].length + lm[0].length;
  } else if (rest.startsWith('<?')) {
    const cm = /<\?[\s\S]*?(?:\?>[^\n]*\n*|$)/.exec(rest);
    end = i + cm[0].length;
  } else if (/^<![A-Z]/.test(rest)) {
    const cm = /<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)/.exec(rest);
    end = i + cm[0].length;
  } else if (rest.startsWith('<![CDATA[')) {
    const cm = /<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)/.exec(rest);
    end = i + cm[0].length;
  } else {
    // 6. block tag open/close; 7. open tag with attrs; 8. close tag
    const tagM = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
    if (tagM) {
      const name = tagM[1];
      const isClose = rest[1] === '/';
      const afterName = rest.slice(tagM[0].length);
      let ok = false;
      if (isClose) {
        const gm = /^\s*>/.exec(afterName);
        if (gm && /^[ \t]*(?:\n|$)/.test(afterName.slice(gm[0].length))) ok = true;
        // condition 6 also applies to closing tags of block elements
        if (!ok && BLOCK_TAG_RE.test(name) && /^(?:[ \t]+|\n|\/?>)/.test(afterName)) ok = true;
      } else if (BLOCK_TAG_RE.test(name)) {
        if (/^(?:[ \t]+|\n|\/?>)/.test(afterName)) ok = true;
      } else if (!/^(?:script|pre|style|textarea)(?![a-z0-9-])/i.test(name)) {
        // condition 7: full tag with block-grammar attributes, '>' followed
        // by spaces then EOL
        if (matchBlockOpenTag(s, i) !== -1) ok = true;
      }
      if (ok) {
        // consume until a blank line or EOF
        const term = /(?:\n[ \t]*)+\n/.exec(rest);
        end = term ? i + term.index + term[0].length : s.length;
      }
    }
  }
  if (end === -1) return null;
  const text = trimTrailingBlanks(s.slice(0, end));
  return { raw: text, text, end: text.length };
}

// Match a link reference definition; returns {tag, href, title, raw, end}.
function matchDef(s) {
  let i = 0;
  while (i < 3 && s[i] === ' ') i++;
  if (s[i] !== '[') return null;
  const ref = matchRef(s, i);
  if (!ref) return null;
  let j = ref.end;
  if (s[j] !== ':') return null;
  j++;
  while (s[j] === ' ') j++;
  if (s[j] === '\n') {
    j++;
    while (s[j] === ' ' || s[j] === '\t') j++;
  }
  let href = '';
  if (s[j] === '<') {
    const k = s.indexOf('>', j);
    if (k === -1) return null;
    href = s.slice(j, k + 1);
    j = k + 1;
  } else {
    if (j >= s.length || s[j] === '<' || isSpace(s[j])) return null;
    let k = j;
    while (k < s.length && !isSpace(s[k])) k++;
    href = s.slice(j, k);
    j = k;
  }
  if (href.charAt(0) !== '<' && parenBalance(href) !== -1) return null;
  // Optional title; if the title is followed by junk on the line, the def
  // regex backtracks and matches without the title.
  let title = '';
  const save = j;
  const w = skipTitleWS(s, j);
  let titleEnd = -1;
  if (w !== -1) {
    const mt = matchDefTitle(s, w);
    if (mt) {
      title = mt.title;
      titleEnd = mt.end;
    }
  }
  const trail = (k) => {
    while (s[k] === ' ') k++;
    let e = k;
    while (e < s.length && s[e] === '\n') e++;
    if (e === k && k < s.length) return -1;
    return e;
  };
  let end = titleEnd !== -1 ? trail(titleEnd) : -1;
  if (end === -1) {
    title = '';
    end = trail(save);
    if (end === -1) return null;
  }
  const raw = s.slice(0, end).replace(/\n+$/, '');
  const hm = /^<(.*)>$/.exec(href);
  const cleanHref = hm ? hm[1] : href;
  return {
    tag: normLabel(ref.ref),
    href: unescapePunct(cleanHref),
    title: title ? unescapePunct(title) : '',
    raw,
    end: raw.length,
  };
}

// A definition title: "..." | '...' (newlines only when not followed by a
// blank line) | (...).
function matchDefTitle(src, i) {
  const n = src.length;
  const q = src[i];
  if (q === '"') {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '"') return { title: src.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  if (q === "'") {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === "'") return { title: src.slice(i + 1, j), end: j + 1 };
      if (src[j] === '\n') {
        if (src[j + 1] === '\n') return null;
        j++;
        continue;
      }
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === ')') return { title: src.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}

function matchTable(s, st) {
  const n = s.length;
  let i = 0;
  while (i < n && s[i] === ' ') i++;
  if (i >= n || s[i] === '\n') return null;
  const hEnd = s.indexOf('\n', i);
  const headerLine = s.slice(i, hEnd === -1 ? n : hEnd);
  if (hEnd === -1) return null;
  let d = hEnd + 1;
  let sp = 0;
  while (sp < 3 && s[d] === ' ') { d++; sp++; }
  const dEnd = s.indexOf('\n', d);
  const delimLine = s.slice(d, dEnd === -1 ? n : dEnd);
  if (!/^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(delimLine)) return null;
  if (!/[:|]/.test(delimLine)) return null;
  const headerCells = splitCells(headerLine);
  const delimCells = delimLine.replace(/^\||\| *$/g, '').split('|');
  if (headerCells.length !== delimCells.length) return null;
  const align = delimCells.map((c) => {
    if (/^ *-+: *$/.test(c)) return 'right';
    if (/^ *:-+: *$/.test(c)) return 'center';
    if (/^ *:-+ *$/.test(c)) return 'left';
    return null;
  });
  let pos = dEnd === -1 ? n : dEnd + 1;
  const rows = [];
  while (pos < n) {
    const lineEnd = s.indexOf('\n', pos);
    const eol = lineEnd === -1 ? n : lineEnd;
    const line = s.slice(pos, eol);
    // the table body regex excludes only space-only blank lines ( *\n);
    // a tab-only line is a row (it is not blank, and not indented code
    // since nothing follows the tab)
    if (/^ *$/.test(line)) break;
    if (isBlockStartLine(line, s, pos)) break;
    if (pos > 0 && s[pos - 1] === '\n') {
      // a row line must not be indented code
      if (/^(?: {4}| {0,3}\t)[^\n]/.test(line)) break;
    }
    rows.push(line);
    pos = eol + 1;
    if (lineEnd === -1) break;
  }
  let end = pos;
  while (end < n && s[end] === '\n') end++;
  const raw = s.slice(0, end).replace(/\n+$/, '');
  const header = headerCells.map((c, idx) => ({ text: c, align: align[idx] }));
  const rowNodes = rows.map((line) => splitCells(line, headerCells.length).map((c, idx) => ({ text: c, align: align[idx] })));
  return { header, rows: rowNodes, raw, end: raw.length };
}

function matchSetext(s, tableChecked) {
  // first line must not start a block construct
  const firstEnd = s.indexOf('\n');
  const firstLine = firstEnd === -1 ? s : s.slice(0, firstEnd);
  if (/^[ \t]*$/.test(firstLine)) return null;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])/.test(firstLine)) return null;
  if (/^(?: {4}| {0,3}\t)/.test(firstLine)) return null;
  if (isBlockStartLine(firstLine, s, 0)) return null;
  // tableChecked: the caller already ran matchTable on this s and it failed
  if (!tableChecked && matchTable(s)) return null;
  // scan lines for the underline
  let pos = 0;
  const lines = [];
  while (pos < s.length) {
    const eol = s.indexOf('\n', pos);
    const lineEnd = eol === -1 ? s.length : eol;
    const line = s.slice(pos, lineEnd);
    const um = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (um) {
      if (lines.length === 0) return null;
      const text = lines.join('\n').trim();
      const depth = um[1].charAt(0) === '=' ? 1 : 2;
      return { depth, text, raw: s.slice(0, lineEnd), end: lineEnd };
    }
    if (/^[ \t]*$/.test(line)) return null;
    if (lines.length > 0) {
      if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])/.test(line)) return null;
      if (isBlockStartLine(line, s, pos)) return null;
    }
    lines.push(line);
    if (eol === -1) return null;
    pos = eol + 1;
  }
  return null;
}

function matchParagraph(s) {
  // first line + continuation lines that are not blank and do not start a
  // block construct
  let pos = 0;
  let end = 0;
  const n = s.length;
  while (pos < n) {
    const eol = s.indexOf('\n', pos);
    const lineEnd = eol === -1 ? n : eol;
    const line = s.slice(pos, lineEnd);
    if (pos > 0) {
      // a blank continuation line ends the paragraph — but a whitespace-only
      // line at EOF (no trailing newline) is not a blank line per the
      // paragraph regex's [ \t]+\n lookahead
      if (/^[ \t]*$/.test(line) && eol !== -1) break;
      if (isBlockStartLine(line, s, pos)) break;
      if (matchTable(s.slice(pos))) break;
    }
    end = lineEnd;
    if (eol === -1) { pos = n; break; }
    pos = eol + 1;
    if (pos >= n) break;
  }
  if (end === 0 && pos === 0) return null;
  let text = s.slice(0, end);
  if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
  return { src: text, raw: s.slice(0, end), end };
}

function matchText(s) {
  const eol = s.indexOf('\n');
  const end = eol === -1 ? s.length : eol;
  if (end === 0) return null;
  return { src: s.slice(0, end), raw: s.slice(0, end), end };
}

// Match a blockquote starting at the beginning of s. Returns {node, end}.
// Node: {k:'bq', nodes, raw, text}
function matchBlockquote(s, st) {
  // Collect the lines that belong to the blockquote (a '>' line, or a lazy
  // continuation of a paragraph inside it).
  const lines = [];
  let pos = 0;
  let first = true;
  while (pos < s.length) {
    const eol = s.indexOf('\n', pos);
    const lineEnd = eol === -1 ? s.length : eol;
    const line = s.slice(pos, lineEnd);
    if (/^ {0,3}>/.test(line)) {
      lines.push(line);
      pos = lineEnd + 1;
      first = false;
      // lazy continuation lines: consume paragraph continuation lines that
      // follow a non-blank '>' line
      const after = line.replace(/^ {0,3}>[ \t]?/, '');
      if (after.trim() !== '' && eol !== -1) {
        while (pos < s.length) {
          const e2 = s.indexOf('\n', pos);
          const le2 = e2 === -1 ? s.length : e2;
          const l2 = s.slice(pos, le2);
          if (/^[ \t]*$/.test(l2)) break;
          if (isBlockStartLine(l2, s, pos)) break;
          if (matchTable(s.slice(pos))) break;
          lines.push(l2);
          pos = le2 + 1;
          if (e2 === -1) break;
        }
      }
      if (eol === -1) break;
      continue;
    }
    if (first) return null;
    break;
  }
  if (lines.length === 0) return null;

  let sRaw = '';
  let rText = '';
  let tokens = [];
  let rest = lines.slice();
  while (rest.length > 0) {
    let p = 0;
    const chunk = [];
    let isLazy = false;
    for (; p < rest.length; p++) {
      if (/^ {0,3}>/.test(rest[p])) {
        chunk.push(rest[p]);
        isLazy = true;
      } else if (!isLazy) {
        chunk.push(rest[p]);
      } else {
        break;
      }
    }
    rest = rest.slice(p);
    const h = chunk.join('\n');
    const u = h
      .replace(/^( {0,3}>)([ \t]+)/gm, (g, b, m) => b + expandTabs(m, b.length))
      .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
      .replace(/^ {0,3}>[ \t]?/gm, '');
    sRaw = sRaw ? sRaw + '\n' + h : h;
    rText = rText ? rText + '\n' + u : u;
    const inner = lexBlocks(u, st, true, true, tokens);
    if (rest.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.k === 'code' || last.k === 'heading' || last.k === 'hr' || last.k === 'html' || last.k === 'table')) break;
    if (last && last.k === 'bq') {
      const g = last;
      const b = rest.join('\n');
      const m2 = g.raw + '\n' + b.replace(/^ {0,3}>[ \t]?/gm, '');
      const f = matchBlockquote(m2, st);
      if (!f) break;
      tokens[tokens.length - 1] = f.node;
      const y = m2.slice(f.node.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? rest.slice(0, -R) : rest;
      if (A.length > 0) sRaw += '\n' + A.join('\n');
      rText = rText.slice(0, rText.length - g.text.length) + f.node.text;
      rest = rest.slice(A.length);
      if (rest.length > 0 && /^ {0,3}>/.test(rest[0])) continue;
      break;
    } else if (last && last.k === 'list') {
      const g = last;
      const b = g.raw + '\n' + rest.join('\n');
      const m2 = matchList(b, st);
      if (!m2) break;
      tokens[tokens.length - 1] = m2.node;
      const f = m2.node.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m2.node.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = rest.slice(0, f).join('\n');
        sRaw += '\n' + y;
        rText += '\n' + y;
      }
      rest = rest.slice(f);
      continue;
    }
    // paragraph/text/space: continue with the next chunk (it merges via
    // mergePara)
  }
  // consumed length: the processed raw (sRaw) covers a prefix of the
  // original string; unprocessed lazy lines are left for the outer lexer
  return { node: { k: 'bq', nodes: tokens, raw: sRaw, text: rText }, end: sRaw.length };
}

const listItemRegex = memo1((marker) => new RegExp(`^( {0,3}${marker})((?:[ \\t][^\\n]*)?(?:\\n|$))`));
// marked memoizes these with D(): the indent argument is clamped to
// max(0, min(3, R - 1)) before the regex is built. Memoize them here too:
// R is 0..3 after clamping, so each builder has at most 4 instances and
// building the (large) html regex per list item is avoided.
const clampR = (r) => Math.max(0, Math.min(3, r - 1));
function memo1(fn) {
  const cache = new Map();
  return (a) => {
    let r = cache.get(a);
    if (r === undefined) { r = fn(a); cache.set(a, r); }
    return r;
  };
}
const nextBulletRegex = memo1((r) => new RegExp(`^ {0,${clampR(r)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrRegex = memo1((r) => new RegExp(`^ {0,${clampR(r)}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = memo1((r) => new RegExp(`^ {0,${clampR(r)}}(?:\`\`\`|~~~)`));
const headingBeginRegex = memo1((r) => new RegExp(`^ {0,${clampR(r)}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = memo1((r) => new RegExp(`^ {0,${clampR(r)}}(?:</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = memo1((r) => new RegExp(`^ {0,${clampR(r)}}>`));

// Match a list starting at the beginning of s. Returns {node, end}.
// First line of s (up to the first \n), without allocating a split array.
function firstLine(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}
// First non-space char of a line ('' when blank). Only ` ~ # < > * + - _
// and digits can start a block construct, so other lines skip the regexes.
function firstNonSpace(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i < line.length ? line[i] : '';
}
const BLOCK_START_CHARS = new Set(['`', '~', '#', '<', '>', '*', '+', '-', '_', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);

function matchList(s, st) {
  const n = s;
  let e = s;
  const first = /^ {0,3}([*+-]|\d{1,9}[.)])([ \t][^\n]*?)?(?:\n|$)/.exec(e);
  if (!first) return null;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const listNode = {
    k: 'list',
    ordered,
    start: ordered ? parseInt(bullet.slice(0, -1), 10) : '',
    loose: false,
    items: [],
    raw: '',
  };
  const marker = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = listItemRegex(marker);
  let p = false;
  let lastU = false;
  while (e) {
    let u = false;
    let d = '';
    const it = itemRe.exec(e);
    const ec = e.charCodeAt(0);
    if (!it || ((ec === 45 || ec === 95 || ec === 42 || ec === 32) && /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/.test(e))) break;
    const itemStart = n.length - e.length;
    e = e.substring(it[0].length);
    const g = firstLine(it[2]);
    const b = it[1].length;
    let m = g.replace(/^[ \t]+/, (v) => expandTabs(v, b));
    let f = firstLine(e);
    let y = !m.trim();
    let R = 0;
    // first non-whitespace index of m, counting each tab as 4 spaces
    // (as m.replace(/\t/g, '    ').search(/\S/) does)
    let mFirstNonWs = 0;
    if (!y) {
      let oi = 0;
      let rc = 0;
      while (oi < m.length) {
        const mc = m[oi];
        if (mc === ' ') { oi++; rc++; }
        else if (mc === '\t') { oi++; rc += 4; }
        else break;
      }
      mFirstNonWs = rc;
    }
    if (y) {
      R = b + 1;
    } else {
      R = mFirstNonWs;
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    if (y && /^[ \t]*$/.test(f)) {
      e = e.substring(f.length + 1);
      u = true;
    }
    if (!u) {
      const nextBullet = nextBulletRegex(R);
      const hrR = hrRegex(R);
      const fencesR = fencesBeginRegex(R);
      const headingR = headingBeginRegex(R);
      const htmlR = htmlBeginRegex(R);
      const bqR = blockquoteBeginRegex(R);
      while (e) {
        const U = firstLine(e);
        f = U;
        // Expand leading tabs to tab stops; expandTabs leaves the run
        // unchanged when it holds no tab, so only then run the replace.
        let Z = f;
        if (f.charCodeAt(0) === 32 || f.charCodeAt(0) === 9) {
          let lead = 0;
          while (lead < f.length && (f[lead] === ' ' || f[lead] === '\t')) lead++;
          if (f.slice(0, lead).indexOf('\t') !== -1) Z = f.replace(/^[ \t]+/, (me) => expandTabs(me, 0));
        }
        // only lines that could start a block construct need the regexes
        const fc = firstNonSpace(f);
        if (fc !== '' && BLOCK_START_CHARS.has(fc) && (fencesR.test(f) || headingR.test(f) || htmlR.test(f) || bqR.test(f) || nextBullet.test(f) || hrR.test(f))) break;
        // first non-whitespace index of Z (-1 when all whitespace)
        let zNonWs = -1;
        for (let zi = 0; zi < Z.length; zi++) {
          const zc = Z[zi];
          if (zc !== ' ' && zc !== '\t') { zNonWs = zi; break; }
        }
        if ((zNonWs !== -1 && zNonWs >= R) || zNonWs === -1) {
          d += '\n' + Z.slice(R);
        } else {
          if (y || mFirstNonWs >= 4 || fencesR.test(m) || headingR.test(m) || htmlR.test(m) || hrR.test(m)) break;
          let qe = f;
          if (/^ {0,3}(?:=+|-+) *$/.test(f) && matchSetext(m + '\n' + f)) {
            qe = '    ' + Z.replace(/^ {0,3}/, '');
          }
          d += '\n' + qe;
        }
        y = !f.trim();
        e = e.substring(U.length + 1);
        m = Z.slice(R);
      }
    }
    const itemRaw = n.slice(itemStart, n.length - e.length);
    const item = { raw: itemRaw, text: d, task: false, checked: undefined, loose: false, nodes: [] };
    item.task = /^\[[ xX]\][ \t]+\S/.test(d);
    if (!u) {
      item.nodes = lexBlocks(d, st, false, false);
    }
    lastU = u;
    if (!listNode.loose) {
      if (p) {
        listNode.loose = true;
        item.loose = true;
      } else if (/\n[ \t]*\n[ \t]*$/.test(itemRaw)) {
        p = true;
      }
    }
    listNode.items.push(item);
  }
  const lastItem = listNode.items[listNode.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  // marked trims the last item's text BEFORE lexing its tokens, so trailing
  // blank lines never produce a space token that would make the list loose
  if (!lastU) lastItem.nodes = lexBlocks(lastItem.text, st, false, false);
  listNode.raw = n.slice(0, n.length - e.length).trimEnd();
  // per-item loose detection via space tokens
  for (const item of listNode.items) {
    if (!listNode.loose) {
      const spaces = item.nodes.filter((g) => g.k === 'space');
      if (spaces.length > 0 && spaces.some((g) => /\n.*\n/.test(g.raw))) {
        listNode.loose = true;
      }
    }
  }
  if (listNode.loose) {
    for (const item of listNode.items) {
      item.loose = true;
      for (const tok of item.nodes) {
        if (tok.k === 'text') tok.k = 'p';
      }
    }
  }
  // task items: strip the checkbox prefix, record checked state
  for (const item of listNode.items) {
    if (!item.task) continue;
    const firstNode = item.nodes[0];
    if (firstNode && (firstNode.k === 'p' || firstNode.k === 'text')) {
      const tm = /^\[[ xX]\][ \t]+/.exec(firstNode.src);
      if (tm) {
        item.checked = tm[0][1] !== ' ';
        item.checkbox = item.checked;
        firstNode.src = firstNode.src.replace(/^\[[ xX]\][ \t]+/, '');
        firstNode.raw = firstNode.raw.replace(/^\[[ xX]\][ \t]+/, '');
        firstNode.checkbox = item.checked;
      }
    } else {
      item.task = false;
    }
  }
  // the outer lexer consumes r.raw.length: the raw is trimEnd'ed, so the
  // trailing newlines are left for the space matcher
  return { node: listNode, end: listNode.raw.length };
}

// The block lexer. `top` = whether paragraphs may be created (false inside
// list items); `mergePara` = whether a paragraph merges into the previous
// paragraph (blockquotes). Appends to `nodes` (a fresh array when omitted)
// so a blockquote can merge paragraphs across its chunks.
function lexBlocks(src, st, top, mergePara, nodes) {
  nodes = nodes || [];
  let s = src;
  let prevLen = -1;
  while (s) {
    if (s.length === prevLen) throw new Error('Infinite loop on byte: ' + s.charCodeAt(0));
    prevLen = s.length;
    let r;
    // blank lines
    const sp = matchSpace(s);
    if (sp > 0) {
      const raw = s.slice(0, sp);
      s = s.slice(sp);
      const prev = nodes[nodes.length - 1];
      if (raw.length === 1 && prev) prev.raw += '\n';
      else nodes.push({ k: 'space', raw });
      continue;
    }
    // First non-space/tab char of the block (and its index): every block
    // matcher below only fires for a few leading characters, so a plain
    // paragraph line skips the ones that cannot match. matchers that allow
    // at most 3 leading spaces are skipped when the char sits past 3.
    let fci = 0;
    while (fci < s.length && (s[fci] === ' ' || s[fci] === '\t')) fci++;
    const fc = fci < s.length ? s[fci] : '';
    const near = fci <= 3;
    // indented code
    r = (s[0] === ' ' || s[0] === '\t') ? matchIndentedCode(s) : null;
    if (r) {
      const prev = nodes[nodes.length - 1];
      if (prev && (prev.k === 'p' || prev.k === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.src += '\n' + r.text;
      } else {
        nodes.push({ k: 'code', text: r.text, lang: null, raw: r.raw });
      }
      s = s.slice(r.raw.length);
      continue;
    }
    // fences
    r = (near && (fc === '`' || fc === '~')) ? matchFences(s) : null;
    if (r) {
      nodes.push({ k: 'code', text: r.text, lang: r.lang, raw: r.raw });
      s = s.slice(r.end);
      continue;
    }
    // ATX heading
    r = (near && fc === '#') ? matchHeading(s) : null;
    if (r) {
      nodes.push({ k: 'heading', depth: r.depth, src: r.text, raw: r.raw });
      s = s.slice(r.end);
      continue;
    }
    // hr
    r = (near && (fc === '-' || fc === '_' || fc === '*')) ? matchHr(s) : null;
    if (r) {
      nodes.push({ k: 'hr', raw: r.raw });
      s = s.slice(r.end);
      continue;
    }
    // blockquote
    r = (near && fc === '>') ? matchBlockquote(s, st) : null;
    if (r) {
      nodes.push(r.node);
      s = s.slice(r.end);
      continue;
    }
    // list
    r = (near && (fc === '*' || fc === '+' || fc === '-' || (fc >= '0' && fc <= '9'))) ? matchList(s, st) : null;
    if (r) {
      nodes.push(r.node);
      s = s.slice(r.end);
      continue;
    }
    // html block
    r = (near && fc === '<') ? matchHtmlBlock(s) : null;
    if (r) {
      nodes.push({ k: 'html', text: r.text, raw: r.raw });
      s = s.slice(r.end);
      continue;
    }
    // link reference definition
    r = (near && fc === '[') ? matchDef(s) : null;
    if (r) {
      const prev = nodes[nodes.length - 1];
      if (prev && (prev.k === 'p' || prev.k === 'text')) {
        prev.raw += '\n' + r.raw;
        prev.src += '\n' + r.raw;
      } else {
        if (!(r.tag in st.links)) {
          st.links[r.tag] = { href: r.href, title: r.title };
        }
        // defs are not rendered; keep a marker node so raw accounting works
        nodes.push({ k: 'def', raw: r.raw });
      }
      s = s.slice(r.end);
      continue;
    }
    // table
    r = matchTable(s, st);
    if (r) {
      nodes.push({ k: 'table', header: r.header, rows: r.rows, raw: r.raw });
      s = s.slice(r.end);
      continue;
    }
    // setext heading (matchTable just failed on this s in the block above)
    r = matchSetext(s, true);
    if (r) {
      nodes.push({ k: 'heading', depth: r.depth, src: r.text, raw: r.raw });
      s = s.slice(r.end);
      continue;
    }
    // paragraph (top) or text
    if (top) {
      r = matchParagraph(s);
      if (r) {
        const prev = nodes[nodes.length - 1];
        if (mergePara && prev && prev.k === 'p') {
          prev.raw += '\n' + r.raw;
          prev.src += '\n' + r.src;
        } else {
          nodes.push({ k: 'p', src: r.src, raw: r.raw });
        }
        s = s.slice(r.end);
        continue;
      }
    } else {
      r = matchText(s);
      if (r) {
        const prev = nodes[nodes.length - 1];
        if (prev && prev.k === 'text') {
          prev.raw += '\n' + r.raw;
          prev.src += '\n' + r.src;
        } else {
          nodes.push({ k: 'text', src: r.src, raw: r.raw });
        }
        s = s.slice(r.end);
        continue;
      }
    }
    // fallback: single line as text (should not happen often)
    const eol = s.indexOf('\n');
    const line = eol === -1 ? s : s.slice(0, eol);
    if (line.length === 0) {
      s = s.slice(1);
      continue;
    }
    const prev = nodes[nodes.length - 1];
    if (prev && prev.k === 'text') {
      prev.raw += '\n' + line;
      prev.src += '\n' + line;
    } else {
      nodes.push({ k: 'text', src: line, raw: line });
    }
    s = s.slice(line.length);
  }
  return nodes;
}

// ---------- block rendering ----------

function renderBlocks(nodes, st) {
  const parts = [];
  for (const t of nodes) {
    switch (t.k) {
      case 'space':
      case 'def':
        break;
      case 'code': {
        let txt = t.text;
        const lang = (t.lang || '').match(/^\S*/)[0];
        let r = txt ? txt.replace(/\n$/, '') + '\n' : '';
        const e = esc(r, true);
        parts.push(lang
          ? `<pre><code class="language-${esc(lang, false)}">${e}</code></pre>\n`
          : `<pre><code>${e}</code></pre>\n`);
        break;
      }
      case 'heading': {
        st.inRawBlock = false;
        parts.push(`<h${t.depth}>`, inlineHtml(t.src, st, false), `</h${t.depth}>\n`);
        break;
      }
      case 'hr':
        parts.push('<hr>\n');
        break;
      case 'bq':
        parts.push('<blockquote>\n', renderBlocks(t.nodes, st), '</blockquote>\n');
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        parts.push(t.ordered && t.start !== 1 && t.start !== ''
          ? `<${tag} start="${t.start}">\n`
          : `<${tag}>\n`);
        for (const item of t.items) {
          parts.push('<li>');
          let body = renderBlocks(item.nodes, st);
          if (item.checkbox !== undefined && item.nodes.length > 0 && (item.nodes[0].k === 'p' || item.nodes[0].k === 'text')) {
            // checkbox is inserted inside the first paragraph/text node
            const cb = `<input ${item.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
            body = body.replace(/^(<p>)?/, '$1' + cb);
          }
          parts.push(body, '</li>\n');
        }
        parts.push(`</${tag}>\n`);
        break;
      }
      case 'html':
        parts.push(t.text);
        break;
      case 'table': {
        parts.push('<table>\n<thead>\n<tr>\n');
        for (const c of t.header) {
          parts.push(c.align ? `<th align="${c.align}">` : '<th>');
          st.inRawBlock = false;
          parts.push(inlineHtml(c.text.trim(), st, false), '</th>\n');
        }
        parts.push('</tr>\n</thead>\n');
        if (t.rows.length > 0) {
          parts.push('<tbody>');
          for (const row of t.rows) {
            parts.push('<tr>\n');
            for (const c of row) {
              parts.push(c.align ? `<td align="${c.align}">` : '<td>');
              st.inRawBlock = false;
              parts.push(inlineHtml(c.text.trim(), st, false), '</td>\n');
            }
            parts.push('</tr>\n');
          }
          parts.push('</tbody>');
        }
        parts.push('</table>\n');
        break;
      }
      case 'p': {
        st.inRawBlock = false;
        parts.push('<p>', inlineHtml(t.src, st, false), '</p>\n');
        break;
      }
      case 'text': {
        st.inRawBlock = false;
        parts.push(inlineHtml(t.src, st, false));
        break;
      }
    }
  }
  return parts.join('');
}

// ---------- entry point ----------

export function parse(markdown) {
  const md = String(markdown);
  const src = md.indexOf('\r') === -1 ? md : md.replace(/\r\n|\r/g, '\n');
  const st = { links: {}, inLink: false, linkEmitted: false, inRawBlock: false };
  const nodes = lexBlocks(src, st, true, false);
  return renderBlocks(nodes, st);
}
