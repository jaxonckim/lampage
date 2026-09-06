import React from 'react'
import ReactDOM from 'react-dom/client'
import { installBrowserApi } from './browserApi'
import App from './App'
import './styles/global.css'

installBrowserApi()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
