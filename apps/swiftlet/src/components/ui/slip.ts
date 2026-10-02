export function slipTilt(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ((hash % 9) - 4) / 2;
}
