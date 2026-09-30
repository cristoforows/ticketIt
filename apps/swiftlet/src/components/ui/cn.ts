import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Colour tokens need no entry: tailwind-merge's colour scale accepts any name.
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["label", "body", "title", "display"],
      tracking: ["label", "wordmark", "button"],
      shadow: ["paper", "slip"],
      radius: ["tag", "pill"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
