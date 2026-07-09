import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * cn — merge conditional class names, then de-conflict Tailwind utilities.
 * (clsx resolves conditionals; tailwind-merge lets later classes win.)
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
