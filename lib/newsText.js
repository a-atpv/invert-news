// The format of a news file of invert.kz, and its reading. The site reads the files of
// news/ with its own copy of this code; this copy is here for scripts/check-news.js.
//
// A piece of news is a file, news/YYYY-MM-DD-words-in-latin.md: a few «key: value» lines
// between two «---» lines, then the text. The text knows paragraphs, «## » headings, «- » and
// «1. » lists, **bold** and [links](https://…) — and nothing else. A link leads to a page of
// the site or, by https, to one of the sites listed below.

/** The sections of the news: the word of a file's `topic:` line → what the page calls it. */
export const NEWS_TOPICS = {
  pravila: 'Законы и штрафы',
  rynok: 'Рынок и цены',
  tehnika: 'Техника и уход',
  invert: 'Новости Invert',
};

const FILE_NAME = /^(\d{4})-(\d{2})-(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const FIELDS = ['title', 'summary', 'topic', 'source', 'source_url'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «2026-10-11» → «11 октября 2026». Read as text: a day of the calendar has no time zone to shift it. */
export function newsDateLabel(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** The sites an article may name as its source and link to. */
export const NEWS_LINK_HOSTS = [
  'kolesa.kz', 'tengrinews.kz', 'kursiv.media', 'bizmedia.kz', 'zakon.kz', 'inbusiness.kz', 'digitalbusiness.kz', 'dknews.kz',
  'polisia.kz', 'primeminister.kz', 'eaeunion.org', 'gov.kz', 'zan.kz', 'egov.kz', 'akorda.kz',
];
const knownHost = (hostname) => NEWS_LINK_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));

/** An address a link of an article may lead to: one of the known sites by https, or a page of ours by its path. */
function linkTarget(raw) {
  const value = String(raw).trim();
  if (/^\/(?![/\\])/.test(value)) return value;
  if (!/^https:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return knownHost(url.hostname.toLowerCase()) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** A line of text as pieces: plain, **bold** and [linked](address). */
function inlineOf(line, problems) {
  const pieces = [];
  const plain = (text) => {
    if (!text) return;
    // What is left of markup this format does not know would be shown to the reader as it stands.
    if (/\*|`|<\/?[a-z][^>]*>|\]\(|!\[/i.test(text)) problems.push(`unsupported markup in «${text.trim().slice(0, 60)}» — only **bold** and [text](https://address) are read`);
    pieces.push({ text });
  };
  const marked = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let from = 0;
  for (let found = marked.exec(line); found; found = marked.exec(line)) {
    plain(line.slice(from, found.index));
    from = found.index + found[0].length;
    if (found[1] !== undefined) {
      pieces.push({ text: found[1], bold: true });
      continue;
    }
    const href = linkTarget(found[3]);
    if (href) pieces.push({ text: found[2], href });
    else {
      problems.push(`a link must lead to a path of the site or, by https, to one of the known sources (NEWS_LINK_HOSTS): «${found[3].slice(0, 80)}»`);
      pieces.push({ text: found[2] });
    }
  }
  plain(line.slice(from));
  return pieces;
}

/** The text of an article as blocks: paragraphs, headings and lists. A blank line ends a block. */
function blocksOf(body, problems) {
  const blocks = [];
  let open = null;
  const close = () => {
    if (open?.type === 'p') blocks.push({ type: 'p', inline: inlineOf(open.lines.join(' '), problems) });
    else if (open) blocks.push({ type: open.type, items: open.lines.map((line) => inlineOf(line, problems)) });
    open = null;
  };
  const add = (type, line) => {
    if (open?.type !== type) close();
    open ??= { type, lines: [] };
    open.lines.push(line);
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) close();
    else if (/^## +\S/.test(line)) {
      close();
      blocks.push({ type: 'h', inline: inlineOf(line.replace(/^## +/, ''), problems) });
    } else if (/^- +\S/.test(line)) add('ul', line.replace(/^- +/, ''));
    else if (/^\d+[.)] +\S/.test(line)) add('ol', line.replace(/^\d+[.)] +/, ''));
    else {
      if (/^(#|>|\||```|---)/.test(line)) problems.push(`unsupported markup at the start of «${line.slice(0, 60)}» — the text knows «## » headings and «- » / «1. » lists`);
      add('p', line);
    }
  }
  close();
  return blocks;
}

/** What a reader reads of the blocks, as one string: for counting and for the checks. */
export function newsPlainText(blocks) {
  const line = (inline) => inline.map((piece) => piece.text).join('');
  return blocks.map((block) => (block.items ? block.items.map(line).join('\n') : line(block.inline))).join('\n');
}

/** «"Название"» → «Название»: a value somebody wrapped in quotes the way YAML allows. */
function unquoted(value) {
  const wrapped = /^"(.*)"$/.exec(value) || /^'(.*)'$/.exec(value);
  return wrapped ? wrapped[1].trim() : value;
}

/**
 * A file as an article — or an Error whose message lists everything that is wrong with it.
 * A file with anything wrong is not an article, and the site does not show it.
 */
export function parseArticle(fileName, source) {
  const named = FILE_NAME.exec(fileName);
  if (!named) throw new Error('the name must be YYYY-MM-DD-words-in-latin.md (small Latin letters, digits and hyphens)');
  const [year, month, day] = named.slice(1).map(Number);
  const problems = [];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) problems.push('the date in the name is not a day of the calendar');
  if (fileName.length > 90) problems.push('the name is longer than 90 characters');

  const text = String(source).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const parts = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(text);
  if (!parts) throw new Error('the file must start with «key: value» lines between two «---» lines');

  const fields = {};
  for (const line of parts[1].split('\n')) {
    if (!line.trim()) continue;
    const pair = /^([a-z_]+):(.*)$/.exec(line);
    if (!pair || !FIELDS.includes(pair[1])) problems.push(`cannot read the line «${line.slice(0, 60)}» — the fields are ${FIELDS.join(', ')}`);
    else if (pair[1] in fields) problems.push(`«${pair[1]}» is given twice`);
    else fields[pair[1]] = unquoted(pair[2].trim());
  }
  const { title = '', summary = '', topic = '', source: sourceName = '', source_url: sourceAddress = '' } = fields;

  if (title.length < 15 || title.length > 100) problems.push(`title: ${title.length} characters, 15–100 are expected`);
  if (/[.!]$/.test(title)) problems.push('title: no full stop or exclamation mark at the end');
  if (summary.length < 50 || summary.length > 200) problems.push(`summary: ${summary.length} characters, 50–200 are expected`);
  if (!Object.hasOwn(NEWS_TOPICS, topic)) problems.push(`topic: «${topic}» is not one of ${Object.keys(NEWS_TOPICS).join(', ')}`);
  // News of our own has no source; anything else is somebody's report, and says whose.
  const sourceUrl = sourceAddress ? linkTarget(sourceAddress) : null;
  if (topic !== 'invert' && (!sourceName || !sourceAddress)) problems.push('source and source_url: both are owed by anything but news of Invert itself');
  else if (!sourceName !== !sourceAddress) problems.push('source and source_url come together');
  if (sourceName.length > 60) problems.push('source: the name of the source, not a sentence (60 characters at most)');
  if (sourceAddress && (!sourceUrl || sourceUrl.startsWith('/'))) problems.push('source_url: an https address of one of the known sources (NEWS_LINK_HOSTS) is expected');

  const blocks = blocksOf(parts[2] || '', problems);
  const length = newsPlainText(blocks).length;
  if (length < 500 || length > 4000) problems.push(`the text: ${length} characters, 500–4000 are expected`);
  if (blocks.filter((block) => block.type === 'p').length < 2) problems.push('the text: at least two paragraphs');

  if (problems.length) throw new Error(problems.join('; '));
  return {
    slug: fileName.slice(0, -'.md'.length),
    date: fileName.slice(0, 10),
    title,
    summary,
    topic,
    source: sourceName || null,
    sourceUrl,
    blocks,
  };
}

/** What a card of the list shows of an article — the article without its text. */
export function newsCard({ slug, date, title, summary, topic }) {
  return { slug, date, title, summary, topic };
}
