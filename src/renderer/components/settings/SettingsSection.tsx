interface SettingsSectionProps {
  title: string;
  /** Kept for context in code; claude.ai section headings have no subtitle, so it is not rendered */
  description?: string;
  /** Control rendered at the right of the heading (a refresh button, ...) */
  action?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * A settings section (claude.ai): a 15px semibold heading followed by its rows;
 * sections are spaced 40px apart.
 */
export function SettingsSection({ title, action, children }: SettingsSectionProps) {
  return (
    <section className="mb-10 last:mb-0">
      <div className="flex items-center justify-between gap-7">
        <h3 className="text-[0.9375rem] font-semibold leading-5 text-foreground">{title}</h3>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
