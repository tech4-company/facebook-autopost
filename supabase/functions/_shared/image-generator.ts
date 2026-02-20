const REPLICATE_API_BASE = "https://api.replicate.com/v1";
const DEFAULT_REPLICATE_MODEL = "google/nano-banana-pro";
const DEFAULT_ASPECT_RATIO = "1:1";
const DEFAULT_OUTPUT_FORMAT = "jpg";

interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[];
  error?: string;
}

interface ImageGenerationOptions {
  imagePrompt: string;
  maxAttempts?: number;
}

function buildEnhancedPrompt(prompt: string): string {
  const language = Deno.env.get("DEFAULT_POST_LANGUAGE") || "English";

  return [
    "Create a professional social media image for a Facebook page.",
    `Language context: ${language}.`,
    "Style: modern, clean, high-contrast, readable.",
    "Keep composition suitable for Facebook feed.",
    `Main concept: ${prompt}`,
  ].join("\n");
}

function getModelName(): string {
  return Deno.env.get("REPLICATE_MODEL") || DEFAULT_REPLICATE_MODEL;
}

function getAspectRatio(): string {
  return Deno.env.get("IMAGE_ASPECT_RATIO") || DEFAULT_ASPECT_RATIO;
}

function getOutputFormat(): string {
  return Deno.env.get("IMAGE_OUTPUT_FORMAT") || DEFAULT_OUTPUT_FORMAT;
}

function collectReferenceImages(): string[] {
  const references = [
    Deno.env.get("IMAGE_STYLE_REFERENCE_URL")?.trim(),
    Deno.env.get("IMAGE_BRAND_LOGO_URL")?.trim(),
  ].filter((value): value is string => Boolean(value));

  return references;
}

async function createPrediction(apiToken: string, prompt: string): Promise<ReplicatePrediction> {
  const model = getModelName();
  const references = collectReferenceImages();

  const input: Record<string, unknown> = {
    prompt: buildEnhancedPrompt(prompt),
    aspect_ratio: getAspectRatio(),
    output_format: getOutputFormat(),
    safety_filter_level: "block_only_high",
  };

  if (references.length > 0) {
    input.image_input = references;
  }

  const response = await fetch(`${REPLICATE_API_BASE}/models/${model}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({ input }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Replicate create prediction failed: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

async function getPrediction(apiToken: string, predictionId: string): Promise<ReplicatePrediction> {
  const response = await fetch(`${REPLICATE_API_BASE}/predictions/${predictionId}`, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Replicate poll failed: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

async function waitForPrediction(
  apiToken: string,
  predictionId: string,
  maxAttempts = 60,
): Promise<ReplicatePrediction> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const prediction = await getPrediction(apiToken, predictionId);

    if (
      prediction.status === "succeeded" ||
      prediction.status === "failed" ||
      prediction.status === "canceled"
    ) {
      return prediction;
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error("Replicate prediction timeout");
}

export async function generateImage(options: ImageGenerationOptions): Promise<string | null> {
  const { imagePrompt, maxAttempts = 60 } = options;
  const apiToken = Deno.env.get("REPLICATE_API_TOKEN");

  if (!apiToken) {
    console.warn("REPLICATE_API_TOKEN missing, image mode will fallback to link mode");
    return null;
  }

  try {
    const created = await createPrediction(apiToken, imagePrompt);
    const result = await waitForPrediction(apiToken, created.id, maxAttempts);

    if (result.status !== "succeeded" || !result.output) {
      if (result.error) {
        console.error("Replicate image generation failed", result.error);
      }
      return null;
    }

    return Array.isArray(result.output) ? result.output[0] : result.output;
  } catch (error) {
    console.error("Image generation error", error);
    return null;
  }
}
