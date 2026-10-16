/**
 * Window chrome and the notification bridge. Both are small AppKit shims: the
 * SwiftUI scene owns the window, the app delegate busywork happens here
 * because `@NSApplicationDelegateAdaptor` is a macro (see AgniApp.swift).
 */
import AppKit
import UserNotifications
import SwiftUI

@MainActor
enum WindowChrome {
  /// Charcoal room, transparent titlebar, and a title that names the agent.
  static func configure() {
    guard let window = NSApp.windows.first(where: { $0.contentView != nil }) else { return }
    window.styleMask.insert(.fullSizeContentView)
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.backgroundColor = NSColor(red: 28 / 255, green: 28 / 255, blue: 28 / 255, alpha: 1)
    window.isMovableByWindowBackground = true
    window.toolbarStyle = .unifiedCompact
    retitle(AppModel.active)
  }

  static func retitle(_ model: AppModel?) {
    guard let window = NSApp.windows.first(where: { $0.contentView != nil }) else { return }
    window.title = model?.agent?.name ?? "Agni"
  }
}

/// Local notifications, shown as banners even when Agni is frontmost.
@MainActor
final class NotificationBridge: NSObject, UNUserNotificationCenterDelegate {
  static let shared = NotificationBridge()

  func start() {
    guard Bundle.main.bundleIdentifier != nil else { return }
    UNUserNotificationCenter.current().delegate = self
  }

  func post(title: String, body: String, sound: Bool) {
    guard Bundle.main.bundleIdentifier != nil else { return }
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
      guard granted else { return }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      if sound { content.sound = .default }
      UNUserNotificationCenter.current().add(
        UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
      )
    }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .sound]
  }
}
