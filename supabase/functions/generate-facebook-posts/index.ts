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
import { supabaseAdmin } from "../_shared/supabase.ts";
import type { ContentTopic, NewsItem, PostMode } from "../_shared/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface GenerateRequestBody {
  dry_run?: boolean;
  skip_fetch?: boolean;
  topic_key?: string;
  consume_news?: boolean;
  post_mode?: PostMode;
}

interface RunSummary {
  fetchedNewsCount: number;
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
): Promise<{ topic: ContentTopic; news: NewsItem } | null> {
  if (topicKey) {
    const topic = await getActiveTopicByKey(topicKey);
    if (!topic) {
      throw new Error(`Active topic not found: ${topicKey}`);
    }

    const news = await getBestUnusedNewsForTopic(topic.topic_key);
    if (!news) {
      return null;
    }

    return { topic, news };
  }

  const rotation = await getContentTopicRotation(10);
  for (const topic of rotation) {
    const news = await getBestUnusedNewsForTopic(topic.topic_key);
    if (news) {
      return { topic, news };
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

    const selected = await pickTopicAndNews(body.topic_key);
    if (!selected) {
      return jsonResponse({
        success: true,
        skipped: true,
        reason: "No unused news available for active topics",
        fetchedNewsCount,
      });
    }

    const { topic, news } = selected;
    const content = await generateFacebookContent(news, topic);

    const imagePrompt = shouldGenerateImage ? generateImagePrompt(news, topic) : null;
    const imageUrl = !dryRun && imagePrompt
      ? await generateImage({ imagePrompt })
      : null;

    const finalPostMode: "link" | "image" = imageUrl ? "image" : "link";
    const contentForImagePost = shouldAppendLinkToImageCaption()
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
              link: news.url,
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
