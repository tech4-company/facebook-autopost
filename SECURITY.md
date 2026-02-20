# Security Policy

## Supported Versions

Ten projekt jest utrzymywany na zasadzie "rolling release" dla gałęzi `main`.

| Version | Supported |
| --- | --- |
| `main` | yes |
| starsze tagi/commity | no |

## Reporting a Vulnerability

Jeśli znalazłeś podatność:

1. Nie publikuj jej publicznie (issues, social media) przed poprawką.
2. Zgłoś ją prywatnie przez GitHub Security Advisory (Draft Advisory) w tym repo.
3. Opisz:
- wektor ataku,
- wpływ,
- kroki reprodukcji,
- proponowaną poprawkę (jeśli masz).

Docelowe czasy reakcji (best effort):
- potwierdzenie zgłoszenia: do 3 dni roboczych,
- plan remediacji lub fix: do 14 dni roboczych,
- publikacja advisory po wdrożeniu poprawki.

## Security Model (co chronimy)

Najważniejsze sekrety:
- `SUPABASE_SERVICE_ROLE_KEY`
- `FACEBOOK_PAGE_ACCESS_TOKEN`
- `GEMINI_API_KEY` (jeśli używane)
- `REPLICATE_API_TOKEN` (jeśli używane posty obrazkowe)

Założenia:
- sekrety są trzymane wyłącznie w Supabase Secrets,
- Edge Function działa server-side,
- brak ujawniania sekretów do klienta/frontendu,
- endpoint funkcji wymaga JWT (`verify_jwt = true`).

## Hardening Checklist (produkcyjnie)

1. Nie commituj `.env` ani tokenów do repo.
2. Wywołuj Edge Function wyłącznie server-to-server.
3. Ogranicz dostęp do `SERVICE_ROLE_KEY` do minimum.
4. Rotuj token Facebook, service role key i (jeśli używany) token Replicate regularnie.
5. Używaj dedykowanej Facebook Page do testów i stagingu.
6. Monitoruj `social_posts_history` pod kątem statusów `failed` i anomalii.
7. Rozważ trzymanie klucza do cron joba w Vault zamiast jawnie w SQL.

## Incident Response (minimum)

W przypadku wycieku klucza/tokenu:

1. Natychmiast unieważnij/odnów wycieknięty sekret (`SUPABASE_SERVICE_ROLE_KEY`, `FACEBOOK_PAGE_ACCESS_TOKEN`, `REPLICATE_API_TOKEN` - jeśli używany).
2. Zaktualizuj Supabase Secrets nową wartością.
3. Wykonaj ponowny deploy funkcji.
4. Sprawdź logi i historię postów pod kątem nadużyć.
5. Udokumentuj incydent i działania naprawcze.

## Out of Scope

Ten projekt nie zapewnia:
- automatycznej rotacji tokenów Facebook,
- WAF/IDS,
- zarządzania uprawnieniami w panelu Meta Business.

Te elementy są odpowiedzialnością operatora wdrożenia.
