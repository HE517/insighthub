import { configureStore } from '@reduxjs/toolkit';

import { connectionReducer } from './connectionSlice.js';
import { documentReducer } from './documentSlice.js';
import { realtimeReducer } from './realtimeSlice.js';

export const store = configureStore({
  reducer: {
    connection: connectionReducer,
    document: documentReducer,
    realtime: realtimeReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export type AppStore = typeof store;
