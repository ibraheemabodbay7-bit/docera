import { useQuery } from "@tanstack/react-query";

export interface HwCreditsData {
  credits: number;
  resetAt: string | null;
}

export function useHwCredits() {
  const { data, isLoading } = useQuery<HwCreditsData>({
    queryKey: ["/api/credits/hw"],
    staleTime: 0,
  });

  const credits = data?.credits ?? 10;
  const resetAt = data?.resetAt ?? null;

  // Calculate next reset date: resetAt + 30 days
  const nextReset = resetAt
    ? new Date(new Date(resetAt).getTime() + 30 * 24 * 60 * 60 * 1000)
    : null;

  const daysUntilReset = nextReset
    ? Math.max(0, Math.ceil((nextReset.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  return { credits, resetAt, nextReset, daysUntilReset, isLoading };
}
