
interface ErrorDisplayProps {
  error: string | null;
}

/**
 * Displays error messages in a consistent format.
 */
export function ErrorDisplay({ error }: ErrorDisplayProps) {
  if (!error) {
    return null;
  }

  return (
    <div role="alert" className="mt-6 text-sm text-destructive">
      {error}
    </div>
  );
}
