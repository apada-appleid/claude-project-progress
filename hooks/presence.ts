// HIDIdleTime is the whole machine's time since the last mouse or keyboard input, in nanoseconds.
export const parseIdleMs = (ioreg: string): number | null => {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg)

  return match ? Number(match[1]) / 1e6 : null
}
