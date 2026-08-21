import { createContext, useEffect } from 'react'
import { Theme, useSettingsStore } from '@/stores/settings'

type ThemeProviderProps = {
  children: React.ReactNode
  forcedTheme?: Theme
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const initialState: ThemeProviderState = {
  theme: 'system',
  setTheme: () => null
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

/**
 * Component that provides the theme state and setter function to its children.
 */
export default function ThemeProvider({ children, forcedTheme, ...props }: ThemeProviderProps) {
  const theme = useSettingsStore.use.theme()
  const setTheme = useSettingsStore.use.setTheme()
  const activeTheme = forcedTheme ?? theme

  useEffect(() => {
    const root = window.document.documentElement
    root.classList.remove('light', 'dark')

    if (activeTheme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const handleChange = (e: MediaQueryListEvent) => {
        root.classList.remove('light', 'dark')
        root.classList.add(e.matches ? 'dark' : 'light')
      }

      root.classList.add(mediaQuery.matches ? 'dark' : 'light')
      mediaQuery.addEventListener('change', handleChange)

      return () => mediaQuery.removeEventListener('change', handleChange)
    } else {
      root.classList.add(activeTheme)
    }
  }, [activeTheme])

  const value = {
    theme,
    setTheme
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export { ThemeProviderContext }
