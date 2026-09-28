export type EstimateItem = { description: string; quantityMilli: number; unitCents: number };
export function estimateLineCents(item: EstimateItem): number {
  return Math.round(item.quantityMilli * item.unitCents / 1000);
}
export function estimateTotalCents(items: EstimateItem[]): number {
  const total = items.reduce((sum, item) => sum + estimateLineCents(item), 0);
  if (!Number.isSafeInteger(total) || total > 10_000_000_000)
    throw new Error("El estimado supera el importe máximo permitido");
  return total;
}
