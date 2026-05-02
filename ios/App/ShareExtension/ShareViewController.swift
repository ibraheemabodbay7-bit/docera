import UIKit
import Social
import MobileCoreServices
import UniformTypeIdentifiers

class ShareViewController: UIViewController {

    private let appGroupID = "group.com.docera.app"
    private let inboxFolder = "ShareInbox"

    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
        processItems()
    }

    // MARK: - UI

    private func setupUI() {
        view.backgroundColor = UIColor.black.withAlphaComponent(0.5)

        let card = UIView()
        card.backgroundColor = UIColor(red: 0.11, green: 0.11, blue: 0.118, alpha: 1)
        card.layer.cornerRadius = 20
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        let handle = UIView()
        handle.backgroundColor = UIColor.white.withAlphaComponent(0.2)
        handle.layer.cornerRadius = 2
        handle.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(handle)

        let iconContainer = UIView()
        iconContainer.backgroundColor = UIColor(red: 0.2, green: 0.45, blue: 1.0, alpha: 1)
        iconContainer.layer.cornerRadius = 16
        iconContainer.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(iconContainer)

        let iconLabel = UILabel()
        iconLabel.text = "D"
        iconLabel.textColor = .white
        iconLabel.font = UIFont.systemFont(ofSize: 22, weight: .bold)
        iconLabel.textAlignment = .center
        iconLabel.translatesAutoresizingMaskIntoConstraints = false
        iconContainer.addSubview(iconLabel)

        let titleLabel = UILabel()
        titleLabel.text = "Saving to Docera…"
        titleLabel.textColor = UIColor(red: 0.925, green: 0.925, blue: 0.937, alpha: 1)
        titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textAlignment = .center
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(titleLabel)

        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.color = UIColor(red: 0.557, green: 0.557, blue: 0.576, alpha: 1)
        spinner.startAnimating()
        spinner.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(spinner)

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(equalToConstant: 280),
            card.heightAnchor.constraint(equalToConstant: 160),

            handle.topAnchor.constraint(equalTo: card.topAnchor, constant: 10),
            handle.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            handle.widthAnchor.constraint(equalToConstant: 36),
            handle.heightAnchor.constraint(equalToConstant: 4),

            iconContainer.topAnchor.constraint(equalTo: handle.bottomAnchor, constant: 16),
            iconContainer.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            iconContainer.widthAnchor.constraint(equalToConstant: 48),
            iconContainer.heightAnchor.constraint(equalToConstant: 48),

            iconLabel.centerXAnchor.constraint(equalTo: iconContainer.centerXAnchor),
            iconLabel.centerYAnchor.constraint(equalTo: iconContainer.centerYAnchor),

            titleLabel.topAnchor.constraint(equalTo: iconContainer.bottomAnchor, constant: 12),
            titleLabel.centerXAnchor.constraint(equalTo: card.centerXAnchor),

            spinner.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 10),
            spinner.centerXAnchor.constraint(equalTo: card.centerXAnchor),
        ])
    }

    // MARK: - File Processing

    private func processItems() {
        guard let inputItems = extensionContext?.inputItems as? [NSExtensionItem] else {
            dismiss(after: 0.3)
            return
        }

        var providers: [NSItemProvider] = []
        for item in inputItems {
            providers += item.attachments ?? []
        }

        guard !providers.isEmpty else {
            dismiss(after: 0.3)
            return
        }

        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupID
        ) else {
            dismiss(after: 0.3)
            return
        }

        let inboxURL = containerURL.appendingPathComponent(inboxFolder)
        try? FileManager.default.createDirectory(at: inboxURL, withIntermediateDirectories: true)

        let group = DispatchGroup()
        var savedPaths: [String] = []
        let lock = NSLock()

        let imageType: String
        let pdfType: String
        if #available(iOS 14, *) {
            imageType = UTType.image.identifier
            pdfType = UTType.pdf.identifier
        } else {
            imageType = kUTTypeImage as String
            pdfType = kUTTypePDF as String
        }

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(pdfType) {
                group.enter()
                provider.loadFileRepresentation(forTypeIdentifier: pdfType) { url, error in
                    defer { group.leave() }
                    guard let url = url, error == nil else { return }
                    let dest = inboxURL.appendingPathComponent(UUID().uuidString + ".pdf")
                    try? FileManager.default.copyItem(at: url, to: dest)
                    lock.lock()
                    savedPaths.append(dest.path)
                    lock.unlock()
                }
            } else if provider.hasItemConformingToTypeIdentifier(imageType) {
                group.enter()
                provider.loadDataRepresentation(forTypeIdentifier: imageType) { data, error in
                    defer { group.leave() }
                    guard let data = data, error == nil else { return }
                    let ext = self.imageExtension(from: data)
                    let dest = inboxURL.appendingPathComponent(UUID().uuidString + ext)
                    try? data.write(to: dest)
                    lock.lock()
                    savedPaths.append(dest.path)
                    lock.unlock()
                }
            }
        }

        group.notify(queue: .main) {
            if !savedPaths.isEmpty {
                let defaults = UserDefaults(suiteName: self.appGroupID)
                var existing = defaults?.stringArray(forKey: "pendingSharedFiles") ?? []
                existing.append(contentsOf: savedPaths)
                defaults?.set(existing, forKey: "pendingSharedFiles")
                defaults?.synchronize()
            }
            self.openMainApp()
            // dismiss(after:) removed — alert OK button calls completeRequest
        }
    }

    private func imageExtension(from data: Data) -> String {
        guard data.count >= 4 else { return ".jpg" }
        let bytes = [UInt8](data.prefix(4))
        if bytes[0] == 0xFF && bytes[1] == 0xD8 { return ".jpg" }
        if bytes[0] == 0x89 && bytes[1] == 0x50 { return ".png" }
        if bytes[0] == 0x47 && bytes[1] == 0x49 { return ".gif" }
        if bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46 { return ".webp" }
        return ".jpg"
    }

    private func openMainApp() {
        guard let url = URL(string: "docera://shared") else {
            showDiagnosticAlert(title: "URL parse failed", message: "Could not create docera://shared URL")
            return
        }

        var responder: UIResponder? = self
        let selector = NSSelectorFromString("openURL:options:completionHandler:")

        while responder != nil {
            if (responder! as AnyObject).responds(to: selector) && responder !== self {
                showDiagnosticAlert(title: "Found responder", message: "Class: \(type(of: responder!)), calling open now")
                (responder! as AnyObject).perform(selector, with: url, with: [:] as NSDictionary)
                return
            }
            responder = responder?.next
        }

        showDiagnosticAlert(title: "No responder found", message: "Walked entire chain, nothing responded to selector")
    }

    private func showDiagnosticAlert(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        })

        DispatchQueue.main.async {
            if let rootVC = self.view.window?.rootViewController {
                rootVC.present(alert, animated: true)
            } else {
                self.present(alert, animated: true)
            }
        }
    }

    private func dismiss(after delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        }
    }
}
