import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';

import 'antd/dist/reset.css';
import './styles.css';

import { App } from './App.js';
import { store } from './store/index.js';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root container is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
