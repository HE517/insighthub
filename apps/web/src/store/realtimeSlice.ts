/**
 * Realtime slice: a bounded record of protocol traffic for debugging and for
 * the M0 acceptance evidence (the UI shows the last server message verbatim).
 *
 * Only the last N messages are kept - an unbounded log would be a leak.
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import { WS_MESSAGE_TYPES, type WsServerMessage } from '@insighthub/shared';

const MAX_LOG = 20;

export interface RealtimeState {
  /** Newest-first list of accepted server messages. */
  messages: WsServerMessage[];
  receivedCount: number;
  /** Set when the client had to drop a malformed frame. */
  lastError: string | null;
}

const initialState: RealtimeState = {
  messages: [],
  receivedCount: 0,
  lastError: null,
};

const realtimeSlice = createSlice({
  name: 'realtime',
  initialState,
  reducers: {
    serverMessageReceived(state, action: PayloadAction<WsServerMessage>) {
      state.receivedCount += 1;
      state.messages.unshift(action.payload);
      if (state.messages.length > MAX_LOG) {
        state.messages.length = MAX_LOG;
      }

      if (action.payload.type === WS_MESSAGE_TYPES.error) {
        state.lastError = action.payload.payload.message;
      }
    },
    protocolError(state, action: PayloadAction<string>) {
      state.lastError = action.payload;
    },
  },
});

export const realtimeActions = realtimeSlice.actions;
export const realtimeReducer = realtimeSlice.reducer;
