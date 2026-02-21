import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import {
  getActiveTopicByKey,
  generateFacebookContent,
  generateImagePrompt,
  getContentTopicRotation,
  markTopicAsUsed,
} from "../_shared/content-generator.ts";
import { postToFacebook } from "../_shared/facebook.ts";
import { generateImage } from "../_shared/image-generator.ts";
import {
  fetchAndStoreNews,
  getBestUnusedNewsForTopic,
  markNewsAsUsed,
} from "../_shared/news-fetcher.ts";
import { ensureAndPickTodaySpecialDayNews } from "../_shared/special-days.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import type { ContentTopic, NewsItem, PostMode } from "../_shared/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface GenerateRequestBody {
  dry_run?: boolean;
  skip_fetch?: boolean;
  skip_special_days?: boolean;
  topic_key?: string;
  consume_news?: boolean;
  post_mode?: PostMode;
}

interface RunSummary {
  fetchedNewsCount: number;
  specialDaysStoredCount: number;
  specialDayPost: boolean;
  specialDayName?: string;
  topicKey: string;
  topicName: string;
  newsTitle: string;
  newsUrl: string;
  dryRun: boolean;
  posted: boolean;
  requestedPostMode: PostMode;
  finalPostMode: "link" | "image";
  imageGenerated: boolean;
  imageUrl?: string;
  postId?: string;
  error?: string;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function parsePostMode(value: unknown): PostMode {
  if (value === "image" || value === "link" || value === "auto") {
    return value;
  }

  const envMode = Deno.env.get("DEFAULT_POST_MODE");
  if (envMode === "image" || envMode === "link" || envMode === "auto") {
    return envMode;
  }

  return "auto";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  return /^https?:\/\//i.test(value.trim());
}

function shouldAppendLinkToImageCaption(): boolean {
  const envValue = (Deno.env.get("IMAGE_APPEND_LINK_TO_CAPTION") || "true").toLowerCase();
  return envValue !== "false";
}

async function getPostedCount(): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("social_posts_history")
    .select("id", { count: "exact", head: true })
    .eq("status", "posted");

  if (error) {
    console.warn("Failed to read post count, using 0", error.message);
    return 0;
  }

  return count || 0;
}

async function pickTopicAndNews(
  topicKey?: string,
  specialDayNews?: NewsItem | null,
): Promise<{ topic: ContentTopic; news: NewsItem; specialDayPost: boolean } | null> {
  if (topicKey) {
    const topic = await getActiveTopicByKey(topicKey);
    if (!topic) {
      throw new Error(`Active topic not found: ${topicKey}`);
    }

    const news = topic.topic_key === "special_days"
      ? specialDayNews
      : await getBestUnusedNewsForTopic(topic.topic_key);
    if (!news) {
      return null;
    }

    return {
      topic,
      news,
      specialDayPost: Boolean(specialDayNews && news.id === specialDayNews.id),
    };
  }

  if (specialDayNews) {
    const specialDaysTopic =
      await getActiveTopicByKey("special_days") ||
      await getActiveTopicByKey("culture");

    if (specialDaysTopic) {
      return {
        topic: specialDaysTopic,
        news: specialDayNews,
        specialDayPost: true,
      };
    }

    const fallbackRotation = await getContentTopicRotation(1);
    if (fallbackRotation.length > 0) {
      return {
        topic: fallbackRotation[0],
        news: specialDayNews,
        specialDayPost: true,
      };
    }
  }

  const rotation = await getContentTopicRotation(10);
  for (const topic of rotation) {
    const news = await getBestUnusedNewsForTopic(topic.topic_key);
    if (news) {
      return { topic, news, specialDayPost: false };
    }
  }

  return null;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = (await req.json().catch(() => ({}))) as GenerateRequestBody;
    const dryRun = Boolean(body.dry_run);
    const shouldFetch = !body.skip_fetch;
    const shouldCheckSpecialDays = !body.skip_special_days;
    const consumeNews = body.consume_news ?? !dryRun;
    const requestedPostMode = parsePostMode(body.post_mode);

    const pageId = Deno.env.get("FACEBOOK_PAGE_ID");
    const accessToken = Deno.env.get("FACEBOOK_PAGE_ACCESS_TOKEN");

    if (!dryRun && (!pageId || !accessToken)) {
      return jsonResponse(
        {
          success: false,
          error: "FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN are required for non-dry runs",
        },
        400,
      );
    }

    const postedCount = await getPostedCount();
    const imageEveryNth = parsePositiveInt(Deno.env.get("IMAGE_POST_EVERY_NTH"), 2);

    const shouldGenerateImage =
      requestedPostMode === "image" ||
      (requestedPostMode === "auto" && (postedCount + 1) % imageEveryNth === 0);

    let fetchedNewsCount = 0;
    if (shouldFetch) {
      fetchedNewsCount = await fetchAndStoreNews();
    }

    let specialDaysStoredCount = 0;
    let specialDayName: string | undefined;
    let specialDayNews: NewsItem | null = null;

    if (shouldCheckSpecialDays) {
      const specialDaysResult = await ensureAndPickTodaySpecialDayNews();
      specialDaysStoredCount = specialDaysResult.storedCount;
      specialDayNews = specialDaysResult.selectedNews;
      specialDayName = specialDaysResult.selectedDayName;
    }

    const selected = await pickTopicAndNews(body.topic_key, specialDayNews);
    if (!selected) {
      return jsonResponse({
        success: true,
        skipped: true,
        reason: "No unused news available for active topics",
        fetchedNewsCount,
        specialDaysStoredCount,
      });
    }

    const { topic, news, specialDayPost } = selected;
    const content = await generateFacebookContent(news, topic);

    const imagePrompt = shouldGenerateImage ? generateImagePrompt(news, topic) : null;
    const imageUrl = !dryRun && imagePrompt
      ? await generateImage({ imagePrompt })
      : null;

    const canAttachNewsLink = isHttpUrl(news.url);
    const finalPostMode: "link" | "image" = imageUrl ? "image" : "link";
    const contentForImagePost = shouldAppendLinkToImageCaption() && canAttachNewsLink
      ? `${content}\n\n${news.url}`
      : content;
    const postContent = finalPostMode === "image" ? contentForImagePost : content;

    const { data: historyRow, error: insertError } = await supabaseAdmin
      .from("social_posts_history")
      .insert({
        platform: "facebook",
        content: postContent,
        image_url: imageUrl,
        image_prompt: imagePrompt,
        has_generated_image: Boolean(imageUrl),
        news_reference: news.id,
        status: "generating",
      })
      .select("id")
      .single();

    if (insertError || !historyRow) {
      throw new Error(
        `Failed to create post history row: ${insertError?.message || "unknown error"}`,
      );
    }

    let summary: RunSummary = {
      fetchedNewsCount,
      specialDaysStoredCount,
      specialDayPost,
      specialDayName: specialDayPost ? specialDayName : undefined,
      topicKey: topic.topic_key,
      topicName: topic.topic_name,
      newsTitle: news.title,
      newsUrl: news.url,
      dryRun,
      posted: false,
      requestedPostMode,
      finalPostMode: dryRun && shouldGenerateImage ? "image" : finalPostMode,
      imageGenerated: Boolean(imageUrl),
      imageUrl: imageUrl || undefined,
    };

    if (dryRun) {
      await supabaseAdmin
        .from("social_posts_history")
        .update({
          status: "posted",
          external_post_id: "dry_run",
          posted_at: new Date().toISOString(),
        })
        .eq("id", historyRow.id);

      summary = {
        ...summary,
        posted: true,
        postId: "dry_run",
      };
    } else {
      const result = await postToFacebook(
        finalPostMode === "image"
          ? {
              pageId: pageId!,
              accessToken: accessToken!,
              message: postContent,
              imageUrl: imageUrl!,
            }
          : {
              pageId: pageId!,
              accessToken: accessToken!,
              message: content,
              link: canAttachNewsLink ? news.url : undefined,
            },
      );

      if (!result.success) {
        await supabaseAdmin
          .from("social_posts_history")
          .update({
            status: "failed",
            error_message: result.error || "Unknown posting error",
          })
          .eq("id", historyRow.id);

        summary = {
          ...summary,
          posted: false,
          error: result.error,
        };

        return jsonResponse({ success: false, summary, postPreview: postContent }, 500);
      }

      await supabaseAdmin
        .from("social_posts_history")
        .update({
          status: "posted",
          external_post_id: result.postId,
          posted_at: new Date().toISOString(),
        })
        .eq("id", historyRow.id);

      summary = {
        ...summary,
        posted: true,
        postId: result.postId,
      };
    }

    if (consumeNews && summary.posted) {
      await markNewsAsUsed(news.id);
      await markTopicAsUsed(topic.id);
    }

    return jsonResponse({
      success: true,
      summary,
      postPreview: postContent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("generate-facebook-posts error", message);
    return jsonResponse({ success: false, error: message }, 500);
  }
});
