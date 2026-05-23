import React from 'react'
import {createRoot} from 'react-dom/client'
import './styles/index.css'
import App from './App'
import { applyPlatformAttributes } from './lib/platform'
import './lib/androidWailsShim'

const container = document.getElementById('root')
applyPlatformAttributes()

const root = createRoot(container!)

root.render(
    <React.StrictMode>
        <App/>
    </React.StrictMode>
)
