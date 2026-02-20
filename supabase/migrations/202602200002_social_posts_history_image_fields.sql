-- Add optional image metadata for Replicate-generated Facebook posts.

alter table if exists public.social_posts_history
  add column if not exists image_url text,
  add column if not exists image_prompt text,
  add column if not exists has_generated_image boolean not null default false;

create index if not exists idx_social_posts_history_has_image
  on public.social_posts_history (has_generated_image);
