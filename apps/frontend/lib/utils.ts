import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

/**
 * Strips the leading slash from a path, converting from database format to URL format.
 * Database paths always have a leading slash (e.g., "/enrolment-enquiry/Contact parent"),
 * but URLs should not have a double slash after the base path.
 *
 * @param path - Path like "/enrolment-enquiry/Contact parent" or "enrolment-enquiry/Contact parent"
 * @returns Path without leading slash like "enrolment-enquiry/Contact parent"
 */
export const toUrlPath = (path: string): string => {
  return path.startsWith("/") ? path.slice(1) : path
}
