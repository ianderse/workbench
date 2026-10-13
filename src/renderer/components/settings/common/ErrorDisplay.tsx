
interface ErrorDisplayProps {
  error: string | null;
  envError?: string | null;
}

/**
 * Displays error messages in a consistent format.
 * Combines general errors and environment configuration errors.
 */
export function ErrorDisplay({ error, envError }: ErrorDisplayProps) {
  const displayError = error || envError;

  if (!displayError) {
    return null;
  }

  return (
    <div role="alert" className="mt-6 text-sm text-destructive">
      {displayError}
    </div>
  );
}
