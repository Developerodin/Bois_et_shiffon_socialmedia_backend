Yes. I would connect the agents through a **single product-aware content generation workflow**, accessible from both the Channels page and Content Calendar.

There is one important architectural distinction: the six agents should not all independently create posts. They should work together, with each agent responsible for a specific stage and sharing the same product, channel and campaign context.

The most important requirement is that **product context must travel through the entire pipeline**, from Scout's research to the final Quality check. Merely adding a product dropdown to the frontend will not solve this.

## **1. The workflow we should implement**

Product-aware workflow

**User configures content generation**

Select channels, products, campaign and scheduling preferences.

**Product catalogue**

Real product records, images, SKUs and verified details.

**Target channels**

Instagram, Facebook, Pinterest and other selected destinations.

01

**Scout**

Idea generation

Research products, find content opportunities and rank ideas Recommend / Hold / Reject.

02

**Planner**

Scheduling

Turn shortlisted ideas into channel-specific posts with dates and product associations.

03

**Brief writer**

Creates a product-specific creative brief for each planned post.

04

**Creator**

Creates separate platform-specific captions, copy and media instructions.

05

**Quality**

Checks product accuracy, brand voice, platform compliance and content quality.

**Human approval**

Review required

Posts become ready for approval, not automatically published.

**06 · Analyst**

Separate learning loop

Analyses actual performance and generates learning notes that can inform future Scout and Planner runs. It is not a blocking stage in post generation.

**Important:** Scout should precede Planner when generating new ideas. If a user already has shortlisted ideas, they should be able to start directly at Planner. Both paths must activate the Brief writer → Creator → Quality chain.

## **2. Channel and product selection**

The user should have control over both dimensions before generation starts.

**Step 1 — Where should we publish?**

Illustrative selection interface; actual connection states must come from the integration.

Instagram

Connected

Facebook Page

Connected

Pinterest

Connected

Threads

Not connected

LinkedIn

Manual publishing

X

Manual publishing

3 destinations selected. This is an illustrative selector, not connected to your application.

**Step 2 — Which products should we promote?**

Choose products manually

Let Scout recommend products from my catalogue

Use the complete eligible catalogue as its discovery pool

Search products by name or SKU...

Selected products will be locked as the content-generation scope. A real implementation should display catalogue images, product names and SKUs.

**Step 3 — Content scope**

- Campaign or content objective.
- Planning period.
- Posts per channel.
- Preferred publishing days and times.
- Workspace timezone.

  All defaults should come from existing workspace settings when available.

I'd make manual product selection a first-class option, not an advanced feature hidden inside another menu.

Also, when the user opens generation from a particular channel page, that channel should already be selected. When opening from the calendar with a channel filter applied, inherit that selection as well.

## **3. One product, multiple channel-specific posts**

This is an important detail for the Creator.

Suppose the user selects a product called *TV Unit* and targets Instagram, Facebook and Pinterest.

The system should create three separate content variants connected to the same product, not reuse one generic caption across all platforms.


**TV Unit**

One selected catalogue product

Product-linked

**Instagram**

Carousel / Reel

Visual storytelling, caption, product-focused CTA

Separate draft

**Facebook**

Page post

Product introduction and engagement-oriented copy

Separate draft

**Pinterest**

Product Pin

Search-oriented title, description and product destination

Separate draft

Each post must retain its own:

- Channel/destination ID.
- Product ID or product IDs.
- Brief and visual direction.
- Draft version.
- Quality report.
- Approval status.
- Publishing status.

This ensures product-level traceability and independent approvals.

# **4. Where the workflow should live**

I would add entry points in three places, without disrupting your existing interface.

**A. Channels page —&#x20;**`/social`

Primary entry point

Add a secondary Create with agents action alongside your existing Connect channel, Analytics and Open full calendar controls.

**Create with agents**

Add a compact, collapsible Content workflow panel below the channel list, showing what each agent is doing and how many posts need attention. Do not add a page-level Channels heading.

**B. Content Calendar**

Primary entry point

Add Generate with agents beside New post. Keep New post for users who prefer to create content manually.

Generate with agents

\+ New post

When a channel filter or date is selected, inherit it in the generation wizard. Add product and agent-stage filters to the existing calendar where practical.

**C. Individual channel pages**

Contextual entry

Add Create posts with AI to Instagram, Facebook, Pinterest and other channel workspaces. Automatically select the current destination.

## **5. How the agent monitoring should work**

The user shouldn't have to visit Overview and manually run three agents just to finish a post.

Create one shared workflow-status component.

| Agent        | UI status/action                  |
| ------------ | --------------------------------- |
| Scout        | Ideas discovered · Find ideas     |
| Planner      | Posts planned · Plan selected     |
| Brief writer | Briefs pending · Auto-run         |
| Creator      | Drafts in progress · Auto-run     |
| Quality      | Checks running · Auto-run         |
| Analyst      | Insights available · Run analysis |

Show actual run status: Idle, Queued, Running, Completed, Needs attention or Failed.

The Analyst must appear as a separate learning capability, not as a mandatory step after Quality.

The user should be able to click a stage to inspect its outputs, errors and execution history.

## **6. Important backend architecture requirements**

These are the parts I would not compromise on.

**A. Shared orchestration between web and mobile**

Use the same backend workflow service for both clients. Web must not have a separate, incomplete agent chain.

The web's Plan posts action must initiate the downstream Brief writer → Creator → Quality sequence just like the mobile app's full-chain path.

**B. Product context must persist**

Each workflow should retain:

- Workspace and tenant.
- Selected channel destinations.
- Selected product IDs.
- Product selection mode.
- Campaign and idea IDs.
- Scheduling preferences.
- Workflow run ID.

Each generated post must retain its product association and channel identity. Every downstream agent must receive that same context.

**C. Product accuracy must be enforced**

All agents should use the actual catalogue as their source of truth.

They must not invent:

- Product specifications.
- Materials.
- Dimensions.
- Prices.
- Availability.
- Certifications.
- Country of origin.
- Warranty or delivery claims.

Missing information should be omitted or flagged for confirmation, not fabricated.

**D. Publication must remain approval-gated**

Quality passing does not mean publish automatically.

Connected, supported destinations can proceed through the existing approval and scheduling workflow. Manual destinations should become ready for manual publishing. Disconnected destinations must not receive attempted publishing requests.

# **7. Complete Cursor implementation prompt**

This is the implementation brief I'd use for the actual work. It covers frontend, backend orchestration, catalogue integration and testing.

# ESPANDA — PRODUCT-AWARE AI CONTENT WORKFLOW

## Integrate all six agents into Channels and Content Calendar

Act as a senior full-stack engineer, AI orchestration architect and SaaS product designer.

Implement a complete, product-aware content-generation workflow across Espanda's Channels page (/social), individual channel workspaces and Content Calendar.

This task involves frontend, backend, agent orchestration, persistence and testing.

This is NOT just a UI change.

The existing six agents are:

1. Scout
2. Planner
3. Brief writer
4. Creator
5. Quality
6. Analyst

Their responsibilities and existing orchestration must be preserved.

The most important requirements are:

- Properly connect the web agent chain.
- Allow users to select one or more target channels.
- Allow users to manually select products from the actual product catalogue.
- Allow Scout to recommend products automatically.
- Ensure every generated product-focused post remains linked to its actual product records.
- Generate channel-specific content variants.
- Display agent execution status in Channels and Calendar.
- Preserve human approval before publishing.
- Use the same orchestration implementation across web and mobile.

---

# PART 1 — AUDIT THE EXISTING SYSTEM

Before implementing anything, inspect the entire existing architecture.

## 1.1 Agent implementations

Locate all six agents.

Understand:

- Agent inputs.
- Agent outputs.
- Current prompt construction.
- Existing model/tool integrations.
- Context passed between agents.
- Current trigger mechanisms.
- Persistence of execution results.
- Error and retry handling.

Inspect the existing server-side chain:

Planner → Brief writer → Creator → Quality.

Understand exactly how the Planner's chain option works.

## 1.2 Web and mobile discrepancy

Compare:

Web:

- Plan posts from these ideas.
- How it invokes Planner.
- Whether chain mode is enabled.
- How the created posts are persisted.

Mobile:

- Generate calendar.
- How it invokes Planner.
- How the chain option is supplied.
- How downstream agents execute.

Identify the exact cause of the web workflow stopping after Planner.

Do not make an isolated frontend-only fix.

Use one canonical backend orchestration service for both clients.

## 1.3 Product catalogue

Inspect the existing Products module and actual product data source.

Determine which fields are available:

- Product ID.
- Product title.
- SKU.
- Description.
- Category.
- Product images.
- Price and currency.
- Inventory/availability.
- Product URL.
- Variants.
- Additional verified attributes.

Use the existing catalogue as the authoritative product source.

Do not create a second product catalogue for the AI agents.

## 1.4 Channel and account architecture

Inspect:

- Meta.
- Facebook Pages.
- Instagram.
- Pinterest.
- Threads.
- LinkedIn.
- X.

Identify account IDs, page IDs, connection states and publishing capabilities.

Treat Facebook Pages and Instagram as separate publishing destinations even when they share Meta connection infrastructure.

Distinguish:

- API-connected.
- Partially connected.
- Disconnected.
- Manual publishing.

Do not assume every channel supports automated publishing.

## 1.5 Existing content model

Inspect:

- Ideas.
- Campaigns.
- Planned posts.
- Briefs.
- Drafts.
- Quality reports.
- Approval records.
- Published posts.
- Analytics records.

Understand the existing status model before making changes.

Preserve current identifiers and data relationships wherever possible.

---

# PART 2 — IMPLEMENT PRODUCT-AWARE AGENT CONTEXT

This is the foundation of the entire feature.

All relevant agents must receive consistent product and channel context.

## 2.1 Product selection modes

Support three product selection modes.

### Mode A: Manual product selection

The user searches and selects one or more actual products.

This selection becomes a constraint for the complete workflow.

If the user selects products A and B, downstream agents must not silently replace them with products C or D.

Each generated post must retain the correct product IDs.

### Mode B: Scout-recommended products

The user asks Scout to discover relevant products from the catalogue.

Scout can evaluate:

- Product catalogue information.
- Existing campaigns.
- Business context.
- Brand positioning.
- Channel requirements.
- Previous performance learning, where available.

Scout must return recommended product IDs with explanations.

The user can accept, remove or replace recommendations before planning.

### Mode C: Catalogue discovery

Allow the user to use the eligible catalogue as Scout's discovery pool.

This does not mean blindly generating a post for every catalogue item.

Scout should prioritize relevant products and avoid unnecessary duplication.

The user should be able to review the shortlisted products and ideas.

## 2.2 Product selector UI

Implement a searchable, multi-select product picker using the existing Products API.

Product results should show:

- Thumbnail.
- Product title.
- SKU.
- Price when available.
- Stock state when available.

Requirements:

- Server-side search.
- Pagination or incremental loading.
- Search by product name and SKU.
- Multiple selections.
- Selected product chips.
- Easy removal of selected products.
- Clear loading and empty states.
- Correct workspace/tenant scoping.

Do not load the entire catalogue into the browser unnecessarily.

## 2.3 Product context propagation

Resolve the selected catalogue records and create a canonical product context.

Conceptually, every relevant agent receives:

- Product IDs.
- Product titles.
- Verified product descriptions.
- SKUs.
- Available attributes.
- Product image/asset references.
- Verified product URLs.
- Relevant pricing and inventory data where appropriate.
- Source metadata or timestamps where available.

Persist the product IDs across:

- Scout ideas.
- Campaign planning.
- Planned posts.
- Briefs.
- Creator drafts.
- Quality reports.
- Approval records.
- Published posts.

Use the existing data model and introduce migrations only where required.

Do not rely solely on adding product names to prompt text.

Product relationships must be persisted structurally.

## 2.4 Product-grounded generation rules

Every product-focused generated post must have at least one associated product ID.

Allow an explicit brand-only/content-without-product option, disabled by default.

In manual product mode:

- Use only selected products.
- Do not substitute unrelated catalogue products.
- Do not invent product attributes.
- Preserve product identity across all agent handoffs.

In Scout selection mode:

- Recommend relevant catalogue products.
- Explain why each product was selected.
- Allow manual override.

Use real product images and approved product assets when creating visual briefs.

Do not invent image references or product links.

## 2.5 Product-aware Quality checks

Add or refine Quality checks for:

1. Correct product identity.
2. Product ID consistency.
3. Product relevance.
4. Factual accuracy.
5. Unsupported product claims.
6. Correct product URL where used.
7. Price and stock claim freshness.
8. Brand voice.
9. Platform suitability.
10. Content quality.

If important product details are missing, flag them for confirmation.

Do not hallucinate specifications to make a draft look complete.

Revalidate dynamic information such as prices and stock before final scheduling or publishing, where those fields are used.

---

# PART 3 — CHANNEL SELECTION

Implement channel selection as a first-class part of content generation.

## 3.1 Destination selector

Allow users to select one or more target publishing destinations.

Use actual account and connection records.

Potential destinations:

- Instagram.
- Facebook Pages.
- Pinterest.
- Threads.
- LinkedIn.
- X.

For Facebook/Meta, show individual Facebook Page and Instagram destinations where available.

Do not show the Meta parent connection as an extra publishing destination if the actual destination is a Page or Instagram account.

Each selectable destination should show:

- Platform icon.
- Destination name.
- Account identity.
- Connection state.
- Publishing capability.

## 3.2 Connection-aware behaviour

Connected:\
Allow normal supported publishing workflows.

Disconnected:\
Do not attempt automated publishing.

Allow draft-only generation only with an explicit disconnected/draft-only selection and make the limitation visible.

Manual publishing:\
Allow agent-generated content but clearly mark the resulting post as manual publishing.

Partially connected:\
Evaluate each destination independently.

Never treat an account as publishable simply because its parent Meta connection exists.

## 3.3 Multi-channel content generation

When multiple channels are selected, generate separate channel-specific post variants.

Example:

Selected product: TV Unit.

Selected destinations:

- Instagram.
- Facebook.
- Pinterest.

Generate separate post records with:

- A shared workflow run ID.
- Appropriate product IDs.
- Individual channel IDs.
- Individual platform formats.
- Individual copy/caption.
- Appropriate visual brief.
- Separate quality reports.
- Separate approval and publication states.

Do not reuse the same generic caption for all platforms.

Do not automatically generate the Cartesian product of every selected product and every channel.

Planner should propose sensible product-to-channel groupings and allow users to review the total number of planned posts before generation.

---

# PART 4 — AGENT ORCHESTRATION

Implement a robust orchestration service.

## 4.1 Scout

Trigger:

- Daily automation.
- Manual Find Ideas action.
- Product-aware content generation workflow.

Responsibilities:

- Research available product opportunities.
- Use actual catalogue records.
- Use relevant campaign information.
- Consider channel-specific content opportunities.
- Generate product-linked content ideas.
- Rank Recommend, Hold or Reject.
- Explain the recommendation.

Every product-related idea must carry actual product IDs.

Scout should not create or publish final posts.

## 4.2 Planner

Trigger:

- Manual Plan Selected Ideas.
- Full workflow after idea shortlisting.
- Existing monthly automation.
- Existing mobile Generate Calendar flow.

Responsibilities:

- Convert shortlisted ideas/campaigns into dated posts.
- Respect selected channels.
- Respect selected products.
- Apply scheduling preferences.
- Create separate channel-specific planned posts.
- Preserve product and campaign relationships.

The web implementation must not start Planner with downstream chaining disabled when the user requests the full workflow.

## 4.3 Brief writer

Trigger:\
Automatically after Planner completes in chain mode.

Responsibilities:

- Generate a separate creative brief for each planned post.
- Carry product identity and verified attributes.
- Specify target platform and content format.
- Include visual direction and approved asset references.
- Preserve campaign objective and brand voice.

## 4.4 Creator

Trigger:

- Automatically after Brief writer.
- Existing New Post workflow.
- Quality-blocked revision.
- Approver-requested changes.

Responsibilities:

- Produce channel-specific content.
- Produce copy and captions.
- Follow channel-specific constraints.
- Preserve product references.
- Generate appropriate visual instructions.
- Version every revision.

Creator must receive the exact post's product IDs and target destination.

## 4.5 Quality

Trigger:\
Automatically after every Creator draft.

Responsibilities:

- Product accuracy.
- Catalogue identity validation.
- Brand voice.
- Platform compatibility.
- Unsupported claims.
- Caption/content quality.
- Visual brief consistency.
- CTA and link validity where relevant.

On pass:\
Move the post to the existing approval workflow.

On failure:\
Return actionable feedback to Creator for revision.

Prevent infinite revision loops. Use the existing retry policy or introduce a bounded retry policy with manual escalation.

## 4.6 Analyst

Analyst remains a separate, manual learning capability.

Responsibilities:

- Analyse available analytics.
- Create performance learning notes.
- Identify successful content patterns.
- Recommend future content directions.
- Make relevant learning available to future Scout/Planner runs.

Do not put Analyst in the mandatory sequential publishing chain.

Do not invent analytics when a channel lacks them.

---

# PART 5 — WEB AND MOBILE ORCHESTRATION MUST MATCH

This is one of the most important fixes.

Create or reuse a canonical server-side orchestration entry point.

Both web and mobile must use the same workflow contract.

Web:

- Plan posts from ideas.
- Generate product-focused content.
- Generate calendar.

Mobile:

- Existing Generate Calendar.

They must all correctly pass the full workflow context.

Conceptual workflow input:

{\
workspaceId,\
source,\
channelTargets,\
productSelectionMode,\
productIds,\
campaignId,\
ideaIds,\
schedulePreferences,\
chainMode,\
approvalRequired\
}

Map this to the existing API and type conventions instead of introducing duplicate endpoint contracts.

Ensure:

- Full chain enabled where requested.
- Context persists across agents.
- Jobs execute in the correct order.
- No duplicate runs after retries.
- Failed stages can be retried.
- Successful upstream stages are not unnecessarily repeated.
- Execution history is persisted.
- Tenant and workspace boundaries are enforced.

Use the existing queue/job infrastructure where available.

Do not implement the entire agent chain as fragile sequential browser requests.

The server must own the orchestration.

Use idempotency protection for workflow creation and agent retries.

---

# PART 6 — CONTENT GENERATION UI

Build a reusable Create with Agents workflow wizard.

## Step 1: Select destinations

Show all available channel destinations.

Allow multiple selections.

Display:

- Platform icon.
- Account name.
- Connection state.
- Direct publishing / manual / draft-only capability.

Preselect the channel when launching from an individual channel page.

Preselect the active channel filter when launching from the calendar.

## Step 2: Select products

Offer:

- Choose products manually.
- Let Scout recommend products.
- Use catalogue as a discovery pool.

Manual selection must use the existing searchable Products catalogue.

Allow multiple products.

Show selected product thumbnails, names and SKUs.

Make it explicit whether selected products are locked to the workflow or Scout is permitted to recommend alternatives.

## Step 3: Choose ideas and campaign source

Offer:

- Generate fresh ideas with Scout.
- Use shortlisted existing ideas.
- Use an existing campaign where supported.

If Scout runs:

- Display its recommended ideas.
- Show associated products.
- Show intended channel.
- Show recommendation rationale.
- Let users select/deselect ideas.
- Respect Recommend / Hold / Reject.

Do not automatically schedule rejected ideas.

## Step 4: Configure scheduling

Allow:

- Start/end date.
- Posting frequency.
- Posts per selected channel.
- Preferred days.
- Preferred time windows.
- Existing workspace timezone.

Use saved workspace preferences as defaults.

Do not invent scheduled times or disregard existing scheduling rules.

## Step 5: Review plan

Before execution show a plan preview.

For every proposed post show:

- Product.
- Target channel.
- Content idea.
- Proposed date/time.
- Content format.
- Planned post count.

Allow the user to adjust channel and product associations.

Show the total number of posts before starting the workflow.

Require confirmation before creating a large batch.

## Step 6: Start workflow

Provide a clear Start content workflow action.

Run:\
Scout, when new idea discovery is requested.\
Planner.\
Brief writer.\
Creator.\
Quality.

If existing shortlisted ideas are selected, start at Planner and execute the complete downstream chain.

End at human approval.

Do not auto-publish or bypass approval.

---

# PART 7 — INTEGRATE INTO CHANNELS PAGE AND CALENDAR

## 7.1 Channels page (/social)

Preserve the existing layout, colours and spacing.

IMPORTANT:\
The user intentionally removed the page-level Channels heading. Do not reintroduce it.

Keep the existing:

- Connect channel.
- Analytics.
- Open full calendar.
- Summary metrics.
- Channel list.
- Analytics sections.

Add:

- Create with agents action.
- Compact, collapsible Content workflow status component.
- Agent activity summary.
- Product/channel-aware generation wizard.

When launched from a channel row, preselect that channel.

When launched from a channel-specific workspace, preselect its exact destination/account.

Add lightweight contextual actions without overcrowding the existing channel rows.

## 7.2 Content Calendar

Preserve the existing calendar structure.

Add a Generate with agents action beside the existing New Post action.

Do not replace or remove New Post. It must continue supporting manual content creation.

The generation wizard should inherit:

- Currently selected channel.
- Selected calendar date, if applicable.
- Current campaign or post context, if applicable.

Add useful filters where practical:

- Product.
- Channel.
- Agent workflow stage.
- Approval status.
- Publication status.

Each calendar event should show:

- Channel icon.
- Scheduled time.
- Post title.
- Associated product name or compact product label.
- Agent workflow stage.
- Relevant approval/publication status.

Avoid excessively crowded event cards.

Clicking a post should open its existing detail experience.

## 7.3 Per-post workflow timeline

In the post detail view, show a timeline:

Scout idea (when applicable)\
→ Planned\
→ Brief ready\
→ Drafting\
→ Quality checked\
→ Awaiting approval\
→ Approved\
→ Scheduled / Ready for manual publishing\
→ Published

Show the actual stage, timestamp, agent execution status and meaningful error information.

Do not conflate:

- Agent execution state.
- Editorial status.
- Approval status.
- Publishing status.

Preserve existing status semantics and map legacy values carefully.

---

# PART 8 — AGENT MONITORING COMPONENT

Create one reusable Agent Workflow component for the Channels page and Calendar.

Display the six agents:

Scout\
Planner\
Brief writer\
Creator\
Quality\
Analyst

For each agent show:

- Current state.
- Last execution.
- Actual outputs or pending workload.
- Error state if applicable.
- Next actionable step.

Possible execution states:

- Idle.
- Queued.
- Running.
- Completed.
- Needs attention.
- Failed.

Actions:

- Scout: Run Scout.
- Planner: Plan selected ideas.
- Brief writer: Run/retry where dependencies allow.
- Creator: Run/retry where dependencies allow.
- Quality: Run/retry where dependencies allow.
- Analyst: Run analysis manually.

Do not permit users to bypass required upstream dependencies.

Downstream agents should execute automatically when the proper chain is active.

The Analyst must appear as a separate learning workflow.

Allow users to inspect execution details and retry eligible failed runs.

Keep the component compact and collapsible.

Do not create six permanently visible agent cards that dominate the calendar.

---

# PART 9 — WORKFLOW RELIABILITY

Implement appropriate:

- Persisted workflow runs.
- Individual agent execution records.
- Start and completion timestamps.
- Current stage.
- Error details.
- Retry state.
- Idempotency.
- Cancellation handling.
- Tenant/workspace authorization.

A workflow interrupted by an error should be resumable from the failed stage.

Do not regenerate already completed drafts unnecessarily.

Avoid duplicate planned posts and duplicate agent execution on network retry.

Preserve auditability and draft versions.

If an approver requests changes:

- Pass the actual reviewer feedback to Creator.
- Generate a new draft version.
- Run Quality again.
- Return the revised version to approval.

If Quality blocks a draft:

- Send specific blocking findings to Creator.
- Preserve the failed quality report.
- Retry within the configured limit.

---

# PART 10 — SECURITY AND DATA INTEGRITY

- Validate workspace ownership of every product.
- Validate workspace ownership of every channel account.
- Validate campaign and idea permissions.
- Never accept arbitrary client-provided product details as authoritative.
- Resolve products from the server-side catalogue.
- Enforce channel destination permissions.
- Respect account connection states.
- Avoid leaking one workspace's data to another.
- Do not expose publishing credentials or secrets to agent prompts unnecessarily.

Store actual IDs and relationships, not only descriptive strings.

---

# PART 11 — IMPLEMENTATION AND TESTING

Do not begin by changing several unrelated components.

Implement in controlled stages.

### Phase 1

Audit agent services, web/mobile calls, product models and channel models.

### Phase 2

Build the shared workflow orchestration and product/channel context propagation.

### Phase 3

Fix the web chain and verify parity with mobile.

### Phase 4

Implement product and destination selectors and the generation wizard.

### Phase 5

Integrate the wizard into /social, individual channel workspaces and Calendar.

### Phase 6

Implement agent status tracking, post timelines, retries and error states.

### Phase 7

Run full integration and regression tests.

Test scenarios:

1. Manually select one product and one channel.
2. Select multiple products and multiple channels.
3. Let Scout recommend products.
4. Scout recommends ideas, user rejects some and selects others.
5. Plan existing shortlisted ideas with the full downstream chain.
6. Ensure Brief writer runs after Planner.
7. Ensure Creator runs after Brief writer.
8. Ensure Quality runs after every Creator draft.
9. Verify product IDs remain consistent through every stage.
10. Verify separate channel-specific content variants.
11. Verify LinkedIn and X manual publishing.
12. Verify disconnected channel draft-only behaviour.
13. Verify Meta's Facebook Page and Instagram destination separation.
14. Verify approval-requested revisions.
15. Verify Quality-blocked revisions.
16. Verify failed-agent retries without duplicate posts.
17. Verify web/mobile orchestration parity.
18. Verify Analyst remains independent of the sequential chain.
19. Verify existing monthly automation.
20. Verify tenant isolation and authorization.

Run:

- Backend tests.
- Frontend tests.
- Type checking.
- Build.
- Relevant integration tests.

Inspect both the Channels page and Calendar in the actual browser.

Do not declare completion based only on a successful build.

## FINAL ACCEPTANCE CRITERIA

The implementation is complete only when:

1. Users can select the exact publishing destinations.
2. Users can manually select products from the real catalogue.
3. Scout can recommend products from the same catalogue.
4. Product IDs persist through all downstream agent executions.
5. Every product-focused post has a valid product association.
6. Creator produces distinct channel-specific content.
7. Planner activates the complete downstream chain on web.
8. Web and mobile use the same orchestration logic.
9. Quality verifies product claims and content quality.
10. Posts reach the existing human approval workflow.
11. Agent progress is visible on Channels and Calendar.
12. Each post exposes its workflow history.
13. Disconnected and manual-publishing channels are handled honestly.
14. The Analyst remains a separate performance-learning capability.
15. Existing functionality and design language are preserved.

Do not implement visual placeholders for workflows that are not connected to real backend execution.

The ultimate goal is a fully connected, product-aware AI content production system, not just an interface with six agent names and a Generate button.

## **8. How I'd prioritize the actual implementation**

| Priority | Deliverable                          | Why                                             |
| -------- | ------------------------------------ | ----------------------------------------------- |
| 1        | Fix web/mobile orchestration parity  | Otherwise the chain still stops prematurely     |
| 2        | Persist product and channel context  | Essential for reliable product-specific content |
| 3        | Manual product and channel selection | Gives users control                             |
| 4        | Separate channel-specific drafts     | Avoids generic cross-platform content           |
| 5        | Product-aware Quality validation     | Prevents unsupported product claims             |
| 6        | Channel and Calendar integration     | Makes the workflow accessible                   |
| 7        | Agent monitoring and retries         | Makes it production-operable                    |
| 8        | Analyst learning loop                | Improves future content decisions               |

**My strongest recommendation:** implement the backend context propagation and orchestration before polishing the Agent UI. Otherwise you risk building a beautiful workflow screen that still produces posts disconnected from the actual products or fails to execute the downstream agents.

The finished experience should let someone open a channel or the calendar, choose the products they want to promote, select where they want to publish, review Scout's ideas, and have the entire production chain generate platform-specific posts ready for approval.

