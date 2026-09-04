import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn's merger: clsx for conditionals, twMerge so a caller's class beats
 *  the component's default rather than both landing in the DOM. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
