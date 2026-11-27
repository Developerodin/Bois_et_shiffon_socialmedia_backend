This is moving in the right direction. The workflow is now visible on the Channels page, but its presentation still looks like a row of text labels rather than an actual AI agent pipeline.

I would improve it into a **compact, interactive workflow dashboard** that tells users what each agent has done, what is happening now, and what they need to do next.

There are also a couple of UX inconsistencies worth fixing before adding more features.

## **1. What's wrong with the current design?**

01

**The pipeline wraps awkwardly**

The arrows and final approval count wrap onto another line. This breaks the impression of one connected workflow.

02

**Every agent looks completed**

All five agents have green indicators, even though some have no work to process. A completed previous run is not the same as an active workflow stage.

03

**No obvious next action**

Scout has found 57 new ideas, but Planner has zero shortlisted ideas. The user should immediately see that those ideas need review.

04

**No distinction between output and pending work**

"5 to draft", "0 to check" and "7 awaiting approval" are difficult to interpret together. Clearly distinguish completed outputs, pending queues and approval counts.

05

**Analyst feels disconnected**

Analyst is correctly separate from the sequential chain, but should look like a distinct learning capability rather than an orphaned label underneath.

## **2. My recommended design**

I'd use five compact agent cards in a horizontal pipeline, connected by subtle directional indicators.

**Content workflow**

5 production agents · 1 learning agent

Workflow healthy

**Next action: Review Scout's ideas**

57 new ideas are waiting for your selection.

57 new

Review ideas&#x20;

Completed

**01 · Scout**

# **57**

Ideas discovered

Next: Review ideas

Waiting for input

**02 · Planner**

# **0**

Ideas shortlisted

Next: Plan posts

Idle

**03 · Brief writer**

# **0**

Briefs pending

Next: Create briefs

Completed

**04 · Creator**

# **5**

Drafts created

Next: Quality review

Idle

**05 · Quality**

# **7**

Awaiting approval downstream

Next: View quality results

Separate workflow

**06 · Analyst**

Performance learning

Run analysis when results are available.

Concept illustration. Values and stage states must be reconciled with actual workflow records before implementation.

This card layout is illustrative rather than something I'd necessarily display at full size permanently. For the actual page, I'd use compact horizontal cards on desktop and make their details expandable.

## **3. Five UX improvements I'd prioritize**

**A. Highlight the next action**

In your screenshot, Scout has 57 ideas but no shortlisted ideas.

The UI should automatically recognize this and prioritize:

**57 ideas ready for review**

Scout

Review recommendations, select products and choose which ideas to plan.

Review ideas →

After selection, the next action becomes Plan selected ideas.

**B. Differentiate agent states**

Use clear states:

| State             | Meaning                             |
| ----------------- | ----------------------------------- |
| Idle              | No work currently available         |
| Queued            | Waiting to execute                  |
| Running           | Currently processing                |
| Completed         | Last execution succeeded            |
| Waiting for input | User must take an action            |
| Needs attention   | Quality issue or approval needed    |
| Failed            | Execution failed and needs recovery |

Do not show all stages as completed simply because their last run succeeded.

**C. Make agent cards interactive**

Clicking Scout should open its idea results. Clicking Creator should show drafts. Clicking Quality should show quality reports and failed checks.

Each card should have a clear action based on its actual state.

**D. Separate Analyst**

Keep Analyst outside the production pipeline. It should have its own learning/insights presentation.

**E. Connect products and channels to the workflow**

Show a compact workflow scope:

`Products selected → Instagram + Facebook → 12 proposed posts`

This helps users understand what the agents are currently working on.

## **4. Cursor implementation prompt**

# Task: Refine Espanda Content Workflow UI/UX

Act as a senior SaaS product designer and frontend engineer.

Refine the existing Content Workflow component on the Channels page.

The current implementation displays the six agents in a text-based horizontal sequence. The design is cramped, arrows wrap onto another line, agent states are confusing, and the next required user action is not obvious.

Transform this into a polished, interactive agent workflow dashboard.

IMPORTANT:

- Preserve the existing Espanda/Bois & Chiffons design system.
- Do not change the colour palette.
- Do not redesign the Channels page.
- Do not add a page-level Channels heading.
- Preserve the existing summary metrics, channel list and actions.
- Keep the Content Workflow section collapsible.

## 1. Workflow header

Create a compact header with:

Left:

- Content workflow.
- Number of production agents.
- Number of learning agents.
- Optional overall workflow status.

Right:

- Expand/collapse control.
- Optional workflow activity/history link.

Improve the current oversized outlined Content workflow button.

It should look like a proper section header with a subtle divider and a clear chevron.

## 2. Production pipeline visualization

Display these five agents in sequence:

01 Scout\
02 Planner\
03 Brief writer\
04 Creator\
05 Quality

On desktop, present them as five horizontally aligned compact cards connected by subtle progress indicators.

The cards must:

- Have consistent dimensions.
- Use aligned content.
- Have restrained backgrounds and borders.
- Show stage number.
- Show agent icon.
- Show agent name.
- Show actual execution status.
- Show one key output or queue count.
- Show a concise next action where applicable.

Do not use a long text string with arrow characters.

Use CSS Grid/Flexbox and proper connectors.

The connector must never wrap independently onto a second line.

At medium widths, allow horizontal scrolling or a responsive two-row grid.

At mobile widths, stack stages vertically with a clear progression indicator.

## 3. Proper agent-state semantics

Implement distinct states:

- Idle.
- Queued.
- Running.
- Completed.
- Waiting for input.
- Needs attention.
- Failed.

IMPORTANT:

Execution status and queue count are different concepts.

For example:\
"Completed" means the last agent execution succeeded.

It does NOT mean there is work waiting for that agent.

Show execution status separately from output and pending workload.

Use:

- Completed: subtle green indicator.
- Running: restrained active indicator.
- Waiting for input: subtle amber indicator.
- Failed: restrained red indicator.
- Idle: neutral grey indicator.
- Queued: neutral/informational state.

Do not make every agent appear completed because a previous run was successful.

Do not use green dots for idle or blocked stages.

## 4. Show actionable output information

Display meaningful labels for each agent.

Scout:

- Ideas discovered.
- Ideas awaiting review.
- Recommended ideas.
- Next action: Review ideas.

Planner:

- Ideas shortlisted.
- Posts planned.
- Next action: Plan selected ideas.

Brief writer:

- Briefs created.
- Briefs pending.
- Next action: Create briefs.

Creator:

- Drafts created.
- Drafts pending.
- Next action: Generate drafts.

Quality:

- Checks passed.
- Checks failed.
- Checks waiting.
- Next action: Review quality results.

Source all figures from actual persisted workflow and post data.

Do not hardcode sample counts.

## 5. Dynamic next-action banner

This is a critical feature.

Determine the next actionable stage based on actual dependencies and current workflow state.

Examples:

If Scout has discovered ideas but none are shortlisted:\
"57 ideas are ready for review."\
Action: Review ideas.

If ideas are shortlisted but posts have not been planned:\
"5 ideas are ready for planning."\
Action: Plan selected ideas.

If posts are planned but briefs do not exist:\
"5 posts are waiting for briefs."\
Action: Generate briefs or execute the full chain.

If briefs exist but drafts are missing:\
"5 posts are waiting for drafts."\
Action: Generate drafts.

If Quality is blocked:\
"2 drafts need attention."\
Action: Review issues.

If posts await approval:\
"7 posts are awaiting approval."\
Action: Review approvals.

The next-action banner should represent the first actionable dependency, not simply the agent with the highest workload.

Use one prominent action at a time.

Avoid showing contradictory recommendations.

## 6. Workflow scope summary

Display a compact summary of the current or most recent generation scope.

Where data exists, show:

- Selected products.
- Selected publishing destinations.
- Campaign.
- Number of planned posts.
- Workflow run identifier or useful history link.

Example:\
"3 products · Instagram + Facebook · 8 planned posts"

Use real persisted workflow data.

If nothing has been configured yet, show an appropriate empty state and a Create with agents action.

Do not assume all posts in the workspace share the same workflow scope.

## 7. Analyst separation

Analyst is not part of the five-agent sequential publishing chain.

Move it into a separate compact learning/insights section.

Display:

- Analyst icon and name.
- Last analysis status.
- Available performance data.
- Last execution.
- Run analysis action.

Only run analysis when relevant performance data exists.

Do not block content generation when Analyst is idle.

## 8. Interactions

Every agent card should be clickable.

Scout opens:

- Ideas.
- Recommendation scores.
- Product associations.
- Recommend/Hold/Reject decisions.

Planner opens:

- Shortlisted ideas.
- Scheduling configuration.
- Planned content.

Brief writer opens:

- Generated briefs.
- Product associations.
- Pending work.

Creator opens:

- Drafts.
- Platform-specific content.
- Draft versions.

Quality opens:

- Quality checks.
- Passed results.
- Warnings.
- Blocking errors.

Analyst opens:

- Performance learning.
- Historical analysis.
- Recommendations.

Actions must respect workflow dependencies and permissions.

Do not let users bypass mandatory upstream steps.

## 9. Product and channel awareness

The workflow must reflect the actual product/channel-aware content generation system.

Display the selected products and destination channels.

Ensure each agent's displayed work counts refer to the relevant actual workflow records.

When the user opens Create with agents:

- Preserve preselected channel context.
- Support manual multi-product selection.
- Support Scout-recommended products.
- Support multiple channel destinations.
- Show planned post count before execution.

Preserve the existing full backend orchestration.

Do not use visual-only fake progress.

## 10. Consistency and reconciliation

Inspect how the current values are calculated.

The current screenshot shows:

- Scout: 57 new.
- Planner: 0 shortlisted.
- Brief writer: 0 to brief.
- Creator: 5 to draft.
- Quality: 0 to check.
- 7 awaiting approval.

Verify whether these numbers refer to:

- Last-run outputs.
- Current pending queue.
- Historical output totals.
- Different workflow runs.

Do not merge counts from unrelated runs.

Do not assume seven awaiting approval is the same as seven drafts created by the currently displayed run.

Make the distinction obvious in the UI.

If existing data is inconsistent, expose an appropriate reconciliation or error state instead of hiding the discrepancy.

## 11. Visual style

Use the existing design system.

- White and neutral surfaces.
- Thin borders.
- Existing dark buttons.
- Current purple accent usage.
- Restrained status colours.
- Consistent card heights.
- Compact typography.
- Subtle hover and focus states.

Do not introduce gradients, excessive shadows, giant agent icons or oversized cards.

The pipeline should feel sophisticated and operational, not decorative.

## 12. Responsive behaviour

Desktop:

- Five aligned production-stage cards.
- Clear connectors.
- Analyst as a separate capability.
- Next-action banner easily visible.

Medium screens:

- Compact cards with responsive grid or controlled horizontal scrolling.

Mobile:

- Vertical pipeline.
- Clear agent sequence.
- Accessible actions.
- No horizontal overflow.

Ensure the existing AI assistant panel does not compress the workflow into unreadable cards.

## 13. Technical constraints

Before implementation:

- Inspect existing workflow status APIs.
- Inspect agent execution records.
- Inspect queue counters.
- Inspect existing action handlers.
- Inspect product/channel workflow context.

Preserve backend orchestration and existing API contracts wherever possible.

Do not create mock metrics, fake progress, duplicate workflows or hardcoded statuses.

Keep the Analyst outside the sequential chain.

Do not trigger agents merely because the user expands the UI.

Opening cards should not initiate execution.

## 14. Validation

Verify:

1. Scout with ideas awaiting review.
2. Planner waiting for selected ideas.
3. Planner completed with posts created.
4. Brief writer pending.
5. Creator running.
6. Quality blocked.
7. Posts awaiting approval.
8. Failed agent with retry available.
9. Entire pipeline idle.
10. Analyst with and without analytics available.
11. Collapsed and expanded workflow states.
12. Responsive desktop, tablet and mobile layouts.

Run actual application tests and inspect the browser-rendered result.

Do not declare completion based only on compilation.

Expected result: A compact, highly usable visual representation of the six-agent system that clearly communicates progress, workload, dependencies and the next action.

## **5. One final change I'd insist on**

Your current screenshot contains this:

- Scout: 57 new
- Planner: 0 shortlisted
- Brief writer: 0 to brief
- Creator: 5 to draft
- Quality: 0 to check
- 7 awaiting approval

I would specifically ask Cursor to audit the relationship between those numbers. They may represent different runs or different queue definitions, but the interface should never present them as one uninterrupted live pipeline without explaining the distinction.

**My priority:** build the actionable next-step banner first, then the five-card pipeline. That will make the workflow genuinely useful rather than simply more attractive.


