import { useEffect, useState } from 'react';

/** How often the page's idea of "now" moves on. */
export const CLOCK_MS = 60_000;

/** The current time, read again every minute until the page goes away, so "5 分钟前" does not stand still. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
