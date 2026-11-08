// The eye's states, as plain rules the page code and tests share.
export const LIVE_STATES = ['intro', 'listening', 'thinking', 'speaking'];
export const IDLE_STATES = ['checking', 'invite', 'offline', 'busy'];

export const nextIdle = (status) => (['invite', 'offline', 'busy'].includes(status) ? status : 'offline');
export const canStart = (state) => state === 'invite';
export const isLive = (state) => LIVE_STATES.includes(state);
export const isIdle = (state) => IDLE_STATES.includes(state);
