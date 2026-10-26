import ImageIO
import UIKit
import UniformTypeIdentifiers

/// "Send to dorabot": collects the shared text / links / photos, writes them into the App Group
/// container and opens the app, which shows its confirmation sheet. Nothing is ever sent from here,
/// and nothing leaves the phone until the user taps Send in the app.
final class ShareViewController: UIViewController {
    private let maxImages = 4
    /// The whole chat.send request must stay under ~700 KB of JSON, so each photo is held to this many bytes.
    private let maxImageBytes = 120_000

    private var text = ""
    private var imageFiles: [Data] = []
    private let card = UIView()
    private let preview = UITextView()
    private let status = UILabel()
    private let sendButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        buildUI()
        Task { await load() }
    }

    // MARK: UI

    private func buildUI() {
        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 16
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        let title = UILabel()
        title.text = "Send to dorabot"
        title.font = .systemFont(ofSize: 17, weight: .semibold)

        status.font = .systemFont(ofSize: 13)
        status.textColor = .secondaryLabel
        status.numberOfLines = 0
        status.text = "Reading what you shared…"

        preview.isEditable = false
        preview.backgroundColor = .tertiarySystemBackground
        preview.layer.cornerRadius = 10
        preview.font = .systemFont(ofSize: 14)
        preview.textContainerInset = UIEdgeInsets(top: 8, left: 6, bottom: 8, right: 6)
        preview.heightAnchor.constraint(equalToConstant: 120).isActive = true

        sendButton.setTitle("Send to dorabot", for: .normal)
        sendButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        sendButton.backgroundColor = .systemBlue
        sendButton.setTitleColor(.white, for: .normal)
        sendButton.layer.cornerRadius = 12
        sendButton.heightAnchor.constraint(equalToConstant: 46).isActive = true
        sendButton.isEnabled = false
        sendButton.alpha = 0.5
        sendButton.addTarget(self, action: #selector(handOff), for: .touchUpInside)

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.addTarget(self, action: #selector(cancel(_:)), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [title, status, preview, sendButton, cancel])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        spinner.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            card.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -12),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
        ])
    }

    @objc private func cancel(_ sender: Any?) {
        extensionContext?.cancelRequest(withError: NSError(domain: "ShareExtension", code: 0))
    }

    // MARK: Loading

    private func load() async {
        var texts: [String] = []
        var urls: [String] = []
        var images: [Data] = []
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        for item in items {
            if let t = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { texts.append(t) }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    if images.count < maxImages, let data = await loadImage(provider) { images.append(data) }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let u = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL, !u.isFileURL {
                        urls.append(u.absoluteString)
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let t = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                        let trimmed = t.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty { texts.append(trimmed) }
                    }
                }
            }
        }
        // A page share often repeats the URL as its text; keep each piece once.
        var seen = Set<String>()
        let parts = (texts + urls).filter { seen.insert($0).inserted }
        text = String(parts.joined(separator: "\n").prefix(8000))
        imageFiles = images
        await MainActor.run { ready() }
    }

    private func loadImage(_ provider: NSItemProvider) async -> Data? {
        guard let item = try? await provider.loadItem(forTypeIdentifier: UTType.image.identifier) else { return nil }
        var source: CGImageSource?
        if let url = item as? URL {
            source = CGImageSourceCreateWithURL(url as CFURL, nil)
        } else if let data = item as? Data {
            source = CGImageSourceCreateWithData(data as CFData, nil)
        } else if let image = item as? UIImage, let data = image.pngData() {
            source = CGImageSourceCreateWithData(data as CFData, nil)
        }
        guard let src = source else { return nil }
        // Longest side shrinks until the JPEG fits the per-photo budget.
        for (edge, quality) in [(1280, 0.6), (1024, 0.55), (800, 0.5), (640, 0.45), (480, 0.4)] as [(Int, CGFloat)] {
            let opts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: edge,
            ]
            guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary),
                  let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: quality) else { continue }
            if jpeg.count <= maxImageBytes { return jpeg }
        }
        return nil
    }

    private func ready() {
        if text.isEmpty && imageFiles.isEmpty {
            status.text = "dorabot can take text, links and photos."
            return
        }
        var bits: [String] = []
        if !imageFiles.isEmpty { bits.append("\(imageFiles.count) photo\(imageFiles.count == 1 ? "" : "s")") }
        status.text = "You will review this in dorabot before anything is sent." + (bits.isEmpty ? "" : " Includes " + bits.joined(separator: ", ") + ".")
        preview.text = text.isEmpty ? "(photos only)" : text
        sendButton.isEnabled = true
        sendButton.alpha = 1
    }

    // MARK: Hand-off

    @objc private func handOff() {
        guard let root = AppGroup.shareRoot else {
            status.text = "App Group unavailable. Open dorabot and try again."
            return
        }
        let id = UUID().uuidString
        let dir = root.appendingPathComponent(id, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var names: [String] = []
            for (i, data) in imageFiles.enumerated() {
                let name = "image-\(i).jpg"
                try data.write(to: dir.appendingPathComponent(name))
                names.append(name)
            }
            let payload: [String: Any] = ["text": text, "images": names, "createdAt": Date().timeIntervalSince1970]
            try JSONSerialization.data(withJSONObject: payload).write(to: dir.appendingPathComponent("payload.json"))
        } catch {
            status.text = "Could not save the share. Try again."
            return
        }
        openApp(URL(string: "dorabot-remote://share?id=\(id)")!)
        // Even if iOS refuses the open, the app picks the share up the next time it is opened.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
    }

    private func openApp(_ url: URL) {
        var responder: UIResponder? = self
        while let r = responder {
            if let app = r as? UIApplication {
                app.open(url, options: [:], completionHandler: nil)
                return
            }
            responder = r.next
        }
    }
}
