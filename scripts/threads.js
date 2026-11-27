// `node scripts/threads.js <task>`: the news of invert.kz in the Threads profile of Invert (INV-398).
//
// Every article of news/ that came out after the start (THREADS_SINCE) goes to Threads as one post:
// its title, its summary, a line that invites into the app, and a card that links to the article
// on invert.kz. One post per run; .github/workflows/threads.yml runs it at 09:00, 13:00 and 19:00
// Almaty, so the day's articles go out one by one. Nothing is stored here: what is already out is
// read from Threads itself, by the link of each post.
//
// Tasks:
//   preview  what `post` would do now. Never writes; without a token it shows the next text only.
//   post     `sync`, then publish the oldest article of today or yesterday that is not out yet.
//   sync     remove the post of an article whose file was deleted, or whose title or summary
//            changed; the corrected text goes out in the next slot while the article is of today
//            or yesterday.
//   refresh  extend the token for another 60 days. A token that comes back changed is written into
//            the secret when GH_SECRETS_TOKEN is given; otherwise the run fails and says so.
//   whoami   whose token it is, what it may do, when it runs out.
//
// Writes only with THREADS_MODE=live; with any other value it prints what it would do.
// Needs nothing installed (Node 20+).
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { parseArticle } from '../lib/newsText.js';

const API = process.env.THREADS_API_URL || 'https://graph.threads.com'; // another value only in tests
const SITE = process.env.NEWS_SITE_URL || 'https://invert.kz'; // the same
const LINK_QUERY = 'utm_source=threads&utm_medium=social&utm_campaign=news';
// The founder's words of 27.11.2026, «больше новостей читайте в Invert». `source` is what the
// redirect counts and hands to the stores; the founder's own Threads is `aldiyar_threads`.
const INVITE = 'Больше новостей для водителей Казахстана в приложении Invert: invert.kz/download?source=threads_news';
const MARK = 'source=threads_news'; // what tells a post of this script from the profile's other posts
const ALMATY = 5 * 3600_000; // Kazakhstan keeps UTC+5 all year
const DAY = 86_400_000;
const PER_DAY = 3; // the daily run publishes three articles at most
const MAX_REMOVALS = 3; // a run that wants to remove more is mistaken about something
const MIN_ARTICLES = 50; // fewer files in news/ means a broken checkout, not taken-down articles
const LOOK_BACK = 30; // days of the profile read back
const SETTLE = 2 * 3600_000; // a post younger than this is never taken for a corrected one
const WARN_BEFORE = 10 * DAY; // a token this close to its end turns the run red

const env = process.env;
const task = process.argv[2] || 'preview';
const live = env.THREADS_MODE === 'live' && task !== 'preview';
const token = (env.THREADS_TOKEN || '').trim();
const profile = (env.THREADS_USERNAME || 'invert.app').trim().replace(/^@/, '');
const topicTag = (env.THREADS_TOPIC || 'Авто').trim();
const since = (env.THREADS_SINCE || '').trim();

const say = (line = '') => console.log(line);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const indent = (text) => text.split('\n').map((line) => `    ${line}`).join('\n');
/** The calendar day in Almaty of a moment. */
const almatyDay = (ms = Date.now()) => new Date(ms + ALMATY).toISOString().slice(0, 10);
/** Threads writes `+0000`, which not every reader of dates takes. */
const timeOf = (stamp) => Date.parse(String(stamp || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
/** Text compared as a reader sees it: case, spaces and line breaks aside. */
const plain = (text) => String(text || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const days = (ms) => Math.floor(ms / DAY);

// ---------------------------------------------------------------- the articles and their posts

/** The articles of news/ the site shows: a file the site cannot read is not an article there either. */
export function readArticles(folder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'news')) {
  const list = [];
  for (const name of fs.readdirSync(folder).sort()) {
    if (!name.endsWith('.md')) continue;
    try {
      list.push(parseArticle(name, fs.readFileSync(path.join(folder, name), 'utf8')));
    } catch {
      // check-news.js reports it; here it is simply not news
    }
  }
  return list;
}

export const articleLink = (slug) => `${SITE}/news/${slug}?${LINK_QUERY}`;

/** The text of the post of an article. Throws when Threads would refuse it or the founder's rules would. */
export function postText(article) {
  const text = `${article.title}\n\n${article.summary}\n\n${INVITE}`;
  if (/[\u2014\u2013]/.test(text)) throw new Error(`${article.slug}: a long dash in the text`);
  // Threads counts characters, an emoji by its UTF-8 bytes; there are none here. A title is at most
  // 100 characters and a summary 200 (lib/newsText.js), so the limit of 500 is never near.
  const length = [...text].length;
  if (length > 500) throw new Error(`${article.slug}: ${length} characters, Threads takes 500`);
  return text;
}

/** The article a post links to, by the path of its card: invert.kz/news/<slug>. */
function slugOfLink(link) {
  try {
    const url = new URL(link);
    const named = /^\/news\/(\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(url.pathname);
    if (named && /(^|\.)invert\.kz$/.test(url.hostname)) return named[1];
  } catch {
    // not an address
  }
  return null;
}

/**
 * The posts of this script among the profile's: those with the invitation line or a card leading to
 * an article. Each gets the slug of its article (by its card, or by the title its text starts with
 * when the card says nothing), or null when neither tells.
 */
export function ownPosts(threads, articles) {
  const own = [];
  for (const post of threads) {
    const bySlug = slugOfLink(post.link_attachment_url);
    if (!bySlug && !String(post.text || '').includes(MARK)) continue;
    const text = plain(post.text);
    const byTitle = articles.find((article) => text.startsWith(plain(article.title)));
    own.push({ ...post, slug: bySlug || byTitle?.slug || null, time: timeOf(post.timestamp) });
  }
  return own;
}

/** Posts to take down: the article is gone from news/, or its title or summary is not what the post says. */
export function removals(own, articles, now = Date.now()) {
  const bySlug = new Map(articles.map((article) => [article.slug, article]));
  const out = [];
  for (const post of own) {
    if (!post.slug) continue; // cannot tell which article it was: left alone
    const article = bySlug.get(post.slug);
    if (!article) {
      out.push({ post, why: 'статьи больше нет в news/' });
      continue;
    }
    const text = plain(post.text);
    if (text.includes(plain(article.title)) && text.includes(plain(article.summary))) continue;
    if (now - post.time < SETTLE) {
      say(`  внимание: текст поста ${post.id} не совпадает со статьёй ${post.slug}, но посту меньше двух часов: оставлен`);
      continue;
    }
    out.push({ post, why: 'у статьи изменились заголовок или подводка' });
  }
  return out;
}

/** The articles that may go out now, oldest first: of today or yesterday, not before the start, not out yet. */
export function waiting(articles, own, start, now = Date.now()) {
  const today = almatyDay(now);
  const yesterday = almatyDay(now - DAY);
  const out = new Set(own.map((post) => post.slug).filter(Boolean));
  return articles
    .filter((article) => article.date >= start && article.date >= yesterday && article.date <= today && !out.has(article.slug))
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

// ---------------------------------------------------------------- Threads

async function call(method, route, params = {}) {
  const url = new URL(route.startsWith('http') ? route : `${API}/v1.0${route}`);
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, access_token: token })) {
    if (value === undefined || value === null) continue;
    (method === 'POST' ? body : url.searchParams).set(key, String(value));
  }
  // Reads are repeated after a failure of the network or of Meta; writes never are: a repeated
  // publication could be a second post. The next run sees what a lost answer did.
  for (let attempt = 0; ; attempt += 1) {
    let response;
    let data = {};
    try {
      response = await fetch(url, method === 'POST' ? { method, body } : { method });
      data = await response.json().catch(() => ({}));
    } catch (error) {
      if (method === 'GET' && attempt < 2) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw new Error(`${method} ${route}: ${error.message}`);
    }
    if (response.ok && !data.error) return data;
    if (method === 'GET' && response.status >= 500 && attempt < 2) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    const e = data.error || {};
    throw new Error(`${method} ${route}: HTTP ${response.status} ${e.message || e.error_user_msg || ''} (code ${e.code ?? '-'}, subcode ${e.error_subcode ?? '-'}, trace ${e.fbtrace_id ?? '-'})`.replace(/\s+/g, ' '));
  }
}

/** The profile of the token; refuses anything but the profile this repository posts to. */
async function whose() {
  const me = await call('GET', '/me', { fields: 'id,username' });
  if (me.username !== profile) throw new Error(`ключ от @${me.username}, а публикуем в @${profile}: ничего не делаю`);
  return me;
}

async function tokenInfo() {
  const { data } = await call('GET', '/debug_token', { input_token: token });
  return data || {};
}

async function profileThreads(userId) {
  const found = [];
  let after;
  for (let page = 0; page < 10; page += 1) {
    const answer = await call('GET', `/${userId}/threads`, {
      fields: 'id,text,link_attachment_url,timestamp,permalink',
      since: almatyDay(Date.now() - LOOK_BACK * DAY),
      limit: 100,
      after,
    });
    found.push(...(answer.data || []));
    after = answer.paging?.cursors?.after;
    if (!answer.paging?.next || !after) break;
  }
  return found;
}

async function onSite(slug) {
  try {
    const response = await fetch(`${SITE}/news-data/${slug}.json`, { headers: { accept: 'application/json' } });
    return response.status;
  } catch (error) {
    return error.message;
  }
}

async function publish(userId, article) {
  const text = postText(article);
  const link = articleLink(article.slug);
  if (!live) {
    say(`  пробный режим, вышел бы пост (${[...text].length} знаков, тема «${topicTag}»):\n${indent(text)}\n    [карточка: ${link}]`);
    return;
  }
  const container = await call('POST', `/${userId}/threads`, { media_type: 'TEXT', text, link_attachment: link, topic_tag: topicTag });
  // A text needs no processing, but Meta asks to wait until the container is ready all the same.
  let status = '';
  for (let attempt = 0; attempt < 10 && status !== 'FINISHED'; attempt += 1) {
    if (attempt) await sleep(3000);
    const state = await call('GET', `/${container.id}`, { fields: 'status,error_message' });
    status = state.status;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`контейнер ${container.id}: ${status} ${state.error_message || ''}`);
  }
  if (status !== 'FINISHED') throw new Error(`контейнер ${container.id} не готов за 30 секунд (${status}); следующий запуск попробует снова`);
  const post = await call('POST', `/${userId}/threads_publish`, { creation_id: container.id });
  const { permalink } = await call('GET', `/${post.id}`, { fields: 'permalink' });
  say(`  опубликовано: ${permalink || post.id}`);
}

async function takeDown(found) {
  for (const { post, why } of found) {
    if (!live) {
      say(`  пробный режим, снял бы пост ${post.permalink || post.id} (${post.slug}): ${why}`);
      continue;
    }
    await call('DELETE', `/${post.id}`);
    say(`  снят пост ${post.permalink || post.id} (${post.slug}): ${why}`);
  }
}

/** A token near its end turns the run red, so the failure mail comes while there is time to renew. */
async function expiryCheck() {
  const info = await tokenInfo();
  const now = Date.now();
  const ends = [info.expires_at, info.data_access_expires_at].filter(Boolean).map((s) => s * 1000);
  const first = ends.length ? Math.min(...ends) : 0;
  if (first && first - now < WARN_BEFORE) {
    console.error(`::error::ключ Threads кончается через ${days(first - now)} дн. (${new Date(first).toISOString().slice(0, 10)}): запусти refresh или выпусти новый ключ`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- tasks

async function sync({ andPost }) {
  const articles = readArticles();
  say(`режим: ${live ? 'боевой' : 'пробный'}; статей в news/: ${articles.length}; публикуем в @${profile} с ${since || '(дата старта не задана)'}`);
  if (!token) {
    if (live) throw new Error('нет секрета THREADS_TOKEN');
    say('ключа нет: что уже вышло в Threads, не проверено');
    const next = waiting(articles, [], since || almatyDay(Date.now() - DAY));
    if (!next.length) say('за сегодня и вчера публиковать нечего');
    else await publish(null, next[0]);
    return;
  }
  const me = await whose();
  const own = ownPosts(await profileThreads(me.id), articles);
  say(`наших постов за ${LOOK_BACK} дн.: ${own.length}`);

  let gone = removals(own, articles);
  if (gone.length && articles.length < MIN_ARTICLES) {
    say(`  внимание: в news/ всего ${articles.length} статей, это похоже на сломанную выгрузку; ничего не снимаю`);
    gone = [];
  }
  if (gone.length > MAX_REMOVALS) {
    say(`  внимание: снять просятся ${gone.length} постов, за запуск снимаю не больше ${MAX_REMOVALS}`);
    gone = gone.slice(0, MAX_REMOVALS);
  }
  await takeDown(gone);

  if (andPost) {
    let start = since;
    if (!start && task !== 'preview') throw new Error('не задана переменная THREADS_SINCE (день старта): без неё не публикую, чтобы не выложить архив');
    if (!start) {
      start = almatyDay(Date.now() - DAY);
      say(`дня старта нет, для просмотра беру ${start}`);
    }
    const removed = new Set(gone.map(({ post }) => post.id));
    const left = own.filter((post) => !removed.has(post.id));
    const today = almatyDay();
    const todays = left.filter((post) => Number.isFinite(post.time) && almatyDay(post.time) === today).length;
    if (todays >= PER_DAY) {
      say(`сегодня уже ${todays} поста: больше не публикую`);
    } else {
      let done = false;
      for (const article of waiting(articles, left, start)) {
        const status = await onSite(article.slug);
        if (status !== 200) {
          say(`  ${article.slug}: на invert.kz ещё нет (ответ ${status}), жду следующего запуска`);
          continue;
        }
        say(`публикую ${article.slug}`);
        await publish(me.id, article);
        done = true;
        break;
      }
      if (!done) say('публиковать нечего');
    }
  }
  await expiryCheck();
}

async function refresh() {
  if (!token && !live) {
    say('ключа ещё нет, продлевать нечего');
    return;
  }
  if (!token) throw new Error('нет секрета THREADS_TOKEN');
  const before = await tokenInfo();
  if (before.issued_at && Date.now() - before.issued_at * 1000 < DAY) {
    say('ключу меньше суток, Meta продлевает только после: в следующий раз');
    return;
  }
  const answer = await call('GET', `${API}/refresh_access_token`, { grant_type: 'th_refresh_token' });
  const fresh = String(answer.access_token || '');
  if (!fresh) throw new Error('Meta не вернула ключ');
  say(`ключ продлён на ${days((answer.expires_in || 0) * 1000)} дн.`);
  if (fresh === token) {
    say('ключ остался тем же, секрет не трогаю');
    return;
  }
  console.log(`::add-mask::${fresh}`);
  if (!env.GH_SECRETS_TOKEN || !env.GITHUB_REPOSITORY) {
    throw new Error('Meta выдала новый ключ, а записать его некуда: нужен секрет GH_SECRETS_TOKEN (ключ GitHub с правом Secrets: write на этот репозиторий)');
  }
  const written = spawnSync('gh', ['secret', 'set', 'THREADS_TOKEN', '--repo', env.GITHUB_REPOSITORY], {
    input: fresh,
    env: { ...process.env, GH_TOKEN: env.GH_SECRETS_TOKEN },
    encoding: 'utf8',
  });
  if (written.status !== 0) throw new Error(`не записал новый ключ в секрет: ${(written.stderr || '').trim()}`);
  say('новый ключ записан в секрет THREADS_TOKEN');
}

async function whoami() {
  if (!token) throw new Error('нет секрета THREADS_TOKEN');
  const me = await call('GET', '/me', { fields: 'id,username' });
  say(`профиль: @${me.username} (id ${me.id})${me.username === profile ? '' : `, а публикуем в @${profile}!`}`);
  const info = await tokenInfo();
  const date = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '-');
  say(`ключ: ${info.is_valid ? 'действует' : 'НЕ действует'}, выдан ${date(info.issued_at)}, до ${date(info.expires_at)}, доступ к данным до ${date(info.data_access_expires_at)}`);
  say(`права: ${(info.scopes || []).join(', ') || '-'}`);
  const limit = await call('GET', `/${me.id}/threads_publishing_limit`, { fields: 'quota_usage,config' });
  const quota = limit.data?.[0];
  if (quota) say(`публикаций за сутки: ${quota.quota_usage} из ${quota.config?.quota_total}`);
}

const tasks = {
  preview: () => sync({ andPost: true }),
  post: () => sync({ andPost: true }),
  sync: () => sync({ andPost: false }),
  refresh,
  whoami,
};

// Run as a script, not imported (a folder reached through a symlink, like /tmp on a Mac, still counts).
const real = (file) => fs.realpathSync(file);
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  if (!tasks[task]) {
    console.error(`задачи: ${Object.keys(tasks).join(', ')}`);
    process.exit(2);
  }
  try {
    await tasks[task]();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
