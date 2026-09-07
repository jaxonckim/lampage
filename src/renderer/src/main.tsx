import React from 'react'
import ReactDOM from 'react-dom/client'
import { installBrowserApi } from './browserApi'
import App from './App'
import { useAppStore } from './stores/appStore'
import './styles/global.css'

installBrowserApi()

// Dev/verify hook — same store instance the React tree subscribes to.
if (import.meta.env.DEV) {
  ;(window as Window & { __lampageStore?: typeof useAppStore }).__lampageStore = useAppStore
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
