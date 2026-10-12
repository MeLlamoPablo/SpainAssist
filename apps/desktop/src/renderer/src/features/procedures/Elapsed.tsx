import { useEffect, useState } from 'react';

/** Counts up from `since` (ISO), once a second: "42s", then "3m 05s". */
export function Elapsed({ since, className }: { since: string; className?: string }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const text =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return <span className={className}>{text}</span>;
}
