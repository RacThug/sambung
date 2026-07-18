import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class lists, with later Tailwind utilities winning over
 * earlier conflicting ones (clsx composes, tailwind-merge dedupes). The one
 * helper every shadcn component and themed control uses. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
