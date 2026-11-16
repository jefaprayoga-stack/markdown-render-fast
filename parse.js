// markdown-render-fast: a faster drop-in for marked 18.1.3.
//
// parse(markdown) returns byte-for-byte the HTML marked 18.1.3's
// marked.parse(markdown) returns with marked's default options (gfm on, breaks
// off, pedantic off, async off). It subclasses marked's own Lexer and overrides
// only its two dispatch loops: block tokens are dispatched on the first
// character (plus cheap pre-checks for tables and setext headings), inline
// tokens likewise, and the paragraph regex is replaced by a manual line scanner
// applying the same interruption rules. The tokenizers, the renderer and every
// output rule are marked's own, so the HTML is identical by construction: the
// fork only changes *which* tokenizers are attempted, never what they return.
//
// marked 18.1.3 is (c) MarkedJS, MIT licensed; see vendor/marked/LICENSE and
// vendor/marked/NOTICE. This file's own code is MIT, see ../LICENSE.

import { Lexer, Parser } from './vendor/marked/marked.esm.js';

/** marked's defaults, as parse() runs with them (getDefaults()). */
const DEF = {
  async: false,
  breaks: false,
  extensions: null,
  gfm: true,
  hooks: null,
  pedantic: false,
  renderer: null,
  silent: false,
  tokenizer: null,
  walkTokens: null,
};

/** One probe lexer, to reach marked's shared rule tables (block, inline, other). */
const _probe = new Lexer(DEF);
const OTHER = _probe.tokenizer.rules.other;
const BLOCK_RULES = _probe.tokenizer.rules.block;

/** The hr rule, as the paragraph lookahead tests it. */
const HR_RE = BLOCK_RULES.hr;
/** The heading start the paragraph lookahead tests for. */
const HEADING_BEGIN = OTHER.headingBeginRegex(4);
/** The blockquote start the paragraph lookahead tests for. */
const BLOCKQUOTE_BEGIN = OTHER.blockquoteBeginRegex(4);
/** The html start the paragraph lookahead tests for (on a line slice, $ is its \n). */
const HTML_BEGIN = OTHER.htmlBeginRegex(4);
/** The table rule, run only when the next line looks like a delimiter row. */
const TABLE_RE = BLOCK_RULES.table;

/** A table delimiter row, as the table rule's second line. */
const DELIMITER_ROW = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;
/** The fences pattern the paragraph rule's lookahead uses to interrupt a paragraph. */
const FENCES_INTERRUPT = /^ {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/;
/** The list pattern the paragraph rule's lookahead uses: only *+- and 1. bullets interrupt. */
const LIST_INTERRUPT = /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/;

/** marked's link-label normalisation (link reference definitions). */
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Is the character code an email-local-part character (the url rule's email start)? */
function isEmailChar(code) {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 46 || // .
    code === 95 || // _
    code === 43 || // +
    code === 45 // -
  );
}

/**
 * Could the url rule (GFM autolink) match at the start of `src`? A cheap
 * pre-check for the inline dispatch: true for www., for a protocol/mailto word
 * followed by ':', and for an email-shaped word followed by '@'. A superset of
 * the url rule: it may say yes where the rule fails, never the reverse.
 */
function urlMayMatch(src) {
  if (
    src.charCodeAt(0) === 119 && // w
    src.charCodeAt(1) === 119 &&
    src.charCodeAt(2) === 119 &&
    src.charCodeAt(3) === 46 // .
  ) {
    return true;
  }
  let i = 0;
  const n = src.length;
  while (i < n && isEmailChar(src.charCodeAt(i))) i++;
  const next = src.charCodeAt(i);
  if (next === 64) return true; // '@': an email may start here
  if (next === 58) {
    // ':': mailto:, xmpp: or a protocol:// may start here
    const word = src.slice(0, i).toLowerCase();
    return word === 'mailto' || word === 'xmpp' || word === 'http' || word === 'https' || word === 'ftp';
  }
  return false;
}

/**
 * Does `src` hold a setext underline line (=== or ---) after its first line
 * and before its first blank line? The lheading pre-check for the block
 * dispatch: the lheading rule can only match when one exists.
 */
function hasSetextUnderline(src) {
  let lineStart = src.indexOf('\n');
  if (lineStart === -1) return false;
  lineStart++;
  while (lineStart < src.length) {
    let lineEnd = src.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = src.length;
    // Blank line (empty, or spaces/tabs only) ends the paragraph: no underline past it.
    let i = lineStart;
    while (i < lineEnd && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
    if (i === lineEnd) return false;
    // Underline: up to 3 spaces, then 1+ '=' or 1+ '-', then spaces/tabs only.
    let j = lineStart;
    let spaces = 0;
    while (spaces < 3 && src.charCodeAt(j) === 32) {
      j++;
      spaces++;
    }
    const mark = src.charCodeAt(j);
    if (mark === 61 || mark === 45) {
      // = or -
      let k = j;
      while (k < lineEnd && src.charCodeAt(k) === mark) k++;
      let m = k;
      while (m < lineEnd && (src.charCodeAt(m) === 32 || src.charCodeAt(m) === 9)) m++;
      if (m === lineEnd) return true;
    }
    lineStart = lineEnd + 1;
  }
  return false;
}

/**
 * Does the second line of `src` look like a table delimiter row? The table
 * pre-check for the block dispatch: the table rule can only match then.
 */
function hasDelimiterRow(src) {
  const firstEnd = src.indexOf('\n');
  if (firstEnd === -1) return false;
  const secondStart = firstEnd + 1;
  let secondEnd = src.indexOf('\n', secondStart);
  if (secondEnd === -1) secondEnd = src.length;
  // A delimiter row always holds a '-'; without one the delimiter regex cannot match.
  const dash = src.indexOf('-', secondStart);
  if (dash === -1 || dash >= secondEnd) return false;
  return DELIMITER_ROW.test(src.slice(secondStart, secondEnd));
}

/**
 * The paragraph the block rule matches at the start of `src`, or null when the
 * first line is empty. Replicates the GFM paragraph regex: the first line,
 * plus following lines while none of them starts an interrupting block (hr,
 * heading, blockquote, fences, list, html, table) or is blank. Returns the
 * raw text (lines joined by \n, no trailing newline).
 */
function scanParagraph(src) {
  let end = src.indexOf('\n');
  if (end === -1) end = src.length;
  if (end === 0) return null;
  let pos = end;
  while (pos < src.length) {
    const lineStart = pos + 1;
    let lineEnd = src.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = src.length;
    const hasNewline = lineEnd < src.length;
    // Blank line ends the paragraph: empty, or spaces/tabs only followed by \n.
    // (A non-empty spaces-only last line, with no \n after it, is part of the
    // paragraph: the paragraph regex's blank lookahead needs the \n.)
    let i = lineStart;
    while (i < lineEnd && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
    if (i === lineEnd) {
      if (hasNewline || lineStart === lineEnd) break;
      pos = lineEnd;
      break;
    }
    // Leading spaces (0-3 matter: the interruption rules allow at most 3).
    let indent = 0;
    while (indent < 3 && src.charCodeAt(lineStart + indent) === 32) indent++;
    const first = src.charCodeAt(lineStart + indent);
    let line;
    if (indent < 3 || src.charCodeAt(lineStart + 3) !== 32) {
      // A line indented 4+ spaces (or starting with a tab) cannot start an
      // interrupting block; only a table can still start here.
      if (first === 35) {
        // '#'
        if (HEADING_BEGIN.test((line ??= src.slice(lineStart, lineEnd)))) break;
      } else if (first === 62) {
        // '>'
        break; // a blockquote always interrupts
      } else if (first === 96 || first === 126) {
        // '`' or '~'
        if (FENCES_INTERRUPT.test((line ??= src.slice(lineStart, lineEnd)))) break;
      } else if (first === 45 || first === 95 || first === 42) {
        // '-', '_' or '*'
        if (HR_RE.test((line ??= src.slice(lineStart, lineEnd)))) break;
        if (first !== 95 && LIST_INTERRUPT.test(line)) break;
      } else if (first === 43) {
        // '+'
        if (LIST_INTERRUPT.test((line ??= src.slice(lineStart, lineEnd)))) break;
      } else if (first >= 48 && first <= 57) {
        // digit: only a 1. / 1) bullet interrupts
        if (LIST_INTERRUPT.test((line ??= src.slice(lineStart, lineEnd)))) break;
      } else if (first === 60) {
        // '<'
        if (HTML_BEGIN.test((line ??= src.slice(lineStart, lineEnd)))) break;
      }
    }
    // Table: the current line plus the next line must start a table, which
    // needs the next line to be a delimiter row.
    if (hasNewline) {
      const nextStart = lineEnd + 1;
      let nextEnd = src.indexOf('\n', nextStart);
      if (nextEnd === -1) nextEnd = src.length;
      const dash = src.indexOf('-', nextStart);
      if (dash !== -1 && dash < nextEnd && DELIMITER_ROW.test(src.slice(nextStart, nextEnd))) {
        break;
      }
    }
    pos = lineEnd;
  }
  return src.slice(0, pos);
}

/**
 * marked's Lexer with fast dispatch loops. The tokenizers, the renderer and
 * the token shapes are all marked's own; only the *attempt order* changes:
 * each block is dispatched on its first character (so a paragraph line never
 * pays for the fences, heading, hr, blockquote, list, html or def regexes),
 * tables and setext headings are attempted only when a cheap pre-check says
 * they can match, and the paragraph regex is replaced by scanParagraph.
 */
class FastLexer extends Lexer {
  blockTokens(src, tokens = [], top = false) {
    this.tokenizer.lexer = this;
    let e = src;
    let n = top;
    let smallest = Infinity;
    for (; e;) {
      if (e.length < smallest) {
        smallest = e.length;
      } else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      let r;
      // Find the first non-space/tab character of the first line.
      let k = 0;
      const len = e.length;
      while (k < len) {
        const c = e.charCodeAt(k);
        if (c === 10) break;
        if (c !== 32 && c !== 9) break;
        k++;
      }
      const firstEnd = e.indexOf('\n');
      const firstLineEnd = firstEnd === -1 ? len : firstEnd;
      if (k === firstLineEnd) {
        // Blank first line: only the space rule can match here.
        r = this.tokenizer.space(e);
        e = e.substring(r.raw.length);
        const prev = tokens.at(-1);
        if (r.raw.length === 1 && prev !== undefined) {
          prev.raw += '\n';
        } else {
          tokens.push(r);
        }
        continue;
      }
      // Leading spaces before the first tab or non-blank character.
      let sp = 0;
      while (sp < k && e.charCodeAt(sp) === 32) sp++;
      if (sp >= 4 || e.charCodeAt(sp) === 9) {
        // Indented code: 4+ spaces, or up to 3 spaces plus a tab.
        r = this.tokenizer.code(e);
        if (r) {
          e = e.substring(r.raw.length);
          const prev = tokens.at(-1);
          if (prev?.type === 'paragraph' || prev?.type === 'text') {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
            prev.text += '\n' + r.text;
            this.inlineQueue.at(-1).src = prev.text;
          } else {
            tokens.push(r);
          }
          continue;
        }
      }
      const c = e.charCodeAt(k);
      switch (c) {
        case 96: // '`'
        case 126: // '~'
          if ((r = this.tokenizer.fences(e))) {
            e = e.substring(r.raw.length);
            tokens.push(r);
            continue;
          }
          break;
        case 35: // '#'
          if ((r = this.tokenizer.heading(e))) {
            e = e.substring(r.raw.length);
            tokens.push(r);
            continue;
          }
          break;
        case 62: // '>'
          if ((r = this.tokenizer.blockquote(e))) {
            e = e.substring(r.raw.length);
            tokens.push(r);
            continue;
          }
          break;
        case 45: // '-'
          if ((r = this.tokenizer.hr(e))) {
            e = e.substring(r.raw.length);
            tokens.push(r);
            continue;
          }
          if ((r = this.tokenizer.list(e))) {
            e = e.substring(r.raw.length);
            tokens.push(r);
            continue;
          }
          break;
        case 43: // '+'
          if ((r = this.tokenizer.list(e))) {
            e = e.substring(r.raw.length);
            tokens.push(r);
            continue;
          }
          break;
        case 42: // '*'
          if ((r = this.tokenizer.hr(e))) {
            e = e.substring(r.raw.length);
            tokens.push(r);
            continue;
          }
          if ((r = this.tokenizer.list(e))) {
            e = e.substring(r.raw.length);
            tokens.push(r);
            continue;
          }
          break;
        case 95: // '_'
          if ((r = this.tokenizer.hr(e))) {
            e = e.substring(r.raw.length);
            tokens.push(r);
            continue;
          }
          break;
        case 60: // '<'
          if ((r = this.tokenizer.html(e))) {
            e = e.substring(r.raw.length);
            tokens.push(r);
            continue;
          }
          break;
        case 91: // '['
          if ((r = this.tokenizer.def(e))) {
            e = e.substring(r.raw.length);
            const prev = tokens.at(-1);
            if (prev?.type === 'paragraph' || prev?.type === 'text') {
              prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
              prev.text += '\n' + r.raw;
              this.inlineQueue.at(-1).src = prev.text;
            } else {
              this.tokens.links[r.tag] ||
                (this.tokens.links[r.tag] = { href: r.href, title: r.title });
              tokens.push(r);
            }
            continue;
          }
          break;
        default:
          if (c >= 48 && c <= 57) {
            // digit: an ordered list may start here
            if ((r = this.tokenizer.list(e))) {
              e = e.substring(r.raw.length);
              tokens.push(r);
              continue;
            }
          }
          break;
      }
      // Table: only when the second line looks like a delimiter row.
      if (hasDelimiterRow(e) && (r = this.tokenizer.table(e))) {
        e = e.substring(r.raw.length);
        tokens.push(r);
        continue;
      }
      // Setext heading: only when an underline line exists before the blank line.
      if (hasSetextUnderline(e) && (r = this.tokenizer.lheading(e))) {
        e = e.substring(r.raw.length);
        tokens.push(r);
        continue;
      }
      // Paragraph (top level only): the manual line scanner.
      if (this.state.top) {
        const raw = scanParagraph(e);
        if (raw !== null) {
          const tok = { type: 'paragraph', raw, text: raw, tokens: this.inline(raw) };
          const prev = tokens.at(-1);
          if (n && prev?.type === 'paragraph') {
            prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
            prev.text += '\n' + tok.text;
            this.inlineQueue.pop();
            this.inlineQueue.at(-1).src = prev.text;
          } else {
            tokens.push(tok);
          }
          n = false;
          e = e.substring(raw.length);
          continue;
        }
      }
      // Plain text (reached when not at the top level, or the paragraph missed).
      if ((r = this.tokenizer.text(e))) {
        e = e.substring(r.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
          prev.text += '\n' + r.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(r);
        }
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    this.state.top = true;
    return tokens;
  }


  /**
   * The emphasis mask: the source with link references, code spans and
   * emphasis runs replaced by inert placeholders, so the emphasis closers
   * inside them are not found. This is marked's own masking, re-implemented
   * because its original is a private method.
   */
  maskSrc(src) {
    let t = src;
    const links = this.tokens.links;
    if (links && src.includes('[')) {
      const search = this.tokenizer.rules.inline.reflinkSearch;
      const replace = (m) => {
        const o = m.lastIndexOf('[');
        if (!Object.hasOwn(links, normalizeLabel(m.slice(o + 1, -1)))) return m;
        if (o > 1 && m.charAt(0) !== '!') {
          const inner = m.slice(1, o - 1);
          if (this.linkInText(inner)) {
            return '[' + inner.replace(search, replace) + '][' + 'a'.repeat(m.length - o - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(m.length - 2) + ']';
      };
      t = t.replace(search, replace);
    }
    const rules = this.tokenizer.rules.inline;
    t = t.replace(rules.anyPunctuationOutsideCode, (m, s, r) =>
      r ? '+'.repeat(m.length) : s ? s + m.slice(s.length, -s.length).replace(/`/g, '+') + s : m);
    t = t.replace(rules.blockSkip, (m, s, r) => {
      const o = r ? r.length : 0;
      return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
    });
    return t;
  }

  inlineTokens(src, tokens = []) {
    this.tokenizer.lexer = this;
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      // The emphasis mask is computed lazily inside the loop, on the first
      // emStrong/del attempt: paragraphs whose delimiters never reach the
      // emphasis rule (code spans, plain text) never pay for it. The mask
      // depends only on src and the link definitions, so lazy is identical.
      return this.inlineLoop(src, tokens);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  /**
   * marked's inline loop, dispatched on the first character: a backslash only
   * tries escape and br, a '<' only tag and autolink, '[' only link and
   * reflink, '*'/'_' only emStrong, a backtick only codespan, '~' only del,
   * a space only br, and a word only the url rule (when it can match) before
   * the text rule. Every other character goes straight to the text rule.
   * The order of attempts is the original one, so the tokens are identical.
   */
  inlineLoop(src, tokens) {
    let e = src;
    let s = false;
    let r = '';
    let smallest = Infinity;
    let masked = null;
    for (; e;) {
      if (e.length < smallest) {
        smallest = e.length;
      } else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      if (!s) r = '';
      s = false;
      const c = e.charCodeAt(0);
      let tok;
      switch (c) {
        case 92: // backslash
          if ((tok = this.tokenizer.escape(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
          if ((tok = this.tokenizer.br(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
          break;
        case 60: // '<'
          if ((tok = this.tokenizer.tag(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
          if ((tok = this.tokenizer.autolink(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
          break;
        case 91: // '['
          if ((tok = this.tokenizer.link(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
          if ((tok = this.tokenizer.reflink(e, this.tokens.links))) {
            e = e.substring(tok.raw.length);
            const prev = tokens.at(-1);
            if (tok.type === 'text' && prev?.type === 'text') {
              prev.raw += tok.raw;
              prev.text += tok.text;
            } else {
              tokens.push(tok);
            }
            continue;
          }
          break;
        case 33: // '!'
          if (e.charCodeAt(1) === 91) {
            if ((tok = this.tokenizer.link(e))) {
              e = e.substring(tok.raw.length);
              tokens.push(tok);
              continue;
            }
            if ((tok = this.tokenizer.reflink(e, this.tokens.links))) {
              e = e.substring(tok.raw.length);
              const prev = tokens.at(-1);
              if (tok.type === 'text' && prev?.type === 'text') {
                prev.raw += tok.raw;
                prev.text += tok.text;
              } else {
                tokens.push(tok);
              }
              continue;
            }
          }
          break;
        case 42: // '*'
        case 95: // '_'
          if (masked === null) masked = this.maskSrc(src);
          if ((tok = this.tokenizer.emStrong(e, masked, r))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
          break;
        case 96: // '`'
          if ((tok = this.tokenizer.codespan(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
          break;
        case 126: // '~'
          if (masked === null) masked = this.maskSrc(src);
          if ((tok = this.tokenizer.del(e, masked, r))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
          break;
        case 32: // space
          if ((tok = this.tokenizer.br(e))) {
            e = e.substring(tok.raw.length);
            tokens.push(tok);
            continue;
          }
          break;
        default:
          if (!this.state.inLink && isEmailChar(c) && urlMayMatch(e)) {
            if ((tok = this.tokenizer.url(e))) {
              e = e.substring(tok.raw.length);
              tokens.push(tok);
              continue;
            }
          }
          break;
      }
      if ((tok = this.tokenizer.inlineText(e))) {
        e = e.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') r = tok.raw.slice(-1);
        s = true;
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return tokens;
  }
}

/** One shared parser: parse() holds no per-call state, so it is safe to reuse. */
const sharedParser = new Parser(DEF);

/**
 * Render `markdown` to HTML, byte-for-byte identical to marked 18.1.3's
 * marked.parse(markdown) with marked's default options.
 */
export function parse(markdown) {
  return sharedParser.parse(new FastLexer(DEF).lex(markdown));
}
