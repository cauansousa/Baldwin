import { useEffect, useState } from "react";

/** Current unix time in seconds, re-rendering once per second (for countdowns). */
export function useNowSeconds(): bigint {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return BigInt(now);
}
