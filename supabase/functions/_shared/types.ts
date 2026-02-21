export type SocialPlatform = "facebook";
export type NewsCategory = "tech" | "ngo" | "grants" | "culture" | "general";

export interface NewsItem {
  id: string;
  title: string;
  description: string | null;
  url: string;
  source: string;
  category: NewsCategory;
  published_at: string | null;
  fetched_at: string;
  used: boolean;
  used_at: string | null;
}

export interface ContentTopic {
  id: string;
  topic_key: string;
  topic_name: string;
  description: string | null;
  prompt_template_facebook: string;
  rotation_order: number;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
}

export interface SocialPostHistory {
  id: string;
  platform: SocialPlatform;
  external_post_id: string | null;
  content: string;
  image_url: string | null;
  image_prompt: string | null;
  has_generated_image: boolean;
  news_reference: string | null;
  status: "pending" | "generating" | "posted" | "failed";
  error_message: string | null;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RssSource {
  id: string;
  source_name: string;
  feed_url: string;
  category: NewsCategory;
  is_active: boolean;
  priority: number;
  created_at: string;
}

export interface SpecialDay {
  id: string;
  day_name: string;
  day_description: string | null;
  month: number;
  day: number;
  category: NewsCategory;
  priority: number;
  is_active: boolean;
  created_at: string;
}

export interface RSSFeedItem {
  title: string;
  description?: string;
  link: string;
  pubDate?: string;
}

export interface PostResult {
  success: boolean;
  postId?: string;
  error?: string;
}

export type PostMode = "auto" | "link" | "image";
