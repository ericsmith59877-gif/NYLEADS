# XyberMed Lead Finder

A lead-generation web app for **XyberMed** that finds newly opened **private** medical practices, newly registered physicians,
new labs and new clinics in New York State, removes the ones you could never win, and ranks the rest by how well they fit
XyberMed's services (credentialing, billing and RCM, lab billing).

## What it does
- **Pulls fresh public data automatically** from the CMS NPPES weekly files (newly assigned provider IDs) and the NYS Department of Health facility registry.
- **Narrows to real prospects.** Hospital and university systems, government bodies, national chains (labs, pharmacies, dialysis, urgent care), FQHCs, nursing and adult homes, hospital-run clinics, dentists, and "large employer" addresses are hidden by default (one click shows them).
- **Scores every lead 0-100** (Hot / Warm / Watch) with plain-English reasons: new practice entity or lab, new physician, target specialty, solo practitioner, private-practice naming, doctor + new practice at the same address, recency.
- **Suggests the pitch** for each lead based on specialty (cardiology, urology, oncology, nephrology, GI/hepatology, behavioral health, podiatry, labs).
- **Works like a CRM-lite:** status per lead (New, Contacted, Meeting booked, Won, Not a fit), a "My pipeline" tab, CSV export, links to the official record, Google, Maps and LinkedIn.
- Responsive, dark-mode aware, no login, no database, no API keys.

## Deploy (about 5 minutes, free)
1. **Unzip** this file. Open the unzipped folder so you can see `index.html`, `api`, `data`, `package.json` and `vercel.json`.
2. **GitHub:** create a new repository, click *uploading an existing file*, select **everything inside the folder** (not the folder itself) and drag it in. Click *Commit changes*. On the repository's front page you must see `index.html` and `api` directly.
3. **Vercel:** sign in at vercel.com with GitHub, click *Add New > Project*, import the repository, leave every setting as it is, and click **Deploy**.
4. Open your Vercel link. The first load of the day takes up to a minute while the latest government files are fetched; after that it is cached for 6 hours.

If the repository front page shows a single folder instead of `index.html`, either re-upload the contents, or in Vercel set **Root Directory** to that folder.

## Project layout
| Path | Purpose |
|---|---|
| `index.html` | The whole interface (HTML, CSS, JavaScript, no build step) |
| `api/leads.js` | Serverless function: downloads and parses the data, classifies and returns JSON |
| `data/sample.json` | Fictional sample data shown only if live data cannot load |
| `vercel.json` | Function timeout (60 s) and security headers |

## Customising
- **Who counts as "not a client":** edit the `BIG`, `NOTFIT` and `PRIV` patterns near the top of the classifier in `api/leads.js`.
- **Scoring weights and specialty angles:** edit `prep()`, `TARGET` and `ANGLES` in `index.html`.

## Good to know
- A new provider ID means someone registered, which usually comes before opening and payer enrollment. It is a strong signal, not proof of an open practice. Expect many resident physicians around July; the filters reduce them but cannot remove all.
- CMS keeps roughly five weekly files online, so the app shows about the last 5 weeks of registrations (plus any older IDs updated recently).
- Public data has no email addresses. Organization records include the authorized official's name and phone.
- The site is set to `noindex`, but anyone with the link can open it. Add Vercel password protection or Cloudflare Access if the list is sensitive.
- If live data fails, the page shows the exact reason in a red banner and falls back to sample data.
- Follow Do-Not-Call, TCPA and CAN-SPAM rules when contacting leads.
