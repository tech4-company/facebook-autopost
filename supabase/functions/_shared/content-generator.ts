import { supabaseAdmin } from "./supabase.ts";
import type { ContentTopic, NewsItem } from "./types.ts";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

function replaceTokens(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template,
  );
}

function organizationContext(): Record<string, string> {
  return {
    organization_name: Deno.env.get("ORGANIZATION_NAME") || "Our organization",
    organization_context:
      Deno.env.get("ORGANIZATION_CONTEXT") ||
      "We help nonprofit and social impact teams use digital tools.",
    post_call_to_action: Deno.env.get("POST_CALL_TO_ACTION") || "Follow us for more updates.",
    post_language: Deno.env.get("DEFAULT_POST_LANGUAGE") || "English",
  };
}

function cleanGeneratedContent(content: string): string {
  return content
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```$/, "")
    .replace(/^"|"$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fallbackPost(news: NewsItem, topic: ContentTopic): string {
  const org = organizationContext();
  const lead = news.description ? `${news.description}\n\n` : "";
  return cleanGeneratedContent(
    `${news.title}\n\n${lead}${org.organization_context}\n\n${org.post_call_to_action}`,
  );
}

async function generateWithGemini(prompt: string): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const url = `${GEMINI_API_BASE}/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 500,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const data: GeminiResponse = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

function buildPrompt(topic: ContentTopic, news: NewsItem): string {
  const org = organizationContext();
  const templated = replaceTokens(topic.prompt_template_facebook, {
    news_title: news.title,
    news_description: news.description || "",
    news_url: news.url,
    organization_name: org.organization_name,
    organization_context: org.organization_context,
    post_call_to_action: org.post_call_to_action,
    post_language: org.post_language,
  });

  return [
    "Write exactly one Facebook post.",
    "Do not use markdown code blocks.",
    "Keep it practical and concise.",
    templated,
  ].join("\n\n");
}

export async function getContentTopicRotation(limit = 10): Promise<ContentTopic[]> {
  const { data, error } = await supabaseAdmin
    .from("content_topics")
    .select("*")
    .eq("is_active", true)
    .order("last_used_at", { ascending: true, nullsFirst: true })
    .order("rotation_order", { ascending: true })
    .limit(limit);

  if (error || !data) {
    console.error("Failed to load content topics", error?.message);
    return [];
  }

  return data as ContentTopic[];
}

export async function getActiveTopicByKey(topicKey: string): Promise<ContentTopic | null> {
  const { data, error } = await supabaseAdmin
    .from("content_topics")
    .select("*")
    .eq("topic_key", topicKey)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data as ContentTopic;
}

export async function markTopicAsUsed(topicId: string): Promise<void> {
  await supabaseAdmin
    .from("content_topics")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", topicId);
}

export async function generateFacebookContent(news: NewsItem, topic: ContentTopic): Promise<string> {
  const prompt = buildPrompt(topic, news);
  const apiKey = Deno.env.get("GEMINI_API_KEY");

  if (!apiKey) {
    return fallbackPost(news, topic);
  }

  try {
    const generated = await generateWithGemini(prompt);
    if (!generated.trim()) {
      return fallbackPost(news, topic);
    }
    return cleanGeneratedContent(generated);
  } catch (error) {
    console.warn("Gemini failed, using fallback post", error);
    return fallbackPost(news, topic);
  }
}
