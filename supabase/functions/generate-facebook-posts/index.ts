import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { getActiveTopicByKey, generateFacebookContent, getContentTopicRotation, markTopicAsUsed } from "../_shared/content-generator.ts";
import { postToFacebook } from "../_shared/facebook.ts";
import { fetchAndStoreNews, getBestUnusedNewsForTopic, markNewsAsUsed } from "../_shared/news-fetcher.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import type { ContentTopic, NewsItem } from "../_shared/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface GenerateRequestBody {
  dry_run?: boolean;
  skip_fetch?: boolean;
  topic_key?: string;
  consume_news?: boolean;
}

interface RunSummary {
  fetchedNewsCount: number;
  topicKey: string;
  topicName: string;
  newsTitle: string;
  newsUrl: string;
  dryRun: boolean;
  posted: boolean;
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

async function pickTopicAndNews(topicKey?: string): Promise<{ topic: ContentTopic; news: NewsItem } | null> {
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

    const { data: historyRow, error: insertError } = await supabaseAdmin
      .from("social_posts_history")
      .insert({
        platform: "facebook",
        content,
        news_reference: news.id,
        status: "generating",
      })
      .select("id")
      .single();

    if (insertError || !historyRow) {
      throw new Error(`Failed to create post history row: ${insertError?.message || "unknown error"}`);
    }

    let summary: RunSummary = {
      fetchedNewsCount,
      topicKey: topic.topic_key,
      topicName: topic.topic_name,
      newsTitle: news.title,
      newsUrl: news.url,
      dryRun,
      posted: false,
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
      const result = await postToFacebook({
        pageId: pageId!,
        accessToken: accessToken!,
        message: content,
        link: news.url,
      });

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

        return jsonResponse({ success: false, summary, postPreview: content }, 500);
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
      postPreview: content,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("generate-facebook-posts error", message);
    return jsonResponse({ success: false, error: message }, 500);
  }
});
