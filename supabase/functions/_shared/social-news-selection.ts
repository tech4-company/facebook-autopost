import type { NewsCategory, NewsItem } from "./types.ts";

export interface NewsCandidate {
  id?: string;
  title: string;
  description?: string | null;
  category?: NewsCategory;
  published_at?: string | null;
  fetched_at?: string | null;
  url?: string;
}

const DEFAULT_TOPIC_CATEGORY_PRIORITY: NewsCategory[] = [
  "ngo",
  "tech",
  "grants",
  "culture",
  "general",
];

const TOPIC_CATEGORY_PRIORITY: Record<string, NewsCategory[]> = {
  tech_ngo: ["ngo", "tech", "grants", "culture", "general"],
  grants: ["grants", "ngo", "tech", "culture", "general"],
  culture: ["culture", "ngo", "tech", "grants", "general"],
  general: ["general", "ngo", "tech", "grants", "culture"],
};

const MIN_CATEGORY_RELEVANCE_SCORE: Record<NewsCategory, number> = {
  tech: 2,
  ngo: 2,
  grants: 2,
  culture: 1,
  general: 0,
};

const MIN_TOPIC_RELEVANCE_SCORE = 2;

const NGO_KEYWORDS = [
  "ngo",
  "nonprofit",
  "non-profit",
  "foundation",
  "association",
  "charity",
  "community",
  "volunteer",
  "inclusion",
  "accessibility",
  "social impact",
  "fundacj",
  "stowarzyszen",
  "organizacj pozarzad",
  "wolontar",
  "spoleczn",
];

const NGO_EXCLUDE_KEYWORDS = [
  "fishery",
  "fisheries",
  "aquaculture",
  "ryback",
  "rybactw",
  "akwakultur",
  "commercial fleet",
  "port authority",
];

const TECH_KEYWORDS = [
  "technology",
  "digital",
  "automation",
  "ai",
  "artificial intelligence",
  "cyber",
  "software",
  "data",
  "platform",
  "technolog",
  "cyfrow",
  "digitaliz",
  "automatyzacj",
];

const GRANTS_KEYWORDS = [
  "grant",
  "funding",
  "fund",
  "call for proposals",
  "application",
  "subsidy",
  "dotac",
  "dofinans",
  "nabor",
  "wniosk",
  "konkurs",
];

const CULTURE_KEYWORDS = [
  "culture",
  "heritage",
  "museum",
  "library",
  "archive",
  "art",
  "kultur",
  "dziedzictw",
  "muze",
  "bibliotek",
  "zabyt",
];

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  aogon: "a",
  cacute: "c",
  eogon: "e",
  lstrok: "l",
  nacute: "n",
  oacute: "o",
  sacute: "s",
  zacute: "z",
  zdot: "z",
};

export function decodeHtmlEntities(value: string): string {
  let decoded = value;

  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded
      .replace(/&#(\d+);/g, (raw, decValue: string) => {
        const code = Number(decValue);
        return Number.isFinite(code) ? String.fromCodePoint(code) : raw;
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (raw, hexValue: string) => {
        const code = Number.parseInt(hexValue, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : raw;
      })
      .replace(/&([a-zA-Z]+);/g, (raw, entityName: string) => {
        return NAMED_HTML_ENTITIES[entityName.toLowerCase()] ?? raw;
      });

    if (next === decoded) {
      break;
    }

    decoded = next;
  }

  return decoded;
}

export function normalizeNewsText(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  return decodeHtmlEntities(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countKeywordMatches(text: string, keywords: string[]): number {
  return keywords.reduce((count, keyword) => count + (text.includes(keyword) ? 1 : 0), 0);
}

function getCategoryPriorityBonus(topicKey: string, category?: NewsCategory): number {
  if (!category) {
    return 0;
  }

  const priority = getTopicCategoryPriority(topicKey);
  const index = priority.indexOf(category);

  if (index === 0) return 4;
  if (index === 1) return 2;
  if (index === 2) return 1;
  if (index === 3) return 0;
  if (index === 4) return -1;
  return -2;
}

function getCandidateTimestamp(candidate: NewsCandidate): number {
  const dateValue = candidate.published_at || candidate.fetched_at;
  if (!dateValue) {
    return 0;
  }

  const timestamp = Date.parse(dateValue);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function getTopicCategoryPriority(topicKey: string): NewsCategory[] {
  return TOPIC_CATEGORY_PRIORITY[topicKey] ?? DEFAULT_TOPIC_CATEGORY_PRIORITY;
}

export function scoreNewsForTopic(candidate: NewsCandidate, topicKey: string): number {
  const normalized = normalizeNewsText(
    [candidate.title, candidate.description ?? ""].filter(Boolean).join(" "),
  );

  if (!normalized) {
    return -100;
  }

  const ngoMatches = countKeywordMatches(normalized, NGO_KEYWORDS);
  const excludeMatches = countKeywordMatches(normalized, NGO_EXCLUDE_KEYWORDS);
  const techMatches = countKeywordMatches(normalized, TECH_KEYWORDS);
  const grantsMatches = countKeywordMatches(normalized, GRANTS_KEYWORDS);
  const cultureMatches = countKeywordMatches(normalized, CULTURE_KEYWORDS);

  let score = 0;
  score += ngoMatches * 3;
  score -= excludeMatches * 8;
  score += getCategoryPriorityBonus(topicKey, candidate.category);

  if (topicKey.includes("tech")) {
    score += techMatches * 3;
    score += grantsMatches;
    score += cultureMatches;
  } else if (topicKey.includes("grant")) {
    score += grantsMatches * 3;
    score += ngoMatches;
    score += techMatches;
  } else if (topicKey.includes("culture")) {
    score += cultureMatches * 3;
    score += ngoMatches;
    score += techMatches;
  } else {
    score += techMatches + grantsMatches + cultureMatches;
  }

  return score;
}

export function isNewsRelevantForCategory(
  candidate: Pick<NewsCandidate, "title" | "description">,
  category: NewsCategory,
): boolean {
  if (category === "general") {
    return true;
  }

  const score = scoreNewsForTopic(
    {
      title: candidate.title,
      description: candidate.description,
      category,
    },
    category,
  );

  return score >= MIN_CATEGORY_RELEVANCE_SCORE[category];
}

export function selectBestNewsForTopic<T extends NewsCandidate>(
  candidates: T[],
  topicKey: string,
): T | null {
  const scored = candidates
    .map((candidate) => {
      const relevanceScore = scoreNewsForTopic(candidate, topicKey);
      const recencyScore = getCandidateTimestamp(candidate) / 1_000_000_000_000;
      return {
        candidate,
        relevanceScore,
        totalScore: relevanceScore * 100 + recencyScore,
      };
    })
    .filter((entry) => entry.relevanceScore >= MIN_TOPIC_RELEVANCE_SCORE)
    .sort((a, b) => b.totalScore - a.totalScore);

  if (scored.length === 0) {
    return null;
  }

  return scored[0].candidate;
}

export function categoryFromTopic(topicKey: string): NewsCategory {
  if (topicKey.includes("tech")) return "tech";
  if (topicKey.includes("grant")) return "grants";
  if (topicKey.includes("culture")) return "culture";
  if (topicKey.includes("ngo")) return "ngo";
  return "general";
}

export function castNewsItems(rows: unknown[]): NewsItem[] {
  return rows as NewsItem[];
}
