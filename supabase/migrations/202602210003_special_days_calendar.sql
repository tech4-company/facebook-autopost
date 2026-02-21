-- Special days calendar for occasion-based posts (e.g., World Pizza Day).

create table if not exists public.special_days (
  id uuid primary key default gen_random_uuid(),
  day_name text not null,
  day_description text,
  month integer not null check (month between 1 and 12),
  day integer not null check (day between 1 and 31),
  category text not null check (category in ('tech', 'ngo', 'grants', 'culture', 'general')),
  priority integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (month, day, day_name)
);

create index if not exists idx_special_days_active_date
  on public.special_days (is_active, month, day, priority);

alter table public.special_days enable row level security;

create policy "Service role all special_days"
  on public.special_days
  for all
  to service_role
  using (true)
  with check (true);

create policy "Authenticated read special_days"
  on public.special_days
  for select
  to authenticated
  using (true);

insert into public.special_days (day_name, day_description, month, day, category, priority, is_active)
values
  (
    'Swiatowy Dzien Pizzy',
    'Lekki post spolecznosciowy z nawiazaniem do lokalnych dzialan i integracji.',
    2,
    9,
    'culture',
    10,
    true
  ),
  (
    'Miedzynarodowy Dzien Wolontariusza',
    'Podziekowanie wolontariuszom i zaproszenie do dolaczenia do dzialan organizacji.',
    12,
    5,
    'ngo',
    10,
    true
  ),
  (
    'Swiatowy Dzien Ziemi',
    'Komunikat edukacyjny i mobilizacja spolecznosci do lokalnych dzialan proekologicznych.',
    4,
    22,
    'ngo',
    20,
    true
  )
on conflict (month, day, day_name)
do update set
  day_description = excluded.day_description,
  category = excluded.category,
  priority = excluded.priority,
  is_active = excluded.is_active;

insert into public.content_topics (
  topic_key,
  topic_name,
  description,
  prompt_template_facebook,
  rotation_order,
  is_active
)
values
  (
    'special_days',
    'Special days and awareness dates',
    'Posts related to calendar-based awareness and community days.',
    'Write a Facebook post in {{post_language}} about today''s special day: {{news_title}}. Explain why it matters for local communities and NGOs. Keep it under 500 characters, practical and warm in tone. End with CTA: {{post_call_to_action}}. Context: {{organization_context}}.',
    15,
    true
  )
on conflict (topic_key)
do update set
  topic_name = excluded.topic_name,
  description = excluded.description,
  prompt_template_facebook = excluded.prompt_template_facebook,
  rotation_order = excluded.rotation_order,
  is_active = excluded.is_active;
