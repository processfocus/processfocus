import { useEffect, useState } from "react"

/**
 * Custom hook for syncing state with localStorage
 * Automatically saves to localStorage on every change and loads on mount
 *
 * @param key - localStorage key to store the value under
 * @param initialValue - Default value if nothing is in localStorage
 * @returns [value, setValue, clearValue] tuple
 */
export const useLocalStorage = <T>(
  key: string | undefined,
  initialValue: T,
): [T, (value: T | ((val: T) => T)) => void, () => void] => {
  // State to store our value
  // Pass initial state function to useState so logic is only executed once
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (key === undefined || typeof window === "undefined") {
      return initialValue
    }

    try {
      const item = window.localStorage.getItem(key)
      return item ? (JSON.parse(item) as T) : initialValue
    } catch (error) {
      console.error(`Error loading localStorage key "${key}":`, error)
      return initialValue
    }
  })

  // Return a wrapped version of useState's setter function that
  // persists the new value to localStorage
  const setValue = (value: T | ((val: T) => T)) => {
    if (key === undefined) return
    try {
      // Allow value to be a function so we have same API as useState
      const valueToStore =
        value instanceof Function ? value(storedValue) : value

      setStoredValue(valueToStore)

      if (typeof window !== "undefined") {
        window.localStorage.setItem(key, JSON.stringify(valueToStore))
      }
    } catch (error) {
      console.error(`Error saving to localStorage key "${key}":`, error)
    }
  }

  // Function to clear the value from both state and localStorage
  const clearValue = () => {
    if (key === undefined) return
    try {
      setStoredValue(initialValue)
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(key)
      }
    } catch (error) {
      console.error(`Error clearing localStorage key "${key}":`, error)
    }
  }

  // Sync with localStorage when key changes
  useEffect(() => {
    if (key === undefined || typeof window === "undefined") {
      return
    }

    try {
      const item = window.localStorage.getItem(key)
      if (item) {
        setStoredValue(JSON.parse(item) as T)
      }
    } catch (error) {
      console.error(`Error syncing localStorage key "${key}":`, error)
    }
  }, [key])

  return [storedValue, setValue, clearValue]
}
