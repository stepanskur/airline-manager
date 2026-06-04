// notifier.js — chrome.notifications wrapper + action badge.

import { loadSettings } from "./settings.js";

const ICON = "assets/icon-128.png";

let pendingBadge = "";

export async function notify(title, message, contextMessage) {
  const settings = await loadSettings();
  if (!settings.notificationsEnabled) return;
  return new Promise((resolve) => {
    try {
      chrome.notifications.create(
        {
          type: "basic",
          iconUrl: ICON,
          title,
          message,
          contextMessage: contextMessage || "AirlineClub Co-Pilot",
          priority: 1,
        },
        (id) => resolve(id),
      );
    } catch (e) {
      console.error("notify failed", e);
      resolve(null);
    }
  });
}

export function setBadgeText(text, color) {
  try {
    if (text !== pendingBadge) {
      pendingBadge = text;
      chrome.action.setBadgeText({ text: text || "" });
    }
    if (color) chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {
    console.debug("badge set failed", e);
  }
}

export function clearBadge() {
  setBadgeText("", "#000000");
}
