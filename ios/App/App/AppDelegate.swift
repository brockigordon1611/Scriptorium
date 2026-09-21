import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Nothing had ever set an audio category, so the app ran under the
        // default ambient one — which the ring/silent switch silences outright.
        // Both the spoken voice and the KJV recordings went quiet with no error
        // and no way to tell from inside the web view. Playback is the category
        // for audio the user deliberately started, and is what Podcasts and
        // Audible use; spokenAudio is its speech variant, which also does the
        // right thing when another app interrupts.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [])
        try? AVAudioSession.sharedInstance().setActive(true)
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return false
    }
}

// iOS 27's SDK requires the UIScene lifecycle; an app still launching through
// UIApplicationDelegate alone traps on startup before any of its own code runs.
// Adopting it is the Info.plist manifest plus this class. It lives here rather
// than in its own file so the Xcode project needs no new build-phase entry —
// one less thing for an iCloud sync to mangle.
//
// The window is built from Main.storyboard by UIKit, named in the manifest, so
// there is nothing to set up on connect. What does need doing is forwarding:
// with scenes in play, a URL opened into the app and a universal link arrive
// here instead of at the AppDelegate, and Capacitor's proxy is what the
// AppDelegate was handing them to. Auth redirects come back this way, so
// dropping them would have broken signing in without an obvious cause.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // A link that launched the app cold arrives in the connect options, not
        // as an openURLContexts call.
        if let url = connectionOptions.urlContexts.first?.url {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        }
    }
}
