import { supabaseAdmin } from "./supabase.ts";
import type { NewsItem, SpecialDay } from "./types.ts";

const SPECIAL_DAYS_SOURCE = "Special Days Calendar";
const DEFAULT_SPECIAL_DAYS_TIMEZONE = "Europe/Warsaw";

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  isoDate: string;
}

export interface SpecialDaySelectionResult {
  storedCount: number;
  selectedNews: NewsItem | null;
  selectedDayName?: string;
}

function getTimezone(): string {
  return Deno.env.get("SPECIAL_DAYS_TIMEZONE") || DEFAULT_SPECIAL_DAYS_TIMEZONE;
}

function getLocalDateParts(timeZone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year")?.value || "0");
  const month = Number(parts.find((part) => part.type === "month")?.value || "0");
  const day = Number(parts.find((part) => part.type === "day")?.value || "0");

  return {
    year,
    month,
    day,
    isoDate: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

function buildSpecialDayUrl(specialDayId: string, dateParts: LocalDateParts): string {
  return `special-day://${dateParts.isoDate}/${specialDayId}`;
}

function publishedAtIso(dateParts: LocalDateParts): string {
  return new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, 12, 0, 0)).toISOString();
}

async function listTodaySpecialDays(dateParts: LocalDateParts): Promise<SpecialDay[]> {
  const { data, error } = await supabaseAdmin
    .from("special_days")
    .select("*")
    .eq("is_active", true)
    .eq("month", dateParts.month)
    .eq("day", dateParts.day)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error || !data) {
    console.error("Failed to load special_days", error?.message);
    return [];
  }

  return data as SpecialDay[];
}

async function upsertSpecialDayNewsItem(
  specialDay: SpecialDay,
  dateParts: LocalDateParts,
): Promise<boolean> {
  const payload = {
    title: specialDay.day_name,
    description: specialDay.day_description,
    url: buildSpecialDayUrl(specialDay.id, dateParts),
    source: SPECIAL_DAYS_SOURCE,
    category: specialDay.category,
    published_at: publishedAtIso(dateParts),
    used: false,
  };

  const { error } = await supabaseAdmin
    .from("news_cache")
    .upsert(payload, { onConflict: "url", ignoreDuplicates: true });

  if (error) {
    console.error("Failed to upsert special day news_cache row", specialDay.day_name, error.message);
    return false;
  }

  return true;
}

async function findUnusedSpecialDayNews(url: string): Promise<NewsItem | null> {
  const { data, error } = await supabaseAdmin
    .from("news_cache")
    .select("*")
    .eq("url", url)
    .eq("used", false)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data as NewsItem;
}

export async function ensureAndPickTodaySpecialDayNews(): Promise<SpecialDaySelectionResult> {
  const dateParts = getLocalDateParts(getTimezone());
  const specialDays = await listTodaySpecialDays(dateParts);

  if (specialDays.length === 0) {
    return {
      storedCount: 0,
      selectedNews: null,
    };
  }

  let storedCount = 0;
  for (const specialDay of specialDays) {
    if (await upsertSpecialDayNewsItem(specialDay, dateParts)) {
      storedCount += 1;
    }
  }

  for (const specialDay of specialDays) {
    const url = buildSpecialDayUrl(specialDay.id, dateParts);
    const news = await findUnusedSpecialDayNews(url);
    if (news) {
      return {
        storedCount,
        selectedNews: news,
        selectedDayName: specialDay.day_name,
      };
    }
  }

  return {
    storedCount,
    selectedNews: null,
  };
}
