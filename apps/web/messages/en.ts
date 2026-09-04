/**
 * English strings. The shape of this file is the contract every other locale
 * implements — `Messages` in lib/i18n.tsx is derived from it, so a missing key
 * in a translation is a type error rather than a blank label at runtime.
 */
export default {
  'app.tagline': 'Capture. Connect. Share.',
  'auth.signIn': 'Sign in',
  'auth.createAccount': 'Create account',
  'auth.identifier': 'Username, email or phone',
  'auth.password': 'Password',
  'auth.noMatch': 'Those details do not match an account',
  'nav.chat': 'Chat',
  'nav.camera': 'Camera',
  'nav.stories': 'Stories',
  'nav.snaps': 'Snaps',
  'camera.hint': 'Tap for photo · Hold for video',
  'camera.denied': 'Camera access is blocked. Allow it in your browser settings, then try again.',
  'chat.message': 'Message',
  'chat.typing': 'typing…',
  'chat.connected': 'connected',
  'chat.reconnecting': 'reconnecting…',
  'chat.holdToRecord': 'Hold to record a voice message',
  'chat.slideToCancel': '‹ slide to cancel',
  'call.calling': 'Calling…',
  'call.connecting': 'Connecting…',
  'call.ended': 'Call ended',
  'call.failed': 'Call failed',
  'call.noTurn': 'No TURN server configured — this may not connect across some networks.',
  'friends.search': 'Find people by username',
  'friends.none': 'No friends yet',
  'offline.title': 'You are offline',
  'offline.body': 'Messages will send when you reconnect.',
  'error.generic': 'Something went wrong. Try again.',
  'error.retry': 'Try again',
} as const satisfies Record<string, string>;
