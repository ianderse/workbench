import type { HumanWorkItem } from '../../../types/human-work';

/** Reworded CI review requests observed on ticket 191, 2026-10-29. */
const ciItems: HumanWorkItem[] = [
  {
    "id": "2286bdcd-089c-4f4a-819c-6378bb9d5239",
    "finding": {
      "severity": "major",
      "description": "Hosted PR deliberate-failure evidence not produced: sandbox cannot push, so no GitHub-hosted run exists. Local failure-injection through `npm run verify` was executed; DESIGN_DECISIONS ## 72 records hosted evidence as explicitly pending, not claimed. Requires an authorized push + PR run against a real SHA.",
      "requiresHuman": true,
      "file": "docs/DESIGN_DECISIONS.md"
    },
    "revision": 1,
    "owner": "",
    "status": "open",
    "response": "",
    "evidence": "",
    "at": "2026-10-28T21:39:58.723Z",
    "createdAt": "2026-10-28T21:39:58.723Z",
    "history": []
  },
  {
    "id": "7b927cd3-ebc4-4783-9131-8a6cfa0b7116",
    "finding": {
      "severity": "major",
      "description": "Pre-merge enforcement: docs previously described a hypothetical required-check as the mechanism. Documentation fixed to state the actual current mechanism (no branch protection exists; only the repo owner's manual review of a green `verify` run on the tested SHA) plus the concrete upgrade action. Enabling the required status check on main itself still needs an authorized human.",
      "requiresHuman": true,
      "file": "docs/DESIGN_DECISIONS.md",
      "line": 4695
    },
    "revision": 1,
    "owner": "",
    "status": "open",
    "response": "",
    "evidence": "",
    "at": "2026-10-28T21:39:58.784Z",
    "createdAt": "2026-10-28T21:39:58.784Z",
    "history": []
  },
  {
    "id": "8d549abd-fef1-4cf7-a875-afd3b6b5c55c",
    "finding": {
      "severity": "major",
      "description": "Hosted PR deliberate-failure demonstration not produced: the sandbox has no push authorization, so no GitHub-hosted run exists against a real SHA. Local failure-injection through `npm run verify` (exit 1, short-circuit) was executed and DESIGN_DECISIONS ## 73 records the hosted evidence as explicitly pending, not claimed. Confirmed against code: the workflow's tested-SHA reporting step exists for exactly this follow-up. Receipt 2286bdcd-089c-4f4a-819c-6378bb9d5239 open, no submitted decision. Requires an authorized push + failing-PR run + revert + run/SHA record.",
      "requiresHuman": true,
      "file": "docs/DESIGN_DECISIONS.md",
      "line": 4736
    },
    "revision": 1,
    "owner": "",
    "status": "open",
    "response": "",
    "evidence": "",
    "at": "2026-10-28T21:55:37.982Z",
    "createdAt": "2026-10-28T21:55:37.982Z",
    "history": []
  },
  {
    "id": "5c7509f9-e4c2-4f4a-90cd-2fa05abd8925",
    "finding": {
      "severity": "major",
      "description": "Pre-merge enforcement upgrade still outstanding: docs state the actual current mechanism (no branch protection; repo owner's manual review of a green `verify` run on the tested SHA) and the concrete action \u2014 mark the `verify` job a required status check on main. Enabling it requires repository settings access the sandbox does not have. Receipt 7b927cd3-ebc4-4783-9131-8a6cfa0b7116 open, no submitted decision.",
      "requiresHuman": true,
      "file": "docs/DESIGN_DECISIONS.md",
      "line": 4727
    },
    "revision": 1,
    "owner": "",
    "status": "open",
    "response": "",
    "evidence": "",
    "at": "2026-10-28T21:55:38.045Z",
    "createdAt": "2026-10-28T21:55:38.045Z",
    "history": []
  },
  {
    "id": "50b752ac-2cb2-4150-a5cc-43984ae65dd7",
    "finding": {
      "severity": "major",
      "description": "Hosted PR deliberate-failure demonstration not produced: the sandbox has no push authorization, so no GitHub-hosted run exists against a real SHA, and hosted failure + artifact-retention behavior cannot be established locally. Local failure-injection through `npm run verify` (exit 1, short-circuit) was executed and DESIGN_DECISIONS ## 74 records the hosted evidence as explicitly pending, not claimed. Receipts 2286bdcd-089c-4f4a-819c-6378bb9d5239 and 8d549abd-fef1-4cf7-a875-afd3b6b5c55c open, no submitted approval/waiver/deferral. Requires: authorized push, PR with temporary failing test, record run URL + tested SHA + retained diagnostics, revert, record green run.",
      "requiresHuman": true,
      "file": "docs/DESIGN_DECISIONS.md",
      "line": 4778
    },
    "revision": 1,
    "owner": "",
    "status": "open",
    "response": "",
    "evidence": "",
    "at": "2026-10-28T23:31:22.716Z",
    "createdAt": "2026-10-28T23:31:22.716Z",
    "history": []
  },
  {
    "id": "622ce784-0fd5-4e14-99b1-54197ca5ecf7",
    "finding": {
      "severity": "major",
      "description": "Hosted PR deliberate-failure demonstration not produced: the sandbox has no push authorization, so no GitHub-hosted run exists against a real SHA, and hosted failure + diagnostic-retention behavior cannot be established locally. Local failure-injection through `npm run verify` (exit 1, short-circuit) was executed and DESIGN_DECISIONS ## 76 records hosted evidence as explicitly pending, not claimed. Receipts 2286bdcd-089c-4f4a-819c-6378bb9d5239, 8d549abd-fef1-4cf7-a875-afd3b6b5c55c, 50b752ac-2cb2-4150-a5cc-43984ae65dd7 open with no submitted approval/waiver/deferral. Requires: authorized push, PR with temporary failing test, record run URL + tested SHA + failing step + retained diagnostics, revert, record green run.",
      "requiresHuman": true,
      "file": "docs/DESIGN_DECISIONS.md",
      "line": 4861
    },
    "revision": 1,
    "owner": "",
    "status": "open",
    "response": "",
    "evidence": "",
    "at": "2026-10-29T01:23:00.923Z",
    "createdAt": "2026-10-29T01:23:00.923Z",
    "history": []
  }
];

export const ciHumanWorkItems = () => structuredClone(ciItems);
