---
name: fb-ads
description: "Fetch Facebook Ads campaign performance metrics (installs, CPI, spend) using the MarketingAgent CLI."
metadata:
  {
    "firstclaw":
      {
        "emoji": "📊",
        "requires": { "anyBins": ["python.exe", "python3", "python"] },
      },
  }
---

# Facebook Ads – Campaign Insights

Fetch campaign performance data (name, installs, CPI, spend) from Facebook Ads using the MarketingAgent Python CLI at `C:\Users\Linhan\Documents\MarketingAgent`.

## Prerequisites

The CLI requires four env vars (set in the `.env` file at the project root or exported):

- `FB_APP_ID` – Meta app ID
- `FB_APP_SECRET` – Meta app secret
- `FB_ACCESS_TOKEN` – User or system-user access token
- `FB_AD_ACCOUNT_ID` – Ad account ID (with or without `act_` prefix)

Install Python deps once:

```bash
cd "C:\Users\Linhan\Documents\MarketingAgent" && pip install -r requirements.txt
```

## Fetching All Campaign Insights (installs, CPI, spend)

Get a summary table of all campaigns with installs and CPI for the last 30 days:

```bash
cd "C:\Users\Linhan\Documents\MarketingAgent" && python cli.py insights campaigns
```

Output columns: Campaign name, Spend, Installs, CPI, Clicks, Impressions, plus a TOTAL row.

### Filter by status

Only active campaigns:

```bash
python cli.py insights campaigns --status ACTIVE
```

### Filter by specific campaign IDs

```bash
python cli.py insights campaigns --campaign-ids "123456,789012"
```

### Custom date range

```bash
python cli.py insights campaigns --since 2025-01-01 --until 2025-01-31
```

### Date presets

```bash
python cli.py insights campaigns --date-preset last_7d
python cli.py insights campaigns --date-preset today
python cli.py insights campaigns --date-preset maximum
```

Available presets: `today`, `yesterday`, `last_3d`, `last_7d`, `last_14d`, `last_28d`, `last_30d`, `last_90d`, `this_month`, `last_month`, `this_year`, `last_year`, `maximum`.

### JSON output

Append `--json` to also get raw JSON alongside the table:

```bash
python cli.py insights campaigns --json
```

## Single Campaign Detail

Fetch installs + CPI for one campaign by ID:

```bash
python cli.py insights campaign 123456789
```

With a date range:

```bash
python cli.py insights campaign 123456789 --since 2025-02-01 --until 2025-02-23
```

Returns JSON with: `campaign_id`, `campaign_name`, `spend`, `impressions`, `clicks`, `installs`, `cpi`.

## Listing Campaigns (metadata only, no metrics)

To list campaigns without performance data (just names, statuses, budgets):

```bash
python cli.py campaign list
python cli.py campaign list --status ACTIVE,PAUSED
```

## Interpreting Results

- **Spend** is in the ad account's currency (usually USD).
- **CPI** = Spend / Installs. Shows `N/A` when there are zero installs.
- **Installs** counts `mobile_app_install` actions reported by Facebook.
- Results aggregate over the selected date range.

## Troubleshooting

- **"No campaign data found"** – The date range may have no delivery. Try `--date-preset maximum`.
- **Authentication errors** – Check that `FB_ACCESS_TOKEN` is valid and not expired. Tokens from the Graph API Explorer expire in ~1 hour; use a long-lived token or system user token for production.
- **Missing installs** – The campaign must have `OUTCOME_APP_PROMOTION` objective with app-install optimization for the `mobile_app_install` action to appear.
