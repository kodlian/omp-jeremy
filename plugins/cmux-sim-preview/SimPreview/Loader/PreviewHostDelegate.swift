import UIKit

/// App delegate for the process when the app's own entry point is skipped: a key window that shows the preview.
final class PreviewHostDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // A scene session restored from the app's earlier runs keeps the app's own scene delegate and never asks for a
        // configuration, so the window goes on whichever scene connects.
        NotificationCenter.default.addObserver(forName: UIScene.willConnectNotification, object: nil, queue: .main) { notification in
            guard let scene = notification.object as? UIWindowScene else { return }
            MainActor.assumeIsolated { self.showWindow(in: scene) }
        }
        if Bundle.main.object(forInfoDictionaryKey: "UIApplicationSceneManifest") == nil {
            showWindow(in: nil)
        }
        return true
    }

    /// Implementing this adopts the scene lifecycle, which iOS 27 requires; the window comes from the notification.
    func application(
        _ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
    }

    private func showWindow(in scene: UIWindowScene?) {
        guard window == nil else { return }
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        self.window = window
        PreviewLoader.shared.start()
    }
}
