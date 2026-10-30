import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { ToastProvider } from './components/toast.tsx';
import { StreamClient, streamUrl } from './stream.ts';
import { StreamContext } from './use-api.ts';
import type { StreamSource } from './use-api.ts';
import './styles.css';

const client = new StreamClient(streamUrl(window.location));
const stream: StreamSource = {
  subscribe: (fn) => client.onTopics(fn),
  connection: { get: () => client.state, subscribe: (fn) => client.onState(() => fn()) },
};

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <StreamContext.Provider value={stream}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StreamContext.Provider>
  </StrictMode>,
);
client.start();
