---
type: research
subtype: competitive-analysis
date: 2026-03-26
updated: 2026-03-30
source: barti.com, softwarefinder.com, crunchbase, linkedin, reddit, axios, business insider, firecrawl deep scrape
status: comprehensive
context: OSOD competitive research ONLY — not for IVA operations
related:
  - reference/domain/open-source-od/vision.md
  - decisions/2026-03-14-open-source-od-architecture.md
  - reference/domain/competitive-landscape.md
---

# Barti — Comprehensive Competitive Research for OSOD

## CONTEXT: This is competitive research for Open Source OD. Not for IVA operations. Not for PerformanceOD clients. Research only.

---

## Company Overview

- **Name:** Barti (sometimes misspelled "Bardi" or "BARTI")
- **URL:** barti.com
- **Founded:** 2021 (via Fractal Software venture studio)
- **HQ:** San Francisco, California
- **Employees:** 11-50 (per Jobright/Crunchbase)
- **Co-founders:**
  - **Colton Calandrella** — CEO. WashU alum (BSBA '17). Previously co-founded CheckTheQ. Associate role 2019-2021 before founding Barti. Vision Monday "30 Under 30" (2025). Speaker at WashU Bay Area Entrepreneur Summit.
  - **Dr. Kelly Cai, OD** — COO. Doctor of Optometry from UC Berkeley. Practicing optometrist since 2018. Met Colton through LinkedIn while working at Manhattan Eye, Ear & Throat Hospital in 2022. Recognized as "Most Influential Women in Optical" by Vision Monday (2024).
- **Positioning:** "AI-powered eye care operating system" — EHR + PM in one platform
- **Endorsement:** First and only EHR endorsed AND invested in by AOAExcel (Nov 2024)
- **Target:** Optometry, ophthalmology (expanding), independent eye care practices
- **Cloud-based** (not local-first) — runs on Google Cloud Platform (GCP)
- **Practices onboarded:** 200+ (as of Aug 2025 Series A announcement)
- **Growth:** 10x year-over-year (per LinkedIn post)

---

## Origin Story: Fractal Software Venture Studio

**CRITICAL CONTEXT:** Barti was NOT a typical founder-started company. It was created through **Fractal Software**, a New York-based venture studio that churned out 130+ vertical SaaS startups between 2020-2023.

### How Fractal Worked:
- Recruited aspiring entrepreneurs (bankers, consultants, PMs) as EIRs
- Gave each startup $1M via SAFE note at $4-6M post-money valuation
- Provided cofounder matching, analysts, recruiters, legal setup
- Fractal took ~47.5% ownership stake (massive by startup standards)
- Bienville Capital (NYC asset manager) was the silent LP financing the studios

### Fractal's Collapse:
- By mid-2023, many Fractal startups were struggling to raise external funding
- VCs called Fractal companies "uninvestable" due to cap table structure
- Major VCs (Insight Partners, a16z, Addition) "blacklisted" Fractal companies
- 9 portfolio companies shut down or dissolved
- Fractal stopped creating new companies in June 2023

### Barti Was the Exception:
- Barti was one of the few Fractal companies to successfully raise external funding
- Named to Bain Capital Ventures + Headline's "Top 50 Emerging Vertical SaaS" list (2023)
- Featured in Business Insider as one of only two Fractal success stories
- Successfully raised seed from Vertical Venture Partners and Zag Capital ($4.5-5M)
- Eventually broke free of the Fractal stigma with the AOAExcel endorsement and Series A

**OSOD takeaway:** Barti's origin in a venture studio explains both its strengths (rapid initial build, Silicon Valley engineering talent) and potential weaknesses (cap table complexity, not born from deep clinical passion). Colton is a business guy, not a clinician — Kelly Cai brings the clinical credibility.

---

## Funding History

| Date | Round | Amount | Lead Investor | Other Investors |
|------|-------|--------|---------------|-----------------|
| 2022-11-28 | Seed | $4.5M | Vertical Venture Partners | Zag Capital, Bienville Capital |
| 2023-11-30 | Grant | Unknown | — | — |
| 2024-11 | Strategic | Unknown | AOAExcel | (first-ever EHR investment by AOAExcel) |
| 2025-08-25 | Series A | $12M ($15.08M per Crunchbase) | Five Elms Capital | Health Engine, Correlation Ventures |
| **Total** | | **$19.58M** | | |

### About Five Elms Capital (Series A Lead):
- Growth investor in software businesses. $3B+ AUM. 80+ professionals. 70+ portfolio companies.
- NOT Google, NOT GV, NOT Alphabet — this is a Kansas City-based software PE/growth firm
- Partner Ryan Mandl led the deal

### The "Google Connection" Explained:
- **Barti is NOT Google-backed or Google-invested.** The Google association comes from:
  1. **Google Cloud Platform partnership** — Barti partnered with GCP engineers to build the AI Office Copilot (announced Oct 2024). Quote: "We're excited to collaborate with Google as one of their customers and partners."
  2. **Alexander Wolfe** (VP of Product & Engineering, May 2023 - May 2025) — ex-Google. Was Head of UX for Cloud.google.com (2015-2016), VP of UX at Firebase (acquired by Google in 2014), then ran Wolfe Studios doing contract work for Google Video Intelligence and Google Hive
  3. **Reddit comment:** "The people designing it are from Google" (u/NellChan, Jan 2025)
  4. **Engineering team likely has ex-Google talent** from SF Bay Area hiring pool
- Investors who DID back Barti: Five Elms Capital, Vertical Venture Partners, Zag Capital, Health Engine, AOAExcel, Bienville Capital, Correlation Ventures

---

## Leadership & Key People

### Colton Calandrella — CEO & Co-Founder
- WashU BSBA '17 (Olin Business School)
- Previously co-founded CheckTheQ (per Crunchbase)
- Associate role 2019-2021 (likely Fractal/finance)
- Vision Monday "30 Under 30" (2025)
- WashU Bay Area Entrepreneur Summit speaker
- Writes on aiineyecare.com
- Not a clinician — business/ops background

### Dr. Kelly Cai, OD — COO & Co-Founder
- UC Berkeley School of Optometry (OD)
- Practicing optometrist since 2018
- Was at Manhattan Eye, Ear & Throat Hospital in 2022 when she met Colton via LinkedIn
- Vision Monday "Most Influential Women in Optical" (2024)
- Brings clinical credibility and workflow knowledge

### Alexander Wolfe — Former VP of Product & Engineering (May 2023 - May 2025)
- **This is the key "Silicon Valley engineer" behind Barti's product**
- Career: AdRoll (Head of UX/Frontend) -> Firebase (VP UX, pre-Google acquisition) -> Google (Head of UX for Cloud.google.com) -> Wolfe Studios (Google contracts) -> Teleport (VP UX) -> Pachyderm -> **Barti**
- At Barti: Led full redesign and rebuild. Hired and mentored 10 engineers. Drove Google partnership. Contributed 150K+ lines of production code. Owned roadmap and sprint planning.
- Left May 2025 — just before the Series A announcement (notable timing)
- Now appears to be founding "Wolfe Health" (health insurance guidance)

### Known Engineering Team (from LinkedIn):
- **Steve Davis** — Staff Software Engineer
- **Luca Palonca** — Senior Software Engineer (Italy-based, remote)
- **Jay Lam** — role unknown

---

## Tech Stack (CONFIRMED)

### Frontend (from job posting):
- **React** (component-based)
- **Next.js** (framework)
- **TypeScript**
- **Styled Components** + CSS/Sass
- **GraphQL**
- **Figma** for design-to-code
- **GitHub** for version control

### Infrastructure (from SRE job posting):
- **Google Cloud Platform (GCP)** — primary cloud
- **Google Kubernetes Engine (GKE)** — container orchestration
- **Cloud SQL** — managed database (likely PostgreSQL or MySQL)
- **Docker** + Kubernetes
- **Terraform** or similar IaC
- **GitHub Actions** or CircleCI for CI/CD
- **Prometheus/Grafana/Datadog** for monitoring
- **Python, Go, or Bash** for scripting

### Marketing/Support:
- **Webflow** for marketing site (cdn.prod.website-files.com)
- **Zendesk** for help center (support.barti.com)
- **Ashby** for hiring/ATS (jobs.ashbyhq.com/barti)
- **YouTube** channel: @bartisoftware

### What This Tells Us:
- **Nearly identical stack to OSOD** (React, TypeScript, PostgreSQL-likely)
- The difference: Barti is cloud-native on GCP. OSOD is local-first.
- GraphQL vs REST is a design choice — Barti chose GraphQL
- Next.js suggests SSR/SSG approach vs. OSOD's likely SPA approach
- GKE + Cloud SQL = expensive to run per-practice, but infinitely scalable

### Salary Benchmarks (from job postings):
- Senior Frontend Engineer: $140K-200K + 0.2-0.4% equity
- Senior SRE: $150K-200K + equity
- All roles: Remote, unlimited PTO, full medical/dental/vision

---

## Product — Modules & Features

### Core Platform

| Module | Features |
|--------|----------|
| **Exam/EHR** | AI Scribe, one-tab charting, auto-populated notes, machine integration, specialty templates (myopia, VT, dry eye) |
| **Calendar** | Real-time scheduling, online booking, provider availability, no double-booking |
| **Messaging** | 2-way texting, automated reminders/recalls, review capture |
| **VoIP** | Phone calls from EHR, call logging to patient chart, unified communication log |
| **Optical/CL Ordering** | VisionWeb integration (glasses/frames), FAIT (contact lenses), distributor connections |
| **Billing** | Trizetto clearinghouse integration, CMS 1500 claims, invoice tracking, payment posting |
| **Patient Intake** | Mobile-friendly digital forms, auto-populate to chart |
| **Patient Portal** | (included in Core) |
| **Expense Management** | (included in Core) |
| **Payment Processing** | (included in Core) |
| **ePrescribe** | (Premium+ tier) |
| **eFax** | HIPAA compliant (Premium+ tier) |
| **Website** | Creation and hosting (Premium+ tier), custom design (Copilot tier) |

### AI Suite (10+ tools as of March 2026)

| AI Tool | Function |
|---------|----------|
| **AI Scribe** | Real-time charting during patient visits. First in optometry. Understands clinical eye care language. Populates structured chart fields, dropdowns, CPT/diagnosis codes from voice. |
| **AI Office Copilot** | Built with Google Cloud Platform engineers. Answers incoming calls via VoIP, schedules appointments, collects patient info, enters into calendar — all real-time. Announced Oct 2024. |
| **AI Receptionist** | 24/7 phone agent. Books appointments, handles natural conversation. Practices using it report 10-20% more appointments/month. Demoed live at Vision Expo 2026. |
| **Quinn** | Named AI Agent. Transforms documentation — speak through exam, say "code for me," and Quinn handles everything. Saves 1-2 hours/day. Practices seeing 1-2 additional patients/day. |
| **AI History** | (Details limited — likely auto-populates patient history) |
| **AI Smart Scan** | (Details limited — likely clinical image analysis) |
| **AI Guidelines** | (Copilot tier — likely clinical decision support) |
| **3 more unnamed** | Part of "10 AI tools" suite as of Vision Expo 2026 |

### Announced Roadmap (from Series A):
- **AI Agents to automate 80%+ of routine admin work**
- AI handling calls, optimizing inventory/pricing, scrubbing/submitting claims, analyzing clinical images
- **By 2027:** Practices using voice to manage most work, eliminating repetitive tasks
- **Financial tools** for practice visibility and control
- **Ophthalmology expansion** (beyond optometry)
- "Business in a box for modern eye care practices"

---

## Pricing

| Tier | Monthly | Annual (10% off) | Includes |
|------|---------|-------------------|----------|
| Core | $400 | $360 | EHR, PM, scheduling, messaging, patient portal, payments, expense mgmt |
| Pro | $750 | $675 | + optical/CL ordering, enhanced billing |
| Premium | $950 | $855 | + ePrescribe, eFax, website hosting |
| Copilot | $1,500 | $1,350 | + AI Scribe, AI History, AI Smart Scan, AI Guidelines, custom website design |

- Additional providers: $400/mo per FTE (>30 OD hours/week)
- RCM: 6% medical, 4% vision
- "Go live in under 2 hours" onboarding claim

---

## Integrations Confirmed

| Integration | Purpose |
|-------------|---------|
| **VisionWeb** | Glasses/frame ordering |
| **FAIT** | Contact lens ordering |
| **Trizetto** | Clearinghouse — claims submission |
| **Google Maps** | Online booking widget |
| **Google Cloud Platform** | AI infrastructure |
| **Topcon** | Diagnostic equipment |
| **Marco** | Diagnostic equipment |
| **Huvitz** | Diagnostic equipment |
| **Reichert** | Diagnostic equipment |
| **Akrinos** | Partnership (May 2024, details unclear) |

---

## Market Positioning & Traction

### Key Claims:
- 200+ practices in 3 years (as of Aug 2025)
- 10x year-over-year growth
- "First AI Scribe in optometry"
- "First and only EHR endorsed by AOAExcel"
- "10x more uptime than leading competitors"
- Selected for Vision Expo's first-ever "Call for NEW" innovation showcase (March 2026)
- Bain Capital Ventures Top 50 Emerging Vertical SaaS (2023)

### Named Customers:
- Sampalis Eye Care (Dr. Maria Sampalis)
- Peek-a-Boo Optometry for Kids (Dr. Amber Wiggins — cold start practice)
- Lumos Eyecare (Dr. Kiranjeet Sran)
- Hidden Valley Eye Care (Dr. Mackay — saves 1 hour/day)

### Press Coverage:
- Axios Pro (exclusive Series A coverage, Erin Brodwin)
- Business Insider (Fractal studio story, prominently featured)
- Vision Monday (multiple articles)
- Ophthalmology Times
- Women in Optometry
- Review of Optometric Business
- Modern OD
- Eyes on Eyecare / Glance
- PR Newswire
- WashU Skandalaris Center

---

## Reddit Intelligence (Full Threads Mined)

### Thread 1: "Barti EHR?" (r/optometry, Jan 2025, 2 comments)
- OP skeptical about AOAExcel endorsement
- Key comment: **"Companies pay AOA Excel to be endorsed, it's not necessarily an indication of a superior product. I've had a chance to try Barti and it's basically a big Google doc with a language AI built in. The people designing it are from Google."** (u/NellChan)
- This is the source of the "Google" connection rumor

### Thread 2: "New EHR - Barti" (r/optometry, Aug 2025, 22 comments) — MOST VALUABLE
- Office in trial switching from Revolution. Key comments:
- "No integrated billing is an absolute no go for me" (9 upvotes) — billing since added via Trizetto
- "They have a long ways to go" (7 upvotes, u/scrupio)
- "Don't forget about diagnostic equipment integration" (5 upvotes) — equipment integration is make-or-break
- "It's a closed system which means you're stuck with their features" (2 upvotes, u/FairwaysNGreens13)
- "I couldn't trust them" — unnamed concerns
- "The telephone integration is not ready for production use yet. It's a couple years away" (u/spittlbm)
- Positive: "Having used both Barti and Rev, Barti is still quite new but very easy to use. Still prefer it over Rev" (6 upvotes)
- Positive (later user): "Machine integration with Topcon, Marco, Huvitz, and Reichert. They keep adding new features every month" (u/shixal)
- User switching FROM Eyefinity: "I literally just tried making a post about this. We're looking into switching to Barti from Eyefinity" (u/tobiaspepperman)
- OP's reason for considering: "Barti includes phones, messaging, claims, etc all in one. Whereas with Rev, we've added on all of those things/pay for them separately"

### Thread 3: "Bart vs Revolution EHR?" (r/optometry, Jan 2026, 7 comments)
- "Revolution EHR tends to be a community favorite. Barti's AI package is rudimentary and limited" (3 upvotes)
- "Revolution was very easy to learn for my staff. PM and EHR integrate flawlessly (unlike Eyefinity)" (2 upvotes)
- "Both suck" (1 upvote, u/Tubby_Custard7240)

### Thread 4: "Barti EHR Software" (r/OptometrySchool, Aug 2025, 0 comments)
- 6-OD practice on Eyefinity looking to switch. "Seems too good to be true, but I cannot find user reviews." No responses.

### Thread 5: "Anyone ready to throw their practice management software?" (r/optometry, Jul 2025, 36 comments) — MARKET PAIN VALIDATION
- 21 upvotes, strong resonance
- "15 clicks to do basic tasks, crashes whenever more than 3 people logged in"
- One practice uses 3 SEPARATE EHR systems simultaneously
- Community favorites: Revolution EHR, Crystal PM
- "I have yet to use an EHR that does everything well" (7 upvotes)

---

## Weaknesses / Gaps (Research-Based)

1. **No public API** — "vendor has not shared information about third-party integrations" (softwarefinder). Closed system.
2. **No mobile app** — web-only
3. **Cloud-only** — no local/offline option. Data lives on their servers (GCP).
4. **Fractal venture studio origin** — cap table complexity, VC concerns about founder equity
5. **Small user base** — 200+ practices vs Revolution's 13,000+ or Crystal's established base
6. **VP of Engineering left** — Alexander Wolfe departed May 2025, just before Series A
7. **Reddit skepticism** — "basically a big Google doc," "long ways to go," "closed system," "can't trust them"
8. **AI described as "rudimentary and limited"** by r/optometry community (Jan 2026)
9. **Phone/VoIP "not ready for production"** (per user feedback, though they've since iterated)
10. **No aesthetics, no multi-service** — optometry/ophthalmology only. No concept of cross-specialty practice.
11. **Pricing** — $400-1,500/mo is significant for independent practices
12. **Young company risk** — founded 2021, still early. SaaS in healthcare has high churn.
13. **Reviews** — only 14 reviews total (4.8/5 on softwarefinder). 100% positive but tiny sample.

---

## Help Center (MINEABLE)

**URL:** https://support.barti.com/hc/en-us/

Full training documentation with video walkthroughs for every module:

| Module | Video Length | Help Article |
|--------|-------------|--------------|
| Profile/Org Settings | video | Yes |
| User Management | 2 min | Yes |
| Home Screen | 2 min | Yes |
| Patient Profile | 5 min | Yes — Overview: Patient Profile |
| Intake Form | 1 min | Yes — Overview: Patient Intake |
| Scheduling | 6 min | Yes — Overview: Appointments |
| Recurring Blocks | 3 min | Yes |
| Online Booking | 2 min + 3 min setup | Yes |
| Exam Overview | 10 min | Yes |
| Billing — Services | 3 min | Yes |
| Billing — Inventory | 5 min | Yes |
| Billing — Invoice from Optical | 2 min | Yes |
| Billing — Invoice from Exam | 3 min | Yes |
| Billing — Payment Posting | 3 min | Yes |
| Messaging Center | 3 min | Yes — Overview: Communication Center |
| Appointment Reminders | 3 min | Yes |
| ePrescribe | 1 min | Yes |
| Optical Ordering | 3 min | Yes |
| Claims Management (CMS 1500) | 3 min | Yes |
| AI Scribe | 2 min | Yes |
| VoIP Setup | — | Yes — Enabling VoIP Phones |
| eFax | — | Yes — Getting started with Barti Efax |
| Google Reviews | — | Yes — Setup Google Review |

**Other help articles found:**
- Barti Administration - Account Settings
- Barti Administration - Organization Settings
- Barti Onboarding Integration Timelines
- VoIP Speed Dial for Internal Phone Transferring
- Porting a Phone Number into Barti

---

## YouTube Channel

**Channel:** @bartisoftware (24 subscribers as of March 2026 — tiny)

**Key videos:**
- "How Barti Is Using AI to Modernize Eye Care Practices" (Vision Expo 2026) — https://www.youtube.com/watch?v=7XxNgyqkHko
- "Barti Software: EHR and Practice Management Software" (overview) — https://www.youtube.com/watch?v=htEHxaqCU4c
- "Barti EHR Revolutionizing Eye Care Technology" — https://www.youtube.com/watch?v=Xb9berfc31M
- "Swiping Right on the Perfect EHR with Barti" (podcast ep 26) — https://www.youtube.com/watch?v=H6asYAmnnYk
- "AI that fits today with Colton Calandrella" (Nerdy Optometrist podcast, ep 89) — https://www.youtube.com/watch?v=1hpwITgSDwI

---

## "Anthropic Exposed Their Data" — Investigation

**No evidence found of a Barti-specific data breach or leak.** Searches across security news, breach databases, and optometry forums turned up nothing.

What WAS found:
- **Eye Care Leaders** had a massive breach in Dec 2021 — their myCare Integrity platform was hit by ransomware, affecting 1.5M+ patients across multiple eye care practices. This is the biggest eye care software breach in recent history, but it's NOT Barti.
- The "Anthropic exposed their data" comment may refer to:
  1. Claude/AI being able to scrape their website, help center, and public info (which we just did)
  2. Their Webflow marketing site exposing internal content via CDN URLs
  3. Their Zendesk help center being publicly accessible (no login required)
  4. Some other incident not publicly documented
- **Barti claims "best-in-class security and HIPAA compliance"** and runs on GCP infrastructure

---

## OSOD vs Barti — Strategic Positioning

| Aspect | Barti | OSOD |
|--------|-------|------|
| **Cost** | $400-1,500/mo | Free (open source, AGPL v3) |
| **Deployment** | Cloud only (GCP) | Local-first (your hardware) |
| **Data ownership** | Barti's GCP servers | Your office, your hardware |
| **API access** | None public (closed system) | Full API (by design) |
| **Customization** | Limited to their feature set | Unlimited (open source) |
| **AI** | Proprietary (GCP-based, 10+ tools) | Claude/OpenClaw integration |
| **Community** | Customer support only | Community-built, open contribution |
| **Specialty coverage** | Optometry + expanding to ophthalmology | Optometry + aesthetics + multi-service |
| **Multi-service** | None — single-specialty only | Core architecture, cross-specialty patients |
| **GHL integration** | None | Native (through PerformanceOD) |
| **Foxfire migration** | Unknown | Designed for it |
| **Origin** | VC-backed venture studio startup | Clinician-built open source |
| **Tech stack** | React/Next.js/TypeScript/GraphQL/GCP | React/TypeScript/PostgreSQL/local |
| **Team size** | 11-50, $19.58M raised | Solo founder + community |
| **Practices** | 200+ | 0 (building) |

### Where Barti Beats OSOD (today):
1. **Shipping product** — 200+ practices live, real users, real feedback
2. **AI features** — 10+ AI tools, AI Scribe has 18+ months of production use
3. **Funding** — $19.58M means they can hire, market, and iterate fast
4. **Equipment integrations** — Topcon, Marco, Huvitz, Reichert already working
5. **AOAExcel endorsement** — institutional credibility
6. **All-in-one** — EHR + PM + VoIP + messaging + website in one login
7. **Onboarding** — "Go live in under 2 hours" with dedicated support

### Where OSOD Beats Barti (architecturally):
1. **Free** — $400-1,500/mo savings per practice, every month, forever
2. **Local-first** — Your data never leaves your office. No cloud dependency.
3. **Open source** — Community can contribute, customize, extend. No vendor lock-in.
4. **Full API** — "Closed system" is Barti's #1 weakness per Reddit
5. **Multi-service** — Optometry + aesthetics + any clinical vertical. Barti is eye-care only.
6. **Clinician-founded** — Eric practices in both optometry AND aesthetics. Colton is a business guy.
7. **No VC pressure** — No cap table drama, no pressure to hit ARR targets, no Fractal baggage

### OSOD's Critical Threats from Barti:
1. **Speed** — They're shipping. We're building. The gap widens every month.
2. **AI moat** — 18+ months of production AI scribe data is a real advantage
3. **AOAExcel** — Institutional endorsement means practices trust them by default
4. **Equipment integration** — This is table stakes. OSOD needs it by Phase 2-3 or it's disqualifying.
5. **"Business in a box" narrative** — Independent ODs want turnkey. Open source has perception problem.

---

## What ODs Care About Most (from Reddit, ordered)

1. **Billing/claims integration** — deal-breaker if missing
2. **Equipment/machine integration** — Topcon, Marco, Huvitz, Reichert
3. **Number of clicks** to complete tasks
4. **Stability/uptime** — crashes are rage-inducing
5. **All-in-one** — phones + messaging + claims in one system
6. **Staff learnability**
7. **Openness/integrations** vs closed system
8. **Price**

---

## Intelligence Still Needed

- [ ] Mine Barti YouTube videos for UI screenshots and workflow details (especially Vision Expo 2026 demo)
- [ ] Scrape full support.barti.com help center for functional specs
- [ ] Monitor Barti's Ashby job board for new roles (signals priorities)
- [ ] Track Reddit mentions monthly for sentiment shifts
- [ ] Find out who replaced Alexander Wolfe as VP Engineering
- [ ] Research Barti's ophthalmology expansion moves
- [ ] Check if Barti files for ONC certification
- [ ] Monitor if Barti adds aesthetics or multi-service capability
- [ ] Investigate "Quinn" AI agent capabilities deeper (is it agentic AI or just voice transcription?)
