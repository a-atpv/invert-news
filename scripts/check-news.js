// `node scripts/check-news.js` — reads news/ the way the site does and says what is wrong.
// Needs nothing installed. Run it before every push: a file the site cannot read as an
// article is simply not shown there, and nobody is told.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { parseArticle } from '../lib/newsText.js';

const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'news');
const articles = [];
const found = [];
for (const name of fs.readdirSync(folder).sort()) {
  if (name.startsWith('.')) continue;
  try {
    articles.push(parseArticle(name, fs.readFileSync(path.join(folder, name), 'utf8')));
  } catch (error) {
    found.push(`${name}: ${error.message}`);
  }
}

// One report, one article: the same source address twice is the same story told twice.
const bySource = new Map();
const byTitle = new Map();
for (const article of articles) {
  const address = (article.sourceUrl || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (address && bySource.has(address)) found.push(`${article.slug}.md: the same source_url as ${bySource.get(address)}.md`);
  else if (address) bySource.set(address, article.slug);
  const title = article.title.toLowerCase();
  if (byTitle.has(title)) found.push(`${article.slug}.md: the same title as ${byTitle.get(title)}.md`);
  else byTitle.set(title, article.slug);
}

// An article dated ahead is not shown until its day comes. Kazakhstan's calendar (UTC+5)
// runs ahead of UTC, hence the day of grace.
const tomorrow = new Date(Date.now() + 29 * 60 * 60_000).toISOString().slice(0, 10);
for (const article of articles) {
  if (article.date > tomorrow) found.push(`${article.slug}.md: dated in the future`);
}

for (const line of found) console.error(`news/${line}`);
console.log(found.length ? `\n${found.length} problem(s) in news/` : `news/: ${articles.length} article(s), all read`);
process.exit(found.length ? 1 : 0);
