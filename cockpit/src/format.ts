/** Display helpers. The wire speaks seconds; instruments read milliseconds. */

/** Seconds -> integer milliseconds, e.g. 0.94 -> "940". */
export function ms(seconds: number): string {
  return Math.round(seconds * 1000).toLocaleString('en-GB');
}

/** Seconds -> "1.8s" / "49.5s" / "1m 12s" for durations a human reads as time. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function integer(value: number): string {
  return Math.round(value).toLocaleString('en-GB');
}

/** Costs here are cents-scale; four decimals keeps them honest. */
export function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** "deepgram/nova-3" -> "nova-3", keeping the vendor for the title attribute. */
export function shortModel(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

export function clockTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
