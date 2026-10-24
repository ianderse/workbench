import { SettingsSection } from './SettingsSection';

interface ClaudeOnlyNoteProps {
  title: string;
  /** What applies to Claude Code only, and where the OMP equivalent lives */
  children: React.ReactNode;
}

/** Stands in for a page's Claude Code settings while the OMP backend is selected */
export function ClaudeOnlyNote({ title, children }: ClaudeOnlyNoteProps) {
  return (
    <SettingsSection title={title}>
      <p className="text-sm text-(--nav-label-color)">{children}</p>
    </SettingsSection>
  );
}
