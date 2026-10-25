import Capacitor
import UIKit

/// Capacitor's bridge controller plus the app-local plugins (SPM plugins register themselves).
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PushKeyStorePlugin())
        bridge?.registerPluginInstance(SpeechRecognitionPlugin())
    }
}
