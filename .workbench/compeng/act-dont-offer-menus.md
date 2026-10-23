---
name: act-dont-offer-menus
description: "When told to remove or change something, carry it out instead of coming back with a menu of options to pick from."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 965997fb-e86d-4d68-ba72-16a5e52185ee
  modified: 2026-10-18T14:44:16.009Z
---

When the user says to get rid of something or to make a change, do it. Don't stop to present a
list of options to choose from, and don't re-ask after the user repeats the instruction.

**Why:** The user has already read the analysis by the time they give the instruction; a choice
menu makes them do the work twice and delays the result.

**How to apply:** Pick the reasonable interpretation, say in one line what it covers, and
implement it. If a part of the scope is a real trade-off (a rewrite that loses behavior), do
everything else in full and state plainly what was left out and why, as a sentence in the
summary rather than as a question. See [[concise-summaries]].
