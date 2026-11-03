import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { TooltipProvider } from './components/ui/tooltip';
import { IdentityProvider } from './identity';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <IdentityProvider>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </IdentityProvider>
    </BrowserRouter>
  </StrictMode>,
);
