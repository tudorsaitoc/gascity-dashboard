import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ThemeProvider } from './contexts/ThemeContext';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
