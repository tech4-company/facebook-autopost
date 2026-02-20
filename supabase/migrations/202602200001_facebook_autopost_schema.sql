-- Facebook Auto Post schema (Supabase Edge Function + pg_cron)
-- This migration is standalone and can be used in a fresh Supabase project.

create extension if not exists pgcrypto;

-- ==========================================
-- RSS SOURCES
-- ==========================================
create table if not exists public.rss_sources (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  feed_url text not null unique,
  category text not null check (category in ('tech', 'ngo', 'grants', 'culture', 'general')),
  is_active boolean not null default true,
  priority integer not null default 100,
  created_at timestamptz not null default now()
);

create index if not exists idx_rss_sources_active_priority on public.rss_sources (is_active, priority);

alter table public.rss_sources enable row level security;

create policy "Service role all rss_sources"
  on public.rss_sources
  for all
  to service_role
  using (true)
  with check (true);

create policy "Authenticated read rss_sources"
  on public.rss_sources
  for select
  to authenticated
  using (true);

-- ==========================================
-- NEWS CACHE
-- ==========================================
create table if not exists public.news_cache (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  url text not null unique,
  source text not null,
  category text not null check (category in ('tech', 'ngo', 'grants', 'culture', 'general')),
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  used boolean not null default false,
  used_at timestamptz
);

create index if not exists idx_news_cache_used on public.news_cache (used);
create index if not exists idx_news_cache_category on public.news_cache (category);
create index if not exists idx_news_cache_fetched_at on public.news_cache (fetched_at desc);

alter table public.news_cache enable row level security;

create policy "Service role all news_cache"
  on public.news_cache
  for all
  to service_role
  using (true)
  with check (true);

-- ==========================================
-- CONTENT TOPICS
-- ==========================================
create table if not exists public.content_topics (
  id uuid primary key default gen_random_uuid(),
  topic_key text not null unique,
  topic_name text not null,
  description text,
  prompt_template_facebook text not null,
  rotation_order integer not null,
  is_active boolean not null default true,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_content_topics_active_rotation
  on public.content_topics (is_active, rotation_order);

alter table public.content_topics enable row level security;

create policy "Service role all content_topics"
  on public.content_topics
  for all
  to service_role
  using (true)
  with check (true);

create policy "Authenticated read content_topics"
  on public.content_topics
  for select
  to authenticated
  using (true);

-- ==========================================
-- SOCIAL POSTS HISTORY
-- ==========================================
create table if not exists public.social_posts_history (
  id uuid primary key default gen_random_uuid(),
  platform text not null default 'facebook' check (platform in ('facebook')),
  external_post_id text,
  content text not null,
  news_reference uuid references public.news_cache(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'generating', 'posted', 'failed')),
  error_message text,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_social_posts_history_status
  on public.social_posts_history (status);

create index if not exists idx_social_posts_history_created_at
  on public.social_posts_history (created_at desc);

alter table public.social_posts_history enable row level security;

create policy "Service role all social_posts_history"
  on public.social_posts_history
  for all
  to service_role
  using (true)
  with check (true);

create policy "Authenticated read social_posts_history"
  on public.social_posts_history
  for select
  to authenticated
  using (true);

-- ==========================================
-- UPDATED_AT TRIGGER
-- ==========================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_social_posts_history_updated_at on public.social_posts_history;
create trigger trg_social_posts_history_updated_at
before update on public.social_posts_history
for each row
execute function public.set_updated_at();

-- ==========================================
-- SEED: RSS SOURCES (editable)
-- ==========================================
insert into public.rss_sources (source_name, feed_url, category, is_active, priority)
values
  ('TechCrunch', 'https://techcrunch.com/feed/', 'tech', true, 10),
  ('Google Blog - Technology', 'https://blog.google/technology/rss/', 'tech', true, 20),
  ('Fundusze Europejskie - Wiadomosci', 'https://www.funduszeeuropejskie.gov.pl/rss/wiadomosci/', 'grants', true, 30),
  ('Nonprofit Quarterly', 'https://nonprofitquarterly.org/feed/', 'ngo', true, 40)
on conflict (feed_url) do nothing;

-- ==========================================
-- SEED: CONTENT TOPICS (editable)
-- ==========================================
insert into public.content_topics (topic_key, topic_name, description, prompt_template_facebook, rotation_order, is_active)
values
  (
    'tech_ngo',
    'Technology for nonprofit impact',
    'Technology and digital transformation news relevant to nonprofits.',
    'Write a Facebook post in {{post_language}} about this news: {{news_title}}. Include one practical insight for nonprofit teams. Keep it under 500 characters, use plain text, and end with this CTA: {{post_call_to_action}}. Context about our organization: {{organization_context}}.',
    1,
    true
  ),
  (
    'grants',
    'Funding opportunities',
    'Funding and grants relevant to nonprofit organizations.',
    'Write a Facebook post in {{post_language}} about this funding news: {{news_title}}. Explain who can benefit and what action to take next. Keep it under 500 characters. End with CTA: {{post_call_to_action}}. Context: {{organization_context}}.',
    2,
    true
  ),
  (
    'culture',
    'Culture and heritage digitization',
    'Culture and heritage updates that can inspire community organizations.',
    'Write a Facebook post in {{post_language}} about this culture-related update: {{news_title}}. Explain why it matters for local organizations and communities. Keep it under 500 characters and end with CTA: {{post_call_to_action}}. Context: {{organization_context}}.',
    3,
    true
  )
on conflict (topic_key)
do update set
  topic_name = excluded.topic_name,
  description = excluded.description,
  prompt_template_facebook = excluded.prompt_template_facebook,
  rotation_order = excluded.rotation_order,
  is_active = excluded.is_active;
