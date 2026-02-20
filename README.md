![Tech4Good](./assets/tech4good-banner.png)

---

# facebook-autopost-supabase

Samodzielny projekt Supabase do automatycznego publikowania postów na Facebooku na podstawie kanałów RSS.

To jest wydzielona, uproszczona wersja modułu `generate-social-posts`:
- tylko Facebook,
- bez LinkedIn,
- bez generatora obrazów,
- gotowa do hostowania na darmowym planie Supabase.

## 1. Co to robi i jak się spina

Pipeline jednego uruchomienia:

1. Edge Function czyta aktywne źródła RSS z tabeli `rss_sources`.
2. Pobiera wpisy RSS/Atom, filtruje i zapisuje do `news_cache`.
3. Wybiera temat z rotacji (`content_topics`) i najlepszy nieużyty news.
4. Generuje treść posta:
- tryb AI (Gemini), jeśli jest `GEMINI_API_KEY`,
- tryb fallback (deterministyczny szablon), jeśli brak Gemini.
5. Publikuje post na Facebook Page przez Graph API (`/{page-id}/feed`).
6. Zapisuje wynik i status do `social_posts_history`.
7. Oznacza news/topic jako użyte (żeby ograniczyć duplikaty).

```mermaid
flowchart TD
  A["pg_cron / ręczne wywołanie"] --> B["Edge Function: generate-facebook-posts"]
  B --> C["Tabela rss_sources"]
  B --> D["Pobranie RSS/Atom"]
  D --> E["Tabela news_cache"]
  B --> F["Tabela content_topics"]
  B --> G["Generator treści (Gemini lub fallback)"]
  G --> H["Facebook Graph API /{page-id}/feed"]
  B --> I["Tabela social_posts_history"]
```

## 2. Architektura i granice bezpieczeństwa

### Gdzie są sekrety

Sekrety są trzymane w Supabase Edge Functions Secrets i odczytywane w runtime przez `Deno.env.get(...)`.

Kluczowe sekrety:
- `FACEBOOK_PAGE_ID`
- `FACEBOOK_PAGE_ACCESS_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- opcjonalnie `GEMINI_API_KEY`

### Mapa sekretów (source of truth)

| Sekret | Skąd go wziąć | Gdzie ustawić | Do czego służy |
| --- | --- | --- | --- |
| `FACEBOOK_PAGE_ID` | `id` z odpowiedzi `GET /me/accounts` | `supabase secrets set` | Identyfikacja strony publikującej |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | `access_token` z odpowiedzi `GET /me/accounts` | `supabase secrets set` | Autoryzacja `POST /{page-id}/feed` |
| `SUPABASE_URL` | Dashboard Supabase (Project URL) | `supabase secrets set` | URL API projektu używany przez klienta DB w funkcji |
| `SUPABASE_SERVICE_ROLE_KEY` | Dashboard Supabase (API keys) | `supabase secrets set` | Pełny dostęp serwerowy do tabel (`news_cache`, `content_topics`, itd.) |
| `GEMINI_API_KEY` | Google AI Studio / Gemini | `supabase secrets set` | Generowanie treści posta (tryb AI) |

### Jak sekret "przechodzi" przez system

1. Ustawiasz sekret przez CLI (`supabase secrets set ...`) albo w Dashboard.
2. Supabase przechowuje sekret po swojej stronie.
3. Podczas wykonania Edge Function sekret jest dostępny jako zmienna środowiskowa.
4. Kod używa sekretu tylko serwerowo:
- do zapytań DB (`SUPABASE_SERVICE_ROLE_KEY`),
- do wywołania Facebook Graph API (`FACEBOOK_PAGE_ACCESS_TOKEN`).
5. Sekret nie jest wysyłany do frontendu ani zapisywany w bazie.

### Dlaczego `verify_jwt = true`

W tym repo funkcja ma `verify_jwt = true` (plik `supabase/config.toml`), więc nie przyjmie anonimowego requestu.
Wywołuj ją tylko backend-backend (cron, CI, serwer).

## 3. Wymagania wstępne

- Konto Supabase + nowy projekt.
- Supabase CLI.
- Facebook Page, do której masz uprawnienia administracyjne.
- Meta Developer App (dla tokenów).
- (Opcjonalnie) klucz Gemini API.

## 4. Facebook: dokładne pozyskanie danych (tokeny i sekrety)

Poniższy proces jest najważniejszy, bo od niego zależy działanie publikacji.

### 4.1. Przygotuj Meta App

1. Wejdź do Meta for Developers i utwórz aplikację (typ biznesowy).
2. Powiąż aplikację z odpowiednim Business Managerem (jeśli używacie BM).
3. Upewnij się, że konto użytkownika ma dostęp do strony (Page) i zadania umożliwiające publikację.
4. W panelu aplikacji zapisz:
- `APP_ID`,
- `APP_SECRET` (zwykle w `Settings -> Basic`).
5. Na starcie trzymaj aplikację w trybie developerskim i testuj na stronie testowej.
6. Gdy wdrażasz produkcję dla szerszego grona kont, przygotuj app review wymaganych uprawnień.

### 4.2. Wygeneruj User Access Token (krótkotrwały)

Najprościej przez Graph API Explorer:
- wybierz swoją aplikację,
- wygeneruj token użytkownika,
- zaznacz uprawnienia wymagane do publikowania na stronie.

Minimalnie praktyczne scope'y do tego use-case:
- `pages_manage_posts`
- `pages_read_engagement`
- `pages_show_list`

### 4.3. Zamień na Long-Lived User Token

Wymagane dane:
- `APP_ID`
- `APP_SECRET`
- `SHORT_LIVED_USER_TOKEN`

Przykład:

```bash
curl -G "https://graph.facebook.com/v24.0/oauth/access_token" \
  --data-urlencode "grant_type=fb_exchange_token" \
  --data-urlencode "client_id=<APP_ID>" \
  --data-urlencode "client_secret=<APP_SECRET>" \
  --data-urlencode "fb_exchange_token=<SHORT_LIVED_USER_TOKEN>"
```

W odpowiedzi dostaniesz dłużej ważny token użytkownika.

Uwaga praktyczna:
- `APP_SECRET` to sekret aplikacji Meta, a nie token strony.
- Trzymaj go tylko w bezpiecznym miejscu operatorskim (nigdy w repo).

### 4.4. Pobierz Page Access Token i Page ID

Użyj dłużej ważnego tokenu użytkownika:

```bash
curl -G "https://graph.facebook.com/v24.0/me/accounts" \
  --data-urlencode "access_token=<LONG_LIVED_USER_TOKEN>"
```

W odpowiedzi szukasz:
- `id` -> to `FACEBOOK_PAGE_ID`,
- `access_token` -> to `FACEBOOK_PAGE_ACCESS_TOKEN`.

To właśnie `FACEBOOK_PAGE_ACCESS_TOKEN` trafia potem do Supabase Secrets i jest używany przez Edge Function do publikacji.

### 4.5. Weryfikacja tokenu (zalecane)

Szybki test publikacji (na stronie testowej):

```bash
curl -X POST "https://graph.facebook.com/v24.0/<FACEBOOK_PAGE_ID>/feed" \
  --data-urlencode "message=Test post from automation" \
  --data-urlencode "access_token=<FACEBOOK_PAGE_ACCESS_TOKEN>"
```

Jeżeli dostajesz ID posta, token jest poprawny.

### 4.6. Ważne uwagi operacyjne

- Tokeny mogą stracić ważność po zmianach uprawnień/roli/hasła/polityk Meta.
- Traktuj token jak hasło produkcyjne.
- Po incydencie bezpieczeństwa: natychmiastowa rotacja tokenu.

## 5. Struktura repozytorium

```
supabase/
  config.toml
  .env.local.example
  migrations/
    202602200001_facebook_autopost_schema.sql
  functions/
    import_map.json
    _shared/
      content-generator.ts
      facebook.ts
      news-fetcher.ts
      social-news-selection.ts
      supabase.ts
      types.ts
    generate-facebook-posts/
      index.ts
```

## 6. Supabase: instalacja i deploy

### 6.1. Podłącz repo do projektu Supabase

```bash
supabase login
supabase link --project-ref <PROJECT_REF>
```

### 6.2. Wgraj migracje

```bash
supabase db push
```

To utworzy tabele:
- `rss_sources`
- `news_cache`
- `content_topics`
- `social_posts_history`

### 6.3. Ustaw sekrety runtime

```bash
supabase secrets set SUPABASE_URL=https://<PROJECT_REF>.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<YOUR_SERVICE_ROLE_KEY>
supabase secrets set FACEBOOK_PAGE_ID=<YOUR_FACEBOOK_PAGE_ID>
supabase secrets set FACEBOOK_PAGE_ACCESS_TOKEN=<YOUR_FACEBOOK_PAGE_ACCESS_TOKEN>
```

Opcjonalnie:

```bash
supabase secrets set GEMINI_API_KEY=<YOUR_GEMINI_API_KEY>
supabase secrets set FB_GRAPH_API_VERSION=v24.0
supabase secrets set ORGANIZATION_NAME="Twoja organizacja"
supabase secrets set ORGANIZATION_CONTEXT="Pomagamy NGO wdrażać technologie"
supabase secrets set POST_CALL_TO_ACTION="Obserwuj nas po więcej aktualności"
supabase secrets set DEFAULT_POST_LANGUAGE="Polish"
```

### 6.4. Deploy funkcji

```bash
supabase functions deploy generate-facebook-posts
```

## 7. Testy end-to-end

### Dry run

Nie publikuje na Facebooku, ale przechodzi pipeline i zapisuje historię.

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/generate-facebook-posts" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"dry_run":true}'
```

### Live run

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/generate-facebook-posts" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Szybkie SQL do obserwacji

```sql
select id, platform, status, created_at, posted_at, error_message
from public.social_posts_history
order by created_at desc
limit 20;

select id, title, category, used, fetched_at
from public.news_cache
order by fetched_at desc
limit 20;
```

## 8. Harmonogram (pg_cron)

### Wersja prosta

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'generate-facebook-posts-job',
  '0 9 */3 * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/generate-facebook-posts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

### Wersja bezpieczniejsza (zalecana)

Przechowaj `SERVICE_ROLE_KEY` w Vault i odczytuj go w jobie, zamiast wpisywać jawnie w SQL.

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

select vault.create_secret('<SERVICE_ROLE_KEY>', 'service_role_key', 'Service role key for cron -> edge function');

select cron.schedule(
  'generate-facebook-posts-job',
  '0 9 */3 * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/generate-facebook-posts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'service_role_key'
        limit 1
      )
    ),
    body := '{}'::jsonb
  );
  $$
);
```

## 9. Dostosowanie dla organizacji

### 9.1. Źródła RSS

```sql
select * from public.rss_sources order by priority;

insert into public.rss_sources (source_name, feed_url, category, priority)
values ('Portal NGO', 'https://example.org/rss.xml', 'ngo', 50);
```

### 9.2. Tematy i szablony

Edytujesz `content_topics.prompt_template_facebook`.

Dostępne placeholdery:
- `{{news_title}}`
- `{{news_description}}`
- `{{news_url}}`
- `{{organization_name}}`
- `{{organization_context}}`
- `{{post_call_to_action}}`
- `{{post_language}}`

### 9.3. Wymuszenie konkretnego tematu

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/generate-facebook-posts" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"topic_key":"grants","dry_run":true,"skip_fetch":true}'
```

## 10. Troubleshooting

### "FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN are required"

Brakuje sekretów albo funkcja ich nie widzi. Sprawdź:
- `supabase secrets list`
- czy deploy był po ustawieniu sekretów (w razie wątpliwości zrób deploy ponownie).

### "Facebook API error"

Najczęściej:
- wygasły token,
- brak wymaganych uprawnień,
- brak dostępu konta do strony,
- strona niepowiązana poprawnie z aplikacją/biznesem.

### Brak postów mimo działania funkcji

- sprawdź `rss_sources.is_active`,
- sprawdź czy w `news_cache` są rekordy z `used = false`,
- sprawdź czy `content_topics.is_active = true`.

## 11. Runbook operacyjny

1. Co tydzień: kontrola `social_posts_history`.
2. Co miesiąc: test manualny live run.
3. Co 1-2 miesiące: weryfikacja ważności tokenu Facebook.
4. Po każdym incydencie: rotacja `FACEBOOK_PAGE_ACCESS_TOKEN` i `SUPABASE_SERVICE_ROLE_KEY`.

## 12. Bezpieczeństwo

Pełna polityka bezpieczeństwa jest w pliku `SECURITY.md`.

## 13. Licencja

MIT
