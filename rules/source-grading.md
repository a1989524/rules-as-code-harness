# Source grading

Intent: every external claim carries a visible, checkable grade.

| Grade | Meaning | Typical sources |
| --- | --- | --- |
| S | primary, or the highest gatekeeping | official docs and specs, laws, official statistics, standards (ISO, RFC, W3C), source code and release notes; systematic reviews and guidelines |
| A | peer-reviewed or professionally edited | journal papers, academic books, peer-reviewed proceedings, wire-service reporting |
| B | reliable independent analysis | named expert analysis, research-institute reports, curated databases; encyclopedias only to find the original |
| C | unreviewed public content | preprints, blogs, vendor marketing, Q&A sites, non-maintainer issues |
| D | leads | forums, social media, comments, aggregators, stars |
| × | unusable | retracted, untraceable, fabricated, or outdated for a claim about the present |

- Grade the claim, not the site: a vendor is S about its own product and C about its competitors. Trace reposts to the original.
- Only claims about the present decay. Fast domains (AI, LLMs, agents, frontend frameworks, cloud pricing, vulnerabilities): full grade within 2 months, one grade down at 2–6, two down at 6–12 after confirming nothing newer exists, × after a year. Medium domains (libraries, languages, practice, market data): 6, 18 and 36 months.
- One line per source, highest grade first: `- [Title](URL) — A · source type · freshness · read mode`. Freshness is within 2 months, 2–6 months, 6–12 months or over a year; read mode is opened, page summary, search snippet or republished. No access dates.
- Confidence in a conclusion is judged apart from the grade: established, likely, doubtful or unknown.

Enforced by: the Stop hook `stopSourceLabels` blocks once when a turn that searched the web cites two or more sources and any of them lacks a grade or a read mode; an unsorted list gets a reminder.
