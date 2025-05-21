// src/lib/dateUtils.ts
import {
  startOfDay,
  subDays,
  startOfMonth,
  subMonths,
  // formatISO, // No longer needed directly for output string
} from 'date-fns';

export type TimeRangeOption = 'today' | 'last7days' | 'last30days' | 'thisMonth' | 'lastMonth';

export interface DateRange {
  start: Date;
  end: Date; // Represents the exclusive end (e.g., start of the next day/period)
  startISO: string; // UTC ISO String for API
  endISO: string; // UTC ISO String for API
}

export function getDateRange(option: TimeRangeOption): DateRange {
  const now = new Date();
  let start: Date;
  let end: Date; // End date is exclusive (up to, but not including the start of this date)

  switch (option) {
    case 'today':
      start = startOfDay(now);
      // End is the start of *tomorrow* for '<' comparison in SQL/Supabase
      end = startOfDay(subDays(now, -1));
      break;
    case 'last7days':
      start = startOfDay(subDays(now, 6)); // Includes today + 6 previous days
      end = startOfDay(subDays(now, -1)); // End is start of tomorrow
      break;
    case 'last30days':
      start = startOfDay(subDays(now, 29)); // Includes today + 29 previous days
      end = startOfDay(subDays(now, -1)); // End is start of tomorrow
      break;
    case 'thisMonth':
      start = startOfMonth(now);
      // End is start of *next* month
      end = startOfMonth(subMonths(now, -1));
      break;
    case 'lastMonth':
      const startOfThisMonth = startOfMonth(now);
      start = startOfMonth(subMonths(startOfThisMonth, 1));
      end = startOfThisMonth; // End is start of the current month
      break;
    default: // Default to last 7 days
      start = startOfDay(subDays(now, 6));
      end = startOfDay(subDays(now, -1));
      break;
  }

  // --- CHANGE HERE: Use .toISOString() for standard UTC format ---
  const startISO = start.toISOString(); // e.g., "2025-04-20T06:00:00.000Z"
  const endISO = end.toISOString();     // e.g., "2025-04-21T06:00:00.000Z"
  // ---

  // Keep original Date objects if needed for display formatting
  return { start, end, startISO, endISO };
}

// timeRangeOptions remains the same
export const timeRangeOptions: { value: TimeRangeOption; label: string }[] = [
    { value: 'today', label: 'Today' },
    { value: 'last7days', label: 'Last 7 Days' },
    { value: 'last30days', label: 'Last 30 Days' },
    { value: 'thisMonth', label: 'This Month' },
    { value: 'lastMonth', label: 'Last Month' },
];