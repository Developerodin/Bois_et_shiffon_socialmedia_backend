I've reviewed all six screenshots: Pinterest, Instagram, Facebook Page, Threads, LinkedIn and X.

I think we should approach this as a **complete analytics UI refinement across all social channels**, rather than improving each page independently.

Your existing visual identity is good: neutral background, white cards, dark buttons, subtle borders and restrained platform colours. I would preserve all of that.

The real problem is that the analytics pages currently feel like six different experiences. Instagram and Facebook have dashboards, Pinterest has a small information card, and Threads, LinkedIn and X have basic empty states with enormous unused space.

We need one consistent analytics experience that adapts to each platform's actual capabilities.

# **1. Issues across the six pages**


**Instagram — Screenshot 2**

Needs refinement

Five metric cards are crowded, descriptions get truncated, and the chart and supporting analytics need better hierarchy. The country and top-post sections are useful and should be retained.


**Facebook — Screenshot 3**

Needs refinement

The KPI cards and chart are good foundations, but there's excessive whitespace below the chart. The permission warning is too subtle and needs better presentation.


**Pinterest — Screenshot 1**

Needs improvement

A connected account displays only a small information card. The remaining workspace feels unfinished. It needs a proper analytics-unavailable or data-pending experience.


**Threads — Screenshot 4**

Needs improvement

The disconnected state is too small and isolated. Make the connection process more informative and visually integrated.


**LinkedIn — Screenshot 5**

Needs improvement

Manual publishing is explained, but the page offers almost no useful next steps. Build a proper manual-publishing workspace state.


**X — Screenshot 6**

Needs improvement

Same issue as LinkedIn. Reuse the common manual-publishing state, with X-specific messaging and actions.

# **2. My proposed universal analytics layout**

I recommend maintaining the same page structure across every channel.

**Instagram**

@boisandchiffons · Connected

Connected

**Performance overview**

7 days

14 days

28 days

Followers

# **2,715**

Accounts reached

# **39,304**

Views

# **159,417**

Interactions

# **229**

New followers

# **115**

**Reach over time**

Daily

Illustrative analytics chart, not actual account data.

0200400600800Oct 30Nov 1Nov 3Nov 5Nov 7Nov 9Nov 11Nov 13Nov 15Nov 17Nov 19Nov 21Nov 23Nov 26

Illustrative data for layout visualization only.

**Audience**

Top countries

France ━━━━━━

United States · United Kingdom

More audience insights

**Top content**

Best performing posts

**Post performance**

Reach · Engagement

This is the shared visual structure. The actual metrics, charts and insight cards must change based on the selected platform and available data.

# **3. Individual platform customizations**

This is particularly important. We should not display Instagram metrics on Facebook or force identical KPIs onto every platform.

| Platform  | Primary metrics                                                             | Supporting sections                        |
| --------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| Instagram | Followers, reach, views, interactions, new followers                        | Countries, top posts, content performance  |
| Facebook  | Followers, media views, engagements, page views, new followers              | Reach trends, audience, top posts          |
| Pinterest | Impressions, engagements, outbound clicks, saves, followers where available | Top Pins, boards, audience insights        |
| Threads   | Only metrics supported by the connected account/API                         | Post performance, audience where available |
| LinkedIn  | No API-derived metrics for manual publishing                                | Planned posts, publishing activity         |
| X         | No API-derived metrics for manual publishing                                | Planned posts, publishing activity         |

The table is a target metric architecture, not a claim that every existing integration provides these metrics.

### **Instagram**


[dashsocial.com](https://www.dashsocial.com/features?utm_source=chatgpt.com)

Preserve the five KPI cards and improve their presentation.

I would add:

- Percentage change against the previous equivalent period, only where calculation is supported.
- Better metric descriptions without clipping.
- More visual prominence for the chart.
- Better post thumbnails in Top Posts.
- Sorting by reach, interactions, saves and views where those values exist.

### **Facebook Page**


[buffer.com](https://buffer.com/resources/facebook-algorithm/?utm_source=chatgpt.com)

Keep the current layout, but add:

- A better breakdown of available engagement metrics.
- More useful audience or post-performance details when data supports them.
- A visible data-permission warning.
- A clear indication of when metrics were last refreshed.

The missing Facebook permissions should be presented as an actionable issue, not just tiny text underneath the chart.

### **Pinterest**


[brianacphotography.com](https://brianacphotography.com/blog/how-to-use-pinterest-to-grow-your-photography-business-and-get-leads-with-lean-on-meg?utm_source=chatgpt.com)

The current Pinterest connected card needs replacing with a proper analytics state.

Possible states:

- Account connected, analytics data available.
- Account connected, data unavailable or still being synchronized.
- Account connected, required analytics permissions missing.

Don't show fabricated metrics or empty chart cards just to fill the screen.

### **Threads**


[publer.com](https://publer.com/blog/schedule-threads-for-twitter-x-mastodon-bluesky/?utm_source=chatgpt.com)

Make the disconnected state more informative.

Show the platform identity, connection status, explanation of what becomes available after connecting, and a clear Connect Threads action.

### **LinkedIn and X**


**LinkedIn**


**X**

Since these are currently manually published, I would use a shared manual-publishing dashboard state.

Instead of a small message saying there are no analytics, provide:

- Manual publishing status.
- Explanation that Espanda doesn't receive analytics through this workflow.
- Plan posts action.
- Open native analytics action, where a verified destination is available.
- Upcoming scheduled/planned content if actual records exist.

This makes the pages useful even without an API analytics integration.

# **4. Layout problems that should be fixed everywhere**

These are the most important shared UI improvements.

| Element         | Current problem                             | Recommended improvement                            |
| --------------- | ------------------------------------------- | -------------------------------------------------- |
| Channel sidebar | Items feel disconnected from main dashboard | Consistent icon, name, handle and status hierarchy |
| Channel header  | Inconsistent identity presentation          | Standard reusable header component                 |
| Date controls   | Separate positioning and uneven spacing     | Standard segmented control                         |
| KPI cards       | Labels and descriptions clip                | Responsive grid with better typography             |
| Charts          | Inconsistent page composition               | Shared chart container and axis styling            |
| Insight cards   | Uneven content hierarchy                    | Standard two-column responsive grid                |
| Empty states    | Massive unused whitespace                   | Purposeful platform-specific state                 |
| AI assistant    | Consumes valuable dashboard width           | Fixed, independently collapsible panel             |

## **5. One particularly important layout decision**

Your current layout has three main areas:

**Channels**

Navigation

**Analytics workspace**

Flexible width

**Espanda AI**

Collapsible

Recommended layout proportions, illustrative only.

I'd preserve these three regions but improve their sizing behaviour.

The analytics workspace should have priority over the assistant panel. At smaller desktop widths, allow the assistant to collapse rather than squeezing the charts and metric cards.

Also, keep the assistant's content scroll independent, with the composer anchored to the bottom.

# **6. Ready-to-use Cursor implementation prompt**

I would give Cursor one unified task rather than six different prompts. This is important because shared components should drive all six pages.

# ESPANDA — COMPLETE SOCIAL CHANNEL ANALYTICS UI/UX REFINEMENT

Act as a senior SaaS product designer, frontend architect and experienced analytics dashboard engineer.

Refine the analytics experience across all six social channels:

1. Instagram
2. Facebook Page
3. Pinterest
4. Threads
5. LinkedIn
6. X

The objective is to establish a consistent, production-quality analytics design system while retaining platform-specific metrics, data capabilities and publishing workflows.

IMPORTANT: This is a UI and frontend architecture refinement, not an instruction to invent new analytics integrations.

## 1. Design principles

Preserve the existing Espanda / Bois & Chiffons design system.

Keep:

- Existing neutral grey page background.
- Existing white card surfaces.
- Existing dark primary buttons.
- Current purple accent usage.
- Current typography.
- Existing borders and corner radii.
- Existing platform brand icons.
- Global navigation.
- Channel sidebar.
- Right-side Espanda AI assistant.

Do not introduce a new colour palette.

Do not add a generic page-level "Analytics" heading. Retain the existing selected-channel identity header.

Do not redesign the entire application shell.

Focus on layout, spacing, reusable components, typography, information hierarchy and interaction quality.

Avoid unnecessary gradients, shadows, excessive card nesting and decorative elements.

## 2. First: Audit the current implementation

Before writing code, inspect:

- All six channel analytics pages.
- Shared channel layout.
- Analytics API integrations.
- Existing metric definitions.
- Chart components.
- Date-range selection logic.
- Platform-specific permissions.
- Account connection states.
- Manual publishing workflows.
- Right-side assistant integration.

Identify which components are already shared and which are duplicated.

Determine the actual analytics capabilities for each platform.

Do not assume that every platform supports the same metrics.

Do not replace working components merely to achieve visual consistency.

## 3. Build a reusable analytics workspace layout

Create or refine shared components for:

- ChannelSidebar.
- ChannelAnalyticsHeader.
- DateRangeSelector.
- AnalyticsMetricGrid.
- AnalyticsMetricCard.
- AnalyticsChartCard.
- AudienceInsights.
- TopPerformingPosts.
- AnalyticsDataNotice.
- AnalyticsEmptyState.
- PlatformConnectionState.
- ManualPublishingState.

Use the existing architecture and design tokens.

All six pages should follow the same overall layout.

### Workspace structure

Maintain:

1. Left channel navigation.
2. Main analytics workspace.
3. Right-side Espanda assistant.

The main analytics region must have flexible width.

The assistant should have a manageable fixed width on desktop and collapse into a drawer or overlay at narrower widths.

Prevent the assistant panel from unnecessarily compressing metric cards and charts.

Keep scrolling independent where appropriate.

The AI assistant composer should remain anchored to the bottom.

## 4. Shared channel header

Every channel page should use a consistent header structure.

Display:

- Platform icon.
- Channel name.
- Account handle or destination identity.
- Connection/publishing status.
- Open Calendar action.

Where available, display the data freshness timestamp.

Ensure that the selected platform remains visually clear.

Do not create separate header implementations for every channel.

## 5. Standardize the date-range selector

Use a reusable segmented selector.

Available existing ranges:

- 7 days.
- 14 days.
- 28 days.

Preserve existing date calculations and timezone handling.

Ensure:

- Consistent positioning.
- Consistent control dimensions.
- Clear selected state.
- Accessible keyboard interaction.
- Shared styling across channels.

Changing the date range should update all relevant metrics, charts and supporting data.

Do not fabricate historical values.

For pages without analytics data, hide irrelevant date controls where appropriate.

## 6. KPI / metric card system

Create a reusable responsive metric-card component.

Each card should support:

- Metric label.
- Main value.
- Optional comparison against the previous equivalent period.
- Optional trend indicator.
- Short explanatory description.
- Optional tooltip for additional context.

Requirements:

- Consistent heights.
- Clear numerical typography.
- No unintended text clipping.
- Appropriate responsive columns.
- No misleading zero values for unavailable data.

Support different metric counts per platform.

Use CSS Grid with responsive sizing rather than forcing five cards into a narrow workspace.

If metrics are unavailable, distinguish unavailable, loading and actual zero states.

Do not present unsupported metrics.

## 7. Platform-specific analytics

Retain each platform's supported metric definitions.

### Instagram

Preserve existing metrics:

- Followers.
- Accounts reached.
- Views.
- Interactions.
- New followers.

Refine:

- KPI grid.
- Supporting engagement breakdown.
- Reach/views trend chart.
- Followers by country.
- Top performing posts.

Top posts should have:

- Media thumbnail where available.
- Post title/caption preview.
- Post format.
- Publication date.
- Reach.
- Likes.
- Comments.
- Saves.

Keep existing sorting and data semantics.

### Facebook Page

Preserve existing metrics:

- Followers.
- Media views.
- Post engagements.
- Page views.
- New followers.

Refine:

- KPI grid.
- Main performance chart.
- Metric selector.
- Supporting insights where existing data supports them.
- Data freshness indicator.

The current Facebook permission warning must become a visible, appropriately styled informational/warning notice.

Explain which data is incomplete and why.

Where the application supports a permission-recovery workflow, provide the relevant action.

Do not imply that all metrics are unavailable when only certain Page post metrics are affected.

### Pinterest

Create a complete Pinterest analytics experience using only metrics actually available from the integration.

Potential metrics, only where supported:

- Impressions.
- Engagements.
- Outbound clicks.
- Saves.
- Followers.

Potential supporting sections, where data exists:

- Top Pins.
- Board performance.
- Audience insights.

Support distinct states:

A. Analytics available.\
B. Connected but data unavailable or still being synchronized.\
C. Connected but required permissions missing.\
D. Account disconnected.

Do not show a small generic information card surrounded by an empty workspace.

Do not show fabricated charts or placeholder metrics.

### Threads

Support:

- Connected state.
- Disconnected state.
- Analytics available state.
- Analytics unavailable state.

When disconnected:

- Display platform identity.
- Explain the connection state.
- Show a clear Connect Threads action.
- Briefly describe what will become available after connection.

When connected:

- Display only actual supported metrics and available content insights.

### LinkedIn

The existing publishing workflow is manual.

Create a dedicated manual-publishing dashboard state.

Display:

- Platform identity.
- Manual publishing status.
- Explanation that Espanda does not receive API analytics through this workflow.
- Plan LinkedIn posts action.
- Upcoming planned content if actual records exist.
- View native LinkedIn analytics action, using an existing verified destination where available.

Do not fabricate LinkedIn analytics data.

### X

Use the same reusable manual-publishing state as LinkedIn.

Customize:

- X branding.
- X-specific publishing explanation.
- Plan X posts action.
- Upcoming content where available.
- Native analytics destination where supported.

Do not duplicate the entire LinkedIn implementation.

## 8. Analytics chart system

Create a common chart-container component.

Standardize:

- Chart title.
- Subtitle/period label.
- Metric selector.
- Plot area.
- Axis typography.
- Grid lines.
- Tooltip presentation.
- Loading and error states.
- Empty states.

Requirements:

- Consistent card padding.
- Consistent chart heights.
- Readable labels.
- Appropriate number formatting.
- Accessible data tooltips.
- Responsive width.
- No clipped chart content.

Use existing chart libraries.

Do not introduce new chart dependencies unless required.

Never manufacture chart data to fill empty spaces.

## 9. Supporting insights

Standardize supporting sections across platforms.

Where real data exists, support:

- Audience demographics or geography.
- Top performing posts.
- Best performing content formats.
- Engagement breakdown.
- Post-performance tables.

Use a responsive grid:

- Two columns on wider desktop workspaces.
- One column on narrower workspaces.

Keep the information density balanced.

Do not force every platform to display every insight type.

## 10. Platform-specific empty and unavailable states

This is a critical requirement.

Do not render the same generic small message card on all unsupported pages.

Build a reusable state system with different presentation and messaging for:

A. Disconnected:\
Account needs to be connected.

B. Connected, analytics unavailable:\
Account is connected but Espanda cannot currently display analytics.

C. Data syncing or pending:\
Show this only when synchronization is genuinely in progress.

D. Permission restricted:\
Explain the missing permission and offer recovery if supported.

E. Manual publishing:\
Explain that metrics are not retrieved through the current manual workflow.

F. Error:\
Show a recovery action and distinguish temporary failures from unsupported functionality.

Each state must:

- Be visually integrated with the analytics workspace.
- Preserve the shared card design.
- Explain the current state.
- Have one relevant primary action.
- Have appropriate secondary actions.
- Avoid filling the screen with meaningless placeholders.

Do not confuse zero metrics with unavailable metrics.

## 11. Individual page refinements

Instagram:

- Preserve its existing audience and top-post sections.
- Improve KPI descriptions and chart hierarchy.
- Improve content previews.

Facebook:

- Improve chart presentation.
- Surface permission warnings.
- Add more useful supporting insights only where actual data is available.

Pinterest:

- Replace the isolated connection message with a proper analytics state.
- Prepare the shared layout for future analytics availability.

Threads:

- Build a polished connection state.
- Keep future analytics presentation consistent with the shared system.

LinkedIn and X:

- Reuse a common manual-publishing state.
- Show useful workflow actions.
- Do not invent analytics.

## 12. Responsive layout

Test:

- 1920x1080.
- 1768x900.
- 1440x900.
- 1280x720.
- Tablet.
- Mobile.

Desktop:

- Channel navigation remains usable.
- Analytics workspace uses available width.
- Assistant remains independently sized.
- KPI cards adapt to workspace width.

Smaller desktop:

- Allow assistant collapse.
- Reduce metric columns when necessary.
- Preserve chart readability.

Mobile:

- Stack metric cards.
- Use responsive chart layouts.
- Convert channel navigation to an appropriate compact navigation pattern.
- Make assistant accessible without consuming the entire viewport.

No page-level horizontal overflow.

## 13. Data integrity and technical constraints

Preserve:

- Existing API integrations.
- Existing metric definitions.
- Date-range semantics.
- Timezone handling.
- Connection models.
- Permissions and authorization.
- Publishing workflows.
- Post records.
- Platform-specific capabilities.

Do not:

- Invent metrics.
- Manufacture chart data.
- Convert unavailable data into zero.
- Claim unsupported integrations exist.
- Change backend APIs or database schemas for visual-only work.
- Introduce duplicate platform components.
- Break existing navigation.

Use appropriate loading, error, unavailable and empty states.

Keep components reusable and maintainable.

## 14. Final quality validation

Verify all six channel pages.

Specifically check:

1. Header consistency.
2. Sidebar alignment.
3. Date selector behaviour.
4. Metric card responsiveness.
5. Chart readability.
6. Top posts and audience sections.
7. Permission warnings.
8. Disconnected account states.
9. Manual publishing states.
10. Data freshness labels.
11. Assistant panel sizing and scrolling.
12. Responsive behaviour.
13. Actual API data integrity.
14. Browser console errors.

Run the actual application and inspect every channel at desktop dimensions.

Do not stop after the build succeeds.

The expected outcome is one consistent analytics platform with six appropriately personalized channel experiences, preserving the existing Espanda design identity.

# **7. Implementation order**

I wouldn't ask Cursor to implement everything in one massive pass without checkpoints.

**Phase 1 — Shared analytics foundation**

Highest priority

Build the common header, date selector, KPI cards, chart container and layout sizing.

**Phase 2 — Instagram and Facebook**

Refine the two existing analytics-heavy pages first. They establish the visual standard for the other channels.

**Phase 3 — Pinterest**

Build the connected-but-unavailable state properly and integrate actual analytics when available.

**Phase 4 — Threads, LinkedIn and X**

Create reusable connection and manual-publishing states instead of leaving empty workspaces.

**Phase 5 — Final responsive refinement**

Test the six pages together, including the channel sidebar and Espanda AI panel.

## **My final recommendation**

There are two things I particularly want you to get right:

**First: consistency without uniformity.** All six pages should have the same layout, spacing, typography and component behaviour, but their metrics and content should remain platform-specific.

**Second: meaningful empty states.** Pinterest, Threads, LinkedIn and X should never look like unfinished pages simply because analytics are unavailable. Every state should explain what is happening and give the user something useful to do.

That will make Espanda feel like a unified, mature social media analytics product rather than six separate platform integrations.
</pasted_content id="b8cc">

 