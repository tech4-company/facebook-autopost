import type { PostResult } from "./types.ts";

const DEFAULT_GRAPH_API_VERSION = "v24.0";

export interface FacebookPostOptions {
  pageId: string;
  accessToken: string;
  message: string;
  imageUrl?: string;
  link?: string;
}

function graphApiBase(): string {
  const version = Deno.env.get("FB_GRAPH_API_VERSION") || DEFAULT_GRAPH_API_VERSION;
  return `https://graph.facebook.com/${version}`;
}

async function assertFacebookResponse(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  const errorPayload = await response.json().catch(() => null);
  const errorMessage =
    errorPayload?.error?.message ||
    `${response.status} ${response.statusText}`;

  throw new Error(`Facebook API error: ${errorMessage}`);
}

async function postToFeed(options: FacebookPostOptions): Promise<string> {
  const { pageId, accessToken, message, imageUrl, link } = options;

  if (imageUrl) {
    return await postToPhotos({
      pageId,
      accessToken,
      caption: message,
      imageUrl,
    });
  }

  const params = new URLSearchParams({
    access_token: accessToken,
    message,
  });

  if (link) {
    params.set("link", link);
  }

  const response = await fetch(`${graphApiBase()}/${pageId}/feed?${params.toString()}`, {
    method: "POST",
  });

  await assertFacebookResponse(response);

  const payload = await response.json();
  return payload.id;
}

interface FacebookPhotoPostOptions {
  pageId: string;
  accessToken: string;
  caption: string;
  imageUrl: string;
}

async function postToPhotos(options: FacebookPhotoPostOptions): Promise<string> {
  const { pageId, accessToken, caption, imageUrl } = options;
  const params = new URLSearchParams({
    access_token: accessToken,
    caption,
    url: imageUrl,
  });

  const response = await fetch(`${graphApiBase()}/${pageId}/photos?${params.toString()}`, {
    method: "POST",
  });

  await assertFacebookResponse(response);

  const payload = await response.json();
  return payload.post_id || payload.id;
}

export async function postToFacebook(options: FacebookPostOptions): Promise<PostResult> {
  try {
    const postId = await postToFeed(options);
    return { success: true, postId };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown posting error",
    };
  }
}

export async function verifyFacebookToken(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${graphApiBase()}/me?access_token=${accessToken}`);
    return response.ok;
  } catch {
    return false;
  }
}
