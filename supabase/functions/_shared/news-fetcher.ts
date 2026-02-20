import { supabaseAdmin } from "./supabase.ts";
import type { NewsCategory, NewsItem, RSSFeedItem, RssSource } from "./types.ts";
import {
  decodeHtmlEntities,
  getTopicCategoryPriority,
  isNewsRelevantForCategory,
  selectBestNewsForTopic,
} from "./social-news-selection.ts";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_ITEMS_PER_SOURCE = 25;
const MAX_UNUSED_NEWS_LOOKUP = 40;
const MAX_FALLBACK_UNUSED_NEWS_LOOKUP = 80;

function extractSections(xmlText: string, tagName: string): string[] {
  const sections: string[] = [];
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xmlText)) !== null) {
    if (match[1]) {
      sections.push(match[1]);
    }
  }

  return sections;
}

function extractTag(xml: string, tagName: string): string | null {
  const regex = new RegExp(
    `<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>|<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "i",
  );

  const match = regex.exec(xml);
  return match ? (match[1] || match[2] || null) : null;
}

function extractAtomLink(xml: string): string | null {
  const match = /<link[^>]*href=(["'])(.*?)\1[^>]*\/?>(?:<\/link>)?/i.exec(xml);
  return match?.[2] || null;
}

function cleanText(text: string): string {
  const cleaned = text
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return decodeHtmlEntities(cleaned);
}

function toIsoDate(dateValue?: string): string | null {
  if (!dateValue) {
    return null;
  }

  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function parseRSSFeed(xmlText: string): RSSFeedItem[] {
  const items: RSSFeedItem[] = [];
  const rssItems = extractSections(xmlText, "item");
  const atomEntries = extractSections(xmlText, "entry");
  const sections = [...rssItems, ...atomEntries];

  for (const sectionXml of sections) {
    const title = extractTag(sectionXml, "title");
    const description =
      extractTag(sectionXml, "description") ||
      extractTag(sectionXml, "summary") ||
      extractTag(sectionXml, "content");
    const link = extractTag(sectionXml, "link") || extractAtomLink(sectionXml);
    const pubDate =
      extractTag(sectionXml, "pubDate") ||
      extractTag(sectionXml, "published") ||
      extractTag(sectionXml, "updated");

    if (title && link && /^https?:\/\//i.test(link.trim())) {
      items.push({
        title: cleanText(title),
        description: description ? cleanText(description) : undefined,
        link: link.trim(),
        pubDate: pubDate || undefined,
      });
    }
  }

  return items;
}

async function fetchFeed(source: RssSource): Promise<RSSFeedItem[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(source.feed_url, {
      headers: {
        "User-Agent": "facebook-autopost-supabase/1.0",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`Failed to fetch ${source.source_name}: ${response.status}`);
      return [];
    }

    const xmlText = await response.text();
    if (!/<item>|<entry>/i.test(xmlText)) {
      console.warn(`No RSS entries in ${source.source_name}`);
      return [];
    }

    return parseRSSFeed(xmlText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error fetching ${source.source_name}: ${message}`);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchActiveRssSources(): Promise<RssSource[]> {
  const { data, error } = await supabaseAdmin
    .from("rss_sources")
    .select("*")
    .eq("is_active", true)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error || !data) {
    console.error("Failed to fetch rss_sources", error?.message);
    return [];
  }

  return data as RssSource[];
}

export async function fetchAndStoreNews(): Promise<number> {
  let totalStored = 0;
  const sources = await fetchActiveRssSources();

  for (const source of sources) {
    const entries = await fetchFeed(source);

    for (const entry of entries.slice(0, MAX_ITEMS_PER_SOURCE)) {
      if (!isNewsRelevantForCategory({ title: entry.title, description: entry.description }, source.category)) {
        continue;
      }

      const payload = {
        title: entry.title,
        description: entry.description || null,
        url: entry.link,
        source: source.source_name,
        category: source.category,
        published_at: toIsoDate(entry.pubDate),
        used: false,
      };

      const { error } = await supabaseAdmin
        .from("news_cache")
        .upsert(payload, { onConflict: "url", ignoreDuplicates: true });

      if (!error) {
        totalStored += 1;
      }
    }
  }

  console.log(`Stored ${totalStored} news items`);
  return totalStored;
}

export async function listUnusedNews(
  category?: NewsCategory,
  limit = MAX_UNUSED_NEWS_LOOKUP,
): Promise<NewsItem[]> {
  let query = supabaseAdmin
    .from("news_cache")
    .select("*")
    .eq("used", false)
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("fetched_at", { ascending: false })
    .limit(limit);

  if (category) {
    query = query.eq("category", category);
  }

  const { data, error } = await query;
  if (error || !data) {
    return [];
  }

  return data as NewsItem[];
}

export async function getBestUnusedNewsForTopic(topicKey: string): Promise<NewsItem | null> {
  const checkedUrls = new Set<string>();

  for (const category of getTopicCategoryPriority(topicKey)) {
    const candidates = (await listUnusedNews(category, MAX_UNUSED_NEWS_LOOKUP)).filter((item) => {
      if (checkedUrls.has(item.url)) {
        return false;
      }
      checkedUrls.add(item.url);
      return true;
    });

    const best = selectBestNewsForTopic(candidates, topicKey) as NewsItem | null;
    if (best) {
      return best;
    }
  }

  const fallback = (await listUnusedNews(undefined, MAX_FALLBACK_UNUSED_NEWS_LOOKUP)).filter(
    (item) => !checkedUrls.has(item.url),
  );

  return selectBestNewsForTopic(fallback, topicKey) as NewsItem | null;
}

export async function markNewsAsUsed(newsId: string): Promise<void> {
  await supabaseAdmin
    .from("news_cache")
    .update({ used: true, used_at: new Date().toISOString() })
    .eq("id", newsId);
}
