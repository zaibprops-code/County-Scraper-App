# Hillsborough County Lead Generator

Automated real estate investor lead generation from Hillsborough County, Florida court records.

Collects daily **probate** and **foreclosure** filings from the Hillsborough County Clerk's public CSV exports, cleans and normalizes the data, stores it in Supabase, and serves a searchable dashboard with CSV/Excel export.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 + Tailwind CSS |
| API | Next.js API Routes (TypeScript) |
| Database | Supabase (PostgreSQL) |
| Hosting | Vercel |
| Automation | Vercel Cron (daily 08:00 UTC) |

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/hillsborough-leads.git
cd hillsborough-leads
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env.local
# Edit .env.local with your Supabase credentials and cron secret
```

### 3. Set up Supabase database

1. Create a project at [supabase.com](https://supabase.com)
2. Open **SQL Editor**
3. Paste and run `supabase/migrations/001_initial_schema.sql`

### 4. Run locally

```bash
npm run dev
# → http://localhost:3000
```

### 5. Trigger manual ingestion (local)

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" http://localhost:3000/api/cron
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
| `CRON_SECRET` | Random secret to protect `/api/cron` endpoint |
| `PROBATE_BASE_URL` | Hillsborough probate directory URL |
| `CIVIL_BASE_URL` | Hillsborough civil directory URL |

---

## Project Structure

```
src/
├── app/
│   ├── page.tsx                  # Dashboard UI
│   ├── layout.tsx                # Root layout
│   ├── globals.css               # Global styles
│   └── api/
│       ├── cron/route.ts         # Daily ingestion pipeline
│       ├── leads/route.ts        # Paginated lead query
│       └── export/route.ts       # CSV / Excel export
├── components/
│   ├── FilterBar.tsx             # Search + filter controls
│   ├── LeadsTable.tsx            # Tabbed data table
│   ├── ExportButtons.tsx         # Download buttons
│   └── StatCard.tsx              # Dashboard stat tiles
├── lib/
│   ├── supabase.ts               # Supabase clients
│   ├── downloader.ts             # CSV discovery + download
│   ├── parser.ts                 # CSV → typed lead records
│   ├── filter.ts                 # Lead type detection
│   └── storage.ts                # Supabase batch insert
├── types/
│   └── leads.ts                  # TypeScript interfaces
└── utils/
    └── clean.ts                  # String/date normalization
supabase/
└── migrations/
    └── 001_initial_schema.sql    # Database schema
```

---

## Lead Types Collected

**Probate** — Formal Administration, Summary Administration, Probate Administration, Ancillary Administration, Determination of Homestead

**Foreclosure / Civil** — Mortgage Foreclosure, Lis Pendens, Foreclosure Complaint

---

## Deployment

See deployment steps at the bottom of this file or in the project documentation.

### Vercel Cron

The cron job is configured in `vercel.json` to run daily at 08:00 UTC (04:00 Eastern).
Vercel automatically sends the `Authorization: Bearer <CRON_SECRET>` header.

### Manual trigger

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron
```

---

## Column Mapping

The parser tries multiple column name variants since county CSV formats can differ.
After your first real ingestion, check the server logs for the line:

```
[Parser] Headers in CivilFiling_XXXXXXXX.csv: [...]
```

Update `src/lib/parser.ts` `firstOf(...)` calls if actual column names differ.

---

## License

Private — internal use only.
