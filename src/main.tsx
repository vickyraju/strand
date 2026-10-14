import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ApiGate from './components/ApiGate'
import './index.css'
import { applyTheme } from './theme'

applyTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ApiGate>
      <App />
    </ApiGate>
  </React.StrictMode>,
)
