/**
 * Connection slice: mirrors the transport state of the WebSocket channel.
 *
 * The status vocabulary comes from @insighthub/shared so the UI labels and the
 * server-side view can never drift apart.
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { ConnectionStatus } from '@insighthub/shared';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Server-assigned id from the `connected` handshake. */
  connectionId: string | null;
  /** How many connection attempts have been made (for the retry UX). */
  attempt: number;
  lastError: string | null;
}

const initialState: ConnectionState = {
  status: 'idle',
  connectionId: null,
  attempt: 0,
  lastError: null,
};

const connectionSlice = createSlice({
  name: 'connection',
  initialState,
  reducers: {
    connecting(state) {
      state.status = 'connecting';
      state.attempt += 1;
      state.lastError = null;
    },
    reconnecting(state) {
      state.status = 'reconnecting';
      state.attempt += 1;
    },
    connected(state, action: PayloadAction<{ connectionId: string }>) {
      state.status = 'connected';
      state.connectionId = action.payload.connectionId;
      state.lastError = null;
    },
    disconnected(state) {
      state.status = 'offline';
      state.connectionId = null;
    },
    failed(state, action: PayloadAction<string>) {
      state.status = 'error';
      state.lastError = action.payload;
    },
  },
});

export const connectionActions = connectionSlice.actions;
export const connectionReducer = connectionSlice.reducer;
