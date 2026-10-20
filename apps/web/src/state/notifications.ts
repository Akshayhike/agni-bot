/**
 * Browser notifications, the web counterpart of the Mac notification bridge.
 * Permission is requested once, when the app starts; the in-app toast is
 * always the fallback so a blocked permission never hides a result.
 */

export interface NotificationBridge {
  post(title: string, body: string, sound: boolean, threadID?: string, onOpen?: (threadID: string) => void): void;
  request(): void;
}

export const browserNotifications: NotificationBridge = {
  request() {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") void Notification.requestPermission();
  },

  post(title, body, _sound, threadID, onOpen) {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    try {
      const notification = new Notification(title, { body, tag: threadID ?? title });
      notification.onclick = () => {
        window.focus();
        if (threadID && onOpen) onOpen(threadID);
        notification.close();
      };
    } catch {
      // Some browsers only allow notifications from a service worker.
    }
  },
};

export const silentNotifications: NotificationBridge = {
  request() {},
  post() {},
};
