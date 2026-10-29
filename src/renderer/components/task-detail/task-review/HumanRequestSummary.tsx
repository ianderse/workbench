import { useTranslation } from 'react-i18next';
import type { ReviewRoundFinding } from '../../../../shared/types/claude-code';
import { humanReviewTopics } from '../../../../shared/utils/human-work';

/** Display hints only. Original findings and host-side acceptance remain authoritative. */
export function humanRequestPresentation(findings: ReviewRoundFinding[]) {
  const text = findings.map(finding => finding.description).join('\n');
  const images = [...new Set((text.match(/(?:[\w.-]+[/\\])*[\w.-]+\.(?:png|jpe?g|webp)\b/gi) ?? [])
    .map(path => path.replace(/\\/g, '/')))];
  const screenshots = images.filter(path => /(?:^|\/)\d{2,5}[x×]\d{2,5}\//i.test(path));
  const topics = humanReviewTopics(text);
  const kind = screenshots.length ? 'screenshots'
    : topics.includes('study') ? 'study'
      : topics.includes('visual') ? 'visual' : 'decision';
  // A topic mention does not mean that work is still required. Only the explicit
  // pending-baseline wording gets specialized decision guidance; ambiguity stays neutral.
  const baselineApprovalPending = /\bbaselines?\s+without\s+(?:human\s+)?approval\b/i.test(text)
    || /\b(?:human[- ]acceptance|human[- ]approval)\s+gate\b[^.!?\n]{0,80}\bunmet\b/i.test(text);
  const baselineApprovalNegated = /\b(?:approval|acceptance)\s+(?:is\s+)?(?:not\s+(?:required|needed)|waived)\b/i.test(text)
    || /\bno\s+(?:human\s+|baseline\s+)?approval\s+(?:is\s+)?(?:required|needed)\b/i.test(text);
  return {
    kind,
    images: screenshots.length ? screenshots : images,
    updated: /\b(?:changed|updated|re-pinned)\b/i.test(text),
    baselines: /\bbaselines?\b/i.test(text) && baselineApprovalPending && !baselineApprovalNegated,
  };
}

export function HumanRequestSummary({ findings }: { findings: ReviewRoundFinding[] }) {
  const { t } = useTranslation('tasks');
  const presentation = humanRequestPresentation(findings);
  const title = presentation.kind === 'screenshots'
    ? t(presentation.updated ? 'humanWork.request.updatedScreenshots' : 'humanWork.request.screenshots', { count: presentation.images.length })
    : t(`humanWork.request.${presentation.kind}`);
  return <div className="space-y-2">
    <h4 className="text-base font-medium leading-snug">{title}</h4>
    <p className="text-sm text-muted-foreground">{t(presentation.kind === 'screenshots' && presentation.baselines
      ? 'humanWork.request.baselineDecision' : `humanWork.request.${presentation.kind}Help`)}</p>
    {!!presentation.images.length && <ul className="space-y-1" aria-label={t('humanWork.request.artifacts')}>
      {presentation.images.map(path => <li key={path} className="rounded bg-muted/50 px-2 py-1 font-mono text-xs wrap-anywhere">{path}</li>)}
    </ul>}
  </div>;
}
