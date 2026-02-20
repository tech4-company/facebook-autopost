# facebook-autopost-supabase

Standalone Supabase project for automatic Facebook posting based on RSS news.

This package was extracted from an existing `generate-social-posts` module and simplified for open-source use:
- Facebook only
- No LinkedIn dependency
- No image generation dependency
- Runs as a Supabase Edge Function
- Designed for free-tier friendly usage (low-frequency scheduling)

## Documentation

- Polish (full, recommended): [README.pl.md](./README.pl.md)
- Security policy: [SECURITY.md](./SECURITY.md)

## Repository layout

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

## License

MIT
