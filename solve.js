// sitegen-fast: a fast drop-in replacement for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build
// returns for the same input: every page's index.html, the index and tag
// pages, build-report.txt and each static file, byte for byte. The rules it
// implements are makefun-site's own (front matter, template dialect,
// Markdown subset, slug rule, report), as stated in its README; where the
// README and its code differ, the code's answer is the answer, so this file
// follows the code's behaviour in every corner it could reach.
//
// Speed comes from doing the same work with less of it, not from different
// answers:
//   - Markdown is lexed and rendered in one fused pass, with no token
//     objects, no per-character escaping (plain runs are escaped whole),
//     and first-character dispatch instead of a regex test per line.
//   - Slugs are memoised per build: titles, tag names and heading texts
//     repeat constantly, and ASCII-only text skips Unicode normalisation.
//   - Templates are compiled once per build into small JavaScript
//     functions (new Function over the parsed node tree; literal text is
//     embedded with JSON.stringify), so rendering a page is a few direct
//     property reads and string appends instead of a tree walk with a scope
//     chain. A small tree-walking interpreter covers any template the
//     compiler cannot take, so the answer never depends on codegen.
//   - Everything is deterministic: no clock, no environment, no randomness,
//     no state carried from one case to the next (the slug memo lives and
//     dies inside one run call).

// ------------------------------------------------------------------ text

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped, and nothing else. */
export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when
 * nothing is left. `cache` memoises it for one build; an all-ASCII input
 * needs no normalisation (NFKD is the identity there, and no ASCII
 * character is a combining mark), so it takes the short path.
 */
export function slugify(text, cache) {
  if (cache !== undefined) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
  }
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  if (cache !== undefined) cache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace.
 * A manual scan, matching /\S/ exactly: the whitespace characters are
 * TAB, LF, VT, FF, CR, space, NBSP, U+1680, U+2000-U+200A, U+2028, U+2029,
 * U+202F, U+205F, U+3000 and U+FEFF, and nothing else. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 32 && c < 160) {
      // An ordinary visible character: never whitespace (the first
      // whitespace character above 32 is NBSP at 160).
      if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (
      c === 32 ||
      (c >= 9 && c <= 13) ||
      c === 160 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff
    ) {
      inWord = false;
    } else if (!inWord) {
      // Any other character (a control character, a non-BMP half) is a word character.
      inWord = true;
      n++;
    }
  }
  return n;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------ front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else {
        out += c;
      }
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
export function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // The closing line is a line exactly "---" after the first.
  let p = text.indexOf('\n---', 3);
  let closeEnd = -1;
  while (p !== -1) {
    const q = p + 4;
    if (q === text.length || text[q] === '\n') { closeEnd = q; break; }
    p = text.indexOf('\n---', q);
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, p);
  const fmLines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    if (isBlank(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ------------------------------------------------------------ line helpers

/** A line of spaces and tabs only (or empty). */
function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is a thematic break: `---` or `***`, spaces/tabs after. */
function isHr(line) {
  let e = line.length;
  while (e > 0 && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e !== 3) return false;
  const s = line.slice(0, 3);
  return s === '---' || s === '***';
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6 || n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

// ----------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. A run of backslashes before the match escapes it exactly
 * when the run (counted from `from`) is odd: the scan consumes backslash
 * pairs left to right, so an even run pairs off and leaves the match bare.
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let b = 0;
    for (let k = j - 1; k >= from && s[k] === '\\'; k--) b++;
    if (b % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let b = 0;
    for (let k = j - 1; k >= from && s[k] === '\\'; k--) b++;
    if (b % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline, appended to `parts`; `env.link(target)` is a link's
 * href. One native scan finds the next character that needs attention — a
 * backslash, a backtick, a star, a bracket, or one of the five characters
 * the escape table names — so plain runs are copied raw, never scanned a
 * second time for escaping.
 */
function inlineInto(s, env, parts) {
  const re = /[\\`*\[&<>"']/g;
  let i = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    if (j > i) parts.push(s.slice(i, j));
    const c = s[j];
    if (c === '&') {
      parts.push('&amp;');
      i = j + 1;
    } else if (c === '<') {
      parts.push('&lt;');
      i = j + 1;
    } else if (c === '>') {
      parts.push('&gt;');
      i = j + 1;
    } else if (c === '"') {
      parts.push('&quot;');
      i = j + 1;
    } else if (c === "'") {
      parts.push('&#39;');
      i = j + 1;
    } else if (c === '\\') {
      const nx = s[j + 1];
      if (nx !== undefined && ESCAPABLE.has(nx)) {
        parts.push(nx === '>' ? '&gt;' : nx);
        i = j + 2;
      } else {
        parts.push('\\');
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        parts.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        parts.push('`');
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          parts.push('<strong>');
          inlineInto(s.slice(j + 2, k), env, parts);
          parts.push('</strong>');
          i = k + 2;
        } else {
          parts.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          parts.push('<em>');
          inlineInto(s.slice(j + 1, k), env, parts);
          parts.push('</em>');
          i = k + 1;
        } else {
          parts.push('*');
          i = j + 1;
        }
      }
    } else {
      // '[': [text](target), the first unescaped ']' closing the text.
      const k = findUnescaped(s, ']', j + 1);
      const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        parts.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s.slice(j + 1, k), env, parts);
        parts.push('</a>');
        i = m2 + 1;
      } else {
        parts.push('[');
        i = j + 1;
      }
    }
    re.lastIndex = i;
  }
  if (i < s.length) parts.push(s.slice(i));
}

/** `s` rendered inline. */
function inlineStr(s, env) {
  const parts = [];
  inlineInto(s, env, parts);
  return parts.join('');
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/**
 * `src` rendered in one fused pass: its HTML (each block on its own lines,
 * a "\n" after the last), its table of contents (every level 2 and 3
 * heading) and its excerpt (the first paragraph's inline HTML, or "").
 * `ids` is the page's set of heading ids; `slugCache` memoises slugs.
 */
function renderBody(src, env, ids, slugCache) {
  const lines = src.split('\n');
  const n = lines.length;
  let html = '';
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        const code = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
        html += `<pre><code${fence[1] === '' ? '' : ` class="language-${fence[1]}"`}>${code}</code></pre>\n`;
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text, slugCache), ids);
        const hHtml = inlineStr(h.text, env);
        html += `<h${h.depth} id="${id}">${hHtml}</h${h.depth}>\n`;
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: hHtml });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        html += '<hr>\n';
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      html +=
        kept.length === 0
          ? '<blockquote>\n</blockquote>\n'
          : `<blockquote>\n<p>${inlineStr(kept.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const bullet = c0 >= 48 && c0 <= 57 ? null : BULLET.exec(line);
      const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED.exec(line) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const marker = isOrdered ? ORDERED : BULLET;
        const items = [];
        while (i < n) {
          const mm = marker.exec(lines[i]);
          if (mm !== null) {
            items.push(trimLine(isOrdered ? mm[2] : mm[1]));
            i++;
          } else if (CONTINUED.test(lines[i])) {
            items[items.length - 1] += `\n${trimLine(lines[i])}`;
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
        let list = `${open}\n`;
        for (const item of items) list += `<li>${inlineStr(item, env)}</li>\n`;
        html += `${list}</${tag}>\n`;
        continue;
      }
    }
    // A paragraph: lines up to a blank line, a fence, a heading or a break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const pHtml = inlineStr(text, env);
    if (excerpt === null) excerpt = pHtml;
    html += `<p>${pHtml}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the flat scope: first name from the scope itself, then own properties. */
function lookupPath(C, scope, path) {
  let v = scope[path[0]];
  for (let k = 1; k < path.length; k++) v = C.gv(v, path[k]);
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** An own property of `v`, or undefined (a non-object, null, or a missing key). */
function gv(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/**
 * `nodes` rendered by the tree-walking interpreter, in the flat scope
 * (loop variables are set on it and restored after the loop). Used only
 * where a template could not be compiled; the compiled path is the fast one.
 */
function renderNodesSlow(nodes, C, scope, depth) {
  let s = '';
  for (const n of nodes) {
    if (n.kind === 'text') s += n.text;
    else if (n.kind === 'var') s += C.esc(C.txt(lookupPath(C, scope, n.path)));
    else if (n.kind === 'raw') s += C.txt(lookupPath(C, scope, n.path));
    else if (n.kind === 'if') {
      const branch = C.truthy(lookupPath(C, scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) s += renderNodesSlow(branch, C, scope, depth);
    } else if (n.kind === 'for') {
      const xs = lookupPath(C, scope, n.path);
      if (Array.isArray(xs)) {
        const sv = scope[n.name];
        const sl = scope.loop;
        const lp = { index: 0, first: false, last: false, length: xs.length };
        for (let k = 0; k < xs.length; k++) {
          lp.index = k + 1;
          lp.first = k === 0;
          lp.last = k === xs.length - 1;
          scope[n.name] = xs[k];
          scope.loop = lp;
          s += renderNodesSlow(n.body, C, scope, depth);
        }
        scope[n.name] = sv;
        scope.loop = sl;
      }
    } else if (n.kind === 'include') {
      s += C.inc(n.name, scope, depth);
    }
  }
  return s;
}

/** The code of a path read, as a JavaScript expression over `scope` and `gv`. */
function pathExpr(path) {
  let e = `scope[${JSON.stringify(path[0])}]`;
  for (let k = 1; k < path.length; k++) e = `gv(${e},${JSON.stringify(path[k])})`;
  return e;
}

/** The code of a node list, appended to `out` (an array of code lines). */
function genNodes(nodes, out, uid) {
  for (const n of nodes) {
    if (n.kind === 'text') out.push(`s+=${JSON.stringify(n.text)};`);
    else if (n.kind === 'var') out.push(`s+=esc(txt(${pathExpr(n.path)}));`);
    else if (n.kind === 'raw') out.push(`s+=txt(${pathExpr(n.path)});`);
    else if (n.kind === 'if') {
      out.push(`if(${n.not ? '!' : ''}truthy(${pathExpr(n.path)})){`);
      genNodes(n.then, out, uid);
      if (n.else !== null) {
        out.push('}else{');
        genNodes(n.else, out, uid);
      }
      out.push('}');
    } else if (n.kind === 'for') {
      const u = uid.next++;
      out.push(`{const __xs${u}=${pathExpr(n.path)};`);
      out.push(`if(Array.isArray(__xs${u})){`);
      out.push(`const __sv${u}=scope[${JSON.stringify(n.name)}];const __sl${u}=scope.loop;`);
      out.push(`const __lp${u}={index:0,first:false,last:false,length:__xs${u}.length};`);
      out.push(`for(let __k${u}=0;__k${u}<__xs${u}.length;__k${u}++){`);
      out.push(`__lp${u}.index=__k${u}+1;__lp${u}.first=__k${u}===0;__lp${u}.last=__k${u}===__xs${u}.length-1;`);
      out.push(`scope[${JSON.stringify(n.name)}]=__xs${u}[__k${u}];scope.loop=__lp${u};`);
      genNodes(n.body, out, uid);
      out.push('}');
      out.push(`scope[${JSON.stringify(n.name)}]=__sv${u};scope.loop=__sl${u};}}`);
    } else if (n.kind === 'include') {
      out.push(`s+=inc(${JSON.stringify(n.name)},scope,depth);`);
    }
  }
}

/**
 * A template's node tree compiled into a function
 * (esc, txt, truthy, gv, inc, scope, depth) -> its rendered text, or null
 * when it cannot be compiled (the interpreter then renders it). The helpers
 * arrive as parameters so the generated code reads them as locals, not as
 * properties of a context object. Literal text is embedded with
 * JSON.stringify; nothing from the template ever runs as code except the
 * paths the parser validated.
 */
function compileTemplate(nodes) {
  try {
    const out = ['let s="";'];
    genNodes(nodes, out, { next: 0 });
    out.push('return s;');
    return new Function('esc', 'txt', 'truthy', 'gv', 'inc', 'scope', 'depth', out.join('\n'));
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- build

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Compile every template that parses; the map holds the fast path.
  const compiled = new Map();
  for (const [name, nodes] of templates) {
    const fn = compileTemplate(nodes);
    if (fn !== null) compiled.set(name, fn);
  }
  // The render context: the parsed and compiled templates, and the include
  // hook (a missing template, or one nested more than 8 deep, renders
  // nothing). The interpreter path reads its helpers off C; the compiled
  // path takes them as function parameters.
  const C = { esc: escapeHtml, txt: textOf, truthy, gv, tmpl: templates, compiled };
  const inc = (name, scope, depth) => {
    if (depth >= INCLUDE_DEPTH) return '';
    const fn = compiled.get(name);
    if (fn !== undefined) return fn(escapeHtml, textOf, truthy, gv, inc, scope, depth + 1);
    const nodes = templates.get(name);
    if (nodes === undefined) return '';
    return renderNodesSlow(nodes, { ...C, inc }, scope, depth + 1);
  };
  C.inc = inc;
  const render = (name, scope) => {
    const fn = compiled.get(name);
    if (fn !== undefined) return fn(escapeHtml, textOf, truthy, gv, inc, scope, 0);
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodesSlow(nodes, C, scope, 0);
  };

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order; the first failing check is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each slug unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderBody(s.body, env, new Set(), slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // What templates read.
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const scopeFor = (vars) => Object.assign(Object.create(null), { site, tags: allTags, recent }, vars);
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, scopeFor({ page: pageOf(s) }));
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', scopeFor({
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    }));
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', scopeFor({ tag: tagOf(t) }));
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', scopeFor({}));
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
