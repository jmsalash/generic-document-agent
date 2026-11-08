// What the eye says, and how the relay's health answer maps to the eye's state.

export const BANNER = {
  invite: 'Click me to talk',
  offline: 'Assistant is offline',
  busy: 'Busy with visitors, try soon',
  micDenied: 'Microphone needed to talk',
  connecting: 'Connecting…',
  limit: "Time's up. Click to talk again",
  insecure: 'Needs a secure (https) page',
};

export function healthToStatus(health) {
  if (!health || !health.ok) return 'offline';
  if (typeof health.sessions === 'number' && typeof health.maxSessions === 'number'
      && health.sessions >= health.maxSessions) return 'busy';
  return 'invite';
}
