# Fleet view (Grafana)

> **Blurb — lift this into the root README.**
> The cockpit is a flight recorder for one call: every turn's latency waterfall,
> transcript and cost, replayable from a share link. Grafana is the other half —
> the same recordings read across every call the deployment has ever stored. The
> Worker exposes `GET /api/metrics`, a public, cached, transcript-free aggregate
> over the debrief KV namespace (calls per day, pooled p50/p95/max response
> latency, stage breakdown, over-budget and degraded share, barge-ins, tokens and
> estimated spend), and `grafana/dashboard.json` is an importable dashboard that
> renders it through the Infinity datasource. No agent, no exporter, no metrics
> pipeline: the calls you already recorded are the fleet data.

Two sentences on the split, because it is the whole design: **cockpit = per-call
flight recorder** — one call, every turn, full waterfall detail, live or replayed
from a share link. **Grafana = fleet view** — every recorded call, aggregated,
where you find out whether last Tuesday's p95 was normal.

## Setup

1. Create a free [Grafana Cloud](https://grafana.com/auth/sign-up/create-user) stack (or use any Grafana v10+).
2. **Connections → Add new connection → Infinity**, and install the plugin (`yesoreyeram-infinity-datasource`).
3. **Add new data source** on that page; the defaults are correct — no auth, no URL needed. Save it.
4. **Dashboards → New → Import**, upload `grafana/dashboard.json` (or paste its contents).
5. On the import screen pick the Infinity data source you just made, and click **Import**.
6. Set the **Metrics URL** textbox at the top of the dashboard to your own Worker
   (default: `https://cockpit.agentmaker.io/api/metrics`), then **save the
   dashboard** — that textbox is deliberately not URL-synced (see below), so the
   saved value is what every panel uses.
7. Make a call, hang up, wait up to 60 s for the response cache to roll over, and refresh.

![Fleet dashboard](./screenshot.png) <!-- screenshot placeholder: 8 panels, calls/day bars top-left -->

## If every panel is empty

Check the **Metrics URL** textbox first. Infinity answers an unreachable or empty
URL with zero rows and *no error*, so one bad value blanks all eight panels with
nothing to diagnose — which is precisely what happened on the first live import:
the address bar carried an empty `var-endpoint=`, that overrode the saved
default, and the whole dashboard went quietly blank. The variable is now marked
`skipUrlSync`, so a URL can no longer override it; if you re-add URL syncing,
you re-add that failure mode. Confirm the endpoint independently with:

```sh
curl -s https://cockpit.agentmaker.io/api/metrics | jq .calls_total
```

If that returns a number and the panels are still empty, the problem is the data
source, not the data: check the Infinity plugin is installed and, on a
self-hosted Grafana, that its allowed-hosts setting is empty (allow all) or lists
your Worker's host.

## Notes

- **The dashboard time picker does not filter the data.** The endpoint returns
  one pre-aggregated document — scalars are over the whole sample, and only the
  calls-per-day series (14 fixed UTC buckets) is time-shaped. Leave it at 14 days.
- **`sampled: true`** in the raw JSON means the namespace holds more debriefs than
  the endpoint's 200-per-request read cap, and you are looking at the newest 200.
- **Nothing textual is exposed.** No transcripts, call ids or room names leave
  `/api/metrics` — see the field list in `worker/src/metrics.ts`.
- Response is `cache-control: public, max-age=60` and memoized in the isolate, so
  a scrape interval below a minute buys nothing.
- Panels use Infinity's **backend** parser, which returns fields in alphabetical
  order — the latency and fleet panels carry an `organize` transformation to pin
  a sensible reading order. Add one to any panel where field order matters.
- Latency fields deliberately set no `decimals`. Grafana's `ms` unit auto-scales
  past a second, so `decimals: 0` renders a 5339 ms p95 as a flat "5 s".
- Verified against Grafana Cloud (Grafana 12, Infinity 3.11.1) with live data
  from `cockpit.agentmaker.io`.
- Keep `dashboard.json` hand-edited. Re-exporting it from the Grafana UI replaces
  400 readable lines with a few thousand generated ones and drops the comments.
